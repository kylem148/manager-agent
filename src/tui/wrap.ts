/**
 * Word wrapping for the terminal UI.
 *
 * The bug this fixes: letting the terminal hard-wrap long lines splits words at
 * the raw column edge ("architec\nture"). We instead break at word boundaries,
 * measuring the *visible* width so embedded ANSI SGR codes (colors) don't count
 * toward the column budget and are never split. A single word wider than the
 * line is hard-split by visible column as a last resort so nothing overflows.
 */

// Matches ANSI escape sequences (CSI ... final byte). Enough to skip the SGR
// color/style codes we emit; we never place cursor-movement codes inside text.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Visible column width of a string, ignoring ANSI escape sequences. */
export function visibleWidth(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

/** Strip ANSI escape sequences from a string. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * A "cell" is one visible character plus any ANSI escapes that immediately
 * precede it (zero visible width). Splitting a string into cells lets us wrap
 * and hard-split by visible column without ever cutting an escape sequence.
 */
interface Cell {
  raw: string; // escapes + (optionally) the one visible char
  space: boolean; // is the visible char whitespace?
  w: 0 | 1; // visible width: 0 for an escape-only sentinel, else 1
}

function toCells(text: string): Cell[] {
  const cells: Cell[] = [];
  let pending = ""; // escapes waiting to attach to the next visible char
  const re = /\x1b\[[0-9;?]*[ -/]*[@-~]|[^]/g; // one escape OR one char
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tok = m[0];
    if (tok.startsWith("\x1b[")) {
      pending += tok;
    } else {
      cells.push({ raw: pending + tok, space: /\s/.test(tok), w: 1 });
      pending = "";
    }
  }
  if (pending) {
    // Trailing escapes (e.g. a reset) with no following char: keep them as a
    // zero-width sentinel so they aren't dropped and don't inflate the column.
    cells.push({ raw: pending, space: false, w: 0 });
  }
  return cells;
}

/**
 * Wrap one logical line into visual rows no wider than `width` visible columns.
 * Breaks at spaces; a word wider than `width` is hard-split. A boundary space
 * is consumed at each wrap point. Returns at least one row (possibly empty).
 */
export function wrapLine(text: string, width: number): string[] {
  if (width <= 0) return [text];
  // Fast path: fits and has no tabs to expand.
  if (!text.includes("\t") && visibleWidth(text) <= width) return [text];

  // Normalize tabs to a small fixed width so column math stays honest.
  const cells = toCells(text.replace(/\t/g, "    "));

  const rows: string[] = [];
  let cur = "";
  let curW = 0;

  const pushRow = (): void => {
    // Trailing whitespace at a visual line break is never meaningful.
    rows.push(cur.replace(/\s+$/, ""));
    cur = "";
    curW = 0;
  };

  // Group cells into word / space runs.
  let i = 0;
  while (i < cells.length) {
    const isSpace = cells[i]!.space;
    let j = i;
    while (j < cells.length && cells[j]!.space === isSpace) j++;
    const run = cells.slice(i, j);
    const runW = run.reduce((n, c) => n + c.w, 0);
    i = j;

    if (isSpace) {
      if (curW === 0) continue; // drop leading space on a fresh row
      if (curW + runW <= width) {
        cur += run.map((c) => c.raw).join("");
        curW += runW;
      } else {
        pushRow(); // space runs off the edge — wrap here
      }
      continue;
    }

    // A word (possibly with embedded escapes).
    if (curW + runW <= width) {
      cur += run.map((c) => c.raw).join("");
      curW += runW;
      continue;
    }

    if (curW > 0) pushRow();

    if (runW <= width) {
      cur = run.map((c) => c.raw).join("");
      curW = runW;
    } else {
      // Word wider than a full row: hard-split by visible column.
      let chunk = "";
      let chunkW = 0;
      for (const cell of run) {
        if (chunkW + cell.w > width) {
          rows.push(chunk);
          chunk = "";
          chunkW = 0;
        }
        chunk += cell.raw;
        chunkW += cell.w;
      }
      cur = chunk;
      curW = chunkW;
    }
  }

  pushRow();
  return rows.length ? rows : [""];
}

/**
 * Wrap a block of text (may contain newlines) into visual rows. Each existing
 * newline is a hard break; blank lines are preserved.
 */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const l of text.split("\n")) {
    if (l === "") out.push("");
    else out.push(...wrapLine(l, width));
  }
  return out;
}

/**
 * The plain (ANSI-stripped) text of the visible columns [start, end) of a
 * rendered row. Used to reconstruct what the user selected with the mouse: the
 * transcript rows carry SGR color codes, but a clipboard copy wants just the
 * characters. `end` may be Infinity/large to mean "to the end of the row".
 */
export function sliceVisibleText(s: string, start: number, end: number): string {
  const cells = toCells(s);
  let col = 0;
  let out = "";
  for (const cell of cells) {
    if (cell.w === 0) continue; // escape-only sentinel: no visible char
    if (col >= start && col < end) out += cell.raw.replace(ANSI_RE, "");
    col++;
  }
  return out;
}

/**
 * Return `s` with visible columns [start, end) rendered in reverse video (the
 * selection highlight). Escapes outside the range are preserved so the row's
 * colors survive; escapes *inside* the range are dropped so the highlight is a
 * single uniform [7m..[27m span (color under a selection reads as noise, and an
 * embedded reset would otherwise punch a hole in the highlight). `end` may be a
 * large sentinel to highlight to the end of the row.
 */
export function highlightRange(s: string, start: number, end: number): string {
  if (end <= start) return s;
  const cells = toCells(s);
  let col = 0;
  let before = "";
  let mid = "";
  let after = "";
  for (const cell of cells) {
    if (cell.w === 0) {
      // Zero-width trailing escapes attach to whichever side they fall on.
      if (col <= start) before += cell.raw;
      else if (col >= end) after += cell.raw;
      continue;
    }
    if (col < start) before += cell.raw;
    else if (col < end) mid += cell.raw.replace(ANSI_RE, "");
    else after += cell.raw;
    col++;
  }
  if (mid === "") return s;
  return before + "\x1b[7m" + mid + "\x1b[27m" + after;
}
