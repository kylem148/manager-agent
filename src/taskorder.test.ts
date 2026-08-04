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

test("anything that is not exactly a named stage is queued, matching the store's read", () => {
  // A hand-edited file can hold a word from the old free-form vocabulary. The
  // store coerces it to `queued` on read; this must bucket it the same way
  // rather than dropping it out of the painted table entirely.
  const odd = [
    { task: "junk", status: "ready-to-arm" as unknown as "queued" },
    { task: "real", status: "building" as const },
    { task: "landing", status: "enqueued" as const },
    { task: "checking", status: "testing" as const },
  ];
  assert.deepEqual(
    taskDisplayOrder(odd).map((r) => r.task),
    ["real", "landing", "checking", "junk"],
    "nothing vanishes, whatever the word says",
  );
});

// --- the third status ---------------------------------------------------------
//
// `testing` is a STAGE, not a second way of saying done: work has landed and the
// captain has not checked it yet. It paints between the two that were already
// here, which is the order the work runs in read downward.

const THREE = [
  { task: "waiting", status: "queued" as const },
  { task: "checking", status: "testing" as const },
  { task: "working", status: "building" as const },
];

test("the three groups paint building, then testing, then queued", () => {
  assert.deepEqual(
    taskDisplayOrder(THREE).map((r) => r.task),
    ["working", "checking", "waiting"],
  );
});

test("stored order still holds INSIDE the testing group, like the other two", () => {
  const many = [
    { task: "t-z", status: "testing" as const },
    { task: "q", status: "queued" as const },
    { task: "t-a", status: "testing" as const },
    { task: "b", status: "building" as const },
    { task: "t-m", status: "testing" as const },
  ];
  assert.deepEqual(
    taskDisplayOrder(many).map((r) => r.task),
    ["b", "t-z", "t-a", "t-m", "q"],
    "a stable partition over three buckets, not a sort",
  );
});

test("a table of nothing but testing rows is handed back exactly as it came", () => {
  const testing = THREE.filter((r) => r.status === "testing");
  assert.deepEqual(taskDisplayOrder(testing), testing);
});

test("a table written before `testing` existed orders exactly as it always did", () => {
  // The regression that matters most: adding a bucket in the middle must not
  // move a row in a table that has no rows in it.
  assert.deepEqual(
    taskDisplayOrder(ROWS).map((r) => r.task),
    ["two", "four", "one", "three"],
  );
});

// --- the fourth status --------------------------------------------------------
//
// `enqueued` is the stage between them: built and handed to the merge queue, not
// yet checked. It paints under `building` and above `testing`, which is the
// order the work runs in read downward — most active first.

const FOUR = [
  { task: "waiting", status: "queued" as const },
  { task: "checking", status: "testing" as const },
  { task: "landing", status: "enqueued" as const },
  { task: "working", status: "building" as const },
];

test("the four groups paint building, enqueued, testing, then queued", () => {
  assert.deepEqual(
    taskDisplayOrder(FOUR).map((r) => r.task),
    ["working", "landing", "checking", "waiting"],
  );
});

test("stored order still holds INSIDE the enqueued group, like the other three", () => {
  const many = [
    { task: "e-z", status: "enqueued" as const },
    { task: "q", status: "queued" as const },
    { task: "e-a", status: "enqueued" as const },
    { task: "t", status: "testing" as const },
    { task: "b", status: "building" as const },
    { task: "e-m", status: "enqueued" as const },
  ];
  assert.deepEqual(
    taskDisplayOrder(many).map((r) => r.task),
    ["b", "e-z", "e-a", "e-m", "t", "q"],
    "a stable partition over four buckets, not a sort",
  );
});

test("a table of nothing but enqueued rows is handed back exactly as it came", () => {
  const enqueued = FOUR.filter((r) => r.status === "enqueued");
  assert.deepEqual(taskDisplayOrder(enqueued), enqueued);
});

test("a table written before `enqueued` existed orders exactly as it always did", () => {
  // The same regression the `testing` bucket had to clear: a bucket inserted in
  // the middle must not move a row in a table that has no rows in it.
  assert.deepEqual(
    taskDisplayOrder(THREE).map((r) => r.task),
    ["working", "checking", "waiting"],
  );
  assert.deepEqual(
    taskDisplayOrder(ROWS).map((r) => r.task),
    ["two", "four", "one", "three"],
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
