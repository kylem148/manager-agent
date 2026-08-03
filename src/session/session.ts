import * as readline from "node:readline";
import fsp from "node:fs/promises";
import path from "node:path";
import { effortLevelsFor, parseEffort, type Config, type Effort } from "../config.js";
import type { InstancePaths, LiveFile } from "../paths.js";
import { CACHE_TTL, ModelProvider, type MessageParam } from "../model.js";
import { CostLedger, formatCostReport } from "../cost.js";
import { buildSystemPrompt, buildStartupInjection } from "./prompt.js";
import {
  toolDefinitions,
  makeExecutor,
  newSideEffects,
  SURFACED_TOOLS,
  type ToolSideEffects,
} from "./tools.js";
import {
  detectStaleActiveContext,
  readLiveMemory,
  archiveLog,
  autoArchiveLargeLogs,
  migrateInstanceLayout,
  startTranscript,
  appendTranscript,
  type TranscriptHandle,
} from "../memory/memory.js";
import { listDocs, readDoc } from "../memory/docs.js";
import { onWrite } from "../memory/writequeue.js";
import { c, line, write } from "../ui.js";
import { isConfirmVerb } from "../confirmverb.js";
import {
  Tui,
  WAKE_SENTINEL,
  NO_ANIMATION,
  type AnimationHandle,
  type AnimationSpec,
  type SessionIO,
  type DocSource,
  type PrMessageSaveResult,
  type QueueMergeResult,
} from "../tui/tui.js";
import {
  currentVisuals,
  dispatchFlourish,
  dispatchLabel,
  exitVoyage,
  savingLabel,
  type DispatchTarget,
  type EffectiveVisuals,
} from "../tui/visuals.js";
import { SLASH_COMMANDS } from "../tui/commands.js";
import { pirateBanner } from "../tui/banner.js";
import { LOG_NAMES, type LogName } from "../paths.js";
import {
  readDispatchConfig,
  displayCommand,
  resolveAgent,
  resolveAgentCommand,
  type DispatchConfig,
} from "./dispatchconfig.js";
import { DispatchRegistry, type Job } from "./registry.js";
import { readOnlyEnforcement, type ActiveAgent, type DispatchLane } from "./lanes.js";
import { FeatureManager } from "./features.js";
import { FeatureStore } from "./featurestore.js";
import { TaskError, TaskStore } from "./taskstore.js";
import { startCacheKeepAlive, type KeepAlive } from "./keepalive.js";
import { applyCompaction, planCompaction } from "./compaction.js";
import type { MergeHeadResult } from "./mergequeue.js";
import {
  DEFAULT_FEATURE_BRANCH_TYPE,
  checkRepoPath,
  defaultWorktreeBase,
  featureSlug,
} from "./worktrees.js";
import { resolveReviewRecord } from "./reviewrecord.js";
import {
  firstLineOf,
  flushHistoryNotes,
  noteDispatchCancelled,
  noteDispatchFired,
  noteDispatchLaunchFailed,
  noteMergeOutcome,
} from "./historynotes.js";

/**
 * Interactive terminal session for one co-manager instance.
 *
 * Design choices:
 *  - Natural language is the primary interface. Slash-commands are overrides.
 *  - Memory is silent and self-managed: the model records decisions, progress,
 *    research, and live-state on its own judgment, with no confirmation gate and
 *    no narration. /decide is just a shortcut to record one explicitly.
 *  - Durable transcript: every turn is appended to sessions/ as it happens, so
 *    no exit path (clean, Ctrl-C, kill, crash) can cost the conversation.
 *  - End-of-session auto-save: on exit, if any log is newer than
 *    activeContext.md, we refresh it silently before closing — no prompt.
 *    (/sync does the same on demand mid-session.)
 *  - All rendering goes through a SessionIO (tui.ts). On a real terminal that's
 *    the scrollable full-screen Tui; on piped/non-TTY input it's PlainIO, which
 *    preserves the old line-oriented behavior so scripts keep working.
 */

interface SessionState {
  cfg: Config;
  paths: InstancePaths;
  model: ModelProvider;
  system: string;
  messages: MessageParam[];
  effects: ToolSideEffects;
  io: SessionIO;
  /** The durable, turn-by-turn transcript file for this session. */
  transcript: TranscriptHandle;
  /** Count of real user turns (natural-language + steering commands), so the
   *  exit distill can skip a session where nothing was actually said. */
  userTurns: number;
  /** Dispatch config if the instance is linked (co link), else null. When null,
   *  the dispatch_order tool is not exposed and no dispatch can be armed. */
  dispatch: DispatchConfig | null;
  /** The job registry + capture watcher, created only when linked. */
  registry: DispatchRegistry | null;
  /** The feature levers (create/land/list/status/abandon), created only when
   *  linked. Drives the parallel-worktree flow over the registry + landing gate. */
  features: FeatureManager | null;
  /** The order armed and awaiting a typed `confirm`, or null. Set by the arm
   *  callback; consumed by the confirm interlock in the input loop. `feature`
   *  scopes the dispatch to a feature's worktree (undefined = bare main tree).
   *  `resolve` marks a merge-queue resolver dispatch: on fire the head is moved
   *  to "resolving" and re-processed when the agent finishes. `occupied` records
   *  whether the target worktree already had a live crew agent when the banner
   *  was shown — i.e. whether the captain was offered the lane choice at all
   *  (D-20260729-5); the lane itself is decided fresh at fire time. */
  armed: { order: string; feature?: string; resolve?: boolean; occupied?: boolean } | null;
  /** Completed jobs waiting for a review turn, drained on the next idle prompt. */
  reviewQueue: Job[];
  /**
   * Out-of-band turns the co owes the captain, drained on the next idle prompt
   * exactly like reviewQueue. The merge queue is the only producer today: the
   * captain's panel-native [m] runs entirely outside the agent loop, so when it
   * leaves the NEW head blocked (or the merge itself is refused) this is how that
   * reaches the co — it wakes, reads what happened, and can arm the resolver
   * without the captain having to re-explain any of it (D-20260724-12). A merge
   * that lands cleanly queues NOTHING: co is deliberately not in that loop.
   */
  queueNotices: string[];
  /**
   * The other half of the same queue: one-line records of events the co must
   * have SEEN but must not be woken for — an armed dispatch resolving (fired or
   * cancelled) and the captain's [m]. Same single path into the model's history
   * as queueNotices, a user-role `SYSTEM:` message; the difference is that these
   * are flushed into the history ahead of the next turn rather than drained by
   * driving one, so nothing here costs a model call or a word on screen. See
   * historynotes.ts for why they are buffered rather than pushed in place.
   */
  historyNotes: string[];
  /**
   * `Date.now()` when the last model turn finished, or null before the first.
   *
   * Exists to measure the gap the captain spends thinking between turns, which
   * is the thing the cache TTL is a bet on: the entry lives 5 minutes or an hour
   * from its last hit, so the distribution of these gaps decides whether we are
   * paying a 2x write premium for protection we need or for pauses that were
   * never long enough to matter. Kept on the session rather than the provider
   * because it measures the CAPTAIN's time, not the model's — the provider only
   * ever sees the intervals it was awake for.
   */
  lastTurnEndedAt: number | null;
  /** True while a model turn is in flight, so the cache keep-alive stands down
   *  rather than racing a real request for the same cache entry. */
  inTurn: boolean;
  /** The cache keep-alive, or null when disabled. Owned here so every turn can
   *  reset its clock and the exit path can stop it. */
  keepAlive: KeepAlive | null;
  /** The co's at-a-glance task table (the Ctrl-O Home tab). Loaded at session
   *  start, so the panel shows the last table the co wrote before it says a word
   *  this session. */
  tasks: TaskStore;
  /** The token/cost meter. Fed after every turn, shown only by /cost. */
  costs: CostLedger;
}

const PROMPT_LABEL = c.cyan("you › ");

/**
 * Ship's chores shown beside the spinner while the co is busy. Memory work is
 * silent by design — the co never narrates what it saved — but silence and a
 * frozen terminal look identical from the captain's chair, so we show that
 * SOMETHING is happening without saying what.
 *
 * These are picked at RANDOM rather than mapped per tool, and that's the point:
 * the captain has no use for "reading activeContext.md" vs "appending to
 * decisions.md" — it's the co's own bookkeeping either way. A random chore says
 * "working" and nothing else, which is exactly the amount the user should know.
 */
const BUSY_CHORES = [
  "swabbing the decks",
  "cleaning the cannons",
  "splicing the mainbrace",
  "battening the hatches",
  "coiling the ropes",
  "trimming the sails",
  "scraping the barnacles",
  "counting the doubloons",
  "squaring the yards",
  "tarring the rigging",
  "checking the powder",
  "polishing the brass",
  "sharpening the cutlasses",
  "sounding the depths",
  "bailing the bilge",
  "stowing the cargo",
  "checking the rum stores",
  "greasing the capstan",
  "patching the mainsail",
  "oiling the compass",
  "caulking the hull",
  "hauling in the lines",
  "minding the helm",
  "untangling the rigging",
  "counting the cannonballs",
  "consulting the charts",
  "inking the log",
  "shaking out a reef",
  "mending the nets",
  "wringing out the hammocks",
  "feeding the parrot",
  "arguing with the parrot",
  "rousing the crew",
  "scanning the horizon",
  "reading the stars",
  "dousing the lanterns",
];

/**
 * The doc surface the Ctrl-O viewer overlay reads through. This is the SAME
 * sandboxed doc tool the model uses (listDocs/readDoc resolve inside docs/ and
 * reject any path that escapes it), so the overlay is structurally incapable of
 * listing or opening anything under `.memory/` — it can only ever name a `.md`
 * file the sandbox already vetted. Live refresh rides the serialized memory
 * write queue: onWrite fires with the doc's bare filename after a completed
 * write, and only the doc tier emits there, so the hidden substrate stays
 * invisible to this feature.
 */
function docSource(paths: InstancePaths): DocSource {
  return {
    list: () => listDocs(paths),
    read: (name) => readDoc(paths, name),
    subscribe: (listener) => onWrite((e) => listener(e.name)),
  };
}

/**
 * Run one of the captain's task-table writes for the panel.
 *
 * The store has already mutated in memory by the time this is called (its
 * operations do that synchronously and only the file write is awaited), so the
 * panel repaints immediately and this settles a moment later with the verdict.
 * A refusal — a full table, a row the co retired between the paint and the
 * keystroke — comes back as the one line the panel has room for, never as a
 * thrown error over a session.
 */
async function taskWrite(op: Promise<unknown>): Promise<{ ok: boolean; message?: string }> {
  try {
    await op;
    return { ok: true };
  } catch (e) {
    if (e instanceof TaskError) return { ok: false, message: e.message };
    return { ok: false, message: `the task table could not be written: ${(e as Error).message}` };
  }
}

/** The chore showing right now, so we never pick the same one twice running —
 *  a repeat reads as a stuck spinner, which is the bug this whole thing fixes. */
let lastChore = "";

function pirateChore(): string {
  if (BUSY_CHORES.length < 2) return BUSY_CHORES[0] ?? "working";
  let pick = lastChore;
  while (pick === lastChore) {
    pick = BUSY_CHORES[Math.floor(Math.random() * BUSY_CHORES.length)]!;
  }
  lastChore = pick;
  return pick;
}

export async function runSession(cfg: Config, paths: InstancePaths): Promise<void> {
  // Bring a pre-reorg instance onto the two-tier layout (docs/ + .memory/)
  // before anything reads or writes its memory. Idempotent: a no-op for
  // instances already on the new layout.
  const migration = await migrateInstanceLayout(paths);
  if (migration.moved > 0) {
    line(c.dim(`migrated ${paths.name} to the docs/ + .memory/ layout — ${migration.moved} file(s) moved.`));
  }
  if (migration.mergedEntries > 0) {
    line(c.dim(`  folded ${migration.mergedEntries} log entr(ies) into the existing logs.`));
  }
  for (const r of migration.renumbered) {
    line(c.dim(`  re-minted colliding decision id ${r}`));
  }
  // Parked snapshots need a human to pick a winner, so they're called out by
  // path rather than counted.
  for (const f of migration.parked) {
    line(
      c.yellow(
        `  couldn't auto-merge ${path.basename(f)} — both copies exist; the old one is now at ${f}. Compare and keep the better one.`,
      ),
    );
  }
  if (migration.conflicts > 0) {
    line(
      c.yellow(
        `  ${migration.conflicts} file(s) were left in the old layout because a destination already existed. Inspect ${paths.root}.`,
      ),
    );
  }

  const model = new ModelProvider(cfg.model);
  const effects = newSideEffects();

  // Open the durable transcript BEFORE building the system prompt so we can
  // exclude this fresh (empty) session file from the recent-conversation tail:
  // the tail must reflect the PRIOR session, not the one we just started. Every
  // turn is appended to it as it happens (see runUserTurn/drive), so a crash,
  // Ctrl-C, or kill never costs the conversation. This is the record; docs/ and
  // .memory/ hold the curated memory that cold start reads.
  const transcript = await startTranscript(paths, { model: cfg.model.modelId });

  // Dispatch is available only when the instance has been linked to a repo
  // (`co link`). When linked, the model gets the dispatch_order tool and the
  // prompt says so; unlinked, none of the dispatch machinery is created and the
  // co-manager writes plain-text orders exactly as before.
  const dispatch = await readDispatchConfig(paths);

  // The durable half of a feature record: the one-line intents the co authored at
  // create time, and the PR title/body it authored at enqueue. Everything else
  // about a feature is rebuilt from git by the boot reconcile below; that prose is
  // what git cannot recover, so it is read back from disk here — which is what
  // lets a recovered worktree still show its description, and a head re-processed
  // after a restart still open its pull request with the message the co wrote.
  const featureStore = await FeatureStore.load(paths);

  // The captain's at-a-glance task table, painted AND edited on the panel's Home
  // tab. Loaded whether or not the instance is linked — the table needs no repo
  // — and a missing or corrupt file is simply an empty table.
  const taskStore = await TaskStore.load(paths);

  // The spend meter. Loads before the first turn (including the cold-start
  // greeting, which is a real billed turn) and is otherwise silent all session.
  const costs = await CostLedger.load(paths);

  // The resident prompt is static (identity + behaviour + tools); everything
  // per-instance rides the startup injection below, as the first message of
  // history, where it ages and scrolls like the state it is.
  const system = buildSystemPrompt({ dispatch: Boolean(dispatch) });
  const briefing = await buildStartupInjection(paths, cfg.research, {
    excludeTranscript: transcript.file,
    // The table is read ONCE, here. The captain edits it all session from the
    // panel; the co reads the current table with `task_table list`.
    tasks: taskStore.list(),
    dispatch: dispatch
      ? {
          repoPath: dispatch.repoPath,
          transport: dispatch.anchor
            ? "visible Ghostty pane"
            : "none yet — no crew pane designated (`co pane`); a dispatch fails cleanly until one is",
          agents: dispatch.agents.map((a) => a.name),
          defaultAgent: dispatch.defaultAgent,
        }
      : null,
  });

  // The scroll/selection hint only applies to the interactive TUI; it would be
  // misleading in piped output where there's no scrolling, so it's TUI-only.
  const tui = Tui.capable();
  const header = bannerText(paths.name, cfg, tui, Boolean(dispatch));
  const io: SessionIO = tui
    ? new Tui({
        promptLabel: PROMPT_LABEL,
        header,
        // Whether the sea at the foot of the Home tab may move. The Tui starts
        // that one itself (there is no caller to hand it a spec), so the
        // CO_VISUALS decision has to reach it as a predicate instead — resolved
        // per call for the same reason visualsFor is, and hard-coded plainIO
        // false because this branch IS the Tui.
        scenery: () => currentVisuals({ plainIO: false }).animate,
        docs: docSource(paths),
        // The Home tab's task table: read fresh at paint time,
        // so a row either writer added shows on the next paint. Wired whether or
        // not the instance is linked, so Ctrl-O always has a Home.
        //
        // The four writes are the captain's own keys (a/e/x/s), calling straight
        // into the SAME store the co's task_table tool holds — one table with
        // two writers, not two copies of one. Each names a single row, so
        // neither writer can clobber the other's, and a refusal (a full table, a
        // row that has since moved) comes back as a line the panel prints rather
        // than an exception.
        //
        // `list` hands over STORED order; the panel paints it building-first
        // through the shared helper, exactly as the tool and the live-state
        // block do. Sorting here instead would give the panel one order and the
        // tool another the day one of them stopped calling it.
        tasks: {
          list: () => taskStore.list(),
          add: (task) => taskWrite(taskStore.add(task)),
          setStatus: (task, status) => taskWrite(taskStore.setStatus(task, status)),
          rename: (task, next) => taskWrite(taskStore.rename(task, next)),
          retire: (task) => taskWrite(taskStore.retire(task)),
        },
        // The merge-queue panel tab only exists when the instance is linked (a
        // queue needs a repo). Read fresh at paint time via the FeatureManager,
        // which is created below; the closure is never called before then.
        //
        // `merge` is what makes the tab panel-native (D-20260724-12): the
        // captain's [m] on a ready head calls straight into the engine here, so
        // the merge never routes through a tool call and the co's loop is never
        // parked on the keystroke. It is the ONLY caller of mergeReadyHead in an
        // interactive session.
        ...(dispatch
          ? {
              queue: {
                view: () =>
                  state.features
                    ? state.features.queueView()
                    : { size: 0, head: null, entries: [] },
                headDetail: () => state.features?.headDetail() ?? null,
                merge: () => panelMergeHead(state),
                // `e` in the queue tab edits the head PR's message in place
                // (D-20260727-15). Like `merge` it is a keystroke calling
                // straight into the engine — but it merges nothing: it rewrites
                // a title and a description on GitHub and in the feature store,
                // and leaves the checks, the gate and the queue untouched.
                editPrMessage: (message) => panelEditPrMessage(state, message),
              },
              // The Home tab's worktree list: every tracked worktree, not just
              // the queued ones. Derived in memory from the registry + the queue
              // + the stored intents, so this reads fresh at paint time like the
              // other sources and costs no git call and no model call. `refresh`
              // is the one exception and the reason it exists: the dirty flag
              // needs a `git status` per worktree, so the panel asks for it when
              // the captain opens Home and never on a paint.
              features: {
                list: () => state.features?.overview() ?? [],
                refresh: () => state.features?.refreshDirty() ?? Promise.resolve(),
              },
            }
          : {}),
      })
    : new PlainIO(PROMPT_LABEL, header);

  const state: SessionState = {
    cfg,
    paths,
    model,
    system,
    // Layer 3: the session briefing opens the history. It is a plain user
    // message - internal scaffolding, never logged as a "you" turn - and the
    // rolling anchors cache it incrementally like everything after it.
    messages: [{ role: "user", content: briefing }],
    effects,
    io,
    transcript,
    userTurns: 0,
    lastTurnEndedAt: null,
    inTurn: false,
    keepAlive: null,
    dispatch,
    registry: null,
    features: null,
    armed: null,
    reviewQueue: [],
    queueNotices: [],
    historyNotes: [],
    tasks: taskStore,
    costs,
  };

  // Wire the job registry when linked. On completion a job is queued for review
  // and the input loop is woken so the co reviews it on the next idle prompt,
  // without the captain pasting anything. The wake preserves any half-typed line.
  if (dispatch) {
    state.registry = new DispatchRegistry({
      paths,
      config: dispatch,
      onComplete: (job) => {
        state.reviewQueue.push(job);
        io.appendBlock(
          c.dim(`  · crew job ${job.id} ${job.status === "done" ? "finished" : "failed"}: ${job.label}`),
        );
        io.wake("dispatch-complete");
      },
      onAnchorLost: () => {
        io.appendBlock(
          c.yellow(
            "  · the designated crew pane is gone (closed since `co pane`). Running in the background instead; re-run `co pane` to restore the visible pane.",
          ),
        );
      },
      onHookIssue: (message) => {
        io.appendBlock(
          c.yellow(
            `  · crew completion hook not installed: ${message} Results will land when the pane closes.`,
          ),
        );
      },
    });

    // The feature levers drive the parallel-worktree flow over the registry.
    // The landing gate needs the interactive overlay (openLandingReview), which
    // only the Tui provides; on PlainIO (piped/non-TTY) the engine reports it
    // needs an interactive session rather than crashing.
    state.features = new FeatureManager({
      registry: state.registry,
      repoPath: dispatch.repoPath,
      store: featureStore,
      ...(io instanceof Tui ? { gateHost: io } : {}),
    });
  }

  io.start();

  // The linked repo is the cwd of every git call in the feature layer AND of
  // every crew dispatch, so a path that is missing or is not a repository root
  // disables both — silently, until something deep in git plumbing throws. It is
  // checked once here so the session opens by naming the config value at fault
  // instead of letting a `spawn git ENOENT` pass itself off as a broken git
  // install (the fault this whole check was written for; see checkRepoPath).
  let repoUsable = true;
  if (dispatch) {
    const repo = await checkRepoPath(dispatch.repoPath);
    if (!repo.ok) {
      repoUsable = false;
      io.appendBlock(c.yellow(`  · the linked repo is unusable: ${repo.reason}`));
      io.appendBlock(c.dim(`    stored in ${paths.dispatchConfig}`));
      io.appendBlock(
        c.dim(`    Feature and dispatch levers fail until it is fixed — re-run \`co link ${paths.name}\`.`),
      );
    }
  }

  // Boot reconcile: rebuild feature records from the on-disk worktrees so a
  // feature (1 feature → 1 worktree → 1 branch) survives a restart. Read-only
  // over feature state — it rebuilds records and SURFACES anomalies (a branch
  // with unmerged work but no worktree, a stray dir), destroying nothing.
  // Best-effort: a repo that has never seen the flow, or a git hiccup, must not
  // block the session opening. Skipped outright when the repo path is already
  // known bad, so the one honest message above is not followed by its symptom.
  if (state.features && repoUsable) {
    try {
      const report = await state.features.reconcileAtBoot();
      if (report.records.length > 0) {
        io.appendBlock(
          c.dim(
            `  · recovered ${report.records.length} feature worktree(s): ${report.records
              .map((r) => r.slug)
              .join(", ")}`,
          ),
        );
      }
      for (const a of report.anomalies) {
        io.appendBlock(c.yellow(`  · feature anomaly (${a.kind}): ${a.detail}`));
      }
    } catch (e) {
      io.appendBlock(
        c.yellow(`  · could not reconcile feature worktrees at startup: ${(e as Error).message}`),
      );
    }
  }

  // On a real terminal, open with a short spoken greeting: the co reads its
  // live state (already in the system prompt) and reports where we left off,
  // in character. Skipped for piped/non-TTY sessions (scripts, tests) so their
  // output stays deterministic and we don't burn a model call before the first
  // scripted command.
  if (tui) {
    await runOpeningGreeting(state);
  }

  // Started after the greeting, so the first thing it can ever refresh is a
  // prefix a real turn has already written. Interactive sessions only: a piped
  // or scripted run has no thinking pauses to protect and must stay
  // deterministic.
  if (tui && cfg.model.cacheKeepAliveMs > 0) {
    state.keepAlive = startCacheKeepAlive({
      intervalMs: cfg.model.cacheKeepAliveMs,
      maxConsecutive: cfg.model.cacheKeepAliveMax,
      isBusy: () => state.inTurn,
      // Read fresh on every probe rather than captured once: the history grows
      // all session, and a stale snapshot would refresh a prefix that no longer
      // matches what the next turn will send.
      snapshot: () =>
        state.messages.length === 0
          ? null
          : {
              system: state.system,
              messages: state.messages,
              tools: toolDefinitions({ dispatch: Boolean(state.dispatch) }),
            },
      refresh: (s) => state.model.refreshCache(s),
      // Metered apart from turns: real spend, but not a turn (see cost.ts).
      record: (usage, ms) => state.costs.recordKeepAlive(state.model.modelId, usage, { ms }),
      ...(cfg.model.debugTiming ? { onNote: (l) => io.appendBlock(c.dim(`  ⏱ ${l}`)) } : {}),
    });
  }

  try {
    while (true) {
      // Deliver any completed crew reviews BEFORE idling on input. This is the
      // single drain point: a completion that fired mid-turn calls io.wake()
      // while no question() is pending — the wake is dropped by design — and a
      // slash-command turn `continue`s without reaching any post-turn hook, so
      // draining anywhere later than the top of the loop leaves queued reviews
      // parked until an unrelated event. Every path re-enters here.
      await drainReviews(state);
      // Same contract for anything the panel-native merge left the co to handle
      // (a blocked new head, a refused merge). Drained after the reviews so a
      // completion that arrived first still reports first.
      await drainQueueNotices(state);

      const input = await io.question();
      if (input === null) break; // EOF → clean exit, run the guard below

      // Wake sentinel: a background dispatch finished (or another out-of-band
      // event) and asked for a turn. The loop top drains the queue on the next
      // iteration; the captain's half-typed line is preserved across the wake.
      if (input === WAKE_SENTINEL) {
        continue;
      }

      const raw = input.trim();
      if (raw === "") continue;

      // Confirm interlock: while a dispatch is armed, ONLY a typed `confirm`
      // (case-insensitive) fires it. A bare `confirm` uses the default crew
      // agent; `confirm <name>` targets a specific one for this dispatch only.
      // Anything that isn't a confirm cancels the armed dispatch and is then
      // handled as ordinary input. There is no other path to launch a dispatch,
      // so nothing runs without this explicit confirmation.
      if (state.armed) {
        const confirm = parseConfirm(raw);
        if (confirm.isConfirm) {
          const config = state.dispatch;
          // An explicit agent name must resolve; if it doesn't, keep the order
          // armed (don't make the captain re-draft) and show the valid names.
          if (confirm.agent && config && !resolveAgent(config, confirm.agent)) {
            const names = config.agents.map((a) => a.name).join(", ");
            io.appendBlock(
              c.yellow(
                `  · unknown crew agent "${confirm.agent}". Available: ${names}. Type \`confirm <name>\` or plain \`confirm\` for the default (${config.defaultAgent}).`,
              ),
            );
            continue; // stays armed
          }
          const armed = state.armed;
          state.armed = null;
          io.setConfirmBanner(null);
          await appendTranscript(state.transcript, "you", raw);
          // The lane is decided HERE, from the verb the captain typed and a
          // FRESH reading of the target worktree — never from the arm-time
          // snapshot. If the other agent finished while the order sat armed,
          // the worktree is unoccupied again and a bare `confirm` means what it
          // has always meant there: full write access.
          const lane = laneForConfirm(state, armed, Boolean(confirm.write));
          // That is a wider grant than the banner offered, so it is said out
          // loud. A lane the captain did not read about is exactly the surprise
          // this gate exists to prevent.
          if (armed.occupied && lane === "writer" && !confirm.write) {
            io.appendBlock(
              c.dim(
                "  · the other agent has since finished, so the worktree is free and `confirm` granted" +
                  " the full writing lane, not the read-only one the banner offered.",
              ),
            );
          }
          await fireDispatch(state, armed.order, confirm.agent, armed.feature, armed.resolve, lane);
          continue;
        }
        // Recorded BEFORE the line that cancelled it is appended, which is what
        // pushUserTurn's flush guarantees: the co reads "you were cancelled"
        // and then what the captain said instead, on the one turn it has to
        // react to both. Without this it could only guess which of the two
        // resolutions its armed order got.
        noteDispatchCancelled(state, state.armed.order);
        state.armed = null;
        io.setConfirmBanner(null);
        io.appendBlock(c.dim("  · dispatch cancelled."));
        // Fall through: treat the typed line as normal conversation/command.
      }

      // Record what the captain actually typed, verbatim, before dispatching.
      // Hidden instruction injections (greeting, /decide, /sync) are internal
      // scaffolding and are deliberately not logged as "you" turns.
      await appendTranscript(state.transcript, "you", raw);

      if (raw.startsWith("/")) {
        const handled = await handleCommand(state, raw);
        if (handled === "exit") break;
        continue;
      }

      // A real spoken turn: the exit distill uses this to know the session had
      // conversational substance worth preserving, even if no tool ran.
      state.userTurns++;
      await runUserTurn(state, raw);
      // Reviews that completed during the turn are drained at the loop top.
    }
  } finally {
    state.registry?.stop();
    // Stopped BEFORE the exit guard, which runs a real model turn of its own: a
    // probe firing alongside the distill would race it for the same entry, and
    // there is nothing left to keep warm afterwards either way.
    state.keepAlive?.stop();
    state.keepAlive = null;
    // The end-of-session guard runs inside the live UI so its prompts render
    // in-session; then we tear the UI down and leave a short, persistent
    // footprint on the user's primary screen.
    await endOfSessionGuard(state);
    io.stop();
    printClosingSummary(state);
  }
}

/**
 * After restoring the terminal, print a short recap that survives on screen.
 * This is orientation only — the co-manager's name and where its workspace
 * lives. It deliberately does NOT list what was written this session: memory is
 * self-managed and invisible, surfaced only when the captain asks for it.
 */
function printClosingSummary(state: SessionState): void {
  line(c.magenta(`co-manager: ${state.paths.name}`));
  line(c.dim(`  memory: ${state.paths.root}`));
}

const COMPACT_REQUEST =
  "Session compaction (bookkeeping, not a question from the captain). This" +
  " conversation has grown long enough to be worth compressing. Write a summary" +
  " of everything we have discussed SO FAR that you would want in front of you" +
  " to carry on without a gap. Keep: decisions reached and the reasoning behind" +
  " them, what is currently in flight, anything unresolved or awaiting the" +
  " captain, constraints and corrections he has given you, and the thread of" +
  " what we were doing. Drop: pleasantries, superseded working detail, and" +
  " anything already written to memory or the logs, which you can search. Write" +
  " it as notes to yourself in plain prose, no preamble, no sign-off. Do not" +
  " address the captain and do not call any tools.";

/**
 * Append a turn's own message to the model's history, after anything that
 * happened outside the loop and before it.
 *
 * Every user-role message the session appends goes through here, and that is
 * what makes the ordering guarantee hold without a rule anyone has to remember:
 * a cancellation recorded in the input loop is already in the history by the
 * time the line that caused it is added. The one deliberate exception is the
 * compaction request, which snapshots the history length around its own push and
 * would slice a note flushed there back off again; a note that arrives during a
 * compaction simply stays pending for the next turn.
 */
function pushUserTurn(state: SessionState, content: string): void {
  flushHistoryNotes(state, state.messages);
  state.messages.push({ role: "user", content });
}

async function runUserTurn(state: SessionState, userText: string): Promise<void> {
  pushUserTurn(state, userText);
  await drive(state);
  // After the turn, never before: compacting first would summarise a history
  // that is about to grow anyway, and the captain would wait through a
  // summarising call before getting an answer to what they actually asked.
  await maybeCompact(state);
}

/**
 * Spoken cold-start greeting. The co's live state and the verbatim tail of the
 * last conversation are already in the system prompt, so it can orient with no
 * tool calls. We inject a hidden instruction as the first user turn (same
 * mechanism /sync and /decide use) and let the normal streaming render it in
 * character.
 *
 * The greeting draws on BOTH the curated live state and the recent-conversation
 * tail. This matters: if the last session ended without distilling (a crash, or
 * a purely conversational turn), live state may be thin while the tail still
 * holds the real thread. Reporting "blank charts" then would be wrong — the tail
 * is the floor, so the greeting must use it. Only a truly fresh instance (no
 * live state AND no tail) is treated as a blank start.
 */
async function runOpeningGreeting(state: SessionState): Promise<void> {
  pushUserTurn(
    state,
    "SESSION START (spoken by you, the co-manager, unprompted). You have just" +
      " come aboard and read your session briefing above, which holds your live" +
      " state AND a verbatim tail of our last conversation. Greet the captain and" +
      " report where we left off. Open with an acknowledgement in character — e.g." +
      ' "Aye, ready to work, captain." — then, in 2-4 sentences, summarise the' +
      " current focus, anything in flight, and the most useful next step. Draw on" +
      " your live state first; where it is thin or stale, lean on the recent" +
      " conversation tail to say what we were actually just discussing — do not" +
      " claim the charts are blank when that tail shows real work. ONLY if there is" +
      " genuinely nothing to go on — empty live state AND no recent conversation —" +
      " say so plainly and ask what we're charting, rather than inventing history." +
      " Do not call any tools; do not list open questions exhaustively. Keep it tight.",
  );
  // Deliberately low effort. This turn blocks the first prompt, so its latency is
  // the most visible in the whole session — and it is the least demanding work
  // the co does: summarise state that is already sitting in the system prompt,
  // no tools, no reasoning. Spending session-default effort here bought nothing
  // but a longer wait before the captain could type.
  await drive(state, { effort: "low" });
}

/**
 * Run the model to completion for the current message history.
 *
 * `effort` runs this one turn at a different depth than the session default —
 * used by the cold-start greeting, which is pure summarisation of context the
 * model already has and does not need the session's reasoning depth.
 *
 * `quiet` runs the turn without rendering the model's spoken reply to the
 * screen. Its tool calls still execute (so memory writes happen) and its output
 * is still recorded to the durable transcript — only the on-screen "co ›"
 * stream, busy indicator, and surfaced-tool notices are suppressed. Used by the
 * end-of-session distill: that turn is the co's own bookkeeping, and rendering
 * it made `/exit` look like the co was replying to a chat message.
 */
async function drive(
  state: SessionState,
  opts: { effort?: Effort; quiet?: boolean } = {},
): Promise<string> {
  const { effort, quiet } = opts;
  const { io } = state;
  // Stamped before any model work so the gap measured is the captain's thinking
  // pause, not the pause plus this turn's latency.
  const turnStartedAt = Date.now();
  const idleMs = state.lastTurnEndedAt === null ? 0 : turnStartedAt - state.lastTurnEndedAt;
  state.inTurn = true;
  const executor = makeExecutor({
    paths: state.paths,
    research: state.cfg.research,
    effects: state.effects,
    onNotice: (msg) => {
      // Only external work (web search, fetch) reaches here; memory operations
      // are silent and never call onNotice. Surface the activity and keep it in
      // the raw transcript, interleaved with talk. A quiet turn (exit distill)
      // still records to the transcript but shows nothing on screen.
      if (!quiet) io.appendBlock(c.dim(`  · ${msg}`));
      void appendTranscript(state.transcript, "note", msg);
    },
    // Only wired when the instance is linked. Arming shows the confirm banner and
    // records the order; it never launches — the input loop's `confirm` branch is
    // the only path that fires a dispatch. The feature levers ride the same link
    // gate, so they are exposed together.
    ...(state.dispatch
      ? { onArmDispatch: (order: string, feature?: string) => armDispatch(state, order, feature) }
      : {}),
    ...(state.features ? { features: state.features } : {}),
    ...(state.dispatch && state.features ? { onArmResolve: () => armResolve(state) } : {}),
    // The task table the Home tab paints. Always wired: it is the co's own state
    // and outlives any link to a repo.
    tasks: state.tasks,
  });

  // Streaming render state. "mode" tracks whether the open transcript line is
  // currently carrying answer text or nothing yet, so we know when to break to a
  // fresh line and re-emit the label.
  let mode: "none" | "text" = "none";
  let startedText = false;
  // Accumulate the visible answer verbatim (no ANSI) for the durable transcript.
  let answer = "";

  if (!quiet) io.appendBlock(""); // blank spacer before the assistant turn

  // The busy indicator runs from the moment we call the model until the first
  // token lands, and again for the duration of every tool call. Without it, a
  // silent memory write plus the follow-up model call is several seconds of a
  // terminal that looks hung. A quiet turn stays off the wheel entirely — it
  // runs after `/exit`, where any flicker reads as the co still talking.
  if (!quiet) io.setBusy(pirateChore());

  let result;
  try {
    result = await state.model.runTurn({
      system: state.system,
      messages: state.messages,
      tools: toolDefinitions({ dispatch: Boolean(state.dispatch) }),
      executor,
      ...(effort ? { effort } : {}),
      handlers: {
        // Only fires under CO_DEBUG_TIMING. Rendered through io so it lands in
        // the TUI frame rather than corrupting the alt screen.
        onTiming: (l) => io.appendBlock(c.dim(`  ⏱ ${l}`)),
        onText: (d) => {
          // Always accumulate for the durable transcript; only render when the
          // turn is not quiet.
          startedText = true;
          answer += d;
          if (quiet) return;
          io.setBusy(null);
          if (mode !== "text") {
            io.flushStream();
            io.appendStream(c.green("co  › "), { markdown: true });
            mode = "text";
          }
          io.appendStream(d, { markdown: true });
        },
        onToolUse: (name) => {
          if (quiet) return;
          io.flushStream();
          // Only surface external work in the transcript. Memory reads and
          // writes are the co-manager's private bookkeeping and stay invisible
          // there — but they still drive the ephemeral busy indicator, which
          // shows activity without narrating what was written.
          if (SURFACED_TOOLS.has(name)) {
            io.appendBlock(c.dim(`  · using ${name}…`));
          }
          io.setBusy(pirateChore());
          mode = "none";
        },
      },
    });
  } finally {
    // Never leave the wheel spinning — including when the turn throws.
    io.setBusy(null);
    // Bank what this turn cost, before anything else can fail. In the `finally`
    // so a turn that threw still records the rounds that completed and were
    // billed; a quiet turn (the exit distill) is metered exactly like a spoken
    // one, because it costs exactly like one.
    const spent = state.model.drainUsage();
    await state.costs.record(state.model.modelId, spent.usage, {
      ms: spent.ms,
      rounds: spent.rounds,
      rebuild: spent.rebuild,
      idleMs,
    });
    // Set even on a turn that threw: the cache clock started ticking from the
    // last request the model actually served, not from the last one that
    // succeeded, so a failed turn still resets the gap.
    state.lastTurnEndedAt = Date.now();
    state.inTurn = false;
    // The turn just touched every cache entry a probe would have, so the
    // keep-alive's clock restarts from here rather than from the last probe.
    state.keepAlive?.noteTurn();
  }

  // If the model produced no streamed text but a final string exists, show it
  // (unless quiet — still capture it for the transcript).
  if (!startedText && result.finalText) {
    answer = result.finalText;
    if (!quiet) {
      io.flushStream();
      io.appendStream(c.green("co  › "), { markdown: true });
      io.appendStream(result.finalText, { markdown: true });
    }
  }
  if (!quiet) io.flushStream();
  state.messages = result.messages;

  // Persist the co's turn as soon as it lands — the "save along the way" path.
  await appendTranscript(state.transcript, "co", answer);
  // Returned for the callers that need the words rather than the side effects:
  // compaction feeds the reply straight back into the history as its summary.
  return answer;
}

/**
 * The hard history ceiling, engaged when a session runs long.
 *
 * The cap is generous because compaction is expensive: a cached read bills at
 * 0.1x base input and a 1-hour write at 2x, and every compaction rewrites the
 * retained tail, so a normal session should never reach it. What HARD buys is
 * the other end: a runaway session trims in a controlled way instead of
 * growing until the API refuses the request mid-conversation.
 *
 * Nothing is lost that the co cannot get back. The transcript is written every
 * turn and the logs are append-only and searchable, so this moves detail out
 * of the live window, not off the disk.
 */
async function maybeCompact(state: SessionState): Promise<void> {
  const maxBytes = state.cfg.model.historyMaxBytes;
  if (maxBytes <= 0) return;
  const plan = planCompaction(state.messages, {
    maxBytes,
    keepTurns: state.cfg.model.compactKeepTurns,
  });
  if (!plan) return;

  // Snapshot the length before the summarising turn appends to it, so the cut
  // index computed above still addresses the same messages afterwards.
  const before = state.messages.length;
  // Deliberately NOT pushUserTurn: this snapshot is what the compaction slices
  // back to, so a note flushed here would be cut off again. Pending notes wait
  // for the next real turn instead (see pushUserTurn).
  state.messages.push({ role: "user", content: COMPACT_REQUEST });
  // Low effort deliberately: this is a summary of context the model is already
  // holding, the same call the cold-start greeting makes, and reasoning depth
  // buys nothing here while being billed on every token of it.
  const summary = await drive(state, { quiet: true, effort: "low" });
  if (summary.trim() === "") {
    // No usable summary: leave the history exactly as it was. A compaction that
    // dropped turns and replaced them with nothing would be worse than the cost
    // it was trying to avoid.
    state.messages = state.messages.slice(0, before);
    return;
  }

  // Orientation rides the compaction message so it can never be summarized
  // out of the window (see applyCompaction). Best-effort: a read failure
  // costs the re-injection, never the compaction itself.
  let orientation: string | undefined;
  try {
    const live = await readLiveMemory(state.paths);
    orientation = (Object.keys(live) as LiveFile[])
      .map((f) => `## .memory/${f}\n\n${live[f].trim() || "(empty)"}`)
      .join("\n\n");
  } catch {
    orientation = undefined;
  }
  state.messages = applyCompaction(state.messages.slice(0, before), plan.cut, summary, orientation);

  // The compacted head may have carried protocol sections, so the live window
  // can no longer be assumed to hold them. Resetting the ledger keeps its
  // meaning crisp - "this section is verbatim in the window" - and restores
  // both mechanisms: the next re-read returns the real body, and the next
  // gated act is re-handed the contract. Worst case is one redundant copy.
  state.effects.protocolsRead.clear();

  // Said out loud, unlike every other piece of the co's bookkeeping. Memory
  // writes are invisible because they change nothing the captain can observe;
  // this changes what the co can recall mid-conversation, and a co that quietly
  // stops remembering something you both said an hour ago is a bug report
  // waiting to happen. One dim line, once.
  const freed = plan.before - plan.after;
  const note = `compacted earlier conversation (~${Math.round(freed / 1024).toLocaleString("en-US")} KB)`;
  state.io.appendBlock(c.dim(`  · ${note}`));
  // Written to the transcript as well as the screen, unlike the screen-only
  // notices elsewhere. A compaction is the one piece of bookkeeping whose effect
  // outlives the session: it is why the co may not recall something later, and
  // it is the only record that the ceiling ever engaged. The first attempt at
  // auditing this feature failed precisely because the notice was on screen and
  // nowhere else, so "did it fire?" was unanswerable after the fact.
  await appendTranscript(state.transcript, "note", note);
}

// --- dispatch (arm → confirm → launch → review) ------------------------------

/**
 * Arm a dispatch (called by the dispatch_order tool via the executor). Records
 * the order and shows the confirm banner; it launches NOTHING. Returns a short
 * summary for the tool result. Re-arming replaces any prior armed order — only
 * one can be pending, and the last one the model staged this turn wins.
 */
async function armDispatch(
  state: SessionState,
  order: string,
  feature?: string,
): Promise<{ armed: true; summary: string } | { armed: false; reason: string }> {
  // Read the config the NEXT dispatch will actually use, re-reading disk so a
  // mid-session `co link` is reflected. Without this the banner shows the config
  // snapshotted at session start (state.dispatch) — the exact bug where a
  // re-linked crew command still displayed the old, broken word. We refresh the
  // cached snapshot too so the `confirm <agent>` validation agrees with the banner.
  const config = state.registry ? await state.registry.currentConfig() : state.dispatch;
  if (config) state.dispatch = config;
  if (!config) return { armed: false, reason: "This instance is not linked; run `co link` first." };
  if (!config.repoPath) {
    return { armed: false, reason: "No repo path is registered. Re-run `co link` to set one." };
  }
  if (config.agents.length === 0) {
    return { armed: false, reason: "No crew agent is registered. Re-run `co link` to set one." };
  }
  const target = feature && feature.trim() ? feature.trim() : undefined;
  // Who is already in that worktree. This is the whole gate: an empty list is
  // the ordinary dispatch, unchanged in every particular; anything in it turns
  // the banner into a lane choice (D-20260729-5).
  const live = target ? activeAgentsFor(state, target) : [];
  state.armed = { order, ...(target ? { feature: target } : {}), ...(live.length ? { occupied: true } : {}) };

  const cmd = displayCommand(resolveAgentCommand(config), config.repoPath);
  // Dispatch is visible-only: a crew agent runs in a visible Ghostty pane or not
  // at all. When no pane can be placed the banner says so up front so the captain
  // isn't surprised by a clean failure at fire time.
  const paneReady = state.registry?.paneReady ?? false;
  const transport = paneReady
    ? "visible Ghostty pane"
    : "no crew pane available — run `co pane` to designate one";
  // Where the crew will run: a feature's isolated worktree (naming the path when
  // it is already provisioned) or the bare main tree. This is the target line the
  // captain confirms against — an invisible cwd is the surprise it forecloses.
  const targetLine = describeTarget(state, target, config.repoPath);
  // Offer the named alternatives only when there's a real choice to make.
  const others = config.agents.map((a) => a.name).filter((n) => n !== config.defaultAgent);
  const overrideHint =
    others.length > 0 ? `  or \`confirm <${others.join("|")}>\` to pick another agent` : "";
  // The enforcement clause is stated for the agent a bare confirm would run.
  // An override picks a different agent at fire time, and the dispatch line says
  // what THAT one got — so nothing here ever over-claims for an agent that never ran.
  const enforcement = readOnlyEnforcement(resolveAgentCommand(config));
  state.io.setConfirmBanner([
    live.length > 0
      ? c.yellow(c.bold(`  ⚑ dispatch armed — feature '${target}' ALREADY HAS ${describeAgents(live)}`))
      : c.yellow(c.bold("  ⚑ dispatch armed — type `confirm` to launch, anything else cancels")),
    ...(live.length > 0
      ? [
          c.yellow(
            "  ⚠ a second WRITER shares one git index, one dist/ and one node_modules: a scratch file," +
              " a coverage dir or a build artifact it drops can be swept into the other agent's next" +
              " `git add -A` commit, unseen by either of them.",
          ),
          c.dim(
            `  \`confirm\` → READ-ONLY lane: the order is prefixed with a no-writes-of-any-kind mandate,` +
              ` and for ${config.defaultAgent} that is ${enforcement.detail}.`,
          ),
          c.dim(
            "  `confirm write` → a SECOND WRITING lane. Both agents write this worktree. Anything else cancels.",
          ),
        ]
      : []),
    c.dim(`  transport: ${transport}   agent: ${config.defaultAgent}   command: ${cmd}`),
    c.dim(`  target: ${targetLine}`),
    ...(overrideHint ? [c.dim(overrideHint)] : []),
    c.dim(`  order: ${firstLineOf(order)}`),
  ]);
  const targetSummary = target
    ? ` It targets feature '${target}' (its isolated worktree${
        state.features?.list().some((f) => f.feature === target || f.slug === target)
          ? ""
          : ", provisioned on first use"
      }).`
    : " It targets the bare main tree (no feature).";
  const laneSummary =
    live.length > 0
      ? ` NOTE: that worktree already has ${describeAgents(live)}, so this dispatch is LANE-GATED:` +
        ` a bare \`confirm\` grants the READ-ONLY audit lane (${enforcement.detail} for ${config.defaultAgent})` +
        ` and \`confirm write\` grants a second WRITING lane. The captain chooses, not you.` +
        ` If it lands as a read-only run you will be handed its findings as context to answer with,` +
        ` and you must NOT file a review for it.`
      : "";
  return {
    armed: true,
    summary:
      (paneReady
        ? `It will run in a visible Ghostty pane as: ${cmd} (agent ${config.defaultAgent}).` +
          (others.length > 0
            ? ` The captain can type \`confirm <${others.join("|")}>\` to pick another.`
            : "")
        : `No crew pane is available, so a dispatch will fail cleanly until one is designated with \`co pane\`.` +
          ` The intended command is: ${cmd} (agent ${config.defaultAgent}).`) +
      targetSummary +
      laneSummary,
  };
}

/**
 * The crew agents live in a feature's worktree right now, with their roles. Goes
 * through the FeatureManager first so a feature addressed by slug and one
 * addressed by its created name resolve to the SAME worktree — the occupancy
 * question must not come back empty just because the co armed under a different
 * handle than the running job used. Falls back to the registry for a feature
 * that has no record yet (nothing can be running in a worktree that does not
 * exist, so that answer is empty too, but it stays honest rather than assumed).
 */
function activeAgentsFor(state: SessionState, feature: string): ActiveAgent[] {
  const view = state.features?.list().find((f) => f.feature === feature || f.slug === feature);
  if (view) return view.agents;
  return state.registry?.activeAgents(feature) ?? [];
}

/** "a live crew agent (job-002 [cc], writing)" — the banner's subject line. */
function describeAgents(agents: ActiveAgent[]): string {
  const parts = agents.map(
    (a) =>
      `${a.jobId}${a.agentName ? ` [${a.agentName}]` : ""}, ${a.lane === "writer" ? "WRITING" : "read-only"}`,
  );
  return `${agents.length === 1 ? "a live crew agent" : `${agents.length} live crew agents`} (${parts.join("; ")})`;
}

/**
 * Which lane a confirmed dispatch gets. Read fresh at fire time, never from the
 * arm-time snapshot:
 *
 *  - `confirm write`, or no feature at all (the bare main tree), or a worktree
 *    with nothing in it → the ordinary WRITING lane. This is every dispatch that
 *    existed before the gate, unchanged.
 *  - a bare `confirm` into a worktree that has a live agent → the READ-ONLY
 *    lane. The safe default is the one that cannot corrupt the other agent's
 *    commit, and buying the risky one costs one typed word.
 */
function laneForConfirm(
  state: SessionState,
  armed: { feature?: string },
  write: boolean,
): DispatchLane {
  if (write || !armed.feature) return "writer";
  return activeAgentsFor(state, armed.feature).length > 0 ? "reader" : "writer";
}

/**
 * Arm a fresh-agent resolver dispatch for the blocked merge-queue head
 * (feature_resolve_head tool). Asks the FeatureManager to plan the resolve (is
 * the head resolvable under the retry bound, and what is the feature-scoped
 * order), then arms it through the SAME confirm-gated path as any dispatch,
 * flagged `resolve` so the fire path marks the head "resolving" and the
 * completion drain re-processes it. Launches nothing. Refuses cleanly when there
 * is no resolvable head.
 */
async function armResolve(
  state: SessionState,
): Promise<{ armed: true; summary: string } | { armed: false; reason: string }> {
  if (!state.features) return { armed: false, reason: "Feature levers are unavailable (not linked)." };
  const plan = state.features.planResolveHead();
  if (!plan.ok) return { armed: false, reason: plan.reason };
  const res = await armDispatch(state, plan.order, plan.feature);
  if (!res.armed) return res;
  // Tag the armed order as a resolver so fireDispatch drives the queue's
  // resolving/re-process transitions instead of a plain review-on-completion.
  if (state.armed) state.armed.resolve = true;
  const kindWord = plan.kind === "conflict" ? "a rebase conflict" : "failed CI checks";
  return {
    armed: true,
    summary:
      `Resolver for head '${plan.feature}' (blocked by ${kindWord}, attempt ${plan.attempt}/${plan.maxAttempts}) armed. ` +
      `It will run in that feature's own worktree on its branch and never touch dev. ` +
      res.summary,
  };
}

/** The human-readable dispatch target for the arm banner: a feature's worktree
 *  path when known, the branch/first-use note when the feature isn't provisioned
 *  yet, or the bare main tree. Deterministic and side-effect-free — it never
 *  provisions anything (that happens at fire time). */
function describeTarget(state: SessionState, feature: string | undefined, repoPath: string): string {
  if (!feature) return `bare main tree (${repoPath})`;
  const record = state.features?.list().find((f) => f.feature === feature || f.slug === feature);
  if (record && record.provisionStatus === "ready") {
    return `feature '${feature}' worktree: ${record.worktreePath}`;
  }
  const projected = path.join(defaultWorktreeBase(repoPath), safeFeatureSlug(feature));
  return `feature '${feature}' worktree (provisioned on first use): ${projected}`;
}

/** Slug for display in the arm banner, tolerant of a degenerate name (the real
 *  provision would reject it, but the banner must not throw before that). */
function safeFeatureSlug(feature: string): string {
  try {
    return featureSlug(feature);
  } catch {
    return feature;
  }
}

/**
 * The visuals in force for this session's IO. PlainIO (piped / non-TTY) is a
 * degraded context by definition — it has no addressable screen to animate on —
 * and stdout can't tell us that, so it's the one thing we pass in. Resolved per
 * use, not cached: the terminal width is live, so a window narrowed mid-session
 * degrades on the next dispatch rather than drawing into a screen that shrank.
 */
function visualsFor(io: SessionIO): EffectiveVisuals {
  return currentVisuals({ plainIO: !(io instanceof Tui) });
}

/**
 * Where a confirmed dispatch is headed, as the flourish and its static label
 * show it: a feature's own branch, or the bare main tree. Prefers the branch the
 * feature record already carries and falls back to projecting the name a
 * provision would mint (the default type, since a first-use dispatch never
 * supplied one), so a dispatch with nothing provisioned yet still names the
 * branch the crew will actually be on. Pure display — it provisions nothing,
 * exactly like describeTarget above it.
 */
function dispatchTarget(state: SessionState, feature?: string): DispatchTarget {
  if (!feature) return { kind: "main" };
  const record = state.features?.list().find((f) => f.feature === feature || f.slug === feature);
  return {
    kind: "feature",
    branch: record?.branch ?? `${DEFAULT_FEATURE_BRANCH_TYPE}/${safeFeatureSlug(feature)}`,
  };
}

/**
 * Fire a confirmed dispatch: hand the order to the registry, which launches it
 * into a visible Ghostty pane and watches for completion. Non-blocking — we
 * report where it landed and return immediately; the review lands later via the
 * completion callback. A dispatch that can't place a pane comes back failed (no
 * background path); we surface that cleanly. Never throws into the loop.
 *
 * This is also where the dispatch flourish plays. The destination line is
 * committed to the transcript first and unconditionally, so the record of where
 * an order went is identical at every visuals level; the waves are then scenery
 * over the launch itself — an idle wait the captain already had — and are
 * settled before the result is reported. Nothing about the dispatch depends on
 * them.
 */
async function fireDispatch(
  state: SessionState,
  order: string,
  agentName?: string,
  feature?: string,
  resolve?: boolean,
  lane: DispatchLane = "writer",
): Promise<void> {
  const { io, registry } = state;
  if (!registry) {
    io.appendBlock(c.yellow("  · dispatch unavailable (not linked)."));
    return;
  }

  const visuals = visualsFor(io);
  const target = dispatchTarget(state, feature);
  io.appendBlock(dispatchLabel(target, visuals));
  const flourish = visuals.animate
    ? io.playAnimation(
        dispatchFlourish({ target, glyphs: visuals.glyphs, color: visuals.color }),
      )
    : NO_ANIMATION;

  let job: Job;
  try {
    job = await registry.dispatch(order, agentName, {
      ...(feature ? { feature } : {}),
      lane,
    });
  } catch (e) {
    await flourish.settle();
    io.appendBlock(c.red(`  · dispatch error: ${(e as Error).message}`));
    noteDispatchLaunchFailed(state, { order, error: (e as Error).message });
    return;
  }
  await flourish.settle();

  try {
    if (job.status === "failed") {
      io.appendBlock(c.red(`  · dispatch failed to launch: ${job.error ?? "unknown error"}`));
      noteDispatchLaunchFailed(state, { order, error: job.error ?? "unknown error" });
      return;
    }
    // The armed order resolved the other way: the captain confirmed and this is
    // running. One line into the co's own history so it stops guessing whether a
    // typed confirm fired the order or the next message cancelled it — the
    // screen line below says the same thing, but only to the captain.
    noteDispatchFired(state, {
      order,
      jobId: job.id,
      ...(job.agentName ? { agent: job.agentName } : {}),
      ...(job.feature ? { feature: job.feature } : {}),
    });
    // A resolver dispatch that actually launched moves the merge-queue head to
    // "resolving" (and counts the attempt). Done only on a real launch so a
    // failed placement burns no attempt; the completion drain re-processes it.
    if (resolve && feature && state.features) {
      const started = state.features.beginResolveHead();
      if (!started.started) {
        io.appendBlock(c.yellow(`  · note: ${started.reason}`));
      }
    }
    const agentNote = job.agentName ? ` [${job.agentName}]` : "";
    const featureNote = job.feature ? ` in feature '${job.feature}'` : "";
    // A read-only run names its lane AND how it is held, every time. The one
    // thing this must never do is let an advisory-only run read as an enforced
    // one: the captain confirmed a lane, and which of the two they actually got
    // depends on the agent that ran, which an override may have changed.
    const laneNote =
      job.lane === "reader"
        ? ` (READ-ONLY audit lane — ${
            job.readOnlyEnforced
              ? "write tools denied at launch"
              : "ADVISORY only for this agent: the mandate is in the order, nothing blocks a write"
          })`
        : "";
    const where = `running in a Ghostty pane (${job.paneId ?? "?"})`;
    const followup = resolve
      ? "I'll re-process the head when it finishes."
      : job.lane === "reader"
        ? "I'll report what it found when it finishes."
        : "I'll review it when it finishes.";
    io.appendBlock(
      c.green(`  · dispatched ${job.id}${agentNote}${featureNote}${laneNote}: ${where}. ${followup}`),
    );
  } catch (e) {
    // The launch itself is handled above; this covers the bookkeeping after it
    // (the resolver-head transition), so it must not read as "nothing ran".
    io.appendBlock(c.red(`  · dispatch launched but post-launch bookkeeping failed: ${(e as Error).message}`));
  }
}

/**
 * The panel's `e` → Ctrl-S (D-20260727-15): write the captain's edited title and
 * description onto the head's pull request.
 *
 * Runs outside the agent loop, exactly like the [m] below, and tells the co
 * nothing: the PR's message is the captain's to write, and a model turn about it
 * would be pure noise. What it does leave is a dim transcript line, so the
 * session's own record shows the message changed and when.
 *
 * Never throws into the Tui — a failure comes back as a result the popup prints
 * over the captain's still-intact buffer.
 */
async function panelEditPrMessage(
  state: SessionState,
  message: { title: string; body: string; prNumber: number },
): Promise<PrMessageSaveResult> {
  const { io } = state;
  if (!state.features) {
    return { saved: false, summary: "the merge queue is unavailable in this session." };
  }
  try {
    const res = await state.features.editHeadPrMessage(message);
    io.appendBlock(c.dim(`  · rewrote the message on PR #${res.prNumber} (${res.feature})`));
    return { saved: true, summary: `PR #${res.prNumber} message updated: ${res.title}` };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { saved: false, summary: `the PR message was not written: ${error}`, error };
  }
}

/**
 * The panel's [m] (D-20260724-12): merge the ready queue head, from the keystroke,
 * with the co nowhere in the loop.
 *
 * This runs OUTSIDE the agent loop — it is called by the Tui while the session is
 * idling on question() — and that is the entire point: no tool call is made, no
 * turn is held open, and the co is free the whole time. What it owes the session
 * afterwards is only what the captain can't see for themselves:
 *
 *  - a merge that lands and leaves a ready/queued/empty queue: one dim transcript
 *    line and nothing else. The co is not told and not woken; the captain is
 *    looking right at the result.
 *  - a merge that lands and leaves the NEW head BLOCKED, or a merge the engine
 *    refused: a system turn is queued and the loop woken, so the co picks it up
 *    on the next idle prompt and can offer the (confirm-gated, attempt-bounded)
 *    resolver without the captain re-explaining anything.
 *
 * Never throws into the Tui: a failure comes back as a result the panel banners.
 */
async function panelMergeHead(state: SessionState): Promise<QueueMergeResult> {
  const { io } = state;
  if (!state.features) {
    return { merged: false, summary: "the merge queue is unavailable in this session." };
  }
  let res: Awaited<ReturnType<FeatureManager["mergeReadyHead"]>>;
  try {
    res = await state.features.mergeReadyHead();
  } catch (e) {
    const error = (e as Error).message;
    io.appendBlock(c.red(`  · merge failed: ${error}`));
    noteMergeOutcome(state, { merged: false, outcome: "failed", feature: "", summary: error, error });
    state.queueNotices.push(
      `SYSTEM: The captain pressed [m] on the merge-queue head in the panel and the merge THREW: ${error}. ` +
        `Nothing was merged. Tell them plainly what failed and what you'd do about it. Do not retry it yourself.`,
    );
    io.wake("queue-merge-error");
    return { merged: false, summary: `merge failed: ${error}`, error };
  }

  const head = res.head;
  if (res.merged) {
    io.appendBlock(
      c.green(
        `  · merged ${res.feature}${res.pr ? ` (PR #${res.pr.number})` : ""} → ${res.target} ` +
          `(${res.mergeSha?.slice(0, 7) ?? "?"})` +
          (head ? `; next head '${head.feature}' is ${head.status}` : "; the queue is now empty"),
      ),
    );
  } else {
    io.appendBlock(c.yellow(`  · [m] merged nothing: ${res.summary}`));
  }

  // What the co could never learn otherwise: [m] runs with it nowhere in the
  // loop, so a feature would land on dev while it went on reporting the feature
  // as in flight. One line, no turn, no word on screen — the captain's own
  // reading of this merge is the two lines above and is unchanged.
  noteMergeOutcome(state, res);

  // The co is engaged for exactly one reason: a head that needs a decision.
  const notice = queueMergeNotice(res);
  if (notice) {
    state.queueNotices.push(notice);
    io.wake("queue-merge");
  }

  return {
    merged: res.merged,
    summary: res.summary,
    ...(res.error ? { error: res.error } : {}),
  };
}

/**
 * What (if anything) the co owes the captain after a panel-native merge — the
 * ONE decision that determines whether the co is engaged at all, so it is pure
 * and unit-tested rather than buried in the keystroke path (same reasoning as
 * parseConfirm below).
 *
 * Null means silence, and silence is the happy path: a merge that landed and
 * left a ready/queued/empty queue needs no model turn at all — the captain is
 * looking straight at the result, and waking the co would be pure noise plus a
 * round trip. A notice is returned only when something needs a decision the
 * panel can't offer: the new head came back BLOCKED (the resolver is the co's
 * to arm, confirm-gated), or the merge itself was refused.
 */
export function queueMergeNotice(res: MergeHeadResult): string | null {
  const head = res.head;
  if (head && head.status === "blocked") {
    const kind =
      head.blockedKind === "conflict"
        ? "a rebase conflict"
        : head.blockedKind === "failed"
          ? "a red CI check on its pull request"
          : "a lifecycle problem (not a conflict or a red check)";
    const merged = res.merged
      ? `The captain merged the merge-queue head '${res.feature}' themselves, with [m] in the Ctrl-O panel. ` +
        `You were not involved and nothing is waiting on you. The queue advanced and the new head`
      : `The merge-queue head`;
    return (
      `SYSTEM: ${merged} '${head.feature}' is BLOCKED by ${kind}: ${head.blockedReason ?? "not mergeable"}. ` +
      `It holds the queue and has no [m] until it is green again.\n\n` +
      `Tell the captain in one line what is blocked and why. If it is a conflict or a red CI check, offer ` +
      `feature_resolve_head — it ARMS a fresh crew agent in that feature's own worktree and runs only when ` +
      `they type \`confirm\`; it is bounded to a few attempts. If it is neither, say what you'd do instead ` +
      `(fix by hand, or feature_abandon). Do not try to merge anything yourself, and never tell them to press ` +
      `[m] on a blocked head — there is no [m] there.`
    );
  }
  if (!res.merged && res.outcome === "failed") {
    return (
      `SYSTEM: The captain pressed [m] on the merge-queue head '${res.feature}' in the panel and the merge was ` +
      `REFUSED: ${res.error ?? "the merge could not proceed"}. Nothing was written to dev. The head was ` +
      `re-processed and is now ${head?.status ?? "unknown"}. Explain in one line what happened and what it ` +
      `takes to make it mergeable again. Do not attempt the merge yourself.`
    );
  }
  return null;
}

/**
 * Drain the out-of-band queue notices into turns, same shape as drainReviews:
 * one system turn each, in order, at the top of the input loop. These exist only
 * because the panel's [m] runs outside the agent loop (see panelMergeHead).
 */
async function drainQueueNotices(state: SessionState): Promise<void> {
  while (state.queueNotices.length > 0) {
    const note = state.queueNotices.shift()!;
    state.userTurns++;
    pushUserTurn(state, note);
    await drive(state);
  }
}

/**
 * Drain completed jobs into review turns. For each finished job the co gathers
 * the run's record itself (the captain pastes nothing) and reports a review
 * using the standard report-review protocol. Serial, so multiple completions
 * review in order — and each job resolves its OWN record, keyed by the job.
 *
 * The record source depends on how the job ran. A pane job is a fully native
 * interactive agent with nothing recording its tty, so its reviewable record is
 * the agent's own session transcript; the capture file only proves launch +
 * completion. The transcript is located two ways, in order of trust:
 *  1. The Stop hook's report: when the crew is a Claude Code run, the completion
 *     hook hands us the exact transcript path (and the last message) for THIS
 *     session (crewstophook.ts), so we render that directly — no guessing.
 *  2. By content: for an agent that reported no path, find the transcript whose
 *     first user message matches the job's order (crewtranscript.ts).
 * Failing both, the hook's captured last message is used, then the raw capture
 * (which for a background print-mode run holds the real output).
 */
async function drainReviews(state: SessionState): Promise<void> {
  while (state.reviewQueue.length > 0) {
    const job = state.reviewQueue.shift()!;

    // A resolver agent finishing on the current resolving head: re-process the
    // head now (rebase + push + a fresh read of its PR's checks) so it becomes
    // ready if green or blocked again if not, and fold the outcome into the
    // review turn so the co reports what the queue now shows. One agent per
    // feature, so the resolving head's only in-flight agent is its resolver.
    let resolveNote = "";
    if (job.feature && state.features?.isResolvingHead(job.feature)) {
      try {
        const outcome = await state.features.onResolveDone(job.feature);
        const h = outcome.head;
        const headLine = h
          ? `head '${h.feature}' is now ${h.status}${h.blockedReason ? ` (${h.blockedReason})` : ""}`
          : "the queue is now empty";
        resolveNote =
          `\n\nThis dispatch was a merge-queue RESOLVER for '${job.feature}'. After it finished the ` +
          `head was re-processed: ${headLine}. Tell the captain whether the head is ready to merge ` +
          `(the captain's [m] in the panel), still blocked (they can resolve again with feature_resolve_head until ` +
          `the attempt limit, or fix by hand / abandon), and factor that into your verdict.`;
        state.io.appendBlock(c.dim(`  · resolver finished for '${job.feature}': ${headLine}`));
      } catch (e) {
        resolveNote = `\n\n(Re-processing the resolved head '${job.feature}' failed: ${(e as Error).message})`;
      }
    }

    // Resolve the run's record (reviewrecord.ts): the four sources in order of
    // trust, and — the point of that module — nothing cut without saying so.
    const { record, source } = await resolveReviewRecord(job, state.dispatch);

    state.userTurns++;
    pushUserTurn(state, completionTurn(job, record, source, resolveNote));

    // Both lanes drive the same way; which turn they were handed is the only
    // difference, and completionTurn has already decided that (D-20260729-6).
    await drive(state);
  }
}

/**
 * The system turn a finished job produces — the ROUTING decision, in one pure
 * function so it can be tested without a model call.
 *
 * Two destinations, and which one a run takes is its LANE and nothing else:
 *
 *  - a WRITER built something, so it is reviewed and given a verdict;
 *  - a READER was forbidden to change anything, so there is nothing to accept or
 *    rework — it comes back as context the co answers the captain with
 *    (D-20260729-6).
 */
export function completionTurn(job: Job, record: string, source: string, resolveNote = ""): string {
  return job.lane === "reader"
    ? auditTurn(job, record, source)
    : reviewTurn(job, record, source, resolveNote);
}

/** The review turn: a crew run that produced work, handed over to be reviewed
 *  per the report-review protocol. */
function reviewTurn(job: Job, record: string, source: string, resolveNote: string): string {
  return (
    "SYSTEM: A crew dispatch you launched has finished; review it now for the captain. This is" +
    " not something the captain typed — you triggered it. The agent ran in a separate coding" +
    " session against the registered repo; below is the record of that run, taken from " +
    source +
    ". Review it per the report-review protocol (what went right, what went wrong, escalations," +
    " then a verdict: accept / fix-commit / rework). Be concise. Do NOT ask the captain to paste" +
    " anything; you already have the record. Separate verified from claimed. If the record is" +
    " only a completion marker with no content, say plainly that the run left no reviewable" +
    " record and what the exit code implies.\n\n" +
    "SAY NOTHING UNLESS IT IS VITAL: reach the verdict, then speak only if it is `rework`, a" +
    " genuine escalation, or a fork only the captain can resolve — and then state that decision" +
    " alone, in a line or two. Otherwise say nothing at all and let the run pass: no summary, no" +
    " headline, no line reporting that you reviewed it. He asks when he wants the detail.\n\n" +
    `Job: ${job.id} (${job.label})\nStatus: ${job.status}` +
    (job.exitCode !== undefined ? ` (exit ${job.exitCode})` : "") +
    `\n\n--- record of the run ---\n${record}` +
    resolveNote
  );
}

/**
 * The turn a finished READ-ONLY run produces. Deliberately not the review turn:
 * an audit is a question the captain asked, answered by an agent that was
 * forbidden to change anything, so there is no delivery to accept and no verdict
 * to reach (D-20260729-6). Reviewing one would put an accept/rework on a run that
 * built nothing.
 */
function auditTurn(job: Job, record: string, source: string): string {
  return (
    "SYSTEM: A READ-ONLY AUDIT you dispatched has finished. This is not something the captain typed" +
    " — you triggered it — and it is NOT a crew implementation run. The agent was launched into a" +
    " worktree another agent is still working in, under a read-only mandate: no edits, no commits," +
    " no builds, nothing written to disk at all" +
    (job.readOnlyEnforced
      ? " (its write-capable tools were also denied at launch)" +
        ". So it produced no diff and changed nothing."
      : " (advisory only for this agent — nothing mechanically blocked it, so if the record shows it" +
        " wrote anything, say so plainly: that is a real problem worth raising)." +
        " It was supposed to produce no diff and change nothing.") +
    "\n\nDO NOT REVIEW THIS RUN. Do not give it a verdict (accept / fix-commit / rework), and do" +
    " not treat it as work delivered. Its findings are" +
    " CONTEXT FOR YOU TO ANSWER WITH: read the report below, and reply to the captain with what it" +
    " found and what you make of it, in your own voice and at your usual length. Say plainly where" +
    " the audit is uncertain or where it only looked at part of the picture, and separate what it" +
    " verified from what it merely asserts. If it turned up something that changes a decision, the" +
    " architecture, or what we do next, that is the part to lead with.\n\n" +
    `Job: ${job.id} (${job.label})\nStatus: ${job.status}` +
    (job.exitCode !== undefined ? ` (exit ${job.exitCode})` : "") +
    (job.feature ? `\nWorktree: feature '${job.feature}'` : "") +
    `\nRecord taken from ${source}.` +
    `\n\n--- the audit's report ---\n${record}`
  );
}

/**
 * Parse a typed line against the confirm interlock. Pure so the interlock's
 * three decisions — is this a confirm, which LANE does it grant, and does it
 * name a crew agent — can be unit-tested without arming a real dispatch (which
 * needs a model call).
 *
 *   "confirm"           → { isConfirm: true }
 *   "confirm write"     → { isConfirm: true, write: true }
 *   "confirm ccw"       → { isConfirm: true, agent: "ccw" }
 *   "confirm write ccw" → { isConfirm: true, write: true, agent: "ccw" }
 *   "CONFIRM"           → { isConfirm: true }              (case-insensitive verb)
 *   anything else       → { isConfirm: false }             (cancels the dispatch)
 *
 * `write` is the WORD that buys a second writing lane in an occupied worktree
 * (D-20260729-5). It is folded into the confirm verb rather than asked as a
 * second question after it, because a free-text prompt after `confirm` is
 * another cancel-trap: one wrong keystroke there discards an order the captain
 * has already approved.
 *
 * On an UNOCCUPIED worktree `write` changes nothing — a bare `confirm` already
 * grants full write access there — so it is accepted as a harmless synonym
 * rather than rejected as noise.
 *
 * Only the verb, an optional `write`, and the next token matter; trailing words
 * are ignored so a fat-fingered "confirm cc please" still selects cc rather than
 * cancelling. A crew agent literally NAMED "write" cannot be selected by
 * `confirm write` — the lane word wins — which is a fair trade for a lane verb
 * that reads like English.
 */
export function parseConfirm(raw: string): { isConfirm: boolean; write?: boolean; agent?: string } {
  // The verb test itself is shared with the TUI, which uses it to decide whether
  // a queued line may answer an armed gate. See src/confirmverb.ts for why that
  // is one function and not two.
  if (!isConfirmVerb(raw)) return { isConfirm: false };
  const parts = raw.trim().split(/\s+/);
  let next = 1;
  const write = parts[next]?.toLowerCase() === "write";
  if (write) next += 1;
  const agent = parts[next];
  return {
    isConfirm: true,
    ...(write ? { write: true } : {}),
    ...(agent ? { agent } : {}),
  };
}

type CommandResult = "ok" | "exit";

async function handleCommand(state: SessionState, raw: string): Promise<CommandResult> {
  const { io } = state;
  const [cmd, ...rest] = raw.slice(1).split(" ");
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "help":
      printHelp(io);
      return "ok";

    case "state": {
      const live = await readLiveMemory(state.paths);
      io.appendBlock("");
      io.appendBlock(c.bold(".memory/activeContext.md"));
      io.appendBlock(live["activeContext.md"].trim() || c.dim("(empty)"));
      return "ok";
    }

    case "research": {
      if (!arg) {
        io.appendBlock(c.yellow("usage: /research <question>"));
        return "ok";
      }
      await runUserTurn(
        state,
        `Research this and save a research note (question, sources, findings, tradeoffs, pushback, recommendation, confidence): ${arg}`,
      );
      return "ok";
    }

    case "decide": {
      if (!arg) {
        io.appendBlock(c.yellow("usage: /decide <decision>"));
        return "ok";
      }
      // A shortcut to record a decision explicitly. There is no confirmation
      // step — recording is silent and self-managed.
      pushUserTurn(
        state,
        `Record this as a decision now with memory_write (kind: decision). Use the rationale already in our conversation; if some context is thin, record it anyway and note the open questions inline in the entry. Then rewrite activeContext (memory_rewrite) to reference the new decision id. Keep your spoken reply natural and brief, and do not narrate the memory write. Decision: ${arg}`,
      );
      await drive(state);
      return "ok";
    }

    case "prompt":
    case "orders": {
      if (!arg) {
        io.appendBlock(c.yellow(`usage: /${cmd} <goal>`));
        return "ok";
      }
      await runUserTurn(
        state,
        `Write the orders to the crew (an implementation-ready coding-agent prompt) for this goal now. Write them straight into your reply as plain text the captain can copy to the coding agent — do NOT save them to a file or tool. Do NOT block on questions: where repo details are unknown, put them in an explicit "Assumptions" section and instruct the coding agent to inspect the repo and adjust. State the goal, context, relevant decisions, constraints, what not to change, acceptance criteria, and verification. Goal: ${arg}`,
      );
      return "ok";
    }

    case "sync": {
      await syncActiveContext(state, /*force*/ true);
      return "ok";
    }

    case "archive": {
      const target = arg as LogName;
      if (!LOG_NAMES.includes(target)) {
        io.appendBlock(c.yellow(`usage: /archive <${LOG_NAMES.join("|")}>`));
        return "ok";
      }
      const dest = await archiveLog(state.paths, target);
      io.appendBlock(dest ? c.dim(`archived ${target} → ${dest}`) : c.dim(`${target} has nothing to archive`));
      return "ok";
    }

    case "cost": {
      // The one place spend is ever visible. Nothing else in the session
      // mentions it — that's the whole design (see cost.ts).
      for (const l of formatCostReport({
        ledger: state.costs,
        modelId: state.model.modelId,
        cacheTtl: CACHE_TTL,
      })) {
        io.appendBlock(l);
      }
      return "ok";
    }

    case "effort": {
      // Session-scoped override of CO_EFFORT. Takes effect on the next turn;
      // nothing is written to disk, so a restart returns to the configured
      // default (set CO_EFFORT to make a change stick).
      // The ladder is per-model: xhigh arrived with Opus 4.7, so on the 4.6
      // generation it is a 400 on every subsequent turn rather than a level
      // the model merely ignores. Offer and accept only what this model takes.
      const levels = effortLevelsFor(state.model.modelId);
      const current = state.model.effort ?? "(unset)";
      if (!arg) {
        io.appendBlock(c.dim(`effort: ${current}  (levels: ${levels.join(", ")})`));
        return "ok";
      }
      const next = parseEffort(arg);
      if (!next) {
        io.appendBlock(c.yellow(`usage: /effort [${levels.join("|")}]`));
        return "ok";
      }
      if (!levels.includes(next)) {
        io.appendBlock(
          c.yellow(`${next} is not accepted by ${state.model.modelId} — levels: ${levels.join(", ")}`),
        );
        return "ok";
      }
      state.model.setEffort(next);
      io.appendBlock(c.dim(`effort: ${current} → ${next} (this session)`));
      return "ok";
    }

    case "exit":
    case "quit":
      return "exit";

    default:
      io.appendBlock(c.yellow(`unknown command /${cmd} (try /help)`));
      return "ok";
  }
}

/**
 * Ask the model to produce a fresh activeContext.md. Used by /sync (user-invoked,
 * so it may show feedback) and by the end-of-session guard (auto, quiet: memory
 * maintenance is never narrated). Returns true if it rewrote the file.
 */
async function syncActiveContext(state: SessionState, force: boolean, quiet = false): Promise<boolean> {
  const { io } = state;
  const stale = await detectStaleActiveContext(state.paths);
  if (!force && !stale.stale) {
    if (!quiet) io.appendBlock(c.dim("activeContext.md is current."));
    return false;
  }

  if (!quiet) io.appendBlock(c.dim("\nsyncing activeContext.md…"));

  const before = state.effects.liveRewritten.has("activeContext.md");
  pushUserTurn(
    state,
    "Session sync: update .memory/activeContext.md so the next cold start orients" +
      " correctly. Use memory_rewrite (file: activeContext). Reflect the current focus, decisions" +
      " in flight, recent confirmed decisions (compressed, with ids), open questions," +
      " known risks, and next likely actions. Crucially, update the \"Recent" +
      " conversation\" section to summarise what we actually discussed this session -" +
      " including any casual direction that has not yet become a formal decision (for" +
      " example a change of what the project is about) - so the next session picks up" +
      " the thread. Keep the whole file compact and cap that section to a few bullets," +
      " letting older detail age out. Reply with a brief, natural one-line" +
      " acknowledgement, and do not narrate the memory write or say things like" +
      " saved, logged, or wrote to memory.",
  );
  // On the exit distill (quiet), the model's acknowledgement is suppressed on
  // screen so `/exit` doesn't look like the co replied to a chat message; the
  // memory write still happens and the reply is still kept in the transcript.
  await drive(state, { quiet });

  const after = state.effects.liveRewritten.has("activeContext.md");
  const rewrote = after && !before;

  if (!after && !quiet) {
    io.appendBlock(c.yellow("note: activeContext.md was not rewritten by the model."));
  }
  return rewrote;
}

/**
 * End-of-session distill: whenever the captain actually said something this
 * session, refresh activeContext.md before closing. We AUTO-save — no prompt.
 *
 * This used to gate on "did a log change / is activeContext stale", which meant
 * a purely conversational session (e.g. "let's make this project about cats",
 * no tool call) slipped through and the redefinition was lost on restart. The
 * transcript survived it, but the transcript isn't curated memory. So we now
 * distil unconditionally on any real conversation: the distilled summary is the
 * rich layer, and the verbatim transcript tail is the guaranteed floor beneath
 * it. The only skip is a session where nothing was said (userTurns === 0), so a
 * bare open-and-quit doesn't burn a model call. (/sync does the same on demand.)
 */
async function endOfSessionGuard(state: SessionState): Promise<void> {
  const { io } = state;

  if (state.userTurns === 0) {
    io.appendBlock(c.dim("\nbye."));
    return;
  }

  // The save below is a model call: several seconds of a terminal that has
  // already been told to quit. The line says why we're still here (at every
  // visuals level); the ship, where it can sail, fills that wait and nothing
  // else — it is started AFTER the label, stopped in a finally, and never
  // waited on.
  const visuals = visualsFor(io);
  io.appendBlock("");
  io.appendBlock(savingLabel(visuals));
  const voyage = visuals.animate
    ? io.playAnimation(
        exitVoyage({
          cols: process.stdout.columns || 80,
          glyphs: visuals.glyphs,
          color: visuals.color,
        }),
      )
    : NO_ANIMATION;

  try {
    // Distil the session into live state, quietly. This is the co-manager's own
    // bookkeeping; it is never narrated to the captain.
    await syncActiveContext(state, /*force*/ true, /*quiet*/ true);

    // Keep the chatty logs from growing without bound. This is off the cold-start
    // read path, so it never affects context size — it just keeps on-demand
    // search fast. decisions.md is deliberately never auto-archived (see
    // autoArchiveLargeLogs). Best-effort; failures never block exit. Silent, like
    // the rest of memory maintenance.
    await autoArchiveLargeLogs(state.paths);
  } finally {
    // stop(), never settle(): the save is the point and the voyage is scenery
    // over it. A ship still mid-crossing when the save lands is cut short — exit
    // never waits on an animation, and never on the error path either.
    voyage.stop();
  }

  io.appendBlock(c.dim("bye."));
}

function bannerText(name: string, cfg: Config, tui: boolean, linked: boolean): string {
  const thinking = cfg.model.thinking === "adaptive";

  // Interactive terminal: try the fancy boxed pirate galleon. It carries the
  // name/model/region itself, so we don't repeat those below it. If the frame
  // won't fit the current width, pirateBanner() returns null and we fall back
  // to the plain informational lines used on piped/non-TTY sessions.
  const fancy = tui
    ? pirateBanner({
        name,
        modelId: cfg.model.modelId,
        region: cfg.model.region,
        thinking,
        cols: Math.max(20, process.stdout.columns || 80),
      })
    : null;

  const lines: string[] = [""];
  if (fancy) {
    lines.push(fancy, "");
  } else {
    lines.push(
      c.bold(c.magenta(`co-manager: ${name}`)),
      c.dim(
        `model ${cfg.model.modelId} · region ${cfg.model.region} · ${
          thinking ? "thinking on" : "thinking off"
        }`,
      ),
    );
  }
  lines.push(
    c.dim("architecture brain. type /help for commands, /exit to leave."),
  );
  if (tui) {
    lines.push(
      c.dim("scroll: wheel or PgUp/PgDn · ↑/↓ recalls your input · hold Option/Shift to select text"),
      c.dim(linked ? "Ctrl-O opens the panel (merge queue + docs)" : "Ctrl-O opens the panel (docs)"),
    );
  }
  return lines.join("\n");
}

function printHelp(io: SessionIO): void {
  io.appendBlock("");
  io.appendBlock(c.bold("commands (natural language works without any of these):"));
  io.appendBlock(c.dim("  tip: type / and press Tab or → to accept the grey suggestion"));
  for (const cmd of SLASH_COMMANDS) {
    if (cmd.hidden) continue;
    const key = "/" + cmd.name + (cmd.arg ? " " + cmd.arg : "");
    io.appendBlock(`  ${c.cyan(key.padEnd(18))} ${c.dim(cmd.desc)}`);
  }
}

/**
 * Line-oriented IO for piped / non-TTY sessions (scripts, tests). No alt
 * buffer, no raw mode — just readline plus the existing write/line helpers, so
 * behavior matches the pre-TUI session when there's no interactive terminal.
 */
class PlainIO implements SessionIO {
  private rl: readline.Interface | null = null;
  private closed = false;
  private midLine = false;
  /** Lines readline has emitted that no question() has claimed yet. */
  private queued: string[] = [];
  /** The single in-flight question() waiting on the next line, if any. */
  private waiter: ((answer: string | null) => void) | null = null;

  constructor(private promptLabel: string, private header?: string) {}

  start(): void {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    // Lines come from the 'line' event, not from rl.question's one-shot
    // callback. Piped stdin arrives as a single chunk, so readline emits every
    // line synchronously; a one-shot callback claims the first and the rest are
    // dropped on the floor with no listener, which meant a scripted session ran
    // only its first command and then saw EOF. Queue them and hand them out on
    // demand instead.
    this.rl.on("line", (l) => this.deliver(l));

    // EOF. Release anything still waiting rather than leaving it unsettled:
    // rl.question on a closed interface neither throws nor calls back, so the
    // old code could hang forever if question() ran before this fired.
    this.rl.on("close", () => {
      this.closed = true;
      this.deliver(null);
    });

    if (this.header) line(this.header);
  }

  /** Hand a line to a waiting question(), or park it for the next one. */
  private deliver(answer: string | null): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null; // cleared before calling: never resolve twice
      waiter(answer);
      return;
    }
    if (answer !== null) this.queued.push(answer);
  }

  stop(): void {
    this.flushStream();
    this.rl?.close();
    this.rl = null;
  }

  appendBlock(text: string): void {
    if (this.midLine) { write("\n"); this.midLine = false; }
    line(text);
  }

  // Piped/non-TTY output stays plain markdown — a script or pipe consuming this
  // wants the raw text, not ANSI styling — so the markdown flag is ignored here.
  appendStream(chunk: string, _opts?: { markdown?: boolean }): void {
    if (chunk === "") return;
    write(chunk);
    this.midLine = !chunk.endsWith("\n");
  }

  flushStream(): void {
    if (this.midLine) { write("\n"); this.midLine = false; }
  }

  // No-op off the TTY: a spinner would be noise in a pipe and would break the
  // deterministic output scripts and tests depend on.
  setBusy(_label: string | null): void {}

  /**
   * The session loop is strictly sequential — one question() outstanding at a
   * time — so a single waiter slot is enough.
   */
  question(): Promise<string | null> {
    if (!this.rl) return Promise.resolve(null);

    const next = this.queued.shift();
    // Nothing buffered and stdin is done: EOF, and no trailing prompt label.
    if (next === undefined && this.closed) return Promise.resolve(null);

    write("\n" + this.promptLabel);
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  /**
   * Wake a waiting question() with the sentinel. On the plain path a completed
   * dispatch review is delivered on the next scripted turn regardless, so this is
   * only meaningful if something is actually blocked on input; deliver it if so.
   */
  wake(_reason: string): boolean {
    const waiter = this.waiter;
    if (!waiter) return false;
    this.waiter = null;
    waiter(WAKE_SENTINEL);
    return true;
  }

  // No banner off the TTY: the armed order + command are printed inline by the
  // session loop instead, so a pipe/script sees them as ordinary output.
  setConfirmBanner(_lines: string[] | null): void {}

  // Nothing animates on a pipe: there is no addressable screen, and a stream of
  // redrawn frames would corrupt the deterministic output scripts and tests
  // depend on. The caller's static line has already been printed either way —
  // visualsFor() resolves PlainIO to `off`, so it printed the ASCII form.
  playAnimation(_spec: AnimationSpec): AnimationHandle {
    return NO_ANIMATION;
  }
}
