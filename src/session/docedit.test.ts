import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { instancePaths, type InstancePaths } from "../paths.js";
import { createInstance } from "../memory/memory.js";
import { createDoc, overwriteDoc, readDoc } from "../memory/docs.js";
import type { MessageParam } from "../model.js";
import { Tui, type InStream, type OutStream } from "../tui/tui.js";
import { stripAnsi } from "../tui/wrap.js";
import { docSource, panelWriteDoc, type DocEditContext } from "./session.js";

process.setMaxListeners(0);

/**
 * The session half of the panel's doc editor: what a Ctrl-S actually does to
 * the file, and the one line it leaves behind for the model.
 *
 * The line is the whole reason this is not just a file write. The co is handed
 * architecture.md and plan.md at startup and holds them for the rest of the
 * session, so a doc the captain rewrote underneath it is a copy it would go on
 * quoting. It is told the document MOVED and nothing else — no contents, no
 * turn, no reply — because it has a doc tool and can read the file the next time
 * the subject actually comes up.
 */

async function makeInstance(): Promise<{ paths: InstancePaths; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "co-docedit-"));
  await createInstance(home, "inst");
  return {
    paths: instancePaths(home, "inst"),
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

function context(paths: InstancePaths): DocEditContext & { notes: string[] } {
  const notes: string[] = [];
  return {
    paths,
    messages: [],
    historyNotes: [],
    notes,
    note: (l) => notes.push(l),
  };
}

test("a save writes the file and leaves exactly one line naming it", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    await createDoc(paths, "plan.md", "one\n");
    const ctx = context(paths);

    const res = await panelWriteDoc(ctx, {
      name: "plan.md",
      content: "one\ntwo\n",
      baseline: "one\n",
    });

    assert.equal(res.saved, true);
    assert.equal(await readDoc(paths, "plan.md"), "one\ntwo\n");
    assert.equal(ctx.historyNotes.length, 1, "exactly one line, not one per keystroke");
    assert.match(ctx.historyNotes[0]!, /docs\/plan\.md/, "and it names the doc that changed");
    assert.ok(!ctx.historyNotes[0]!.includes("one\ntwo"), "the contents are never re-injected");
    assert.equal(ctx.notes.length, 1, "the session's own record shows it too");
    assert.deepEqual(
      ctx.messages,
      [],
      "nothing is pushed mid-turn; flushHistoryNotes drains at a turn boundary",
    );
  } finally {
    await cleanup();
  }
});

test("a doc the co rewrote underneath is reported, not overwritten", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    await createDoc(paths, "plan.md", "the co's version\n");
    const ctx = context(paths);

    const res = await panelWriteDoc(ctx, {
      name: "plan.md",
      content: "the captain's version\n",
      baseline: "what the editor opened on\n",
    });

    assert.equal(res.saved, false);
    assert.match(res.error ?? "", /changed on disk/);
    assert.match(res.error ?? "", /Ctrl-Y/, "and says how not to lose the typed text");
    assert.equal(await readDoc(paths, "plan.md"), "the co's version\n", "the file is untouched");
    assert.deepEqual(ctx.historyNotes, [], "nothing changed, so the model is told nothing");
  } finally {
    await cleanup();
  }
});

test("the write is the same sandbox every other doc write runs through", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const ctx = context(paths);
    for (const name of ["../.memory/activeContext.md", ".memory/decisions.md", "../../.env"]) {
      const res = await panelWriteDoc(ctx, { name, content: "pwned", baseline: "" });
      assert.equal(res.saved, false, `${name} was refused`);
      assert.match(res.error ?? "", /not a valid doc name/);
    }
    assert.deepEqual(ctx.historyNotes, []);
  } finally {
    await cleanup();
  }
});

// --- end to end --------------------------------------------------------------
//
// The real Tui, wired to a real instance folder through the SAME docSource the
// session builds, driven with the bytes a terminal sends. Everything between the
// keystroke and the file is the shipped path: the panel, the popup, the write
// queue, the sandbox, the on-disk write. Only the terminal is a fake.

function panel(paths: InstancePaths, ctx: DocEditContext): {
  send(bytes: string): void;
  frame(): string;
  stop(): void;
} {
  let listener: ((d: string) => void) | null = null;
  const writes: string[] = [];
  const out: OutStream = { write: (s) => writes.push(String(s)), columns: 80, rows: 24 };
  const inp: InStream = {
    isTTY: true,
    setRawMode: () => {},
    resume: () => {},
    pause: () => {},
    setEncoding: () => {},
    on: (_e, l) => (listener = l),
    removeListener: () => (listener = null),
  };
  const tui = new Tui({
    promptLabel: "you > ",
    out,
    inp,
    docs: docSource(paths, (edit) => panelWriteDoc(ctx, edit)),
  });
  tui.start();
  tui.question();
  return {
    send: (bytes) => listener?.(bytes),
    frame: () => stripAnsi(writes[writes.length - 1] ?? ""),
    stop: () => tui.stop(),
  };
}

/** Wait for something the panel does off a real filesystem read: unlike the
 *  faked sources in the tui tests, these settle on the thread pool's clock. */
async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Open the panel on a doc and press `e`, waiting out each real read. */
async function openEditorOn(h: { send(b: string): void; frame(): string }, name: string): Promise<void> {
  h.send("\x0f"); // Ctrl-O
  await waitFor(() => h.frame().includes(name), "the docs list");
  h.send("a"); // the first (and only) doc
  await waitFor(() => h.frame().includes(`docs · ${name}`), "the open doc");
  h.send("e");
  await waitFor(() => h.frame().includes("┌"), "the editor");
}

test("end to end: Ctrl-O, open a doc, edit it, Ctrl-S — the file on disk changes", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    await createDoc(paths, "plan.md", "# Plan\n\nold body\n");
    const ctx = context(paths);
    const h = panel(paths, ctx);

    await openEditorOn(h, "plan.md");
    h.send("NEW "); // types at the head of the buffer
    h.send("\x13"); // Ctrl-S
    await waitFor(() => !h.frame().includes("┌"), "the popup to close on a landed save");

    assert.equal(
      await readFile(paths.docFile("plan.md"), "utf8"),
      "NEW # Plan\n\nold body\n",
      "the real file holds what was typed",
    );
    assert.match(h.frame(), /saved docs\/plan\.md/, "with a receipt on the tab");
    assert.equal(ctx.historyNotes.length, 1);
    assert.match(ctx.historyNotes[0]!, /docs\/plan\.md/);
    h.stop();
  } finally {
    await cleanup();
  }
});

test("end to end: Esc leaves the file byte-identical", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    await createDoc(paths, "plan.md", "# Plan\n\nold body\n");
    const before = await readFile(paths.docFile("plan.md"));
    const ctx = context(paths);
    const h = panel(paths, ctx);

    await openEditorOn(h, "plan.md");
    h.send("a whole new plan");
    h.send("\x1b"); // warns
    assert.match(h.frame(), /Esc again to discard/);
    h.send("\x1b"); // discards
    await waitFor(() => !h.frame().includes("┌"), "the popup to close");

    assert.deepEqual(await readFile(paths.docFile("plan.md")), before, "not one byte moved");
    assert.deepEqual(ctx.historyNotes, [], "and the model was told nothing");
    h.stop();
  } finally {
    await cleanup();
  }
});

test("end to end: a doc the co rewrote mid-edit is refused, and both texts survive", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    await createDoc(paths, "plan.md", "# Plan\n\nold body\n");
    const ctx = context(paths);
    const h = panel(paths, ctx);

    await openEditorOn(h, "plan.md");
    h.send("captain's line. ");

    // The co writes the same doc through its own tool while the popup is open.
    await overwriteDoc(paths, "plan.md", "# Plan\n\nthe co's rewrite\n");

    h.send("\x13"); // Ctrl-S
    await waitFor(() => h.frame().includes("changed on disk"), "the refusal");

    assert.equal(
      await readFile(paths.docFile("plan.md"), "utf8"),
      "# Plan\n\nthe co's rewrite\n",
      "the co's write is not clobbered",
    );
    const frame = h.frame();
    assert.match(frame, /changed on disk/, "the popup says so");
    assert.match(frame, /captain's line\./, "with the captain's text still in it");
    assert.deepEqual(ctx.historyNotes, [], "nothing was written, so nothing is announced");
    h.stop();
  } finally {
    await cleanup();
  }
});
