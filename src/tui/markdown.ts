/**
 * Markdown → ANSI rendering for the transcript, in the spirit of Claude Code's
 * terminal output. The model speaks markdown; without this it prints literally
 * ("**bold**"). We turn it into real terminal styling.
 *
 * Why line-based and stateful: inline spans ("**...**") can straddle several
 * stream tokens, and fenced code blocks straddle many lines. So the unit of
 * rendering is one *complete logical line*, and a MarkdownRenderer instance
 * carries the cross-line state — whether we're inside a ``` fence, and whether a
 * table block is currently being collected.
 *
 * Tables are the one construct that cannot be rendered a line at a time: column
 * widths are a function of every row, so the block must be complete before it
 * can be laid out. `feed()` therefore returns *entries* rather than strings — a
 * plain line resolves immediately, while table rows accumulate and resolve as a
 * single `{ kind: "table" }` entry when the block ends. Callers display the
 * still-growing block via `pendingLines()`, which re-lays it out on every paint
 * so a streaming table appears live instead of popping in at the end.
 *
 * Keeping the table entry in *raw* form (rather than pre-rendered strings) is
 * what lets the caller re-lay it out on terminal resize; word-wrapping an
 * already-drawn table would shred its alignment.
 *
 * Three constraints shape the implementation:
 *  - ANSI-aware: the caller may hand us a line that already carries escapes
 *    (the green "co  › " speaker label leads the first line). Those pass through
 *    untouched, and block detection looks past them.
 *  - Wrap-safe: wrap.ts breaks rows at word boundaries and attaches each escape
 *    to the following visible char. If we opened bold once at the start of a
 *    long run, the second wrapped row would lose it. So we style each word as a
 *    self-contained on…off pair; a run that wraps keeps its styling on every row
 *    and never bleeds past its end.
 *  - Lossless: every branch here only ever *adds* escapes or swaps a markup
 *    glyph for a display one. Nothing that can't be rendered is dropped — it
 *    falls through to its own raw text.
 */

import { colorEnabled } from "../ui.js";
import { visibleWidth, wrapLine } from "./wrap.js";

const ESC = "\x1b";
// One SGR escape sequence (colour/style). Matches what ui.ts emits.
const SGR = /\x1b\[[0-9;]*m/;
// A leading "gutter": the speaker label the session prepends, e.g. "co  › ".
// Peeling the WHOLE label (not just its opening escape) lets block markers on
// the first answer line — "# heading", "- item", "| cell |" — still be
// recognised, so the first line of a reply renders like every other line.
//
// Two forms, because the label is only escape-wrapped when colour is on: an
// escape-wrapped run ending in a reset (model text never contains raw escapes,
// so any such prefix is ours), or the bare "name › " label that ui.ts emits
// under NO_COLOR / a pipe. Either may be followed by further bare escapes.
const LEADING_GUTTER =
  /^(?:(?:\x1b\[[0-9;]*m)+[^\n\x1b]*\x1b\[0m|[A-Za-z0-9_.-]{1,16} {1,3}› )?(?:\x1b\[[0-9;]*m)*/;

/** A style is an on-code and the matching off-code, so styles can nest. */
interface Style {
  on: string;
  off: string;
}
const BOLD: Style = { on: "1", off: "22" };
const DIM: Style = { on: "2", off: "22" };
const ITALIC: Style = { on: "3", off: "23" };
const UNDERLINE: Style = { on: "4", off: "24" };
const STRIKE: Style = { on: "9", off: "29" };
const CODE: Style = { on: "36", off: "39" }; // cyan for inline code
const HEADING: Style = { on: "1;36", off: "0" }; // bold cyan; full reset is fine per-word

/** Bullet glyphs by nesting depth, so nested lists read as nested. */
const BULLETS = ["•", "◦", "▪"];

/** Widest a fence rule or blockquote decoration will ever be drawn. */
const MAX_RULE = 60;

/**
 * Apply a style to text one word at a time, leaving the whitespace between words
 * unstyled. Self-contained words are the trick that lets wrap.ts split a styled
 * run across rows without dropping or leaking the style (see file header).
 */
function styleWords(text: string, s: Style): string {
  if (!colorEnabled || text === "") return text;
  // Split keeping the whitespace runs so we can re-emit them verbatim.
  return text
    .split(/(\s+)/)
    .map((seg) => (seg === "" || /^\s+$/.test(seg) ? seg : `${ESC}[${s.on}m${seg}${ESC}[${s.off}m`))
    .join("");
}

function dim(s: string): string {
  return colorEnabled && s !== "" ? `${ESC}[${DIM.on}m${s}${ESC}[${DIM.off}m` : s;
}

/** Split a raw line into its leading styled gutter (if any) and the rest. */
function peel(raw: string): { lead: string; body: string } {
  const lead = LEADING_GUTTER.exec(raw)?.[0] ?? "";
  return { lead, body: raw.slice(lead.length) };
}

/**
 * Render inline markdown (bold/italic/code/strike/links) within one line's text.
 * Walks left to right; at each position it tries the delimiters in precedence
 * order and otherwise passes a single character (or a whole escape sequence)
 * through untouched. Recursion handles the occasional nested span; the on/off
 * style codes compose because each closes only its own attribute.
 */
export function renderInline(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);

    // Pass through any escape sequence already in the text (e.g. the label).
    if (text[i] === ESC) {
      const m = rest.match(SGR);
      if (m && m.index === 0) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }

    // Inline code — highest precedence, no markdown parsed inside.
    let m = /^`([^`]+)`/.exec(rest);
    if (m) {
      out += styleWords(m[1]!, CODE);
      i += m[0].length;
      continue;
    }

    // Bold: ** … ** or __ … __
    m = /^\*\*([\s\S]+?)\*\*/.exec(rest) || /^__([\s\S]+?)__/.exec(rest);
    if (m) {
      out += styleWords(renderInline(m[1]!), BOLD);
      i += m[0].length;
      continue;
    }

    // Strikethrough: ~~ … ~~
    m = /^~~([\s\S]+?)~~/.exec(rest);
    if (m) {
      out += styleWords(renderInline(m[1]!), STRIKE);
      i += m[0].length;
      continue;
    }

    // Italic: * … * or _ … _  (single marker; the ** case is handled above)
    m = /^\*([^*\s][^*]*?)\*/.exec(rest) || /^_([^_\s][^_]*?)_/.exec(rest);
    if (m) {
      out += styleWords(renderInline(m[1]!), ITALIC);
      i += m[0].length;
      continue;
    }

    // Link: [text](url) — underline the text, trail the url dimmed.
    m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (m) {
      out += styleWords(renderInline(m[1]!), UNDERLINE);
      out += styleWords(` (${m[2]})`, DIM);
      i += m[0].length;
      continue;
    }

    out += text[i];
    i += 1;
  }
  return out;
}

// --- code fences -------------------------------------------------------------

/**
 * A language family for the code highlighter. Deliberately coarse: the point is
 * to make code scannable, not to be a compiler front end.
 */
interface Lexicon {
  lineComment: string[];
  blockComment: boolean; // supports slash-star
  keywords: Set<string>;
}

const kw = (s: string): Set<string> => new Set(s.split(/\s+/).filter(Boolean));

const JS = kw(`const let var function return if else for while do break continue class extends
  new this super import export from as default async await yield try catch finally throw typeof
  instanceof in of delete void null undefined true false interface type enum implements public
  private protected readonly static get set switch case abstract declare namespace satisfies keyof`);
const PY = kw(`def class return if elif else for while break continue import from as pass raise
  try except finally with lambda yield global nonlocal assert del not and or in is None True False
  async await match case self`);
const GO = kw(`func package import return if else for range break continue switch case default
  type struct interface map chan go defer var const nil true false select fallthrough`);
const RUST = kw(`fn let mut const struct enum impl trait use pub mod match if else for while loop
  break continue return self Self where as in ref move true false async await dyn crate super
  unsafe static type`);
const CLIKE = kw(`int char float double void long short unsigned signed struct class union enum
  public private protected static final return if else for while do break continue switch case
  default new delete this null true false namespace using template typename const virtual override
  try catch throw sizeof typedef extern inline bool`);
const SH = kw(`if then else elif fi for while until do done case esac function return export local
  readonly source echo cd exit set unset shift trap eval`);
const SQL = kw(`select from where group by order having join left right inner outer full on as
  insert into values update set delete create table drop alter index primary key foreign references
  null not and or in like limit offset distinct union all case when then else end`);

const LEXICONS: Record<string, Lexicon> = {
  js: { lineComment: ["//"], blockComment: true, keywords: JS },
  ts: { lineComment: ["//"], blockComment: true, keywords: JS },
  py: { lineComment: ["#"], blockComment: false, keywords: PY },
  go: { lineComment: ["//"], blockComment: true, keywords: GO },
  rust: { lineComment: ["//"], blockComment: true, keywords: RUST },
  clike: { lineComment: ["//"], blockComment: true, keywords: CLIKE },
  sh: { lineComment: ["#"], blockComment: false, keywords: SH },
  sql: { lineComment: ["--"], blockComment: true, keywords: SQL },
  json: { lineComment: [], blockComment: false, keywords: kw("true false null") },
  yaml: { lineComment: ["#"], blockComment: false, keywords: kw("true false null yes no on off") },
};

/** Fence info string → lexicon, or null when we don't know the language. */
function lexiconFor(lang: string): Lexicon | null {
  switch (lang) {
    case "js": case "jsx": case "javascript": case "mjs": case "cjs": case "node":
      return LEXICONS.js!;
    case "ts": case "tsx": case "typescript":
      return LEXICONS.ts!;
    case "py": case "python": case "python3":
      return LEXICONS.py!;
    case "go": case "golang":
      return LEXICONS.go!;
    case "rs": case "rust":
      return LEXICONS.rust!;
    case "c": case "h": case "cpp": case "c++": case "cc": case "hpp":
    case "java": case "cs": case "csharp": case "swift": case "kotlin": case "kt":
      return LEXICONS.clike!;
    case "sh": case "bash": case "zsh": case "shell": case "console": case "fish":
      return LEXICONS.sh!;
    case "sql": case "postgres": case "postgresql": case "mysql":
      return LEXICONS.sql!;
    case "json": case "jsonc": case "json5":
      return LEXICONS.json!;
    case "yaml": case "yml":
      return LEXICONS.yaml!;
    default:
      return null;
  }
}

const HL_COMMENT: Style = { on: "2", off: "22" };
const HL_STRING: Style = { on: "32", off: "39" };
const HL_NUMBER: Style = { on: "33", off: "39" };
const HL_KEYWORD: Style = { on: "35", off: "39" };

function paint(text: string, s: Style): string {
  if (!colorEnabled || text === "") return text;
  return `${ESC}[${s.on}m${text}${ESC}[${s.off}m`;
}

/**
 * Highlight one line of code. Unknown languages fall back to dim, which is what
 * this renderer did for every fence before.
 *
 * The scanner is written so that the concatenation of every emitted segment's
 * *source* text is exactly the input — each branch consumes a span and emits
 * that same span, styled. That invariant is what makes highlighting safe under
 * the "never mangle content" rule, and it is asserted directly in the tests.
 *
 * State is per-line, so a block comment or triple-quoted string spanning lines
 * only highlights its first line. Under-highlighting is the acceptable failure.
 */
export function highlightCode(src: string, lang: string): string {
  const lex = lexiconFor(lang);
  if (!lex) return dim(src);
  if (!colorEnabled) return src;

  let out = "";
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);

    // Line comment — swallows the remainder of the line.
    const lc = lex.lineComment.find((p) => rest.startsWith(p));
    if (lc) {
      out += paint(rest, HL_COMMENT);
      break;
    }

    // Block comment — to its terminator, or to end of line if unterminated.
    if (lex.blockComment && rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2);
      const span = end === -1 ? rest : rest.slice(0, end + 2);
      out += paint(span, HL_COMMENT);
      i += span.length;
      continue;
    }

    // String — to the matching unescaped quote, or to end of line if unterminated.
    const ch = src[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === ch) { j += 1; break; }
        j += 1;
      }
      const span = src.slice(i, Math.min(j, src.length));
      out += paint(span, HL_STRING);
      i += span.length;
      continue;
    }

    // Number.
    let m = /^\d[\w.]*/.exec(rest);
    if (m) {
      out += paint(m[0], HL_NUMBER);
      i += m[0].length;
      continue;
    }

    // Identifier — keyword or not.
    m = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (m) {
      out += lex.keywords.has(m[0]) ? paint(m[0], HL_KEYWORD) : m[0];
      i += m[0].length;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

// --- tables ------------------------------------------------------------------

export type Align = "left" | "right" | "center";

/**
 * A table held in raw markdown form. Kept un-rendered so it can be laid out
 * again at a different width when the terminal resizes.
 */
export interface TableBlock {
  /** Styled speaker gutter that led the header line, if any. */
  lead: string;
  header: string;
  align: Align[];
  rows: string[];
}

/** Minimum content columns we'll squeeze a table column down to before giving up. */
const MIN_COL = 4;

/**
 * Split a table row on unescaped pipes. A leading or trailing pipe produces an
 * empty edge cell, which is delimiter syntax rather than content, so it's
 * dropped — but only when the line actually had that edge pipe, so a genuinely
 * empty first or last cell survives.
 */
function splitRow(line: string): string[] {
  const s = line.trim();
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  if (s.startsWith("|") && cells.length && cells[0]!.trim() === "") cells.shift();
  if (s.endsWith("|") && cells.length && cells[cells.length - 1]!.trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

/** The "|---|:--:|" line under a table header. */
function isDelimiterRow(trimmed: string): boolean {
  if (!trimmed.includes("-")) return false;
  const cells = splitRow(trimmed);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function parseAlign(trimmed: string): Align[] {
  return splitRow(trimmed).map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    return l && r ? "center" : r ? "right" : "left";
  });
}

/**
 * Could this line be a table row? Any line carrying an unescaped pipe qualifies,
 * except ones that already announce themselves as another block — a list item or
 * heading containing a pipe is a list item, not a table.
 */
function isRowCandidate(trimmed: string): boolean {
  if (trimmed === "") return false;
  if (/^(#{1,6}\s|>|```|~~~)/.test(trimmed)) return false;
  if (/^([-*+]|\d{1,9}[.)])\s/.test(trimmed)) return false;
  return /(^|[^\\])\|/.test(trimmed);
}

function padCell(s: string, w: number, a: Align): string {
  const space = Math.max(0, w - visibleWidth(s));
  if (space === 0) return s;
  if (a === "right") return " ".repeat(space) + s;
  if (a === "center") {
    const l = Math.floor(space / 2);
    return " ".repeat(l) + s + " ".repeat(space - l);
  }
  return s + " ".repeat(space);
}

/**
 * Lay a table out as box-drawn rows that fit `width` visible columns.
 *
 * Sizing: every column starts at its natural width (the widest rendered cell),
 * then the widest column is shaved one column at a time until the whole table
 * fits. Cells whose content no longer fits their column are word-wrapped into
 * multiple physical lines, so a wide table gets narrower and taller rather than
 * overflowing. If even MIN_COL per column won't fit — a table with more columns
 * than the terminal can hold — we fall back to per-record stanzas, which is
 * ugly but keeps every cell readable and loses nothing.
 */
export function renderTable(t: TableBlock, width: number): string[] {
  const headCells = splitRow(t.header);
  const bodyCells = t.rows.map(splitRow);
  const cols = Math.max(1, headCells.length, t.align.length, ...bodyCells.map((r) => r.length));

  const fit = (cells: string[]): string[] => {
    const out: string[] = [];
    for (let i = 0; i < cols; i++) out.push(cells[i] ?? "");
    return out;
  };
  const align: Align[] = [];
  for (let i = 0; i < cols; i++) align.push(t.align[i] ?? "left");

  const head = fit(headCells).map((c) => styleWords(renderInline(c), BOLD));
  const body = bodyCells.map((r) => fit(r).map((c) => renderInline(c)));

  // Natural widths, measured on the *rendered* text so markup that disappears
  // ("**x**" → "x") doesn't inflate the column.
  const w: number[] = [];
  for (let i = 0; i < cols; i++) {
    let n = visibleWidth(head[i]!);
    for (const r of body) n = Math.max(n, visibleWidth(r[i]!));
    w.push(Math.max(1, n));
  }

  // Chrome is a leading "│", then " │" per column plus the cell's own trailing
  // space: 3 columns of decoration per column, plus the closing edge.
  const leadW = visibleWidth(t.lead);
  const budget = width - (3 * cols + 1) - leadW;
  let total = w.reduce((a, b) => a + b, 0);
  while (total > budget) {
    let idx = -1;
    let best = MIN_COL;
    for (let i = 0; i < cols; i++) {
      if (w[i]! > best) {
        best = w[i]!;
        idx = i;
      }
    }
    if (idx === -1) break; // everything is at the floor already
    w[idx] = w[idx]! - 1;
    total -= 1;
  }
  if (total > budget) return renderStanzas(t, width);

  const out: string[] = [];
  const border = (l: string, mid: string, r: string): string =>
    dim(l + w.map((x) => "─".repeat(x + 2)).join(mid) + r);

  /** A row as per-column lines: one entry per column, each already wrapped. */
  const layout = (cells: string[]): string[][] =>
    cells.map((c, i) => (c === "" ? [""] : wrapLine(c, w[i]!)));

  const emit = (parts: string[][]): void => {
    const height = Math.max(...parts.map((p) => p.length));
    for (let k = 0; k < height; k++) {
      const segs = parts.map((p, i) => " " + padCell(p[k] ?? "", w[i]!, align[i]!) + " ");
      out.push(dim("│") + segs.join(dim("│")) + dim("│"));
    }
  };

  const bodyParts = body.map(layout);
  // Once any cell wraps, adjacent records blur into each other without a rule
  // between them. Single-line rows don't have that problem, so they stay dense.
  const wrapped = bodyParts.some((p) => p.some((col) => col.length > 1));

  out.push(border("┌", "┬", "┐"));
  emit(layout(head));
  out.push(border("├", "┼", "┤"));
  bodyParts.forEach((p, i) => {
    if (wrapped && i > 0) out.push(border("├", "┼", "┤"));
    emit(p);
  });
  out.push(border("└", "┴", "┘"));

  // The gutter label only exists on the first line; the rest of the table is
  // indented to match so the box stays rectangular.
  const pad = " ".repeat(leadW);
  return out.map((l, i) => (i === 0 ? t.lead + l : pad + l));
}

/**
 * Last-resort table layout for when the terminal is too narrow for even minimal
 * columns: one "Header: value" stanza per record. Never as scannable as a real
 * table, but every cell survives and stays labelled.
 */
function renderStanzas(t: TableBlock, width: number): string[] {
  const heads = splitRow(t.header);
  const leadW = visibleWidth(t.lead);
  const indent = "  ";
  const inner = Math.max(8, width - indent.length - leadW);
  const out: string[] = [];

  for (const raw of t.rows) {
    const cells = splitRow(raw);
    const n = Math.max(heads.length, cells.length);
    for (let i = 0; i < n; i++) {
      const label = styleWords(renderInline(heads[i] ?? `col ${i + 1}`), BOLD);
      const text = `${label}: ${renderInline(cells[i] ?? "")}`;
      for (const row of wrapLine(text, inner)) out.push(indent + row);
    }
    out.push("");
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  if (out.length === 0) {
    // Header with no data rows: still show the headers rather than nothing.
    for (const h of heads) out.push(indent + styleWords(renderInline(h), BOLD));
  }

  const pad = " ".repeat(leadW);
  return out.map((l, i) => (i === 0 ? t.lead + l : pad + l));
}

// --- the renderer ------------------------------------------------------------

/**
 * One resolved unit of transcript. Plain lines are already rendered to ANSI;
 * tables stay raw so the caller can re-lay them out on resize.
 */
export type Rendered = { kind: "line"; text: string } | { kind: "table"; table: TableBlock };

/** The multi-line construct currently being collected, if any. */
type OpenBlock =
  // A line with a pipe in it that *might* turn out to be a table header — we
  // can't know until the next line either is or isn't a delimiter row.
  | { kind: "maybe"; lead: string; header: string }
  | { kind: "table"; table: TableBlock };

export class MarkdownRenderer {
  private inFence = false;
  private fenceLang = "";
  private block: OpenBlock | null = null;

  /** True while inside a fenced code block (caller may want to suppress ghosts). */
  get insideFence(): boolean {
    return this.inFence;
  }

  /** Reset cross-line state. Call when a fresh assistant turn begins. */
  reset(): void {
    this.inFence = false;
    this.fenceLang = "";
    this.block = null;
  }

  /**
   * Feed one complete logical line and get back whatever is now final.
   *
   * Usually that's the line itself. A line that opens or continues a table is
   * absorbed and yields nothing; the block resolves to a single table entry as
   * soon as a line arrives that isn't part of it. One line of lookahead is the
   * whole cost — a pipe-bearing line is held until we see whether a delimiter
   * row follows — and `pendingLines()` keeps held lines on screen meanwhile.
   */
  feed(raw: string, width: number): Rendered[] {
    const { lead, body } = peel(raw);
    const trimmed = body.trimStart();

    // Code fences win over everything: a pipe inside a code block is code.
    if (this.inFence || /^(```|~~~)/.test(trimmed)) {
      const before = this.flushBlock(width);
      return [...before, { kind: "line", text: this.line(raw, width) }];
    }

    if (this.block === null) {
      if (isRowCandidate(trimmed)) {
        this.block = { kind: "maybe", lead, header: body };
        return [];
      }
      return [{ kind: "line", text: this.line(raw, width) }];
    }

    if (this.block.kind === "maybe") {
      if (isDelimiterRow(trimmed)) {
        this.block = {
          kind: "table",
          table: { lead: this.block.lead, header: this.block.header, align: parseAlign(trimmed), rows: [] },
        };
        return [];
      }
      // Not a table after all — emit the held line, then handle this one.
      const held = this.block;
      this.block = null;
      return [
        { kind: "line", text: this.line(held.lead + held.header, width) },
        ...this.feed(raw, width),
      ];
    }

    if (isRowCandidate(trimmed)) {
      // A stray second delimiter row is markup, not data: absorb and drop it.
      if (!isDelimiterRow(trimmed)) this.block.table.rows.push(body);
      return [];
    }

    const done = this.flushBlock(width);
    return [...done, ...this.feed(raw, width)];
  }

  /** Whether a multi-line block is mid-collection. */
  hasOpenBlock(): boolean {
    return this.block !== null;
  }

  /**
   * Close any open block and return it. A "maybe" that never became a table
   * degrades to the plain line it always was — nothing is lost either way.
   */
  flushBlock(width = 80): Rendered[] {
    const b = this.block;
    if (!b) return [];
    this.block = null;
    if (b.kind === "maybe") return [{ kind: "line", text: this.line(b.lead + b.header, width) }];
    return [{ kind: "table", table: b.table }];
  }

  /**
   * Provisional display for the block still being collected, so a streaming
   * table grows on screen instead of appearing all at once when it completes.
   *
   * `open` is the caller's still-unterminated line. When it looks like another
   * table row it's folded in as a provisional row and reported as `absorbed`,
   * so the caller doesn't also draw it raw underneath the box.
   */
  pendingLines(width: number, open: string | null): { rows: string[]; absorbed: boolean } {
    const b = this.block;
    if (!b) return { rows: [], absorbed: false };

    if (b.kind === "maybe") {
      return { rows: wrapLine(this.peek(b.lead + b.header, width), width), absorbed: false };
    }

    const openBody = open === null ? "" : peel(open).body;
    const openTrim = openBody.trim();
    const absorbed = isRowCandidate(openTrim) && !isDelimiterRow(openTrim);
    const table = absorbed ? { ...b.table, rows: [...b.table.rows, openBody] } : b.table;
    return { rows: renderTable(table, width), absorbed };
  }

  /**
   * Render a line for display WITHOUT committing its fence toggle. Used to paint
   * the still-streaming open line live: it may be a partial line, so we must not
   * let a half-typed ``` flip state that the real commit will flip again.
   */
  peek(raw: string, width = 80): string {
    const savedFence = this.inFence;
    const savedLang = this.fenceLang;
    const out = this.line(raw, width);
    this.inFence = savedFence;
    this.fenceLang = savedLang;
    return out;
  }

  /**
   * Render one complete logical line of markdown to a styled line. Leading
   * escape sequences (the speaker label) are preserved and skipped for the
   * purpose of block detection. Tables are not handled here — they need the
   * whole block, so they go through feed().
   */
  line(raw: string, width = 80): string {
    const { lead, body } = peel(raw);
    const trimmed = body.trimStart();
    const indent = body.slice(0, body.length - trimmed.length);
    const ruleWidth = Math.max(3, Math.min(MAX_RULE, width - visibleWidth(lead) - indent.length));

    // Fenced code blocks. The ``` markers are markup, not content, so they're
    // replaced by a dim rule (carrying the language, when the fence declares
    // one) rather than printed literally.
    const fence = /^(```|~~~)\s*([^\s`~]*)/.exec(trimmed);
    if (fence) {
      if (this.inFence) {
        this.inFence = false;
        this.fenceLang = "";
        return lead + dim(indent + "─".repeat(ruleWidth));
      }
      this.inFence = true;
      this.fenceLang = (fence[2] ?? "").toLowerCase();
      const label = this.fenceLang ? `── ${this.fenceLang} ` : "";
      const tail = Math.max(3, ruleWidth - visibleWidth(label));
      return lead + dim(indent + label + "─".repeat(tail));
    }
    if (this.inFence) {
      return lead + highlightCode(body, this.fenceLang);
    }

    // Horizontal rule.
    if (/^([-*_])\1{2,}\s*$/.test(trimmed)) {
      return lead + dim(indent + "─".repeat(Math.max(3, Math.min(24, ruleWidth))));
    }

    // ATX heading: #, ##, … → bold cyan, markers stripped.
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) {
      return lead + indent + styleWords(renderInline(h[2]!), HEADING);
    }

    // Blockquote: "> quote" → dim, gutter bar.
    const q = /^>\s?(.*)$/.exec(trimmed);
    if (q) {
      return lead + indent + dim("│ ") + styleWords(renderInline(q[1]!), DIM);
    }

    // Unordered list: -, *, + → bullet, content rendered inline. The bullet
    // glyph varies with indent depth so nested lists read as nested.
    const ul = /^([-*+])\s+(.*)$/.exec(trimmed);
    if (ul) {
      const depth = Math.min(BULLETS.length - 1, Math.floor(indent.length / 2));
      return lead + indent + BULLETS[depth]! + " " + renderListItem(ul[2]!);
    }

    // Ordered list: "1." → keep the number, content rendered inline.
    const ol = /^(\d{1,9})([.)])\s+(.*)$/.exec(trimmed);
    if (ol) {
      return lead + indent + `${ol[1]}. ` + renderListItem(ol[3]!);
    }

    // Plain paragraph line.
    return lead + indent + renderInline(trimmed);
  }
}

/** List item content, with a GFM task-list checkbox swapped for a real glyph. */
function renderListItem(content: string): string {
  const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
  if (task) {
    const done = task[1] !== " ";
    return (done ? "☑" : "☐") + " " + renderInline(task[2]!);
  }
  return renderInline(content);
}
