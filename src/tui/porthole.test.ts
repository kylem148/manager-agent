import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  DocSource,
  InStream,
  OutStream,
  QueuePanelSource,
  QueuePanelView,
  TaskPanelRow,
  TaskPanelSource,
} from "./tui.js";

/**
 * The lit porthole: the panel's tab bar, cut into the galleon's hull.
 *
 * The ship carries one window per tab, every one of them lit, and the tab the
 * captain is on lit brighter. That is a claim about COLOUR, and colour is the one
 * thing overlay.test.ts is structurally unable to see: `colorEnabled` in ui.ts is
 * computed once, from `process.stdout.isTTY`, when that module is first loaded,
 * and a test runner is not a terminal — so every frame over there comes out bare
 * and an assertion that a window was lit would pass against a painter that had
 * never been told about light. So this file is a terminal, the way taskcolor.test.ts is:
 * the flag is flipped before ui.ts is evaluated, which is why the imports below
 * are dynamic and the one above is type-only (erased, pulling in no module).
 *
 * These are real painted panel frames, not a call into the art: the point is
 * that the panel hands the scene the bar it is actually showing, so the window
 * has to be read back off the screen, on more than one tab, with everything
 * between the two doing whatever it really does.
 */

process.stdout.isTTY = true;
delete process.env.NO_COLOR;
process.env.TERM = "xterm-256color";

const { Tui } = await import("./tui.js");
const { colorEnabled } = await import("../ui.js");

const PROMPT = "you > ";
const CTRL_O = "\x0f";

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

const TASKS: TaskPanelRow[] = [{ task: "the lit window", status: "building" }];

const QUEUE_VIEW: QueuePanelView = {
  size: 1,
  head: null,
  entries: [{ feature: "head-a", position: 1, isHead: true, status: "ready", commitsReady: 1 }],
};

/** A window with a lamp in it: soft yellow. Every window has one. */
const GLOW = /\x1b\[38;5;185mo\x1b\[0m/;
/** The one turned up: a brighter yellow over it. Both are 256-colour and not the
 *  base palette's yellow/bright-yellow, because a theme is free to put those two
 *  at the same luminance and Ghostty's default does — a test written against the
 *  base pair would pass on a step nobody can see. */
const LAMP = /\x1b\[38;5;227mo\x1b\[0m/;

/**
 * The hull's windows as the screen actually holds them: how many there are, and
 * which one is turned up. Read off the raw bytes, because the bytes are the
 * claim.
 */
function windows(frame: string): { count: number; lit: number } | null {
  const spans = [...frame.matchAll(new RegExp(`${GLOW.source}|${LAMP.source}`, "g"))].map((m) => m[0]);
  if (spans.length === 0) return null;
  return { count: spans.length, lit: spans.findIndex((s) => LAMP.test(s)) };
}

/** A panel over three tabs — home, queue, docs — on a screen with room for the
 *  whole scene under any of them. */
function panel(): { frame: () => string; send: (b: string) => void; stop: () => void } {
  let listener: ((d: string) => void) | null = null;
  const writes: string[] = [];
  const out: OutStream = { write: (s) => writes.push(String(s)), columns: 90, rows: 48 };
  const inp: InStream = {
    isTTY: true,
    setRawMode: () => {},
    resume: () => {},
    pause: () => {},
    setEncoding: () => {},
    on: (_e, l) => (listener = l),
    removeListener: () => (listener = null),
  };
  const tasks: TaskPanelSource = { list: () => TASKS.map((t) => ({ ...t })) };
  const queue: QueuePanelSource = { view: () => QUEUE_VIEW, headDetail: () => null };
  const docs: DocSource = {
    list: () => Promise.resolve(["plan.md"]),
    read: () => Promise.resolve("# Plan\n"),
    subscribe: () => () => {},
  };
  const tui = new Tui({ promptLabel: PROMPT, out, inp, tasks, queue, docs });
  tui.start();
  tui.question();
  listener?.(CTRL_O);
  return {
    frame: () => writes[writes.length - 1] ?? "",
    send: (b) => listener?.(b),
    stop: () => tui.stop(),
  };
}

test("this file really is painting in colour, or nothing below means anything", () => {
  assert.equal(colorEnabled, true, "the TTY flip landed before ui.ts was loaded");
});

test("the ship carries a lit window per tab, and the one you are on is brighter", async () => {
  const p = panel();
  await settle();

  const home = windows(p.frame());
  assert.ok(home, "the panel opened on home with lit windows on the hull");
  assert.equal(home.count, 3, "three tabs in the bar, three windows on the ship");
  assert.equal(home.lit, 0, "and home is the first of them");
  p.stop();
});

test("the brighter window follows the captain from tab to tab", async () => {
  const p = panel();
  await settle();
  assert.deepEqual(windows(p.frame()), { count: 3, lit: 0 }, "home");

  p.send("2");
  await settle();
  assert.deepEqual(windows(p.frame()), { count: 3, lit: 1 }, "the queue tab lights the second window");

  p.send("3");
  await settle();
  assert.deepEqual(windows(p.frame()), { count: 3, lit: 2 }, "and the docs tab the third");

  p.send("1");
  await settle();
  assert.deepEqual(windows(p.frame()), { count: 3, lit: 0 }, "and back to the first on the way home");
  p.stop();
});

test("every window has a lamp, one is turned up, and the timber between is timber", async () => {
  const p = panel();
  await settle();
  const frame = p.frame();

  // Exactly one window turned up in the whole frame: a second would mean the
  // panel had lit a tab it is not on, which is the one thing this can get wrong
  // quietly. And the other two still glow — a dark porthole is the look this
  // deliberately does not have.
  assert.equal([...frame.matchAll(new RegExp(LAMP.source, "g"))].length, 1, "one window turned up and no more");
  assert.equal([...frame.matchAll(new RegExp(GLOW.source, "g"))].length, 2, "and the other two are still lit");
  assert.doesNotMatch(frame, /\x1b\[2mo\x1b\[0m/, "no window is ever a dark hole");

  // Neither lamp is the base palette's yellow or bright yellow. A theme decides
  // what those two are and is allowed to make them the same; if the lamps ever
  // fell back to them the feature would go invisible with every colour assertion
  // above still passing.
  assert.doesNotMatch(frame, /\x1b\[93mo/, "no lamp rides on the theme's bright yellow");
  assert.match(frame, new RegExp(`\\x1b\\[33m {4}\\x1b\\[0m${GLOW.source}`), "a lamp sits in plain timber");
  p.stop();
});
