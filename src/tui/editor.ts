/**
 * The buffer/edit model both of the app's text editors run on: the prompt input
 * bar at the bottom of the transcript, and the pull-request message editor that
 * pops up over the Ctrl-O queue tab (D-20260727-15).
 *
 * It exists because the second one arrived. The prompt's editing rules — word
 * wrap with an exact cursor mapping, line-scoped Home/End/Ctrl-A/E/U/K, a
 * literal newline in the buffer, visual-row Up/Down — were already the house
 * idiom, and the captain should not have to learn a second one to retitle a pull
 * request. So the rules live HERE, as one buffer model with no terminal in it,
 * and both editors are thin key-routing layers over it. A binding that behaves
 * differently in the two places is now a code change, not a drift.
 *
 * Everything is pure and synchronous: no ANSI, no I/O, no width assumptions
 * beyond "one char is one column" (the same assumption the rest of the editor
 * makes — tabs never reach a buffer, and a wide glyph is drawn wide by the
 * terminal either way).
 */

/**
 * Buffer offsets where each visual row starts, for a buffer wrapped to `avail`
 * columns. The first entry is always 0, so the count is the number of rows.
 *
 * Rows break at the last space that fits, so a long line wraps at word
 * boundaries; the trailing space rides along on the end of the row (invisible).
 * A word longer than a full row is hard-split at the column edge as a last
 * resort so nothing overflows.
 *
 * The buffer may contain literal newlines (Shift+Enter / Ctrl-J compose a
 * multi-line message; Enter does it in the PR editor), and each one ends its row
 * unconditionally: the row after it starts at the index just past the "\n", so
 * the newline character itself is the last character of the row it terminates.
 * Callers slicing a row must strip that trailing "\n" before painting it — see
 * layoutBuffer. Every other char counts as one column.
 */
export function inputRowStarts(buf: string, avail: number): number[] {
  const width = Math.max(1, avail);
  const starts = [0];
  const n = buf.length;
  let rowStart = 0;
  while (rowStart <= n) {
    // Wrap only up to the next hard break; the newline owns the row end.
    const nl = buf.indexOf("\n", rowStart);
    const lineEnd = nl === -1 ? n : nl;

    let cur = rowStart;
    for (;;) {
      let col = 0;
      let lastBreak = -1; // buffer index just past the last space seen this row
      let j = cur;
      for (; j < lineEnd && col < width; j++) {
        col++;
        if (buf[j] === " ") lastBreak = j + 1;
      }
      if (j >= lineEnd) break; // the remainder fits on the current row
      // Break after the last fitting space so the following word stays whole;
      // if the row is one unbroken word, hard-split at the column edge (j).
      const next = lastBreak > cur ? lastBreak : j;
      starts.push(next);
      cur = next;
    }

    if (nl === -1) break;
    starts.push(nl + 1); // the row after the hard break (possibly empty)
    rowStart = nl + 1;
  }
  return starts;
}

/** A buffer wrapped to a width, plus where the cursor sits inside that wrapping. */
export interface EditorLayout {
  /** The visual rows, in order, with any terminating "\n" stripped. */
  segs: string[];
  /** Buffer offset each row starts at. Shorter than `segs` by one when the
   *  cursor forced a synthetic trailing row (see below). */
  starts: number[];
  /** 0-based row the cursor is on, within `segs`. */
  cursorRow: number;
  /** 0-based column of the cursor within its row. */
  cursorCol: number;
}

/**
 * Wrap `buf` to `avail` columns and map `cursor` (a buffer index) to a (row,
 * col) inside that wrapping. Because rows are contiguous — every row starts
 * exactly where the previous one ended — the index → (row, col) mapping is
 * exact, including on soft-wrapped rows, which is what makes the caret land
 * where it visually appears rather than a word away.
 */
export function layoutBuffer(buf: string, cursor: number, avail: number): EditorLayout {
  const width = Math.max(1, avail);
  const starts = inputRowStarts(buf, width);

  const segs: string[] = [];
  for (let r = 0; r < starts.length; r++) {
    const raw = buf.slice(starts[r]!, starts[r + 1] ?? buf.length);
    // A hard-broken row carries its terminating "\n" as its last character.
    // Painting that would emit a real line break mid-frame, so drop it here;
    // the index math above (and the cursor mapping below) still counts it.
    segs.push(raw.endsWith("\n") ? raw.slice(0, -1) : raw);
  }

  // The cursor sits on the last row whose start offset is <= cursor; its column
  // is the distance from that row's start.
  let cursorRow = starts.length - 1;
  while (cursorRow > 0 && starts[cursorRow]! > cursor) cursorRow--;
  let cursorCol = cursor - starts[cursorRow]!;

  // A cursor sitting exactly at the end of a row that fills the full width (a
  // hard-split word, or a trailing space that wrapped) belongs at the start of a
  // fresh row below it; add that row so the caret stays visible.
  if (cursorCol >= width) {
    cursorRow++;
    cursorCol = 0;
    if (segs.length <= cursorRow) segs.push("");
  }
  if (segs.length === 0) segs.push("");
  return { segs, starts, cursorRow, cursorCol };
}

/**
 * The scroll offset a viewport `height` rows tall should sit at to keep
 * `cursorRow` visible, given where it currently sits and how many rows there
 * are. Clamped at both ends, so a buffer shorter than the viewport never
 * scrolls and the last row can never be scrolled past.
 */
export function scrollToCursor(
  scroll: number,
  cursorRow: number,
  height: number,
  total: number,
): number {
  const h = Math.max(1, height);
  const max = Math.max(0, total - h);
  let next = Math.max(0, Math.min(scroll, max));
  if (cursorRow < next) next = cursorRow;
  else if (cursorRow > next + h - 1) next = cursorRow - h + 1;
  return Math.max(0, Math.min(next, max));
}

/** A pull request's human message, as the editor's one buffer splits into it. */
export interface EditedMessage {
  title: string;
  body: string;
}

/**
 * Split the editor's single buffer into a title and a body, `git commit` style:
 * line 1 is the title, everything after it is the body, and the blank line
 * between them is a separator rather than content.
 *
 * ONE buffer rather than two fields is the whole point (D-20260727-15): there is
 * no focus to switch, no tab order to learn, and the shape is one every
 * developer already knows from writing a commit message.
 *
 * The title is trimmed but not otherwise folded here — landing.ts's
 * authoredPrTitle owns the real fold (it collapses interior whitespace too), and
 * the save path runs everything through it, so there is exactly one definition
 * of what a title is allowed to look like. Blank lines at both ends of the body
 * are dropped, so the separator line never becomes a leading blank in the
 * description.
 */
export function splitMessage(text: string): EditedMessage {
  const lines = text.split("\n");
  const title = (lines.shift() ?? "").trim();
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return { title, body: lines.join("\n") };
}

/** The inverse of splitMessage: the buffer text for a title + body. Round-trips
 *  with it, so opening the editor on a saved message and saving it again with no
 *  keystrokes in between is a no-op. */
export function joinMessage(title: string, body: string): string {
  const { title: t, body: b } = splitMessage(`${title}\n\n${body}`);
  return b === "" ? `${t}\n` : `${t}\n\n${b}\n`;
}

/**
 * A text buffer with a cursor, and the editing verbs both editors bind keys to.
 * Mutable and deliberately small: it holds the text, the caret and the original
 * text (for the dirty check), and nothing about how any of it is drawn.
 */
export class TextEditor {
  private buf: string;
  private cur: number;
  private readonly initial: string;

  /** Opens on `text` with the caret at the very start — the title, which is what
   *  a captain retitling a PR reaches for first. */
  constructor(text: string) {
    this.buf = text;
    this.initial = text;
    this.cur = 0;
  }

  /** The whole buffer, verbatim. */
  get text(): string {
    return this.buf;
  }

  /** The caret's buffer offset. */
  get cursor(): number {
    return this.cur;
  }

  /** Whether anything has changed since the buffer was opened. Compares text,
   *  not keystrokes, so typing a character and deleting it again is clean. */
  get dirty(): boolean {
    return this.buf !== this.initial;
  }

  layout(width: number): EditorLayout {
    return layoutBuffer(this.buf, this.cur, width);
  }

  /** The buffer as a title + body. */
  message(): EditedMessage {
    return splitMessage(this.buf);
  }

  /**
   * Insert at the caret and advance it.
   *
   * CR/CRLF is normalised to LF, and every other C0 control is dropped: a paste
   * carries whatever its source had, and an ESC or a BEL sitting in the buffer
   * is a character no row can render — and, written back to a pull request,
   * junk nobody typed.
   */
  insert(text: string): void {
    const t = text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "");
    if (t === "") return;
    this.buf = this.buf.slice(0, this.cur) + t + this.buf.slice(this.cur);
    this.cur += t.length;
  }

  /** Delete the character before the caret. At a line boundary that is the
   *  newline itself, which joins the two lines — the conventional behaviour. */
  backspace(): void {
    if (this.cur === 0) return;
    this.buf = this.buf.slice(0, this.cur - 1) + this.buf.slice(this.cur);
    this.cur--;
  }

  /** Delete the character after the caret (the Delete key). At the end of a line
   *  that is the newline, which pulls the next line up. */
  deleteForward(): void {
    if (this.cur >= this.buf.length) return;
    this.buf = this.buf.slice(0, this.cur) + this.buf.slice(this.cur + 1);
  }

  left(): void {
    if (this.cur > 0) this.cur--;
  }

  right(): void {
    if (this.cur < this.buf.length) this.cur++;
  }

  /** Offset of the start of the logical line the caret is on. */
  lineStart(): number {
    // lastIndexOf clamps a negative fromIndex to 0 rather than searching
    // nothing, so a caret at 0 must short-circuit or a leading "\n" would report
    // a line start of 1 — past the caret.
    if (this.cur === 0) return 0;
    return this.buf.lastIndexOf("\n", this.cur - 1) + 1;
  }

  /** Offset of the end of the logical line the caret is on (before its "\n"). */
  lineEnd(): number {
    const nl = this.buf.indexOf("\n", this.cur);
    return nl === -1 ? this.buf.length : nl;
  }

  home(): void {
    this.cur = this.lineStart();
  }

  end(): void {
    this.cur = this.lineEnd();
  }

  killToStart(): void {
    const start = this.lineStart();
    this.buf = this.buf.slice(0, start) + this.buf.slice(this.cur);
    this.cur = start;
  }

  killToEnd(): void {
    this.buf = this.buf.slice(0, this.cur) + this.buf.slice(this.lineEnd());
  }

  /**
   * Move the caret one VISUAL row up or down, keeping its column where it can —
   * the same rule the prompt input uses, so a wrapped paragraph moves line by
   * line on screen rather than jumping a whole paragraph at a time. Returns
   * false when there is no such row, which is how the caller clamps at the ends
   * (the prompt falls through to history there; the PR editor simply stops).
   */
  moveRow(delta: 1 | -1, width: number): boolean {
    const { segs, starts, cursorRow, cursorCol } = this.layout(width);
    const target = cursorRow + delta;
    if (target < 0 || target >= segs.length) return false;
    const start = starts[target];
    if (start === undefined) {
      // The synthetic row layoutBuffer appends for a caret parked past the last
      // column has no start offset of its own: it IS the end of the buffer.
      this.cur = this.buf.length;
    } else {
      this.cur = Math.min(start + Math.min(cursorCol, segs[target]!.length), this.buf.length);
    }
    return true;
  }
}
