import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVisualsLevel, type VisualsLevel } from "../config.js";
import {
  VISUALS_MIN_COLS,
  currentVisuals,
  dispatchFlourish,
  dispatchLabel,
  exitVoyage,
  reducedMotionFromEnv,
  resolveVisuals,
  savingLabel,
  voyageFrames,
  waveBand,
  type VisualsEnv,
} from "./visuals.js";
import { Tui, type AnimationSpec, type InStream, type OutStream } from "./tui.js";
import { stripAnsi, visibleWidth } from "./wrap.js";

/**
 * The terminal visuals: the CO_VISUALS toggle, the degradation predicate that
 * decides what a given terminal may actually be shown, the wave/ship frame
 * generators and their plain-ASCII twins, and the bounded region the Tui plays
 * them in.
 *
 * What these tests are really protecting is the degradation contract. The
 * animations are decoration and nothing depends on them — but the LABELS carry
 * real information (which branch an order went to, why the session hasn't
 * closed yet), so every path has to end in a legible single line no matter what
 * the terminal can do. Hence the shape of the file: the predicate is checked
 * condition by condition, and every frame generator is checked in both
 * alphabets, with the ASCII one asserted to be strictly 7-bit.
 *
 * Timing is deliberately NOT tested (no fake clocks, no waiting on frames). What
 * matters is that frame N renders correctly and that the region opens, paints,
 * and clears — a wall-clock test of a decorative timer would buy flake, not
 * confidence.
 */

process.setMaxListeners(0);

/** A capable terminal: the baseline the degradation cases are varied from. */
function capableEnv(overrides: Partial<VisualsEnv> = {}): VisualsEnv {
  return {
    level: "full",
    isTTY: true,
    noColor: false,
    term: "xterm-256color",
    plainIO: false,
    columns: 100,
    reducedMotion: false,
    ...overrides,
  };
}

/** True when `s` contains nothing outside printable 7-bit ASCII (ANSI styling,
 *  which is stripped first, doesn't count — it's already NO_COLOR-gated). */
function isPlainAscii(s: string): boolean {
  return /^[\x20-\x7e]*$/.test(stripAnsi(s));
}

// --- CO_VISUALS parsing -------------------------------------------------------

test("parseVisualsLevel accepts the three levels, case- and space-insensitively", () => {
  for (const level of ["full", "minimal", "off"] as VisualsLevel[]) {
    assert.equal(parseVisualsLevel(level), level);
    assert.equal(parseVisualsLevel(`  ${level.toUpperCase()} `), level);
  }
});

test("parseVisualsLevel maps the on/off spellings people actually type", () => {
  for (const on of ["on", "true", "1", "yes"]) assert.equal(parseVisualsLevel(on), "full");
  for (const off of ["0", "false", "none", "no"]) assert.equal(parseVisualsLevel(off), "off");
});

test("parseVisualsLevel returns null for unset/empty/garbage so the caller defaults", () => {
  assert.equal(parseVisualsLevel(undefined), null);
  assert.equal(parseVisualsLevel(""), null);
  assert.equal(parseVisualsLevel("   "), null);
  assert.equal(parseVisualsLevel("fancy"), null);
  assert.equal(parseVisualsLevel("fullish"), null);
});

// --- the degradation predicate ------------------------------------------------

test("a capable terminal at CO_VISUALS=full animates in box-drawing glyphs", () => {
  const v = resolveVisuals(capableEnv());
  assert.deepEqual(v, {
    level: "full",
    animate: true,
    glyphs: "unicode",
    color: true,
    degradedBy: null,
  });
});

test("CO_VISUALS=minimal keeps the glyphs and the accent but never moves", () => {
  const v = resolveVisuals(capableEnv({ level: "minimal" }));
  assert.equal(v.animate, false);
  assert.equal(v.glyphs, "unicode");
  assert.equal(v.color, true);
  // Not a degradation: the captain asked for this level.
  assert.equal(v.degradedBy, null);
});

test("CO_VISUALS=off is a plain ASCII static line, and not reported as degraded", () => {
  const v = resolveVisuals(capableEnv({ level: "off" }));
  assert.equal(v.level, "off");
  assert.equal(v.animate, false);
  assert.equal(v.glyphs, "ascii");
  assert.equal(v.color, false);
  assert.equal(v.degradedBy, null);
});

test("every degradation condition collapses full to a static ASCII line", () => {
  const conditions: Array<[string, Partial<VisualsEnv>]> = [
    ["NO_COLOR", { noColor: true }],
    ["non-TTY", { isTTY: false }],
    ["PlainIO", { plainIO: true }],
    ["TERM=dumb", { term: "dumb" }],
    ["narrow width", { columns: VISUALS_MIN_COLS - 1 }],
    ["reduced motion", { reducedMotion: true }],
  ];
  for (const [name, override] of conditions) {
    const v = resolveVisuals(capableEnv(override));
    assert.equal(v.level, "off", `${name} must resolve to off`);
    assert.equal(v.animate, false, `${name} must not animate`);
    assert.equal(v.glyphs, "ascii", `${name} must fall back to ASCII`);
    assert.equal(v.color, false, `${name} must not colour`);
    assert.ok(v.degradedBy, `${name} must report why it degraded`);
  }
});

test("the width floor is a floor, not a range: exactly the minimum still animates", () => {
  assert.equal(resolveVisuals(capableEnv({ columns: VISUALS_MIN_COLS })).animate, true);
  assert.equal(resolveVisuals(capableEnv({ columns: VISUALS_MIN_COLS - 1 })).animate, false);
});

test("the environment can only lower the configured level, never raise it", () => {
  // minimal on a broken terminal degrades further; nothing promotes off/minimal.
  assert.equal(resolveVisuals(capableEnv({ level: "minimal", term: "dumb" })).level, "off");
  assert.equal(resolveVisuals(capableEnv({ level: "off" })).animate, false);
});

test("reducedMotionFromEnv honors the common spellings and ignores falsey values", () => {
  assert.equal(reducedMotionFromEnv({}), false);
  assert.equal(reducedMotionFromEnv({ CO_REDUCED_MOTION: "1" }), true);
  assert.equal(reducedMotionFromEnv({ REDUCED_MOTION: "yes" }), true);
  assert.equal(reducedMotionFromEnv({ PREFERS_REDUCED_MOTION: "reduce" }), true);
  assert.equal(reducedMotionFromEnv({ NO_MOTION: "true" }), true);
  for (const falsey of ["", "0", "false", "off", "no"]) {
    assert.equal(reducedMotionFromEnv({ NO_MOTION: falsey }), false, `NO_MOTION=${falsey}`);
  }
});

test("currentVisuals reads CO_VISUALS and takes the caller's PlainIO word for it", () => {
  const prev = process.env.CO_VISUALS;
  try {
    process.env.CO_VISUALS = "off";
    assert.equal(currentVisuals({ isTTY: true, columns: 100 }).level, "off");

    process.env.CO_VISUALS = "full";
    // PlainIO is the one thing stdout can't report, so the session passes it in.
    assert.equal(currentVisuals({ plainIO: true }).level, "off");
    // Everything else forced capable: this must be the full treatment whether
    // the test runner's own stdout happens to be a TTY or a pipe.
    const capable = currentVisuals({
      isTTY: true,
      noColor: false,
      term: "xterm-256color",
      columns: 100,
      reducedMotion: false,
    });
    assert.equal(capable.animate, true);
  } finally {
    if (prev === undefined) delete process.env.CO_VISUALS;
    else process.env.CO_VISUALS = prev;
  }
});

// --- the branch label ---------------------------------------------------------

test("the dispatch label names the feature branch, in glyphs or in ASCII", () => {
  const target = { kind: "feature", branch: "co/feat-terminal-visuals" } as const;

  const fancy = stripAnsi(dispatchLabel(target, { glyphs: "unicode", color: true }));
  assert.equal(fancy, "  ≈≈▸ dispatching → co/feat-terminal-visuals");

  const plain = stripAnsi(dispatchLabel(target, { glyphs: "ascii", color: false }));
  assert.equal(plain, "  ~~> dispatching -> co/feat-terminal-visuals");
  assert.ok(isPlainAscii(plain), "the fallback label is 7-bit ASCII");
});

test("a bare-tree dispatch says so instead of inventing a branch name", () => {
  for (const glyphs of ["unicode", "ascii"] as const) {
    const label = stripAnsi(dispatchLabel({ kind: "main" }, { glyphs, color: glyphs === "unicode" }));
    assert.match(label, /the bare main tree \(no feature branch\)/);
    assert.ok(!label.includes("co/feat-"), "no branch is named for the main tree");
  }
  assert.ok(isPlainAscii(stripAnsi(dispatchLabel({ kind: "main" }, { glyphs: "ascii", color: false }))));
});

test("the saving line carries the same information in both alphabets", () => {
  assert.equal(stripAnsi(savingLabel({ glyphs: "unicode", color: true })), "  ≈≈ saving… fair winds");
  const plain = stripAnsi(savingLabel({ glyphs: "ascii", color: false }));
  assert.equal(plain, "  ~~ saving... fair winds");
  assert.ok(isPlainAscii(plain));
});

// --- the wave band ------------------------------------------------------------

test("waveBand fills exactly the requested width at any frame", () => {
  for (const width of [0, 1, 7, 8, 9, 40, 137]) {
    for (const frame of [0, 1, 5, 8, 97]) {
      assert.equal(waveBand(width, frame, "unicode").length, Math.max(0, width), `w${width} f${frame}`);
      assert.equal(waveBand(width, frame, "ascii").length, Math.max(0, width));
    }
  }
  assert.equal(waveBand(-4, 0, "unicode"), "");
});

test("waveBand rolls the swell one column to the right per frame", () => {
  const a = waveBand(20, 0, "unicode");
  const b = waveBand(20, 1, "unicode");
  assert.notEqual(a, b, "the band moves");
  assert.equal(b.slice(1), a.slice(0, 19), "what was at column N is at N+1");
});

test("waveBand draws water in ASCII when the glyphs are unavailable", () => {
  const fancy = waveBand(24, 3, "unicode");
  assert.ok(fancy.includes("≈"), "box-drawing water");
  const plain = waveBand(24, 3, "ascii");
  assert.ok(isPlainAscii(plain), "no glyph survives into the ASCII band");
  assert.ok(plain.includes("~"), "ASCII water is still water");
});

// --- the dispatch flourish ----------------------------------------------------

test("the flourish is two rows: rolling water over the destination label", () => {
  const target = { kind: "feature", branch: "co/feat-waves" } as const;
  const spec = dispatchFlourish({ target, glyphs: "unicode", color: true });
  assert.equal(spec.rows, 2);
  // Open-ended: it covers the launch, so it has no frame count of its own.
  assert.equal(spec.frames, undefined);
  assert.ok((spec.minDurationMs ?? 0) > 0, "an instant launch still reads as a departure");

  const frame = spec.render(0, 80);
  assert.equal(frame.length, 2, "exactly the rows it reserved");
  for (const row of frame) assert.ok(visibleWidth(row) <= 80, "never wider than the terminal");
  assert.match(stripAnsi(frame[1]!), /dispatching .* co\/feat-waves/, "the label row names the branch");
  assert.ok(stripAnsi(frame[0]!).includes("▸"), "the order runs out ahead of the swell");
});

test("the flourish actually animates: consecutive frames differ", () => {
  const spec = dispatchFlourish({
    target: { kind: "main" },
    glyphs: "unicode",
    color: false,
  });
  const first = spec.render(0, 80)[0];
  const second = spec.render(1, 80)[0];
  assert.notEqual(first, second, "the water row changes between frames");
  // The label is the information; it must not jitter.
  assert.equal(spec.render(0, 80)[1], spec.render(1, 80)[1]);
});

test("the flourish has a strictly ASCII form", () => {
  const spec = dispatchFlourish({
    target: { kind: "feature", branch: "co/feat-x" },
    glyphs: "ascii",
    color: false,
  });
  for (const frame of [0, 1, 9]) {
    for (const row of spec.render(frame, 72)) {
      assert.ok(isPlainAscii(row), `ASCII-only at frame ${frame}: ${JSON.stringify(row)}`);
    }
  }
});

test("the flourish survives an absurdly narrow render without throwing or wrapping", () => {
  const spec = dispatchFlourish({
    target: { kind: "feature", branch: "co/feat-x" },
    glyphs: "unicode",
    color: true,
  });
  for (const cols of [0, 1, 2, 3, 12]) {
    const rows = spec.render(4, cols);
    assert.equal(rows.length, 2);
    assert.ok(visibleWidth(rows[0]!) <= Math.max(0, cols), `water fits in ${cols} cols`);
  }
});

// --- the exit ship ------------------------------------------------------------

/** The hull's leftmost visible column in a rendered sea row, or -1 when the ship
 *  is off-screen. The sea has no underscores, so one locates the hull. */
function hullAt(seaRow: string): number {
  return stripAnsi(seaRow).indexOf("_");
}

test("the voyage is bounded and sized to the terminal", () => {
  assert.ok(voyageFrames(80) > voyageFrames(40), "a wider crossing takes longer");
  assert.ok(voyageFrames(0) > 0, "even a degenerate width terminates");
  const spec = exitVoyage({ cols: 80, glyphs: "unicode", color: true });
  assert.equal(spec.rows, 3);
  assert.equal(spec.frames, voyageFrames(80), "it ends itself rather than looping");
});

test("the ship sails left to right once and leaves clean water behind it", () => {
  const cols = 60;
  const spec = exitVoyage({ cols, glyphs: "unicode", color: false });
  const positions: number[] = [];
  for (let f = 0; f < spec.frames!; f++) {
    const rows = spec.render(f, cols);
    assert.equal(rows.length, 3, `three rows at frame ${f}`);
    for (const row of rows) assert.ok(visibleWidth(row) <= cols, `row fits at frame ${f}`);
    assert.equal(visibleWidth(rows[2]!), cols - 1, "the sea spans the width, off the last column");
    const at = hullAt(rows[2]!);
    if (at >= 0) positions.push(at);
  }
  assert.ok(positions.length > 3, "the ship is on screen for a real stretch of the voyage");
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i]! >= positions[i - 1]!, "the hull only ever moves right");
  }
  assert.equal(hullAt(spec.render(spec.frames! - 1, cols)[2]!), -1, "the last frame is open water");
});

test("the ship carries mast and sail above the waterline", () => {
  const spec = exitVoyage({ cols: 60, glyphs: "unicode", color: false });
  // Mid-voyage, so the whole sprite is on screen.
  const rows = spec.render(Math.floor(voyageFrames(60) / 2), 60).map(stripAnsi);
  assert.ok(rows[0]!.includes("│"), "a mast");
  assert.ok(rows[1]!.includes("/") && rows[1]!.includes("\\"), "a sail");
  assert.ok(rows[2]!.includes("\\___/"), "a hull cut into the water");
});

test("the ship has a strictly ASCII form", () => {
  const spec = exitVoyage({ cols: 60, glyphs: "ascii", color: false });
  for (let f = 0; f < spec.frames!; f++) {
    for (const row of spec.render(f, 60)) {
      assert.ok(isPlainAscii(row), `ASCII-only at frame ${f}: ${JSON.stringify(row)}`);
    }
  }
  const mid = spec.render(Math.floor(voyageFrames(60) / 2), 60).map(stripAnsi);
  assert.ok(mid[0]!.includes("|"), "an ASCII mast");
  assert.ok(mid[2]!.includes("\\___/"), "an ASCII hull");
});

test("a resize mid-voyage re-lays the sea rather than overflowing the row", () => {
  const spec = exitVoyage({ cols: 100, glyphs: "unicode", color: false });
  // Built for 100 columns, rendered into 44 after a SIGWINCH.
  for (let f = 0; f < spec.frames!; f++) {
    const rows = spec.render(f, 44);
    for (const row of rows) assert.ok(visibleWidth(row) <= 44, `frame ${f} fits the new width`);
    assert.equal(visibleWidth(rows[2]!), 43);
  }
});

// --- the bounded region in the Tui -------------------------------------------

interface Harness {
  tui: Tui;
  lastFramePlain(): string;
  stop(): void;
}

function harness(cols = 60, rows = 16): Harness {
  const writes: string[] = [];
  const out: OutStream = { write: (s) => writes.push(String(s)), columns: cols, rows };
  const inp: InStream = {
    isTTY: true,
    setRawMode: () => {},
    resume: () => {},
    pause: () => {},
    setEncoding: () => {},
    on: () => {},
    removeListener: () => {},
  };
  const tui = new Tui({ promptLabel: "you > ", out, inp });
  tui.start();
  return {
    tui,
    lastFramePlain: () => stripAnsi(writes[writes.length - 1] ?? ""),
    stop: () => tui.stop(),
  };
}

/** A spec whose rows are trivially greppable in a painted frame. */
function markerSpec(rows = 2): AnimationSpec {
  return {
    rows,
    render: (frame) => ["<<band>>", `<<label ${frame}>>`].slice(0, rows),
  };
}

test("playAnimation paints its region and clears it on stop", () => {
  const h = harness();
  void h.tui.question();
  const handle = h.tui.playAnimation(markerSpec());
  assert.equal(handle.animating, true);
  const frame = h.lastFramePlain();
  assert.match(frame, /<<band>>/, "the region is painted");
  assert.match(frame, /you > /, "the input bar is still there, below it");
  handle.stop();
  assert.doesNotMatch(h.lastFramePlain(), /<<band>>/, "stop clears the region");
  h.stop();
});

test("settle() clears the region and resolves", async () => {
  const h = harness();
  const handle = h.tui.playAnimation({ ...markerSpec(), minDurationMs: 0 });
  await handle.settle();
  assert.doesNotMatch(h.lastFramePlain(), /<<band>>/);
  // Idempotent: settling an already-settled animation is a no-op, not a hang.
  await handle.settle();
  handle.stop();
  h.stop();
});

test("nothing animates while model tokens are streaming", () => {
  const h = harness();
  h.tui.appendStream("co  › half an answer", { markdown: true });
  const handle = h.tui.playAnimation(markerSpec());
  assert.equal(handle.animating, false, "refused over an open stream");
  assert.doesNotMatch(h.lastFramePlain(), /<<band>>/);
  h.stop();
});

test("a stream that starts mid-animation kills the animation", () => {
  const h = harness();
  const handle = h.tui.playAnimation(markerSpec());
  assert.equal(handle.animating, true);
  h.tui.appendStream("tokens arriving", { markdown: true });
  assert.doesNotMatch(h.lastFramePlain(), /<<band>>/, "scenery yields to real output");
  h.stop();
});

test("the region is refused on a screen too narrow or too short to spare it", () => {
  const narrow = harness(30, 24);
  assert.equal(narrow.tui.playAnimation(markerSpec()).animating, false);
  assert.doesNotMatch(narrow.lastFramePlain(), /<<band>>/);
  narrow.stop();

  const short = harness(80, 9);
  assert.equal(short.tui.playAnimation(markerSpec(3)).animating, false);
  short.stop();
});

test("a real dispatch flourish paints the destination branch in the region", () => {
  const h = harness(72, 18);
  void h.tui.question();
  const handle = h.tui.playAnimation(
    dispatchFlourish({
      target: { kind: "feature", branch: "co/feat-terminal-visuals" },
      glyphs: "unicode",
      color: true,
    }),
  );
  assert.equal(handle.animating, true);
  assert.match(h.lastFramePlain(), /dispatching .* co\/feat-terminal-visuals/);
  handle.stop();
  h.stop();
});

test("teardown ends a voyage still under way and releases anyone waiting on it", async () => {
  const h = harness();
  const handle = h.tui.playAnimation({ ...markerSpec(3), minDurationMs: 60_000 });
  assert.equal(handle.animating, true);
  h.stop(); // the alt screen goes away mid-voyage
  // A minute-long floor must not be able to hold the exit: teardown settles it.
  await handle.settle();
});
