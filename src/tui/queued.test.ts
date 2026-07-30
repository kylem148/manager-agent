import { test } from "node:test";
import assert from "node:assert/strict";
import { Tui, type DocSource, type InStream, type OutStream } from "./tui.js";

/**
 * The input queue: what happens to keystrokes that arrive while a turn is in
 * flight. Driven end-to-end through the real Tui with fake streams, because the
 * whole feature lives in the seam between the keyboard and question() — a unit
 * test of either half would prove nothing about the seam.
 *
 * "A turn is in flight" means exactly one thing to the Tui: no question() is
 * outstanding, so nothing is reading input. That is the state the session loop is
 * in from the moment it takes a line until it asks for the next one.
 *
 * What these tests CANNOT prove is the feel — that the block reads as pending
 * rather than as sent, that dim is dim enough, that typing at the spinner is
 * still instant. Those are hand-verify only.
 */

process.setMaxListeners(0);

const PROMPT = "you > "; // 6 visible columns

interface Harness {
  tui: Tui;
  send(bytes: string): void;
  lastFrame(): string;
  stop(): void;
}

function harness(opts: { cols?: number; rows?: number; docs?: DocSource } = {}): Harness {
  let listener: ((d: string) => void) | null = null;
  const writes: string[] = [];

  const out: OutStream = {
    write: (s) => writes.push(s),
    columns: opts.cols ?? 60,
    rows: opts.rows ?? 14,
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

  const tui = new Tui({
    promptLabel: PROMPT,
    out,
    inp,
    ...(opts.docs ? { docs: opts.docs } : {}),
  });
  tui.start();
  return {
    tui,
    send: (bytes) => listener?.(bytes),
    lastFrame: () => writes[writes.length - 1] ?? "",
    stop: () => tui.stop(),
  };
}

/** A read that must NOT have resolved yet. Settles the microtask queue first, so
 *  a synchronously-resolved question() would already have landed. */
async function pending(p: Promise<string | null>): Promise<boolean> {
  let done = false;
  void p.then(() => (done = true));
  await Promise.resolve();
  await Promise.resolve();
  return !done;
}

// --- Enter still submits when nothing is in flight ---------------------------

test("Enter with a read outstanding submits immediately, and queues nothing", async () => {
  const h = harness();
  const answer = h.tui.question();
  h.send("straight through\r");
  assert.equal(await answer, "straight through");
  // No queue block: the message went out, it is not waiting anywhere.
  assert.equal(h.lastFrame().includes("Press up to edit"), false);
  h.stop();
});

test("back-to-back submits stay one-per-read with no queue in between", async () => {
  const h = harness();
  const first = h.tui.question();
  h.send("one\r");
  assert.equal(await first, "one");
  const second = h.tui.question();
  h.send("two\r");
  assert.equal(await second, "two");
  assert.equal(h.lastFrame().includes("Press up to edit"), false);
  h.stop();
});

// --- typing and queuing during a turn ---------------------------------------

test("keystrokes during a turn edit the prompt line normally and are visible", () => {
  const h = harness();
  // No question() at all: a turn is in flight.
  h.send("half a thought");
  h.send("\x1b[D\x1b[D"); // left twice: the caret lands before "ht"
  h.send("X");
  assert.match(h.lastFrame(), /you > half a thougXht/);
  // Home and End still work on the line while nothing is reading it.
  h.send("\x01!"); // Ctrl-A, then type at the start
  assert.match(h.lastFrame(), /you > !half a thougXht/);
  h.send("\x05?"); // Ctrl-E, then type at the end
  assert.match(h.lastFrame(), /you > !half a thougXht\?/);
  h.stop();
});

test("Enter during a turn enqueues instead of submitting, and the block says so", async () => {
  const h = harness();
  h.send("first thing\r");
  const frame = h.lastFrame();
  assert.match(frame, /› first thing/);
  assert.match(frame, /Press up to edit queued messages/);
  // The line is clear and ready for the next message.
  assert.match(frame, /you > *(\x1b|$)/m);

  // It is delivered to the next read, not lost.
  assert.equal(await h.tui.question(), "first thing");
  h.stop();
});

test("more than one can queue, and they drain FIFO across successive reads", async () => {
  const h = harness();
  h.send("alpha\r");
  h.send("bravo\r");
  h.send("charlie\r");
  const frame = h.lastFrame();
  // One row each, in the order they were typed, under one hint.
  assert.match(frame, /› alpha[\s\S]*› bravo[\s\S]*› charlie/);
  assert.equal(frame.match(/Press up to edit/g)?.length, 1, "exactly one hint line");

  assert.equal(await h.tui.question(), "alpha");
  // Gone from the BLOCK (it is in the transcript above now, where a sent turn goes).
  assert.equal(h.lastFrame().includes("› alpha"), false, "the delivered one left the block");
  assert.match(h.lastFrame(), /› bravo/);
  assert.equal(await h.tui.question(), "bravo");
  assert.equal(await h.tui.question(), "charlie");

  // Empty again: the next read waits on the keyboard rather than resolving.
  const idle = h.tui.question();
  assert.ok(await pending(idle), "an empty queue leaves the read waiting");
  assert.equal(h.lastFrame().includes("Press up to edit"), false);
  h.send("live\r");
  assert.equal(await idle, "live");
  h.stop();
});

// --- the block shows messages, never a number --------------------------------

test("no queue count survives anywhere in the block, at any depth", () => {
  const h = harness();
  for (const m of ["a1", "b2", "c3", "d4", "e5", "f6"]) h.send(`${m}\r`);
  const frame = h.lastFrame();
  // The old block led with "N queued" and closed with "+N more". Both are gone,
  // and no other digit-plus-noun count took their place.
  assert.equal(/\d+\s+queued/.test(frame), false, "no total");
  assert.equal(/\+ ?\d+ more/.test(frame), false, "no remainder count");
  assert.equal(/^\s*\d+\.\s/m.test(frame), false, "no numbering");
  assert.match(frame, /Press up to edit queued messages/);
  h.stop();
});

test("past the block's ceiling the oldest are elided, never the newest", () => {
  // 14 rows → a ceiling of 4 listed messages.
  const h = harness();
  for (const m of ["one", "two", "three", "four", "five", "six"]) h.send(`${m}\r`);
  const frame = h.lastFrame();
  assert.equal(frame.includes("› one"), false, "the oldest fell off");
  assert.equal(frame.includes("› two"), false);
  assert.match(frame, /…[\s\S]*› three[\s\S]*› four[\s\S]*› five[\s\S]*› six/);
  // The newest is the row ↑ acts on, so it is the one that must never be elided.
  h.send("\x1b[A");
  assert.match(h.lastFrame(), /you > six/);
  h.stop();
});

test("a released message is echoed into the transcript like a typed turn", async () => {
  const h = harness();
  h.send("show me the queue\r");
  await h.tui.question();
  assert.match(h.lastFrame(), /you > show me the queue/);
  h.stop();
});

test("a blank Enter during a turn queues nothing", async () => {
  const h = harness();
  h.send("\r");
  h.send("   \r");
  assert.equal(h.lastFrame().includes("Press up to edit"), false);
  const idle = h.tui.question();
  assert.ok(await pending(idle), "nothing was queued, so nothing is released");
  h.stop();
});

test("a message too wide for the terminal is cut but keeps the block's indent", () => {
  const h = harness({ cols: 34 });
  h.send("short\r");
  h.send(`${"x".repeat(60)}\r`);
  const rows = h.lastFrame().split(/\x1b\[\d+;1H\x1b\[2K/);
  const listed = rows.filter((r) => /^ {2}› /.test(r));
  assert.equal(listed.length, 2, "both messages are listed");
  for (const r of listed) {
    assert.match(r, /^ {2}› \S/, "the mark survives the cut");
    // clipCell marks a cut with an ellipsis; nothing may overflow the width.
    assert.ok(r.replace(/\x1b\[[\d;]*m/g, "").length <= 34, `row overflows: ${JSON.stringify(r)}`);
  }
  assert.match(h.lastFrame(), /…/, "the long one was cut, not wrapped");
  h.stop();
});

test("a queued multi-line message keeps its newlines but paints on one row", async () => {
  const h = harness();
  h.send("top\x1b[13;2ubottom\r"); // Shift+Enter composes, Enter queues
  const frame = h.lastFrame();
  assert.match(frame, /› top bottom/, "flattened for the block");
  // A literal newline in the frame below the rule would tear the frame apart.
  const block = frame.slice(frame.indexOf("› top"));
  assert.equal(block.includes("\n"), false);
  assert.equal(await h.tui.question(), "top\nbottom");
  h.stop();
});

test("Ctrl-J still composes during a turn instead of queuing", async () => {
  const h = harness();
  h.send("one\ntwo"); // LF == Ctrl-J: a newline, not a submit
  assert.equal(h.lastFrame().includes("Press up to edit"), false);
  h.send("\r"); // now queue the whole two-line message
  assert.match(h.lastFrame(), /› one two/);
  assert.equal(await h.tui.question(), "one\ntwo");
  h.stop();
});

test("a queued paste chip expands on release, exactly as a submit would", async () => {
  const h = harness();
  h.send("\x1b[200~pasted one\npasted two\x1b[201~");
  assert.match(h.lastFrame(), /Pasted text #1 \+2 lines/);
  h.send("\r"); // queued while a turn is in flight
  assert.match(h.lastFrame(), /› \[Pasted text #1 \+2 lines\]/, "the block shows the chip");
  assert.equal(await h.tui.question(), "pasted one\npasted two");
  h.stop();
});

test("a queued message is recalled by history like a submitted one", async () => {
  const h = harness();
  h.send("remembered\r"); // queued
  assert.equal(await h.tui.question(), "remembered");
  const next = h.tui.question();
  h.send("\x1b[A"); // Up
  h.send("\r");
  assert.equal(await next, "remembered");
  h.stop();
});

// --- the armed dispatch gate: a confirm passes, nothing else does ------------

test("a queued `confirm` answers an armed gate", async () => {
  const h = harness();
  h.send("confirm\r"); // typed at the spinner, while the co was still arming
  // The turn ends having armed a dispatch: the banner IS the armed gate.
  h.tui.setConfirmBanner(["  dispatch armed — type `confirm` to launch"]);
  assert.equal(await h.tui.question(), "confirm", "the gate reads it as the launch");
  assert.equal(h.lastFrame().includes("Press up to edit"), false, "and it left the queue");
  h.stop();
});

test("every spelling of the verb passes; nothing else is mistaken for one", async () => {
  for (const verb of ["confirm", "confirm ccw", "confirm write", "  CONFIRM  ", "confirm write ccw"]) {
    const h = harness();
    h.send(`${verb}\r`);
    h.tui.setConfirmBanner(["  armed"]);
    // Delivered verbatim, spacing and all: trimming is the session's business.
    assert.equal(await h.tui.question(), verb, `"${verb}" is a confirm`);
    h.stop();
  }
  for (const notVerb of ["confirmed", "please confirm", "unconfirm", "confirm.", "yes"]) {
    const h = harness();
    h.send(`${notVerb}\r`);
    h.tui.setConfirmBanner(["  armed"]);
    assert.ok(await pending(h.tui.question()), `"${notVerb}" must not reach the gate`);
    h.stop();
  }
});

test("a queued NON-confirm can never reach an armed gate, so it can never cancel one", async () => {
  const h = harness();
  h.send("do the other thing\r"); // queued mid-turn
  h.tui.setConfirmBanner(["  dispatch armed — type `confirm` to launch"]);

  const read = h.tui.question();
  assert.ok(await pending(read), "an armed gate must not be answered by an ordinary line");
  assert.match(h.lastFrame(), /› do the other thing/, "it is still waiting, visibly");

  // Only a live keystroke resolves the gate for it.
  h.send("confirm\r");
  assert.equal(await read, "confirm");
  assert.match(h.lastFrame(), /› do the other thing/, "nothing released itself behind the confirm");

  // The session clears the banner once the gate is resolved; now it drains.
  h.tui.setConfirmBanner(null);
  assert.equal(await h.tui.question(), "do the other thing");
  h.stop();
});

test("a confirm behind ordinary lines still fires, and they keep their order after it", async () => {
  const h = harness();
  h.send("also look at the migration\r");
  h.send("confirm ccw\r");
  h.send("and then tell me what you find\r");
  h.tui.setConfirmBanner(["  armed"]);

  // The gate asked one question; the queue answers that one and holds the rest.
  assert.equal(await h.tui.question(), "confirm ccw");
  const frame = h.lastFrame();
  assert.match(frame, /› also look at the migration[\s\S]*› and then tell me what you find/);
  assert.equal(frame.includes("› confirm ccw"), false, "the confirm left the queue");

  h.tui.setConfirmBanner(null);
  assert.equal(await h.tui.question(), "also look at the migration");
  assert.equal(await h.tui.question(), "and then tell me what you find");
  h.stop();
});

test("a queue narrowed through an arm survives it and drains in order afterwards", async () => {
  const h = harness();
  h.send("first\r");
  h.send("second\r");
  h.tui.setConfirmBanner(["  armed"]);
  const gate = h.tui.question();
  h.send("confirm\r");
  assert.equal(await gate, "confirm");
  h.tui.setConfirmBanner(null);
  assert.equal(await h.tui.question(), "first");
  assert.equal(await h.tui.question(), "second");
  h.stop();
});

// --- recall one with ↑, clear all with esc-esc --------------------------------

test("Up lifts the newest queued message back to the line", async () => {
  const h = harness();
  h.send("keep me\r");
  h.send("take me back\r");
  assert.match(h.lastFrame(), /› take me back/);

  h.send("\x1b[A"); // Up
  const frame = h.lastFrame();
  assert.equal(frame.includes("› take me back"), false, "the newest left the queue");
  assert.match(frame, /you > take me back/, "and landed on the line, editable");

  // The caret is at the end, so typing appends.
  h.send(" now");
  assert.match(h.lastFrame(), /you > take me back now/);

  // The older one is untouched and still first out.
  h.send("\r");
  assert.equal(await h.tui.question(), "keep me");
  assert.equal(await h.tui.question(), "take me back now");
  h.stop();
});

test("Up recalls one at a time, newest first, then falls through to history", () => {
  const h = harness();
  h.send("older\r");
  h.send("newer\r");

  h.send("\x1b[A");
  assert.match(h.lastFrame(), /you > newer/);
  h.send("\x1b"); // clear the line; the recalled message is not re-queued
  h.send("\x1b[A");
  assert.match(h.lastFrame(), /you > older/, "the next Up takes the next newest");
  assert.equal(h.lastFrame().includes("Press up to edit"), false, "the queue is empty now");

  // Nothing queued left: Up is input history again, as it always was.
  h.send("\x1b");
  h.send("\x1b[A");
  assert.match(h.lastFrame(), /you > newer/, "history's newest, not the queue's");
  h.stop();
});

test("Up recalls a queued paste chip as a chip, and it re-expands when re-sent", async () => {
  const h = harness();
  h.send("\x1b[200~pasted one\npasted two\x1b[201~");
  h.send("\r");
  h.send("\x1b[A");
  assert.match(h.lastFrame(), /you > \[Pasted text #1 \+2 lines\]/, "the chip came back, not the body");
  h.send("\r");
  assert.equal(await h.tui.question(), "pasted one\npasted two");
  h.stop();
});

// Guard 1 (claude-code #63191, #62922): inside a multi-line input, Up is the
// cursor's key first. It has regressed there twice, both times by letting the
// recall/history meaning win at the bottom line.
test("in a multi-line input Up moves the cursor and recalls nothing until the top row", () => {
  const h = harness();
  h.send("queued and staying\r");
  h.send("first line\x1b[13;2usecond line"); // Shift+Enter between them

  h.send("\x1b[A"); // Up: to the first row of the input, NOT out of it
  assert.match(h.lastFrame(), /you > first line/, "the buffer is intact");
  assert.match(h.lastFrame(), /second line/);
  assert.match(h.lastFrame(), /› queued and staying/, "the queue was not touched");

  // Proves the caret moved ROWS: had Up left the input, this would land on
  // "second line" (or on a recalled message) instead of the row above.
  h.send("X");
  assert.match(h.lastFrame(), /you > first lineX/);
  assert.match(h.lastFrame(), /second line/);
  h.send("\x7f"); // put it back before the top-row check below

  // Only now, at the top row, does Up leave the input. The line has text on it,
  // so what it leaves for is the queue: the newest queued message.
  h.send("\x01"); // Ctrl-A → start of the top row
  h.send("\x1b[A");
  assert.match(h.lastFrame(), /you > queued and staying/);
  h.stop();
});

// Guard 2 (claude-code #66335): the race where a message was both sent and put
// in the edit box. A message the read already took is out of the queue, so ↑
// cannot lift it — it falls through to history like any other line.
test("Up cannot recall a message that has already been delivered", async () => {
  const h = harness();
  h.send("gone to the model\r");
  assert.equal(await h.tui.question(), "gone to the model", "delivered");

  h.send("\x1b[A");
  // It is on the line — but from HISTORY, which is the honest place for a line
  // that was sent. The discriminator is Down: history browsing restores the
  // draft, a queue recall (which leaves history alone) would not.
  assert.match(h.lastFrame(), /you > gone to the model/);
  h.send("\x1b[B");
  assert.match(h.lastFrame(), /you > *(\x1b|$)/m, "Down restored the empty draft: that was history");

  // And nothing was put back in the queue behind it.
  assert.equal(h.lastFrame().includes("Press up to edit"), false);
  assert.ok(await pending(h.tui.question()), "the queue is empty, not holding a ghost");
  h.stop();
});

test("Up takes the newest STILL-QUEUED message when the head has gone out", async () => {
  const h = harness();
  h.send("delivered\r");
  h.send("still waiting\r");
  assert.equal(await h.tui.question(), "delivered");

  h.send("\x1b[A");
  assert.match(h.lastFrame(), /you > still waiting/, "the queue's newest, not the sent one");
  // A queue recall is a live edit, not a history browse: Down leaves it alone.
  h.send("\x1b[B");
  assert.match(h.lastFrame(), /you > still waiting/);
  h.stop();
});

test("Backspace on an empty line is the plain no-op it is everywhere else", async () => {
  const h = harness();
  h.send("queued line\r");
  h.send("\x7f\x7f\x7f"); // Backspace no longer recalls: that is ↑'s job alone
  assert.match(h.lastFrame(), /› queued line/, "the queue is untouched");
  assert.match(h.lastFrame(), /you > *(\x1b|$)/m, "and the line is still empty");
  assert.equal(await h.tui.question(), "queued line");
  h.stop();
});

test("Backspace with text on the line still deletes a character and nothing else", () => {
  const h = harness();
  h.send("queued line\r");
  h.send("typing");
  h.send("\x7f"); // deletes the "g"
  assert.match(h.lastFrame(), /you > typin/);
  assert.match(h.lastFrame(), /› queued line/);

  // Even at column 0 of a line that has text on it, Backspace is a no-op.
  h.send("\x01"); // Ctrl-A → start of line
  h.send("\x7f");
  assert.match(h.lastFrame(), /you > typin/);
  assert.match(h.lastFrame(), /› queued line/, "the queue is not what Backspace is aimed at");
  h.stop();
});

test("esc-esc on an empty line clears the whole queue and receipts it", async () => {
  const h = harness();
  h.send("one\r");
  h.send("two\r");
  h.send("three\r");
  h.send("\x1b\x1b");
  const frame = h.lastFrame();
  assert.equal(frame.includes("Press up to edit"), false, "the block is gone");
  assert.match(frame, /queue cleared · 3 dropped/, "and said so on the separator");

  const idle = h.tui.question();
  assert.ok(await pending(idle), "nothing is left to release");
  h.stop();
});

test("esc-esc with text on the line still clears only the line", async () => {
  const h = harness();
  h.send("queued and staying\r");
  h.send("scratch this");
  h.send("\x1b");
  h.send("\x1b[27u"); // the Kitty spelling of Escape
  const frame = h.lastFrame();
  assert.match(frame, /› queued and staying/, "the queue is untouched");
  assert.equal(frame.includes("scratch this"), false, "the line is cleared");
  assert.equal(await h.tui.question(), "queued and staying");
  h.stop();
});

// --- the Ctrl-O panel owns its own keys -------------------------------------

test("with the panel open, Enter belongs to the panel and queues nothing", async () => {
  const docs: DocSource = {
    list: () => Promise.resolve(["architecture.md"]),
    read: () => Promise.resolve("# doc\n\nbody"),
    subscribe: () => () => {},
  };
  const h = harness({ docs });
  h.send("\x0f"); // Ctrl-O: open the panel
  h.send("a message\r"); // every byte here is the panel's
  h.send("\r");
  assert.equal(h.lastFrame().includes("Press up to edit"), false, "nothing queued from the panel");

  h.send("\x0f"); // close it: the prompt line is intact and empty
  assert.equal(h.lastFrame().includes("Press up to edit"), false);
  const idle = h.tui.question();
  assert.ok(await pending(idle), "the panel's keys never reached the queue");
  h.stop();
});
