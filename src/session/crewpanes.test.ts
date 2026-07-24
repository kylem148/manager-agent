import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CrewPaneLayout,
  DEFAULT_PANE_LAYOUT,
  crewPaneTitle,
  type PlacementDecision,
} from "./crewpanes.js";

/**
 * Tests for the crew-pane placement planner. This is the Ghostty/macOS geometry
 * layer of crew dispatch, and it is pure: no AppleScript, no processes, no disk.
 * So these tests exercise the state machine directly — the same decisions the
 * transport would execute — against the acceptance criteria in the dispatch
 * order: anchor takeover, alternating splits of the newest pane, cap + reuse,
 * queue-when-full, configurable direction/cap, and restart survival.
 */

const ANCHOR = { id: "pane-anchor", title: crewPaneTitle("my-saas") };

/** Drive one full dispatch: plan → transport learns a pane id → commit. The
 *  callback yields the pane id the transport "creates" for split/takeover. */
function dispatch(layout: CrewPaneLayout, newId: (d: PlacementDecision) => string): PlacementDecision {
  const decision = layout.plan();
  if (decision.kind === "queue") {
    layout.abort(); // nothing placed; a queued dispatch commits nothing
    return decision;
  }
  layout.commit(newId(decision));
  return decision;
}

/** A transport stub: the anchor keeps its id; each split returns a fresh id. */
function splitTransport(): (d: PlacementDecision) => string {
  let n = 0;
  return (d) => {
    if (d.kind === "takeover" || d.kind === "reuse") return d.paneId;
    return `pane-${++n}`; // a split's new pane id
  };
}

test("first dispatch takes over the anchor, no split", () => {
  const layout = new CrewPaneLayout(ANCHOR);
  const decision = layout.plan();
  assert.deepEqual(decision, { kind: "takeover", paneId: "pane-anchor" });
  layout.commit("pane-anchor");
  assert.equal(layout.paneCount, 1);
  assert.equal(layout.runningCount, 1);
});

test("jobs 2-4 split the newest pane, alternating beside/below by default", () => {
  const layout = new CrewPaneLayout(ANCHOR); // default seq ["right","down"], cap 4
  const tx = splitTransport();

  dispatch(layout, tx); // job 1: takeover anchor

  const j2 = dispatch(layout, tx);
  assert.deepEqual(j2, { kind: "split", target: "pane-anchor", direction: "right" });

  const j3 = dispatch(layout, tx);
  // Splits the NEWEST pane (the one job 2 created), next direction in sequence.
  assert.deepEqual(j3, { kind: "split", target: "pane-1", direction: "down" });

  const j4 = dispatch(layout, tx);
  assert.deepEqual(j4, { kind: "split", target: "pane-2", direction: "right" });

  assert.equal(layout.paneCount, 4);
});

test("job 5 reuses the oldest finished pane when one is free", () => {
  const layout = new CrewPaneLayout(ANCHOR);
  const tx = splitTransport();
  for (let i = 0; i < 4; i++) dispatch(layout, tx); // fill to cap: anchor, pane-1, pane-2, pane-3

  // Finish two, oldest-first order should pick the anchor (seq 0).
  layout.finish("pane-2");
  layout.finish("pane-anchor");

  const j5 = dispatch(layout, tx);
  assert.deepEqual(j5, { kind: "reuse", paneId: "pane-anchor" });
  assert.equal(layout.paneCount, 4, "reuse must not create a 5th pane");
  assert.equal(layout.runningCount, 3, "anchor flips back to running");
});

test("job 5 queues when at the cap with nothing finished", () => {
  const layout = new CrewPaneLayout(ANCHOR);
  const tx = splitTransport();
  for (let i = 0; i < 4; i++) dispatch(layout, tx);

  const j5 = dispatch(layout, tx);
  assert.deepEqual(j5, { kind: "queue" });
  assert.equal(layout.paneCount, 4, "a queued dispatch places nothing");

  // Once a pane frees, the next dispatch reuses it rather than queueing.
  layout.finish("pane-1");
  const retry = dispatch(layout, tx);
  assert.deepEqual(retry, { kind: "reuse", paneId: "pane-1" });
});

test("a queued dispatch leaves no pending state, so the next plan() works", () => {
  const layout = new CrewPaneLayout(ANCHOR);
  const tx = splitTransport();
  for (let i = 0; i < 4; i++) dispatch(layout, tx);

  assert.deepEqual(layout.plan(), { kind: "queue" });
  // No abort() needed after a queue; planning again must not throw.
  assert.deepEqual(layout.plan(), { kind: "queue" });
});

test("direction sequence and cap are configurable", () => {
  const layout = new CrewPaneLayout(ANCHOR, { directionSequence: ["down", "right", "left"], cap: 3 });
  const tx = splitTransport();

  dispatch(layout, tx); // takeover
  assert.deepEqual(dispatch(layout, tx), { kind: "split", target: "pane-anchor", direction: "down" });
  assert.deepEqual(dispatch(layout, tx), { kind: "split", target: "pane-1", direction: "right" });

  // cap is 3, so the 4th dispatch is past the cap already.
  assert.equal(layout.paneCount, 3);
  assert.deepEqual(layout.plan(), { kind: "queue" });
});

test("bad config falls back to defaults instead of crashing", () => {
  const layout = new CrewPaneLayout(ANCHOR, { directionSequence: [], cap: 0 });
  assert.deepEqual(layout.resolvedConfig, DEFAULT_PANE_LAYOUT);
});

test("splitCount indexes splits, not dispatches, so reuse doesn't skip directions", () => {
  // Regression guard: a reuse must not advance the direction sequence, or the
  // next real split would land in the wrong direction.
  const layout = new CrewPaneLayout(ANCHOR, { directionSequence: ["right", "down"], cap: 2 });
  const tx = splitTransport();

  dispatch(layout, tx); // takeover anchor
  assert.deepEqual(dispatch(layout, tx), { kind: "split", target: "pane-anchor", direction: "right" });

  // At cap (2). Finish and reuse — this is not a split.
  layout.finish("pane-1");
  assert.deepEqual(dispatch(layout, tx), { kind: "reuse", paneId: "pane-1" });

  // Free a slot so a real split can happen again; it should be the SECOND
  // direction ("down"), proving reuse didn't consume a sequence step.
  const wide = CrewPaneLayout.fromState(layout.toState(), { directionSequence: ["right", "down"], cap: 3 });
  wide.finish("pane-anchor");
  // paneCount is 2 < cap 3 now, so this splits the newest pane.
  const d = wide.plan();
  assert.deepEqual(d, { kind: "split", target: "pane-1", direction: "down" });
});

test("finish is tolerant of unknown and duplicate ids", () => {
  const layout = new CrewPaneLayout(ANCHOR);
  const tx = splitTransport();
  dispatch(layout, tx);
  assert.equal(layout.finish("nope"), false, "unknown id is a no-op");
  assert.equal(layout.finish("pane-anchor"), true);
  assert.equal(layout.finish("pane-anchor"), false, "already-finished is a no-op");
});

test("plan() twice without resolving throws (dispatch is sequential)", () => {
  const layout = new CrewPaneLayout(ANCHOR);
  layout.plan();
  assert.throws(() => layout.plan(), /already pending/);
});

test("abort discards the pending decision so the next plan() succeeds", () => {
  const layout = new CrewPaneLayout(ANCHOR);
  const first = layout.plan();
  assert.equal(first.kind, "takeover");
  layout.abort();
  // Aborting the takeover means no pane was created; planning again re-offers it.
  assert.deepEqual(layout.plan(), { kind: "takeover", paneId: "pane-anchor" });
  assert.equal(layout.paneCount, 0);
});

test("state round-trips across a restart", () => {
  const layout = new CrewPaneLayout(ANCHOR, { directionSequence: ["right", "down"], cap: 4 });
  const tx = splitTransport();
  dispatch(layout, tx); // takeover
  dispatch(layout, tx); // split → pane-1
  layout.finish("pane-anchor");

  const restored = CrewPaneLayout.fromState(layout.toState(), { directionSequence: ["right", "down"], cap: 4 });
  assert.equal(restored.paneCount, 2);
  assert.equal(restored.runningCount, 1);
  // The next split should continue the sequence (2nd split → "down") and target
  // the newest pane, exactly as if there had been no restart.
  const d = restored.plan();
  assert.deepEqual(d, { kind: "split", target: "pane-1", direction: "down" });
});

test("crewPaneTitle namespaces by instance for discovery", () => {
  assert.equal(crewPaneTitle("my-saas"), "co-crew:my-saas");
  assert.notEqual(crewPaneTitle("a"), crewPaneTitle("b"));
});

// --- link durability: pruning closed panes ----------------------------------
//
// The captain can close a finished worker pane at any time; its id then goes
// stale in the tracked list. These exercise the pure selection logic that keeps
// the link alive across that — pruning a dead id, picking the newest LIVING pane
// as the split origin, and falling back to the anchor when every child is gone —
// with no Ghostty involved (the registry does the real liveness probing).

test("prune drops a tracked pane and is tolerant of unknown ids", () => {
  const layout = new CrewPaneLayout(ANCHOR);
  const tx = splitTransport();
  dispatch(layout, tx); // takeover anchor
  dispatch(layout, tx); // split → pane-1
  assert.deepEqual(layout.trackedPaneIds, ["pane-anchor", "pane-1"]);

  assert.equal(layout.prune("nope"), false, "an untracked id is a no-op");
  assert.equal(layout.prune("pane-1"), true, "a tracked id is removed");
  assert.equal(layout.prune("pane-1"), false, "pruning again is a no-op");
  assert.deepEqual(layout.trackedPaneIds, ["pane-anchor"]);
  assert.equal(layout.paneCount, 1);
});

test("after the newest pane is closed, the next split targets the newest LIVING pane (fibonacci preserved)", () => {
  const layout = new CrewPaneLayout(ANCHOR); // seq ["right","down"], cap 4
  const tx = splitTransport();
  dispatch(layout, tx); // takeover anchor
  dispatch(layout, tx); // split anchor → pane-1 (dir right)
  dispatch(layout, tx); // split pane-1 → pane-2 (dir down)
  assert.deepEqual(layout.trackedPaneIds, ["pane-anchor", "pane-1", "pane-2"]);

  // The captain closes the newest worker pane. The registry would prune it:
  layout.prune("pane-2");

  // The next dispatch splits the newest LIVING pane — pane-1 — not the dead one.
  const d = layout.plan();
  assert.deepEqual(d, { kind: "split", target: "pane-1", direction: "right" });
});

test("when every worker child is closed, the next split falls back to the anchor", () => {
  const layout = new CrewPaneLayout(ANCHOR, { directionSequence: ["right", "down"], cap: 4 });
  const tx = splitTransport();
  dispatch(layout, tx); // takeover anchor (seq 0)
  dispatch(layout, tx); // split → pane-1 (seq 1, splitCount 1)
  dispatch(layout, tx); // split → pane-2 (seq 2, splitCount 2)

  // The captain closes EVERY tracked pane, the anchor's own included.
  layout.prune("pane-2");
  layout.prune("pane-1");
  layout.prune("pane-anchor");
  assert.deepEqual(layout.trackedPaneIds, [], "the worker box is empty");

  // The link is not dead: the next worker grows by SPLITTING the persisted
  // anchor (the spiral's root), continuing the direction sequence (2 splits so
  // far → index 2 % 2 → "right").
  const d = layout.plan();
  assert.deepEqual(d, { kind: "split", target: "pane-anchor", direction: "right" });
});

test("splitting from the anchor fallback registers a fresh child the next split grows from", () => {
  const layout = new CrewPaneLayout(ANCHOR, { directionSequence: ["right", "down"], cap: 4 });
  const tx = splitTransport();
  dispatch(layout, tx); // takeover anchor
  dispatch(layout, tx); // split → pane-1
  layout.prune("pane-1");
  layout.prune("pane-anchor"); // worker box empty

  // Fallback: split the anchor (2nd direction, "down"), transport returns a
  // fresh id.
  const d1 = layout.plan();
  assert.deepEqual(d1, { kind: "split", target: "pane-anchor", direction: "down" });
  layout.commit("pane-99");
  assert.deepEqual(layout.trackedPaneIds, ["pane-99"], "the regrown child is tracked");

  // The next split grows from that regrown child, not the anchor — the spiral
  // continues from where it left off (3rd split → index 0 → "right").
  const d2 = layout.plan();
  assert.deepEqual(d2, { kind: "split", target: "pane-99", direction: "right" });
});

test("pruning does not disturb the direction sequence", () => {
  // A closed pane must not skip or repeat a split direction, or the spiral bends.
  const layout = new CrewPaneLayout(ANCHOR, { directionSequence: ["right", "down"], cap: 4 });
  const tx = splitTransport();
  dispatch(layout, tx); // takeover
  dispatch(layout, tx); // split → pane-1 (dir right, splitCount 1)
  layout.prune("pane-1"); // captain closes it before the next dispatch

  // panes = [anchor]; next split targets the anchor and uses the SECOND
  // direction ("down"), proving prune left splitCount alone.
  const d = layout.plan();
  assert.deepEqual(d, { kind: "split", target: "pane-anchor", direction: "down" });
});
