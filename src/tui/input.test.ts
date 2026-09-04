import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ESC_ESC_WINDOW_MS,
  Tui,
  inputRowStarts,
  type InStream,
  type OutStream,
} from "./tui.js";

/**
 * End-to-end tests for the multi-line input box: raw bytes in one end, the
 * submitted message out the other, driving the real Tui with fake streams.
 *
 * This is deliberately not a unit test of the decode table (keys.test.ts covers
 * that) — the thing worth pinning down is that a keypress travels the whole
 * path (parse → action → buffer → submit) without the message being mangled or
 * sent early.
 */

// Each Tui registers process-level exit hooks; a file full of them would trip
// the listener-leak warning.
process.setMaxListeners(0);

const PROMPT = "you > "; // 6 visible columns

interface Harness {
  tui: Tui;
  send(bytes: string): void;
  lastFrame(): string;
  allOutput(): string;
  /** Move the injected clock forward, for the esc-esc window. */
  advance(ms: number): void;
  stop(): void;
}

function harness(cols = 40, rows = 12): Harness {
  let listener: ((d: string) => void) | null = null;
  const writes: string[] = [];
  // A clock the test drives: esc-esc's window is the only thing that reads it,
  // and a real sleep is the one way to make that test flaky.
  let clock = 1_000_000;

  const out: OutStream = { write: (s) => writes.push(s), columns: cols, rows };
  const inp: InStream = {
    isTTY: true,
    setRawMode: () => {},
    resume: () => {},
    pause: () => {},
    setEncoding: () => {},
    on: (_e, l) => (listener = l),
    removeListener: () => (listener = null),
  };

  const tui = new Tui({ promptLabel: PROMPT, out, inp, now: () => clock });
  tui.start();
  return {
    tui,
    send: (bytes) => listener?.(bytes),
    lastFrame: () => writes[writes.length - 1] ?? "",
    allOutput: () => writes.join(""),
    advance: (ms) => {
      clock += ms;
    },
    stop: () => tui.stop(),
  };
}

/** The exact OSC 52 payload a clipboard write of `text` would carry. */
function osc52For(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

/** Every OSC 52 write made so far, decoded back to the text it carried. */
function clipboardWrites(h: Harness): string[] {
  return [...h.allOutput().matchAll(/\x1b\]52;c;([^\x07]*)\x07/g)].map((m) =>
    Buffer.from(m[1]!, "base64").toString("utf8"),
  );
}

/** Type `bytes`, then press Enter, and return the message the session receives. */
async function submitAfter(bytes: string, h = harness()): Promise<string | null> {
  const answer = h.tui.question();
  h.send(bytes);
  h.send("\r");
  const line = await answer;
  h.stop();
  return line;
}

// --- wrapping ---------------------------------------------------------------

test("input wrapping breaks at spaces and tracks row starts", () => {
  assert.deepEqual(inputRowStarts("", 10), [0]);
  assert.deepEqual(inputRowStarts("short", 10), [0]);
  // Break after the space so "world" stays whole.
  assert.deepEqual(inputRowStarts("hello world", 8), [0, 6]);
  // A single word longer than the row is hard-split at the column edge.
  assert.deepEqual(inputRowStarts("abcdefghijkl", 5), [0, 5, 10]);
});

test("a newline ends its row unconditionally", () => {
  // The "\n" is the last character of the row it terminates, so the next row
  // starts just past it.
  assert.deepEqual(inputRowStarts("a\nb", 40), [0, 2]);
  assert.deepEqual(inputRowStarts("a\nb\nc", 40), [0, 2, 4]);
  // A trailing newline opens a real (empty) row for the cursor to sit on.
  assert.deepEqual(inputRowStarts("a\n", 40), [0, 2]);
  // Consecutive newlines are blank rows, not collapsed.
  assert.deepEqual(inputRowStarts("\n\n", 40), [0, 1, 2]);
  // Wrapping still applies within each logical line.
  assert.deepEqual(inputRowStarts("hello world\nx", 8), [0, 6, 12]);
});

// --- submit vs. compose -----------------------------------------------------

test("plain Enter still submits", async () => {
  assert.equal(await submitAfter("hello"), "hello");
});

test("Enter with no pending read queues the line rather than dropping it", async () => {
  const h = harness();
  h.send("stray\r"); // nobody is reading yet: this queues
  const answer = h.tui.question();
  // Delivered exactly once, whole, to the read that follows. It used to sit in
  // the buffer waiting for a second Enter; it is now the answer to this read.
  // The queue's own behaviour is pinned in queued.test.ts.
  assert.equal(await answer, "stray");
  h.stop();
});

test("Shift+Enter (Kitty CSI-u) inserts a newline instead of submitting", async () => {
  assert.equal(await submitAfter("a\x1b[13;2ub"), "a\nb");
});

test("Ctrl+Enter and Alt+Enter also compose", async () => {
  assert.equal(await submitAfter("a\x1b[13;5ub"), "a\nb");
  assert.equal(await submitAfter("a\x1b[13;3ub"), "a\nb");
});

test("Ctrl-J is the fallback newline on terminals with no enhanced protocol", async () => {
  assert.equal(await submitAfter("a\nb"), "a\nb");
});

test("Alt+Enter as an ESC-prefixed CR composes, and never submits", async () => {
  assert.equal(await submitAfter("a\x1b\rb"), "a\nb");
  assert.equal(await submitAfter("a\x1b\nb"), "a\nb");
});

test("xterm modifyOtherKeys Shift+Enter composes", async () => {
  assert.equal(await submitAfter("a\x1b[27;2;13~b"), "a\nb");
});

test("Ctrl-J under the Kitty protocol still composes", async () => {
  // With the protocol on, the terminal disambiguates Ctrl-J away from LF.
  assert.equal(await submitAfter("a\x1b[106;5ub"), "a\nb");
});

test("a multi-line message reaches the session with its newlines intact", async () => {
  const msg = await submitAfter("line one\x1b[13;2uline two\x1b[13;2uline three");
  assert.equal(msg, "line one\nline two\nline three");
  assert.equal(msg?.split("\n").length, 3);
});

test("a trailing Shift+Enter leaves the newline in the message", async () => {
  assert.equal(await submitAfter("a\x1b[13;2u"), "a\n");
});

// --- rendering --------------------------------------------------------------

test("a multi-line buffer paints one row per line, hanging under the prompt", () => {
  const h = harness();
  h.tui.question();
  h.send("aa\x1b[13;2ubb");
  const frame = h.lastFrame();
  assert.match(frame, /you > aa/);
  assert.match(frame, /\x1b\[\d+;1H\x1b\[2K {6}bb/); // continuation row, hang-indented
  // The literal newline must never be painted: it would break the frame apart.
  const inputRegion = frame.slice(frame.indexOf("you > aa"));
  assert.equal(inputRegion.includes("\n"), false);
  h.stop();
});

test("the input box grows a row per line and the transcript yields it", () => {
  const h = harness(40, 12);
  h.tui.question();
  const before = (h.lastFrame().match(/\x1b\[2K/g) ?? []).length;
  h.send("a\x1b[13;2ub\x1b[13;2uc");
  const frame = h.lastFrame();
  assert.match(frame, /you > a/);
  assert.match(frame, / {6}b/);
  assert.match(frame, / {6}c/);
  // The frame still paints the same number of rows: the two extra input rows
  // come out of the transcript viewport rather than off the bottom of the
  // screen. (12 rows == 10 viewport + separator + 1 input, then 8 + 1 + 3.)
  assert.equal((frame.match(/\x1b\[2K/g) ?? []).length, before);
  assert.equal(before, 12);
  h.stop();
});

test("the submitted turn is echoed as one hang-indented block", async () => {
  const h = harness();
  const answer = h.tui.question();
  h.send("first\x1b[13;2usecond\r");
  await answer;
  const frame = h.lastFrame();
  assert.match(frame, /you > first/);
  assert.match(frame, / {6}second/);
  h.stop();
});

// --- cursor movement across lines -------------------------------------------

test("Up/Down move between input rows before falling through to history", async () => {
  const h = harness();
  const first = h.tui.question();
  h.send("older\r");
  assert.equal(await first, "older");

  const second = h.tui.question();
  h.send("x\x1b[13;2uy");
  h.send("\x1b[A"); // Up: from row 1 to row 0, column preserved
  h.send("Z"); // lands at the end of "x"
  h.send("\x1b[B"); // Down: back to row 1
  h.send("W"); // lands at the end of "y"
  h.send("\r");
  assert.equal(await second, "xZ\nyW");
  h.stop();
});

test("Up on the first row still browses history", async () => {
  const h = harness();
  const first = h.tui.question();
  h.send("remembered\r");
  await first;

  const second = h.tui.question();
  h.send("\x1b[A"); // nothing typed: row 0, so this is a history recall
  h.send("\r");
  assert.equal(await second, "remembered");
  h.stop();
});

// --- line-scoped editing ----------------------------------------------------

test("Ctrl-A/Ctrl-E move within the current line, not the whole buffer", async () => {
  const h = harness();
  const answer = h.tui.question();
  h.send("one\x1b[13;2utwo");
  h.send("\x01"); // Ctrl-A → start of "two", not start of buffer
  h.send("-");
  h.send("\x05"); // Ctrl-E → end of "two"
  h.send("!");
  h.send("\r");
  assert.equal(await answer, "one\n-two!");
  h.stop();
});

test("Ctrl-U kills to the start of the current line only", async () => {
  const h = harness();
  const answer = h.tui.question();
  h.send("keep\x1b[13;2udrop\x15lost");
  h.send("\r");
  assert.equal(await answer, "keep\nlost");
  h.stop();
});

test("the PR editor's buffer-scoped keys do nothing at all to the prompt line", async () => {
  // Ctrl-G/X/Y are bound by the popup's editor. They were unbound bytes here
  // before that, and they stay unbound: no text typed, no buffer cleared, no
  // clipboard write. This is the guard on "the prompt line did not change".
  const h = harness();
  const answer = h.tui.question();
  h.send("keep this line");
  h.send("\x07"); // Ctrl-G
  h.send("\x18"); // Ctrl-X
  h.send("\x19"); // Ctrl-Y
  assert.ok(!h.allOutput().includes("\x1b]52;"), "nothing was sent to the clipboard");
  h.send("\r");
  assert.equal(await answer, "keep this line", "the line is exactly what was typed");
  h.stop();
});

test("Ctrl-K kills to the end of the current line only", async () => {
  const h = harness();
  const answer = h.tui.question();
  h.send("head\x1b[13;2utail");
  h.send("\x01"); // to the start of "tail"
  h.send("\x0b"); // Ctrl-K: removes "tail", keeps the line above
  h.send("\r");
  assert.equal(await answer, "head\n");
  h.stop();
});

test("Backspace deletes the newline and rejoins the lines", async () => {
  const h = harness();
  const answer = h.tui.question();
  h.send("a\x1b[13;2u"); // buffer "a\n", cursor at the end
  h.send("\x7f"); // eat the newline
  h.send("b");
  h.send("\r");
  assert.equal(await answer, "ab");
  h.stop();
});

test("esc-esc clears a multi-line buffer, in both escape encodings", async () => {
  const h = harness();
  const answer = h.tui.question();
  h.send("gone\x1b[13;2ualso gone");
  h.send("\x1b");
  h.send("\x1b[27u"); // the Kitty protocol's spelling of Escape
  h.send("fresh\r");
  assert.equal(await answer, "fresh");
  // And it left the whole buffer, newline included, on the clipboard.
  assert.deepEqual(clipboardWrites(h), ["gone\nalso gone"]);
  h.stop();
});

// --- esc-esc is a CUT --------------------------------------------------------
//
// Driving real bytes through the real input path: the gesture must put the line
// on the clipboard, the window must exclude two presses that aren't one gesture,
// and neither may cost an ESC-prefixed sequence anything.

test("esc-esc cuts the line: the exact text goes to the clipboard, the line goes", async () => {
  const h = harness();
  const answer = h.tui.question();
  h.send("abandon this thought");
  h.send("\x1b");
  h.send("\x1b");

  assert.deepEqual(clipboardWrites(h), ["abandon this thought"], "verbatim, one write");
  assert.ok(
    h.allOutput().includes(osc52For("abandon this thought")),
    "the sequence on the wire is the OSC 52 write for exactly that text",
  );
  assert.match(h.lastFrame(), /cut · 1 line on the clipboard/, "receipted on the separator");
  assert.equal(h.lastFrame().includes("abandon this thought"), false, "the line is gone");

  // Typing after the cut starts from an empty line.
  h.send("something else\r");
  assert.equal(await answer, "something else");
  h.stop();
});

test("esc-esc cuts the EXPANDED text of a collapsed paste, not the chip", async () => {
  // The chip is a display placeholder; a clipboard carrying it back would be the
  // one case where "recoverable by pasting" was untrue.
  const h = harness();
  h.tui.question();
  h.send("\x1b[200~one\ntwo\x1b[201~");
  assert.match(h.lastFrame(), /Pasted text #1 \+2 lines/);
  h.send("\x1b\x1b");
  assert.deepEqual(clipboardWrites(h), ["one\ntwo"]);
  h.stop();
});

test("two Escs further apart than the window are not one gesture", async () => {
  const h = harness();
  const answer = h.tui.question();
  h.send("keep this line");
  h.send("\x1b");
  h.advance(ESC_ESC_WINDOW_MS + 1);
  h.send("\x1b");

  assert.deepEqual(clipboardWrites(h), [], "nothing was sent to the clipboard");
  assert.match(h.lastFrame(), /you > keep this line/, "and the line is untouched");

  // The stale press re-armed rather than being spent, so the next one still cuts.
  h.send("\x1b");
  assert.deepEqual(clipboardWrites(h), ["keep this line"]);
  h.send("second thoughts\r");
  assert.equal(await answer, "second thoughts");
  h.stop();
});

test("a press exactly on the window boundary still counts", () => {
  const h = harness();
  h.tui.question();
  h.send("on the edge");
  h.send("\x1b");
  h.advance(ESC_ESC_WINDOW_MS);
  h.send("\x1b");
  assert.deepEqual(clipboardWrites(h), ["on the edge"]);
  h.stop();
});

test("an ESC-prefixed sequence still parses as its key, armed or not", async () => {
  const h = harness();
  const first = h.tui.question();
  h.send("remembered\r");
  assert.equal(await first, "remembered");

  const answer = h.tui.question();
  h.send("ab");
  h.send("\x1b"); // armed
  h.send("\x1b[D"); // Left: an arrow, not the second half of a gesture
  h.send("X");
  assert.deepEqual(clipboardWrites(h), [], "an arrow key never cuts");

  // The arrow disarmed it, so the ESC that opened it cannot pair with a later one.
  h.send("\x1b");
  h.send("\x1b[A"); // Up: history recall, still a key and not a cut
  assert.deepEqual(clipboardWrites(h), []);
  assert.match(h.lastFrame(), /you > remembered/, "the arrow did what arrows do");

  h.send("\x1b");
  h.send("\x1b"); // now a real gesture, on the recalled line
  assert.deepEqual(clipboardWrites(h), ["remembered"]);
  h.send("aXb\r");
  assert.equal(await answer, "aXb");
  h.stop();
});

test("nothing is deferred: a whole gesture and the next key land in one data event", () => {
  // The proof that the window is a deadline and not a timer. If the first ESC
  // were held back to see what followed it, this one read could not have already
  // cut the line AND typed the next character by the time it returned — and that
  // same hold would sit on the front of every arrow key.
  const h = harness();
  h.tui.question();
  h.send("scratch");
  h.send("\x1b\x1bX");
  assert.deepEqual(clipboardWrites(h), ["scratch"]);
  assert.match(h.lastFrame(), /you > X/);
  h.stop();
});

test("esc-esc on an empty line writes nothing to the clipboard", () => {
  const h = harness();
  h.tui.question();
  // Something worth keeping is put on the clipboard first...
  h.send("worth keeping");
  h.send("\x1b\x1b");
  assert.deepEqual(clipboardWrites(h), ["worth keeping"]);

  // ...and a stray double-tap on the now-empty prompt must not empty it. An
  // OSC 52 write with an empty payload is a real "clear the clipboard".
  h.send("\x1b\x1b");
  h.send("\x1b\x1b");
  assert.deepEqual(clipboardWrites(h), ["worth keeping"], "no second write at all");
  h.stop();
});

test("a single Esc still does nothing on its own", async () => {
  const h = harness();
  const answer = h.tui.question();
  h.send("untouched");
  h.send("\x1b");
  assert.deepEqual(clipboardWrites(h), []);
  assert.match(h.lastFrame(), /you > untouched/);
  h.send("\r");
  assert.equal(await answer, "untouched", "and the line submits as typed");
  h.stop();
});

// --- paste ------------------------------------------------------------------

test("a multi-line paste still collapses to a chip and expands on submit", async () => {
  const h = harness();
  const answer = h.tui.question();
  h.send("\x1b[200~one\ntwo\x1b[201~");
  assert.match(h.lastFrame(), /Pasted text #1 \+2 lines/);
  h.send("\r");
  assert.equal(await answer, "one\ntwo");
  h.stop();
});

test("pasted newlines never submit, even mid-paste", async () => {
  const h = harness();
  const answer = h.tui.question();
  h.send("\x1b[200~a\r\nb\x1b[201~"); // CR inside a paste must not be Enter
  h.send("tail\r");
  assert.equal(await answer, "a\nbtail");
  h.stop();
});

// --- protocol lifecycle -----------------------------------------------------

test("the enhanced keyboard protocol is pushed on start and popped on stop", () => {
  const h = harness();
  assert.match(h.allOutput(), /\x1b\[>1u/, "flags pushed on start");
  const beforeStop = h.allOutput();
  assert.equal(beforeStop.includes("\x1b[<u"), false, "not popped early");

  h.stop();
  const after = h.allOutput();
  assert.equal((after.match(/\x1b\[>1u/g) ?? []).length, 1);
  assert.equal((after.match(/\x1b\[<u/g) ?? []).length, 1, "popped exactly once");
  // The pop must happen while we still own the alternate screen: the Kitty flag
  // stack is per-screen-buffer.
  assert.ok(after.indexOf("\x1b[<u") < after.indexOf("\x1b[?1049l"), "popped before leaving alt");

  h.stop(); // idempotent: a second teardown must not pop someone else's entry
  assert.equal((h.allOutput().match(/\x1b\[<u/g) ?? []).length, 1);
});

test("CO_KEYS=off skips the protocol entirely and Ctrl-J still composes", async () => {
  const prev = process.env.CO_KEYS;
  process.env.CO_KEYS = "off";
  try {
    const h = harness();
    assert.equal(h.allOutput().includes("\x1b[>1u"), false);
    const answer = h.tui.question();
    h.send("a\nb\r");
    assert.equal(await answer, "a\nb");
    h.stop();
    // Nothing was pushed, so nothing may be popped.
    assert.equal(h.allOutput().includes("\x1b[<u"), false);
  } finally {
    if (prev === undefined) delete process.env.CO_KEYS;
    else process.env.CO_KEYS = prev;
  }
});

test("a flag-query reply is swallowed, not typed into the buffer", async () => {
  // Some terminals answer a progressive-enhancement query unprompted; the reply
  // shares the CSI-u final byte and must not become input.
  assert.equal(await submitAfter("a\x1b[?1ub"), "ab");
});
