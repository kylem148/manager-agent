import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CrewPaneLayout,
  DEFAULT_PANE_LAYOUT,
  crewPaneTitle,
  type PlacementDecision,
  type PlacementInput,
} from "./crewpanes.js";

/**
 * Tests for the crew-pane placement planner. This is the Ghostty/macOS geometry
 * layer of crew dispatch, and it is pure: no AppleScript, no processes, no disk.
 * So these tests exercise the state machine directly — the same decisions the
 * transport would execute — against the acceptance criteria in the dispatch
 * order: reuse a provably idle pane before creating one, alternating splits of
 * the newest pane when nothing is free, no cap at any count, and restart
 * survival. Whether a pane IS idle is measured elsewhere (paneoccupancy.ts) and
 * arrives here as the `free` list, so it is a plain input in every case below.
 */

const ANCHOR = { id: "pane-anchor", title: crewPaneTitle("my-saas") };

/** Drive one full dispatch: plan → transport learns a pane id → commit. The
 *  callback yields the pane id the transport "creates" for split/takeover. */
function dispatch(
  layout: CrewPaneLayout,
  newId: (d: PlacementDecision) => string,
  input: PlacementInput = {},
): PlacementDecision {
  const decision = layout.plan(input);
  layout.commit(newId(decision));
  return decision;
}

/** A transport stub: an existing pane keeps its id; each split returns a fresh one. */
function splitTransport(): (d: PlacementDecision) => string {
  let n = 0;
  return (d) => {
    if (d.kind === "takeover" || d.kind === "reuse") return d.paneId;
    return `pane-${++n}`; // a split's new pane id
  };
}

/** The very first dispatch into an anchor co has never run a job in: the one
 *  placement made without proof (see the module doc). */
const VIRGIN_ANCHOR: PlacementInput = { anchorUnproven: true };

test("the first dispatch into an anchor co has never used takes it over, no split", () => {
  const layout = new CrewPaneLayout(ANCHOR);
  const decision = layout.plan(VIRGIN_ANCHOR);
  assert.deepEqual(decision, { kind: "takeover", paneId: "pane-anchor" });
  layout.commit("pane-anchor");
  assert.equal(layout.paneCount, 1);
  assert.equal(layout.runningCount, 1);
});

test("an anchor co CAN judge but hasn't proven idle is split from, never taken over", () => {
  // co has an identity on record for the anchor (anchorUnproven false) and the
  // occupancy read did not put it in `free` — something is running in it. The
  // pane must not be typed into; splitting it is harmless.
  const layout = new CrewPaneLayout(ANCHOR);
  assert.deepEqual(layout.plan({ free: [] }), {
    kind: "split",
    target: "pane-anchor",
    direction: "right",
  });
});

test("with nothing free, dispatches split the newest pane, alternating beside/below", () => {
  const layout = new CrewPaneLayout(ANCHOR); // default seq ["right","down"]
  const tx = splitTransport();

  dispatch(layout, tx, VIRGIN_ANCHOR); // job 1: takeover anchor

  const j2 = dispatch(layout, tx);
  assert.deepEqual(j2, { kind: "split", target: "pane-anchor", direction: "right" });

  const j3 = dispatch(layout, tx);
  // Splits the NEWEST pane (the one job 2 created), next direction in sequence.
  assert.deepEqual(j3, { kind: "split", target: "pane-1", direction: "down" });

  const j4 = dispatch(layout, tx);
  assert.deepEqual(j4, { kind: "split", target: "pane-2", direction: "right" });

  assert.equal(layout.paneCount, 4);
});

test("a pane proven free is reused instead of splitting a new one", () => {
  // The bug this whole slice exists for: the captain /exits the agent, the pane
  // returns to a shell prompt, and the next dispatch used to split anyway.
  const layout = new CrewPaneLayout(ANCHOR);
  const tx = splitTransport();
  dispatch(layout, tx, VIRGIN_ANCHOR); // anchor
  dispatch(layout, tx); // split → pane-1
  layout.finish("pane-1");

  const next = dispatch(layout, tx, { free: ["pane-1"] });
  assert.deepEqual(next, { kind: "reuse", paneId: "pane-1" });
  assert.equal(layout.paneCount, 2, "reuse creates no pane");
  assert.equal(layout.runningCount, 2, "the reused pane flips back to running");
});

test("the oldest free pane wins, so reuse rotates rather than hammering one pane", () => {
  const layout = new CrewPaneLayout(ANCHOR);
  const tx = splitTransport();
  for (let i = 0; i < 4; i++) dispatch(layout, tx, i === 0 ? VIRGIN_ANCHOR : {});
  layout.finish("pane-2");
  layout.finish("pane-anchor");

  // Both are offered; the anchor was created first (seq 0), so it goes first.
  const next = dispatch(layout, tx, { free: ["pane-2", "pane-anchor"] });
  assert.deepEqual(next, { kind: "reuse", paneId: "pane-anchor" });
});

test("a pane the layout knows is RUNNING is never reused, however free it looks", () => {
  // Belt and braces over the registry's lease check: the layout has the last
  // word on a pane it just launched into.
  const layout = new CrewPaneLayout(ANCHOR);
  const tx = splitTransport();
  dispatch(layout, tx, VIRGIN_ANCHOR);
  const next = layout.plan({ free: ["pane-anchor"] });
  assert.deepEqual(next, { kind: "split", target: "pane-anchor", direction: "right" });
});

test("a pane co owns but does not track — the anchor, or one from an earlier run — is taken over", () => {
  const layout = new CrewPaneLayout(ANCHOR);
  const tx = splitTransport();
  dispatch(layout, tx, VIRGIN_ANCHOR); // anchor is tracked now
  dispatch(layout, tx); // split → pane-1

  // pane-77 is a pane a previous session created and the store still remembers;
  // the registry proved it idle. It joins the layout rather than being split.
  const next = layout.plan({ free: ["pane-77"] });
  assert.deepEqual(next, { kind: "takeover", paneId: "pane-77" });
  layout.commit("pane-77");
  assert.deepEqual(layout.trackedPaneIds, ["pane-anchor", "pane-1", "pane-77"]);
});

test("there is no cap: with nothing free, panes keep being created at any count", () => {
  // The order is explicit that splitting must never refuse. A false "occupied"
  // costs one extra pane, and that has to stay cheap at 5 panes and at 50.
  const layout = new CrewPaneLayout(ANCHOR);
  const tx = splitTransport();
  const kinds = new Set<string>();
  for (let i = 0; i < 25; i++) {
    kinds.add(dispatch(layout, tx, i === 0 ? VIRGIN_ANCHOR : {}).kind);
  }
  assert.equal(layout.paneCount, 25, "every dispatch placed somewhere");
  assert.deepEqual([...kinds].sort(), ["split", "takeover"], "no queue, no refusal");
});

test("direction sequence is configurable", () => {
  const layout = new CrewPaneLayout(ANCHOR, { directionSequence: ["down", "right", "left"] });
  const tx = splitTransport();

  dispatch(layout, tx, VIRGIN_ANCHOR); // takeover
  assert.deepEqual(dispatch(layout, tx), { kind: "split", target: "pane-anchor", direction: "down" });
  assert.deepEqual(dispatch(layout, tx), { kind: "split", target: "pane-1", direction: "right" });
  assert.deepEqual(dispatch(layout, tx), { kind: "split", target: "pane-2", direction: "left" });
  assert.deepEqual(dispatch(layout, tx), { kind: "split", target: "pane-3", direction: "down" });
});

test("bad config falls back to defaults instead of crashing", () => {
  const layout = new CrewPaneLayout(ANCHOR, { directionSequence: [] });
  assert.deepEqual(layout.resolvedConfig, DEFAULT_PANE_LAYOUT);
});

test("splitCount indexes splits, not dispatches, so reuse doesn't skip directions", () => {
  // Regression guard: a reuse must not advance the direction sequence, or the
  // next real split would land in the wrong direction.
  const layout = new CrewPaneLayout(ANCHOR, { directionSequence: ["right", "down"] });
  const tx = splitTransport();

  dispatch(layout, tx, VIRGIN_ANCHOR); // takeover anchor
  assert.deepEqual(dispatch(layout, tx), { kind: "split", target: "pane-anchor", direction: "right" });

  // Finish and reuse — this is not a split.
  layout.finish("pane-1");
  assert.deepEqual(dispatch(layout, tx, { free: ["pane-1"] }), { kind: "reuse", paneId: "pane-1" });

  // The next real split uses the SECOND direction ("down"), proving reuse didn't
  // consume a sequence step.
  assert.deepEqual(layout.plan(), { kind: "split", target: "pane-1", direction: "down" });
});

test("finish is tolerant of unknown and duplicate ids", () => {
  const layout = new CrewPaneLayout(ANCHOR);
  const tx = splitTransport();
  dispatch(layout, tx, VIRGIN_ANCHOR);
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
  const first = layout.plan(VIRGIN_ANCHOR);
  assert.equal(first.kind, "takeover");
  layout.abort();
  // Aborting the takeover means no pane was created; planning again re-offers it.
  assert.deepEqual(layout.plan(VIRGIN_ANCHOR), { kind: "takeover", paneId: "pane-anchor" });
  assert.equal(layout.paneCount, 0);
});

test("state round-trips across a restart", () => {
  const layout = new CrewPaneLayout(ANCHOR, { directionSequence: ["right", "down"] });
  const tx = splitTransport();
  dispatch(layout, tx, VIRGIN_ANCHOR); // takeover
  dispatch(layout, tx); // split → pane-1
  layout.finish("pane-anchor");

  const restored = CrewPaneLayout.fromState(layout.toState(), { directionSequence: ["right", "down"] });
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
  dispatch(layout, tx, VIRGIN_ANCHOR); // takeover anchor
  dispatch(layout, tx); // split → pane-1
  assert.deepEqual(layout.trackedPaneIds, ["pane-anchor", "pane-1"]);

  assert.equal(layout.prune("nope"), false, "an untracked id is a no-op");
  assert.equal(layout.prune("pane-1"), true, "a tracked id is removed");
  assert.equal(layout.prune("pane-1"), false, "pruning again is a no-op");
  assert.deepEqual(layout.trackedPaneIds, ["pane-anchor"]);
  assert.equal(layout.paneCount, 1);
});

test("after the newest pane is closed, the next split targets the newest LIVING pane (fibonacci preserved)", () => {
  const layout = new CrewPaneLayout(ANCHOR); // seq ["right","down"]
  const tx = splitTransport();
  dispatch(layout, tx, VIRGIN_ANCHOR); // takeover anchor
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
  const layout = new CrewPaneLayout(ANCHOR, { directionSequence: ["right", "down"] });
  const tx = splitTransport();
  dispatch(layout, tx, VIRGIN_ANCHOR); // takeover anchor (seq 0)
  dispatch(layout, tx); // split → pane-1 (seq 1, splitCount 1)
  dispatch(layout, tx); // split → pane-2 (seq 2, splitCount 2)

  // The captain closes EVERY tracked pane, the anchor's own included.
  layout.prune("pane-2");
  layout.prune("pane-1");
  layout.prune("pane-anchor");
  assert.deepEqual(layout.trackedPaneIds, [], "the worker box is empty");

  // The link is not dead: the next worker grows by SPLITTING the persisted
  // anchor (the spiral's root), continuing the direction sequence (2 splits so
  // far → index 2 % 2 → "right"). Note it SPLITS rather than taking the anchor
  // over: nothing proved the anchor idle.
  const d = layout.plan();
  assert.deepEqual(d, { kind: "split", target: "pane-anchor", direction: "right" });
});

test("splitting from the anchor fallback registers a fresh child the next split grows from", () => {
  const layout = new CrewPaneLayout(ANCHOR, { directionSequence: ["right", "down"] });
  const tx = splitTransport();
  dispatch(layout, tx, VIRGIN_ANCHOR); // takeover anchor
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
  const layout = new CrewPaneLayout(ANCHOR, { directionSequence: ["right", "down"] });
  const tx = splitTransport();
  dispatch(layout, tx, VIRGIN_ANCHOR); // takeover
  dispatch(layout, tx); // split → pane-1 (dir right, splitCount 1)
  layout.prune("pane-1"); // captain closes it before the next dispatch

  // panes = [anchor]; next split targets the anchor and uses the SECOND
  // direction ("down"), proving prune left splitCount alone.
  const d = layout.plan();
  assert.deepEqual(d, { kind: "split", target: "pane-anchor", direction: "down" });
});
