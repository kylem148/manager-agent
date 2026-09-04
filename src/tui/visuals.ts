/**
 * The nautical terminal visuals: the dispatch flourish (waves rolling under the
 * destination branch as an order fires) and the exit ship (a small hull sailing
 * the width once while memory saves).
 *
 * This module is pure presentation and pure functions. It decides WHAT gets
 * drawn — frame content, glyph set, the one colour accent, and the static line
 * that stands in when nothing may move; tui.ts decides WHEN, owning the bounded
 * region and its timer (see AnimationSpec there). Nothing here touches model
 * I/O, memory, or the dispatch interlock: an animation is scenery over work that
 * was going to happen anyway, and removing it must never change an outcome.
 *
 * Three rules shape everything below:
 *
 *  1. MOTION IS FOR IDLE WAITS ONLY. Both animations play over a wait the
 *     captain already had (the crew launch; the save-on-exit distill). Neither
 *     may run while model tokens stream — enforced structurally in tui.ts.
 *  2. IT DEGRADES TO A LINE. Every animation has a static one-line form carrying
 *     the same information (dispatchLabel / savingLabel), and resolveVisuals
 *     drops to it under anything that says the terminal can't or shouldn't do
 *     this: CO_VISUALS, NO_COLOR, a non-TTY, the PlainIO fallback, TERM=dumb, a
 *     narrow screen, or a reduced-motion signal. The information is never in the
 *     animation alone.
 *  3. NO EMOJI, NO WIDE GLYPHS. Every character is width-1 ASCII or a width-1
 *     box-drawing/math glyph with a plain-ASCII twin, because the column math in
 *     wrap.ts counts characters — a two-column emoji would shear every row. The
 *     colour accent (one: cyan, the water) is always carried by a glyph or by
 *     text, never by colour alone.
 */

import { c } from "../ui.js";
import { visualsLevel, type VisualsLevel } from "../config.js";
import type { AnimationSpec } from "./tui.js";

/** Which alphabet the art is drawn from. `ascii` is the universal fallback. */
export type GlyphKind = "unicode" | "ascii";

/**
 * Below this width the flourish can't show a wave band AND a branch label
 * without truncating the branch — which is the one thing the flourish exists to
 * show — so a narrower terminal gets the static line instead. tui.ts keeps its
 * own floor of the same size for its own layout safety; either one refusing is
 * enough, and they are deliberately independent checks.
 */
export const VISUALS_MIN_COLS = 40;

/** Two spaces, matching the `  · ` system notes the session already prints, so a
 *  dispatch label lines up with the dispatch report under it. */
const INDENT = "  ";

/** Every glyph the art uses, in both alphabets. Each is exactly one column. */
interface GlyphSet {
  /** Wave crest — the bulk of the water. */
  wave: string;
  /** Wave trough, for a bit of texture in the swell. */
  trough: string;
  /** The order under way / the ship's pennant. */
  arrow: string;
  /** "to", in the destination label. The only multi-column glyph (ASCII "->"),
   *  and it never appears inside a width-critical band. */
  to: string;
  mast: string;
  ellipsis: string;
}

const GLYPHS: Record<GlyphKind, GlyphSet> = {
  unicode: { wave: "≈", trough: "~", arrow: "▸", to: "→", mast: "│", ellipsis: "…" },
  ascii: { wave: "~", trough: "-", arrow: ">", to: "->", mast: "|", ellipsis: "..." },
};

// --- the degradation predicate ----------------------------------------------

/** Everything the effective visuals level is decided from. Passed explicitly so
 *  the predicate is a pure function of its inputs and testable per condition. */
export interface VisualsEnv {
  /** The configured level (CO_VISUALS). The environment can only lower it. */
  level: VisualsLevel;
  isTTY: boolean;
  noColor: boolean;
  term: string | undefined;
  /** True when the session fell back to the plain line-oriented IO. */
  plainIO: boolean;
  columns: number;
  reducedMotion: boolean;
}

export interface EffectiveVisuals {
  /** The level actually in force after degradation. */
  level: VisualsLevel;
  /** Whether anything may move. Only ever true at `full`. */
  animate: boolean;
  glyphs: GlyphKind;
  /** Whether the one accent colour may be used. */
  color: boolean;
  /** Why the configured level was lowered, for diagnostics; null if it wasn't
   *  (including when the captain simply asked for a lower level). */
  degradedBy: string | null;
}

/** Env vars that mean "don't animate". There is no standard for this in a
 *  terminal the way `prefers-reduced-motion` is standard on the web, so we honor
 *  the spellings people actually use, plus our own namespaced one. */
const REDUCED_MOTION_KEYS = [
  "CO_REDUCED_MOTION",
  "REDUCED_MOTION",
  "PREFERS_REDUCED_MOTION",
  "NO_MOTION",
] as const;

/** Values that mean "not set" for a boolean-ish env var. */
const FALSEY = new Set(["", "0", "false", "off", "no"]);

/** Whether any reduced-motion signal is present in the environment. */
export function reducedMotionFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return REDUCED_MOTION_KEYS.some((k) => {
    const v = env[k];
    return v !== undefined && !FALSEY.has(v.trim().toLowerCase());
  });
}

/**
 * The first reason this environment can't have the full treatment, or null.
 * Ordered most-fundamental first, so the reported reason is the one a person
 * would name: "it's a pipe" beats "it's narrow" when both are true.
 */
function degradation(env: VisualsEnv): string | null {
  if (env.plainIO) return "the plain (non-TTY) session fallback is in use";
  if (!env.isTTY) return "output is not a TTY";
  if (env.term === "dumb") return "TERM=dumb";
  if (env.noColor) return "NO_COLOR is set";
  if (env.reducedMotion) return "a reduced-motion signal is set";
  if (env.columns < VISUALS_MIN_COLS) {
    return `the terminal is only ${env.columns} columns (needs ${VISUALS_MIN_COLS})`;
  }
  return null;
}

/**
 * Resolve what may actually be drawn. The contract is a one-way ratchet: the
 * configured level is a ceiling and the environment can only lower it, so no
 * combination of settings can produce motion on a terminal that shouldn't have
 * it.
 *
 *   full     animation, box-drawing glyphs, the cyan accent
 *   minimal  no motion; the same glyphs and accent on a static line
 *   off      no motion, plain ASCII, no colour — a single static line
 *
 * Any degradation condition collapses straight to `off`, which is what makes the
 * fallback one thing to reason about rather than a matrix: whatever is wrong
 * with the terminal, what it gets is the plain ASCII line.
 */
export function resolveVisuals(env: VisualsEnv): EffectiveVisuals {
  const degradedBy = degradation(env);
  if (degradedBy !== null || env.level === "off") {
    return { level: "off", animate: false, glyphs: "ascii", color: false, degradedBy };
  }
  if (env.level === "minimal") {
    return { level: "minimal", animate: false, glyphs: "unicode", color: true, degradedBy: null };
  }
  return { level: "full", animate: true, glyphs: "unicode", color: true, degradedBy: null };
}

/**
 * resolveVisuals against the live process. `overrides` carries what the process
 * can't tell us — chiefly `plainIO`, which the session knows and stdout does
 * not. Read at the point of use rather than cached: the width is live, so a
 * terminal narrowed mid-session degrades on the next dispatch.
 */
export function currentVisuals(overrides: Partial<VisualsEnv> = {}): EffectiveVisuals {
  return resolveVisuals({
    level: visualsLevel(),
    isTTY: Boolean(process.stdout.isTTY),
    noColor: Boolean(process.env.NO_COLOR),
    term: process.env.TERM,
    plainIO: false,
    columns: process.stdout.columns || 80,
    reducedMotion: reducedMotionFromEnv(),
    ...overrides,
  });
}

// --- shared drawing primitives ----------------------------------------------

/** The repeating swell, built from the alphabet's crest/trough pair. */
function waveUnit(g: GlyphSet): string {
  return `${g.wave}${g.wave}${g.trough}${g.wave}${g.wave}${g.trough}${g.trough}${g.wave}`;
}

/**
 * `width` columns of water, phase-shifted by `frame`. Shifting by one column per
 * frame moves the swell to the RIGHT — toward the destination on the dispatch
 * band, and with the ship on the exit voyage. Always returns exactly `width`
 * characters (every glyph is one column), which is what keeps the region's rows
 * from wrapping.
 */
export function waveBand(width: number, frame: number, kind: GlyphKind): string {
  if (width <= 0) return "";
  const unit = waveUnit(GLYPHS[kind]);
  const n = unit.length;
  // Negative offset walks the window backwards through the pattern, which reads
  // as the pattern moving forwards. Normalised so a negative frame is harmless.
  const off = ((-frame % n) + n) % n;
  let out = "";
  while (out.length < width + n) out += unit;
  return out.slice(off, off + width);
}

/**
 * Stamp `sprite` onto `base` at column `x`, clipped to the base's width. A space
 * in the sprite is transparent (it never erases what's under it) so a drawing
 * can have a ragged silhouette without punching holes in the water.
 */
function overlay(base: string, sprite: string, x: number): string {
  const cells = [...base];
  for (let i = 0; i < sprite.length; i++) {
    const ch = sprite[i]!;
    const col = x + i;
    if (ch === " " || col < 0 || col >= cells.length) continue;
    cells[col] = ch;
  }
  return cells.join("");
}

/** The accent, applied only when colour is allowed and there's something to
 *  paint (`c.cyan("")` would emit a bare escape pair for nothing). */
function tint(s: string, color: boolean): string {
  return color && s !== "" ? c.cyan(s) : s;
}

// --- the dispatch flourish ---------------------------------------------------

/** Where a confirmed dispatch is headed. A feature dispatch names the branch its
 *  crew will work on; everything else runs in the repo's own checkout. */
export type DispatchTarget = { kind: "feature"; branch: string } | { kind: "main" };

/** How much of an EffectiveVisuals the label builders need. */
type Styling = Pick<EffectiveVisuals, "glyphs" | "color">;

/**
 * The one-line destination label: `≈≈▸ dispatching → feat/slug`, or
 * `~~> dispatching -> feat/slug` in ASCII. This is the durable form — the
 * session commits it to the transcript at EVERY visuals level, including `full`,
 * so the animation only ever adds motion to information that is already there
 * (and still there after the region clears).
 *
 * A dispatch with no feature says so in words rather than naming a branch,
 * because "the bare main tree" is exactly the case where a branch name would be
 * a lie. It also stays unbolded: the emphasis is reserved for the branch, so a
 * feature dispatch and a main-tree dispatch never look alike at a glance.
 */
export function dispatchLabel(target: DispatchTarget, v: Styling): string {
  const g = GLYPHS[v.glyphs];
  const lead = `${g.wave}${g.wave}${g.arrow}`;
  const dest =
    target.kind === "feature"
      ? v.color
        ? c.bold(target.branch)
        : target.branch
      : "the bare main tree (no feature branch)";
  return `${INDENT}${tint(lead, v.color)} dispatching ${tint(g.to, v.color)} ${dest}`;
}

/** Columns the order advances per frame as it runs out. Faster than the swell
 *  it leaves behind, so the two read as separate motions. */
const ORDER_STEP = 3;

/**
 * The dispatch flourish: two rows above the input bar — the order running out to
 * sea with its wake behind it, over the destination label.
 *
 * The water is a WAKE, not a full-width band: it exists only behind the order,
 * so the row is mostly empty and the eye goes to the label under it. A band
 * spanning the terminal was the first cut and it drowned the thing it was meant
 * to frame.
 *
 * Open-ended by design (no frame count): it plays for exactly as long as the
 * launch takes, which is the idle wait it exists to fill, with a floor
 * (minDurationMs) so an instant launch still reads as a departure rather than a
 * flicker. The caller settles it the moment the crew is away.
 */
export function dispatchFlourish(opts: { target: DispatchTarget } & Styling): AnimationSpec {
  const { glyphs, color } = opts;
  const g = GLYPHS[glyphs];
  const label = dispatchLabel(opts.target, opts);
  return {
    rows: 2,
    intervalMs: 90,
    minDurationMs: 900,
    render: (frame, cols) => {
      // Leave the final column untouched: writing it auto-wraps on some
      // terminals, which would push the whole frame down a row.
      const width = Math.max(0, cols - INDENT.length - 1);
      if (width === 0) return ["", label];
      // Where the order has got to. It wraps rather than parking at the edge:
      // the launch takes as long as it takes, and a second departure reads
      // better than a stalled arrow.
      const x = (frame * ORDER_STEP) % width;
      const wake = waveBand(x, frame, glyphs);
      return [INDENT + tint(wake, color) + (color ? c.bold(g.arrow) : g.arrow), label];
    },
  };
}

// --- the exit ship -----------------------------------------------------------

/** Columns the ship occupies. Every sprite row is exactly this wide. */
const SHIP_WIDTH = 5;

/** Columns the ship advances per frame. At ~11fps that's a shade over two
 *  seconds to cross an 80-column terminal: a voyage, not a twitch. */
const SHIP_STEP = 2;

/**
 * The ship, three rows tall and five columns wide, drawn on the same left origin
 * so the mast stays over the hull. Spaces are transparent (see overlay), so the
 * silhouette sits in open water without a box around it.
 *
 *     |>
 *    /|\
 *    \___/
 */
function shipSprite(g: GlyphSet): [string, string, string] {
  return [`  ${g.mast}${g.arrow} `, ` /${g.mast}\\ `, `\\___/`];
}

/**
 * How many frames a voyage takes at `cols` wide: from just off the left edge to
 * fully past the right one. The Tui uses this to end the animation by itself, so
 * a ship that finishes before the save does simply sails off and clears.
 */
export function voyageFrames(cols: number): number {
  // +1 so the last frame drawn is clean water with the ship already past the
  // edge, rather than the region blinking out with a half-hull still showing.
  return Math.ceil((Math.max(0, cols) + SHIP_WIDTH) / SHIP_STEP) + 1;
}

/**
 * The exit ship: three rows — mast, sail, and the sea with the hull cut into it —
 * sailing left to right once while memory saves.
 *
 * It is bounded (voyageFrames) rather than looping, so the worst case is a ship
 * that finishes early and leaves clean water, never one that keeps the region
 * open. It is also resize-safe in both directions: the sea is re-laid at the
 * current width every frame, and a ship that a shrink has left past the right
 * edge simply isn't drawn (overlay clips it) instead of overflowing the row. The
 * caller stops it the instant the save returns — the voyage is scenery over that
 * wait, and it never becomes the reason the session is still open.
 */
export function exitVoyage(opts: { cols: number } & Styling): AnimationSpec {
  const { glyphs, color } = opts;
  const sprite = shipSprite(GLYPHS[glyphs]);
  return {
    rows: 3,
    intervalMs: 90,
    frames: voyageFrames(opts.cols),
    render: (frame, cols) => {
      const width = Math.max(0, cols - 1); // keep off the auto-wrapping last column
      const x = -SHIP_WIDTH + frame * SHIP_STEP;
      const sea = waveBand(width, frame, glyphs);
      // The hull displaces water; the sea on either side of it carries the one
      // accent, so the ship reads as an object in it rather than part of it.
      const start = Math.max(0, x);
      const end = Math.min(width, x + SHIP_WIDTH);
      const seaRow =
        end <= start
          ? tint(sea, color) // the ship is off-screen: open water
          : tint(sea.slice(0, start), color) +
            sprite[2].slice(start - x, end - x) +
            tint(sea.slice(end), color);
      const blank = " ".repeat(width);
      return [
        overlay(blank, sprite[0], x).replace(/\s+$/, ""),
        overlay(blank, sprite[1], x).replace(/\s+$/, ""),
        seaRow,
      ];
    },
  };
}

/**
 * The static line shown while the session saves on the way out: `≈≈ saving… fair
 * winds`. Like dispatchLabel this is committed at every level, so the captain
 * always knows why the prompt hasn't come back yet, animation or no animation.
 */
export function savingLabel(v: Styling): string {
  const g = GLYPHS[v.glyphs];
  return `${INDENT}${tint(`${g.wave}${g.wave}`, v.color)} saving${g.ellipsis} fair winds`;
}
