import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MODEL_CHOICES,
  DEFAULT_MODEL_ID,
  MODEL_ID_KEY,
  persistInstanceModel,
  resolveModelOrigin,
} from "../config.js";
import { readEnvFile } from "../envfile.js";
import { runModelCommand } from "../session/session.js";
import { Tui, type InStream, type ModelPickerEntry, type OutStream, type TaskPanelSource } from "./tui.js";
import { stripAnsi } from "./wrap.js";

/**
 * The in-panel model picker: bare `/model`'s surface (D-20260803-1).
 *
 * Raw bytes go in one end and we assert on the painted frames and on what the
 * promise resolves to, the way the rest of the panel is tested. The three
 * properties that matter, and that nothing else can prove:
 *
 *  - IT OPENS AND CLOSES BY ITSELF. `/model` is typed at the prompt with the
 *    panel shut, so the picker stands one up and takes it back down, leaving the
 *    conversation exactly where it was.
 *  - IT OWNS THE KEYBOARD. It is holding a caller's promise open, so no panel key
 *    - a digit that jumps tabs, a paging key - may move the screen out from under
 *    it. Every exit settles the promise exactly once.
 *  - ESC CHANGES NOTHING. Cancel resolves null, and null is what makes `/model`
 *    write nothing; the id path is proved in session.test.ts.
 */

process.setMaxListeners(0);

const PROMPT = "you > ";
const CTRL_O = "\x0f";
const ESC = "\x1b";
const ENTER = "\r";
const UP = "\x1b[A";
const DOWN = "\x1b[B";

interface Harness {
  tui: Tui;
  send(bytes: string): void;
  lastFrame(): string;
  lastFramePlain(): string;
  /** The picker's own rows, one string each - a frame is a run of
   *  cursor-addressed segments, not lines, so a row has to be picked out by
   *  where it was placed rather than by splitting on newlines. */
  boxRows(): string[];
  /** The row the cursor is on. */
  cursorRow(): string;
  stop(): void;
}

function harness(cols = 80, rows = 16, tasks?: TaskPanelSource): Harness {
  let listener: ((d: string) => void) | null = null;
  const writes: string[] = [];
  const out: OutStream = {
    write: (s) => writes.push(String(s)),
    get columns(): number {
      return cols;
    },
    get rows(): number {
      return rows;
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
  const tui = new Tui({ promptLabel: PROMPT, out, inp, ...(tasks ? { tasks } : {}) });
  tui.start();
  const last = (): string => writes[writes.length - 1] ?? "";
  const boxRows = (): string[] =>
    placedSegments(last())
      .map((s) => s.text)
      .filter((t) => t.startsWith("│"));
  return {
    tui,
    send: (bytes) => listener?.(bytes),
    lastFrame: last,
    lastFramePlain: () => stripAnsi(last()),
    boxRows,
    cursorRow: () => boxRows().find((t) => t.includes("▸")) ?? "",
    stop: () => tui.stop(),
  };
}

/** A task source, so the panel has a Home tab to open the picker over - the
 *  shape a real session always wires. */
function tasksWith(...rows: string[]): TaskPanelSource {
  const table = rows.map((task) => ({ task, status: "queued" as const }));
  return {
    list: () => table,
    add: () => Promise.resolve({ ok: true as const }),
    setStatus: () => Promise.resolve({ ok: true as const }),
    rename: () => Promise.resolve({ ok: true as const }),
    retire: () => Promise.resolve({ ok: true as const }),
  };
}

const CHOICES: readonly ModelPickerEntry[] = MODEL_CHOICES;

test("the list offered is exactly the three curated models, in inference-profile form", () => {
  // The list is a constant and not a discovery: Bedrock cannot say what a key
  // may invoke (ListFoundationModels ignores access; availability has answered
  // AUTHORIZED for models that then 403). So it is pinned here.
  assert.deepEqual(
    MODEL_CHOICES.map((m) => m.label),
    ["Opus 4.8", "Opus 5", "Sonnet 5"],
  );
  assert.deepEqual(
    MODEL_CHOICES.map((m) => m.id),
    [
      "us.anthropic.claude-opus-4-8",
      "us.anthropic.claude-opus-5",
      "us.anthropic.claude-sonnet-5",
    ],
  );
  // Every row carries the geo-scoped inference profile: the bare
  // `anthropic.claude-…` form is rejected for on-demand throughput, so a list
  // spelled that way would fail its own probe on every row.
  for (const m of MODEL_CHOICES) assert.match(m.id, /^us\.anthropic\./);
  assert.ok(
    MODEL_CHOICES.some((m) => m.id === DEFAULT_MODEL_ID),
    "the default must be ON the list, or the picker opens with nothing marked",
  );
});

test("bare /model opens the picker over the panel, with the model in force marked", async () => {
  const h = harness(80, 16, tasksWith("ship the picker"));
  const p = h.tui.openModelPicker(CHOICES, DEFAULT_MODEL_ID);

  const frame = h.lastFramePlain();
  assert.match(frame, /set the model/, "the box says what it is for");
  for (const m of CHOICES) {
    assert.ok(frame.includes(m.label), `${m.label} is offered`);
    assert.ok(frame.includes(m.id), `${m.id} is shown in full - it is what gets stored`);
  }
  // Marked in WORDS, not by colour alone: under a test runner colour is off, and
  // so it is on a NO_COLOR terminal.
  const marked = h.boxRows().filter((l) => l.includes("· in force"));
  assert.equal(marked.length, 1, "exactly one row is the model in force");
  assert.ok(marked[0]!.includes(DEFAULT_MODEL_ID), "and it is the model actually in force");
  assert.ok(marked[0]!.includes("▸"), "which is also where the cursor opens");
  assert.match(frame, /Enter set the model/, "the footer names what Enter does");

  // The view it opened over is still painted around it.
  assert.match(frame, /ship the picker/);

  h.send(ESC);
  assert.equal(await p, null);
  h.stop();
});

test("↓ then Enter resolves the id of the row it landed on, and puts the screen back", async () => {
  const h = harness(80, 16, tasksWith("ship the picker"));
  // Opens on Opus 5 (the default, index 1); one step down is Sonnet 5.
  const p = h.tui.openModelPicker(CHOICES, DEFAULT_MODEL_ID);
  h.send(DOWN);

  const cursor = h.cursorRow();
  assert.ok(cursor.includes("us.anthropic.claude-sonnet-5"), "the cursor moved a row");
  assert.ok(!cursor.includes("· in force"), "and the mark stayed on the model in force");

  h.send(ENTER);
  assert.equal(await p, "us.anthropic.claude-sonnet-5");

  // The panel it opened for itself is gone: the captain is back at the prompt he
  // typed `/model` on, with the conversation intact.
  const after = h.lastFramePlain();
  assert.ok(!after.includes("set the model"), "the picker is off the screen");
  assert.ok(after.includes(PROMPT), "and the prompt line is back");
  h.stop();
});

test("Enter with no movement re-pins the model already in force", async () => {
  const h = harness(80, 16, tasksWith("ship the picker"));
  const p = h.tui.openModelPicker(CHOICES, DEFAULT_MODEL_ID);
  h.send(ENTER);
  assert.equal(
    await p,
    DEFAULT_MODEL_ID,
    "the cursor opens on the model in force, so a blind Enter never switches anything",
  );
  h.stop();
});

test("j/k move the cursor as well, the way they do everywhere else in the panel", async () => {
  const h = harness(80, 16, tasksWith("ship the picker"));
  const p = h.tui.openModelPicker(CHOICES, DEFAULT_MODEL_ID);
  h.send("k"); // up: Opus 4.8
  h.send(ENTER);
  assert.equal(await p, "us.anthropic.claude-opus-4-8");
  h.stop();
});

test("the cursor clamps at the ends rather than wrapping", async () => {
  const h = harness(80, 16, tasksWith("ship the picker"));
  const p = h.tui.openModelPicker(CHOICES, DEFAULT_MODEL_ID);
  h.send(UP);
  h.send(UP);
  h.send(UP); // past the top
  h.send(ENTER);
  assert.equal(await p, "us.anthropic.claude-opus-4-8", "the first row, not the last");
  h.stop();
});

test("Esc cancels: the promise resolves null and the screen goes back untouched", async () => {
  const h = harness(80, 16, tasksWith("ship the picker"));
  const p = h.tui.openModelPicker(CHOICES, DEFAULT_MODEL_ID);
  h.send(DOWN); // move first - cancelling after moving must still change nothing
  h.send(ESC);

  assert.equal(await p, null, "null is what makes /model write nothing");
  const after = h.lastFramePlain();
  assert.ok(!after.includes("set the model"));
  assert.ok(after.includes(PROMPT));
  h.stop();
});

test("Ctrl-O cancels too - the key that closes the panel closes this", async () => {
  const h = harness(80, 16, tasksWith("ship the picker"));
  const p = h.tui.openModelPicker(CHOICES, DEFAULT_MODEL_ID);
  h.send(CTRL_O);
  assert.equal(await p, null);
  h.stop();
});

test("the picker owns the keyboard: no panel key moves the screen out from under it", async () => {
  const h = harness(80, 16, tasksWith("ship the picker"));
  const p = h.tui.openModelPicker(CHOICES, DEFAULT_MODEL_ID);

  // A digit jumps tabs everywhere else in the panel, Tab cycles them, and
  // space/g page a body. Here they must all be inert: the picker is holding
  // `/model` open, and a caller waiting on a view that is no longer on screen is
  // a hung session.
  for (const key of ["1", "2", "3", "\t", "i", " ", "g", "G", "d", "u"]) h.send(key);

  assert.match(h.lastFramePlain(), /set the model/, "still the picker");
  assert.ok(h.cursorRow().includes(DEFAULT_MODEL_ID), "and the cursor has not moved");

  h.send(ENTER);
  assert.equal(await p, DEFAULT_MODEL_ID);
  h.stop();
});

test("it opens the panel for itself even in a session with no tab wired at all", async () => {
  // `/model` works in every session; the panel's usual "nothing to show" refusal
  // is about tabs, and the picker brings its own content.
  const h = harness(80, 16);
  const p = h.tui.openModelPicker(CHOICES, DEFAULT_MODEL_ID);
  assert.match(h.lastFramePlain(), /set the model/);
  h.send(ENTER);
  assert.equal(await p, DEFAULT_MODEL_ID);
  h.stop();
});

test("opened over a panel the captain already had up, it hands that view back", async () => {
  const h = harness(80, 16, tasksWith("ship the picker"));
  h.send(CTRL_O); // the captain opens the panel himself
  assert.match(h.lastFramePlain(), /ship the picker/);

  const p = h.tui.openModelPicker(CHOICES, DEFAULT_MODEL_ID);
  h.send(ESC);
  assert.equal(await p, null);

  const after = h.lastFramePlain();
  assert.ok(!after.includes("set the model"), "the picker is gone");
  assert.match(after, /ship the picker/, "but the panel he opened is not - only the box was his to close");
  h.stop();
});

test("teardown settles an open picker as a cancel rather than hanging its caller", async () => {
  const h = harness(80, 16, tasksWith("ship the picker"));
  const p = h.tui.openModelPicker(CHOICES, DEFAULT_MODEL_ID);
  h.stop();
  assert.equal(await p, null, "a screen that is gone will never deliver a keystroke");
});

test("a current id that is not on the list leaves nothing marked and starts at the top", async () => {
  const h = harness(80, 16, tasksWith("ship the picker"));
  const p = h.tui.openModelPicker(CHOICES, "us.anthropic.claude-sonnet-4-6");

  assert.ok(
    !h.boxRows().some((l) => l.includes("· in force")),
    "nothing on the list is in force, and it does not pretend one is",
  );
  h.send(ENTER);
  assert.equal(await p, "us.anthropic.claude-opus-4-8", "the cursor still had somewhere to be");
  h.stop();
});

test("the box fits its content and never overflows a narrow screen", async () => {
  // A frame is a run of cursor-addressed segments, so the width that matters is
  // each segment's, measured from where it was placed.
  const h = harness(44, 10, tasksWith("ship the picker"));
  const p = h.tui.openModelPicker(CHOICES, DEFAULT_MODEL_ID);
  const painted = placedSegments(h.lastFrame());
  assert.ok(painted.some((s) => s.text.includes("set the model")), "the box was painted");
  for (const s of painted) {
    assert.ok(
      s.col - 1 + s.text.length <= 44,
      `a segment ran past the right edge: ${JSON.stringify(s)}`,
    );
  }
  // At this width the ids no longer fit beside the names, so the column goes
  // whole rather than every id being cut off inside its shared prefix.
  const box = h.boxRows();
  assert.equal(box.length, CHOICES.length, "every model is still offered");
  assert.ok(box.some((t) => t.includes("Opus 5")), "the names survive");
  assert.ok(box.some((t) => t.includes("· in force")), "and so does the one thing you came to read");
  assert.ok(!box.some((t) => t.includes("us.anthropic.claude-opus…")), "no id is cut inside its shared prefix");
  h.send(ESC);
  await p;
  h.stop();
});

// --- the whole way through ----------------------------------------------------
//
// These two cross a layer on purpose (the rest of this file, and production,
// keep the Tui clear of the session). What they pin is the one thing neither
// side can prove alone: that a keystroke in the picker ends up as a line in this
// co-manager's own `.env`, and that Esc ends up as nothing at all. Real bytes,
// the real command, the real writer, a real temp CO_HOME - only Bedrock is
// absent, and the chosen model is the one already in force, which is the case
// `/model` deliberately does not probe.

/** The `/model` deps a real session builds for the Tui branch, over a temp home. */
function liveDeps(tui: Tui, instanceRoot: string, home: string, current: string) {
  return {
    current,
    origin: resolveModelOrigin({ instanceRoot, home }),
    probe: async () => {
      throw new Error("the probe must not run for the model already in force");
    },
    persist: (id: string) => persistInstanceModel(instanceRoot, id),
    commit: () => null,
    pick: (choices: readonly ModelPickerEntry[], cur: string) => tui.openModelPicker(choices, cur),
  };
}

test("Enter in the picker writes the choice to this co-manager's own .env", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "co-picker-"));
  try {
    const root = path.join(home, "instances", "one");
    const h = harness(80, 16, tasksWith("ship the picker"));
    const deps = liveDeps(h.tui, root, home, DEFAULT_MODEL_ID);

    const running = runModelCommand("", deps);
    await new Promise((r) => setImmediate(r)); // let the picker go up
    assert.match(h.lastFramePlain(), /set the model/, "bare /model opened it");
    h.send(ENTER); // the model in force, re-pinned
    const out = (await running).join("\n");

    assert.match(out, /already in force/);
    assert.equal(
      readEnvFile(path.join(root, ".env"))[MODEL_ID_KEY],
      DEFAULT_MODEL_ID,
      "the choice is on disk, in this instance's own .env, and nowhere else",
    );
    // And a fresh read of the ladder - what the next session start does - agrees.
    const after = resolveModelOrigin({ instanceRoot: root, home });
    assert.equal(after.modelId, DEFAULT_MODEL_ID);
    assert.equal(after.source, "instance");
    h.stop();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Esc in the picker writes nothing: no .env, no switch, just the report", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "co-picker-"));
  try {
    const root = path.join(home, "instances", "one");
    const h = harness(80, 16, tasksWith("ship the picker"));
    const deps = liveDeps(h.tui, root, home, DEFAULT_MODEL_ID);

    const running = runModelCommand("", deps);
    await new Promise((r) => setImmediate(r));
    h.send(DOWN); // move first - a cancel after moving must still change nothing
    h.send(ESC);
    const out = (await running).join("\n");

    assert.match(out, /source: the built-in default/, "the report is still printed");
    assert.ok(!out.includes("stored for this co-manager"), "and nothing claims to have been stored");
    assert.deepEqual(
      readEnvFile(path.join(root, ".env")),
      {},
      "no file, so the next session starts on exactly what this one did",
    );
    h.stop();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

/** Every `CSI row;col H` -addressed chunk of a frame, with its column and the
 *  plain text written there. */
function placedSegments(frame: string): { col: number; text: string }[] {
  const out: { col: number; text: string }[] = [];
  const re = /\x1b\[(\d+);(\d+)H/g;
  let m: RegExpExecArray | null;
  const marks: { at: number; end: number; col: number }[] = [];
  while ((m = re.exec(frame)) !== null) {
    marks.push({ at: m.index, end: m.index + m[0].length, col: Number(m[2]) });
  }
  for (let i = 0; i < marks.length; i++) {
    const slice = frame.slice(marks[i]!.end, marks[i + 1]?.at ?? frame.length);
    out.push({ col: marks[i]!.col, text: stripAnsi(slice) });
  }
  return out;
}
