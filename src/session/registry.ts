import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { InstancePaths } from "../paths.js";
import { CrewPaneLayout } from "./crewpanes.js";
import { readDispatchConfig, resolveAgentCommand, type DispatchConfig } from "./dispatchconfig.js";
import {
  anchorExists,
  paneExists,
  dispatchCorrelation,
  isGhosttyAvailable,
  jobScriptFile,
  launchGhostty,
  parseSentinel,
  PaneUnavailableError,
  type TransportKind,
} from "./transport.js";
import { installCrewStopHook, type InstallResult } from "./crewhook.js";
import { stopCaptureFile, type StopCapture } from "./crewstophook.js";
import {
  defaultWorktreeBase,
  featureBranch,
  featureSlug,
  provisionWorktree,
  type FeatureRecord,
  type WorktreeOptions,
} from "./worktrees.js";

/**
 * The dispatch job registry and capture watcher.
 *
 * One registry per session. It owns every in-flight crew job: it launches each
 * in a VISIBLE Ghostty pane, polls its capture file for completion, enforces the
 * wall-clock timeout, and drains the queue when a pane frees. It is fully
 * non-blocking: nothing here is ever awaited on the conversation path — the
 * session arms and fires a dispatch and moves on, and the registry notifies via a
 * callback when a job finishes. Multiple jobs run concurrently.
 *
 * VISIBLE-PANE-ONLY. A crew agent runs in a pane the operator can watch, or it
 * does not run. There is no background/headless path. If a visible pane cannot
 * be opened — Ghostty absent, no anchor designated (`co pane` not run), the
 * anchor pane closed, or a placement/paste that goes nowhere — the dispatch
 * FAILS with an actionable message and launches nothing (no process, no
 * dangling job). This is deliberate: the removed background fallback once let a
 * dispatch run invisibly, the operator assumed it had failed and re-dispatched,
 * and two agents raced on the same checkout and corrupted the tree. An invisible
 * run is exactly the failure mode this design forecloses.
 *
 * LINK DURABILITY. The transport link has two layers: a persisted anchor (one
 * terminal id in .dispatch/config.json, which survives any pane deletion) and
 * this registry's in-memory pane layout (CrewPaneLayout), which tracks every
 * crew pane so a new worker splits from the newest one — the fibonacci spiral.
 * The layout is the fragile layer: a worker pane the captain closes leaves a
 * stale id behind, and a split targeting it would fail. So the registry keeps
 * the layout honest against a session where panes come and go forever, two ways:
 * PROACTIVELY, reconcilePaneLiveness() probes every tracked pane's existence
 * before planning and prunes the closed ones; and REACTIVELY, launchResilient()
 * prunes a pane that dies between the sweep and the split and re-plans against
 * the survivors. A single dead worker never nulls the whole layout — only a dead
 * ANCHOR (no living surface left to grow from) fails a dispatch, and then with a
 * clear re-run-`co pane` message, never a cryptic error.
 *
 * COMPLETION is detected from the capture file, which carries two kinds of
 * marker sharing one sentinel contract (sentinel.ts):
 *
 *  - A Claude Code crew's Stop hook (crewstophook.ts, installed per agent at
 *    dispatch time) appends an exit-0 sentinel the moment the crew FIRST
 *    finishes responding, plus a <job>.stop.json sidecar naming the run's own
 *    transcript. This is the primary signal: the review fires while the pane
 *    stays open and interactive — no /exit needed.
 *  - The pane's launch script still appends a sentinel with the real exit code
 *    when the crew PROCESS exits — the backstop for non-Claude agents and
 *    failed runs.
 *
 * These two markers force COMPLETION and PANE RELEASE apart. The old exit-time
 * sentinel meant both at once: the crew process was gone, its pane back to an
 * idle shell, safe to reuse (reuse pastes a launch line into the pane, so it
 * MUST be an idle shell, not a live agent). The Stop hook fires on the crew's
 * FIRST finish, while the agent is still live in its pane — so a hook-completed
 * job's review must fire, but its pane must NOT be offered for reuse, or a later
 * dispatch would paste a launch line into a running agent. This is exactly the
 * "never launch into a live pane" invariant.
 *
 * The ground-truth "the crew process is gone" signal is the per-job launch
 * script deleting itself: buildJobScript's finish() does `rm -f <self>` only
 * when the crew actually exits (and the pane's held shell has taken over). So a
 * pane job completes in two steps: finalize() fires the review immediately, but
 * releases the pane to the planner only once jobScriptFile() is gone. When the
 * script is already gone at completion time (a non-Claude agent, or a run whose
 * only marker is the exit-time sentinel) the release happens inline; otherwise
 * the job waits in pendingRelease and tick() releases it when the script clears.
 */

export type JobStatus = "running" | "queued" | "done" | "failed";

export interface Job {
  id: string;
  /** The full order text handed to the agent. */
  order: string;
  /** A short human label for notices (first line of the order, trimmed). */
  label: string;
  /** The crew agent this job launched with (the confirm-time override or the
   *  config default). Undefined means the config default was used. Kept so a
   *  queued job relaunches with the same agent and reviews can name it. */
  agentName?: string;
  transport: TransportKind;
  status: JobStatus;
  paneId?: string;
  /** The feature this job is scoped to, when dispatched with one: the
   *  job<->feature linkage. The feature's worktree record lives in the
   *  registry's feature map (getFeature). Absent for a plain dispatch. */
  feature?: string;
  /** The working directory the crew process was launched in, when it isn't the
   *  linked repo: a feature-scoped job runs inside the feature's worktree.
   *  Kept on the job so a queued relaunch lands in the same checkout. Absent for
   *  a plain dispatch. */
  cwd?: string;
  captureFile: string;
  /** Epoch ms when the job started running (set on launch, not on queue). */
  startedAt: number | null;
  /** Exit code from the sentinel, once complete (-1 when unobservable). */
  exitCode?: number;
  /** Populated when status is "failed": why it failed to launch or run. */
  error?: string;
  /** The crew agent's own session transcript path, if the Stop hook reported one
   *  (crewstophook.ts). Preferred over locating the transcript by order text. */
  transcriptPath?: string;
  /** The text of the crew agent's last response, if the Stop hook captured it.
   *  A fallback review record when no transcript can be read. */
  lastAssistantMessage?: string;
}

/** Fired when a job reaches a terminal state (done or failed). */
export type JobCompletionListener = (job: Job) => void;

const POLL_INTERVAL_MS = 750;

/** Injected clock, so tests aren't at the mercy of Date.now / real timers. */
export interface RegistryClock {
  now(): number;
}

export interface RegistryOptions {
  paths: InstancePaths;
  config: DispatchConfig;
  onComplete: JobCompletionListener;
  clock?: RegistryClock;
  pollIntervalMs?: number;
  /** Test seam: force whether the visible-pane path is available, bypassing the
   *  real macOS+Ghostty probe. Defaults to isGhosttyAvailable(). */
  ghosttyAvailable?: boolean;
  /** Called once if the designated crew anchor pane has been closed since
   *  `co pane` ran; the dispatch then fails (there is no background path) and the
   *  operator is told to re-run `co pane`. */
  onAnchorLost?: () => void;
  /** Called when the crew completion hook could not be installed (e.g. an
   *  unparseable settings.json in the agent's config dir). Advisory only: the
   *  dispatch still runs and completion falls back to the exit-time sentinel. */
  onHookIssue?: (message: string) => void;
  /** Test seam: skip the live anchor `exists` check (assume it's present). */
  skipAnchorCheck?: boolean;
  /** Test seam: replace the crew Stop-hook installer, so tests never write into
   *  the real ~/.claude. Defaults to installCrewStopHook (the real merge into the
   *  agent's config dir). */
  installHook?: (agentCommand: string) => Promise<InstallResult>;
  /** Test seam: replace the worktree provisioner, so tests can drive the
   *  feature-scoped dispatch path without a real git repo. Defaults to
   *  provisionWorktree (worktrees.ts), which is idempotent for an intact
   *  feature and throws with a reconcile pointer on any half-state. */
  provisionWorktree?: (opts: WorktreeOptions, feature: string) => Promise<FeatureRecord>;
}

/** Per-dispatch options beyond the order and agent. */
export interface DispatchOptions {
  /** Scope the dispatch to a feature: its worktree is provisioned on first use
   *  (reused on every later dispatch until landing) and the crew process runs
   *  with the worktree as its working directory, so the agent operates in the
   *  feature's isolated checkout on its `co/feat-<slug>` branch, never the
   *  primary tree. Omit for the plain repo-cwd dispatch. */
  feature?: string;
}

export class DispatchRegistry {
  private readonly paths: InstancePaths;
  /** The dispatch config. Re-read from disk at each dispatch (see
   *  refreshConfig) so a `co pane` / `co link` change in another process takes
   *  effect on the next dispatch without a session restart. Seeded from the
   *  constructor value, which is also the fallback when the file can't be read. */
  private config: DispatchConfig;
  private readonly onComplete: JobCompletionListener;
  private readonly clock: RegistryClock;
  private readonly pollIntervalMs: number;
  /** Whether the visible-pane path is usable at all: macOS + Ghostty reachable
   *  through AppleScript. Cached once at construction (the answer can't change
   *  within a session). When false, EVERY dispatch fails with an actionable
   *  message — there is no background/headless path to fall back to. */
  private readonly ghosttyAvailable: boolean;
  /** Whether to skip the live anchor `exists` probe (tests, and the no-anchor
   *  case). Remembered so a re-read that swaps in a new anchor re-probes it. */
  private readonly skipAnchorCheck: boolean;

  private readonly jobs = new Map<string, Job>();
  /** Per-feature worktree records (worktrees.ts), keyed by feature name. Not
   *  yet read by the job flow — see the feature-record methods below. */
  private readonly features = new Map<string, FeatureRecord>();
  /** Per-session tag mixed into capture/script FILE names (job ids stay short
   *  for display). Job ids restart at 001 every session while the captures dir
   *  persists, so an untagged job-001.log from a previous session would be
   *  overwritten — and worse, a stale file still containing a completion
   *  sentinel would instantly "complete" a new job before its launch had even
   *  created the real capture. Derived from the injected clock so tests stay
   *  deterministic. Combined with a per-DISPATCH nonce (see dispatch()) so the
   *  capture/identity key is unique per dispatch, not merely per session: a
   *  back-to-back re-run of the same order must never share a capture key. */
  private readonly runTag: string;
  /** FIFO of jobs waiting for a crew pane to free (at the pane cap). */
  private readonly queue: string[] = [];
  private layout: CrewPaneLayout | null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private jobSeq = 0;
  private stopped = false;
  /** Agent commands whose crew Stop hook we've already installed this session, so
   *  the (idempotent) install runs at most once per distinct agent — the hook
   *  lands in the agent's own config dir and teaches its Claude Code to report
   *  completion on first finish. Keyed by the resolved command string, since two
   *  agents (cc/ccw) resolve to different config dirs. */
  private readonly hookInstalled = new Set<string>();
  /** Jobs that have COMPLETED (their review has fired) but whose Ghostty pane
   *  still hosts a LIVE interactive agent — the Stop hook reports completion on
   *  the crew's FIRST finish, long before the human closes it. The pane is
   *  released for reuse only once the crew PROCESS exits, which buildJobScript
   *  signals by removing its own launch script (jobScriptFile). Polled in tick();
   *  never populated for a completion detected after the script was already gone
   *  (released inline). Keyed by job id. */
  private readonly pendingRelease = new Set<string>();
  /** Whether we've confirmed the designated anchor pane still exists this
   *  session. Checked once, lazily, on the first pane launch: a pane closed
   *  since `co pane` ran would otherwise fail the dispatch. */
  private anchorChecked = false;
  private readonly onAnchorLost?: () => void;
  private readonly onHookIssue?: (message: string) => void;
  private readonly installHook: (agentCommand: string) => Promise<InstallResult>;
  private readonly provisionFeature: (opts: WorktreeOptions, feature: string) => Promise<FeatureRecord>;

  constructor(opts: RegistryOptions) {
    this.paths = opts.paths;
    this.config = opts.config;
    this.onComplete = opts.onComplete;
    this.clock = opts.clock ?? { now: () => Date.now() };
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.ghosttyAvailable = opts.ghosttyAvailable ?? isGhosttyAvailable();
    this.skipAnchorCheck = Boolean(opts.skipAnchorCheck);
    this.runTag = this.clock.now().toString(36);

    // The placement planner exists only when Ghostty is reachable AND an anchor
    // has been designated. Without Ghostty, or before `co pane`, there is no
    // geometry — and there is no background path, so a dispatch in that state
    // FAILS with an actionable message (see dispatch()) rather than running
    // anything invisible.
    this.layout =
      this.ghosttyAvailable && this.config.anchor
        ? new CrewPaneLayout(this.config.anchor, this.config.pane)
        : null;
    this.onAnchorLost = opts.onAnchorLost;
    this.onHookIssue = opts.onHookIssue;
    this.installHook = opts.installHook ?? ((agentCommand) => installCrewStopHook({ agentCommand }));
    this.provisionFeature = opts.provisionWorktree ?? provisionWorktree;
    // Tests (and the no-anchor case) skip the live existence probe.
    this.anchorChecked = this.skipAnchorCheck || !this.layout;
  }

  /**
   * Whether the NEXT dispatch could actually open a visible pane: Ghostty is
   * reachable and an anchor has been designated (`co pane`). When false, a
   * dispatch fails cleanly — there is no background path — so the arming banner
   * warns the operator to run `co pane` (or open Ghostty) before confirming.
   *
   * Best-effort at the current moment: it doesn't re-probe a possibly-closed
   * anchor (that lazy check happens at launch time), so a true here means "the
   * geometry is set up", not "guaranteed to succeed". A launch that then finds
   * the pane gone still fails cleanly with an actionable message.
   */
  get paneReady(): boolean {
    return this.ghosttyAvailable && this.layout !== null;
  }

  private nextJobId(): string {
    // Stable, sortable, collision-free within a session. Not time-based so tests
    // are deterministic. Capture FILES additionally carry the runTag plus a
    // per-dispatch nonce, because the captures dir persists across sessions while
    // these ids restart at 001 (and a re-run must never share a capture key).
    this.jobSeq += 1;
    return `job-${String(this.jobSeq).padStart(3, "0")}`;
  }

  /** A short random nonce that makes each dispatch's capture/identity key unique,
   *  even for the same order re-run back-to-back in one session. The job id
   *  (job-NNN) is stable and display-friendly; the capture FILE key additionally
   *  mixes in the session runTag and this per-dispatch nonce, so two dispatches
   *  can never share a capture file, a Stop-hook correlation, or a stale-sentinel
   *  collision. */
  private dispatchNonce(): string {
    return randomBytes(4).toString("hex");
  }

  /** Snapshot of all jobs, newest last. */
  list(): Job[] {
    return [...this.jobs.values()];
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Jobs currently running or queued. */
  activeCount(): number {
    return this.list().filter((j) => j.status === "running" || j.status === "queued").length;
  }

  // --- feature records (worktree layer) --------------------------------------
  //
  // Per-feature worktree state for the parallel-dispatch flow (worktrees.ts):
  // which branch and isolated checkout a feature owns, and where its provision
  // stands. A feature-scoped dispatch (DispatchOptions.feature) reads and
  // maintains these (provision on first use, reuse thereafter) while a plain
  // dispatch never touches them.

  /** Record (or update) a feature's worktree state. */
  upsertFeature(record: FeatureRecord): void {
    this.features.set(record.feature, record);
  }

  getFeature(feature: string): FeatureRecord | undefined {
    return this.features.get(feature);
  }

  /** Snapshot of all tracked features. */
  listFeatures(): FeatureRecord[] {
    return [...this.features.values()];
  }

  /** Drop a feature record (after teardown). Returns whether one existed. */
  removeFeature(feature: string): boolean {
    return this.features.delete(feature);
  }

  /** The jobs dispatched under a feature, oldest first: the other direction of
   *  the job<->feature linkage (each scoped Job carries its feature name). */
  jobsForFeature(feature: string): Job[] {
    return this.list().filter((j) => j.feature === feature);
  }

  /**
   * Re-read the dispatch config from disk and return the current in-memory copy.
   * This is the SAME refresh a dispatch does, exposed so the arming banner shows
   * exactly what the next dispatch will run — otherwise the banner reads a config
   * snapshotted at session start and a mid-session `co link` makes it lie (it
   * would show the old crew command while dispatch quietly uses the new one).
   */
  async currentConfig(): Promise<DispatchConfig> {
    await this.refreshConfig();
    return this.config;
  }

  /**
   * Re-read the dispatch config from disk and, if the designated anchor changed
   * (a `co pane` in another process while this session runs), rebuild the layout
   * on the new anchor so the very next dispatch targets it — no session restart.
   *
   * This is the fix for a stale pane id surviving `co pane`: the running session
   * cached the anchor at construction, so a re-designated pane was invisible. We
   * do NOT rebuild when the anchor id is unchanged: that would throw away live
   * pane state (splits, running jobs) on every dispatch. A brand-new anchor is
   * re-probed for existence on its first pane launch (anchorChecked reset).
   *
   * Best-effort: an unreadable/corrupt config keeps the current in-memory config
   * rather than tearing down a working session.
   */
  private async refreshConfig(): Promise<void> {
    const fresh = await readDispatchConfig(this.paths);
    if (!fresh) return; // never linked, or unreadable: keep what we have
    this.config = fresh;

    // The rest reconciles pane geometry, which only exists when Ghostty is
    // reachable. The config re-read above must happen regardless, though: a
    // mid-session `co link` (e.g. correcting a crew command) has to take effect
    // even when no pane can be placed, so the eventual failure names the right
    // command.
    if (!this.ghosttyAvailable) return;

    const anchor = fresh.anchor;
    const currentAnchorId = this.layout?.anchorPaneId ?? null;
    const nextAnchorId = anchor?.id ?? null;
    if (nextAnchorId === currentAnchorId) return; // unchanged: keep live state

    // The anchor was added, changed, or cleared. Rebuild from the fresh value.
    this.layout = anchor ? new CrewPaneLayout(anchor, fresh.pane) : null;
    // A fresh anchor must be re-probed for existence before we trust it (unless
    // tests opt out); a cleared anchor has no pane to check.
    this.anchorChecked = this.skipAnchorCheck || !this.layout;
  }

  /**
   * Launch (or queue) a dispatch for `order`. Returns the created Job. Never
   * throws into the caller: a launch failure marks the job failed and notifies,
   * so a bad dispatch can't crash the session. Starts the poller if idle.
   *
   * With `opts.feature`, the dispatch is scoped to that feature: its worktree is
   * provisioned if this is the feature's first dispatch (ensureFeatureWorktree),
   * reused otherwise, and the crew process runs with the worktree as its cwd;
   * the agent binds to the isolated checkout by being launched inside it. A
   * worktree is worked serially (agents in one checkout would trample each
   * other's index and files), so a second dispatch to a feature whose job is
   * still running or queued fails cleanly instead of launching. Provisioning
   * failures take the same marked-failed-and-notified path as launch failures.
   */
  async dispatch(order: string, agentName?: string, opts: DispatchOptions = {}): Promise<Job> {
    // Pick up a `co pane` / `co link` change made since the session started (or
    // the last dispatch) before deciding whether a pane can be placed.
    await this.refreshConfig();

    // Teach this agent's Claude Code to report completion on first finish (the
    // Stop hook, crewstophook.ts). Idempotent and best-effort: an install failure
    // only means the review waits until the pane closes, exactly the old
    // behaviour, so it never blocks the dispatch.
    await this.ensureStopHook(agentName);

    const id = this.nextJobId();
    const label = firstLine(order);
    // The capture/identity key is unique per DISPATCH: the job id (stable, for
    // display) plus the session runTag plus a per-dispatch random nonce. The
    // runTag alone stops a previous session's job-001.log from being overwritten
    // (or, worse, its stale sentinel read as this job's); the nonce additionally
    // stops two dispatches IN ONE SESSION — the same order re-run back-to-back —
    // from ever sharing a capture file, a Stop-hook correlation, or a sentinel.
    const captureFile = this.paths.captureFile(`${id}-${this.runTag}-${this.dispatchNonce()}`);
    const job: Job = {
      id,
      order,
      label,
      ...(agentName ? { agentName } : {}),
      ...(opts.feature ? { feature: opts.feature } : {}),
      transport: "ghostty",
      status: "running",
      captureFile,
      startedAt: this.clock.now(),
    };
    this.jobs.set(id, job);

    // Lazily confirm the designated anchor pane still exists before the first
    // pane launch. If it was closed since `co pane` ran, drop the layout so the
    // failure below is clean and actionable rather than a raw AppleScript error.
    if (this.layout && !this.anchorChecked) {
      this.anchorChecked = true;
      const present = await anchorExists(this.config.anchor!.id);
      if (!present) {
        this.layout = null;
        this.onAnchorLost?.();
      }
    }

    // Reclaim any hook-completed pane whose agent has since been closed before
    // this job plans its placement, so a genuinely-free pane is reused now
    // instead of this dispatch queueing until the next poll tick.
    await this.releaseFinishedPanes();

    try {
      // No visible pane can be placed — Ghostty isn't reachable, or no anchor has
      // been designated (`co pane` not run), or the anchor pane was just found
      // gone. There is NO background path: fail cleanly with an actionable
      // message and launch nothing. This is the whole point of visible-only
      // dispatch — an invisible run is what let two agents race the same tree.
      if (!this.layout) {
        throw new Error(this.paneUnavailableMessage());
      }

      // Feature scoping happens inside the try so its failures ride the same
      // marked-failed-and-notified path as launch failures: a bad provision
      // (a half-state worktree, a missing repo) can't crash the session.
      if (job.feature) {
        const clash = this.list().find(
          (j) =>
            j.id !== job.id &&
            j.feature === job.feature &&
            (j.status === "running" || j.status === "queued"),
        );
        if (clash) {
          throw new Error(
            `feature '${job.feature}' already has an active job (${clash.id}); ` +
              `a feature's worktree runs one agent at a time`,
          );
        }
        const record = await this.ensureFeatureWorktree(job.feature);
        job.cwd = record.worktreePath;
      }

      // Proactively drop any worker pane the captain has closed since it was
      // created, so the common "delete a finished worker, dispatch again" path
      // plans against living panes only and never even hits a dead-pane error.
      await this.reconcilePaneLiveness();

      try {
        const launched = await this.launchResilient(job);
        if (!launched) {
          // At the pane cap with nothing free: hold this job until one frees.
          // This is the ONLY non-launch outcome that isn't a failure — the queue
          // never runs anything in the background, it just waits for a pane.
          job.status = "queued";
          job.startedAt = null;
          this.queue.push(job.id);
        }
      } catch (e) {
        if (!(e instanceof PaneUnavailableError)) throw e;
        // Only a dead ANCHOR reaches here: launchResilient prunes-and-retries a
        // dead worker pane, so a single closed worker never gets this far. The
        // anchor is the growth root with no living surface behind it — there is
        // no background path, so drop the layout for the session, tell the
        // operator to re-run `co pane`, and fail the dispatch. Nothing launched.
        this.layout = null;
        this.onAnchorLost?.();
        throw new Error(this.paneUnavailableMessage());
      }
    } catch (e) {
      job.status = "failed";
      job.error = (e as Error).message;
      // Notify asynchronously so dispatch() callers see a consistent return
      // before the completion callback fires.
      queueMicrotask(() => this.onComplete(job));
      return job;
    }

    this.ensurePolling();
    return job;
  }

  /** The actionable message a pane-unavailable failure surfaces. Names the exact
   *  fix depending on why no pane could be placed: open Ghostty, or designate the
   *  crew pane. There is no background fallback to mention — a dispatch that can't
   *  be seen doesn't run. */
  private paneUnavailableMessage(): string {
    if (!this.ghosttyAvailable) {
      return (
        "couldn't open a crew pane — dispatch needs a visible Ghostty pane and " +
        "Ghostty isn't reachable here (macOS + Ghostty 1.3+ with automation access). " +
        "Nothing was launched."
      );
    }
    return (
      "couldn't open a crew pane — relink the dispatch pane and try again " +
      "(run `co pane` to designate the crew pane). Nothing was launched."
    );
  }

  /**
   * Install the crew-completion Stop hook into the config dir the given agent
   * uses, at most once per distinct agent command per session. The hook is what
   * makes a dispatched run report its result the moment Claude first finishes,
   * with the pane still open (crewstophook.ts / crewhook.ts). The install is
   * idempotent and surgical (merges one hook, preserves the rest of the user's
   * settings.json); a failure is reported via onHookIssue but never blocks the
   * dispatch, since the transport's own exit-time sentinel remains the backstop.
   */
  private async ensureStopHook(agentName?: string): Promise<void> {
    const command = resolveAgentCommand(this.config, agentName);
    if (!command || this.hookInstalled.has(command)) return;
    // Mark before awaiting so two rapid dispatches for the same agent don't both
    // run the install; a failure below still leaves it marked (we don't retry a
    // broken settings.json every dispatch — it's reported once).
    this.hookInstalled.add(command);
    try {
      const res = await this.installHook(command);
      if (res.error) this.onHookIssue?.(res.error);
    } catch (e) {
      this.onHookIssue?.(`could not install the crew completion hook: ${(e as Error).message}`);
    }
  }

  /**
   * The feature's worktree, provisioned on first use and reused thereafter.
   * A record already marked ready whose directory still exists is returned
   * without touching git: the once-per-feature cost stays once-per-feature
   * across the many dispatches a feature consumes. Anything else (first
   * dispatch this session, a failed earlier provision, a worktree deleted out
   * from under us) goes through provisionWorktree, which is itself idempotent
   * for an intact feature (a session restart quietly rebinds to the existing
   * worktree) and throws with a reconcile pointer on half-states. The
   * record's provision status is tracked through the attempt so a concurrent
   * listFeatures() never sees a fiction.
   */
  private async ensureFeatureWorktree(feature: string): Promise<FeatureRecord> {
    const existing = this.features.get(feature);
    if (existing?.provisionStatus === "ready" && fs.existsSync(existing.worktreePath)) {
      return existing;
    }
    const slug = featureSlug(feature);
    const pending: FeatureRecord = {
      feature,
      slug,
      branch: featureBranch(feature),
      worktreePath: path.join(defaultWorktreeBase(this.config.repoPath), slug),
      provisionStatus: "provisioning",
    };
    this.upsertFeature(pending);
    try {
      const record = await this.provisionFeature({ repoPath: this.config.repoPath }, feature);
      this.upsertFeature(record);
      return record;
    } catch (e) {
      this.upsertFeature({ ...pending, provisionStatus: "failed" });
      throw e;
    }
  }

  /**
   * Prune every tracked crew pane the captain has closed since it was created, so
   * the very next placement targets living panes only. Probes Ghostty's `exists`
   * for each tracked pane id (in parallel) and drops the dead ones from the
   * layout. This is the PROACTIVE half of link durability: the common
   * delete-a-worker-then-dispatch path never even reaches a dead-pane error,
   * because the dead id is gone before plan() runs. launchResilient is the
   * reactive backstop for a pane that dies between this sweep and the split.
   *
   * Never nulls the layout: a dead anchor is pruned from the tracked list here
   * too (so a surviving child can still be split from), and the anchor-loss
   * decision is deferred to the moment a dispatch actually needs the anchor and
   * finds it gone (launchResilient → dispatch's catch). Best-effort — a probe
   * failure degrades to "gone", which at worst orphans a live pane from tracking,
   * never a link break.
   */
  private async reconcilePaneLiveness(): Promise<void> {
    if (!this.layout) return;
    const ids = this.layout.trackedPaneIds;
    if (ids.length === 0) return;
    const alive = await Promise.all(ids.map((id) => paneExists(id)));
    ids.forEach((id, i) => {
      if (!alive[i]) this.layout?.prune(id);
    });
  }

  /**
   * Launch a job on a pane, surviving the captain closing a worker pane. On a
   * PaneUnavailableError for a tracked WORKER pane, prune just that dead id and
   * re-plan against the survivors (the next newest living child, else the
   * anchor), leaving the rest of the link intact — one dead pane never destroys
   * the layout.
   *
   * Only a dead ANCHOR (the growth root) — or an id we don't track and so can't
   * prune — escapes as a PaneUnavailableError, which dispatch()/drainQueue turn
   * into a clean "re-run `co pane`" failure. The loop is bounded: each retry
   * prunes exactly one tracked pane, and an emptied list falls back to the
   * anchor, which escapes rather than looping.
   */
  private async launchResilient(job: Job): Promise<boolean> {
    for (;;) {
      try {
        return await this.launchOnPane(job);
      } catch (e) {
        if (!(e instanceof PaneUnavailableError)) throw e;
        const deadId = e.paneId;
        // The anchor itself is gone, or the failed id isn't a tracked worker we
        // can prune: there is no living surface to grow from. Surface it to the
        // anchor-loss path rather than looping.
        if (!this.layout || deadId === this.config.anchor?.id || !this.layout.prune(deadId)) {
          throw e;
        }
        // Pruned a dead worker pane; loop to re-plan against the survivors.
      }
    }
  }

  /**
   * Ghostty launch path: launchGhostty consults the planner (its single plan()).
   * Returns true if the job actually launched into a pane, false if the planner
   * said to queue (at the cap with nothing free). The caller owns queue bookkeeping.
   */
  private async launchOnPane(job: Job): Promise<boolean> {
    const res = await launchGhostty({
      paths: this.paths,
      config: this.config,
      layout: this.layout!,
      jobId: job.id,
      order: job.order,
      captureFile: job.captureFile,
      ...(job.agentName ? { agentName: job.agentName } : {}),
      ...(job.cwd ? { cwd: job.cwd } : {}),
    });
    if (res.placement && res.placement.kind === "queue") return false;
    job.paneId = res.paneId;
    return true;
  }

  /** Begin polling capture files if not already. */
  private ensurePolling(): void {
    if (this.poller || this.stopped) return;
    this.poller = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    // Deliberately NOT unref'd: while a crew job is in flight, detecting its
    // completion and firing the review IS the work the process is here to do, so
    // the poller legitimately holds the loop open (the detached agent child is
    // unref'd, so nothing else would). tick() clears the timer the moment no job
    // is active, and stop() clears it on every session-exit path, so it can't
    // outlive the jobs it watches. Tests always stop() in a finally so a failed
    // assertion can't leak a live interval.
  }

  /** One poll: check each running job for completion or timeout, then reclaim any
   *  pane whose hook-completed agent has since been closed. */
  private async tick(): Promise<void> {
    const running = this.list().filter((j) => j.status === "running");
    for (const job of running) {
      await this.checkJob(job);
    }
    // A hook-completed pane whose agent the human has since closed (its launch
    // script self-deleted) rejoins the reusable set here and drains any queued
    // job into it. Runs before the stop check so a release that launches a
    // queued job keeps the poller alive for it.
    await this.releaseFinishedPanes();
    // Nothing left to watch and nothing queued: stop the timer. A pane still
    // pending release with nothing queued does NOT hold the poller (and the
    // process) open — a future dispatch that needs the pane re-drains it.
    if (this.activeCount() === 0 && this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
  }

  private async checkJob(job: Job): Promise<void> {
    // Timeout first: a hung agent must not watch forever.
    const timeoutSec = this.config.caps.timeoutSec;
    if (timeoutSec && job.startedAt !== null) {
      const elapsed = (this.clock.now() - job.startedAt) / 1000;
      if (elapsed > timeoutSec) {
        // A pane job's agent lives in a Ghostty pane we don't own the process
        // for, so there's nothing to kill — mark it failed and let finalize
        // release the pane once its agent is gone. The human closes the pane.
        await this.finalize(job, "failed", { error: `timed out after ${timeoutSec}s` });
        return;
      }
    }

    let captured: string;
    try {
      // Tail read: a pane capture is a pty recording of an interactive agent
      // and can run to megabytes; the sentinel is appended at the very end, so
      // polling never needs more than the tail.
      captured = await readFileTail(job.captureFile, 64 * 1024);
    } catch {
      return; // capture file not created yet; try again next tick
    }
    const sentinel = parseSentinel(captured);
    if (!sentinel) return;

    // The completion marker may have come from the crew's Stop hook, which drops
    // a sidecar (<job>.stop.json) beside the capture carrying the agent's own
    // session transcript path and last message. Prefer that record for the
    // review — it's exact, not located by matching the order text. Absent (a
    // non-Claude agent, or an exit-time transport sentinel), the review falls
    // back to finding the transcript by order and then to the raw capture.
    const stop = await this.readStopCapture(job);

    const status: JobStatus = sentinel.exitCode > 0 ? "failed" : "done";
    await this.finalize(job, status, {
      exitCode: sentinel.exitCode,
      ...(stop?.transcript_path ? { transcriptPath: stop.transcript_path } : {}),
      ...(stop?.last_assistant_message ? { lastAssistantMessage: stop.last_assistant_message } : {}),
      ...(status === "failed" ? { error: `agent exited ${sentinel.exitCode}` } : {}),
    });
  }

  /** Read the Stop hook's sidecar (<job>.stop.json) for a job, or null when the
   *  hook didn't fire (non-Claude agent, or completion came from the transport's
   *  exit-time sentinel). Best-effort: a missing or malformed sidecar is just an
   *  absent record, never an error. */
  private async readStopCapture(job: Job): Promise<StopCapture | null> {
    const { job: stem, captureDir } = dispatchCorrelation(job.captureFile);
    try {
      const raw = await fsp.readFile(stopCaptureFile(captureDir, stem), "utf8");
      return JSON.parse(raw) as StopCapture;
    } catch {
      return null;
    }
  }

  /** Move a job to a terminal state, fire its review, and release its pane for
   *  reuse — but only once that pane no longer hosts a live agent. The queue
   *  drain is awaited so a released pane deterministically relaunches the next
   *  queued job before the caller (a poll tick) returns.
   *
   *  COMPLETION and PANE RELEASE are separate on the pane path (see the class
   *  doc): the Stop hook fires on the crew's first finish while the agent is
   *  still live in the pane, so we notify immediately but must not offer that
   *  pane for reuse until the crew process is truly gone. buildJobScript deletes
   *  the launch script (jobScriptFile) as its last act, so the script's absence
   *  is that signal. If it is already gone (exit-time sentinel, or a non-Claude
   *  agent) we release inline; otherwise the job waits in pendingRelease and
   *  tick() releases it when the script clears. */
  private async finalize(job: Job, status: "done" | "failed", extra: Partial<Job>): Promise<void> {
    job.status = status;
    Object.assign(job, extra);
    // Notify first so the review is enqueued before we relaunch anything; the
    // ordering keeps a completion callback ahead of the next job's launch notices.
    this.onComplete(job);
    if (!job.paneId || !this.layout) return; // failed before a pane was placed
    if (this.paneAgentGone(job)) {
      await this.releasePane(job);
    } else {
      // The agent is still live in its pane (hook fired on first finish). Hold
      // the pane; tick() releases it once the launch script self-deletes.
      this.pendingRelease.add(job.id);
    }
  }

  /** Whether the crew PROCESS behind a pane job has exited, so its pane is back
   *  to an idle held shell and safe to reuse. True once the per-job launch script
   *  has removed itself (buildJobScript's last act) — or when there was never a
   *  script (defensive; a job that failed before launch has no pane and never
   *  reaches here). */
  private paneAgentGone(job: Job): boolean {
    return !fs.existsSync(jobScriptFile(job.captureFile));
  }

  /** Free a completed job's pane in the planner and drain the queue into it.
   *  Idempotent per job via pendingRelease removal by the caller. */
  private async releasePane(job: Job): Promise<void> {
    if (!job.paneId || !this.layout) return;
    this.layout.finish(job.paneId);
    await this.drainQueue();
  }

  /** Release any completed-but-still-live pane whose crew process has now exited
   *  (its launch script self-deleted). Run each poll tick alongside the running
   *  jobs so a hook-completed pane rejoins the reusable set the moment its agent
   *  is closed — without blocking the review, which already fired at completion. */
  private async releaseFinishedPanes(): Promise<void> {
    if (this.pendingRelease.size === 0) return;
    for (const id of [...this.pendingRelease]) {
      const job = this.jobs.get(id);
      if (!job || !job.paneId) {
        this.pendingRelease.delete(id); // job vanished; nothing to release
        continue;
      }
      if (this.paneAgentGone(job)) {
        this.pendingRelease.delete(id);
        await this.releasePane(job);
      }
    }
  }

  /**
   * A pane just freed: try to launch the oldest queued job. Re-plans through the
   * layout, so a freed pane is reused (or the job re-queues if the planner still
   * says to). Best-effort; a launch failure fails just that job.
   */
  private async drainQueue(): Promise<void> {
    if (!this.layout) return;
    // A pane the captain closed while jobs waited must not be planned against, so
    // sweep liveness once before draining — the freed slot then re-plans over
    // living panes only.
    await this.reconcilePaneLiveness();
    while (this.queue.length > 0) {
      if (!this.layout) return; // the anchor died mid-drain; stop cleanly
      const nextId = this.queue[0]!;
      const job = this.jobs.get(nextId);
      if (!job || job.status !== "queued") {
        this.queue.shift(); // stale entry (job finished/removed); drop it
        continue;
      }
      // Mark running provisionally so launchOnPane's plan()/commit() treat it as
      // an active job; revert if the planner still says to queue.
      job.status = "running";
      job.startedAt = this.clock.now();
      let launched = false;
      try {
        launched = await this.launchResilient(job);
      } catch (e) {
        if (e instanceof PaneUnavailableError) {
          // launchResilient already pruned any dead worker pane and retried; only
          // a dead ANCHOR reaches here. There is no background path: drop pane
          // geometry for the session and fail this job cleanly — same as a
          // first-time dispatch that can't place a pane.
          this.queue.shift();
          this.layout = null;
          this.onAnchorLost?.();
          job.status = "failed";
          job.error = this.paneUnavailableMessage();
          this.onComplete(job);
          continue;
        }
        this.queue.shift();
        job.status = "failed";
        job.error = (e as Error).message;
        this.onComplete(job);
        continue;
      }
      if (!launched) {
        // Still no room. Revert and stop; the next completion re-drains.
        job.status = "queued";
        job.startedAt = null;
        return;
      }
      this.queue.shift();
      this.ensurePolling();
    }
  }

  /** Stop the poller. Jobs keep running in their panes / background; we simply
   *  stop watching (called at session end). Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
  }
}

function firstLine(order: string): string {
  const line = order.split("\n").find((l) => l.trim() !== "")?.trim() ?? "dispatch";
  return line.length > 60 ? line.slice(0, 57) + "…" : line;
}

/** Read at most the last `maxBytes` of a file (the whole file when smaller).
 *  Throws like readFile if the file doesn't exist — callers treat that as
 *  "not created yet". Exported for the session's review reader, which faces the
 *  same pty-recording sizes. */
export async function readFileTail(file: string, maxBytes: number): Promise<string> {
  const stat = await fsp.stat(file);
  if (stat.size <= maxBytes) return fsp.readFile(file, "utf8");
  const fh = await fsp.open(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    await fh.read(buf, 0, maxBytes, stat.size - maxBytes);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}
