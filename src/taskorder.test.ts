import { test } from "node:test";
import assert from "node:assert/strict";
import { taskDisplayOrder } from "./taskorder.js";

/**
 * The one rule for what order the task table is READ in (D-20260729-5), and the
 * reason it is a function in a file of its own rather than three sorts in three
 * painters: the panel, the `task_table` tool and the system prompt's live-state
 * block all call this, so the captain and the co cannot be looking at
 * differently-ordered tables and both call it "the table".
 *
 * What matters here is not that it sorts — it is that it is STABLE inside each
 * group, that it copies nothing it was not asked to, and that it is a pure
 * function of the rows with no clock in it, because the live-state block is
 * assembled once per session and has to stay byte-identical for the prompt cache.
 */

const ROWS = [
  { task: "one", status: "queued" as const },
  { task: "two", status: "building" as const },
  { task: "three", status: "queued" as const },
  { task: "four", status: "building" as const },
];

test("building rows come first, queued rows after", () => {
  assert.deepEqual(
    taskDisplayOrder(ROWS).map((r) => r.task),
    ["two", "four", "one", "three"],
  );
});

test("stored order is kept INSIDE each group, so a deliberate order survives", () => {
  // A stable partition, not a comparator: nothing sorts by text, by length, or
  // by anything else that would scramble rows the captain put in an order.
  const many = [
    { task: "z", status: "queued" as const },
    { task: "a", status: "queued" as const },
    { task: "m", status: "building" as const },
    { task: "b", status: "queued" as const },
    { task: "c", status: "building" as const },
  ];
  assert.deepEqual(
    taskDisplayOrder(many).map((r) => r.task),
    ["m", "c", "z", "a", "b"],
  );
});

test("a table of one status is handed back exactly as it came", () => {
  const queued = ROWS.filter((r) => r.status === "queued");
  assert.deepEqual(taskDisplayOrder(queued), queued);
  const building = ROWS.filter((r) => r.status === "building");
  assert.deepEqual(taskDisplayOrder(building), building);
  assert.deepEqual(taskDisplayOrder([]), []);
});

test("the input array is never reordered: this is a view, not a sort in place", () => {
  const rows = [...ROWS];
  taskDisplayOrder(rows);
  assert.deepEqual(rows, ROWS, "the store's own order is the store's business");
});

test("it is deterministic: the same rows give the same order, every time", () => {
  // The live-state block is assembled once per session and sits in the prompt
  // cache prefix. An order that varied — a clock, a shuffle, a Set iteration —
  // would move bytes underneath it.
  const first = taskDisplayOrder(ROWS).map((r) => r.task);
  for (let n = 0; n < 50; n++) {
    assert.deepEqual(taskDisplayOrder(ROWS).map((r) => r.task), first);
  }
});

test("anything that is not exactly `building` is queued, matching the store's read", () => {
  // A hand-edited file can hold a word from the old free-form vocabulary. The
  // store coerces it to `queued` on read; this must bucket it the same way
  // rather than dropping it out of the painted table entirely.
  const odd = [
    { task: "junk", status: "ready-to-arm" as unknown as "queued" },
    { task: "real", status: "building" as const },
  ];
  assert.deepEqual(
    taskDisplayOrder(odd).map((r) => r.task),
    ["real", "junk"],
    "nothing vanishes, whatever the word says",
  );
});

test("it carries whatever shape a row has, so one function serves both layers", () => {
  // The session's TaskRow and the tui's TaskPanelRow are separate declarations
  // on purpose (the Tui never imports the session layer). Both are structurally
  // { task, status }, and a caller with extra fields keeps them.
  const extra = [
    { task: "a", status: "queued" as const, note: 1 },
    { task: "b", status: "building" as const, note: 2 },
  ];
  assert.deepEqual(taskDisplayOrder(extra), [
    { task: "b", status: "building", note: 2 },
    { task: "a", status: "queued", note: 1 },
  ]);
});
