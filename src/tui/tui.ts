/**
 * A tiny, zero-dependency terminal UI for the interactive session.
 *
 * Why this exists: comanager used to enter the alternate screen buffer but kept
 * driving I/O through readline. The alt buffer has NO native scrollback, so the
 * wheel had nothing to scroll and its synthesized arrow keys leaked into
 * readline as input-history navigation. This module fixes that by owning the
 * screen the way vim/htop/Claude-Code-fullscreen do: a full-screen renderer
 * with its own scrollable transcript buffer plus a line editor at the bottom.
 *
 * Design, mirroring Claude Code's fullscreen mode:
 *  - Alternate screen buffer; a fixed input region at the bottom, a scrolling
 *    transcript above it.
 *  - We keep the ENTIRE transcript in memory as visual rows (already wrapped to
 *    the current width) and paint only the visible slice. Scrolling moves the
 *    slice; it never asks the terminal for scrollback it doesn't have.
 *  - Mouse wheel scrolls the transcript (SGR mouse mode 1006 + button tracking).
 *    Because the app grabs the mouse for the wheel, the terminal can't do its
 *    own click-drag selection, so we implement selection ourselves: a left-drag
 *    over the transcript highlights those cells in reverse video and, on release,
 *    copies the plain text to the clipboard via OSC 52 (works locally and over
 *    SSH). The terminal's modifier-key override (hold Option in iTerm2, Fn in
 *    Terminal.app, Shift elsewhere) still works as a fallback, and CO_MOUSE=off
 *    disables capture entirely.
 *  - PgUp/PgDn/Ctrl-Home/Ctrl-End scroll from the keyboard; ↑/↓ navigate INPUT
 *    HISTORY (this is the behavior users expect and the old bug conflated).
 *  - SIGWINCH re-wraps and repaints. Every exit path restores the terminal.
 *
 * Non-goals: right-to-left / wide-glyph width beyond the ANSI-aware column
 * counting in ./wrap.
 */

import { wrapText, wrapLine, visibleWidth, sliceVisibleText, highlightRange } from "./wrap.js";
import { c, colorEnabled } from "../ui.js";
import { classifyToken, completeCommand } from "./commands.js";
import { MarkdownRenderer, renderTable, type Rendered } from "./markdown.js";
import {
  classify,
  classifyByte,
  parseCsiU,
  parseModifyOtherKeys,
  type Action,
} from "./keys.js";

const ESC = "\x1b";
const CSI = "\x1b[";

// Bracketed-paste (DECSET 2004) markers. When enabled, the terminal wraps
// pasted content in these so we can tell a paste from fast typing and never
// let its embedded newlines read as Enter.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

// The chip a collapsed multi-line paste leaves in the input buffer. It's plain
// text (no ANSI) so the editor's cursor-index == visible-column math still
// holds; (\d+) captures the paste id used to expand it back on submit.
const CHIP_PATTERN = String.raw`\[Pasted text #(\d+) \+\d+ lines\]`;

function chipFor(id: number, lines: number): string {
  return `[Pasted text #${id} +${lines} lines]`;
}

function mouseEnabled(): boolean {
  return process.env.CO_MOUSE !== "off";
}

function pasteEnabled(): boolean {
  return process.env.CO_PASTE !== "off";
}

/**
 * Whether to ask the terminal for the Kitty keyboard protocol. It's how
 * Shift+Enter becomes visible at all (see keys.ts); CO_KEYS=off opts out for
 * anyone whose terminal mis-handles the request. Turning it off costs only
 * Shift+Enter — Ctrl-J still inserts a newline either way.
 */
function enhancedKeysEnabled(): boolean {
  return process.env.CO_KEYS !== "off";
}

/** Count the lines in text, ignoring a single trailing newline. */
function countLines(text: string): number {
  const parts = text.split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

/**
 * Word-wrap the plain-text input buffer into visual rows no wider than `avail`
 * visible columns, returning the buffer offset at which each row starts
 * (`starts[0]` is always 0).
 *
 * The rows are *contiguous*: every character of `buf` belongs to exactly one
 * row and no boundary space is dropped. That is the whole trick — it lets the
 * editor word-wrap yet still map a `cursor` index to an exact (row, col) via
 * `starts`, which is why the editor used to hard-wrap by column instead. We
 * break after the last space that fits so words stay whole; the trailing space
 * rides along on the end of the row (invisible). A word longer than a full row
 * is hard-split at the column edge as a last resort so nothing overflows.
 *
 * The buffer may contain literal newlines (Shift+Enter / Ctrl-J compose a
 * multi-line message), and each one ends its row unconditionally: the row after
 * it starts at the index just past the "\n", so the newline character itself is
 * the last character of the row it terminates. Callers slicing a row must strip
 * that trailing "\n" before painting it — see inputLayout. Tabs never reach the
 * buffer (Tab is a completion key) and every other char counts as one column,
 * matching the width assumptions the rest of the editor already makes.
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

/**
 * The currently-active Tui, if any. A top-level error handler can call
 * restoreTerminal() to guarantee the alt buffer is torn down before printing on
 * the primary screen, without threading the instance through call sites.
 */
let activeTui: Tui | null = null;

/** Restore the terminal if a Tui is active. Safe to call unconditionally. */
export function restoreTerminal(): void {
  activeTui?.stop();
}

/** Terminal control helpers, batched so each frame is one write(). */
const term = {
  enterAlt: `${CSI}?1049h`,
  leaveAlt: `${CSI}?1049l`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  clear: `${CSI}2J`,
  // SGR mouse: 1000 (button) + 1002 (drag) so wheel events are reported, then
  // 1006 for the SGR extended coordinate encoding we parse below.
  mouseOn: `${CSI}?1000h${CSI}?1002h${CSI}?1006h`,
  mouseOff: `${CSI}?1000l${CSI}?1002l${CSI}?1006l`,
  // Bracketed paste: the terminal wraps pasted content in PASTE_START/PASTE_END
  // so we can buffer it whole instead of processing its newlines as Enter.
  pasteOn: `${CSI}?2004h`,
  pasteOff: `${CSI}?2004l`,
  // Kitty keyboard protocol, progressive-enhancement flag 1 ("disambiguate
  // escape codes"). PUSHES onto the terminal's per-screen flag stack, so
  // keysOff pops exactly our entry and leaves whatever the outer program (tmux,
  // a shell) had pushed untouched. Flag 1 is the mildest level: keys with an
  // unambiguous legacy encoding (Enter, Tab, Backspace, printable text) keep
  // sending it, and only the previously-unrepresentable combos — Shift+Enter,
  // Ctrl+Enter, Ctrl+J — arrive as CSI-u. Terminals that don't implement the
  // protocol ignore both sequences: they're syntactically valid CSI with a
  // private-use intermediate, so nothing is echoed as stray input.
  keysOn: `${CSI}>1u`,
  keysOff: `${CSI}<u`,
  moveTo: (row: number, col: number): string => `${CSI}${row};${col}H`,
  clearLine: `${CSI}2K`,
};

/** The subset of a writable TTY stream the Tui needs. Enables test injection. */
export interface OutStream {
  write(s: string): unknown;
  columns?: number;
  rows?: number;
}

/** The subset of a readable TTY stream the Tui needs. */
export interface InStream {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  setEncoding(enc: BufferEncoding): unknown;
  on(event: "data", listener: (data: string) => void): unknown;
  removeListener(event: "data", listener: (data: string) => void): unknown;
}

export interface TuiOptions {
  /** Painted once at the very top of the transcript (banner). */
  header?: string;
  /** The input prompt label, e.g. "you › ". May contain ANSI. */
  promptLabel: string;
  /** Injectable IO for testing; defaults to process stdio. */
  out?: OutStream;
  inp?: InStream;
}

/**
 * The interface the interactive session drives. The rich implementation is the
 * Tui below; a plain readline implementation (session.ts) satisfies the same
 * contract for piped/non-TTY use so scripts and tests keep working.
 */
export interface SessionIO {
  start(): void;
  stop(): void;
  /** Commit a finished block of text (may contain newlines/ANSI). */
  appendBlock(text: string): void;
  /**
   * Stream a chunk into the open (unterminated) transcript line. Pass
   * `{ markdown: true }` for assistant answer text so completed lines are
   * rendered markdown → ANSI; omit it for labels and system text.
   */
  appendStream(chunk: string, opts?: { markdown?: boolean }): void;
  /** Commit whatever is currently open (no-op if nothing is streaming). */
  flushStream(): void;
  /**
   * Show (or clear, with null) an animated "working on it" indicator while the
   * co is busy off-screen — a model call in flight, a tool running. Ephemeral:
   * it never enters the transcript.
   */
  setBusy(label: string | null): void;
  /** Read one line; resolves null on EOF (clean exit). */
  question(): Promise<string | null>;
}

/**
 * Spinner frames for the busy indicator: Claude Code's pulsing asterisk. The
 * glyphs run small → large and then back down, so the star breathes rather than
 * snapping from full size to a dot. The bounce is baked into the array (the two
 * endpoints appear once) instead of being computed, so the cycle is just an
 * index step.
 */
const BUSY_FRAMES = ["·", "✢", "✳", "∗", "✻", "✽", "✻", "∗", "✳", "✢"];
const BUSY_TICK_MS = 120;

export class Tui implements SessionIO {
  private out: OutStream;
  private inp: InStream;

  private cols = 80;
  private rows = 24;

  // Transcript model. `committed` holds finalized entries that never change;
  // `committedRows` is their wrapped form, cached so we don't re-wrap the whole
  // history on every token. `open` is the single logical line still being
  // streamed into (may be ""). Its wrapped rows are appended on the fly.
  //
  // Entries are kept as `Rendered` rather than plain strings because a table
  // has to be laid out against the current width: word-wrapping an already-drawn
  // table on resize would shred its alignment, so tables stay in raw form here
  // and are re-rendered by entryRows() whenever the width changes.
  private committed: Rendered[] = [];
  private committedRows: string[] = [];
  private open: string | null = null;
  /** Whether the open logical line is assistant answer text to render as markdown. */
  private openMarkdown = false;
  /** Stateful markdown → ANSI renderer for assistant answer lines. */
  private md = new MarkdownRenderer();
  /** Top visible transcript row index. Clamped to [0, maxScroll]. */
  private scroll = 0;
  /** True while pinned to the bottom (auto-follow new output). */
  private atBottom = true;

  // Line editor state.
  private promptLabel: string;
  private buf = "";
  private cursor = 0; // index within buf
  private history: string[] = [];
  private histIdx = -1; // -1 == editing a fresh line
  private draft = ""; // stashed in-progress line while browsing history

  private header?: string;
  private active = false;
  private raw = false;
  /** True once we've pushed our Kitty keyboard flags, so stop() pops exactly one. */
  private keysPushed = false;

  // Bracketed-paste state. While `pasting`, raw bytes accumulate in `pasteBuf`
  // (across as many data events as the paste spans) until the end marker. A
  // multi-line paste is collapsed to a `[Pasted text #N +K lines]` chip; the
  // real content is stashed in `pastes` keyed by id and expanded back on submit,
  // so the model always sees the full text while the editor stays uncluttered.
  private pasting = false;
  private pasteBuf = "";
  private pasteCounter = 0;
  private pastes = new Map<number, string>();

  // Mouse text selection over the transcript. Coordinates are ABSOLUTE row
  // indices into renderedRows() plus a 0-based visible column, so they stay
  // valid as new output is appended below and as the view scrolls. `selecting`
  // is true only during an active left-drag; the highlighted `selection`
  // persists after release (as copied-confirmation) until the next keypress or
  // click clears it. `lastPaintStart` is the transcript row shown at the top of
  // the viewport in the last paint(), the anchor for mapping mouse (x,y) back to
  // absolute coordinates.
  private selection:
    | { anchorRow: number; anchorCol: number; focusRow: number; focusCol: number }
    | null = null;
  private selecting = false;
  private lastPaintStart = 0;

  // A transient status message shown right-aligned on the separator line just
  // above the input bar (e.g. "copied 4 lines"), the way Claude Code flashes
  // ephemeral notices. It clears itself after a short delay and is never
  // committed to the transcript.
  private status: string | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;

  // The busy indicator: a spinner + label that sits in the same right-hand slot
  // as `status` and, unlike it, persists until explicitly cleared. It exists so
  // silent work (a model call in flight, a memory write) never reads as a hung
  // terminal. Like `status` it is ephemeral — never committed to the transcript,
  // so it leaves no scrollback trail and doesn't narrate what was saved.
  private busy: string | null = null;
  private busyFrame = 0;
  private busyTimer: ReturnType<typeof setInterval> | null = null;

  // Pending single-line resolver when awaiting input.
  private pendingResolve: ((line: string | null) => void) | null = null;
  private sigintCount = 0;
  // Armed by a lone ESC; a second consecutive lone ESC clears the input line
  // (matches Claude Code's esc-esc). Any other key disarms it.
  private escPending = false;

  private onResize = (): void => {
    this.measure();
    this.rewrap();
    this.paint();
  };

  constructor(opts: TuiOptions) {
    this.promptLabel = opts.promptLabel;
    this.header = opts.header;
    this.out = opts.out ?? process.stdout;
    this.inp = opts.inp ?? process.stdin;
  }

  // --- lifecycle -------------------------------------------------------------

  /**
   * Whether a real interactive TUI is possible on this stream. TERM=dumb is a
   * TTY but has no cursor addressing or alternate buffer, so the full-screen
   * takeover would garble it — those sessions fall back to PlainIO.
   */
  static capable(): boolean {
    return Boolean(process.stdout.isTTY && process.stdin.isTTY && process.env.TERM !== "dumb");
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    activeTui = this;
    this.measure();

    if (this.inp.isTTY && this.inp.setRawMode) {
      this.inp.setRawMode(true);
      this.raw = true;
    }
    this.inp.resume();
    this.inp.setEncoding("utf8");

    this.out.write(term.enterAlt + term.clear + term.hideCursor);
    if (mouseEnabled()) this.out.write(term.mouseOn);
    if (pasteEnabled()) this.out.write(term.pasteOn);
    if (enhancedKeysEnabled()) {
      this.out.write(term.keysOn);
      this.keysPushed = true;
    }

    if (this.header) this.appendBlock(this.header);

    process.on("SIGWINCH", this.onResize);
    this.inp.on("data", this.handleData);
    this.hookRestore();
    this.paint();
  }

  /** Restore the terminal. Idempotent; safe to call on any exit path. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (activeTui === this) activeTui = null;

    process.removeListener("SIGWINCH", this.onResize);
    this.inp.removeListener("data", this.handleData);
    if (this.statusTimer) { clearTimeout(this.statusTimer); this.statusTimer = null; }
    if (this.busyTimer) { clearInterval(this.busyTimer); this.busyTimer = null; }
    this.busy = null;

    if (mouseEnabled()) this.out.write(term.mouseOff);
    if (pasteEnabled()) this.out.write(term.pasteOff);
    // Pop the keyboard flags BEFORE leaving the alternate screen: the Kitty
    // flag stack is per-screen-buffer, so popping after the switch would pop
    // the primary screen's stack and strand our entry on the alt screen. stop()
    // runs on every exit path (normal, SIGTERM/SIGHUP, uncaughtException, and
    // process 'exit'), so a crash can't leave the terminal in enhanced mode.
    // Only pop what we pushed: an unmatched pop would discard an entry belonging
    // to whatever wraps us (tmux, a shell, an outer TUI).
    if (this.keysPushed) {
      this.out.write(term.keysOff);
      this.keysPushed = false;
    }
    this.out.write(term.showCursor + term.leaveAlt);
    if (this.raw && this.inp.setRawMode) this.inp.setRawMode(false);
    this.inp.pause();
  }

  private restoreHooked = false;
  private hookRestore(): void {
    if (this.restoreHooked) return;
    this.restoreHooked = true;
    process.once("exit", () => this.stop());
    for (const sig of ["SIGTERM", "SIGHUP"] as const) {
      process.once(sig, () => {
        this.stop();
        process.exit(sig === "SIGTERM" ? 143 : 129);
      });
    }
    process.once("uncaughtException", (err) => {
      this.stop();
      // Surface on the restored primary screen.
      console.error(err);
      process.exit(1);
    });
  }

  private measure(): void {
    this.cols = Math.max(20, this.out.columns || 80);
    this.rows = Math.max(6, this.out.rows || 24);
  }

  // --- transcript ------------------------------------------------------------

  /** Number of screen rows reserved for the input editor + separator. */
  private inputRows(): number {
    // busy line (when working) + separator + wrapped input text rows
    return this.busyRows() + 1 + this.inputTextRows();
  }

  /**
   * Rows the busy indicator occupies: one while working, none when idle. It
   * gets its own line above the rule rather than riding on it, which is where
   * Claude Code puts its spinner. The transcript viewport gives up that row for
   * the duration — the same way it already yields rows as the input wraps.
   */
  private busyRows(): number {
    return this.busy === null ? 0 : 1;
  }

  /**
   * How many screen rows the wrapped input text occupies, capped so the editor
   * never eats more than half the screen — past that it scrolls internally
   * around the cursor, so the transcript stays visible on a big paste.
   */
  private inputTextRows(): number {
    return Math.min(this.inputLayout().segs.length, this.maxInputTextRows());
  }

  private maxInputTextRows(): number {
    return Math.max(1, Math.floor(this.rows / 2));
  }

  /**
   * Wrap the raw input buffer to the available width and map the cursor to a
   * (row, col) within that wrapping. We word-wrap (break at spaces) so typing a
   * long line no longer splits words mid-word at the column edge; a word wider
   * than a row is still hard-split so nothing overflows. See inputRowStarts for
   * why contiguous rows keep the cursor index → (row, col) mapping exact.
   */
  private inputLayout(): {
    segs: string[];
    starts: number[];
    cursorRow: number;
    cursorCol: number;
  } {
    const promptW = visibleWidth(this.promptLabel);
    const avail = Math.max(1, this.cols - promptW);
    const starts = inputRowStarts(this.buf, avail);

    const segs: string[] = [];
    for (let r = 0; r < starts.length; r++) {
      const raw = this.buf.slice(starts[r]!, starts[r + 1] ?? this.buf.length);
      // A hard-broken row carries its terminating "\n" as its last character.
      // Painting that would emit a real line break mid-frame, so drop it here;
      // the index math above (and the cursor mapping below) still counts it.
      segs.push(raw.endsWith("\n") ? raw.slice(0, -1) : raw);
    }

    // The cursor sits on the last row whose start offset is <= cursor; its
    // column is the distance from that row's start.
    let cursorRow = starts.length - 1;
    while (cursorRow > 0 && starts[cursorRow]! > this.cursor) cursorRow--;
    let cursorCol = this.cursor - starts[cursorRow]!;

    // A cursor sitting exactly at the end of a row that fills the full width
    // (a hard-split word, or a trailing space that wrapped) belongs at the
    // start of a fresh row below it; add that row so the caret stays visible.
    if (cursorCol >= avail) {
      cursorRow++;
      cursorCol = 0;
      if (segs.length <= cursorRow) segs.push("");
    }
    if (segs.length === 0) segs.push("");
    return { segs, starts, cursorRow, cursorCol };
  }

  /**
   * Move the cursor one visual row up or down, keeping its column where it can.
   * Returns false when there is no such row — which is how ↑/↓ fall through to
   * input-history browsing at the top/bottom of a multi-line buffer, matching
   * what every other editor-with-history does.
   */
  private moveCursorRow(delta: 1 | -1): boolean {
    const { segs, starts, cursorRow, cursorCol } = this.inputLayout();
    const target = cursorRow + delta;
    if (target < 0 || target >= segs.length) return false;

    const start = starts[target];
    if (start === undefined) {
      // The synthetic row inputLayout appends for a caret parked past the last
      // column has no start offset of its own: it IS the end of the buffer.
      this.cursor = this.buf.length;
    } else {
      this.cursor = Math.min(start + Math.min(cursorCol, segs[target]!.length), this.buf.length);
    }
    this.paint();
    return true;
  }

  private viewportRows(): number {
    return Math.max(1, this.rows - this.inputRows());
  }

  /**
   * Provisional rows for a multi-line block (a table) still being streamed, plus
   * whether the open partial line was folded into it. Re-laid out on every call
   * so the table grows live rather than popping in when the block closes.
   */
  private pendingView(): { rows: string[]; absorbed: boolean } {
    return this.md.pendingLines(this.cols, this.openMarkdown ? this.open : null);
  }

  /** Rows for the open line, when it isn't already part of a pending block. */
  private openRows(absorbed: boolean): string[] {
    if (absorbed || this.open === null) return [];
    if (this.open === "") return [""];
    return wrapLine(this.renderedOpen(), this.cols);
  }

  /** The rendered transcript: committed rows, any pending block, then the open line. */
  private renderedRows(): string[] {
    const { rows: pending, absorbed } = this.pendingView();
    return [...this.committedRows, ...pending, ...this.openRows(absorbed)];
  }

  private rowCount(): number {
    // Avoid materializing the committed array just to count.
    const { rows: pending, absorbed } = this.pendingView();
    return this.committedRows.length + pending.length + this.openRows(absorbed).length;
  }

  private maxScroll(): number {
    return Math.max(0, this.rowCount() - this.viewportRows());
  }

  private wrapLogical(l: string): string[] {
    return l === "" ? [""] : wrapLine(l, this.cols);
  }

  /** Visual rows for one committed entry at the current width. */
  private entryRows(e: Rendered): string[] {
    // A table is laid out to fit `cols` exactly, so it must not be word-wrapped.
    return e.kind === "table" ? renderTable(e.table, this.cols) : this.wrapLogical(e.text);
  }

  private pushEntry(e: Rendered): void {
    this.committed.push(e);
    this.committedRows.push(...this.entryRows(e));
  }

  /**
   * Commit a finalized logical line into the cached transcript. `markdown`
   * lines (assistant answer text) go through the renderer, which resolves most
   * lines immediately but holds table rows until the block closes — so a single
   * call here can commit nothing, one line, or a whole table. The raw markdown
   * lives only in the durable transcript that session.ts keeps.
   */
  private commitLine(l: string, markdown = false): void {
    if (markdown) {
      for (const e of this.md.feed(l, this.cols)) this.pushEntry(e);
      return;
    }
    // Plain text (labels, tool notices) can't belong to a table: close any open
    // block first so the table lands above it rather than swallowing it.
    for (const e of this.md.flushBlock(this.cols)) this.pushEntry(e);
    this.pushEntry({ kind: "line", text: l });
  }

  /** Append a block of text (may contain newlines/ANSI) as committed lines. */
  appendBlock(text: string): void {
    // A block interrupts any open stream line: flush it first.
    this.flushStream();
    // A block is a turn boundary (spacer, label, tool notice, system line): any
    // assistant markdown stream has ended, so drop stale fence/table state.
    this.md.reset();
    for (const l of text.split("\n")) this.commitLine(l);
    this.afterGrow();
  }

  /**
   * Stream a chunk into the open logical line (no trailing newline). Used for
   * token-by-token model output. Newlines inside the chunk commit lines. Pass
   * `markdown: true` for assistant answer text so completed lines render as
   * markdown; the open (partial) line is rendered live but non-committally.
   */
  appendStream(chunk: string, opts?: { markdown?: boolean }): void {
    if (this.open === null) this.open = "";
    this.openMarkdown = Boolean(opts?.markdown);
    const text = this.open + chunk;
    const parts = text.split("\n");
    this.open = parts.pop() ?? ""; // trailing partial line stays open
    for (let k = 0; k < parts.length; k++) this.commitLine(parts[k]!, this.openMarkdown);
    // Only the open line's wrapping is recomputed on paint — O(open line), not
    // O(whole transcript). committedRows above is untouched.
    this.afterGrow();
  }

  /** Commit any open stream line, and close any block it was part of. */
  flushStream(): void {
    if (this.open !== null) {
      this.commitLine(this.open, this.openMarkdown);
      this.open = null;
      this.openMarkdown = false;
    }
    // A turn that ends mid-table still has to render it.
    for (const e of this.md.flushBlock(this.cols)) this.pushEntry(e);
  }

  /** Display form of the open line: markdown-rendered live if it's answer text. */
  private renderedOpen(): string {
    if (this.open === null || this.open === "") return this.open ?? "";
    return this.openMarkdown ? this.md.peek(this.open, this.cols) : this.open;
  }

  /** After the transcript grows: keep the bottom pinned if we were following. */
  private afterGrow(): void {
    if (this.atBottom) this.scroll = this.maxScroll();
    if (this.active) this.paint();
  }

  /**
   * Re-wrap all committed entries at the current width (resize only). Tables are
   * laid out again from their raw form rather than re-wrapped, so a resize
   * re-flows their columns instead of breaking the box apart.
   */
  private rewrap(): void {
    const rows: string[] = [];
    for (const e of this.committed) rows.push(...this.entryRows(e));
    this.committedRows = rows;
    this.scroll = Math.min(this.scroll, this.maxScroll());
  }

  // --- scrolling -------------------------------------------------------------

  private scrollBy(delta: number): void {
    const prev = this.scroll;
    this.scroll = Math.max(0, Math.min(this.maxScroll(), this.scroll + delta));
    this.atBottom = this.scroll >= this.maxScroll();
    if (this.scroll !== prev) this.paint();
  }

  private scrollToBottom(): void {
    this.scroll = this.maxScroll();
    this.atBottom = true;
    this.paint();
  }

  // --- rendering -------------------------------------------------------------

  private paint(): void {
    if (!this.active) return;
    // The input region height is dynamic (it grows as the buffer wraps), so the
    // transcript viewport height changes as the user types. Re-pin to the bottom
    // when following, so a growing input never leaves the transcript showing
    // stale top rows. When scrolled up (not following), scroll stays put.
    if (this.atBottom) this.scroll = this.maxScroll();
    const vp = this.viewportRows();
    const rowsAll = this.renderedRows();
    const start = Math.min(this.scroll, Math.max(0, rowsAll.length - vp));
    this.lastPaintStart = start; // anchor for mapping mouse (x,y) → absolute row
    const frame: string[] = [term.moveTo(1, 1)];

    for (let r = 0; r < vp; r++) {
      const absRow = start + r;
      const line = this.applySelection(rowsAll[absRow] ?? "", absRow);
      frame.push(term.clearLine + this.clip(line, this.cols) + "\n");
    }

    // Busy line: the spinner + chore, hard against the left margin on its own
    // row directly above the rule. Only painted while working.
    const busyRows = this.busyRows();
    if (busyRows) {
      frame.push(
        term.moveTo(vp + 1, 1) + term.clearLine + c.cyan(this.clip(this.busyText(), this.cols)),
      );
    }

    // Separator: a horizontal rule, with a scroll hint on the left when not
    // pinned to the bottom and a transient status (e.g. "copied 4 lines") on
    // the right.
    const below = rowsAll.length - (start + vp);
    const scrollHint =
      this.atBottom || below <= 0 ? "" : `more below · ${below} line(s)`;
    const sepRow = vp + busyRows + 1;
    frame.push(term.moveTo(sepRow, 1) + term.clearLine + this.renderSeparator(scrollHint));

    // Input region: one or more wrapped rows below the separator. The prompt
    // label leads the first row; continuation rows hang-indent under it so the
    // text forms a clean block and the cursor column math is uniform.
    const view = this.inputView();
    const firstRow = sepRow + 1;
    for (let vr = 0; vr < view.rows.length; vr++) {
      frame.push(term.moveTo(firstRow + vr, 1) + term.clearLine + view.rows[vr]!);
    }

    // Place the hardware cursor and reveal it on the input line.
    const promptW = visibleWidth(this.promptLabel);
    frame.push(
      term.moveTo(firstRow + view.cursorRow, promptW + 1 + view.cursorCol) + term.showCursor,
    );
    this.out.write(frame.join(""));
  }

  /**
   * Build the visible input rows and the cursor's position within them. The
   * buffer is wrapped to `cols - promptW` columns; if it wraps to more rows than
   * we allow (see maxInputTextRows), we show a window around the cursor so the
   * caret stays visible on a large paste. Each row is prefixed with the prompt
   * label (first buffer row) or an equal-width indent (continuation rows), so a
   * cursor at column `cursorCol` within a segment always sits at screen column
   * promptW + 1 + cursorCol.
   */
  private inputView(): { rows: string[]; cursorRow: number; cursorCol: number } {
    const promptW = visibleWidth(this.promptLabel);
    const avail = Math.max(1, this.cols - promptW);
    const { segs, cursorRow, cursorCol } = this.inputLayout();
    const indent = " ".repeat(promptW);

    // Internal scroll window when the input is taller than we allow.
    const cap = this.maxInputTextRows();
    let winStart = 0;
    if (segs.length > cap) {
      winStart = Math.min(Math.max(0, cursorRow - cap + 1), segs.length - cap);
    }
    const winEnd = Math.min(segs.length, winStart + (segs.length > cap ? cap : segs.length));

    // The single-line, fits-on-screen case keeps the command colouring + ghost
    // completion decoration; multi-row editing drops it (a line that long isn't
    // a command being typed), matching the old horizontal-scroll behaviour.
    const rows: string[] = [];
    for (let s = winStart; s < winEnd; s++) {
      const gutter = s === 0 ? this.promptLabel : indent;
      const body =
        segs.length === 1 ? this.decorateInput(avail).text : segs[s]!;
      rows.push(gutter + body);
    }
    return { rows, cursorRow: cursorRow - winStart, cursorCol };
  }

  /**
   * Compose the separator line: a dim horizontal rule that spans the width,
   * carrying an optional left-side scroll hint and, when present, a right-side
   * transient status. Both are laid onto a plain-text canvas first so the rule
   * fills exactly the space between them, then styled.
   */
  private renderSeparator(scrollHint: string): string {
    const w = this.cols;
    const status = this.status ?? "";
    // Reserve the right end for the status with one dash of padding on each side.
    const right = status ? ` ${status} ` : "";
    const rightW = visibleWidth(right);
    const leftHint = scrollHint ? `── ${scrollHint} ` : "";
    const left = visibleWidth(leftHint) + rightW <= w ? leftHint : "";
    const fill = Math.max(0, w - visibleWidth(left) - rightW);
    const rule = left + "─".repeat(fill);
    // The rule is dim; the status stands out in cyan so a copy notice reads.
    return c.dim(rule) + (status ? c.cyan(right) : "");
  }

  /** Truncate a rendered row to the visible width, preserving escapes. */
  private clip(line: string, width: number): string {
    if (visibleWidth(line) <= width) return line;
    // wrapLine hard-splits by column; take its first row.
    return wrapLine(line, width)[0] ?? "";
  }

  /**
   * Overlay the active selection highlight onto the rendered transcript row at
   * absolute index `absRow`. Rows outside the selection are returned unchanged;
   * the anchor/focus are normalized so dragging up or down both work, and the
   * first/last rows are highlighted from/to the correct column while interior
   * rows highlight fully.
   */
  private applySelection(line: string, absRow: number): string {
    const sel = this.selection;
    if (!sel) return line;
    const { top, bottom, topCol, bottomCol } = this.normalizedSelection(sel);
    if (absRow < top || absRow > bottom) return line;
    const from = absRow === top ? topCol : 0;
    const to = absRow === bottom ? bottomCol : Number.MAX_SAFE_INTEGER;
    return highlightRange(line, from, to);
  }

  /**
   * Order a selection's endpoints top-to-bottom so highlight/copy don't care
   * which direction the user dragged. `bottomCol` is exclusive (the column just
   * past the last selected cell).
   */
  private normalizedSelection(sel: NonNullable<Tui["selection"]>): {
    top: number;
    bottom: number;
    topCol: number;
    bottomCol: number;
  } {
    // bottomCol is exclusive, so the cell the drag ended on is included: +1
    // past the ending cell's column.
    const forward =
      sel.focusRow > sel.anchorRow ||
      (sel.focusRow === sel.anchorRow && sel.focusCol >= sel.anchorCol);
    return forward
      ? { top: sel.anchorRow, bottom: sel.focusRow, topCol: sel.anchorCol, bottomCol: sel.focusCol + 1 }
      : { top: sel.focusRow, bottom: sel.anchorRow, topCol: sel.focusCol, bottomCol: sel.anchorCol + 1 };
  }

  /** The plain text of the current selection, joined with newlines. */
  private selectionText(): string {
    const sel = this.selection;
    if (!sel) return "";
    const { top, bottom, topCol, bottomCol } = this.normalizedSelection(sel);
    const rowsAll = this.renderedRows();
    const out: string[] = [];
    for (let r = top; r <= bottom && r < rowsAll.length; r++) {
      const from = r === top ? topCol : 0;
      const to = r === bottom ? bottomCol : Number.MAX_SAFE_INTEGER;
      out.push(sliceVisibleText(rowsAll[r] ?? "", from, to));
    }
    return out.join("\n");
  }

  /**
   * Flash a transient status on the separator line above the input bar. It
   * replaces any prior status and auto-clears after `ms`. Never enters the
   * transcript, so it leaves no scrollback trail (matching Claude Code's
   * ephemeral notices). No-op timer on the non-TTY path is harmless.
   */
  private setStatus(text: string, ms = 2000): void {
    this.status = text;
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => {
      this.status = null;
      this.statusTimer = null;
      this.paint();
    }, ms);
    // Don't keep the process alive just to clear a cosmetic notice.
    this.statusTimer.unref?.();
    this.paint();
  }

  /** The busy indicator as it appears in the separator's right-hand slot. */
  private busyText(): string {
    if (!this.busy) return "";
    return `${BUSY_FRAMES[this.busyFrame % BUSY_FRAMES.length]} ${this.busy}…`;
  }

  /**
   * Start, relabel, or stop the busy indicator. Passing a new label while one is
   * already running just swaps the text and keeps the wheel turning, so a run of
   * back-to-back operations reads as one continuous piece of work rather than a
   * stutter of restarts.
   */
  setBusy(label: string | null): void {
    if (label === null) {
      if (this.busyTimer) { clearInterval(this.busyTimer); this.busyTimer = null; }
      if (this.busy === null) return;
      this.busy = null;
      this.paint();
      return;
    }
    const wasIdle = this.busy === null;
    this.busy = label;
    if (wasIdle) this.busyFrame = 0;
    if (!this.busyTimer) {
      this.busyTimer = setInterval(() => {
        this.busyFrame++;
        this.paint();
      }, BUSY_TICK_MS);
      // Cosmetic: never hold the event loop open for a spinner.
      this.busyTimer.unref?.();
    }
    this.paint();
  }

  /** Drop any active selection and repaint if it was showing. */
  private clearSelection(): void {
    if (!this.selection && !this.selecting) return;
    this.selection = null;
    this.selecting = false;
    this.paint();
  }

  /**
   * Copy `text` to the system clipboard via OSC 52. This is terminal-native, so
   * it works through SSH/tmux (given passthrough) without shelling out to
   * pbcopy/xclip. Empty selections are ignored.
   */
  private copyToClipboard(text: string): void {
    if (text === "") return;
    const b64 = Buffer.from(text, "utf8").toString("base64");
    this.out.write(`${ESC}]52;c;${b64}\x07`);
  }

  /**
   * The command completion currently being suggested, or null. Only offered
   * while the user is still typing the command word (a "/" line with no space
   * yet) and the cursor is at the end, so accepting can't corrupt mid-line text.
   * paint() and the Tab/→ accept path both read this so they always agree.
   */
  private currentGhost(): { name: string; arg?: string } | null {
    if (!this.buf.startsWith("/")) return null;
    if (this.buf.includes(" ")) return null; // past the command word
    if (this.buf.includes("\n")) return null; // a multi-line message isn't a command
    if (this.cursor !== this.buf.length) return null; // complete only at the end
    const cmd = completeCommand(this.buf.slice(1));
    return cmd ? { name: cmd.name, arg: cmd.arg } : null;
  }

  /**
   * Build the decorated, fits-on-screen input text: colour the "/command" token
   * and append the light-grey ghost completion. Guaranteed visible width <=
   * avail (the ghost is clipped to the remaining room).
   */
  private decorateInput(avail: number): { text: string; cursorCol: number } {
    const buf = this.buf;
    let text = buf;

    if (colorEnabled && buf.startsWith("/")) {
      const spaceIdx = buf.indexOf(" ");
      const cmdPart = spaceIdx === -1 ? buf : buf.slice(0, spaceIdx);
      const rest = spaceIdx === -1 ? "" : buf.slice(spaceIdx);
      const kind = classifyToken(cmdPart.slice(1));
      const painted =
        kind === "valid" ? c.green(cmdPart)
        : kind === "unknown" ? c.yellow(cmdPart)
        : c.cyan(cmdPart); // a valid prefix, still being typed
      text = painted + rest;
    }

    const ghost = this.currentGhost();
    if (ghost && colorEnabled) {
      const remainder = ghost.name.slice(buf.length - 1); // buf is "/" + partial
      const hint = remainder + (ghost.arg ? " " + ghost.arg : "");
      const room = avail - buf.length;
      if (room > 0) text += c.grey(hint.slice(0, room));
    }

    return { text, cursorCol: this.cursor };
  }

  /**
   * Accept the current ghost completion: fill in the command name (plus a
   * trailing space when it takes an argument). Returns false if none is showing.
   */
  private acceptGhost(): boolean {
    const ghost = this.currentGhost();
    if (!ghost) return false;
    this.buf = "/" + ghost.name + (ghost.arg ? " " : "");
    this.cursor = this.buf.length;
    this.paint();
    return true;
  }

  // --- input ----------------------------------------------------------------

  /**
   * Await one line of input. Resolves with the line on Enter, or null on EOF
   * (Ctrl-D on an empty line) so the caller can treat it as a clean exit.
   */
  question(): Promise<string | null> {
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
      this.paint();
    });
  }

  /** Print a system line into the transcript (e.g. a notice). */
  print(text: string): void {
    this.appendBlock(text);
  }

  private submit(): void {
    const line = this.buf;
    // Echo the entered turn into the transcript with the prompt label, with a
    // blank spacer above it. This mirrors the spacer drive() puts before the
    // "co ›" turn, so each turn is separated evenly instead of the input line
    // butting straight up against the previous output. We echo the EXPANDED
    // text (chips → full pasted content), matching Claude Code: the input box
    // shows the compact "[Pasted text #1 +43 lines]" chip while editing, but
    // once sent the chat history shows the whole thing the model will see.
    const expanded = this.expandChips(line);
    this.appendBlock("");
    this.appendBlock(this.echoBlock(expanded));
    if (line.trim() !== "") {
      // History keeps the DISPLAY line (chip intact), so ↑ recalls the compact
      // chip; the pastes map persists for the session, so re-submitting still
      // expands it.
      this.history.push(line);
    }
    this.buf = "";
    this.cursor = 0;
    this.histIdx = -1;
    this.draft = "";
    const r = this.pendingResolve;
    this.pendingResolve = null;
    this.scrollToBottom();
    r?.(expanded);
  }

  /**
   * The transcript echo of a submitted turn: the prompt label leads the first
   * line and every continuation line hangs under it, so a multi-line message
   * reads as one block instead of having its second line start hard against the
   * left margin like a new speaker.
   */
  private echoBlock(text: string): string {
    const lines = text.split("\n");
    const indent = " ".repeat(visibleWidth(this.promptLabel));
    return lines
      .map((l, idx) => (idx === 0 ? this.promptLabel + l : indent + l))
      .join("\n");
  }

  /** Clear the input line and reset history browsing (esc-esc). */
  private clearInput(): void {
    this.buf = "";
    this.cursor = 0;
    this.histIdx = -1;
    this.draft = "";
    this.paint();
  }

  private handleData = (data: string): void => {
    // A single data event may batch multiple sequences (e.g. paste). Walk it.
    // Each consume() path repaints when it changes visible state, so we don't
    // force an extra full repaint here.
    let i = 0;
    while (i < data.length) {
      const consumed = this.consume(data, i);
      i += consumed > 0 ? consumed : 1; // never stall on a zero-width parse
    }
  };

  /** Parse one key/sequence starting at `data[i]`. Returns bytes consumed. */
  private consume(data: string, i: number): number {
    // Inside a bracketed paste, bytes are opaque content: accumulate them until
    // the end marker and never parse CSI/keys within (a paste can contain
    // anything, including escape sequences and newlines).
    if (this.pasting) return this.consumePaste(data, i);

    const ch = data[i]!;
    // Any real keystroke dismisses a lingering selection highlight, but mouse
    // reports (ESC [ < ...) must not — they drive the selection itself.
    const isMouse = ch === ESC && data[i + 1] === "[" && data[i + 2] === "<";
    if (!isMouse && this.selection) this.clearSelection();
    // esc-esc clears the input line. Arm on a lone ESC, fire on the next one.
    // Any other key disarms, so clear by default and re-arm only below.
    const wasEscPending = this.escPending;
    this.escPending = false;

    // Start of a bracketed paste. Checked before the generic CSI/ESC dispatch
    // because the marker itself begins with ESC [.
    if (data.startsWith(PASTE_START, i)) {
      this.pasting = true;
      this.pasteBuf = "";
      return PASTE_START.length;
    }

    // Alt+Enter, as sent by terminals that encode Meta as an ESC prefix (and by
    // macOS terminals with "Option as Meta" on). Checked before the generic
    // ESC/CSI dispatch, which would otherwise read it as a lone ESC followed by
    // a bare Enter — i.e. it would SUBMIT, the one thing it must never do.
    if (ch === ESC && (data[i + 1] === "\r" || data[i + 1] === "\n")) {
      this.applyAction({ kind: "newline" }, wasEscPending);
      return 2;
    }

    // --- Escape sequences (CSI) ---
    if (ch === ESC && data[i + 1] === "[") {
      return this.consumeCsi(data, i, wasEscPending);
    }
    // Lone ESC: arm esc-esc; a second consecutive lone ESC clears the input.
    if (ch === ESC) {
      this.applyAction({ kind: "escape" }, wasEscPending);
      return 1;
    }

    this.applyAction(classifyByte(ch), wasEscPending);
    return 1;
  }

  /**
   * Apply a decoded key action to the editor. Every encoding — legacy control
   * bytes, Kitty CSI-u, xterm modifyOtherKeys — lands here, so a binding is
   * defined exactly once no matter how the terminal spelled it.
   *
   * `wasEscPending` is the esc-esc arming state captured by the caller before
   * it was cleared: only another escape consumes it, every other key disarms.
   */
  private applyAction(action: Action, wasEscPending: boolean): void {
    // Ctrl-C's "press again to quit" only counts consecutive presses.
    if (action.kind !== "interrupt") this.sigintCount = 0;

    switch (action.kind) {
      case "insert":
        this.insertText(action.text);
        this.paint();
        return;

      case "newline":
        // Compose, don't send: a literal newline in the buffer. The wrapping
        // and cursor math handle it (see inputRowStarts) and submit() ships the
        // buffer with the newlines intact.
        this.insertText("\n");
        this.scrollToBottom(); // the taller input box must not hide the tail
        return;

      case "submit":
        if (this.pendingResolve) this.submit();
        return;

      case "escape":
        if (wasEscPending) this.clearInput();
        else this.escPending = true;
        return;

      case "interrupt": {
        // First press hints, second within the same idle exits.
        this.sigintCount++;
        if (this.sigintCount >= 2) {
          this.stop();
          process.exit(130);
        }
        this.print(c.dim("(press Ctrl-C again to quit, or type /exit)"));
        return;
      }

      case "eof": {
        // Ctrl-D on an empty buffer: EOF → resolve null (clean exit).
        if (this.buf !== "") return;
        const r = this.pendingResolve;
        this.pendingResolve = null;
        r?.(null);
        return;
      }

      case "backspace": {
        if (this.cursor === 0) return;
        // A chip is atomic: if the cursor sits just past (or within) one, remove
        // the whole chip rather than nibbling its closing bracket.
        const chip = this.chipSpanAt(this.cursor);
        if (chip) {
          this.buf = this.buf.slice(0, chip.start) + this.buf.slice(chip.end);
          this.cursor = chip.start;
        } else {
          this.buf = this.buf.slice(0, this.cursor - 1) + this.buf.slice(this.cursor);
          this.cursor--;
        }
        this.paint();
        return;
      }

      // Ctrl-A/E/U/K operate on the LOGICAL line around the cursor, not the
      // whole buffer: in a multi-line message "start of line" means what it
      // does in any editor, and Ctrl-U can no longer wipe three lines of
      // composition when the user meant to clear one.
      case "home":
        this.cursor = this.lineStart();
        this.paint();
        return;
      case "end":
        this.cursor = this.lineEnd();
        this.paint();
        return;
      case "kill-to-start": {
        const start = this.lineStart();
        this.buf = this.buf.slice(0, start) + this.buf.slice(this.cursor);
        this.cursor = start;
        this.paint();
        return;
      }
      case "kill-to-end":
        this.buf = this.buf.slice(0, this.cursor) + this.buf.slice(this.lineEnd());
        this.paint();
        return;

      case "tab":
        // Accept the ghost command completion when one is showing; else ignore
        // (we never insert literal tabs into the buffer).
        this.acceptGhost();
        return;

      case "none":
        return;
    }
  }

  /** Offset of the start of the logical line the cursor is on. */
  private lineStart(): number {
    // lastIndexOf clamps a negative fromIndex to 0 rather than searching
    // nothing, so a cursor at 0 must short-circuit or a leading "\n" would
    // report a line start of 1 — past the cursor.
    if (this.cursor === 0) return 0;
    return this.buf.lastIndexOf("\n", this.cursor - 1) + 1;
  }

  /** Offset of the end of the logical line the cursor is on (before its "\n"). */
  private lineEnd(): number {
    const nl = this.buf.indexOf("\n", this.cursor);
    return nl === -1 ? this.buf.length : nl;
  }

  /** Insert text at the cursor and advance it. Does not repaint. */
  private insertText(text: string): void {
    this.buf = this.buf.slice(0, this.cursor) + text + this.buf.slice(this.cursor);
    this.cursor += text.length;
  }

  /**
   * Consume bytes while inside a bracketed paste. Everything up to PASTE_END is
   * opaque content; on the end marker we finalize. A data event may end without
   * the marker (a paste split across reads) — we buffer and stay `pasting`.
   * Returns bytes consumed from `data` at `i`.
   */
  private consumePaste(data: string, i: number): number {
    const end = data.indexOf(PASTE_END, i);
    if (end === -1) {
      // No end marker in this chunk: swallow the rest, await the next event.
      this.pasteBuf += data.slice(i);
      return data.length - i;
    }
    this.pasteBuf += data.slice(i, end);
    this.finishPaste();
    return end - i + PASTE_END.length;
  }

  /**
   * Finalize a completed paste. Multi-line content collapses to a chip (the real
   * text stashed for expansion on submit); single-line content is inserted
   * verbatim — normalizing any stray CR so it can't read as Enter. Clears the
   * open history-browse draft state the way a keystroke would.
   */
  private finishPaste(): void {
    const raw = this.pasteBuf;
    this.pasting = false;
    this.pasteBuf = "";
    this.histIdx = -1;

    // Normalize CRLF/CR to LF (a stray \r would otherwise be a literal newline
    // in the buffer, which the editor can't render), then drop a single trailing
    // newline — copying a whole line usually grabs its line break, and that
    // trailing terminator is noise whether the paste is one line or many.
    const text = raw.replace(/\r\n?/g, "\n").replace(/\n$/, "");
    const multiline = text.includes("\n");

    if (multiline) {
      const id = ++this.pasteCounter;
      this.pastes.set(id, text);
      this.insertText(chipFor(id, countLines(text)));
    } else {
      this.insertText(text);
    }
    this.scrollToBottom();
    this.paint();
  }

  /**
   * Expand any paste chips in `line` back to their stored content. Called at
   * submit so the model receives the full pasted text, never the chip label.
   * Unknown ids (e.g. a chip typed by hand) are left as-is.
   */
  private expandChips(line: string): string {
    if (this.pastes.size === 0) return line;
    return line.replace(new RegExp(CHIP_PATTERN, "g"), (match, idStr) => {
      const stored = this.pastes.get(Number.parseInt(idStr, 10));
      return stored ?? match;
    });
  }

  /**
   * If a delete at `pos` would touch a chip (i.e. `pos` falls inside a chip's
   * text, `start < pos <= end`), return that chip's [start, end) span so the
   * caller can remove it whole. A chip is an atomic token: editing its middle
   * would break the marker and silently drop the expansion, so backspace/Delete
   * take the whole thing — matching Claude Code. Returns null when `pos` isn't
   * within any chip.
   */
  private chipSpanAt(pos: number): { start: number; end: number } | null {
    if (this.pastes.size === 0) return null;
    const re = new RegExp(CHIP_PATTERN, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buf)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (pos > start && pos <= end) return { start, end };
    }
    return null;
  }

  /** Handle a CSI sequence (arrows, nav keys, mouse). Returns bytes consumed. */
  private consumeCsi(data: string, i: number, wasEscPending = false): number {
    // Mouse (SGR 1006): ESC [ < b ; x ; y (M|m). The final byte is M for a
    // press/motion and m for a release; we need it to tell drag-end from drag.
    if (data[i + 2] === "<") {
      const end = this.findMouseEnd(data, i + 3);
      if (end === -1) return data.length - i; // incomplete; drop remainder
      const body = data.slice(i + 3, end); // "b;x;y"
      this.handleMouse(body, data[end] === "M");
      return end - i + 1; // include the final M/m
    }

    // Find the final byte of the CSI sequence.
    let j = i + 2;
    while (j < data.length && !/[A-Za-z~]/.test(data[j]!)) j++;
    if (j >= data.length) return data.length - i;
    const final = data[j]!;
    const params = data.slice(i + 2, j);
    const consumed = j - i + 1;

    switch (final) {
      case "u": {
        // Kitty keyboard protocol, CSI-u form: this is where Shift+Enter (and
        // Ctrl+Enter, and Ctrl+J once the protocol is on) actually arrives.
        // A reply to a flag query (`CSI ? <flags> u`) parses as null and is
        // swallowed, so it never leaks into the buffer as text.
        const ev = parseCsiU(params);
        if (ev) this.applyAction(classify(ev), wasEscPending);
        return consumed;
      }
      case "A": // Up → previous input row, else previous history
        if (!this.moveCursorRow(-1)) this.historyPrev();
        return consumed;
      case "B": // Down → next input row, else next history
        if (!this.moveCursorRow(1)) this.historyNext();
        return consumed;
      case "C": // Right — move cursor, or accept a ghost completion at line end
        if (this.cursor < this.buf.length) { this.cursor++; this.paint(); }
        else this.acceptGhost();
        return consumed;
      case "D": // Left
        if (this.cursor > 0) { this.cursor--; this.paint(); }
        return consumed;
      case "H": // Home → start of the current logical line
        this.applyAction({ kind: "home" }, wasEscPending);
        return consumed;
      case "F": // End → end of the current logical line
        this.applyAction({ kind: "end" }, wasEscPending);
        return consumed;
      case "~": {
        // xterm's modifyOtherKeys form, `CSI 27 ; mods ; code ~` — the other way
        // a terminal can report Shift+Enter. We don't turn modifyOtherKeys on
        // ourselves, but iTerm2 and xterm users may already have it enabled, and
        // decoding it costs one branch.
        const other = parseModifyOtherKeys(params);
        if (other) {
          this.applyAction(classify(other), wasEscPending);
          return consumed;
        }
        // PgUp=5, PgDn=6, Home=1/7, End=4/8, Del=3
        const n = Number.parseInt(params, 10);
        if (n === 5) this.scrollBy(-Math.max(1, this.viewportRows() - 1));
        else if (n === 6) this.scrollBy(Math.max(1, this.viewportRows() - 1));
        else if (n === 3) { // Delete (forward)
          if (this.cursor < this.buf.length) {
            // Forward-delete removes the char to the right; a chip starting at
            // the cursor is deleted whole (chipSpanAt uses start<pos<=end, so
            // probe at cursor+1 to catch a chip whose start == cursor).
            const chip = this.chipSpanAt(this.cursor + 1);
            if (chip && chip.start === this.cursor) {
              this.buf = this.buf.slice(0, chip.start) + this.buf.slice(chip.end);
            } else {
              this.buf = this.buf.slice(0, this.cursor) + this.buf.slice(this.cursor + 1);
            }
            this.paint();
          }
        }
        return consumed;
      }
      default:
        // Ctrl-Home / Ctrl-End arrive as ESC[1;5H / ESC[1;5F.
        if (final === "H" || final === "F") return consumed;
        return consumed;
    }
  }

  private findMouseEnd(data: string, from: number): number {
    for (let k = from; k < data.length; k++) {
      if (data[k] === "M" || data[k] === "m") return k;
    }
    return -1;
  }

  /**
   * Handle an SGR mouse report. `body` is "b;x;y" (1-based screen coords) and
   * `press` is true for the M terminator (button-down / motion) vs m (release).
   *
   * The low two bits of `b` are the button (0 = left), bit 5 (32) is the motion
   * flag, bit 6 (64) is the wheel flag. So: 0 = left press, 32 = left drag,
   * 64/65 = wheel up/down. On left press we anchor a selection; on drag we
   * extend its focus; on release we copy the selected text to the clipboard.
   */
  private handleMouse(body: string, press: boolean): void {
    const parts = body.split(";");
    const b = Number.parseInt(parts[0] ?? "", 10);
    const x = Number.parseInt(parts[1] ?? "", 10);
    const y = Number.parseInt(parts[2] ?? "", 10);
    if (Number.isNaN(b)) return;

    // Wheel up = 64, wheel down = 65 (the 64 "wheel" bit set).
    if (b === 64) { this.scrollBy(-3); return; }
    if (b === 65) { this.scrollBy(3); return; }

    const button = b & 0b11;
    const motion = (b & 32) !== 0;

    if (button === 0 && !motion && press) {
      // Left button down: begin a fresh selection anchored at this cell.
      this.beginSelection(x, y);
    } else if (button === 0 && motion && press) {
      // Left drag: extend the selection's focus to the current cell.
      this.extendSelection(x, y);
    } else if (button === 0 && !press) {
      // Left release: finalize. A zero-length selection is just a click, which
      // clears any prior highlight rather than copying an empty string.
      this.endSelection();
    }
  }

  /**
   * Map a 1-based screen (x, y) to an absolute (row, col) in renderedRows().
   * `y` above the transcript viewport or on the input region is clamped into
   * range so a drag that runs off the edge still selects sensibly. Returns null
   * only when there is no transcript at all.
   */
  private mouseToCell(x: number, y: number): { row: number; col: number } | null {
    const vp = this.viewportRows();
    const rowInView = Math.max(0, Math.min(vp - 1, y - 1)); // y is 1-based
    const row = this.lastPaintStart + rowInView;
    const col = Math.max(0, x - 1); // x is 1-based; col is 0-based
    if (this.renderedRows().length === 0) return null;
    return { row, col };
  }

  private beginSelection(x: number, y: number): void {
    const cell = this.mouseToCell(x, y);
    if (!cell) return;
    this.selecting = true;
    this.selection = {
      anchorRow: cell.row,
      anchorCol: cell.col,
      focusRow: cell.row,
      focusCol: cell.col,
    };
    this.paint();
  }

  private extendSelection(x: number, y: number): void {
    if (!this.selecting || !this.selection) return;
    const cell = this.mouseToCell(x, y);
    if (!cell) return;
    // Auto-scroll when the drag reaches the top/bottom edge of the viewport so a
    // selection can span more than one screenful.
    if (y <= 1) this.scrollBy(-1);
    else if (y >= this.viewportRows()) this.scrollBy(1);
    this.selection.focusRow = cell.row;
    this.selection.focusCol = cell.col;
    this.paint();
  }

  private endSelection(): void {
    if (!this.selecting) return;
    this.selecting = false;
    const sel = this.selection;
    // A bare click (press and release on the same cell, no drag) selects
    // nothing: clear any prior highlight and copy nothing.
    const dragged =
      sel != null && (sel.anchorRow !== sel.focusRow || sel.anchorCol !== sel.focusCol);
    const text = dragged ? this.selectionText() : "";
    if (text === "") {
      this.selection = null;
      this.paint();
      return;
    }
    this.copyToClipboard(text);
    const n = countLines(text);
    this.setStatus(`copied ${n} line${n === 1 ? "" : "s"}`);
  }

  // --- input history ---------------------------------------------------------

  private historyPrev(): void {
    if (this.history.length === 0) return;
    if (this.histIdx === -1) {
      this.draft = this.buf;
      this.histIdx = this.history.length - 1;
    } else if (this.histIdx > 0) {
      this.histIdx--;
    }
    this.buf = this.history[this.histIdx] ?? "";
    this.cursor = this.buf.length;
    this.paint();
  }

  private historyNext(): void {
    if (this.histIdx === -1) return;
    if (this.histIdx < this.history.length - 1) {
      this.histIdx++;
      this.buf = this.history[this.histIdx] ?? "";
    } else {
      this.histIdx = -1;
      this.buf = this.draft;
    }
    this.cursor = this.buf.length;
    this.paint();
  }
}
