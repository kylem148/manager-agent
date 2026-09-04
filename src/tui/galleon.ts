/**
 * The galleon: the one ship this app draws, and the water it floats on.
 *
 * It used to live inside banner.ts, which was the only thing that drew it. The
 * Ctrl-O home panel now draws the same ship at the bottom of its own scene, and
 * the moment a second file wanted a ship there were two ways to end up with two
 * DIFFERENT ships: a copy-paste that drifts, or a "close enough" redraw. So the
 * art, its width, its colouring and the waterline it sits on are one module that
 * both surfaces import, and there is exactly one ship in the codebase.
 *
 * Every glyph is width-1 ASCII. Nothing here is wide or emoji: both callers do
 * column arithmetic around this art (a box border, a panel viewport), and a
 * two-column glyph counted as one desyncs the layout it sits in.
 *
 * The hull's PORTHOLES are the one part of it that is not fixed. The panel gives
 * the ship one window per tab in its bar and lights the one you are on, so the
 * count is a parameter and the row is rebuilt around it (galleonArt) rather than
 * being read off the block below. The block still says four, because four is
 * what the greeting draws and what an unparameterised ship is.
 */

import { c } from "../ui.js";

/**
 * The ship, authored as a raw block so the backslashes of the stern read
 * literally. Internal spacing is significant: every line shares the same left
 * origin, and the whole block is placed as a unit (never per-line, which would
 * shear the hull). String.raw keeps `\`, `\\`, `\\\` exactly as typed.
 */
export const GALLEON = String.raw`
            |>>=x
            |
      |     |     |
     )_)   )_)   )_)
    )___) )___) )___)\
   )_____)_____)_____)\\
 ___|_____|_____|_______\\\__
 \    o    o    o    o     /
  \~-~-~-~-~-~-~-~-~-~-~-~-/
`
  .split("\n")
  .filter((l) => l.length > 0);

/** Columns the ship occupies, measured from its widest line. */
export const GALLEON_WIDTH = Math.max(...GALLEON.map((l) => l.length));

/** Rows the ship occupies. */
export const GALLEON_HEIGHT = GALLEON.length;

/**
 * The row the portholes are cut into — the upper of the two hull rows, the one
 * between the gunwale and the waterline crest.
 *
 * It is a constant rather than a search for the `o`s, because a search is a
 * silent wrong answer the day someone adds an `o` to a sail. galleon.test.ts
 * pins it: the row this names, rebuilt at its authored porthole count, has to
 * come back byte-for-byte identical to what is typed above.
 */
export const GALLEON_PORTHOLE_ROW = 7;

/** The glyph one porthole is drawn with. Width-1, like everything else here. */
const PORTHOLE = "o";

/** Blank columns between two portholes when they all fit at full spacing. */
const PORTHOLE_GAP = 4;

/** The hull row's fixed ends. Everything between them is the porthole span, and
 *  its width is what every count is laid out inside — so a re-porthole-ed ship
 *  is exactly as wide as the authored one and GALLEON_WIDTH never moves. */
const HULL_BOW = " \\";
const HULL_STERN = "/";
const HULL_SPAN =
  GALLEON[GALLEON_PORTHOLE_ROW]!.length - HULL_BOW.length - HULL_STERN.length;

/** How many portholes the ship is authored with, and the count it draws when
 *  nobody asks for another — the banner's greeting, chiefly, which has no tabs
 *  to count. */
export const GALLEON_PORTHOLES = [...GALLEON[GALLEON_PORTHOLE_ROW]!].filter(
  (ch) => ch === PORTHOLE,
).length;

/** Which columns of a hull row are windows, and which of them has a lamp in it.
 *  Handed to galleonRow, which is what turns it into colour. */
export interface HullLights {
  /** Every porthole's column in that row, left to right. */
  cols: number[];
  /** Which of them is lit, as an index into `cols`, or null for none. */
  lit: number | null;
}

/** The ship as text, plus where its windows are so a caller can light them. */
export interface GalleonArt {
  /** The block, top to bottom. Always GALLEON_HEIGHT rows of GALLEON_WIDTH-safe
   *  text: only the hull row is ever rebuilt, and only within its own span. */
  lines: string[];
  /** Which row the portholes are on. */
  litRow: number;
  /** That row's windows, or null when the ship was not given a bar to carry —
   *  the greeting's ship, whose hull is painted as plain timber. */
  lights: HullLights | null;
}

/**
 * The ship with `portholes` windows on its hull, the `lit` one (an index into
 * that same run, left to right) marked for gold.
 *
 * The windows are laid out at a fixed gap and CENTRED in the hull span, so a
 * ship with three of them is a three-window ship rather than a four-window ship
 * missing one — the eye reads a hole where a porthole was left out. The gap
 * tightens only if a count arrives that will not fit at full spacing, which the
 * panel's four tabs cannot produce and which is here so that a fifth tab is a
 * narrower ship rather than a broken one.
 *
 * The row's WIDTH is invariant under all of it. Both callers do column
 * arithmetic around this art, and a hull row that grew or shrank with the tab
 * count would shear the scene it sits in.
 */
export function galleonArt(
  portholes?: number,
  lit: number | null = null,
): GalleonArt {
  const { row, cols } = hullRow(portholes ?? GALLEON_PORTHOLES);
  const lines = [...GALLEON];
  lines[GALLEON_PORTHOLE_ROW] = row;
  // No count asked for means no bar to carry: the greeting's ship, whose hull is
  // plain timber and whose windows are part of the woodwork.
  const lights =
    portholes === undefined ? null : { cols, lit: lit !== null && lit >= 0 && lit < cols.length ? lit : null };
  return { lines, litRow: GALLEON_PORTHOLE_ROW, lights };
}

/** The hull row for `count` portholes, and the column each one landed on. */
function hullRow(count: number): { row: string; cols: number[] } {
  // At most one porthole per column, and never a negative count: this is fed
  // from a tab bar, and a scene must not be able to throw over a bad number.
  const n = Math.max(0, Math.min(Math.trunc(count), HULL_SPAN));
  const gap = n < 2 ? 0 : Math.min(PORTHOLE_GAP, Math.floor((HULL_SPAN - n) / (n - 1)));
  const left = Math.floor((HULL_SPAN - (n + gap * (n - 1))) / 2);

  const cols: number[] = [];
  let inner = " ".repeat(left);
  for (let i = 0; i < n; i++) {
    if (i > 0) inner += " ".repeat(gap);
    cols.push(HULL_BOW.length + inner.length);
    inner += PORTHOLE;
  }
  return { row: HULL_BOW + inner.padEnd(HULL_SPAN, " ") + HULL_STERN, cols };
}

/**
 * Colour one row of the ship, by its index within the block.
 *
 * The flag pennant at the masthead flies red (Jolly Roger); the lowest hull row
 * is the crest of the sea, so it takes the water's blue, which is what lets the
 * hull meet a waterline drawn underneath it without a seam. Everything between,
 * masts and hull and decks, is the warm timber yellow of the galleon.
 *
 * `lights` puts a lamp in EVERY window of this row and turns one of them up. A
 * ship at anchor with one dark porthole per tab you are not on reads as a ship
 * with the lights off; a ship with every window warm and one of them brighter
 * reads as a ship, which is the point of drawing one.
 *
 * Both lamps are yellow — amber, and a brighter yellow over it. They come out of
 * the 256-colour cube rather than the base palette, and that is forced rather
 * than chosen: a theme decides what its yellow and its bright yellow ARE, and
 * Ghostty's default puts them at #f0c674 and #e7c547, which are the same colour
 * to the eye and the second of which is fractionally the darker. Two windows a
 * column apart cannot carry a difference the theme is allowed to flatten, so the
 * two yellows name themselves.
 *
 * Each window is painted as its own span rather than nested inside the row's
 * yellow, because `c` closes every colour with a full reset and a nested one
 * would strip the timber off everything after it.
 *
 * The colour goes through the shared `c` helper, so NO_COLOR, a pipe and
 * TERM=dumb strip it here exactly as everywhere else, and the art keeps its
 * exact column count either way. A stripped hull is simply a row of plain
 * windows: this says nothing the tab bar has not already said in words.
 */
export function galleonRow(
  line: string,
  i: number,
  total: number,
  lights: HullLights | null = null,
): string {
  if (i === 0) return c.red(line);
  if (i === total - 1) return c.blue(line);
  if (!lights || lights.cols.length === 0) return c.yellow(line);

  let out = "";
  let at = 0;
  for (const [n, col] of lights.cols.entries()) {
    if (col < at || col >= line.length) continue; // off this row; leave it timber
    if (col > at) out += c.yellow(line.slice(at, col));
    out += n === lights.lit ? c.lampBright(line[col]!) : c.lamp(line[col]!);
    at = col + 1;
  }
  if (at < line.length) out += c.yellow(line.slice(at));
  return out;
}

/**
 * A stylized waterline that fills `width` columns. A repeating `~~~^` gives a
 * gentle swell without any wide glyphs, so alignment stays exact.
 *
 * `phase` slides the window along the pattern, which is what lets a caller
 * animate the swell: raising it by one walks the crests one column to the LEFT,
 * so a ship drawn over it reads as making way to the right. It is normalised
 * modulo the pattern, so any integer — including a negative one, or a frame
 * counter that has run for hours — is a legal phase. Phase 0 is the still
 * water the banner draws, and the width is exact at every phase.
 */
export function seaLine(width: number, phase = 0): string {
  if (width <= 0) return "";
  const unit = "~~~^";
  const off = ((phase % unit.length) + unit.length) % unit.length;
  let out = "";
  while (out.length < width + unit.length) out += unit;
  return out.slice(off, off + width);
}
