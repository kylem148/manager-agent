import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Tui,
  type DocSaveResult,
  type DocSource,
  type InStream,
  type OutStream,
} from "./tui.js";
import { stripAnsi } from "./wrap.js";

/**
 * Editing a doc from the Ctrl-O panel: `e` on an open document, the SAME popup
 * the queue tab's `e` opens on a pull request message, saved with the same
 * Ctrl-S and abandoned with the same Esc.
 *
 * What these pin is the part that would be expensive to discover at a real
 * terminal, and the part where a mistake costs the captain a file: that the
 * buffer is the document's raw markdown, that Ctrl-S sends exactly the buffer
 * plus the text it opened on (the baseline the write checks against), that a
 * refusal — a stale baseline, a session with no doc-write surface — leaves the
 * captain's text on screen instead of losing it, and that Esc writes NOTHING at
 * all.
 *
 * The `.memory/` question is not asked here and cannot be: the panel can only
 * ever name a doc its injected source listed, and that source is the sandboxed
 * doc tool. The sandbox itself is proved in memory/docs.test.ts.
 */

process.setMaxListeners(0);

const CTRL_O = "\x0f";
const CTRL_S = "\x13";
const CTRL_X = "\x18";
const CTRL_G = "\x07";
const ESC = "\x1b";
const BACKSPACE = "\x7f";

const PLAN = "# Plan\n\nShip the checkout flow.\n";

interface EditDocs extends DocSource {
  /** Every save Ctrl-S sent, in order. */
  writes: { name: string; content: string; baseline: string }[];
  /** Settle the in-flight save. */
  resolveWrite(res: DocSaveResult): void;
  /** What `read` hands back next (the co rewriting a doc under the captain). */
  set(name: string, content: string): void;
}

/** A doc source whose save the test settles by hand, so the in-flight window
 *  (and the fire-once lockout over it) is observable. */
function editDocs(initial: Record<string, string> = { "plan.md": PLAN }, wired = true): EditDocs {
  const store = new Map(Object.entries(initial));
  let settle: ((r: DocSaveResult) => void) | null = null;
  const api: EditDocs = {
    writes: [],
    list: () => Promise.resolve([...store.keys()].sort()),
    read: (name) => {
      const v = store.get(name);
      return v === undefined ? Promise.reject(new Error(`no doc ${name}`)) : Promise.resolve(v);
    },
    subscribe: () => () => {},
    resolveWrite: (res) => settle?.(res),
    set: (name, content) => store.set(name, content),
  };
  if (wired) {
    api.write = (edit): Promise<DocSaveResult> => {
      api.writes.push(edit);
      return new Promise((resolve) => {
        settle = resolve;
      });
    };
  }
  return api;
}

interface Harness {
  tui: Tui;
  send(bytes: string): void;
  /** The last painted frame with ANSI stripped — one long line, since a panel
   *  frame positions every row with a cursor move rather than a newline. */
  frame(): string;
  /** The last frame laid onto a grid the way a terminal would lay it out. */
  screen(): string[];
  stop(): void;
}

/** Replay a frame's cursor moves and text onto a blank grid. Only the sequences
 *  the panel actually emits are interpreted; every other escape is styling. */
function render(frame: string, cols: number, rows: number): string[] {
  const grid: string[][] = Array.from({ length: rows }, () => Array(cols).fill(" "));
  let row = 0;
  let col = 0;
  for (const token of frame.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    const csi = /^\x1b\[(\d*);?(\d*)([A-Za-z])$/.exec(token);
    if (csi) {
      if (csi[3] === "H") {
        row = (Number(csi[1] || "1") || 1) - 1;
        col = (Number(csi[2] || "1") || 1) - 1;
      }
      continue;
    }
    if (token.startsWith("\x1b")) continue;
    for (const ch of token) {
      if (ch === "\n") {
        row++;
        col = 0;
        continue;
      }
      if (row >= 0 && row < rows && col >= 0 && col < cols) grid[row]![col] = ch;
      col++;
    }
  }
  return grid.map((r) => r.join("").replace(/\s+$/, ""));
}

function harness(docs: DocSource, cols = 80, rows = 24): Harness {
  let listener: ((d: string) => void) | null = null;
  const writes: string[] = [];
  const out: OutStream = {
    write: (s) => writes.push(String(s)),
    columns: cols,
    rows,
  };
  const inp: InStream = {
    isTTY: true,
    setRawMode: () => {},
    resume: () => {},
    pause: () => {},
    setEncoding: () => {},
    on: (_e, l) => (listener = l),
    removeListener: () => (listener = null),
  };
  const tui = new Tui({ promptLabel: "you > ", out, inp, docs });
  tui.start();
  tui.question();
  return {
    tui,
    send: (bytes) => listener?.(bytes),
    frame: () => stripAnsi(writes[writes.length - 1] ?? ""),
    screen: () => render(writes[writes.length - 1] ?? "", cols, rows),
    stop: () => tui.stop(),
  };
}

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Open the panel, open plan.md from the docs list, and press `e`. */
async function openEditor(docs: DocSource, cols = 80, rows = 24): Promise<Harness> {
  const h = harness(docs, cols, rows);
  h.send(CTRL_O);
  await settle();
  h.send("a"); // the first doc in the list
  await settle();
  h.send("e");
  return h;
}

/** The buffer as the popup is currently painting it: the text between the box's
 *  side rails, top to bottom, trailing blank rows dropped. */
function buffer(h: Harness): string[] {
  const rows: string[] = [];
  for (const line of h.screen()) {
    const m = /│ ?(.*?) *│/.exec(line);
    if (m) rows.push(m[1]!);
  }
  rows.pop(); // the last row inside the box is the message line
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return rows;
}

/** The popup's message line: the last row inside the box's side rails. */
function messageLine(h: Harness): string {
  const rows: string[] = [];
  for (const line of h.screen()) {
    const m = /│ ?(.*?) *│/.exec(line);
    if (m) rows.push(m[1]!);
  }
  return rows[rows.length - 1] ?? "";
}

/** Whether the popup is on screen at all. */
const popupOpen = (h: Harness): boolean => h.frame().includes("┌");

// --- opening -----------------------------------------------------------------

test("e on an open doc edits its raw markdown in the popup", async () => {
  const h = await openEditor(editDocs());
  assert.deepEqual(buffer(h), ["# Plan", "", "Ship the checkout flow."], "the file, verbatim");
  assert.match(h.frame(), /edit docs\/plan\.md/, "the box says what is being edited");
  h.stop();
});

test("the doc stays painted under the popup, and the bar still says which tab", async () => {
  // Tall enough that the box (90% of the body) leaves room above it: the point
  // is that the document is still THERE, the way the queue stays visible around
  // the PR editor.
  const h = await openEditor(editDocs(), 80, 60);
  const screen = h.screen();
  assert.match(screen[0]!, /docs · edit docs\/plan\.md/, "the bar names the tab and the edit");
  assert.ok(
    screen.some((r) => r.includes("Ship the checkout flow.") && !r.includes("│")),
    "the rendered doc is still behind the box",
  );
  h.stop();
});

test("e is refused, in words, when the session cannot write docs", async () => {
  const docs = editDocs({ "plan.md": PLAN }, false);
  const h = await openEditor(docs);
  assert.ok(!popupOpen(h), "no editor opened over a doc it could not save");
  assert.match(h.frame(), /editing docs isn't available in this session/);
  assert.equal(docs.writes.length, 0);
  h.stop();
});

test("the footer offers e only where it would fire", async () => {
  const on = harness(editDocs());
  on.send(CTRL_O);
  await settle();
  on.send("a");
  await settle();
  assert.match(on.frame(), /y copy · e edit/, "a writable doc advertises the key");
  on.stop();

  const off = harness(editDocs({ "plan.md": PLAN }, false));
  off.send(CTRL_O);
  await settle();
  off.send("a");
  await settle();
  const footer = off.screen()[off.screen().length - 1] ?? "";
  assert.ok(footer.includes("y copy"), "copying is still offered");
  assert.ok(!footer.includes("e edit"), "editing is not");
  off.stop();
});

// --- saving ------------------------------------------------------------------

test("Ctrl-S sends the buffer and the text it opened on, then repaints from disk", async () => {
  const docs = editDocs();
  const h = await openEditor(docs);
  h.send("NOTE: ");
  h.send(CTRL_S);
  await settle();

  assert.equal(docs.writes.length, 1, "exactly one write");
  assert.deepEqual(docs.writes[0], {
    name: "plan.md",
    content: "NOTE: # Plan\n\nShip the checkout flow.\n",
    baseline: PLAN,
  });
  assert.match(messageLine(h), /writing plan\.md…/, "the box locks while it is in flight");

  // What lands on the tab afterwards is what the SOURCE reads back, not the
  // buffer that was typed.
  docs.set("plan.md", "# Plan\n\nwhat the file really holds now\n");
  docs.resolveWrite({ saved: true, summary: "saved docs/plan.md" });
  await settle();
  await settle();

  assert.ok(!popupOpen(h), "a save that landed closes the popup");
  assert.match(h.frame(), /saved docs\/plan\.md/, "and leaves a receipt");
  assert.match(h.frame(), /what the file really holds now/, "the doc is re-read from the source");
  h.stop();
});

test("a refused save keeps the popup open over the captain's text", async () => {
  const docs = editDocs();
  const h = await openEditor(docs);
  h.send("mine ");
  h.send(CTRL_S);
  await settle();
  docs.resolveWrite({
    saved: false,
    summary: "no",
    error: '"plan.md" changed on disk while it was open. Nothing was written.',
  });
  await settle();

  assert.ok(popupOpen(h), "the popup is still up");
  assert.match(messageLine(h), /changed on disk/, "with the reason in it");
  assert.deepEqual(buffer(h), ["mine # Plan", "", "Ship the checkout flow."], "and the text intact");

  // And it can be retried from exactly where it was left.
  h.send(CTRL_S);
  await settle();
  assert.equal(docs.writes.length, 2);
  h.stop();
});

test("every key is ignored while a save is in flight", async () => {
  const docs = editDocs();
  const h = await openEditor(docs);
  h.send("x");
  h.send(CTRL_S);
  await settle();
  h.send("yyy");
  h.send(CTRL_S);
  h.send(ESC);
  await settle();

  assert.equal(docs.writes.length, 1, "the second Ctrl-S did not fire a second write");
  assert.ok(popupOpen(h), "and Esc did not walk away from one in flight");
  docs.resolveWrite({ saved: true, summary: "saved docs/plan.md" });
  await settle();
  await settle();
  assert.equal(docs.writes[0]!.content, "x# Plan\n\nShip the checkout flow.\n", "no stray keys");
  h.stop();
});

test("an emptied buffer is refused rather than written", async () => {
  const docs = editDocs();
  const h = await openEditor(docs);
  h.send(CTRL_G); // select all
  h.send(CTRL_X); // cut the lot
  h.send(CTRL_S);
  await settle();

  assert.equal(docs.writes.length, 0, "nothing was sent");
  assert.ok(popupOpen(h), "the popup stays up");
  assert.match(messageLine(h), /the buffer is empty — plan\.md was left alone/);
  h.stop();
});

// --- discarding --------------------------------------------------------------

test("Esc discards: nothing is written, and the doc is exactly as it was", async () => {
  const docs = editDocs();
  const h = await openEditor(docs);
  h.send("throwaway edit");
  h.send(BACKSPACE);

  h.send(ESC);
  await settle();
  assert.ok(popupOpen(h), "a dirty buffer warns before it goes");
  assert.match(messageLine(h), /unsaved changes — Esc again to discard/);

  h.send(ESC);
  await settle();
  assert.ok(!popupOpen(h), "the second Esc discards");
  assert.equal(docs.writes.length, 0, "and writes nothing at all");
  assert.match(h.frame(), /discarded the unsaved edit to plan\.md/);
  assert.match(h.frame(), /Ship the checkout flow\./, "the doc is back, unchanged");
  h.stop();
});

test("a clean buffer leaves on the first Esc, still writing nothing", async () => {
  const docs = editDocs();
  const h = await openEditor(docs);
  h.send(ESC);
  await settle();
  assert.ok(!popupOpen(h), "nothing was changed, so there is nothing to warn about");
  assert.equal(docs.writes.length, 0);
  h.stop();
});

test("Ctrl-O leaves through the editor's own exit, not the panel's", async () => {
  const docs = editDocs();
  const h = await openEditor(docs);
  h.send("edited");
  h.send(CTRL_O);
  await settle();
  assert.ok(popupOpen(h), "the panel did not close out from under an unsaved buffer");
  assert.match(messageLine(h), /unsaved changes/);
  assert.equal(docs.writes.length, 0);
  h.stop();
});
