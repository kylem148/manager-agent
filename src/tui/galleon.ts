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
 * Colour one row of the ship, by its index within the block.
 *
 * The flag pennant at the masthead flies red (Jolly Roger); the lowest hull row
 * is the crest of the sea, so it takes the water's blue, which is what lets the
 * hull meet a waterline drawn underneath it without a seam. Everything between,
 * masts and hull and decks, is the warm timber yellow of the galleon.
 *
 * The colour goes through the shared `c` helper, so NO_COLOR, a pipe and
 * TERM=dumb strip it here exactly as everywhere else, and the art keeps its
 * exact column count either way.
 */
export function galleonRow(line: string, i: number, total: number): string {
  if (i === 0) return c.red(line);
  if (i === total - 1) return c.blue(line);
  return c.yellow(line);
}

/**
 * A stylized waterline that fills `width` columns. A repeating `~~~^` gives a
 * gentle swell without any wide glyphs, so alignment stays exact.
 */
export function seaLine(width: number): string {
  const unit = "~~~^";
  let out = "";
  while (out.length < width) out += unit;
  return out.slice(0, width);
}
