import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { instancePaths } from "../paths.js";
import { TaskStore, TASK_TABLE_CAP, TASK_STATUSES, coerceTasks, type TaskRow } from "./taskstore.js";
import { makeExecutor, newSideEffects, toolDefinitions } from "./tools.js";
import type { ResearchConfig } from "../config.js";

/**
 * The persisted task table (taskstore.ts). The table used to exist only as prose
 * the co re-printed into the chat, so these tests are about the thing that made
 * it renderable: a small file that survives a restart, is rewritten whole, and
 * degrades to an empty table rather than failing a session start.
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

test("a table written in one session is read back in the next", async () => {
  const { paths, cleanup } = await tmpPaths();
  try {
    const first = await TaskStore.load(paths);
    assert.deepEqual(first.list(), [], "a missing file is an empty table, not a failure");

    const res = await first.replace(ROWS);
    assert.deepEqual(res.stored, ROWS);
    assert.equal(res.dropped, 0);

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

test("a write replaces the WHOLE table, and an empty list clears it", async () => {
  const { paths, cleanup } = await tmpPaths();
  try {
    const store = await TaskStore.load(paths);
    await store.replace(ROWS);
    // Not a merge, not an append: what the co sends is the table now.
    await store.replace([{ task: "ship it", status: "building" }]);
    assert.deepEqual(store.list(), [{ task: "ship it", status: "building" }]);
    assert.deepEqual((await TaskStore.load(paths)).list(), store.list());

    await store.replace([]);
    assert.deepEqual(store.list(), [], "an empty list is how the co clears the table");
    assert.deepEqual((await TaskStore.load(paths)).list(), []);
  } finally {
    await cleanup();
  }
});

test("a corrupt file reads back as an empty table, and the next write heals it", async () => {
  const { paths, cleanup } = await tmpPaths();
  try {
    await fsp.mkdir(path.dirname(paths.taskTable), { recursive: true });
    await fsp.writeFile(paths.taskTable, "{ not json at all", "utf8");

    const store = await TaskStore.load(paths);
    assert.deepEqual(store.list(), [], "a broken cache never stops the co opening");

    await store.replace(ROWS);
    assert.deepEqual((await TaskStore.load(paths)).list(), ROWS, "and the file is valid again");
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
 * The store on disk predates the two-word contract: real files hold a `type`
 * field and free-form statuses (`ready-to-arm`, `scoping`, `armed`, `backlog`).
 * Reading one is not an error case — it is the normal case on the first run
 * after this change, and it must land as a table the panel can paint.
 */
test("a store written under the old shape loads: type ignored, unknown status queued", async () => {
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
    for (const row of store.list()) {
      assert.ok(TASK_STATUSES.includes(row.status), `${row.status} is one of the two`);
      assert.ok(!("type" in row), "and nothing carries the old field forward");
    }

    // And the next write heals the file itself, rather than leaving `type` on
    // disk for the next reader to strip again.
    await store.replace(store.list());
    const onDisk = JSON.parse(await fsp.readFile(paths.taskTable, "utf8")) as unknown[];
    assert.ok(!JSON.stringify(onDisk).includes("\"type\""), "the stored rows are the new shape");
  } finally {
    await cleanup();
  }
});

test("the table is capped at five, and a write over the cap reports what it dropped", async () => {
  const { paths, cleanup } = await tmpPaths();
  try {
    assert.equal(TASK_TABLE_CAP, 5, "an at-a-glance block, not a backlog");
    const many = Array.from({ length: TASK_TABLE_CAP + 5 }, (_, n) => ({
      task: `task ${n + 1}`,
      status: "queued",
    }));
    const store = await TaskStore.load(paths);
    const res = await store.replace(many);
    assert.equal(res.stored.length, TASK_TABLE_CAP);
    assert.equal(res.dropped, 5, "truncation is reported, never silent");
    assert.equal(store.list()[0]!.task, "task 1", "the head of the table is what survives");
  } finally {
    await cleanup();
  }
});

test("an ephemeral store holds a table with no file behind it", async () => {
  const store = TaskStore.ephemeral(ROWS);
  assert.equal(store.size, 2);
  await store.replace([{ task: "only", status: "building" }]);
  assert.deepEqual(store.list(), [{ task: "only", status: "building" }]);
});

test("list() hands back a copy, so a caller cannot mutate the stored table", () => {
  const store = TaskStore.ephemeral(ROWS);
  const rows = store.list();
  rows[0]!.status = "queued";
  rows.push({ task: "injected", status: "queued" });
  assert.deepEqual(store.list(), ROWS);
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

test("the task_table tool is declared, linked or not, and replaces the table in one call", async () => {
  // The table is the co's own: unlike the feature levers it does not ride the
  // dispatch link, so it is declared in both shapes of the tool surface.
  for (const dispatch of [false, true]) {
    const tool = toolDefinitions({ dispatch }).find((t) => t.name === "task_table");
    assert.ok(tool, `declared with dispatch=${dispatch}`);
    assert.match(tool.description, /replaces? the (whole|captain's)/i);
    assert.deepEqual(tool.input_schema.required, ["tasks"]);
  }

  const store = TaskStore.ephemeral(ROWS);
  const res = await callTool(store, {
    tasks: [{ task: "one thing", status: "building" }],
  });
  assert.ok(!res.is_error, res.content);
  assert.deepEqual(store.list(), [{ task: "one thing", status: "building" }]);
  assert.match(res.content, /"stored": ?1/, "and the co is told what was stored");

  // An empty list is the documented way to clear it.
  await callTool(store, { tasks: [] });
  assert.deepEqual(store.list(), []);
});

/**
 * The schema is the real gate on the vocabulary. Coercion in the store is the
 * backstop for a file written before this change; the enum is what stops a third
 * status ever being SUBMITTED, and the cap rides beside it as maxItems so the
 * model is told the ceiling rather than only told off for exceeding it.
 */
test("the tool's schema offers two statuses and no more, and caps the table at five", () => {
  const tool = toolDefinitions().find((t) => t.name === "task_table");
  assert.ok(tool);
  const props = tool.input_schema.properties as {
    tasks: {
      maxItems?: number;
      items: { properties: Record<string, { enum?: string[] }>; required?: string[] };
    };
  };
  assert.equal(props.tasks.maxItems, TASK_TABLE_CAP);
  assert.deepEqual(props.tasks.items.properties.status?.enum, ["building", "queued"]);
  assert.deepEqual(props.tasks.items.required, ["task", "status"]);
  assert.ok(!("type" in props.tasks.items.properties), "the Type column is gone from the contract too");
});

test("a status outside the enum still cannot be stored: it lands as queued", async () => {
  const store = TaskStore.ephemeral();
  // The schema rejects this shape; the store is what happens if one gets past it
  // anyway (an older file, a model that ignored the enum). Never a third word.
  await callTool(store, { tasks: [{ task: "an old row", type: "fix", status: "ready-to-arm" }] });
  assert.deepEqual(store.list(), [{ task: "an old row", status: "queued" }]);
});

test("the tool tells the co when rows were dropped, rather than letting it assume", async () => {
  const store = TaskStore.ephemeral();
  const res = await callTool(store, {
    tasks: [
      ...Array.from({ length: TASK_TABLE_CAP }, (_, n) => ({ task: `t${n}`, status: "queued" })),
      { task: "one too many", status: "queued" },
      { status: "queued" }, // no task text
    ],
  });
  assert.equal(store.size, TASK_TABLE_CAP);
  assert.match(res.content, /"dropped": ?2/);
  assert.match(res.content, /Prune to the major items/);
});

test("a malformed or unavailable call is an error the co can read, never a throw", async () => {
  const store = TaskStore.ephemeral(ROWS);
  const bad = await callTool(store, { tasks: "three things" });
  assert.equal(bad.is_error, true);
  assert.match(bad.content, /requires a `tasks` array/);
  assert.deepEqual(store.list(), ROWS, "and the stored table is untouched");

  const missing = await callTool(undefined, { tasks: [] });
  assert.equal(missing.is_error, true);
  assert.match(missing.content, /task table is unavailable/);
});
