import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Tui,
  type InStream,
  type OutStream,
  type PrMessageSaveResult,
  type QueueHeadDetail,
  type QueuePanelSource,
  type QueuePanelView,
} from "./tui.js";
import { stripAnsi } from "./wrap.js";
import { EVIDENCE_CLOSE, EVIDENCE_OPEN, splitEvidence } from "../session/forge.js";

/**
 * The in-panel PR message editor (D-20260727-15), driven the way a captain
 * drives it: raw bytes in one end, painted frames and calls into the injected
 * source out the other.
 *
 * What these pin is the behaviour that would be expensive to discover at a real
 * terminal: that `e` only opens over a head that HAS a pull request, that the
 * buffer holds the prose and never co's evidence fence, that Ctrl-S sends the
 * split title and body and nothing else, that a refusal or a gh failure leaves
 * the captain's text exactly where it was — and that none of it merges anything.
 *
 * The popup's actual LOOK on a real terminal (the box, the caret's blink, how it
 * feels to type in) is not something a frame diff can judge; that is a hand
 * check. What is asserted here is what is on the screen and what was called.
 */

process.setMaxListeners(0);

const CTRL_O = "\x0f";
const CTRL_S = "\x13";
const CTRL_E = "\x05";
const CTRL_A = "\x01";
const CTRL_K = "\x0b";
const CTRL_U = "\x15";
const CTRL_G = "\x07";
const CTRL_X = "\x18";
const CTRL_Y = "\x19";
const ESC = "\x1b";
const BACKSPACE = "\x7f";
const DEL = "\x1b[3~";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";

const PROSE = "Adds the saved-card path so a returning customer can pay in one tap.";
const EVIDENCE = `${EVIDENCE_OPEN}\n### Checks\n**green** — 2 checks passed.\n${EVIDENCE_CLOSE}`;
const BODY = `${PROSE}\n\n${EVIDENCE}\n`;

const VIEW: QueuePanelView = {
  size: 2,
  head: null,
  entries: [
    { feature: "checkout", position: 1, isHead: true, status: "ready", commitsReady: 2 },
    { feature: "search", position: 2, isHead: false, status: "queued" },
  ],
};

function readyDetail(overrides: Partial<QueueHeadDetail> = {}): QueueHeadDetail {
  return {
    kind: "ready",
    feature: "checkout",
    target: "dev",
    commits: ["abc1234 job: the card form"],
    checks: {
      verdict: "passed",
      ungated: false,
      requiredOnly: false,
      total: 2,
      passed: 2,
      failed: 0,
      pending: 0,
      skipped: 0,
      runs: [],
      ms: 10,
    },
    pr: {
      number: 42,
      url: "https://github.com/acme/repo/pull/42",
      title: "feat: stripe checkout",
      body: BODY,
      prose: splitEvidence(BODY).prose,
    },
    ...overrides,
  } as QueueHeadDetail;
}

interface EditQueue extends QueuePanelSource {
  /** Every message Ctrl-S sent, in order. */
  edits: { title: string; body: string; prNumber: number }[];
  merges: number;
  /** Settle the in-flight save. */
  resolveEdit(res: PrMessageSaveResult): void;
  rejectEdit(e: Error): void;
  setDetail(d: QueueHeadDetail | null): void;
}

/** A queue source whose save the test settles by hand, so the in-flight window
 *  (and the fire-once lockout over it) is observable. */
function editQueue(detail: QueueHeadDetail | null = readyDetail(), wired = true): EditQueue {
  let cur = detail;
  let settle: ((r: PrMessageSaveResult) => void) | null = null;
  let fail: ((e: Error) => void) | null = null;
  const api: EditQueue = {
    edits: [],
    merges: 0,
    view: () => VIEW,
    headDetail: () => cur,
    merge: () => {
      api.merges++;
      return Promise.resolve({ merged: true, summary: "merged" });
    },
    resolveEdit: (res) => settle?.(res),
    rejectEdit: (e) => fail?.(e),
    setDetail: (d) => (cur = d),
  };
  if (wired) {
    api.editPrMessage = (message): Promise<PrMessageSaveResult> => {
      api.edits.push(message);
      return new Promise((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
    };
  }
  return api;
}

interface Harness {
  tui: Tui;
  send(bytes: string): void;
  /** Resize the terminal the way SIGWINCH does. */
  resize(cols: number, rows: number): void;
  /** The last painted frame with ANSI stripped — one long line, since a panel
   *  frame positions every row with a cursor move rather than a newline. Good
   *  for "is this text on screen"; use screen() when the LAYOUT matters. */
  frame(): string;
  /** The last frame laid onto a grid the way a terminal would lay it out, so a
   *  test can read the rows the captain actually sees. */
  screen(): string[];
  /** The raw last frame, for assertions about escape sequences. */
  raw(): string;
  /** Every byte written to the terminal. The OSC 52 clipboard write rides
   *  alongside a frame rather than inside one. */
  writes(): string[];
  stop(): void;
}

/** Replay a frame's cursor moves and text onto a blank grid. Only the sequences
 *  the panel actually emits are interpreted (absolute moves, line clears); every
 *  other escape is styling and is dropped. */
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

function harness(queue: QueuePanelSource, cols = 80, rows = 24): Harness {
  let listener: ((d: string) => void) | null = null;
  const writes: string[] = [];
  const size = { cols, rows };
  const out: OutStream = {
    write: (s) => writes.push(String(s)),
    get columns(): number {
      return size.cols;
    },
    get rows(): number {
      return size.rows;
    },
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
  const tui = new Tui({ promptLabel: "you > ", out, inp, queue });
  tui.start();
  tui.question();
  return {
    tui,
    send: (bytes) => listener?.(bytes),
    resize: (c, r) => {
      size.cols = c;
      size.rows = r;
      process.emit("SIGWINCH");
    },
    frame: () => stripAnsi(writes[writes.length - 1] ?? ""),
    screen: () => render(writes[writes.length - 1] ?? "", size.cols, size.rows),
    raw: () => writes[writes.length - 1] ?? "",
    writes: () => writes,
    stop: () => tui.stop(),
  };
}

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Open the panel on the queue tab and press `e`. */
async function openEditor(q: QueuePanelSource, cols = 80, rows = 24): Promise<Harness> {
  const h = harness(q, cols, rows);
  h.send(CTRL_O);
  await settle();
  h.send("e");
  return h;
}

/**
 * The buffer as the popup is currently painting it: the text between the box's
 * side rails, top to bottom, trailing blank rows dropped. This is what the
 * captain can actually see, so every buffer assertion below reads it rather than
 * reaching into the Tui.
 */
function buffer(h: Harness): string[] {
  const rows: string[] = [];
  for (const line of h.screen()) {
    const m = /│ ?(.*?) *│/.exec(line);
    if (m) rows.push(m[1]!);
  }
  // The last row inside the box is the message line, not buffer text; the blank
  // rows below the end of a short buffer are padding.
  rows.pop();
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

/** The box's top-left corner, read off the painted screen (1-based), so the
 *  tests never restate the geometry the renderer chose. */
function boxCorner(h: Harness): { top: number; left: number } {
  const screen = h.screen();
  for (let r = 0; r < screen.length; r++) {
    const col = screen[r]!.indexOf("┌");
    if (col >= 0) return { top: r + 1, left: col + 1 };
  }
  throw new Error("no box on screen");
}

/** The cell the frame parked the hardware caret on (1-based row, col). */
function caretCell(h: Harness): { row: number; col: number } {
  const m = /\x1b\[(\d+);(\d+)H\x1b\[\?25h$/.exec(h.raw());
  if (!m) throw new Error("the frame did not end by placing the caret");
  return { row: Number(m[1]), col: Number(m[2]) };
}

/** The character the last frame actually painted at a 1-based screen cell. */
function charAt(h: Harness, row: number, col: number): string {
  return h.screen()[row - 1]?.[col - 1] ?? " ";
}

/** The text of the last OSC 52 clipboard write in `writes`, or null. */
function clipboardPayload(writes: string[]): string | null {
  let found: string | null = null;
  for (const w of writes) {
    const m = /\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/.exec(w);
    if (m) found = Buffer.from(m[1]!, "base64").toString("utf8");
  }
  return found;
}

/** A bracketed paste, as a terminal delivers it. */
const paste = (text: string): string => `\x1b[200~${text}\x1b[201~`;

/** SGR 1006 mouse reports, 1-based screen coordinates. */
const mousePress = (x: number, y: number): string => `\x1b[<0;${x};${y}M`;
const mouseDrag = (x: number, y: number): string => `\x1b[<32;${x};${y}M`;
const mouseRelease = (x: number, y: number): string => `\x1b[<0;${x};${y}m`;

// --- opening -----------------------------------------------------------------

test("e opens the head PR's message: title on line 1, a blank line, then the prose", async () => {
  const h = await openEditor(editQueue());
  const rows = buffer(h);
  assert.equal(rows[0], "feat: stripe checkout", "the title is line 1");
  assert.equal(rows[1], "", "and line 2 is the separator");
  assert.ok(rows.slice(2).join(" ").includes("saved-card path"), "the prose follows");
  assert.match(h.frame(), /edit PR #42 · checkout/, "the box says what is being edited");
  h.stop();
});

test("co's evidence fence is nowhere in the editor — it cannot be seen or deleted", async () => {
  const h = await openEditor(editQueue());
  const frame = h.frame();
  for (const marker of [EVIDENCE_OPEN, EVIDENCE_CLOSE, "<!--", "### Checks", "**green**"]) {
    assert.ok(!frame.includes(marker), `the editor never shows ${marker}`);
  }
  h.stop();
});

test("e is a no-op with a stated reason when the head has no pull request", async () => {
  const q = editQueue({
    kind: "blocked",
    feature: "checkout",
    target: "dev",
    reason: "rebase conflict in src/app.ts",
    blockedKind: "conflict",
  });
  const h = await openEditor(q);
  assert.match(h.frame(), /no pull request yet/, "it says why nothing opened");
  assert.ok(!h.frame().includes("Ctrl-S"), "and no editor is on screen");
  h.stop();
});

test("e is a no-op with a stated reason when the session cannot edit a PR", async () => {
  const h = await openEditor(editQueue(readyDetail(), false));
  assert.match(h.frame(), /isn't available in this session/);
  assert.ok(!h.frame().includes("Ctrl-S"));
  h.stop();
});

test("a blocked head whose red checks left a PR can still have its message edited", async () => {
  const q = editQueue({
    kind: "blocked",
    feature: "checkout",
    target: "dev",
    reason: "PR #42: 1 of 2 checks failed",
    blockedKind: "failed",
    pr: {
      number: 42,
      url: "https://github.com/acme/repo/pull/42",
      title: "feat: stripe checkout",
      body: BODY,
      prose: splitEvidence(BODY).prose,
    },
  });
  const h = await openEditor(q);
  assert.match(h.frame(), /edit PR #42/, "the PR exists, so the message is editable");
  h.stop();
});

// --- editing -----------------------------------------------------------------

test("typing, arrows and the line keys all work, with no mode to enter or leave", async () => {
  const h = await openEditor(editQueue());
  h.send(CTRL_E); // end of the title
  h.send(" v2");
  assert.equal(buffer(h)[0], "feat: stripe checkout v2");

  h.send(CTRL_A); // back to the title's start
  h.send("WIP ");
  assert.equal(buffer(h)[0], "WIP feat: stripe checkout v2");

  // The caret is just past "WIP "; walk it one to the right, then delete either
  // side of it to prove both keys act at the caret rather than at an end.
  h.send(RIGHT + RIGHT + LEFT); // net +1, so the caret sits between "WIP f" and "eat"
  h.send(BACKSPACE);
  assert.equal(buffer(h)[0], "WIP eat: stripe checkout v2", "backspace takes the character before it");
  h.send(DEL);
  assert.equal(buffer(h)[0], "WIP at: stripe checkout v2", "Delete takes the character after it");

  h.send(CTRL_U); // kill to line start, from where the caret is
  assert.equal(buffer(h)[0], "at: stripe checkout v2");
  h.send(CTRL_E);
  h.send("!" + CTRL_A + CTRL_K); // to the end, type, then kill the whole line
  assert.equal(buffer(h)[0], "", "Ctrl-K from the line start empties the line, and only it");
  assert.equal(buffer(h)[1], "", "the separator is still there");
  h.stop();
});

test("Enter inserts a newline — it never saves, because a description is prose", async () => {
  const q = editQueue();
  const h = await openEditor(q);
  h.send(CTRL_E);
  h.send("\r"); // Enter
  h.send("second line");
  const rows = buffer(h);
  assert.equal(rows[0], "feat: stripe checkout");
  assert.equal(rows[1], "second line", "the newline landed in the buffer");
  assert.deepEqual(q.edits, [], "and nothing was sent");
  h.stop();
});

test("Up and Down move between rows and clamp at the ends", async () => {
  const h = await openEditor(editQueue());
  h.send(DOWN + DOWN); // title -> blank -> first prose row
  h.send(CTRL_A);
  h.send(">> ");
  assert.match(buffer(h)[2] ?? "", /^>> /, "Down reached the prose");

  h.send(UP + UP + UP + UP + UP); // more ups than there are rows
  h.send(CTRL_A);
  h.send("# ");
  assert.match(buffer(h)[0] ?? "", /^# /, "clamped at the first row rather than wrapping around");
  h.stop();
});

test("Tab does not switch tabs and Ctrl-U does not page: the editor owns the keyboard", async () => {
  const h = await openEditor(editQueue());
  h.send("\t");
  assert.match(h.frame(), /edit PR #42/, "Tab did not leave the editor");
  h.send(CTRL_U);
  assert.match(h.frame(), /edit PR #42/, "and Ctrl-U is a kill, not a page");
  h.stop();
});

test("a mouse report never types its own coordinates into the buffer", async () => {
  const h = await openEditor(editQueue());
  const before = buffer(h);
  h.send(mousePress(10, 5) + mouseDrag(20, 7) + mouseRelease(20, 7));
  assert.deepEqual(buffer(h), before, "not one byte of that reached the buffer as text");
  h.stop();
});

// --- selecting with the mouse ------------------------------------------------
//
// The popup owns the mouse while it is open: a drag selects TEXT inside the
// buffer and copies it out on release. The panel's own drag-select is
// unreachable from here; it resumes the moment the popup closes, which the last
// test in this file pins from the other side.

/** The 1-based screen cell of the first text column of buffer row `r` (0-based,
 *  as painted, i.e. after any scroll). */
function textCell(h: Harness, r: number, col = 0): { x: number; y: number } {
  const { top, left } = boxCorner(h);
  return { x: left + 2 + col, y: top + 1 + r };
}

test("a drag inside the popup selects those characters and copies them on release", async () => {
  const h = await openEditor(editQueue(), 80, 24);
  // The selection is caret-based, the way it is in any text editor: the drag
  // runs BETWEEN characters, so ending on column 4 takes the first four.
  const from = textCell(h, 0, 0); // the title row
  const to = textCell(h, 0, 4);
  const before = h.writes().length;

  h.send(mousePress(from.x, from.y));
  h.send(mouseDrag(to.x, to.y));
  assert.match(h.raw(), /\x1b\[7mfeat\x1b\[27m/, "the dragged characters are highlighted");

  h.send(mouseRelease(to.x, to.y));
  assert.equal(clipboardPayload(h.writes().slice(before)), "feat", "and they are on the clipboard");
  assert.match(messageLine(h), /copied 1 line/, "with a receipt naming what was sent");
  assert.match(messageLine(h), /allow clipboard access/, "and the OSC 52 caveat");
  h.stop();
});

test("a multi-row drag takes the line breaks with it", async () => {
  const h = await openEditor(editQueue(), 80, 24);
  const from = textCell(h, 0, 0);
  const to = textCell(h, 2, 4); // through the separator into the prose
  const before = h.writes().length;
  h.send(mousePress(from.x, from.y));
  h.send(mouseDrag(to.x, to.y));
  h.send(mouseRelease(to.x, to.y));
  assert.equal(
    clipboardPayload(h.writes().slice(before)),
    "feat: stripe checkout\n\nAdds",
    "the blank separator line is a real newline in the clipboard, not a gap",
  );
  h.stop();
});

test("typing over a selection replaces it, which is how a body is swapped wholesale", async () => {
  const h = await openEditor(editQueue(), 80, 24);
  const from = textCell(h, 0, 0);
  const to = textCell(h, 0, 4);
  h.send(mousePress(from.x, from.y));
  h.send(mouseDrag(to.x, to.y));
  h.send(mouseRelease(to.x, to.y));
  h.send("fix");
  assert.equal(buffer(h)[0], "fix: stripe checkout", "the selected run went, the typed text took its place");
  h.stop();
});

test("a bare click moves the caret and copies nothing", async () => {
  const h = await openEditor(editQueue(), 80, 24);
  const at = textCell(h, 0, 5);
  const before = h.writes().length;
  h.send(mousePress(at.x, at.y));
  h.send(mouseRelease(at.x, at.y));
  assert.equal(clipboardPayload(h.writes().slice(before)), null, "nothing was copied");
  h.send("|");
  assert.equal(buffer(h)[0], "feat:| stripe checkout", "but the caret moved to where it was clicked");
  h.stop();
});

test("a click outside the box drops the selection and starts no new one", async () => {
  const h = await openEditor(editQueue(), 80, 24);
  const from = textCell(h, 0, 0);
  h.send(mousePress(from.x, from.y));
  h.send(mouseDrag(from.x + 4, from.y));
  h.send(mouseRelease(from.x + 4, from.y));
  assert.match(h.raw(), /\x1b\[7m/, "something is selected");

  const before = h.writes().length;
  h.send(mousePress(1, 1)); // the tab bar, well outside the popup
  h.send(mouseRelease(1, 1));
  assert.ok(!h.raw().includes("\x1b[7mfeat"), "the selection is gone");
  assert.equal(clipboardPayload(h.writes().slice(before)), null, "and nothing was copied by it");
  h.stop();
});

test("a drag off the bottom edge scrolls, so a selection can outrun the window", async () => {
  const long = Array.from({ length: 60 }, (_, i) => `paragraph line ${i}`).join("\n");
  const q = editQueue(
    readyDetail({
      pr: { number: 42, url: "u", title: "a title", body: `${long}\n\n${EVIDENCE}\n`, prose: long },
    } as Partial<QueueHeadDetail>),
  );
  const h = await openEditor(q, 80, 24);
  const start = textCell(h, 0, 0);
  const { top } = boxCorner(h);
  const belowBox = top + 40; // well past the bottom border, as a real drag runs

  const before = h.writes().length;
  h.send(mousePress(start.x, start.y));
  for (let n = 0; n < 30; n++) h.send(mouseDrag(start.x + 8, belowBox));
  const rows = buffer(h);
  assert.ok(!rows.includes("a title"), "the viewport scrolled under the drag");
  assert.ok(rows.some((r) => /^paragraph line 2\d$/.test(r)), `it is deep in the body: ${rows[0]}`);

  h.send(mouseRelease(start.x + 8, belowBox));
  const copied = clipboardPayload(h.writes().slice(before)) ?? "";
  assert.match(copied, /^a title\n\nparagraph line 0\n/, "the selection starts where the drag did");
  assert.ok(copied.split("\n").length > 20, `and runs past one screenful: ${copied.split("\n").length} lines`);
  h.stop();
});

test("the wheel scrolls the popup, caret and all", async () => {
  const long = Array.from({ length: 60 }, (_, i) => `paragraph line ${i}`).join("\n");
  const q = editQueue(
    readyDetail({
      pr: { number: 42, url: "u", title: "a title", body: `${long}\n\n${EVIDENCE}\n`, prose: long },
    } as Partial<QueueHeadDetail>),
  );
  const h = await openEditor(q, 80, 24);
  assert.equal(buffer(h)[0], "a title", "it opens at the top");
  for (let n = 0; n < 8; n++) h.send("\x1b[<65;20;10M"); // wheel down
  assert.ok(!buffer(h).includes("a title"), "the top scrolled away");
  assert.ok(buffer(h).some((r) => r.startsWith("paragraph line ")), "and the body is under the window");
  const cell = caretCell(h);
  const { top } = boxCorner(h);
  assert.ok(cell.row > top, "the caret came with it and is still inside the box");
  for (let n = 0; n < 40; n++) h.send("\x1b[<64;20;10M"); // wheel back up
  assert.equal(buffer(h)[0], "a title", "and back to the top, clamped");
  h.stop();
});

// --- pasting -----------------------------------------------------------------

test("a multi-line paste lands as literal text: no Enter, no submit, no truncation", async () => {
  const q = editQueue();
  const h = await openEditor(q, 80, 24);
  h.send(CTRL_G); // select the whole message
  const body = ["## What", "", "- swapped the card form out", "- kept the old path behind a flag"].join("\n");
  h.send(paste(`replacement title\n\n${body}`));

  const rows = buffer(h);
  assert.equal(rows[0], "replacement title", "line 1 became the new title");
  assert.equal(rows[2], "## What", "and the pasted body followed it, line for line");
  assert.ok(rows.includes("- swapped the card form out"));
  assert.ok(rows.includes("- kept the old path behind a flag"));
  assert.deepEqual(q.edits, [], "nothing was submitted along the way");
  h.stop();
});

test("a paste split across data events is still one atomic insert", async () => {
  const q = editQueue();
  const h = await openEditor(q, 80, 24);
  h.send(CTRL_G);
  // A real terminal delivers a long paste in chunks; the marker can land in any
  // of them, and the content between can carry anything at all.
  h.send("\x1b[200~one\ntw");
  h.send("o\nthree\r\nfour\rfive");
  h.send("\nsix\x1b[201~");
  const rows = buffer(h);
  assert.deepEqual(
    rows,
    ["one", "two", "three", "four", "five", "six"],
    "every chunk landed in order, with CR and CRLF normalised to real newlines",
  );
  assert.deepEqual(q.edits, [], "and no chunk boundary ever read as Enter");
  h.stop();
});

test("a paste carrying escape sequences inserts their text, never their meaning", async () => {
  const h = await openEditor(editQueue(), 80, 24);
  h.send(CTRL_G);
  // A diff copied out of a coloured terminal, and a stray Ctrl-S in the payload:
  // neither may steer the editor.
  h.send(paste("title\n\n\x1b[31mred\x1b[0m text\x13"));
  assert.equal(buffer(h)[0], "title");
  assert.equal(buffer(h)[2], "[31mred[0m text", "the escapes' text survives; the escapes do not");
  assert.match(h.frame(), /Ctrl-S save/, "and the embedded Ctrl-S did not save");
  h.stop();
});

test("a long paste is not truncated", async () => {
  const q = editQueue();
  const h = await openEditor(q, 80, 24);
  h.send(CTRL_G);
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
  h.send(paste(`t\n\n${lines.join("\n")}`));
  h.send(CTRL_S);
  assert.equal(q.edits.length, 1);
  assert.equal(q.edits[0]!.body, lines.join("\n"), "all 200 lines reached the save, in order");
  q.resolveEdit({ saved: true, summary: "ok" });
  await settle();
  h.stop();
});

// --- select all, clear all, copy ---------------------------------------------

test("Ctrl-G selects the whole buffer and Ctrl-Y copies it out", async () => {
  const h = await openEditor(editQueue(), 80, 24);
  const before = h.writes().length;
  h.send(CTRL_G);
  assert.match(messageLine(h), /3 lines selected/, "the whole message is selected");
  h.send(CTRL_Y);
  assert.equal(
    clipboardPayload(h.writes().slice(before)),
    `feat: stripe checkout\n\n${PROSE}\n`,
    "and the clipboard has the message as the buffer holds it",
  );
  h.stop();
});

test("Ctrl-X clears the whole buffer, and puts what it took on the clipboard", async () => {
  const h = await openEditor(editQueue(), 80, 24);
  const before = h.writes().length;
  h.send(CTRL_X);
  assert.deepEqual(buffer(h), [], "the buffer is empty in one keystroke, not forty");
  assert.equal(
    clipboardPayload(h.writes().slice(before)),
    `feat: stripe checkout\n\n${PROSE}\n`,
    "and nothing was destroyed: it is a cut",
  );
  assert.match(messageLine(h), /cleared · 3 lines on the clipboard/);

  h.send("a fresh title");
  assert.equal(buffer(h)[0], "a fresh title", "and the buffer takes new text straight away");
  h.stop();
});

test("Ctrl-Y with a live selection copies just that, not the buffer", async () => {
  const h = await openEditor(editQueue(), 80, 24);
  const from = textCell(h, 0, 0);
  const to = textCell(h, 0, 4);
  h.send(mousePress(from.x, from.y));
  h.send(mouseDrag(to.x, to.y));
  h.send(mouseRelease(to.x, to.y));
  const before = h.writes().length;
  h.send(CTRL_Y);
  assert.equal(clipboardPayload(h.writes().slice(before)), "feat", "the selection, not the message");
  h.stop();
});

test("select-all then a kill key is still line-scoped: Ctrl-U never wipes the buffer", async () => {
  const h = await openEditor(editQueue(), 80, 24);
  h.send(CTRL_G);
  h.send(CTRL_U); // with everything selected, this is still "kill to line start"
  assert.equal(buffer(h)[0], "feat: stripe checkout", "the title is untouched");
  assert.ok(buffer(h).join(" ").includes("saved-card path"), "and so is the prose");
  h.stop();
});

test("an arrow key collapses a selection rather than dragging it along", async () => {
  const h = await openEditor(editQueue(), 80, 24);
  h.send(CTRL_G);
  assert.match(h.raw(), /\x1b\[7m/, "something is selected");
  h.send(RIGHT);
  assert.ok(!h.raw().includes("\x1b[7mfeat"), "the arrow dropped it");
  h.send("x");
  assert.match(buffer(h)[0] ?? "", /stripe checkout/, "and typing did not eat the message");
  h.stop();
});

// --- the viewport ------------------------------------------------------------

test("the viewport scrolls with the caret on a body taller than the popup", async () => {
  const long = Array.from({ length: 40 }, (_, i) => `paragraph line ${i}`).join("\n");
  const q = editQueue(
    readyDetail({
      pr: {
        number: 42,
        url: "u",
        title: "feat: stripe checkout",
        body: `${long}\n\n${EVIDENCE}\n`,
        prose: long,
      },
    } as Partial<QueueHeadDetail>),
  );
  const h = await openEditor(q, 80, 24);
  assert.equal(buffer(h)[0], "feat: stripe checkout", "it opens at the top");
  assert.ok(!buffer(h).includes("paragraph line 39"), "the far end is off screen");

  for (let n = 0; n < 45; n++) h.send(DOWN);
  const rows = buffer(h);
  assert.ok(rows.includes("paragraph line 39"), "the caret's row scrolled into view");
  assert.ok(!rows.includes("feat: stripe checkout"), "and the top scrolled off");

  for (let n = 0; n < 60; n++) h.send(UP);
  assert.equal(buffer(h)[0], "feat: stripe checkout", "and back again, clamped at the top");
  h.stop();
});

test("a long line soft-wraps for display, and the caret is placed where it looks", async () => {
  // One unbroken 120-character prose line in a 76-column popup: it must wrap for
  // display without a newline entering the buffer.
  const long = `The ${"quick brown fox ".repeat(8)}jumps.`;
  const q = editQueue(
    readyDetail({
      pr: { number: 42, url: "u", title: "t", body: `${long}\n\n${EVIDENCE}\n`, prose: long },
    } as Partial<QueueHeadDetail>),
  );
  const h = await openEditor(q, 80, 24);
  const rows = buffer(h).slice(2);
  assert.ok(rows.length > 1, `the line wrapped: ${JSON.stringify(rows)}`);
  assert.ok(rows.every((r) => r.length <= 72), "no row overflows the box");

  // Walk the caret to a known COLUMN on the first wrapped row, drop down one
  // visual row, and type. The character must land at that same column of the row
  // below — which it can only do if the buffer offset behind the visual position
  // is the right one. (This is the mapping a hard-wrapping editor gets wrong.)
  h.send(DOWN + DOWN); // title -> separator -> the prose's first visual row
  h.send(RIGHT + RIGHT + RIGHT + RIGHT + RIGHT); // column 5
  h.send(DOWN); // same column, one visual row down
  h.send("|");
  const after = buffer(h).slice(2);
  assert.equal(after[1]?.indexOf("|"), 5, `the mark is at column 5 of the second row: ${after[1]}`);
  assert.ok(
    after.join(" ").includes("quick brown fox"),
    "and the words around it are intact — nothing was inserted mid-word by a stale offset",
  );
  assert.ok(
    !buffer(h).some((r, i) => i > 1 && r === ""),
    "the wrap is display-only: no newline entered the buffer",
  );
  h.stop();
});

test("the caret is placed on screen inside the box, and shown", async () => {
  const h = await openEditor(editQueue(), 80, 24);
  // The box's own corner is read back off the painted screen rather than
  // recomputed from the geometry, so this pins the caret against what the
  // captain sees and keeps holding when the popup is resized or moved.
  const { top: boxTop, left: boxLeft } = boxCorner(h);
  const tail = h.raw().slice(h.raw().lastIndexOf("\x1b[?25"));
  assert.match(h.raw(), /\x1b\[\d+;\d+H\x1b\[\?25h$/, `the frame ends by showing the caret: ${tail}`);
  const { row, col } = caretCell(h);
  // Title is line 1 of the buffer and the caret opens at its start, so it must
  // sit on the box's first text row, at the first text column.
  assert.equal(row, boxTop + 1, "first text row of the box");
  assert.equal(col, boxLeft + 2, "first text column of the box");

  h.send(RIGHT + RIGHT + RIGHT);
  const after = caretCell(h);
  assert.equal(after.row, boxTop + 1, "still on the title row");
  assert.equal(after.col, boxLeft + 5, "three columns along");
  h.stop();
});

// --- saving ------------------------------------------------------------------

test("Ctrl-S sends the split title and body, and closes on success", async () => {
  const q = editQueue();
  const h = await openEditor(q);
  h.send(CTRL_E);
  h.send(" v2");
  h.send(CTRL_S);
  assert.deepEqual(
    q.edits,
    [{ title: "feat: stripe checkout v2", body: PROSE, prNumber: 42 }],
    "the title is line 1, the body is the prose (no fence in either), pinned to the PR it opened on",
  );
  assert.match(h.frame(), /writing PR #42/, "the popup says it is in flight");

  q.resolveEdit({ saved: true, summary: "PR #42 message updated: feat: stripe checkout v2" });
  await settle();
  assert.ok(!h.frame().includes("Ctrl-S save"), "the popup closed");
  assert.match(h.frame(), /PR #42 message updated/, "and the queue tab carries the receipt");
  h.stop();
});

test("a save in flight is fire-once: more keys, including Esc, do nothing until it settles", async () => {
  const q = editQueue();
  const h = await openEditor(q);
  h.send(CTRL_S);
  h.send(CTRL_S + CTRL_S);
  h.send("typing while it saves");
  h.send(ESC + ESC);
  assert.equal(q.edits.length, 1, "exactly one write was requested");
  assert.match(h.frame(), /writing PR #42/, "and the popup could not be left mid-write");

  q.resolveEdit({ saved: true, summary: "done" });
  await settle();
  h.stop();
});

test("an empty title is refused before anything is sent, with the buffer intact", async () => {
  const q = editQueue();
  const h = await openEditor(q);
  h.send(CTRL_E);
  h.send(CTRL_U); // wipe the title line
  h.send(CTRL_S);
  assert.deepEqual(q.edits, [], "nothing was sent");
  assert.match(h.frame(), /line 1 is the title and it is empty/, "and it says so");
  h.send("feat: a title after all");
  assert.equal(buffer(h)[0], "feat: a title after all", "the buffer is still there to fix");
  h.send(CTRL_S);
  assert.equal(q.edits.length, 1, "and the fixed message goes through");
  q.resolveEdit({ saved: true, summary: "ok" });
  await settle();
  h.stop();
});

test("a gh failure is visible and non-destructive: the popup stays over the captain's text", async () => {
  const q = editQueue();
  const h = await openEditor(q);
  h.send(CTRL_E);
  h.send(" v2");
  h.send(CTRL_S);
  q.resolveEdit({
    saved: false,
    summary: "the PR message was not written: gh pr edit exited 1",
    error: "gh pr edit 42 exited 1: could not update pull request",
  });
  await settle();
  assert.match(h.frame(), /could not update pull request/, "the failure is on screen");
  assert.equal(buffer(h)[0], "feat: stripe checkout v2", "and the edit is still in the buffer");
  h.send(CTRL_S);
  assert.equal(q.edits.length, 2, "and it can simply be retried");
  q.resolveEdit({ saved: true, summary: "ok" });
  await settle();
  h.stop();
});

test("a thrown save is caught the same way — the panel never wedges on it", async () => {
  const q = editQueue();
  const h = await openEditor(q);
  h.send("x");
  h.send(CTRL_S);
  q.rejectEdit(new Error("gh: network unreachable"));
  await settle();
  assert.match(h.frame(), /network unreachable/);
  assert.match(buffer(h)[0] ?? "", /^xfeat: stripe checkout/, "the buffer survived");
  h.stop();
});

// --- leaving -----------------------------------------------------------------

test("Esc on a clean buffer leaves at once", async () => {
  const h = await openEditor(editQueue());
  h.send(ESC);
  assert.ok(!h.frame().includes("Ctrl-S save"), "the popup closed");
  assert.match(h.frame(), /checkout\s+\[ready\]/, "back on the queue tab");
  h.stop();
});

test("Esc on a dirty buffer warns first, and the second Esc discards", async () => {
  const q = editQueue();
  const h = await openEditor(q);
  h.send(" edited");
  h.send(ESC);
  assert.match(h.frame(), /unsaved changes — Esc again to discard/, "it warns");
  assert.match(buffer(h)[0] ?? "", /^ edited/, "and the text is still there");

  h.send(ESC);
  assert.ok(!h.frame().includes("Ctrl-S save"), "the second Esc discarded it");
  assert.match(h.frame(), /discarded the unsaved edit to PR #42/, "and says what it did");
  assert.deepEqual(q.edits, [], "nothing was ever written");
  h.stop();
});

test("any other key disarms the discard warning", async () => {
  const h = await openEditor(editQueue());
  h.send("edited");
  h.send(ESC);
  assert.match(h.frame(), /Esc again to discard/);
  h.send("x"); // a keystroke that isn't Escape
  h.send(ESC);
  assert.match(h.frame(), /Esc again to discard/, "the warning starts over rather than discarding");
  assert.match(buffer(h)[0] ?? "", /^editedxfeat/, "and the buffer is intact");
  h.stop();
});

// --- what it must NOT do -----------------------------------------------------

test("nothing in the editor merges anything, and [m] is untouched by it", async () => {
  const q = editQueue();
  const h = await openEditor(q);
  h.send("m"); // inside the editor this is a character, not the merge key
  assert.equal(q.merges, 0, "m typed in the buffer merges nothing");
  assert.match(buffer(h)[0] ?? "", /^mfeat:/, "it is just text");
  h.send(CTRL_S);
  q.resolveEdit({ saved: true, summary: "PR #42 message updated" });
  await settle();
  assert.equal(q.merges, 0, "and saving merged nothing either");

  // Back on the queue tab, [m] is exactly where it was.
  h.send("m");
  assert.equal(q.merges, 1, "the merge key still merges, on its own deliberate press");
  h.stop();
});

test("a paste that lands on the queue tab is swallowed, not typed as panel keys", async () => {
  // Pasting into the panel is a normal gesture now that the editor takes one, so
  // a paste that misses the popup must not be read as keystrokes: `m` is the
  // merge on this tab, and a pasted paragraph carrying one would merge the head.
  const q = editQueue();
  const h = harness(q);
  h.send(CTRL_O);
  await settle();
  h.send(paste("fix the merge path so m stops meaning merge"));
  assert.equal(q.merges, 0, "nothing merged");
  assert.match(h.frame(), /checkout\s+\[ready\]/, "and the tab is where it was");

  // Split across data events, the way a long one really arrives.
  h.send("\x1b[200~more text with an m in it");
  h.send(" and a q and an e\x1b[201~");
  assert.equal(q.merges, 0, "still nothing merged");
  assert.match(h.frame(), /checkout\s+\[ready\]/, "the panel did not close and no editor opened");

  // And the tab's own keys still work immediately afterwards.
  h.send("m");
  assert.equal(q.merges, 1, "a real keypress still merges");
  h.stop();
});

test("the queue tab advertises e only when the head has a PR to edit", async () => {
  const withPr = harness(editQueue());
  withPr.send(CTRL_O);
  await settle();
  assert.match(withPr.frame(), /e edit message/, "the footer offers it");
  withPr.stop();

  const withoutPr = harness(
    editQueue({ kind: "blocked", feature: "checkout", target: "dev", reason: "no gh on PATH" }),
  );
  withoutPr.send(CTRL_O);
  await settle();
  assert.ok(!withoutPr.frame().includes("e edit message"), "and never offers it where it wouldn't fire");
  withoutPr.stop();
});

test("a resize re-lays the popup out and keeps the caret's text, not just its offset", async () => {
  const long = "One paragraph that re-wraps when the terminal narrows under it.";
  const q = editQueue(
    readyDetail({
      pr: { number: 42, url: "u", title: "a title", body: `${long}\n\n${EVIDENCE}\n`, prose: long },
    } as Partial<QueueHeadDetail>),
  );
  const h = await openEditor(q, 80, 24);
  assert.equal(buffer(h).slice(2).length, 1, "it fits one row at 80 columns");

  h.resize(46, 16);
  const narrow = buffer(h).slice(2);
  assert.ok(narrow.length > 1, `it re-wrapped at 46 columns: ${JSON.stringify(narrow)}`);
  assert.equal(narrow.join(" ").replace(/\s+/g, " ").trim(), long, "with every word still there");

  // The buffer survived the resize by identity — the caret is where it was (the
  // title it opened on), and typing still lands in the same text.
  h.send(CTRL_E);
  h.send("!");
  assert.equal(buffer(h)[0], "a title!", "the caret never moved out from under the captain");
  assert.equal(
    buffer(h).slice(2).join(" ").replace(/\s+/g, " ").trim(),
    long,
    "and the re-wrapped prose is untouched by the edit",
  );
  h.stop();
});

/**
 * The resize case, stated properly.
 *
 * The previous version of this test resized a ONE-ROW body with the caret still
 * on the title, which can pass while both the caret mapping and the viewport are
 * wrong, because nothing had scrolled and nothing had re-wrapped under the caret. This
 * one loads a body far longer than the window, drives the caret deep into it so
 * the viewport HAS scrolled, and then narrows the terminal so every row re-wraps
 * under it. Three things then have to hold at once: the caret's buffer offset is
 * untouched, the caret is painted exactly where that offset now appears, and the
 * viewport has followed it. Anything less passes on a broken editor.
 */
test("a resize keeps the caret's offset, its painted cell and the viewport, on a long body", async () => {
  // Lines long enough to wrap at 46 columns and not at 80, so the resize really
  // re-lays every row rather than just moving the box.
  const long = Array.from(
    { length: 60 },
    (_, i) => `paragraph ${i} ${"filler word ".repeat(4)}end`,
  ).join("\n");
  const q = editQueue(
    readyDetail({
      pr: { number: 42, url: "u", title: "a title", body: `${long}\n\n${EVIDENCE}\n`, prose: long },
    } as Partial<QueueHeadDetail>),
  );
  const h = await openEditor(q, 80, 24);

  // Drive the caret well past the first screenful, then park it at the start of
  // a logical line and mark it. A line start is a row start at EVERY width, so
  // the marker's painted column is a fact the test can hold the caret to.
  for (let n = 0; n < 30; n++) h.send(DOWN);
  h.send(CTRL_A);
  h.send("◇");
  assert.ok(
    buffer(h).some((r) => r.startsWith("◇")),
    "the caret's row is on screen before the resize",
  );
  assert.ok(!buffer(h).includes("a title"), "and the viewport has genuinely scrolled off the top");

  h.resize(46, 16);

  // 1. The viewport followed the caret through the re-wrap.
  const box = boxCorner(h);
  const marked = buffer(h).findIndex((r) => r.startsWith("◇"));
  assert.ok(marked >= 0, `the caret's text is still on screen after the resize: ${JSON.stringify(buffer(h))}`);

  // 2. The caret is painted exactly where its offset appears: the marker sits in
  //    the cell immediately before it.
  const cell = caretCell(h);
  assert.equal(charAt(h, cell.row, cell.col - 1), "◇", "the caret is right after the marker it typed");
  assert.equal(cell.col - 1, box.left + 2, "which is the first text column, because it is a line start");
  assert.equal(cell.row, box.top + 1 + marked, "and on the box row that marker was painted on");

  // 3. The buffer offset never moved: the next character lands against the mark.
  h.send("◆");
  assert.ok(
    buffer(h).some((r) => r.startsWith("◇◆")),
    `typing after the resize landed at the caret: ${JSON.stringify(buffer(h))}`,
  );
  h.send(CTRL_S);
  const sent = q.edits[0]!;
  assert.equal(sent.body.split("◇◆").length - 1, 1, "exactly one mark, so nothing was inserted twice");
  const at = /\n◇◆paragraph (\d+) /.exec(sent.body);
  assert.ok(at, `the mark is at the start of the line the caret was on: ${sent.body.slice(0, 200)}`);
  assert.ok(Number(at[1]) > 20, `and that line is deep in the body, not near the top (got ${at[1]})`);
  assert.equal(sent.body.match(/^paragraph \d+ /gm)?.length, 59, "the other 59 lines are untouched");
  q.resolveEdit({ saved: true, summary: "ok" });
  await settle();
  h.stop();
});

test("a selection survives a resize, because it is anchored in the text and not on the screen", async () => {
  const long = Array.from({ length: 40 }, (_, i) => `paragraph ${i} ${"filler ".repeat(5)}end`).join("\n");
  const q = editQueue(
    readyDetail({
      pr: { number: 42, url: "u", title: "a title", body: `${long}\n\n${EVIDENCE}\n`, prose: long },
    } as Partial<QueueHeadDetail>),
  );
  const h = await openEditor(q, 80, 24);
  h.send(CTRL_G); // select the whole message
  h.resize(52, 18);
  assert.match(h.raw(), /\x1b\[7m/, "it is still highlighted at the new width");
  assert.match(messageLine(h), /lines selected/, "and still reported as a selection");

  // And it is still the RIGHT text: typing replaces the whole thing.
  h.send("replaced");
  assert.deepEqual(buffer(h), ["replaced"], "the selection that survived was the whole buffer");
  h.stop();
});

test("Ctrl-O takes the editor's own exit rather than closing the panel over an unsaved buffer", async () => {
  const q = editQueue();
  const h = await openEditor(q);
  h.send("edited");
  h.send(CTRL_O);
  assert.match(h.frame(), /Esc again to discard/, "it warns exactly as Esc does");
  h.send(CTRL_O);
  assert.ok(!h.frame().includes("Ctrl-S save"), "the second discards the buffer");
  assert.match(h.frame(), /checkout\s+\[ready\]/, "landing back on the queue tab, panel still open");
  assert.deepEqual(q.edits, []);
  h.stop();
});

test("the panel's own drag-select resumes the moment the popup closes", async () => {
  // The handoff, from the other side: while the popup is open the panel's drag
  // handler is unreachable, and closing it must hand the mouse straight back
  // rather than leave both handlers live or neither.
  const h = await openEditor(editQueue(), 80, 24);
  h.send(ESC); // clean buffer: leaves at once, back on the queue tab

  const row = h.screen().findIndex((r) => r.includes("checkout")) + 1; // 1-based
  assert.ok(row > 1, "the queue tab is painted underneath");
  const text = h.screen()[row - 1]!;
  const before = h.writes().length;
  h.send(mousePress(3, row));
  h.send(mouseDrag(12, row));
  h.send(mouseRelease(12, row));
  const copied = clipboardPayload(h.writes().slice(before));
  assert.equal(copied, text.slice(2, 12), "the panel copied the cells that were dragged over");
  assert.match(h.frame(), /copied 1 line/, "with the panel's own receipt in the footer");
  h.stop();
});

test("the popup fits a small terminal without covering the tab bar or the footer", async () => {
  const h = await openEditor(editQueue(), 40, 12);
  const lines = h.frame().split("\n").filter((l) => l.trim() !== "");
  assert.ok(h.frame().includes("┌"), "the box is drawn");
  assert.ok(h.frame().includes("└"), "and closed");
  assert.ok(
    lines.some((l) => l.includes("queue · edit PR #42")),
    "the tab bar still names what is open",
  );
  assert.match(h.frame(), /Ctrl-S/, "and the keys are still legible");
  h.stop();
});
