import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { instancePaths } from "../paths.js";
import {
  TaskError,
  TaskStore,
  TASK_TABLE_CAP,
  TASK_STATUSES,
  coerceTasks,
  type TaskRow,
} from "./taskstore.js";
import { makeExecutor, newSideEffects, toolDefinitions, TASK_COMMANDS } from "./tools.js";
import type { ResearchConfig } from "../config.js";

/**
 * The persisted task table (taskstore.ts), now a TWO-WRITER surface: the captain
 * types rows into it from the panel and the co edits it through `task_table`.
 *
 * That is what these tests are really about. The store used to be rewritten
 * whole on every call, which is safe with one author and is silent data loss
 * with two — so every operation here names ONE row, by its exact text, and the
 * tests that matter most are the ones pinning that it can touch nothing else and
 * that an unclear address FAILS rather than picking a row.
 */

async function tmpPaths(): Promise<{ paths: ReturnType<typeof instancePaths>; cleanup: () => Promise<void> }> {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "co-tasks-")));
  return {
    paths: instancePaths(path.join(root, "home"), "inst"),
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

const ROWS: TaskRow[] = [
  { task: "ctrl-o overhaul", status: "building" },
  { task: "bedrock retry backoff", status: "queued" },
];

/** The code of the TaskError a call throws, or "" when it did not throw. */
async function refusal(op: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await op();
    return { code: "", message: "" };
  } catch (e) {
    assert.ok(e instanceof TaskError, `expected a TaskError, got ${String(e)}`);
    return { code: e.code, message: e.message };
  }
}

test("a table written in one session is read back in the next", async () => {
  const { paths, cleanup } = await tmpPaths();
  try {
    const first = await TaskStore.load(paths);
    assert.deepEqual(first.list(), [], "a missing file is an empty table, not a failure");

    await first.add("ctrl-o overhaul");
    await first.setStatus("ctrl-o overhaul", "building");
    await first.add("bedrock retry backoff");
    assert.deepEqual(first.list(), ROWS);

    // Beside the feature store, under .dispatch/ — never in the user's repo.
    assert.ok(fs.existsSync(paths.taskTable), "the table is on disk");
    assert.equal(path.basename(paths.taskTable), "tasks.json");
    assert.equal(path.dirname(paths.taskTable), path.dirname(paths.featureStore));

    const next = await TaskStore.load(paths);
    assert.deepEqual(next.list(), ROWS, "and it survives the restart");
  } finally {
    await cleanup();
  }
});

test("add appends as queued, at the end, and never as anything else", async () => {
  const store = TaskStore.ephemeral();
  const row = await store.add("  wire   the   panel  ");
  // Whitespace is folded, because a row is one line in a table.
  assert.deepEqual(row, { task: "wire the panel", status: "queued" });
  await store.add("second");
  assert.deepEqual(store.list(), [
    { task: "wire the panel", status: "queued" },
    { task: "second", status: "queued" },
  ]);
  // A new task has not been started: `building` is the separate step that says
  // work has begun, and add cannot skip it.
  assert.ok(store.list().every((r) => r.status === "queued"));

  assert.equal((await refusal(() => store.add("   "))).code, "EMPTY_TASK");
  assert.equal(store.size, 2, "and a refused add stored nothing");
});

test("a row is addressed by its EXACT text; no match and two matches both fail", async () => {
  const store = TaskStore.ephemeral(ROWS);

  // The exact text works, whitespace-folded as the store stores it.
  assert.deepEqual(await store.setStatus("bedrock retry backoff", "building"), {
    task: "bedrock retry backoff",
    status: "building",
  });

  // Nothing close counts. A prefix, a case fold and a near miss are all refused
  // rather than resolved to "the obvious one" — with two writers, the obvious
  // one is how the wrong row gets retired.
  for (const near of ["bedrock", "BEDROCK RETRY BACKOFF", "bedrock retry backof"]) {
    const { code, message } = await refusal(() => store.retire(near));
    assert.equal(code, "NO_MATCH", `"${near}" is not a match`);
    assert.match(message, /ctrl-o overhaul/, "and the error says what the table DOES hold");
  }

  // A file hand-edited (or written by an older build) can hold two rows reading
  // the same. Neither is guessed at.
  const dupes = TaskStore.ephemeral([
    { task: "same", status: "queued" },
    { task: "same", status: "building" },
  ]);
  assert.equal((await refusal(() => dupes.retire("same"))).code, "MULTIPLE_MATCHES");
  assert.equal((await refusal(() => dupes.setStatus("same", "queued"))).code, "MULTIPLE_MATCHES");
  assert.equal(dupes.size, 2, "and nothing was touched on the way to refusing");
});

test("no operation touches a row it did not name", async () => {
  const store = TaskStore.ephemeral([
    { task: "one", status: "building" },
    { task: "two", status: "queued" },
    { task: "three", status: "queued" },
  ]);
  const before = store.list();

  await store.setStatus("two", "building");
  assert.deepEqual(store.list()[0], before[0], "the row above is untouched");
  assert.deepEqual(store.list()[2], before[2], "and the row below");

  await store.retire("one");
  assert.deepEqual(store.list(), [
    { task: "two", status: "building" },
    { task: "three", status: "queued" },
  ]);

  await store.add("four");
  assert.deepEqual(store.list().slice(0, 2), [
    { task: "two", status: "building" },
    { task: "three", status: "queued" },
  ], "an add is an append and rewrites nothing");
});

test("adding the text of a row already on the table is refused, not duplicated", async () => {
  const store = TaskStore.ephemeral(ROWS);
  const { code, message } = await refusal(() => store.add("ctrl-o overhaul"));
  assert.equal(code, "DUPLICATE_TASK");
  assert.match(message, /already holds/);
  // Two rows reading the same would make BOTH unaddressable, which is the one
  // state the exact-text contract cannot recover from.
  assert.deepEqual(store.list(), ROWS);
});

test("status takes the two words and nothing else", async () => {
  const store = TaskStore.ephemeral(ROWS);
  await store.setStatus("ctrl-o overhaul", "queued");
  assert.equal(store.list()[0]!.status, "queued");
  await store.setStatus("ctrl-o overhaul", "building");
  assert.equal(store.list()[0]!.status, "building");

  // Strict on the way in, unlike the read path: a write that silently became
  // `queued` is a write the caller believes landed.
  for (const bad of ["done", "ready-to-arm", "", 3, undefined]) {
    assert.equal((await refusal(() => store.setStatus("ctrl-o overhaul", bad))).code, "BAD_STATUS");
  }
  assert.equal(store.list()[0]!.status, "building", "and the row is as it was");
});

/**
 * Renaming a row (D-20260729-5). The row's text used to be immutable, so fixing
 * a typo meant retire-and-re-add — which lost the two things a row carries
 * besides its words: its status and its place. So this is one operation, and
 * what these pin is that neither moves.
 */
test("rename rewrites a row's text, keeping its status and its place", async () => {
  const store = TaskStore.ephemeral([
    { task: "one", status: "queued" },
    { task: "typo in teh middle", status: "building" },
    { task: "three", status: "queued" },
  ]);
  const row = await store.rename("typo in teh middle", "  typo in   the middle  ");
  // Folded like every other cell: a row is one line in a table.
  assert.deepEqual(row, { task: "typo in the middle", status: "building" });
  assert.deepEqual(store.list(), [
    { task: "one", status: "queued" },
    { task: "typo in the middle", status: "building" },
    { task: "three", status: "queued" },
  ], "same status, same position, and the neighbours untouched");
});

test("rename survives the restart, and heals the file like every other write", async () => {
  const { paths, cleanup } = await tmpPaths();
  try {
    const store = await TaskStore.load(paths);
    await store.add("ctrl-o overhual");
    await store.setStatus("ctrl-o overhual", "building");
    await store.add("bedrock retry backoff");
    await store.rename("ctrl-o overhual", "ctrl-o overhaul");

    assert.deepEqual((await TaskStore.load(paths)).list(), [
      { task: "ctrl-o overhaul", status: "building" },
      { task: "bedrock retry backoff", status: "queued" },
    ]);
  } finally {
    await cleanup();
  }
});

test("renaming a row to the text it already has is a successful no-op", async () => {
  const store = TaskStore.ephemeral(ROWS);
  const row = await store.rename("ctrl-o overhaul", "ctrl-o overhaul");
  // The collision check must not see the row itself, or the one case that
  // reaches it most often — opening the field and changing nothing — would fail.
  assert.deepEqual(row, { task: "ctrl-o overhaul", status: "building" });
  assert.deepEqual(store.list(), ROWS);
});

test("rename refuses on all four counts, and changes nothing when it does", async () => {
  const store = TaskStore.ephemeral(ROWS);

  // 1. The old text matches no row, and the error says what IS there.
  const missing = await refusal(() => store.rename("no such row", "something"));
  assert.equal(missing.code, "NO_MATCH");
  assert.match(missing.message, /ctrl-o overhaul/);

  // 2. It matches more than one, so there is no way to tell which was meant.
  const dupes = TaskStore.ephemeral([
    { task: "same", status: "queued" },
    { task: "same", status: "building" },
  ]);
  assert.equal((await refusal(() => dupes.rename("same", "different"))).code, "MULTIPLE_MATCHES");
  assert.deepEqual(dupes.list().map((r) => r.task), ["same", "same"]);

  // 3. The new text is empty, or only whitespace, or not text at all.
  for (const bad of ["", "   ", "\n\t ", undefined, 7]) {
    const { code } = await refusal(() => store.rename("ctrl-o overhaul", bad));
    assert.equal(code, "EMPTY_TASK", `${JSON.stringify(bad)} is not a task`);
  }

  // 4. It would read the same as a DIFFERENT row — the duplicate-addressability
  //    rule `add` is held to, which two identical rows cannot be recovered from.
  const clash = await refusal(() => store.rename("ctrl-o overhaul", "bedrock retry backoff"));
  assert.equal(clash.code, "DUPLICATE_TASK");
  assert.match(clash.message, /Another row already reads/);

  assert.deepEqual(store.list(), ROWS, "and every refusal left the table exactly as it was");
});

test("the address is resolved before the new text is judged", async () => {
  // Both wrong at once: which row was meant is the harder question and the one
  // whose answer the co needs, so it is the one it is told about.
  const store = TaskStore.ephemeral(ROWS);
  assert.equal((await refusal(() => store.rename("no such row", "  "))).code, "NO_MATCH");
});

test("retire lifts a row out of the table and keeps it, timestamped, in done", async () => {
  const { paths, cleanup } = await tmpPaths();
  try {
    const store = await TaskStore.load(paths);
    await store.add("ctrl-o overhaul");
    await store.add("bedrock retry backoff");

    const at = "2026-07-29T10:11:12.000Z";
    const record = await store.retire("ctrl-o overhaul", at);
    assert.deepEqual(record, { task: "ctrl-o overhaul", retiredAt: at });
    assert.deepEqual(store.list(), [{ task: "bedrock retry backoff", status: "queued" }]);
    assert.deepEqual(store.done(), [{ task: "ctrl-o overhaul", retiredAt: at }]);

    // Done is an ACTION, not a third status: nothing retired is still in the
    // table, and nothing retired is lost either.
    const reloaded = await TaskStore.load(paths);
    assert.deepEqual(reloaded.list(), [{ task: "bedrock retry backoff", status: "queued" }]);
    assert.deepEqual(reloaded.done(), [{ task: "ctrl-o overhaul", retiredAt: at }]);

    // A default timestamp is a real one.
    await reloaded.retire("bedrock retry backoff");
    const stamped = reloaded.done()[1]!;
    assert.ok(!Number.isNaN(Date.parse(stamped.retiredAt)), "the default stamp parses as a date");
  } finally {
    await cleanup();
  }
});

test("the table is capped at five, and the sixth add FAILS rather than dropping anything", async () => {
  const store = TaskStore.ephemeral();
  assert.equal(TASK_TABLE_CAP, 5, "an at-a-glance block, not a backlog");
  for (let n = 0; n < TASK_TABLE_CAP; n++) await store.add(`task ${n + 1}`);

  const { code, message } = await refusal(() => store.add("one too many"));
  assert.equal(code, "TABLE_FULL");
  assert.match(message, /Retire something first/);
  assert.match(message, /"task 1"/, "and it names what is in the way");
  // Nothing is evicted to make room: evicting is this store deleting a row
  // nobody named, which is the thing it exists to prevent.
  assert.equal(store.size, TASK_TABLE_CAP);
  assert.equal(store.list()[0]!.task, "task 1");

  await store.retire("task 3");
  await store.add("one too many");
  assert.deepEqual(store.list().map((r) => r.task), [
    "task 1",
    "task 2",
    "task 4",
    "task 5",
    "one too many",
  ]);
});

test("a corrupt file reads back as an empty table, and the next write heals it", async () => {
  const { paths, cleanup } = await tmpPaths();
  try {
    await fsp.mkdir(path.dirname(paths.taskTable), { recursive: true });
    await fsp.writeFile(paths.taskTable, "{ not json at all", "utf8");

    const store = await TaskStore.load(paths);
    assert.deepEqual(store.list(), [], "a broken cache never stops the co opening");
    assert.deepEqual(store.done(), []);

    await store.add("ctrl-o overhaul");
    assert.deepEqual((await TaskStore.load(paths)).list(), [
      { task: "ctrl-o overhaul", status: "queued" },
    ], "and the file is valid again");
  } finally {
    await cleanup();
  }
});

test("a file holding the wrong shape entirely is an empty table too", async () => {
  const { paths, cleanup } = await tmpPaths();
  try {
    await fsp.mkdir(path.dirname(paths.taskTable), { recursive: true });
    // Valid JSON, wrong shape: the old table was prose, and a hand edit can be
    // anything at all.
    await fsp.writeFile(paths.taskTable, JSON.stringify({ tasks: "three things" }), "utf8");
    assert.deepEqual((await TaskStore.load(paths)).list(), []);
  } finally {
    await cleanup();
  }
});

test("rows are coerced: junk is dropped, cells are one line, status is one of two", () => {
  assert.deepEqual(
    coerceTasks([
      { task: "  spaced  out  ", status: " Building " },
      { task: "multi\nline\ndescription", status: "queued" },
      { task: "no status at all" },
      { task: "" }, // nothing to show
      { status: "queued" }, // no task text at all
      "a bare string",
      null,
    ]),
    [
      { task: "spaced out", status: "building" },
      { task: "multi line description", status: "queued" },
      { task: "no status at all", status: "queued" },
    ],
  );
});

/**
 * The store on disk predates both the two-word contract and the `done` list:
 * real files hold a `type` field, free-form statuses, and a BARE ARRAY where the
 * file now holds an object. Reading one is not an error case — it is the normal
 * case on the first run after this change.
 */
test("a store written under the old shape loads: bare array, type ignored, status coerced", async () => {
  const { paths, cleanup } = await tmpPaths();
  try {
    await fsp.mkdir(path.dirname(paths.taskTable), { recursive: true });
    await fsp.writeFile(
      paths.taskTable,
      JSON.stringify([
        { task: "Fix crew handoff truncation", type: "fix", status: "ready-to-arm" },
        { task: "Ctrl-O home page cleanup", type: "fix", status: "scoping" },
        { task: "Widget render audit", type: "research", status: "building" },
      ]),
      "utf8",
    );

    const store = await TaskStore.load(paths);
    assert.deepEqual(store.list(), [
      { task: "Fix crew handoff truncation", status: "queued" },
      { task: "Ctrl-O home page cleanup", status: "queued" },
      // The one word that survived the old vocabulary keeps its meaning.
      { task: "Widget render audit", status: "building" },
    ]);
    assert.deepEqual(store.done(), [], "a file with no done list has retired nothing");
    for (const row of store.list()) {
      assert.ok(TASK_STATUSES.includes(row.status), `${row.status} is one of the two`);
      assert.ok(!("type" in row), "and nothing carries the old field forward");
    }

    // And the next write heals the file itself, rather than leaving `type` on
    // disk for the next reader to strip again.
    await store.setStatus("Widget render audit", "queued");
    const onDisk = JSON.parse(await fsp.readFile(paths.taskTable, "utf8")) as Record<string, unknown>;
    assert.ok(!JSON.stringify(onDisk).includes("\"type\""), "the stored rows are the new shape");
    assert.ok(Array.isArray(onDisk.tasks) && Array.isArray(onDisk.done), "and the file has both lists");
  } finally {
    await cleanup();
  }
});

test("an ephemeral store holds a table with no file behind it", async () => {
  const store = TaskStore.ephemeral(ROWS);
  assert.equal(store.size, 2);
  await store.retire("ctrl-o overhaul");
  assert.deepEqual(store.list(), [{ task: "bedrock retry backoff", status: "queued" }]);
});

test("list() and done() hand back copies, so a caller cannot mutate the store", async () => {
  const store = TaskStore.ephemeral(ROWS);
  await store.retire("ctrl-o overhaul", "2026-07-29T00:00:00.000Z");
  const rows = store.list();
  rows[0]!.status = "building";
  rows.push({ task: "injected", status: "queued" });
  const done = store.done();
  done[0]!.task = "rewritten";
  assert.deepEqual(store.list(), [{ task: "bedrock retry backoff", status: "queued" }]);
  assert.deepEqual(store.done(), [{ task: "ctrl-o overhaul", retiredAt: "2026-07-29T00:00:00.000Z" }]);
});

// --- the tool the co writes through ------------------------------------------

/** Run one `task_table` call through the real executor, against a real store. */
async function callTool(
  tasks: TaskStore | undefined,
  input: unknown,
): Promise<{ content: string; is_error?: boolean }> {
  const paths = instancePaths("/nowhere", "inst"); // nothing here touches it
  const executor = makeExecutor({
    paths,
    research: {} as ResearchConfig,
    effects: newSideEffects(),
    ...(tasks ? { tasks } : {}),
  });
  const res = await executor({ type: "tool_use", id: "t1", name: "task_table", input });
  return { content: res.content, ...(res.is_error ? { is_error: true } : {}) };
}

test("the task_table tool is declared, linked or not, and dispatches on a command", async () => {
  // The table does not ride the dispatch link (it needs no repo), so it is
  // declared in both shapes of the tool surface.
  for (const dispatch of [false, true]) {
    const tool = toolDefinitions({ dispatch }).find((t) => t.name === "task_table");
    assert.ok(tool, `declared with dispatch=${dispatch}`);
    assert.deepEqual(tool.input_schema.required, ["command"]);
    const props = tool.input_schema.properties as Record<string, { enum?: string[] }>;
    assert.deepEqual(props.command?.enum, ["add", "status", "rename", "retire", "list"]);
    assert.deepEqual(props.status?.enum, ["building", "queued"], "and the status enum is the gate");
    assert.ok("new_task" in props, "rename needs a second text, and it is declared");
    assert.ok(!("tasks" in props), "the whole-table array is gone from the contract");
  }
  assert.deepEqual([...TASK_COMMANDS], ["add", "status", "rename", "retire", "list"]);
});

test("the tool adds, moves and retires one named row, and lists the table", async () => {
  const store = TaskStore.ephemeral();

  const added = await callTool(store, { command: "add", task: "one thing" });
  assert.ok(!added.is_error, added.content);
  assert.deepEqual(store.list(), [{ task: "one thing", status: "queued" }]);
  assert.match(added.content, /"status": ?"queued"/, "a new row is queued, always");

  await callTool(store, { command: "add", task: "another" });
  await callTool(store, { command: "status", task: "one thing", status: "building" });
  assert.deepEqual(store.list(), [
    { task: "one thing", status: "building" },
    { task: "another", status: "queued" },
  ]);

  const listed = await callTool(store, { command: "list" });
  assert.match(listed.content, /one thing/);
  assert.match(listed.content, /another/);

  const retired = await callTool(store, { command: "retire", task: "one thing" });
  assert.ok(!retired.is_error, retired.content);
  assert.deepEqual(store.list(), [{ task: "another", status: "queued" }]);
  assert.equal(store.done()[0]!.task, "one thing");
  assert.match(retired.content, /retiredAt/, "with the moment it left");
});

test("there is no way to clear or replace the table in one call", async () => {
  const store = TaskStore.ephemeral(ROWS);
  // The shapes the old contract accepted, and every plausible attempt at the
  // old behaviour, all bounce off the command dispatch.
  for (const input of [
    { tasks: [] },
    { command: "replace", tasks: [{ task: "x", status: "queued" }] },
    { command: "clear" },
    { command: "" },
  ]) {
    const res = await callTool(store, input);
    assert.equal(res.is_error, true, JSON.stringify(input));
    assert.match(res.content, /UNKNOWN_COMMAND/);
  }
  assert.deepEqual(store.list(), ROWS, "and the table is exactly as it was");
});

test("a refusal comes back as an error the co can read, carrying the real table", async () => {
  const store = TaskStore.ephemeral(ROWS);

  const missing = await callTool(store, { command: "retire", task: "something else" });
  assert.equal(missing.is_error, true);
  assert.match(missing.content, /NO_MATCH/);
  assert.match(missing.content, /ctrl-o overhaul/, "so its next call can be right");
  assert.deepEqual(store.list(), ROWS);

  const full = TaskStore.ephemeral(
    Array.from({ length: TASK_TABLE_CAP }, (_, n) => ({ task: `t${n}`, status: "queued" })),
  );
  const over = await callTool(full, { command: "add", task: "one too many" });
  assert.equal(over.is_error, true);
  assert.match(over.content, /TABLE_FULL/);
  assert.equal(full.size, TASK_TABLE_CAP, "nothing was dropped to make room");

  const unavailable = await callTool(undefined, { command: "list" });
  assert.equal(unavailable.is_error, true);
  assert.match(unavailable.content, /task table is unavailable/);
});

test("the tool renames one named row, and refuses in the shape the co can read", async () => {
  const store = TaskStore.ephemeral([
    { task: "ctrl-o overhual", status: "building" },
    { task: "bedrock retry backoff", status: "queued" },
  ]);

  const renamed = await callTool(store, {
    command: "rename",
    task: "ctrl-o overhual",
    new_task: "ctrl-o overhaul",
  });
  assert.ok(!renamed.is_error, renamed.content);
  assert.deepEqual(store.list(), [
    { task: "ctrl-o overhaul", status: "building" },
    { task: "bedrock retry backoff", status: "queued" },
  ], "status and position both kept");
  assert.match(renamed.content, /"renamed"/, "the tool says which row moved");

  // Every refusal comes back as an is_error carrying the code, the sentence and
  // the REAL table, so the co's next call can be right rather than a guess.
  for (const [input, code] of [
    [{ command: "rename", task: "not on the table", new_task: "x" }, "NO_MATCH"],
    [{ command: "rename", task: "ctrl-o overhaul", new_task: "   " }, "EMPTY_TASK"],
    [{ command: "rename", task: "ctrl-o overhaul" }, "EMPTY_TASK"],
    [{ command: "rename", task: "ctrl-o overhaul", new_task: "bedrock retry backoff" }, "DUPLICATE_TASK"],
  ] as const) {
    const res = await callTool(store, input);
    assert.equal(res.is_error, true, JSON.stringify(input));
    assert.match(res.content, new RegExp(code));
    assert.match(res.content, /"table"/, "and it carries the table as it actually is");
    assert.match(res.content, /ctrl-o overhaul/);
  }

  const dupes = TaskStore.ephemeral([
    { task: "same", status: "queued" },
    { task: "same", status: "building" },
  ]);
  const ambiguous = await callTool(dupes, { command: "rename", task: "same", new_task: "other" });
  assert.equal(ambiguous.is_error, true);
  assert.match(ambiguous.content, /MULTIPLE_MATCHES/);

  // A rename to the row's own text is not a collision with itself.
  const noop = await callTool(store, {
    command: "rename",
    task: "ctrl-o overhaul",
    new_task: "ctrl-o overhaul",
  });
  assert.ok(!noop.is_error, noop.content);
  assert.deepEqual(store.list()[0], { task: "ctrl-o overhaul", status: "building" });
});

/**
 * The tool and the panel must agree about what the table looks like, or the co
 * and the captain are describing different tables to each other. So every
 * `table` this tool hands back — the listing, the echo after a write, the one
 * carried by a refusal — is in the same display order the Home tab paints.
 */
test("every table the tool returns is building-first, like the panel's", async () => {
  const store = TaskStore.ephemeral([
    { task: "first added", status: "queued" },
    { task: "second added", status: "queued" },
    { task: "third added", status: "building" },
  ]);
  const tableOf = (content: string): string[] =>
    ((JSON.parse(content) as { table: TaskRow[] }).table ?? []).map((r) => r.task);

  const listed = await callTool(store, { command: "list" });
  assert.deepEqual(tableOf(listed.content), ["third added", "first added", "second added"]);

  // The stored order is untouched by the display order — `add` still appends.
  assert.deepEqual(store.list().map((r) => r.task), ["first added", "second added", "third added"]);

  // A status change re-sorts what is READ without rewriting what is STORED.
  const moved = await callTool(store, { command: "status", task: "first added", status: "building" });
  assert.deepEqual(tableOf(moved.content), ["first added", "third added", "second added"]);
  assert.deepEqual(store.list().map((r) => r.task), ["first added", "second added", "third added"]);

  const refused = await callTool(store, { command: "retire", task: "nothing reads this" });
  assert.equal(refused.is_error, true);
  assert.deepEqual(tableOf(refused.content), ["first added", "third added", "second added"]);
});

test("a status outside the enum is refused by the tool, never coerced into the table", async () => {
  const store = TaskStore.ephemeral(ROWS);
  const res = await callTool(store, { command: "status", task: "ctrl-o overhaul", status: "done" });
  assert.equal(res.is_error, true);
  assert.match(res.content, /BAD_STATUS/);
  assert.equal(store.list()[0]!.status, "building", "the row did not move");
});
