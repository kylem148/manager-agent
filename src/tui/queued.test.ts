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
  assert.equal(h.lastFrame().includes("queued"), false);
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
  assert.equal(h.lastFrame().includes("queued"), false);
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
  assert.match(frame, /1 queued/);
  assert.match(frame, /1\. first thing/);
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
  assert.match(frame, /3 queued/);
  assert.match(frame, /1\. alpha/);
  assert.match(frame, /2\. bravo/);
  assert.match(frame, /3\. charlie/);

  assert.equal(await h.tui.question(), "alpha");
  assert.match(h.lastFrame(), /2 queued/);
  assert.equal(await h.tui.question(), "bravo");
  assert.equal(await h.tui.question(), "charlie");

  // Empty again: the next read waits on the keyboard rather than resolving.
  const idle = h.tui.question();
  assert.ok(await pending(idle), "an empty queue leaves the read waiting");
  assert.equal(h.lastFrame().includes("queued"), false);
  h.send("live\r");
  assert.equal(await idle, "live");
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
  assert.equal(h.lastFrame().includes("queued"), false);
  const idle = h.tui.question();
  assert.ok(await pending(idle), "nothing was queued, so nothing is released");
  h.stop();
});

test("beyond three queued the block collapses the rest into a count", () => {
  const h = harness();
  for (const m of ["a1", "b2", "c3", "d4", "e5"]) h.send(`${m}\r`);
  const frame = h.lastFrame();
  assert.match(frame, /5 queued/);
  assert.match(frame, /3\. c3/);
  assert.match(frame, /\+ 2 more/);
  assert.equal(frame.includes("4. d4"), false, "the block has a ceiling");
  h.stop();
});

test("a message too wide for the terminal is cut but keeps the block's indent", () => {
  const h = harness({ cols: 34 });
  h.send("short\r");
  h.send(`${"x".repeat(60)}\r`);
  const rows = h.lastFrame().split(/\x1b\[\d+;1H\x1b\[2K/);
  const listed = rows.filter((r) => /^ {4}\d\. /.test(r));
  assert.equal(listed.length, 2, "both messages are listed");
  for (const r of listed) {
    assert.match(r, /^ {4}\d\. \S/, "the lead survives the cut");
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
  assert.match(frame, /1\. top bottom/, "flattened for the block");
  // A literal newline in the frame below the rule would tear the frame apart.
  const block = frame.slice(frame.indexOf("1. top"));
  assert.equal(block.includes("\n"), false);
  assert.equal(await h.tui.question(), "top\nbottom");
  h.stop();
});

test("Ctrl-J still composes during a turn instead of queuing", async () => {
  const h = harness();
  h.send("one\ntwo"); // LF == Ctrl-J: a newline, not a submit
  assert.equal(h.lastFrame().includes("queued"), false);
  h.send("\r"); // now queue the whole two-line message
  assert.match(h.lastFrame(), /1 queued/);
  assert.equal(await h.tui.question(), "one\ntwo");
  h.stop();
});

test("a queued paste chip expands on release, exactly as a submit would", async () => {
  const h = harness();
  h.send("\x1b[200~pasted one\npasted two\x1b[201~");
  assert.match(h.lastFrame(), /Pasted text #1 \+2 lines/);
  h.send("\r"); // queued while a turn is in flight
  assert.match(h.lastFrame(), /1\. \[Pasted text #1 \+2 lines\]/, "the block shows the chip");
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

// --- the armed dispatch gate: HOLD, never drain -----------------------------

test("the queue is HELD, not drained, while a dispatch is armed", async () => {
  const h = harness();
  h.send("do the other thing\r"); // queued mid-turn
  // The turn ends having armed a dispatch: the banner IS the armed gate.
  h.tui.setConfirmBanner(["  dispatch armed — type `confirm` to launch"]);

  const read = h.tui.question();
  assert.ok(await pending(read), "an armed gate must not be answered from the queue");
  const frame = h.lastFrame();
  assert.match(frame, /1 queued/);
  assert.match(frame, /HELD/, "the block says it is being held");

  // Only a live keystroke resolves the gate.
  h.send("confirm\r");
  assert.equal(await read, "confirm");
  // Still held: nothing released itself behind the confirm.
  assert.match(h.lastFrame(), /1 queued/);

  // The session clears the banner once the gate is resolved; now it drains.
  h.tui.setConfirmBanner(null);
  assert.equal(await h.tui.question(), "do the other thing");
  h.stop();
});

test("a queued `confirm` can never fire an armed order by itself", async () => {
  const h = harness();
  h.send("confirm\r"); // queued before anything was armed
  h.tui.setConfirmBanner(["  dispatch armed — type `confirm` to launch"]);
  const read = h.tui.question();
  assert.ok(await pending(read), "the queued confirm stayed put");
  // Cancel it live instead. That line, not the queued one, is what the loop sees.
  h.send("no, hold off\r");
  assert.equal(await read, "no, hold off");
  h.stop();
});

test("a queue held through an arm survives it and drains in order afterwards", async () => {
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

// --- cancel one, clear all ---------------------------------------------------

test("Backspace on an empty line lifts the newest queued message back to the line", async () => {
  const h = harness();
  h.send("keep me\r");
  h.send("take me back\r");
  assert.match(h.lastFrame(), /2 queued/);

  h.send("\x7f"); // Backspace, empty line
  const frame = h.lastFrame();
  assert.match(frame, /1 queued/, "the newest left the queue");
  assert.match(frame, /you > take me back/, "and landed on the line, editable");
  assert.equal(frame.includes("take me back\r"), false);

  // The caret is at the end, so typing appends.
  h.send(" now");
  assert.match(h.lastFrame(), /you > take me back now/);

  // The older one is untouched and still first out.
  h.send("\r");
  assert.equal(await h.tui.question(), "keep me");
  assert.equal(await h.tui.question(), "take me back now");
  h.stop();
});

test("Backspace with text on the line never touches the queue", async () => {
  const h = harness();
  h.send("queued line\r");
  h.send("typing");
  h.send("\x7f"); // deletes the "g"
  assert.match(h.lastFrame(), /you > typin/);
  assert.match(h.lastFrame(), /1 queued/);

  // Even at column 0 of a line that has text on it, Backspace is a no-op.
  h.send("\x01"); // Ctrl-A → start of line
  h.send("\x7f");
  assert.match(h.lastFrame(), /you > typin/);
  assert.match(h.lastFrame(), /1 queued/, "the queue is not what Backspace is aimed at here");
  h.stop();
});

test("Backspace on an empty line with an empty queue is the no-op it always was", () => {
  const h = harness();
  h.send("\x7f\x7f\x7f");
  assert.equal(h.lastFrame().includes("queued"), false);
  h.send("fine");
  assert.match(h.lastFrame(), /you > fine/);
  h.stop();
});

test("esc-esc on an empty line clears the whole queue and receipts it", async () => {
  const h = harness();
  h.send("one\r");
  h.send("two\r");
  h.send("three\r");
  h.send("\x1b\x1b");
  const frame = h.lastFrame();
  assert.equal(frame.includes("queued ·"), false, "the block is gone");
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
  assert.match(frame, /1 queued/, "the queue is untouched");
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
  assert.equal(h.lastFrame().includes("queued ·"), false, "nothing queued from the panel");

  h.send("\x0f"); // close it: the prompt line is intact and empty
  assert.equal(h.lastFrame().includes("queued ·"), false);
  const idle = h.tui.question();
  assert.ok(await pending(idle), "the panel's keys never reached the queue");
  h.stop();
});
