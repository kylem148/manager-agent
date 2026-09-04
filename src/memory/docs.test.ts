import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { instancePaths, type InstancePaths } from "../paths.js";
import { createInstance } from "./memory.js";
import {
  DocError,
  createDoc,
  deleteDoc,
  listDocs,
  overwriteDoc,
  overwriteDocIfUnchanged,
  readDoc,
  readSurfacedDocs,
  strReplaceDoc,
} from "./docs.js";
import { makeExecutor, newSideEffects, toolDefinitions } from "../session/tools.js";
import { buildStartupInjection } from "../session/prompt.js";
import { onWrite } from "./writequeue.js";
import { rewriteLive, appendLog } from "./memory.js";
import type { ResearchConfig } from "../config.js";

/**
 * The doc tool: the six commands against docs/, and — the part that actually
 * matters — the sandbox. The tool is the co-manager's only general-purpose file
 * surface, so every way of naming something outside docs/ must be rejected, not
 * merely unlikely to be tried.
 */

async function makeInstance(): Promise<{ paths: InstancePaths; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "co-docs-"));
  await createInstance(home, "inst");
  return {
    paths: instancePaths(home, "inst"),
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

async function expectDocError(fn: () => Promise<unknown>, code: string): Promise<DocError> {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof DocError, `expected a DocError, got ${e}`);
    assert.equal(e.code, code);
    return e;
  }
  assert.fail(`expected ${code}, but the call succeeded`);
}

test("a fresh instance has an empty docs/", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    assert.deepEqual(await readdir(paths.docs), []);
    assert.deepEqual(await listDocs(paths), []);
  } finally {
    await cleanup();
  }
});

test("create / read / list / str_replace / overwrite / delete", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    await createDoc(paths, "plan.md", "# Plan\n\n- ship the doc tool\n");
    await createDoc(paths, "architecture.md", "# Arch\n");

    assert.deepEqual(await listDocs(paths), ["architecture.md", "plan.md"]);
    assert.equal(await readDoc(paths, "plan.md"), "# Plan\n\n- ship the doc tool\n");

    await strReplaceDoc(paths, "plan.md", "ship the doc tool", "ship the doc tool, then the prompt");
    assert.match(await readDoc(paths, "plan.md"), /then the prompt/);

    const over = await overwriteDoc(paths, "plan.md", "# Plan\n\nstarting over");
    assert.equal(over.created, false);
    assert.equal(await readDoc(paths, "plan.md"), "# Plan\n\nstarting over\n");

    await deleteDoc(paths, "plan.md");
    assert.deepEqual(await listDocs(paths), ["architecture.md"]);
    await expectDocError(() => readDoc(paths, "plan.md"), "DOC_NOT_FOUND");
  } finally {
    await cleanup();
  }
});

test("create refuses to clobber; delete refuses what is not there", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    await createDoc(paths, "plan.md", "original\n");
    const e = await expectDocError(() => createDoc(paths, "plan.md", "replacement\n"), "DOC_EXISTS");
    assert.match(e.message, /overwrite/, "the error says what to do instead");
    assert.equal(await readDoc(paths, "plan.md"), "original\n", "the original is untouched");

    await expectDocError(() => deleteDoc(paths, "nope.md"), "DOC_NOT_FOUND");
    await expectDocError(() => strReplaceDoc(paths, "nope.md", "a", "b"), "DOC_NOT_FOUND");
  } finally {
    await cleanup();
  }
});

test("str_replace demands a unique match", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    await createDoc(paths, "plan.md", "alpha\nbeta\nalpha\n");

    const dup = await expectDocError(
      () => strReplaceDoc(paths, "plan.md", "alpha", "gamma"),
      "MULTIPLE_MATCHES",
    );
    assert.match(dup.message, /more context|surrounding context/i);
    assert.equal(await readDoc(paths, "plan.md"), "alpha\nbeta\nalpha\n", "nothing was guessed");

    await expectDocError(() => strReplaceDoc(paths, "plan.md", "delta", "gamma"), "NO_MATCH");
    await expectDocError(() => strReplaceDoc(paths, "plan.md", "", "gamma"), "NO_MATCH");

    // Unique once enough context is included.
    await strReplaceDoc(paths, "plan.md", "beta\nalpha", "beta\ngamma");
    assert.equal(await readDoc(paths, "plan.md"), "alpha\nbeta\ngamma\n");
  } finally {
    await cleanup();
  }
});

test("overwrite creates when the doc does not exist yet", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const r = await overwriteDoc(paths, "notes.md", "fresh");
    assert.equal(r.created, true);
    assert.equal(await readDoc(paths, "notes.md"), "fresh\n");
  } finally {
    await cleanup();
  }
});

test("a checked overwrite writes only while the file still holds what was read", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    await createDoc(paths, "plan.md", "one\n");
    const opened = await readDoc(paths, "plan.md");

    const ok = await overwriteDocIfUnchanged(paths, "plan.md", "one\ntwo\n", opened);
    assert.equal(ok.name, "plan.md");
    assert.equal(await readDoc(paths, "plan.md"), "one\ntwo\n");

    // The co rewrote it while the editor was open: the stale baseline is
    // refused, and the co's version is still on disk afterwards.
    await overwriteDoc(paths, "plan.md", "the co's rewrite\n");
    const e = await expectDocError(
      () => overwriteDocIfUnchanged(paths, "plan.md", "the captain's rewrite\n", opened),
      "DOC_CHANGED",
    );
    assert.match(e.message, /changed on disk/);
    assert.equal(await readDoc(paths, "plan.md"), "the co's rewrite\n");

    // Deleted out from under the editor is the same answer: a save must not
    // silently resurrect a document the co removed.
    await deleteDoc(paths, "plan.md");
    await expectDocError(
      () => overwriteDocIfUnchanged(paths, "plan.md", "back from the dead\n", "the co's rewrite\n"),
      "DOC_CHANGED",
    );
    await expectDocError(() => readDoc(paths, "plan.md"), "DOC_NOT_FOUND");
  } finally {
    await cleanup();
  }
});

test("a checked overwrite announces itself on the write queue", async () => {
  const { paths, cleanup } = await makeInstance();
  const seen: string[] = [];
  const off = onWrite((e) => seen.push(`${e.kind}:${e.name}`));
  try {
    await createDoc(paths, "plan.md", "one\n");
    seen.length = 0;
    await overwriteDocIfUnchanged(paths, "plan.md", "two\n", "one\n");
    assert.deepEqual(seen, ["doc:plan.md"], "the viewer refreshes off exactly one signal");

    seen.length = 0;
    await expectDocError(
      () => overwriteDocIfUnchanged(paths, "plan.md", "three\n", "stale\n"),
      "DOC_CHANGED",
    );
    assert.deepEqual(seen, [], "a refused write signals nothing");
  } finally {
    off();
    await cleanup();
  }
});

test("the sandbox rejects every way out of docs/", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const escapes = [
      "../.memory/decisions.md",
      "../../.env",
      "..",
      "./plan.md",
      "sub/plan.md",
      "sub\\plan.md",
      ".memory/activeContext.md",
      "/etc/passwd",
      path.join(paths.memory, "activeContext.md"),
      ".env",
      ".hidden.md",
      "plan.txt",
      "plan",
      "",
    ];
    for (const name of escapes) {
      await expectDocError(() => readDoc(paths, name), "INVALID_DOC_NAME");
      await expectDocError(() => createDoc(paths, name, "x"), "INVALID_DOC_NAME");
      await expectDocError(() => overwriteDoc(paths, name, "x"), "INVALID_DOC_NAME");
      await expectDocError(() => deleteDoc(paths, name), "INVALID_DOC_NAME");
      await expectDocError(() => strReplaceDoc(paths, name, "a", "b"), "INVALID_DOC_NAME");
      // The panel's editor writes through here, so it is held to the same
      // sandbox as every other writer — `.memory/` included.
      await expectDocError(
        () => overwriteDocIfUnchanged(paths, name, "x", ""),
        "INVALID_DOC_NAME",
      );
    }

    // The substrate is untouched by all of that.
    assert.match(await readFile(paths.liveFile("activeContext.md"), "utf8"), /Active context/);
  } finally {
    await cleanup();
  }
});

test("a symlink planted inside docs/ cannot be used to escape", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const secret = path.join(paths.root, "secret.md");
    await writeFile(secret, "classified\n");
    await symlink(secret, path.join(paths.docs, "escape.md"));

    await expectDocError(() => readDoc(paths, "escape.md"), "PATH_ESCAPE");
    await expectDocError(() => overwriteDoc(paths, "escape.md", "pwned"), "PATH_ESCAPE");
    await expectDocError(() => deleteDoc(paths, "escape.md"), "PATH_ESCAPE");
    await expectDocError(() => strReplaceDoc(paths, "escape.md", "classified", "x"), "PATH_ESCAPE");

    assert.equal(await readFile(secret, "utf8"), "classified\n", "the target is untouched");
    assert.deepEqual(await listDocs(paths), [], "a symlink is not listed as a doc");
  } finally {
    await cleanup();
  }
});

test("a directory inside docs/ is not addressable as a doc", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    await mkdir(path.join(paths.docs, "sub.md"));
    await expectDocError(() => deleteDoc(paths, "sub.md"), "DOC_NOT_A_FILE");
    await expectDocError(() => readDoc(paths, "sub.md"), "DOC_NOT_A_FILE");
    assert.deepEqual(await listDocs(paths), []);
  } finally {
    await cleanup();
  }
});

test("the doc tool is wired into the model's tool surface; rewrite_architecture is gone", async () => {
  const names = toolDefinitions().map((t) => t.name);
  assert.ok(names.includes("doc"));
  assert.ok(!names.includes("rewrite_architecture"));
});

test("the executor dispatches all six commands and reports errors structurally", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const research = {} as ResearchConfig;
    const execute = makeExecutor({ paths, research, effects: newSideEffects() });
    let n = 0;
    const call = (input: Record<string, unknown>) =>
      execute({ type: "tool_use", id: `t${++n}`, name: "doc", input });

    assert.deepEqual(JSON.parse(String((await call({ command: "list" })).content)), { docs: [] });
    await call({ command: "create", name: "plan.md", content: "# Plan\n\nfirst\n" });
    assert.deepEqual(JSON.parse(String((await call({ command: "list" })).content)), {
      docs: ["plan.md"],
    });
    const read = await call({ command: "read", name: "plan.md" });
    assert.equal(JSON.parse(String(read.content)).content, "# Plan\n\nfirst\n");

    await call({ command: "str_replace", name: "plan.md", old_str: "first", new_str: "second" });
    assert.match(await readDoc(paths, "plan.md"), /second/);
    await call({ command: "overwrite", name: "plan.md", content: "# Plan\n\nthird" });
    assert.equal(await readDoc(paths, "plan.md"), "# Plan\n\nthird\n");
    await call({ command: "delete", name: "plan.md" });
    assert.deepEqual(await listDocs(paths), []);

    const bad = await call({ command: "read", name: "../../.env" });
    assert.equal(bad.is_error, true);
    assert.equal(JSON.parse(String(bad.content)).error, "INVALID_DOC_NAME");

    const missing = await call({ command: "read", name: "nope.md" });
    assert.equal(JSON.parse(String(missing.content)).error, "DOC_NOT_FOUND");

    const unknown = await call({ command: "rename", name: "plan.md" });
    assert.equal(unknown.is_error, true);
    assert.equal(JSON.parse(String(unknown.content)).error, "UNKNOWN_COMMAND");
  } finally {
    await cleanup();
  }
});

test("doc writes emit a write-queue change signal; the .memory/ substrate never does", async () => {
  const { paths, cleanup } = await makeInstance();
  const events: string[] = [];
  const unsubscribe = onWrite((e) => {
    assert.equal(e.kind, "doc");
    events.push(e.name);
  });
  try {
    // Every mutating doc command fires exactly one signal, carrying the bare
    // filename the viewer needs to decide "is this the doc I'm showing?".
    await createDoc(paths, "plan.md", "# Plan\n");
    await strReplaceDoc(paths, "plan.md", "# Plan", "# Plan v2");
    await overwriteDoc(paths, "plan.md", "# Plan v3\n");
    await deleteDoc(paths, "plan.md");
    assert.deepEqual(events, ["plan.md", "plan.md", "plan.md", "plan.md"]);

    // Writes to the hidden substrate go through the SAME serialized queue but
    // must never surface on this channel: the doc viewer can only ever learn
    // about docs/, never about .memory/.
    events.length = 0;
    await rewriteLive(paths, "activeContext.md", "fresh orientation\n");
    await appendLog(paths, "decisions", "a decision");
    assert.deepEqual(events, [], "no substrate write leaks to the doc-change channel");
  } finally {
    unsubscribe();
    await cleanup();
  }
});

test("cold start surfaces architecture.md and plan.md when they exist", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const research = { } as ResearchConfig;

    const empty = await readSurfacedDocs(paths);
    assert.deepEqual(empty, [], "nothing to surface on a fresh instance");
    const fresh = await buildStartupInjection(paths, research);
    assert.ok(!fresh.includes("docs/architecture.md"), "no phantom architecture.md");

    await createDoc(paths, "architecture.md", "# Arch\n\nthe hull and the rigging\n");
    await createDoc(paths, "plan.md", "# Plan\n\nthe course we are steering\n");
    await createDoc(paths, "scratch.md", "not surfaced at cold start\n");

    // The privileged read lands in the startup injection (layer 3), not the
    // static system prompt: docs are state, and state rides history.
    const briefing = await buildStartupInjection(paths, research);
    assert.match(briefing, /## docs[/\\]architecture\.md/);
    assert.match(briefing, /the hull and the rigging/);
    assert.match(briefing, /## docs[/\\]plan\.md/);
    assert.match(briefing, /the course we are steering/);
    assert.ok(!briefing.includes("not surfaced at cold start"), "only the two privileged docs");
    assert.match(briefing, /activeContext\.md/, "the substrate live state is still there");
  } finally {
    await cleanup();
  }
});
