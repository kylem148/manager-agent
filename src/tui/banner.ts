/**
 * The fancy on-load banner: a boxed pirate galleon shown at the top of the
 * interactive session, in the spirit of Claude Code's "welcome back" panel.
 *
 * Why it lives here and not inline in session.ts: it's pure presentation with a
 * bit of layout math (ANSI-aware centering, auto-sizing the frame to the widest
 * line, a width gate for narrow terminals) that would clutter the session loop.
 *
 * Contract:
 *  - Returns a multi-line string ready to hand to the TUI as its header, or
 *    null when the terminal is too narrow to render the frame cleanly — the
 *    caller falls back to the plain text banner in that case.
 *  - Scales to the terminal: the box fills the full width, the ship stays fixed
 *    and centered in the middle, and the ocean/waterline stretches to fill
 *    whatever width is left. The wider the terminal, the longer the ocean.
 *  - Only the interactive TUI uses this. Piped / non-TTY sessions keep the plain
 *    line-oriented banner so scripts and tests stay deterministic.
 *  - All width math goes through visibleWidth() so embedded SGR color codes
 *    never throw off the box alignment. Every art glyph is width-1 ASCII or a
 *    width-1 box-drawing char — no emoji / wide glyphs, which would desync the
 *    border by rendering as two columns while counting as one.
 */

import { visibleWidth } from "./wrap.js";
import { c } from "../ui.js";

/** Frame chrome per row: "│ " on the left + " │" on the right = 4 columns. */
const CHROME = 4;

/** Minimum blank columns kept outside the box (at least one each side). */
const OUTER_MARGIN = 2;

/**
 * The ship, authored as a raw block so the backslashes of the stern read
 * literally. Internal spacing is significant: every line shares the same left
 * origin, and the whole block is centered as a unit (never per-line, which
 * would shear the hull). String.raw keeps `\`, `\\`, `\\\` exactly as typed.
 */
const SHIP = String.raw`
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

export interface BannerInfo {
  name: string;
  modelId: string;
  region: string;
  thinking: boolean;
  /** Terminal width in columns; the frame is gated on this. */
  cols: number;
}

/**
 * Build the boxed pirate-ship banner. The box scales to the terminal width: the
 * ship stays fixed and centered, and the ocean stretches to fill the rest, so a
 * wider terminal just gets a longer ocean. Returns null when the terminal is too
 * narrow to hold the ship at all, so the caller can fall back to plain text.
 */
export function pirateBanner(info: BannerInfo): string | null {
  // Lines that live inside the box, as plain text. We measure them to find the
  // minimum interior the content actually needs; the frame then grows past that
  // to fill the terminal. Color is applied after sizing (visibleWidth ignores
  // SGR, so order wouldn't matter, but plain sizing keeps the math obvious).
  const shipWidth = Math.max(...SHIP.map((l) => l.length));
  const title = "Aye, Captain.";
  const subtitle = "your navigator stands ready at the helm";
  const nameLine = `co-manager  ·  ${info.name}`;
  const metaLine = `${info.modelId}  ·  ${info.region}  ·  thinking ${
    info.thinking ? "on" : "off"
  }`;

  // The smallest interior that fits every element without truncation.
  const minContent = Math.max(
    shipWidth,
    visibleWidth(title),
    visibleWidth(subtitle),
    visibleWidth(nameLine),
    visibleWidth(metaLine),
  );

  // The interior grows to fill the terminal (minus the frame chrome and a small
  // outer margin so we never write into the last column, which auto-wraps on
  // some terminals). The box is then centered in whatever margin is left.
  const available = info.cols - CHROME - OUTER_MARGIN;
  if (available < minContent) return null; // too narrow → plain fallback
  const contentWidth = available;

  // Center the whole box within the terminal by padding each line on the left.
  const boxWidth = contentWidth + CHROME;
  const indent = " ".repeat(Math.max(0, Math.floor((info.cols - boxWidth) / 2)));

  const rows: string[] = [];
  rows.push(pad("", contentWidth)); // top breathing room
  rows.push(center(c.bold(c.yellow(title)), contentWidth));
  rows.push(center(c.dim(subtitle), contentWidth));
  rows.push(pad("", contentWidth));
  const shipRows = centerBlock(SHIP, shipWidth, contentWidth);
  shipRows.forEach((line, i) => {
    // Flag pennant at the masthead flies red (Jolly Roger); the lowest hull row
    // is the crest of the sea, so it takes the water's blue. Everything between
    // — masts, hull, decks — is the warm timber yellow of the galleon.
    if (i === 0) rows.push(c.red(line));
    else if (i === shipRows.length - 1) rows.push(c.blue(line));
    else rows.push(c.yellow(line));
  });
  rows.push(seaRow(contentWidth, shipWidth));
  rows.push(pad("", contentWidth));
  rows.push(center(c.bold(c.magenta(nameLine)), contentWidth));
  rows.push(center(c.dim(metaLine), contentWidth));
  rows.push(pad("", contentWidth));

  return frame(rows, contentWidth, indent);
}

/**
 * Wrap pre-built content rows in a rounded box of the given content width, with
 * `indent` blank columns on the left so the whole box sits centered.
 */
function frame(rows: string[], contentWidth: number, indent: string): string {
  const border = c.dim;
  const top = indent + border("╭" + "─".repeat(contentWidth + 2) + "╮");
  const bottom = indent + border("╰" + "─".repeat(contentWidth + 2) + "╯");
  const bar = border("│");
  const body = rows.map((r) => `${indent}${bar} ${r} ${bar}`);
  return [top, ...body, bottom].join("\n");
}

/** Right-pad `s` to `width` visible columns (content already fits). */
function pad(s: string, width: number): string {
  const gap = width - visibleWidth(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
}

/** Center `s` within `width` visible columns, padding both sides with spaces. */
function center(s: string, width: number): string {
  const gap = Math.max(0, width - visibleWidth(s));
  const left = Math.floor(gap / 2);
  return " ".repeat(left) + s + " ".repeat(gap - left);
}

/**
 * Center a multi-line art block as a unit: every line gets the same left margin
 * (preserving the drawing's internal alignment) and is right-padded to `width`.
 */
function centerBlock(lines: string[], blockWidth: number, width: number): string[] {
  const left = Math.floor(Math.max(0, width - blockWidth) / 2);
  const margin = " ".repeat(left);
  return lines.map((l) => pad(margin + l, width));
}

/**
 * The waterline row, colored. A repeating `~~~^` swell fills the content width
 * (all width-1 chars, so alignment stays exact). On wide terminals, where the
 * water beside the centered ship is roomy enough, a small fish swims in each
 * flank — pointing inward, toward the ship. On narrow terminals the flanks are
 * too tight and it's plain water, so the accent only ever appears when there's
 * space for it and never crowds the ship or the border.
 */
function seaRow(width: number, shipWidth: number): string {
  const swell = seaLine(width);

  // Where the centered ship sits, so we can target the open water on each side.
  const shipLeft = Math.floor(Math.max(0, width - shipWidth) / 2);
  const rightFlankStart = shipLeft + shipWidth;
  const rightFlankWidth = width - rightFlankStart;

  // The fish only appears once a flank has real open water around it, so narrow
  // terminals stay clean and the accent is reserved for wider screens. 18 cols
  // of flank ≈ an 70-col+ terminal; below that it's plain swell on both sides.
  const FISH = "><>"; // left flank: swims right, toward the ship
  const FISH_REV = "<><"; // right flank: swims left, toward the ship
  const MIN_FLANK = 18;

  // Overlay a fish centered in a flank spanning [start, start+flankWidth).
  const fish: Array<{ at: number; glyph: string }> = [];
  if (shipLeft >= MIN_FLANK) {
    fish.push({ at: Math.floor((shipLeft - FISH.length) / 2), glyph: FISH });
  }
  if (rightFlankWidth >= MIN_FLANK) {
    fish.push({
      at: rightFlankStart + Math.floor((rightFlankWidth - FISH_REV.length) / 2),
      glyph: FISH_REV,
    });
  }

  if (fish.length === 0) return c.blue(swell);

  // Stitch the row from alternating water (blue) and fish (cyan) segments. Each
  // fish replaces exactly glyph.length water cells, so total width is unchanged.
  let out = "";
  let cursor = 0;
  for (const f of fish) {
    out += c.blue(swell.slice(cursor, f.at));
    out += c.cyan(f.glyph);
    cursor = f.at + f.glyph.length;
  }
  out += c.blue(swell.slice(cursor));
  return out;
}

/**
 * A stylized waterline that fills the content width. A repeating `~~~^` gives a
 * gentle swell without any wide glyphs, so alignment stays exact.
 */
function seaLine(width: number): string {
  const unit = "~~~^";
  let out = "";
  while (out.length < width) out += unit;
  return out.slice(0, width);
}
