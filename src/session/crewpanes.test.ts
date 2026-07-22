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
