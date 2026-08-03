/**
 * The ocean scene at the foot of the Ctrl-O home tab: a waterline over the sea
 * floor, with the galleon from the session-start greeting riding on it.
 *
 * This is decoration, and it is the only thing in the panel that is. Everything
 * else on Home answers a question; this answers none, and exists because opening
 * the panel should feel like something. That makes the yield rule the whole
 * design rather than a detail of it:
 *
 *   DECORATION ALWAYS LOSES TO CONTENT. No row of the task table or the worktree
 *   list is ever clipped, scrolled, truncated or pushed off screen to keep a
 *   glyph of this on screen.
 *
 * So the scene is drawn out of the room the real content did not use, and gives
 * that room back in a fixed order as the content grows:
 *
 *   plenty of room  →  ship + waterline + sea floor
 *   less room       →  waterline + sea floor  (the ship goes first)
 *   less again      →  nothing at all
 *
 * Width works the same way: below a minimum the ship is absent rather than
 * clipped, because half a hull is worse than open water. The waterline itself is
 * a tile and fits any width, so it is the last thing to go.
 *
 * It is STATIC. There is no timer, no frame counter and no repaint loop here:
 * the rows are a pure function of (width, spare rows), rebuilt on the paints the
 * panel was already doing. Nothing about this scene ever causes one.
 */

import { c } from "../ui.js";
import { GALLEON, GALLEON_HEIGHT, GALLEON_WIDTH, galleonRow, seaLine } from "./galleon.js";

/** Left inset: the same two columns every other row of the panel is indented by,
 *  so the water starts where the content starts. */
const SEA_LEFT = 2;

/** Columns kept clear at the right edge. Writing into a terminal's last column
 *  triggers its auto-wrap on the row, which the banner avoids for the same
 *  reason, and this is the bottom of the screen, where a wrap costs a line. */
const SEA_RIGHT = 1;

/** The sea itself: the waterline, and the floor under it. */
const SEA_ROWS = 2;

/** Blank rows kept between the last row of real content and the top of the
 *  scene, so the art never reads as part of the list above it. */
const SEA_GAP = 1;

/** Below this the water is too short a stub to read as water; draw nothing. */
const MIN_SEA_COLS = 8;

/** Open water kept on each side of the hull. The ship appears only when it fits
 *  with this to spare, so it is never wedged against the edge and never clipped
 *  mid-hull. At narrower widths there is simply no ship. */
const SHIP_CLEARANCE = 2;

/**
 * The sea floor: scattered sand and pebbles, tiled. Deliberately a fixed
 * repeating unit rather than anything sampled: the scene is static, and a
 * randomised floor would redraw differently on every repaint.
 */
const FLOOR_UNIT = "  .  ,   . :  o   ,  .";

/** The narrowest terminal that can hold the ship, chrome included. Exported so
 *  the width gate can be asserted against one number rather than restated. */
export const OCEAN_SHIP_MIN_COLS =
  GALLEON_WIDTH + SHIP_CLEARANCE * 2 + SEA_LEFT + SEA_RIGHT;

/** The shallowest spare-row count that still holds the ship. */
export const OCEAN_SHIP_MIN_ROWS = GALLEON_HEIGHT + SEA_ROWS + SEA_GAP;

/** The shallowest spare-row count that still holds the waterline. */
export const OCEAN_SEA_MIN_ROWS = SEA_ROWS + SEA_GAP;

/**
 * The scene's own rows, top to bottom, with no leading padding: either the ship
 * over the sea, or the sea alone, or nothing. `spare` is how many rows of the
 * viewport the real content left unused.
 */
export function oceanScene(cols: number, spare: number): string[] {
  const seaWidth = cols - SEA_LEFT - SEA_RIGHT;
  if (seaWidth < MIN_SEA_COLS) return [];
  if (spare < OCEAN_SEA_MIN_ROWS) return [];

  const indent = " ".repeat(SEA_LEFT);
  const sea = [
    indent + c.blue(seaLine(seaWidth)),
    indent + c.dim(floorLine(seaWidth)),
  ];

  // The ship is the first thing to yield, on either axis: it needs its own rows
  // AND its own columns, and failing either leaves the water drawn without it.
  const roomForShip =
    cols >= OCEAN_SHIP_MIN_COLS && spare >= OCEAN_SHIP_MIN_ROWS;
  if (!roomForShip) return sea;

  // Centered in the water as a block, so the hull keeps its internal alignment.
  const margin = indent + " ".repeat(Math.floor((seaWidth - GALLEON_WIDTH) / 2));
  const ship = GALLEON.map((line, i) => galleonRow(margin + line, i, GALLEON_HEIGHT));
  return [...ship, ...sea];
}

/**
 * The scene padded to sit at the BOTTOM of the space it was given: `spare` rows
 * in total, blank until the art starts, so the sea floor lands on the viewport's
 * last row. Returns nothing at all when there is no room for a scene, which is
 * the case the caller appends to its content unchanged.
 *
 * Because the result never exceeds the spare rows, the Home body it is appended
 * to never outgrows the viewport on account of the art, so the art can never
 * push a row of content out of view, or invent a scroll position, or put a "more
 * below" count on the footer.
 */
export function oceanRows(cols: number, spare: number): string[] {
  const scene = oceanScene(cols, spare);
  if (scene.length === 0) return [];
  return [...new Array<string>(spare - scene.length).fill(""), ...scene];
}

/** The sea floor, tiled to `width` columns. */
function floorLine(width: number): string {
  let out = "";
  while (out.length < width) out += FLOOR_UNIT;
  return out.slice(0, width).replace(/\s+$/, "");
}
