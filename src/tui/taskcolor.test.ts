import { test } from "node:test";
import assert from "node:assert/strict";
import type { InStream, OutStream, TaskPanelRow, TaskPanelSource } from "./tui.js";

/**
 * The colour of the task table's status column — the one thing every other TUI
 * test is structurally unable to see.
 *
 * `colorEnabled` in ui.ts is computed ONCE, from `process.stdout.isTTY`, at the
 * moment that module is first loaded. A test runner is not a terminal, so in
 * overlay.test.ts every `c.cyan(...)` is the identity function and every frame
 * comes out bare; those tests assert against stripped text for exactly that
 * reason. An assertion there that a status is yellow would pass against a
 * painter that had never been told about yellow at all, which is worse than no
 * test.
 *
 * So this file exists to be a terminal. node:test runs each test FILE in its own
 * process, so flipping the flag here reaches nothing else, and the flip has to
 * happen BEFORE ui.ts is evaluated — hence the dynamic imports below and the
 * type-only import above, which is erased and pulls in no module at all.
 */
process.stdout.isTTY = true;
delete process.env.NO_COLOR;
process.env.TERM = "xterm-256color";

const { Tui } = await import("./tui.js");
const { colorEnabled } = await import("../ui.js");

const PROMPT = "you > ";
const CTRL_O = "\x0f";

/** SGR as ui.ts writes it: the code, the text, then a full reset. */
const sgr = (code: number, text: string): string => `\x1b[${code}m${text}\x1b[0m`;

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

/** The panel, opened over a fixed table, with the raw bytes of the last frame. */
function paint(rows: TaskPanelRow[]): { frame: string; stop: () => void } {
  let listener: ((d: string) => void) | null = null;
  const writes: string[] = [];
  const out: OutStream = {
    write: (s) => writes.push(String(s)),
    columns: 80,
    rows: 20,
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
  const tasks: TaskPanelSource = { list: () => rows.map((r) => ({ ...r })) };
  const tui = new Tui({ promptLabel: PROMPT, out, inp, tasks });
  tui.start();
  tui.question();
  listener?.(CTRL_O);
  return { frame: writes[writes.length - 1] ?? "", stop: () => tui.stop() };
}

test("this file really is painting in colour, or nothing below means anything", () => {
  assert.equal(colorEnabled, true, "the TTY flip landed before ui.ts was loaded");
  assert.equal(sgr(33, "x"), "\x1b[33mx\x1b[0m", "and yellow is SGR 33, as ui.ts writes it");
});

test("a `testing` row paints its status yellow, through the shared colour helper", async () => {
  const p = paint([
    { task: "yellow row", status: "testing" },
    { task: "cyan row", status: "building" },
    { task: "dim row", status: "queued" },
  ]);
  await settle();

  // The exact bytes ui.ts emits for c.yellow. Not "contains a 33 somewhere":
  // the code has to wrap the status word itself and close behind it, which is
  // what keeps the column's width arithmetic honest.
  assert.ok(p.frame.includes(sgr(33, "testing")), "the status word is wrapped in yellow");

  // The two that were already here are untouched — the new colour is an
  // addition to the panel's convention, not a re-theming of it.
  assert.ok(p.frame.includes(sgr(36, "building")), "building is still cyan");
  assert.ok(p.frame.includes(sgr(2, "queued")), "queued is still dim");
  p.stop();
});

test("yellow comes from the theme handling, so NO_COLOR strips it like everything else", async () => {
  // Not a new hardcoded escape scheme: the same `c` helper the rest of the panel
  // uses, which means the existing opt-out already covers it. Proved by painting
  // the same table in the process where colour is OFF — see overlay.test.ts,
  // where the frames carry no ANSI at all and the status words still line up.
  const p = paint([{ task: "yellow row", status: "testing" }]);
  await settle();
  const plain = p.frame.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /testing\s+yellow row/, "and stripping it leaves the row intact");
  p.stop();
});
