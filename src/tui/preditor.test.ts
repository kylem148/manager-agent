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

test("a mouse drag is swallowed whole: no coordinates typed, no selection behind it", async () => {
  const h = await openEditor(editQueue());
  const before = buffer(h);
  h.send("\x1b[<0;10;5M\x1b[<32;20;7M\x1b[<0;20;7m"); // press, drag, release
  assert.deepEqual(buffer(h), before, "not one byte of that reached the buffer");
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
  // The box is centred; its first text row is one below the top border. The
  // frame ends by parking the hardware cursor there and revealing it.
  const tail = h.raw().slice(h.raw().lastIndexOf("\x1b[?25"));
  assert.match(h.raw(), /\x1b\[\d+;\d+H\x1b\[\?25h$/, `the frame ends by showing the caret: ${tail}`);
  const m = /\x1b\[(\d+);(\d+)H\x1b\[\?25h$/.exec(h.raw())!;
  const row = Number(m[1]);
  const col = Number(m[2]);
  // Title is line 1 of the buffer and the caret opens at its start, so it must
  // sit on the box's first text row, at the first text column.
  const boxTop = 1 + Math.floor((24 - 17) / 2);
  const boxLeft = 1 + Math.floor((80 - 76) / 2);
  assert.equal(row, boxTop + 1, "first text row of the box");
  assert.equal(col, boxLeft + 2, "first text column of the box");

  h.send(RIGHT + RIGHT + RIGHT);
  const after = /\x1b\[(\d+);(\d+)H\x1b\[\?25h$/.exec(h.raw())!;
  assert.equal(Number(after[1]), boxTop + 1, "still on the title row");
  assert.equal(Number(after[2]), boxLeft + 5, "three columns along");
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
