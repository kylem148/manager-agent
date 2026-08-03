import { test } from "node:test";
import assert from "node:assert/strict";
import { GALLEON, GALLEON_HEIGHT, GALLEON_WIDTH } from "./galleon.js";
import {
  OCEAN_SEA_MIN_ROWS,
  OCEAN_SHIP_MIN_COLS,
  OCEAN_SHIP_MIN_ROWS,
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
  assert.equal(scene.length, GALLEON_HEIGHT + 2, "the ship, a waterline, a sea floor");

  // The ship is THE ship: the same art the fresh-session greeting draws, laid
  // down as a block with one shared left margin, never re-authored per surface.
  const ship = scene.slice(0, GALLEON_HEIGHT);
  const margin = ship[0]!.length - ship[0]!.trimStart().length - (GALLEON[0]!.length - GALLEON[0]!.trimStart().length);
  assert.deepEqual(ship.map((l) => l.slice(margin)), GALLEON, "identical to the banner's galleon");

  // And it floats: the hull's last row sits directly on the waterline.
  assert.match(scene.at(-2)!, /~~~\^/, "a waterline under the hull");
  assert.match(scene.at(-1)!, /\./, "and a sea floor under that");
});

test("the ship is the first thing to yield: one row short and the water stands alone", () => {
  const roomy = oceanScene(WIDE, OCEAN_SHIP_MIN_ROWS);
  assert.equal(roomy.length, GALLEON_HEIGHT + 2, "at its floor the ship is still drawn");

  const tight = plain(oceanScene(WIDE, OCEAN_SHIP_MIN_ROWS - 1));
  assert.equal(tight.length, 2, "one row less and the ship is gone, not shrunk");
  assert.match(tight[0]!, /~~~\^/, "the waterline is what's left");
  assert.ok(!tight.join("\n").includes("|>>=x"), "no mast, no pennant, no half a ship");
});

test("the water yields next, and below its own floor there is no scene at all", () => {
  assert.equal(oceanScene(WIDE, OCEAN_SEA_MIN_ROWS).length, 2, "at its floor the water is drawn");
  assert.deepEqual(oceanScene(WIDE, OCEAN_SEA_MIN_ROWS - 1), [], "one row less and it is gone");
  assert.deepEqual(oceanScene(WIDE, 0), [], "no spare room is no scene");
  assert.deepEqual(oceanScene(WIDE, -4), [], "and an overflowing body is not a crash");
});

test("at a narrow width the ship is absent, never a clipped hull", () => {
  const narrow = plain(oceanScene(OCEAN_SHIP_MIN_COLS - 1, 40));
  assert.equal(narrow.length, 2, "water only");
  assert.ok(!narrow.join("\n").includes(")_)"), "not one column of the hull");

  const wide = plain(oceanScene(OCEAN_SHIP_MIN_COLS, 40));
  assert.equal(wide.length, GALLEON_HEIGHT + 2, "one column more and it sails");

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
  assert.match(rows.at(-1)!, /\./, "the sea floor lands on the bottom row");
  const blanks = rows.filter((r) => r.trim() === "").length;
  assert.equal(blanks, spare - (GALLEON_HEIGHT + 2), "everything above the scene is empty");
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

test("the scene is static: the same size renders the same rows, every time", () => {
  // No timer, no frame counter, no sampling. A repaint at an unchanged size must
  // be byte-identical, or the panel would flicker on every keystroke.
  const once = oceanScene(WIDE, 40);
  for (let n = 0; n < 5; n++) assert.deepEqual(oceanScene(WIDE, 40), once);
});

test("the art is width-1 ASCII throughout, so the panel's columns cannot desync", () => {
  const rows = plain(oceanScene(WIDE, 40));
  for (const row of rows) {
    assert.match(row, /^[\x20-\x7e]*$/, `non-ASCII in the scene: ${JSON.stringify(row)}`);
    assert.equal(visibleWidth(row), row.length, "one char, one column");
  }
  assert.equal(GALLEON_WIDTH, Math.max(...GALLEON.map((l) => l.length)));
});
