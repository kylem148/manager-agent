/**
 * Crew-pane placement (the Ghostty/macOS geometry layer of crew dispatch).
 *
 * This module answers exactly one question, deterministically: when a crew job
 * is dispatched, WHERE does its pane go? It is pure placement logic — no
 * AppleScript, no child processes, no disk. The transport that actually runs
 * `osascript ... split` and reads back a pane id lives elsewhere (and is not
 * built yet); this planner tells it what to do and remembers what it did.
 *
 * The rules, from the dispatch order:
 *   1. A one-time ANCHOR is designated (the crew region, top-left in the
 *      captain's layout). It is tagged with a recognizable title plus its pane
 *      id so it can be found on every dispatch and rebuilt across restarts.
 *   2. The FIRST dispatch takes over the anchor pane directly — it runs the crew
 *      there, with no split.
 *   3. Each SUBSEQUENT dispatch splits the most-recently-created crew pane,
 *      alternating direction by a configurable sequence (default beside/below,
 *      i.e. Ghostty `right` then `down`). The pane id the split returns is
 *      tracked so the next split targets it in turn — the region subdivides in
 *      place and never touches the co-manager or terminal panes.
 *   4. Crew panes are capped (default 4, configurable). At the cap we stop
 *      splitting — a further split would be unreadable — and instead reuse the
 *      OLDEST FINISHED crew pane. If none is free, the dispatch QUEUES until one
 *      frees.
 *   5. Direction sequence and cap are config values, injected here with sane
 *      defaults, so placement is retunable without a code change.
 *
 * Off the macOS+Ghostty path, none of this runs: the portable fallback dispatch
 * is a detached background process with no geometry, and it simply never
 * constructs a CrewPaneLayout. Geometry is confined to the platform that has it.
 *
 * Deliberately out of scope here (parts of the wider dispatch order, unbuilt):
 * the confirm interlock, the `osascript` transport, the detached fallback, the
 * job registry / capture-file watcher, and loading the per-instance config that
 * feeds `PaneLayoutConfig`. This planner is designed to slot under all of those:
 * it takes config as data, exposes its state for a registry to persist, and can
 * be rebuilt from that state after a restart.
 */

/** A Ghostty split direction. The new pane appears on this side of the target. */
export type SplitDirection = "right" | "down" | "left" | "up";

const SPLIT_DIRECTIONS: readonly SplitDirection[] = ["right", "down", "left", "up"];

/** Retunable placement config. Sourced per-instance by the (unbuilt) dispatch
 *  registration; here it is just data with defaults, never hardcoded logic. */
export interface PaneLayoutConfig {
  /**
   * Split directions cycled by split index (0-based): the 1st split uses
   * directionSequence[0], the 2nd directionSequence[1], wrapping around. Default
   * ["right", "down"] — beside, then below, alternating — matching the captain's
   * "horz, then down, then horz" layout for a top-left crew region.
   */
  directionSequence: SplitDirection[];
  /**
   * Maximum number of concurrent crew panes. Past this we reuse the oldest
   * finished pane rather than splitting further (splits halve the region each
   * time and become unreadable). Default 4.
   */
  cap: number;
}

export const DEFAULT_PANE_LAYOUT: PaneLayoutConfig = {
  directionSequence: ["right", "down"],
  cap: 4,
};

/**
 * A discoverable title for crew panes. The transport sets this on a pane via
 * AppleScript so it can find "the anchor" / "a crew pane" again on the next
 * dispatch and after a restart, when only titles and ids survive. Kept here so
 * the naming scheme has one owner even though the planner itself works on ids.
 */
export const CREW_PANE_TITLE_PREFIX = "co-crew";

export function crewPaneTitle(instance: string): string {
  return `${CREW_PANE_TITLE_PREFIX}:${instance}`;
}

/** What the planner decides for one dispatch. The transport executes it. */
export type PlacementDecision =
  /** Run the crew in the anchor pane directly (first dispatch, no split). */
  | { kind: "takeover"; paneId: string }
  /** Split `target` in `direction`; the new pane hosts the crew. */
  | { kind: "split"; target: string; direction: SplitDirection }
  /** Reuse an existing finished pane (at the cap); run the crew there. */
  | { kind: "reuse"; paneId: string }
  /** At the cap with no finished pane free: hold the dispatch until one frees. */
  | { kind: "queue" };

type PaneStatus = "running" | "finished";

interface CrewPane {
  id: string;
  /** Monotonic creation order: 0 = anchor, then 1, 2, ... per split. Fixes
   *  "newest" (max) for the next split and "oldest" (min) for reuse. */
  seq: number;
  status: PaneStatus;
}

/** Serializable snapshot, so a registry can persist placement across restarts. */
export interface CrewPaneLayoutState {
  anchorId: string;
  anchorTitle: string;
  panes: CrewPane[];
  /** Count of splits performed; indexes the direction sequence. */
  splitCount: number;
  /** Next creation sequence to assign. */
  nextSeq: number;
}

function normalizeConfig(config?: Partial<PaneLayoutConfig>): PaneLayoutConfig {
  // Tolerate bad config rather than crash a dispatch: the whole point of making
  // these values configurable is that the captain can retune them freely, and a
  // fat-fingered cap of 0 or an empty sequence should degrade to the default,
  // not take the session down.
  const seq = (config?.directionSequence ?? DEFAULT_PANE_LAYOUT.directionSequence).filter((d) =>
    SPLIT_DIRECTIONS.includes(d),
  );
  const directionSequence = seq.length > 0 ? seq : [...DEFAULT_PANE_LAYOUT.directionSequence];
  // A cap below 1 is nonsensical (the first dispatch alone occupies one pane),
  // so a bad value degrades to the default rather than being silently clamped —
  // consistent with how an empty directionSequence falls back to the default
  // sequence above. A valid fractional cap floors.
  const rawCap = config?.cap ?? DEFAULT_PANE_LAYOUT.cap;
  const cap = Number.isFinite(rawCap) && rawCap >= 1 ? Math.floor(rawCap) : DEFAULT_PANE_LAYOUT.cap;
  return { directionSequence, cap };
}

/**
 * Deterministic placement state machine for one instance's crew region.
 *
 * The dispatch flow is strictly sequential (the confirm interlock guarantees one
 * arm→confirm→dispatch at a time), so placement is a transaction:
 *
 *   const decision = layout.plan();      // decide target + direction (a query)
 *   // ...transport acts; for a split it learns the NEW pane id only now...
 *   layout.commit(resultPaneId);         // record the outcome
 *
 * and `abort()` discards a planned-but-not-executed dispatch (the captain
 * cancels at confirm, or the transport fails). `finish(paneId)` marks a pane's
 * job done so it becomes reusable. `finish` is tolerant of unknown ids — a stray
 * or late completion must never crash the session.
 */
export class CrewPaneLayout {
  private readonly config: PaneLayoutConfig;
  private readonly anchorId: string;
  private readonly anchorTitle: string;
  /** Crew panes in creation order. */
  private panes: CrewPane[];
  private splitCount: number;
  private nextSeq: number;
  /** The decision returned by the last plan() and not yet committed/aborted. */
  private pending: PlacementDecision | null = null;

  constructor(anchor: { id: string; title: string }, config?: Partial<PaneLayoutConfig>) {
    this.config = normalizeConfig(config);
    this.anchorId = anchor.id;
    this.anchorTitle = anchor.title;
    this.panes = [];
    this.splitCount = 0;
    this.nextSeq = 0;
  }

  /** Rebuild a planner from persisted state (e.g. after a restart). */
  static fromState(state: CrewPaneLayoutState, config?: Partial<PaneLayoutConfig>): CrewPaneLayout {
    const layout = new CrewPaneLayout(
      { id: state.anchorId, title: state.anchorTitle },
      config,
    );
    // Clone so the caller's snapshot can't be mutated through us.
    layout.panes = state.panes.map((p) => ({ ...p }));
    layout.splitCount = state.splitCount;
    layout.nextSeq = state.nextSeq;
    return layout;
  }

  /** A serializable snapshot for a registry to persist. */
  toState(): CrewPaneLayoutState {
    return {
      anchorId: this.anchorId,
      anchorTitle: this.anchorTitle,
      panes: this.panes.map((p) => ({ ...p })),
      splitCount: this.splitCount,
      nextSeq: this.nextSeq,
    };
  }

  get resolvedConfig(): PaneLayoutConfig {
    return { directionSequence: [...this.config.directionSequence], cap: this.config.cap };
  }

  /** Panes currently running a job. */
  get runningCount(): number {
    return this.panes.filter((p) => p.status === "running").length;
  }

  /** Total crew panes in existence (running + finished). */
  get paneCount(): number {
    return this.panes.length;
  }

  /**
   * Decide placement for the next dispatch, without mutating (a query). The
   * decision is stashed as pending; commit() applies it once the transport knows
   * the resulting pane id, or abort() discards it. Calling plan() twice without
   * resolving the first is a caller bug (dispatch is sequential) and throws.
   */
  plan(): PlacementDecision {
    if (this.pending) {
      throw new Error("plan() called with a dispatch already pending; commit() or abort() it first");
    }
    const decision = this.decide();
    // A queue decision places nothing, so there is nothing to commit later; do
    // not leave it pending, or the next plan() would wrongly throw.
    this.pending = decision.kind === "queue" ? null : decision;
    return decision;
  }

  private decide(): PlacementDecision {
    // First dispatch of all: take over the anchor, no split.
    if (this.panes.length === 0) {
      return { kind: "takeover", paneId: this.anchorId };
    }
    // Below the cap: split the most-recently-created crew pane.
    if (this.panes.length < this.config.cap) {
      const newest = this.panes[this.panes.length - 1]!;
      const direction = this.config.directionSequence[
        this.splitCount % this.config.directionSequence.length
      ]!;
      return { kind: "split", target: newest.id, direction };
    }
    // At the cap: reuse the oldest finished pane, else queue.
    const oldestFinished = this.panes.find((p) => p.status === "finished");
    return oldestFinished ? { kind: "reuse", paneId: oldestFinished.id } : { kind: "queue" };
  }

  /**
   * Record the outcome of the pending dispatch. `resultPaneId` is the anchor id
   * for a takeover, the newly returned pane id for a split, or the reused pane's
   * id for a reuse. A new pane is registered running; a reused pane flips back to
   * running.
   */
  commit(resultPaneId: string): void {
    const pending = this.pending;
    if (!pending) {
      throw new Error("commit() called with no pending dispatch; call plan() first");
    }
    if (pending.kind === "queue") {
      // Defensive: queue is never stashed as pending, so this should be
      // unreachable. Guard anyway so a caller mistake is loud, not silent.
      throw new Error("cannot commit a queued dispatch; it has no pane yet");
    }
    this.pending = null;

    switch (pending.kind) {
      case "reuse": {
        const pane = this.panes.find((p) => p.id === resultPaneId);
        if (!pane) {
          throw new Error(`commit(reuse) for unknown pane ${resultPaneId}`);
        }
        pane.status = "running";
        return;
      }
      case "takeover":
      case "split": {
        // A takeover's pane is the anchor; a split's is a fresh id from the
        // transport. Either way it is a new crew pane. splitCount advances only
        // on an actual split, so the direction sequence tracks splits, not
        // dispatches.
        if (pending.kind === "split") this.splitCount++;
        this.panes.push({ id: resultPaneId, seq: this.nextSeq++, status: "running" });
        return;
      }
    }
  }

  /** Discard a planned-but-not-executed dispatch (cancelled or failed to launch). */
  abort(): void {
    this.pending = null;
  }

  /**
   * Mark the job in a pane as finished, freeing it for reuse. Tolerant of an
   * unknown or already-finished id: a stray or duplicate completion signal must
   * never crash the session. Returns true if it changed a running pane.
   */
  finish(paneId: string): boolean {
    const pane = this.panes.find((p) => p.id === paneId);
    if (!pane || pane.status === "finished") return false;
    pane.status = "finished";
    return true;
  }
}
