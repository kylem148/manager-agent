import * as readline from "node:readline";
import fsp from "node:fs/promises";
import path from "node:path";
import { EFFORT_LEVELS, parseEffort, type Config, type Effort } from "../config.js";
import type { InstancePaths } from "../paths.js";
import { ModelProvider, type MessageParam } from "../model.js";
import { buildSystemPrompt } from "./prompt.js";
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
import { Tui, WAKE_SENTINEL, type SessionIO, type DocSource } from "../tui/tui.js";
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
import { DispatchRegistry, readFileTail, type Job } from "./registry.js";
import { scrubCapture } from "./transport.js";
import { findCrewTranscript, renderTranscriptForReview } from "./crewtranscript.js";

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
  /** The order armed and awaiting a typed `confirm`, or null. Set by the arm
   *  callback; consumed by the confirm interlock in the input loop. */
  armed: { order: string } | null;
  /** Completed jobs waiting for a review turn, drained on the next idle prompt. */
  reviewQueue: Job[];
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

  const system = await buildSystemPrompt(paths, cfg.research, {
    excludeTranscript: transcript.file,
    dispatch: dispatch
      ? {
          repoPath: dispatch.repoPath,
          transport: dispatch.anchor
            ? "visible pane (Ghostty) with background fallback"
            : "background (no crew pane designated yet)",
          agents: dispatch.agents.map((a) => a.name),
          defaultAgent: dispatch.defaultAgent,
        }
      : null,
  });

  // The scroll/selection hint only applies to the interactive TUI; it would be
  // misleading in piped output where there's no scrolling, so it's TUI-only.
  const tui = Tui.capable();
  const header = bannerText(paths.name, cfg, tui);
  const io: SessionIO = tui
    ? new Tui({ promptLabel: PROMPT_LABEL, header, docs: docSource(paths) })
    : new PlainIO(PROMPT_LABEL, header);

  const state: SessionState = {
    cfg,
    paths,
    model,
    system,
    messages: [],
    effects,
    io,
    transcript,
    userTurns: 0,
    dispatch,
    registry: null,
    armed: null,
    reviewQueue: [],
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
    });
  }

  io.start();

  // On a real terminal, open with a short spoken greeting: the co reads its
  // live state (already in the system prompt) and reports where we left off,
  // in character. Skipped for piped/non-TTY sessions (scripts, tests) so their
  // output stays deterministic and we don't burn a model call before the first
  // scripted command.
  if (tui) {
    await runOpeningGreeting(state);
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
          await fireDispatch(state, armed.order, confirm.agent);
          continue;
        }
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

async function runUserTurn(state: SessionState, userText: string): Promise<void> {
  state.messages.push({ role: "user", content: userText });
  await drive(state);
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
  state.messages.push({
    role: "user",
    content:
      "SESSION START (spoken by you, the co-manager, unprompted). You have just" +
      " come aboard and read the system prompt above, which holds your live state" +
      " AND a verbatim tail of our last conversation. Greet the captain and report" +
      " where we left off. Open with an acknowledgement in character — e.g." +
      ' "Aye, ready to work, captain." — then, in 2-4 sentences, summarise the' +
      " current focus, anything in flight, and the most useful next step. Draw on" +
      " your live state first; where it is thin or stale, lean on the recent" +
      " conversation tail to say what we were actually just discussing — do not" +
      " claim the charts are blank when that tail shows real work. ONLY if there is" +
      " genuinely nothing to go on — empty live state AND no recent conversation —" +
      " say so plainly and ask what we're charting, rather than inventing history." +
      " Do not call any tools; do not list open questions exhaustively. Keep it tight.",
  });
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
): Promise<void> {
  const { effort, quiet } = opts;
  const { io } = state;
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
    // the only path that fires a dispatch.
    ...(state.dispatch ? { onArmDispatch: (order: string) => armDispatch(state, order) } : {}),
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
  state.armed = { order };

  const cmd = displayCommand(resolveAgentCommand(config), config.repoPath);
  const transport =
    state.registry?.activeTransport === "ghostty" ? "visible Ghostty pane" : "background run";
  // Offer the named alternatives only when there's a real choice to make.
  const others = config.agents.map((a) => a.name).filter((n) => n !== config.defaultAgent);
  const overrideHint =
    others.length > 0 ? `  or \`confirm <${others.join("|")}>\` to pick another agent` : "";
  state.io.setConfirmBanner([
    c.yellow(c.bold("  ⚑ dispatch armed — type `confirm` to launch, anything else cancels")),
    c.dim(`  transport: ${transport}   agent: ${config.defaultAgent}   command: ${cmd}`),
    ...(overrideHint ? [c.dim(overrideHint)] : []),
    c.dim(`  order: ${firstLineOf(order)}`),
  ]);
  return {
    armed: true,
    summary:
      `It will run via ${transport} as: ${cmd} (agent ${config.defaultAgent}).` +
      (others.length > 0 ? ` The captain can type \`confirm <${others.join("|")}>\` to pick another.` : ""),
  };
}

/**
 * Fire a confirmed dispatch: hand the order to the registry, which launches it
 * on the chosen transport and watches for completion. Non-blocking — we report
 * which transport was used and return immediately; the review lands later via the
 * completion callback. Never throws into the loop.
 */
async function fireDispatch(state: SessionState, order: string, agentName?: string): Promise<void> {
  const { io, registry } = state;
  if (!registry) {
    io.appendBlock(c.yellow("  · dispatch unavailable (not linked)."));
    return;
  }
  try {
    const job = await registry.dispatch(order, agentName);
    if (job.status === "failed") {
      io.appendBlock(c.red(`  · dispatch failed to launch: ${job.error ?? "unknown error"}`));
      return;
    }
    const agentNote = job.agentName ? ` [${job.agentName}]` : "";
    const where =
      job.transport === "ghostty"
        ? job.status === "queued"
          ? "queued for a free crew pane"
          : `running in a Ghostty pane (${job.paneId ?? "?"})`
        : "running in the background";
    io.appendBlock(c.green(`  · dispatched ${job.id}${agentNote}: ${where}. I'll review it when it finishes.`));
  } catch (e) {
    io.appendBlock(c.red(`  · dispatch error: ${(e as Error).message}`));
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
 * the agent's own session transcript (located by matching the job's order text
 * — see crewtranscript.ts); the capture file only proves launch + completion.
 * A background job's capture holds real output (print mode) and is used
 * directly, as is any capture when no transcript can be found.
 */
async function drainReviews(state: SessionState): Promise<void> {
  while (state.reviewQueue.length > 0) {
    const job = state.reviewQueue.shift()!;

    let record = "";
    let source = "";
    const config = state.dispatch;
    if (config) {
      try {
        const transcript = await findCrewTranscript({
          agentCommand: resolveAgentCommand(config, job.agentName),
          repoPath: config.repoPath,
          order: job.order,
          startedAtMs: job.startedAt ?? 0,
        });
        if (transcript) {
          const raw = await readFileTail(transcript, 4 * 1024 * 1024);
          record = renderTranscriptForReview(raw, 16000);
          source = "the crew agent's own session transcript";
        }
      } catch {
        /* fall through to the capture */
      }
    }
    if (!record) {
      try {
        record = await readCapture(state, job.captureFile);
        source = "the raw run capture";
      } catch {
        record = "(no transcript was found and the capture file could not be read)";
        source = "nothing — no record was recoverable";
      }
    }

    state.userTurns++;
    state.messages.push({
      role: "user",
      content:
        "SYSTEM: A crew dispatch you launched has finished; review it now for the captain. This is" +
        " not something the captain typed — you triggered it. The agent ran in a separate coding" +
        " session against the registered repo; below is the record of that run, taken from " +
        source +
        ". Review it per the report-review protocol (what went right, what went wrong, escalations," +
        " then a verdict: accept / fix-commit / rework). Be concise. Do NOT ask the captain to paste" +
        " anything; you already have the record. Separate verified from claimed. If the record is" +
        " only a completion marker with no content, say plainly that the run left no reviewable" +
        " record and what the exit code implies.\n\n" +
        `Job: ${job.id} (${job.label})\nStatus: ${job.status}` +
        (job.exitCode !== undefined ? ` (exit ${job.exitCode})` : "") +
        `\n\n--- record of the run ---\n${record}`,
    });
    await drive(state);
  }
}

/** Read a capture file for review, capping its size so a runaway log can't blow
 *  the context window. Reads only the file tail, scrubs terminal escape noise
 *  into readable text, and keeps the last MAX characters — where the run's
 *  conclusion and the sentinel live. (Pane captures hold just probe + sentinel;
 *  this mainly serves background-run captures and degrade notes.) */
async function readCapture(_state: SessionState, file: string): Promise<string> {
  const raw = await readFileTail(file, 256 * 1024);
  const clean = scrubCapture(raw);
  const MAX = 16000;
  return clean.length > MAX ? "…[capture truncated to the last part]\n" + clean.slice(-MAX) : clean;
}

function firstLineOf(order: string): string {
  const l = order.split("\n").find((x) => x.trim() !== "")?.trim() ?? "";
  return l.length > 80 ? l.slice(0, 77) + "…" : l;
}

/**
 * Parse a typed line against the confirm interlock. Pure so the interlock's
 * two decisions — is this a confirm, and does it name a crew agent — can be
 * unit-tested without arming a real dispatch (which needs a model call).
 *
 *   "confirm"        → { isConfirm: true }                 (use the default agent)
 *   "confirm ccw"    → { isConfirm: true, agent: "ccw" }   (override for this run)
 *   "CONFIRM"        → { isConfirm: true }                 (case-insensitive verb)
 *   anything else    → { isConfirm: false }                (cancels the dispatch)
 *
 * Only the verb and the first token after it matter; trailing words are ignored
 * so a fat-fingered "confirm cc please" still selects cc rather than cancelling.
 */
export function parseConfirm(raw: string): { isConfirm: boolean; agent?: string } {
  const [verb, agentToken] = raw.trim().split(/\s+/, 2);
  if (verb?.toLowerCase() !== "confirm") return { isConfirm: false };
  return agentToken ? { isConfirm: true, agent: agentToken } : { isConfirm: true };
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
      state.messages.push({
        role: "user",
        content: `Record this as a decision now with append_decision. Use the rationale already in our conversation; if some context is thin, record it anyway and note the open questions inline in the entry. Then refresh activeContext.md to reference the new decision id. Keep your spoken reply natural and brief, and do not narrate the memory write. Decision: ${arg}`,
      });
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

    case "effort": {
      // Session-scoped override of CO_EFFORT. Takes effect on the next turn;
      // nothing is written to disk, so a restart returns to the configured
      // default (set CO_EFFORT to make a change stick).
      const current = state.model.effort ?? "(unset)";
      if (!arg) {
        io.appendBlock(c.dim(`effort: ${current}  (levels: ${EFFORT_LEVELS.join(", ")})`));
        return "ok";
      }
      const next = parseEffort(arg);
      if (!next) {
        io.appendBlock(c.yellow(`usage: /effort [${EFFORT_LEVELS.join("|")}]`));
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
  state.messages.push({
    role: "user",
    content:
      "Session sync: update .memory/activeContext.md so the next cold start orients" +
      " correctly. Use rewrite_active_context. Reflect the current focus, decisions" +
      " in flight, recent confirmed decisions (compressed, with ids), open questions," +
      " known risks, and next likely actions. Crucially, update the \"Recent" +
      " conversation\" section to summarise what we actually discussed this session -" +
      " including any casual direction that has not yet become a formal decision (for" +
      " example a change of what the project is about) - so the next session picks up" +
      " the thread. Keep the whole file compact and cap that section to a few bullets," +
      " letting older detail age out. Reply with a brief, natural one-line" +
      " acknowledgement, and do not narrate the memory write or say things like" +
      " saved, logged, or wrote to memory.",
  });
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

  // Distil the session into live state, quietly. This is the co-manager's own
  // bookkeeping; it is never narrated to the captain.
  await syncActiveContext(state, /*force*/ true, /*quiet*/ true);

  // Keep the chatty logs from growing without bound. This is off the cold-start
  // read path, so it never affects context size — it just keeps on-demand
  // search fast. decisions.md is deliberately never auto-archived (see
  // autoArchiveLargeLogs). Best-effort; failures never block exit. Silent, like
  // the rest of memory maintenance.
  await autoArchiveLargeLogs(state.paths);

  io.appendBlock(c.dim("bye."));
}

function bannerText(name: string, cfg: Config, tui: boolean): string {
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
      c.dim("Ctrl-O opens the doc viewer"),
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
}
