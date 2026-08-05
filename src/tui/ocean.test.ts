import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GALLEON,
  GALLEON_HEIGHT,
  GALLEON_PORTHOLE_ROW,
  GALLEON_PORTHOLES,
  GALLEON_WIDTH,
  galleonArt,
} from "./galleon.js";
import {
  OCEAN_SEA_MIN_ROWS,
  OCEAN_SHIP_MIN_COLS,
  OCEAN_SHIP_MIN_ROWS,
  OCEAN_TICK_MS,
  oceanRows,
  oceanScene,
} from "./ocean.js";
import { stripAnsi, visibleWidth } from "./wrap.js";

/**
 * The ocean at the foot of the Ctrl-O home tab.
 *
 * This is the only purely decorative thing in the panel, and every test here is
 * about the same rule: it is drawn out of room the content did not want, and it
 * gives that room back before the content gives up a single line. The order is
 * fixed: the ship goes first, the water second, and by the time either is gone
 * the rows it was using are already the content's again.
 *
 * The panel-level proof that no row of the task table or the worktree list is
 * ever lost to this lives in overlay.test.ts, against real painted frames. These
 * are the arithmetic underneath it.
 */

/** The rows with their colour stripped. `colorEnabled` is false under a test
 *  runner anyway, but the art must be assertable either way. */
function plain(rows: string[]): string[] {
  return rows.map((r) => stripAnsi(r));
}

const WIDE = 90;

test("with room for both, the scene is the greeting's own ship over the water", () => {
  const scene = plain(oceanScene(WIDE, 40));
  assert.equal(scene.length, GALLEON_HEIGHT + 1, "the ship and a waterline, and nothing else");

  // The ship is THE ship: the same art the fresh-session greeting draws, laid
  // down as a block with one shared left margin, never re-authored per surface.
  const ship = scene.slice(0, GALLEON_HEIGHT);
  const margin = ship[0]!.length - ship[0]!.trimStart().length - (GALLEON[0]!.length - GALLEON[0]!.trimStart().length);
  assert.deepEqual(ship.map((l) => l.slice(margin)), GALLEON, "identical to the banner's galleon");

  // And it floats: the hull's last row sits directly on the waterline, which is
  // the last row of the scene. Nothing is drawn below the water.
  assert.match(scene.at(-1)!, /~~~\^/, "a waterline under the hull, and the scene ends there");
});

test("the waterline is the last row of the scene, at every size and every frame", () => {
  // The sea floor that used to sit under the water is gone, and gone means gone:
  // the scene got shorter rather than keeping a blank row where it was. Anything
  // else would be a row of content spent on nothing.
  for (const cols of [12, 34, 36, 80, 200]) {
    for (const spare of [2, 3, 8, 13, 40]) {
      for (const frame of [0, 1, 5, 9]) {
        const scene = plain(oceanScene(cols, spare, frame));
        if (scene.length === 0) continue;
        assert.match(scene.at(-1)!, /~~~\^/, `cols=${cols} spare=${spare}: the water is the last row`);
      }
    }
  }
});

test("the ship is the first thing to yield: one row short and the water stands alone", () => {
  const roomy = oceanScene(WIDE, OCEAN_SHIP_MIN_ROWS);
  assert.equal(roomy.length, GALLEON_HEIGHT + 1, "at its floor the ship is still drawn");

  const tight = plain(oceanScene(WIDE, OCEAN_SHIP_MIN_ROWS - 1));
  assert.equal(tight.length, 1, "one row less and the ship is gone, not shrunk");
  assert.match(tight[0]!, /~~~\^/, "the waterline is what's left");
  assert.ok(!tight.join("\n").includes("|>>=x"), "no mast, no pennant, no half a ship");
});

test("the water yields next, and below its own floor there is no scene at all", () => {
  assert.equal(oceanScene(WIDE, OCEAN_SEA_MIN_ROWS).length, 1, "at its floor the water is drawn");
  assert.deepEqual(oceanScene(WIDE, OCEAN_SEA_MIN_ROWS - 1), [], "one row less and it is gone");
  assert.deepEqual(oceanScene(WIDE, 0), [], "no spare room is no scene");
  assert.deepEqual(oceanScene(WIDE, -4), [], "and an overflowing body is not a crash");
});

test("at a narrow width the ship is absent, never a clipped hull", () => {
  const narrow = plain(oceanScene(OCEAN_SHIP_MIN_COLS - 1, 40));
  assert.equal(narrow.length, 1, "water only");
  assert.ok(!narrow.join("\n").includes(")_)"), "not one column of the hull");

  const wide = plain(oceanScene(OCEAN_SHIP_MIN_COLS, 40));
  assert.equal(wide.length, GALLEON_HEIGHT + 1, "one column more and it sails");

  // The property, swept: at NO width is a row of the ship painted partially.
  for (let cols = 0; cols < 120; cols++) {
    const rows = plain(oceanScene(cols, 40));
    const hull = rows.filter((r) => /[)\\|]/.test(r));
    if (hull.length === 0) continue;
    assert.equal(hull.length, GALLEON_HEIGHT, `cols=${cols}: a ship is whole or absent`);
    for (const [i, r] of hull.entries()) {
      assert.ok(r.trimStart().startsWith(GALLEON[i]!.trimStart()), `cols=${cols}: row ${i} is intact`);
    }
  }
});

test("a terminal too narrow for any water draws nothing rather than a stub", () => {
  for (const cols of [0, 1, 5, 10]) {
    assert.deepEqual(oceanScene(cols, 40), [], `cols=${cols}`);
  }
});

test("no row of the scene ever reaches the terminal's last column", () => {
  for (let cols = 1; cols < 200; cols++) {
    for (const row of oceanScene(cols, 40)) {
      assert.ok(visibleWidth(row) < cols, `cols=${cols}: ${JSON.stringify(stripAnsi(row))}`);
    }
  }
});

test("oceanRows fills exactly the spare rows and pins the scene to the last of them", () => {
  const spare = 20;
  const rows = plain(oceanRows(WIDE, spare));
  assert.equal(rows.length, spare, "it takes the room it was offered, and no more");
  assert.match(rows.at(-1)!, /~~~\^/, "the waterline lands on the bottom row");
  const blanks = rows.filter((r) => r.trim() === "").length;
  assert.equal(blanks, spare - (GALLEON_HEIGHT + 1), "everything above the scene is empty");
  assert.ok(rows.slice(0, blanks).every((r) => r.trim() === ""), "and the blanks are all at the top");
});

test("oceanRows can never cost a row: it returns at most the spare it was given", () => {
  for (let spare = -5; spare < 60; spare++) {
    for (const cols of [12, 34, 36, 80, 200]) {
      const rows = oceanRows(cols, spare);
      assert.ok(rows.length === 0 || rows.length === spare, `cols=${cols} spare=${spare}`);
      assert.ok(rows.length <= Math.max(0, spare), `cols=${cols} spare=${spare}: never more than the leftovers`);
    }
  }
});

test("a repaint on the same frame renders the same rows, every time", () => {
  // No clock, no sampling, no state. Two paints on one frame must be
  // byte-identical, or the panel would flicker on every keystroke.
  const once = oceanScene(WIDE, 40, 7);
  for (let n = 0; n < 5; n++) assert.deepEqual(oceanScene(WIDE, 40, 7), once);
  assert.deepEqual(oceanScene(WIDE, 40), oceanScene(WIDE, 40, 0), "no frame means frame 0");
});

test("the art is width-1 ASCII throughout, so the panel's columns cannot desync", () => {
  for (const frame of [0, 1, 2, 5, 13]) {
    for (const row of plain(oceanScene(WIDE, 40, frame))) {
      assert.match(row, /^[\x20-\x7e]*$/, `non-ASCII at frame ${frame}: ${JSON.stringify(row)}`);
      assert.equal(visibleWidth(row), row.length, "one char, one column");
    }
  }
  assert.equal(GALLEON_WIDTH, Math.max(...GALLEON.map((l) => l.length)));
});

// --- the portholes -----------------------------------------------------------
//
// The hull carries one window per tab in the panel's bar. That is charm and not
// information, so what these pin is that it cannot COST anything: the row keeps
// its width at every count, the block keeps its height, and a count nobody
// should ever pass still comes back as a ship.

/** The windows on a hull row: their columns, left to right. */
function windowsOf(row: string): number[] {
  return [...row].flatMap((ch, i) => (ch === "o" ? [i] : []));
}

test("the authored ship is what the builder gives back at its own count", () => {
  // The one guard against the row index drifting away from the art above it: if
  // someone reorders a line of the block, this rebuild stops matching.
  const art = galleonArt();
  assert.deepEqual(art.lines, GALLEON, "no argument means the ship as typed");
  assert.equal(art.litRow, GALLEON_PORTHOLE_ROW);
  assert.equal(art.lights, null, "and no bar to carry, so the hull is plain timber");
  assert.equal(
    windowsOf(GALLEON[GALLEON_PORTHOLE_ROW]!).length,
    GALLEON_PORTHOLES,
    "the authored count is read off the authored row",
  );
});

test("a count changes what is on the hull row and never how wide it is", () => {
  const authored = GALLEON[GALLEON_PORTHOLE_ROW]!;
  for (let n = 0; n <= 6; n++) {
    const art = galleonArt(n);
    const row = art.lines[GALLEON_PORTHOLE_ROW]!;
    assert.equal(windowsOf(row).length, n, `${n} tabs put ${n} windows on the hull`);
    assert.equal(row.length, authored.length, `${n}: the row is exactly as long as it was`);
    assert.equal(art.lines.length, GALLEON_HEIGHT, `${n}: and the block exactly as tall`);
    assert.equal(GALLEON_WIDTH, Math.max(...art.lines.map((l) => l.length)), `${n}: same ship width`);
    assert.match(row, /^ \\[ o]+\/$/, `${n}: bow and stern untouched`);
  }
});

test("the windows are centred on the hull, so a short bar is not a gap-toothed ship", () => {
  for (const n of [1, 2, 3, 4, 5]) {
    const row = galleonArt(n).lines[GALLEON_PORTHOLE_ROW]!;
    const cols = windowsOf(row);
    const lead = cols[0]! - 2; // past the bow
    const trail = row.length - 1 - cols.at(-1)! - 1; // back from the stern
    assert.ok(Math.abs(lead - trail) <= 1, `${n}: the run sits amidships (${lead} vs ${trail})`);
  }
});

test("the lights name every window and light exactly one of them", () => {
  for (let lit = 0; lit < 4; lit++) {
    const art = galleonArt(4, lit);
    assert.deepEqual(
      art.lights?.cols,
      windowsOf(art.lines[GALLEON_PORTHOLE_ROW]!),
      `lit=${lit}: every window's column is handed over, not just the lit one`,
    );
    assert.equal(art.lights?.lit, lit, `window ${lit} is the one with the lamp in it`);
  }
  // A bar index that is not in the bar is a darkened ship, never a broken one —
  // and its windows are still named, so they are still drawn as windows.
  for (const lit of [-1, 4, 99]) {
    const lights = galleonArt(4, lit).lights;
    assert.equal(lights?.lit, null, `lit=${lit} lights nothing`);
    assert.equal(lights?.cols.length, 4, `lit=${lit}: the four windows are still there`);
  }
});

test("a nonsense count is still a ship", () => {
  // Nothing in the panel can produce these — the bar has at most four tabs — and
  // the scene must not be the thing that throws if something ever does.
  for (const n of [-3, 0, 0.5, 999]) {
    const row = galleonArt(n).lines[GALLEON_PORTHOLE_ROW]!;
    assert.equal(row.length, GALLEON[GALLEON_PORTHOLE_ROW]!.length, `count ${n}: the hull holds`);
    assert.match(row, /^ \\[ o]+\/$/, `count ${n}: still a hull`);
  }
});

test("the scene passes the panel's windows through to the ship it draws", () => {
  const hull = (ports?: { count: number; lit: number }): string =>
    plain(oceanScene(WIDE, 40, 0, ports))[GALLEON_PORTHOLE_ROW]!;
  assert.equal(windowsOf(hull()).length, GALLEON_PORTHOLES, "no bar means the authored ship");
  assert.equal(windowsOf(hull({ count: 3, lit: 1 })).length, 3, "three tabs, three windows");
  assert.equal(windowsOf(hull({ count: 2, lit: 0 })).length, 2, "two tabs, two windows");

  // The sway moves the lit window with the hull rather than leaving it behind:
  // the column is the art's own, so the two can never come apart.
  for (const frame of [0, 1, 2, 3, 4, 7]) {
    const rows = plain(oceanScene(WIDE, 40, frame, { count: 4, lit: 2 }));
    assert.equal(windowsOf(rows[GALLEON_PORTHOLE_ROW]!).length, 4, `frame ${frame}: four windows still`);
  }
});

// --- the tide ----------------------------------------------------------------
//
// The second half of the scene, and the half that has to earn its place: motion
// at the bottom of a page whose job is a task table. So these tests are as much
// about what does NOT move as about what does — the row count, the content's
// room — because a decoration that moves is a decoration with a new set of ways
// to cost the captain a line.

/** The waterline of a scene — the last row of it — without indent or colour. */
function water(cols: number, spare: number, frame: number): string {
  return stripAnsi(oceanScene(cols, spare, frame).at(-1) ?? "").trimStart();
}

/** How far the ship's block sits from the left edge on `frame`. */
function shipAt(frame: number): number {
  const row = stripAnsi(oceanScene(WIDE, 40, frame)[0] ?? "");
  return row.length - row.trimStart().length;
}

test("the water drifts one column a frame", () => {
  // The swell is the motion the scene has left now that the floor under it is
  // gone: the waterline itself slides, and the hull sways over it (below).
  for (let f = 0; f < 9; f++) {
    const now = water(WIDE, 40, f);
    const next = water(WIDE, 40, f + 1);
    assert.notEqual(next, now, `frame ${f}: the swell moves`);
    assert.equal(next.slice(0, -1), now.slice(1), `frame ${f}: it moves by exactly one column`);
    assert.equal(next.length, now.length, "and the row is the same width either way");
  }
});

test("the ship rides the swell: it sways a column, whole, and never further", () => {
  const centre = shipAt(0);
  const seen = new Set<number>();
  for (let f = 0; f < 40; f++) {
    const at = shipAt(f);
    seen.add(at - centre);
    assert.ok(Math.abs(at - centre) <= 1, `frame ${f}: the sway is a column, not a voyage`);
    // Whole or absent is the rule at every frame, exactly as it is at every
    // width: a sway that clipped a mast would be worse than no sway at all.
    const ship = plain(oceanScene(WIDE, 40, f)).slice(0, GALLEON_HEIGHT);
    for (const [i, r] of ship.entries()) {
      assert.ok(r.trimStart().startsWith(GALLEON[i]!.trimStart()), `frame ${f}: row ${i} is intact`);
    }
  }
  assert.deepEqual([...seen].sort(), [-1, 0, 1], "it rolls both ways, and rests amidships");
});

test("the two motions are slow, and out of step with each other", () => {
  assert.ok(OCEAN_TICK_MS >= 500, `a frame lasts ${OCEAN_TICK_MS}ms: half a second or slower`);
  // A scene that repeated every few seconds would read as a loop rather than as
  // weather. The water's period is 4 frames; the ship's must not divide into it.
  const period = (at: (f: number) => unknown): number => {
    const first = JSON.stringify(at(0));
    for (let f = 1; f < 200; f++) if (JSON.stringify(at(f)) === first) return f;
    return -1;
  };
  const swell = period((f) => water(WIDE, 40, f));
  const whole = period((f) => oceanScene(WIDE, 40, f));
  assert.equal(swell, 4, "the swell alone is a four-frame loop");
  assert.ok(whole >= swell * 4, `the ship stretches that to ${whole} frames, not ${swell}`);
  assert.ok(whole * OCEAN_TICK_MS >= 10_000, `${whole} frames is ${whole * OCEAN_TICK_MS}ms of it`);
});

test("a frame is a phase: any integer is legal, and none of them is a special case", () => {
  const ref = oceanScene(WIDE, 40, 3);
  assert.deepEqual(oceanScene(WIDE, 40, 3 + 20), ref, "it comes back around");
  assert.deepEqual(oceanScene(WIDE, 40, 3 - 20), ref, "in both directions");
  for (const frame of [-7, -1, 999_999]) {
    const rows = plain(oceanScene(WIDE, 40, frame));
    assert.equal(rows.length, GALLEON_HEIGHT + 1, `frame ${frame} draws the whole scene`);
    for (const row of rows) assert.ok(visibleWidth(row) < WIDE, `frame ${frame} fits`);
  }
});

test("no frame can cost a row or reach the last column, at any size", () => {
  // The yield arithmetic is written against the scene's HEIGHT, so the one thing
  // the frame must never change is how many rows come back.
  for (let cols = 0; cols < 120; cols++) {
    for (let spare = -2; spare < 24; spare++) {
      const still = oceanScene(cols, spare).length;
      for (const frame of [1, 2, 5, 9]) {
        const scene = oceanScene(cols, spare, frame);
        assert.equal(scene.length, still, `cols=${cols} spare=${spare} frame=${frame}: same height`);
        for (const row of scene) {
          assert.ok(visibleWidth(row) < cols, `cols=${cols} frame=${frame}: off the last column`);
        }
        const padded = oceanRows(cols, spare, frame);
        assert.ok(padded.length <= Math.max(0, spare), `cols=${cols} spare=${spare}: never more`);
      }
    }
  }
});
