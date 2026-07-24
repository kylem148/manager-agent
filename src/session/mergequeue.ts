import {
  executeLanding,
  prepareLanding,
  type BuildTestSummary,
  type LandingOptions,
  type PrepareResult,
} from "./landing.js";
import { resolveWorktreeOptions } from "./worktrees.js";

/**
 * The serial merge-queue engine (decisions D-20260723-14/-21/-22): the layer
 * that turns "the captain marked these features done" into an ordered, one-at-a-
 * time landing onto `dev`. It sits ON TOP of the proven landing machinery and
 * adds no git of its own — every rebase, build+test, merge, and teardown is the
 * EXISTING code (prepareLanding for processing, executeLanding for the merge).
 * What this module owns is the state machine and the ordering.
 *
 * THE INVARIANT: at most ONE feature is ever being processed or ready at a time,
 * and it is always the queue HEAD (entries[0]). Every other entry sits "queued"
 * and is never touched — no speculative pre-testing of non-head features
 * (D-20260723-22 defers the merge train). This falls out of the design: only the
 * head is ever handed to prepareLanding.
 *
 * THE LIFECYCLE of a single feature through the queue:
 *   queued ──processHead──▶ head-processing ──▶ ready   (rebase clean, build+test green)
 *                                            └─▶ blocked (rebase conflict OR build+test red)
 *   ready ──mergeReadyHead──▶ (merged: gone from the queue; the next feature becomes head)
 *   blocked ──holds the queue── until the captain resolves (re-enqueue to retry) or removes it.
 *
 * THE MERGE IS PANEL-NATIVE (D-20260724-12). mergeReadyHead performs the merge
 * outright: no gate is opened, nothing is awaited but git. The human act that
 * authorises it is the Ctrl-O panel's [m] keystroke on a ready head, and the
 * panel calls this directly — so the co's agent loop is never parked waiting on
 * a keypress. The old shape (a co tool call that opened a blocking review gate
 * and held the turn open until [m]) is gone; the queue no longer knows the Tui
 * exists. What guards the merge is unchanged and lives BELOW here: the head must
 * be `ready` (rebased onto the current dev tip with a green build+test on the
 * combined state), and executeLanding still pins to the exact tested featureSha
 * and CAS-writes dev, so a stale green fails loudly instead of landing.
 *
 * STRICT SERIAL, HEAD-ONLY, NO SET-ASIDE (D-20260723-21): a blocked head keeps
 * its position and holds everything behind it. Nothing is set aside, nothing red
 * ever lands, and no resolver agent is auto-spawned here (a later slice). The
 * head just waits.
 *
 * WHY the head is re-processed against the NEW dev tip after each merge: feature
 * A green and feature B green does not make A+B green — B may compile only
 * against code A changed. So when A merges and B becomes head, B is rebased onto
 * the dev A just moved and build+tested on that combined tree before it is ever
 * offered for merge. This is exactly prepareLanding's contract; the queue just
 * calls it at the right moments.
 *
 * WHAT this module does NOT do: touch `main` at all, reach for a terminal (it
 * has no UI and no host to open one — it EXPOSES state the panel renders and a
 * merge the panel invokes), or persist across a restart (in-memory per session,
 * like the registry's job map — a restart rebuilds feature records from disk but
 * starts the queue empty, which is safe: nothing has been half-landed).
 */

/**
 * Where a queued feature stands. Only the head is ever anything but "queued".
 *
 * "resolving" (D-20260723-24) is the head while a FRESH crew agent we dispatched
 * is fixing it in its own worktree (rebasing onto the dev tip, resolving the
 * conflict, driving build+test green). It is a busy state: the head holds the
 * queue and merges nothing until the agent finishes and the head is re-processed.
 */
export type QueueStatus = "queued" | "head-processing" | "ready" | "blocked" | "resolving";

/**
 * Why a blocked head is blocked, kept apart from the human-readable reason so the
 * UI and the resolver path can branch on it. "conflict": the rebase onto the dev
 * tip hit merge conflicts (a fresh agent can resolve these). "failed": the rebase
 * was clean but the combined build+test came back red.
 */
export type BlockedKind = "conflict" | "failed";

/** How many times the head may be handed to a fresh resolver agent before the
 *  queue gives up and leaves it blocked for the captain (D-20260723-24). */
export const MAX_RESOLVE_ATTEMPTS = 3;

/** One feature's place in the queue. `prepared`/`blockedReason` are meaningful
 *  only for the head (the sole entry that is ever processed). */
interface QueueEntry {
  feature: string;
  status: QueueStatus;
  /** The head's most recent processHead outcome; absent until it is processed. */
  prepared?: PrepareResult;
  /** One-line reason the head is blocked (conflict paths, or a red exit). */
  blockedReason?: string;
  /** Which flavour of blocked, when status is "blocked" — drives the resolver. */
  blockedKind?: BlockedKind;
  /** How many fresh resolver agents have been dispatched for this head so far.
   *  Persists across re-processing; reset only when the head changes. */
  resolveAttempts?: number;
}

/** A JSON-serializable snapshot of one entry, for tool output and feature views. */
export interface QueueEntryView {
  feature: string;
  /** 1-based position in landing order (1 is the head). */
  position: number;
  isHead: boolean;
  status: QueueStatus;
  /** Commits awaiting merge on a ready head (0 is possible but is treated as
   *  nothing-to-land and reported blocked, so a ready head always has > 0). */
  commitsReady?: number;
  /** Present when status is "blocked". */
  blockedReason?: string;
  /** Present when status is "blocked": conflict vs red build+test. */
  blockedKind?: BlockedKind;
  /** Resolver attempts spent so far on this head (0 until the first dispatch). */
  resolveAttempts?: number;
}

export interface QueueView {
  size: number;
  head: QueueEntryView | null;
  /** Every entry in landing order. */
  entries: QueueEntryView[];
}

/**
 * The head's inline body for the Ctrl-O queue tab (D-20260724-12). A ready head
 * carries exactly what pressing [m] would land — the per-job commits, the full
 * patch against dev, and the build+test that passed on the combined state — so
 * the affordance and its evidence sit in one view. A blocked head carries why it
 * is not mergeable (and, for the two fixable flavours, what the resolver would
 * be sent at). Anything else has no body.
 *
 * Structurally what the Tui's QueueHeadDetail declares; the Tui does not import
 * from the session layer, so the two are kept assignable rather than shared.
 */
export type QueueHeadDetail =
  | {
      kind: "ready";
      feature: string;
      /** The integration branch the merge writes (e.g. "dev"). */
      target: string;
      commits: string[];
      diff: string;
      buildTest?: BuildTestSummary;
    }
  | {
      kind: "blocked";
      feature: string;
      target: string;
      blockedKind?: BlockedKind;
      reason: string;
      /** conflict: the paths left unmerged, and git's own account. */
      conflictFiles?: string[];
      detail?: string;
      /** failed: the red build+test's exit code and output tail. */
      exitCode?: number;
      output?: string;
      buildTest?: BuildTestSummary;
      resolveAttempts?: number;
      maxResolveAttempts?: number;
    };

/** The side effects the queue needs from its owner (FeatureManager): the busy
 *  check that must gate any git on a worktree, and the record cleanup a merge
 *  or removal implies. Kept as a narrow interface so the queue is unit-testable
 *  with a fake host and no registry. */
export interface MergeQueueHost {
  /** Whether a crew agent is currently running or queued in the feature's
   *  worktree. A worktree is worked serially, so the queue must never rebase or
   *  merge one out from under a live agent. */
  isBusy(feature: string): boolean;
  /** Drop the feature's tracking (registry record + any intent) after it has
   *  landed or been removed from the queue. */
  forget(feature: string): void;
}

/** Test seams: the two pieces of the EXISTING landing machinery the queue
 *  drives. Defaulted to the real ones; overridden in unit tests so the state
 *  machine can be exercised without a real git repo. */
export interface MergeQueueDeps {
  prepare: typeof prepareLanding;
  execute: typeof executeLanding;
}

export interface MergeQueueOptions {
  repoPath: string;
  /** Combined build+test for the landing prepare (the head's gate to ready). */
  buildTestCommand: string;
  host: MergeQueueHost;
  deps?: Partial<MergeQueueDeps>;
}

/** enqueue's outcome: the entry's place plus the head's (possibly just-updated)
 *  state, so the co can see in one call whether the head is now ready/blocked. */
export interface EnqueueResult {
  feature: string;
  /** True when the feature was already in the queue (idempotent add). */
  alreadyQueued: boolean;
  entry: QueueEntryView;
  head: QueueEntryView | null;
  queue: QueueView;
  summary: string;
}

/**
 * mergeReadyHead's outcome (and, unchanged in shape, what feature_merge_head
 * reports back to the co).
 *
 *  merged     — the head landed on dev and the queue advanced.
 *  failed     — executeLanding refused or threw (a stale green, a dev checkout,
 *               a branch that moved); nothing was written.
 *  not-ready  — the head isn't green (blocked/processing/resolving); no merge.
 *  empty      — nothing is queued.
 *  busy       — a crew agent still owns the head's worktree.
 *  panel      — an interactive session: the [m] affordance is live in the Ctrl-O
 *               queue tab and the merge is the captain's keystroke, not a tool
 *               call. Nothing was merged and nothing is waiting on the co.
 */
export interface MergeHeadResult {
  merged: boolean;
  outcome: "merged" | "failed" | "not-ready" | "empty" | "busy" | "panel";
  /** The head that was (attempted to be) merged. Empty string for an empty queue. */
  feature: string;
  summary: string;
  /** Present on a merge: the merge commit and the branch it landed on. */
  mergeSha?: string;
  target?: string;
  /** The head AFTER the operation: on a merge, the next feature (already
   *  processed against the new dev tip); otherwise the same head. */
  head: QueueEntryView | null;
  queue: QueueView;
  error?: string;
}

export interface ProcessHeadResult {
  processed: boolean;
  head: QueueEntryView | null;
  queue: QueueView;
  summary: string;
}

export interface RemoveResult {
  removed: boolean;
  /** Whether the removed feature was the head (so the queue advanced). */
  wasHead: boolean;
  head: QueueEntryView | null;
  queue: QueueView;
}

export class MergeQueue {
  private readonly entries: QueueEntry[] = [];
  private readonly repoPath: string;
  private readonly buildTestCommand: string;
  private readonly host: MergeQueueHost;
  private readonly deps: MergeQueueDeps;

  constructor(opts: MergeQueueOptions) {
    this.repoPath = opts.repoPath;
    this.buildTestCommand = opts.buildTestCommand;
    this.host = opts.host;
    this.deps = {
      prepare: opts.deps?.prepare ?? prepareLanding,
      execute: opts.deps?.execute ?? executeLanding,
    };
  }

  private landingOptions(): LandingOptions {
    return { repoPath: this.repoPath, buildTestCommand: this.buildTestCommand };
  }

  private get targetBranch(): string {
    return resolveWorktreeOptions({ repoPath: this.repoPath }).devBranch;
  }

  /** Whether a feature is anywhere in the queue. */
  has(feature: string): boolean {
    return this.entries.some((e) => e.feature === feature);
  }

  /** The head feature name, or undefined for an empty queue. */
  headFeature(): string | undefined {
    return this.entries[0]?.feature;
  }

  view(): QueueView {
    return {
      size: this.entries.length,
      head: this.entries[0] ? this.toView(this.entries[0], 0) : null,
      entries: this.entries.map((e, i) => this.toView(e, i)),
    };
  }

  /** One feature's queue view, or undefined when it isn't queued — for merging
   *  into a FeatureView so feature_list/feature_status show position + head state. */
  viewFor(feature: string): QueueEntryView | undefined {
    const i = this.entries.findIndex((e) => e.feature === feature);
    return i === -1 ? undefined : this.toView(this.entries[i]!, i);
  }

  private toView(entry: QueueEntry, index: number): QueueEntryView {
    const view: QueueEntryView = {
      feature: entry.feature,
      position: index + 1,
      isHead: index === 0,
      status: entry.status,
    };
    if (entry.status === "ready" && entry.prepared?.kind === "green") {
      view.commitsReady = entry.prepared.commits.length;
    }
    if (entry.blockedReason) view.blockedReason = entry.blockedReason;
    if (entry.blockedKind) view.blockedKind = entry.blockedKind;
    if (entry.resolveAttempts) view.resolveAttempts = entry.resolveAttempts;
    return view;
  }

  /**
   * The head's full detail for the panel's inline body: what a ready head would
   * land (commits + diff + the build+test that passed) or why a blocked one
   * can't. This is the whole substance behind the panel's `[m]`: the captain
   * reads exactly what the merge covers, in the same place the key lives.
   * Returns null when the head is neither ready nor blocked (empty queue, or a
   * head still processing / being resolved — those need no body beyond the list
   * row's state chip).
   */
  headDetail(): QueueHeadDetail | null {
    const head = this.entries[0];
    if (!head) return null;
    const target = this.targetBranch;
    const p = head.prepared;
    if (head.status === "ready" && p?.kind === "green") {
      return {
        kind: "ready",
        feature: head.feature,
        target,
        commits: p.commits,
        diff: p.diff,
        ...(p.buildTest ? { buildTest: p.buildTest } : {}),
      };
    }
    if (head.status === "blocked") {
      const detail: QueueHeadDetail = {
        kind: "blocked",
        feature: head.feature,
        target,
        reason: head.blockedReason ?? "not mergeable",
        ...(head.blockedKind ? { blockedKind: head.blockedKind } : {}),
        resolveAttempts: head.resolveAttempts ?? 0,
        maxResolveAttempts: MAX_RESOLVE_ATTEMPTS,
      };
      if (p?.kind === "conflict") {
        detail.conflictFiles = p.conflictFiles;
        detail.detail = p.detail;
      } else if (p?.kind === "failed") {
        detail.exitCode = p.exitCode;
        detail.output = p.output;
        if (p.buildTest) detail.buildTest = p.buildTest;
      }
      return detail;
    }
    return null;
  }

  /**
   * Add a feature to the back of the queue and, when it is (or becomes) the head,
   * process it. Idempotent: an already-queued feature keeps its position. There
   * is NO confirm gate here (D-20260723-23) — enqueue is the "mark done" verb; the
   * only gate in the whole flow is the merge keystroke on the head.
   *
   * Re-enqueuing the head is also the RETRY lever for a blocked head: if the
   * enqueued feature is the head and not already green, it is (re)processed, so a
   * captain who has resolved a conflict or fixed a red build can re-run the head
   * without a dedicated tool. A head already "ready" is left as-is (no wasted
   * build+test).
   */
  async enqueue(feature: string): Promise<EnqueueResult> {
    const alreadyQueued = this.has(feature);
    if (!alreadyQueued) this.entries.push({ feature, status: "queued" });

    const head = this.entries[0]!;
    if (head.feature === feature && head.status !== "ready") {
      await this.runProcessHead();
    }

    const idx = this.entries.findIndex((e) => e.feature === feature);
    return {
      feature,
      alreadyQueued,
      entry: this.toView(this.entries[idx]!, idx),
      head: this.entries[0] ? this.toView(this.entries[0], 0) : null,
      queue: this.view(),
      summary: this.summarize(feature, alreadyQueued),
    };
  }

  /**
   * Process the head: rebase it onto the current dev tip and run the combined
   * build+test, via the EXISTING prepareLanding. Green (with commits) -> ready;
   * a rebase conflict, a red build+test, or any prepare precondition failure ->
   * blocked. This is the only place the queue runs git, and it only ever touches
   * the head. Callable directly to retry a blocked head after a manual fix.
   */
  async processHead(): Promise<ProcessHeadResult> {
    const head = await this.runProcessHead();
    return {
      processed: Boolean(head),
      head: head ? this.toView(this.entries[0]!, 0) : null,
      queue: this.view(),
      summary: head
        ? this.summarize(head.feature, true)
        : "the merge queue is empty; nothing to process.",
    };
  }

  /** The core head-processing transition. Returns the head entry (still the head
   *  afterwards), or undefined for an empty queue. Never throws: a prepare
   *  precondition failure becomes a blocked head, not an exception. */
  private async runProcessHead(): Promise<QueueEntry | undefined> {
    const head = this.entries[0];
    if (!head) return undefined;
    // Already green and waiting for the merge keystroke: nothing to redo.
    if (head.status === "ready") return head;
    // A live crew agent owns the worktree; we cannot rebase under it. Hold the
    // head — a later enqueue/processHead (once the crew is done) advances it. If
    // the busy agent is the resolver we dispatched, keep the head "resolving" so
    // the queue/panel still reflect that; otherwise hold it plain "queued".
    if (this.host.isBusy(head.feature)) {
      if (head.status !== "resolving") {
        head.status = "queued";
        delete head.prepared;
        delete head.blockedReason;
        delete head.blockedKind;
      }
      return head;
    }

    head.status = "head-processing";
    delete head.prepared;
    delete head.blockedReason;
    delete head.blockedKind;

    let result: PrepareResult;
    try {
      result = await this.deps.prepare(this.landingOptions(), head.feature);
    } catch (e) {
      // prepareLanding throws on a lifecycle problem (no branch/worktree, a
      // dirty or detached worktree). That is not mergeable either — surface it
      // as blocked rather than letting it crash the enqueue/merge tool. This is
      // NOT a conflict/red flavour a fresh agent can fix, so no blockedKind.
      head.status = "blocked";
      head.blockedReason = e instanceof Error ? e.message : String(e);
      return head;
    }

    head.prepared = result;
    switch (result.kind) {
      case "green":
        if (result.commits.length === 0) {
          head.status = "blocked";
          head.blockedReason = "no commits beyond dev; nothing to land (abandon it instead)";
        } else {
          head.status = "ready";
        }
        break;
      case "conflict":
        head.status = "blocked";
        head.blockedKind = "conflict";
        head.blockedReason = `rebase conflict in ${
          result.conflictFiles.join(", ") || "the worktree"
        }`;
        break;
      case "failed":
        head.status = "blocked";
        head.blockedKind = "failed";
        head.blockedReason = `build+test failed (exit ${result.exitCode})`;
        break;
    }
    return head;
  }

  /**
   * Whether the head is a blocked feature a fresh resolver agent can be sent at:
   * blocked by a rebase conflict or a red build+test (not a lifecycle problem,
   * which has no blockedKind), and not already past the retry bound. This is the
   * gate the resolve tool checks before arming a dispatch, so a doomed resolve is
   * refused up front rather than after a wasted confirm.
   */
  canResolveHead(): { ok: true; feature: string; kind: BlockedKind; attempt: number } | { ok: false; reason: string } {
    const head = this.entries[0];
    if (!head) return { ok: false, reason: "the merge queue is empty; nothing to resolve." };
    if (head.status === "resolving") {
      return { ok: false, reason: `head '${head.feature}' already has a resolver agent working; let it finish.` };
    }
    if (head.status !== "blocked" || !head.blockedKind) {
      return {
        ok: false,
        reason: `head '${head.feature}' is ${head.status}, not blocked by a conflict or a red build+test; nothing for a resolver to do.`,
      };
    }
    const spent = head.resolveAttempts ?? 0;
    if (spent >= MAX_RESOLVE_ATTEMPTS) {
      return {
        ok: false,
        reason: `head '${head.feature}' has already had ${spent} resolver attempt(s) (limit ${MAX_RESOLVE_ATTEMPTS}); it stays blocked for you to resolve by hand or abandon.`,
      };
    }
    return { ok: true, feature: head.feature, kind: head.blockedKind, attempt: spent + 1 };
  }

  /**
   * Mark the head "resolving" and count the attempt, once the captain has
   * confirmed a fresh resolver dispatch into the feature's worktree. The engine
   * does NOT dispatch (that is the confirm-gated session path); it only records
   * that a resolver is now in flight so the queue/panel show it and re-processing
   * is deferred until the agent finishes. Returns the head view, or a refusal if
   * the head is no longer resolvable (it changed under us).
   */
  beginResolve(): { started: true; head: QueueEntryView } | { started: false; reason: string } {
    const gate = this.canResolveHead();
    if (!gate.ok) return { started: false, reason: gate.reason };
    const head = this.entries[0]!;
    head.status = "resolving";
    head.resolveAttempts = gate.attempt;
    // Keep blockedReason/blockedKind as the record of WHAT is being resolved; the
    // "resolving" status is what callers branch on.
    return { started: true, head: this.toView(head, 0) };
  }

  /**
   * Re-process the head after a resolver agent finished (its worktree is now on a
   * rebased, hopefully-green state). Green -> ready; still conflicted/red ->
   * blocked again (with its attempt count preserved, so the retry bound holds).
   * A no-op if the head isn't the feature the resolver ran on, or isn't resolving
   * (e.g. it was abandoned or already advanced while the agent ran).
   */
  async onResolveDone(feature: string): Promise<ProcessHeadResult> {
    const head = this.entries[0];
    if (!head || head.feature !== feature || head.status !== "resolving") {
      return {
        processed: false,
        head: head ? this.toView(head, 0) : null,
        queue: this.view(),
        summary: `resolver for '${feature}' finished but it is no longer the resolving head; nothing to re-process.`,
      };
    }
    // Drop the resolving marker so runProcessHead actually re-runs (it skips a
    // "ready" head, and would treat "resolving" as a live-agent hold otherwise).
    // resolveAttempts is preserved on the entry, so the bound still applies.
    head.status = "queued";
    const processed = await this.runProcessHead();
    const h = this.entries[0]!;
    return {
      processed: Boolean(processed),
      head: this.toView(h, 0),
      queue: this.view(),
      summary: this.summarize(h.feature, true),
    };
  }

  /**
   * MERGE THE READY HEAD, then advance. This is the panel's [m] (D-20260724-12)
   * and the whole happy path: no gate is opened, no promise waits on a human,
   * nothing is armed. The authorisation already happened — the keystroke that
   * called this — so the function's job is purely to do the merge and leave the
   * queue in an honest state.
   *
   * Only a `ready` (green) head merges; anything else is refused with the reason
   * and NOTHING is written. On a merge, executeLanding lands the head on dev
   * (a --no-ff merge commit, per-job commits kept) and tears down the worktree +
   * branch; the entry is dropped, the owner forgets it, and the NEW head is
   * immediately processed against the just-moved dev tip — so by the time this
   * resolves, the next head's `[m]` is either already live (green) or the head is
   * blocked and the caller can escalate. On an executeLanding refusal the green
   * is invalidated and the head re-processed, so what the panel shows next is the
   * truth rather than the stale green that just failed.
   *
   * The merge reuses the head's ALREADY-computed green (from processHead) rather
   * than re-running the build+test: executeLanding pins to that exact featureSha
   * and CAS-writes dev, so a branch or a dev that moved since fails loudly.
   */
  async mergeReadyHead(): Promise<MergeHeadResult> {
    const head = this.entries[0];
    if (!head) {
      return {
        merged: false,
        outcome: "empty",
        feature: "",
        summary: "the merge queue is empty; nothing to merge.",
        head: null,
        queue: this.view(),
      };
    }
    if (this.host.isBusy(head.feature)) {
      return {
        merged: false,
        outcome: "busy",
        feature: head.feature,
        summary: `head '${head.feature}' still has a crew agent working; let it finish before merging.`,
        head: this.toView(head, 0),
        queue: this.view(),
      };
    }
    if (head.status !== "ready" || head.prepared?.kind !== "green") {
      // Not green. (Re)process so the refusal reflects current truth, then report.
      await this.runProcessHead();
      const h = this.entries[0]!;
      return {
        merged: false,
        outcome: "not-ready",
        feature: head.feature,
        summary: `head '${head.feature}' is not ready to merge (${h.status}${
          h.blockedReason ? `: ${h.blockedReason}` : ""
        }).`,
        head: this.toView(h, 0),
        queue: this.view(),
      };
    }

    const target = this.targetBranch;
    const green = head.prepared;
    let mergeSha: string;
    try {
      const landed = await this.deps.execute(this.landingOptions(), head.feature, {
        featureSha: green.featureSha,
      });
      mergeSha = landed.mergeSha;
    } catch (e) {
      // executeLanding refused (a stale green, a moved branch, dev checked out
      // somewhere). Nothing was written. The green is no longer trustworthy:
      // invalidate it so the head is genuinely re-processed (runProcessHead
      // skips a still-"ready" head) and the panel shows current truth.
      const error = e instanceof Error ? e.message : String(e);
      head.status = "queued";
      delete head.prepared;
      await this.runProcessHead();
      const h = this.entries[0]!;
      return {
        merged: false,
        outcome: "failed",
        feature: head.feature,
        summary: `merging ${head.feature} was refused: ${error}; the head was re-processed (${h.status}).`,
        error,
        head: this.toView(h, 0),
        queue: this.view(),
      };
    }

    // The worktree/branch are gone (executeLanding tore them down). Drop the
    // record and advance: the next feature becomes head and is processed against
    // the dev tip this merge just moved, so its [m] is live (or its block is
    // visible) the moment this returns.
    this.host.forget(head.feature);
    this.entries.shift();
    const next = await this.runProcessHead();
    return {
      merged: true,
      outcome: "merged",
      feature: head.feature,
      summary: `merged ${head.feature}: ${mergeSha.slice(0, 7)} on ${target}${
        next ? `; next head '${next.feature}' is ${next.status}` : "; the queue is now empty"
      }`,
      mergeSha,
      target,
      head: this.entries[0] ? this.toView(this.entries[0], 0) : null,
      queue: this.view(),
    };
  }

  /**
   * Remove a feature from the queue WITHOUT merging it (the captain dropped or
   * abandoned it). If it was the head, the queue advances and the new head is
   * processed. Does NOT itself tear anything down — the caller (feature_abandon)
   * owns the worktree teardown; this only maintains queue order. No-op (removed:
   * false) for a feature that wasn't queued.
   */
  async remove(feature: string): Promise<RemoveResult> {
    const idx = this.entries.findIndex((e) => e.feature === feature);
    if (idx === -1) {
      return {
        removed: false,
        wasHead: false,
        head: this.entries[0] ? this.toView(this.entries[0], 0) : null,
        queue: this.view(),
      };
    }
    const wasHead = idx === 0;
    this.entries.splice(idx, 1);
    if (wasHead) await this.runProcessHead();
    return {
      removed: true,
      wasHead,
      head: this.entries[0] ? this.toView(this.entries[0], 0) : null,
      queue: this.view(),
    };
  }

  /** A one-line human account of a feature's current place/state in the queue. */
  private summarize(feature: string, alreadyQueued: boolean): string {
    const i = this.entries.findIndex((e) => e.feature === feature);
    if (i === -1) return `${feature} is not in the merge queue`;
    const e = this.entries[i]!;
    const where = alreadyQueued ? "already queued" : "queued";
    if (i !== 0) return `${feature} ${where} at position ${i + 1}; head is '${this.entries[0]!.feature}'`;
    switch (e.status) {
      case "ready":
        return `head '${feature}' is ready to merge (${e.prepared?.kind === "green" ? e.prepared.commits.length : 0} commit(s)); the captain lands it with [m] in the Ctrl-O queue tab — you are not in that loop, do not wait on it`;
      case "blocked": {
        const kind = e.blockedKind === "conflict" ? "rebase conflict" : e.blockedKind === "failed" ? "red build+test" : "not mergeable";
        const spent = e.resolveAttempts ?? 0;
        const resolveHint =
          e.blockedKind && spent < MAX_RESOLVE_ATTEMPTS
            ? `; dispatch a fresh resolver with feature_resolve_head (attempt ${spent + 1}/${MAX_RESOLVE_ATTEMPTS}) or fix it by hand`
            : e.blockedKind
              ? `; the ${spent}-attempt resolver limit is spent — resolve by hand or abandon`
              : "";
        return `head '${feature}' is BLOCKED (${kind}): ${e.blockedReason ?? "not mergeable"}; it holds the queue${resolveHint}`;
      }
      case "resolving":
        return `head '${feature}' is being resolved by a fresh crew agent in its worktree (attempt ${e.resolveAttempts ?? 1}/${MAX_RESOLVE_ATTEMPTS}); it re-processes when the agent finishes`;
      case "queued":
        return this.host.isBusy(feature)
          ? `head '${feature}' is queued but a crew agent is still working it; it will process once free`
          : `head '${feature}' is queued for processing`;
      case "head-processing":
        return `head '${feature}' is processing`;
    }
  }
}
