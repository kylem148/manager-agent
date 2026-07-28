/**
 * Crew-pane placement (the Ghostty/macOS geometry layer of crew dispatch).
 *
 * This module answers exactly one question, deterministically: when a crew job
 * is dispatched, WHERE does its pane go? It is pure placement logic — no
 * AppleScript, no child processes, no disk. The transport that actually runs
 * `osascript ... split` and reads back a pane id lives in transport.ts; this
 * planner tells it what to do and remembers what it did.
 *
 * The rules, from the dispatch order:
 *   1. A one-time ANCHOR is designated (the crew region, top-left in the
 *      captain's layout). It is tagged with a recognizable title plus its pane
 *      id so it can be found on every dispatch and rebuilt across restarts.
 *   2. REUSE COMES FIRST. A dispatch runs in a crew pane that is PROVABLY
 *      unoccupied — no lease of co's own on it and nothing running in it — and
 *      only creates a pane when every pane co owns is busy. The proof is not
 *      this module's job: occupancy is measured against the real panes at
 *      dispatch time (paneoccupancy.ts, driven by registry.ts) and handed in as
 *      the `free` list, so placement stays pure and the freshness of the reading
 *      is guaranteed by the caller. A pane co merely BELIEVES is finished is
 *      never enough — the captain keeps talking to an agent long after it has
 *      filed its report.
 *   3. Nothing free: SPLIT the most-recently-created LIVING crew pane,
 *      alternating direction by a configurable sequence (default beside/below,
 *      i.e. Ghostty `right` then `down`). The pane id the split returns is
 *      tracked so the next split targets it in turn — the region subdivides in
 *      place and never touches the co-manager or terminal panes. A pane the
 *      captain has since closed is dropped from the tracked list (prune), so the
 *      split origin is always the newest pane that still exists; once every
 *      worker child is gone, the split falls back to the persisted anchor, the
 *      spiral's root. This is what lets the session spawn and delete crew panes
 *      indefinitely without ever breaking the transport link.
 *   4. There is NO CAP. Splitting is the fallback for "everything co owns is
 *      busy", and a fallback that can refuse would turn a full screen into a
 *      dispatch failure or a wait — while the error that matters (launching into
 *      a pane the captain is using) costs real work. An extra pane is the cheap
 *      mistake, so it is always available.
 *   5. The direction sequence is a config value, injected here with a sane
 *      default, so placement is retunable without a code change.
 *
 * The one takeover co cannot prove is the FIRST dispatch into a freshly
 * designated anchor: co has never run a job there, so it has no tty for it and
 * nothing to read. That single case keeps the long-standing behaviour (`co pane`
 * promises the first dispatch takes the pane over) and is protected the way it
 * always was — the transport probes for the job actually starting and fails the
 * dispatch if the pane was busy. Every later takeover or reuse, of that anchor
 * or any other pane, requires proof.
 *
 * Off the macOS+Ghostty path none of this runs: dispatch is visible-only, so a
 * session that cannot reach Ghostty never constructs a CrewPaneLayout at all and
 * fails its dispatches cleanly instead. Geometry is confined to the platform
 * that has it.
 *
 * Deliberately out of scope here: the confirm interlock, the `osascript`
 * transport, the job registry / capture-file watcher, the occupancy measurement,
 * and loading the per-instance config that feeds `PaneLayoutConfig`. This planner
 * slots under all of those: it takes config and occupancy as data, exposes its
 * state for a registry to persist, and can be rebuilt from that state.
 */

/** A Ghostty split direction. The new pane appears on this side of the target. */
export type SplitDirection = "right" | "down" | "left" | "up";

const SPLIT_DIRECTIONS: readonly SplitDirection[] = ["right", "down", "left", "up"];

/** Retunable placement config, read per-instance from the dispatch config; here
 *  it is just data with defaults, never hardcoded logic. */
export interface PaneLayoutConfig {
  /**
   * Split directions cycled by split index (0-based): the 1st split uses
   * directionSequence[0], the 2nd directionSequence[1], wrapping around. Default
   * ["right", "down"] — beside, then below, alternating — matching the captain's
   * "horz, then down, then horz" layout for a top-left crew region.
   */
  directionSequence: SplitDirection[];
}

export const DEFAULT_PANE_LAYOUT: PaneLayoutConfig = {
  directionSequence: ["right", "down"],
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

/** What the planner decides for one dispatch. The transport executes it. There
 *  is no "queue" outcome: with no cap, a dispatch that finds nothing free always
 *  has a split available. */
export type PlacementDecision =
  /** Run the crew in an existing pane co owns but does not yet track — the
   *  anchor, or a pane recovered from a previous session. No split. */
  | { kind: "takeover"; paneId: string }
  /** Split `target` in `direction`; the new pane hosts the crew. */
  | { kind: "split"; target: string; direction: SplitDirection }
  /** Reuse a tracked pane that is provably idle; run the crew there. */
  | { kind: "reuse"; paneId: string };

/**
 * The live reading placement is decided against, taken fresh at dispatch time by
 * the registry (see paneoccupancy.ts). Planning is pure; PROVING a pane free is
 * I/O, and the split between the two is deliberate — a planner that cached
 * occupancy would eventually launch into a pane the captain had taken back.
 */
export interface PlacementInput {
  /** Pane ids proven unoccupied right now, best candidate first. Every id here
   *  must be a pane co owns — one it created or the anchor it was given — which
   *  the caller guarantees because the caller is the side that holds the pane
   *  records. The layout re-orders them (its own tracked panes first, oldest
   *  freed first) and refuses any it knows is running a job. */
  free?: readonly string[];
  /** True only when co has NO identity record for the anchor — it has never run
   *  a job there, so the anchor's state cannot be read at all. That is the one
   *  case where the genuine first dispatch still takes the anchor over unproven
   *  (see the module doc). Default false: without proof, split. */
  anchorUnproven?: boolean;
}

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
  return { directionSequence };
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
    return { directionSequence: [...this.config.directionSequence] };
  }

  /** The anchor pane id this layout was built on. The registry compares it to the
   *  freshly-read config at dispatch time to detect a `co pane` change and rebuild
   *  the layout on the new anchor without a session restart. */
  get anchorPaneId(): string {
    return this.anchorId;
  }

  /** Panes currently running a job. */
  get runningCount(): number {
    return this.panes.filter((p) => p.status === "running").length;
  }

  /** Total crew panes in existence (running + finished). */
  get paneCount(): number {
    return this.panes.length;
  }

  /** The ids of every tracked crew pane, oldest first (the anchor if it has been
   *  taken over, then each split). The registry probes these for existence
   *  before planning and prunes any the captain has closed, so placement only
   *  ever targets a pane that still lives. */
  get trackedPaneIds(): string[] {
    return this.panes.map((p) => p.id);
  }

  /**
   * Decide placement for the next dispatch, without mutating (a query). The
   * decision is stashed as pending; commit() applies it once the transport knows
   * the resulting pane id, or abort() discards it. Calling plan() twice without
   * resolving the first is a caller bug (dispatch is sequential) and throws.
   *
   * `input.free` is the caller's FRESH proof of which panes are idle right now;
   * with none supplied nothing is reusable and every dispatch creates a pane,
   * which is the safe default for a caller that cannot measure.
   */
  plan(input: PlacementInput = {}): PlacementDecision {
    if (this.pending) {
      throw new Error("plan() called with a dispatch already pending; commit() or abort() it first");
    }
    const decision = this.decide(input);
    this.pending = decision;
    return decision;
  }

  private decide(input: PlacementInput): PlacementDecision {
    // 1. Reuse before creating. Only panes co owns are eligible: one it tracks,
    //    or the anchor the captain designated. An id we don't recognise is
    //    ignored however free it looks — adopting an arbitrary terminal is how a
    //    dispatch ends up in someone else's window.
    const reusable = this.pickReusable(input.free ?? []);
    if (reusable) {
      // A tracked pane flips back to running (reuse); a pane co owns but has not
      // tracked this session — the anchor, or one recovered from an earlier run —
      // joins the layout as a new member (takeover). The transport treats both
      // identically: one short launch line pasted into an existing pane.
      return this.panes.some((p) => p.id === reusable)
        ? { kind: "reuse", paneId: reusable }
        : { kind: "takeover", paneId: reusable };
    }

    // 2. Nothing free. Create a pane — always possible, never capped.
    if (this.panes.length === 0) {
      // The genuine first dispatch into an anchor co has never run in: no tty on
      // record, so nothing to prove either way. This is the single unproven
      // takeover (see the module doc); it keeps `co pane`'s promise and is
      // guarded by the transport's launch probe.
      if (this.nextSeq === 0 && input.anchorUnproven) {
        return { kind: "takeover", paneId: this.anchorId };
      }
      // An emptied worker box (every pane the captain closed, pruned by the
      // registry's liveness sweep) grows a fresh child by SPLITTING the anchor —
      // as does a busy anchor we may not take over. The spiral's root outlives
      // its children, so "go forever" never stalls just because the panes it once
      // split from are gone. If the anchor pane is itself gone the split fails
      // cleanly and the registry surfaces a re-run-`co pane` message.
      return { kind: "split", target: this.anchorId, direction: this.nextDirection() };
    }
    // Split the most-recently-created LIVING crew pane. Dead panes are pruned
    // before we plan (registry liveness sweep) and on a failed split (reactive
    // retry), so the newest tracked pane is the newest living one — the
    // fibonacci origin. Unchanged by reuse: this is the create path exactly as
    // it always was.
    const newest = this.panes[this.panes.length - 1]!;
    return { kind: "split", target: newest.id, direction: this.nextDirection() };
  }

  /**
   * The best pane to run in among the ones just proven free: tracked panes
   * first, oldest by creation order (the long-standing "reuse the oldest freed
   * pane" rule, which keeps a rotation rather than hammering one pane), then any
   * other pane co owns in the order the caller ranked them.
   *
   * A tracked pane still marked running is never chosen even if the caller
   * offers it. That is belt and braces over the registry's own lease check: the
   * layout knows a job is live in it, and no external reading outranks that.
   */
  private pickReusable(free: readonly string[]): string | null {
    const offered = new Set(free);
    const tracked = this.panes
      .filter((p) => p.status === "finished" && offered.has(p.id))
      .sort((a, b) => a.seq - b.seq);
    if (tracked.length > 0) return tracked[0]!.id;
    // Not tracked this session: the anchor, or a pane recovered from an earlier
    // run. The caller owns "co owns this pane" (it is the side that holds the
    // pane records); the layout only refuses ids it KNOWS are busy.
    const untracked = free.find((id) => !this.panes.some((p) => p.id === id));
    return untracked ?? null;
  }

  /** The split direction for the next split, indexed by how many splits have
   *  happened (not dispatches), so reuse never consumes a sequence step. */
  private nextDirection(): SplitDirection {
    return this.config.directionSequence[this.splitCount % this.config.directionSequence.length]!;
  }

  /**
   * Record the outcome of the pending dispatch. `resultPaneId` is the existing
   * pane's id for a takeover, the newly returned pane id for a split, or the
   * reused pane's id for a reuse. A pane new to the layout is registered running;
   * a tracked one flips back to running.
   */
  commit(resultPaneId: string): void {
    const pending = this.pending;
    if (!pending) {
      throw new Error("commit() called with no pending dispatch; call plan() first");
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
        // A takeover's pane already existed (the anchor, or one recovered from
        // an earlier run); a split's is a fresh id from the transport. Either way
        // it is new to the layout. splitCount advances only on an actual split,
        // so the direction sequence tracks splits, not dispatches.
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

  /**
   * Drop a tracked pane the captain has closed, so it is never chosen as a split
   * origin or reuse target again. Returns true if a pane was removed; tolerant of
   * an unknown id (already pruned, or never tracked). This is the whole of "one
   * dead pane never breaks the link": pruning the newest pane hands the next
   * split to the previous one, and pruning them all hands it to the anchor (see
   * decide) — so any number of closed workers leaves the rest of the layout
   * intact.
   *
   * Deliberately leaves splitCount and nextSeq untouched: the direction sequence
   * keeps advancing so the spiral stays consistent across a closed pane, and
   * creation seqs stay monotonic and unique. `finished` panes are unaffected too
   * — only an actually-gone pane is pruned, never a merely-idle one, which is
   * exactly the pane the next dispatch wants to reuse.
   */
  prune(paneId: string): boolean {
    const before = this.panes.length;
    this.panes = this.panes.filter((p) => p.id !== paneId);
    return this.panes.length < before;
  }
}
