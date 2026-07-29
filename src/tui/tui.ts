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
 *    The Ctrl-O panel gets the same treatment on its own body: a left-drag over
 *    any panel view highlights and copies, so a paragraph of a doc, a PR link on
 *    the queue tab or a chunk of a filed review all come out the same way. On
 *    top of that a doc has `y`, which copies its RAW markdown rather than the
 *    painted rows - the two answer different questions ("give me this bit of
 *    what I'm looking at" vs "give me that document"), so both exist.
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
  type KeyEvent,
} from "./keys.js";
import {
  TextEditor,
  inputRowStarts,
  joinMessage,
  layoutBuffer,
  scrollToCursor,
  type EditorLayout,
} from "./editor.js";

// The buffer/edit model is shared with the panel's PR message editor; it lives
// in ./editor so both surfaces bind keys to ONE set of editing rules. Re-exported
// because the input-layout tests (and any future caller) have always reached it
// through this module.
export { inputRowStarts };

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

/**
 * Fit `s` into `width` visible columns for a fixed-column layout: unchanged when
 * it already fits, otherwise cut with an ellipsis so the eye can tell a
 * truncated cell from a short one.
 *
 * `width` is an upper bound, not a target — the cut lands on a word boundary
 * where there is one (a truncated intent reads as words, not as a syllable) and
 * hard-splits a word too long to break, which is what a branch name or a handle
 * always is. Callers that need the column filled pad afterwards.
 *
 * ANSI-aware in both directions — it measures visible width, never bytes, and it
 * appends a reset when it cuts a styled string, because a colour opened before
 * the cut and closed after it would otherwise bleed across the rest of the row.
 */
export function clipCell(s: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(s) <= width) return s;
  const cut = sliceVisibleAnsi(s, width - 1);
  return `${cut}…${s.includes(ESC) ? `${ESC}[0m` : ""}`;
}

/** The first `width` visible columns of `s`, ANSI escapes kept where they sit
 *  (unlike sliceVisibleText, which strips them for the clipboard). */
function sliceVisibleAnsi(s: string, width: number): string {
  return wrapLine(s.replace(/\s+/g, " "), Math.max(1, width))[0] ?? "";
}

/** Pad `s` out to `width` VISIBLE columns. The counterpart of clipCell for a
 *  fixed-column layout, and the reason String.padEnd is wrong for any cell that
 *  might carry colour: padEnd counts escape bytes as characters.
 *
 *  Exported with clipCell because they are the whole of the Home tab's column
 *  arithmetic and the only part of it a test can pin: `colorEnabled` is false
 *  under a test runner, so a rendered frame there carries no escapes to get
 *  wrong. These are tested with the escapes written in by hand. */
export function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleWidth(s)));
}

/**
 * Flow `text` after a fixed `lead`, wrapping at word boundaries into rows no
 * wider than `width`, with every continuation row indented to the column the
 * text started in — so a description too long for one line reads as more of the
 * SAME row rather than as new rows of the list.
 *
 * This is the Home tab's answer to text that used to be clipped. Truncation
 * removed the overflow and left the information unreadable, which was the actual
 * complaint; nothing here is ever dropped.
 *
 * `text` is UNSTYLED and `style` colours each row after the wrap. That order
 * matters: a wrap point consumes the space run it breaks on, and a closing SGR
 * reset rides on the character after the text it closes — so wrapping an
 * already-styled string can eat the reset and bleed the colour down the panel.
 */
export function flowRow(
  lead: string,
  text: string,
  width: number,
  style: (s: string) => string = (s) => s,
): string[] {
  const col = visibleWidth(lead);
  const gap = " ".repeat(col);
  return wrapLine(text, Math.max(1, width - col)).map(
    (row, i) => (i === 0 ? lead : gap) + style(row),
  );
}

/**
 * Pack already-styled `tokens` onto rows no wider than `width`, after `lead` on
 * the first row and `indent` columns in on every continuation row. The fallback
 * for a fixed-column row whose columns alone outgrow the terminal (a long branch
 * name on a narrow screen), where the alternative is the painter clipping it.
 *
 * A token is never split at a space, because a styled token is atomic: its
 * closing reset would be dropped with the space run the wrap consumed. A token
 * wider than a whole row is hard-split by visible column instead, which keeps
 * every escape attached to the character it styles.
 */
export function packRow(lead: string, tokens: string[], width: number, indent: number): string[] {
  const hang = " ".repeat(Math.max(0, Math.min(indent, Math.max(0, width - 1))));
  const rows: string[] = [];
  let cur = lead;
  let curW = visibleWidth(lead);
  let bare = true; // no token on this row yet, so no separating space is owed
  for (const tok of tokens.filter((t) => t !== "")) {
    const w = visibleWidth(tok);
    if (!bare && curW + 1 + w > width) {
      rows.push(cur.replace(/\s+$/, ""));
      cur = hang;
      curW = hang.length;
      bare = true;
    }
    if (bare && curW + w > width) {
      // Wider than the row it starts on. Split it at the narrower of the two
      // prefixes so every piece fits under either of them.
      const parts = wrapLine(tok, Math.max(1, width - Math.max(curW, hang.length)));
      for (let p = 0; p < parts.length - 1; p++) rows.push((p === 0 ? cur : hang) + parts[p]!);
      cur = (parts.length > 1 ? hang : cur) + parts[parts.length - 1]!;
      curW = visibleWidth(cur);
      bare = false;
      continue;
    }
    cur += (bare ? "" : " ") + tok;
    curW += (bare ? 0 : 1) + w;
    bare = false;
  }
  rows.push(cur.replace(/\s+$/, ""));
  return rows;
}

/** Where a worktree's description hangs when it will not fit beside the columns:
 *  in past the row's own two-space indent and its marker, so it reads as part of
 *  the row above rather than as a row of its own. */
const WORKTREE_HANG = 6;

/** Count the lines in text, ignoring a single trailing newline. */
function countLines(text: string): number {
  const parts = text.split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

/**
 * The OSC 52 clipboard-write sequence for `text`: `ESC ] 52 ; c ; <base64> BEL`.
 *
 * Terminal-native, so it reaches the system clipboard locally AND through
 * SSH/tmux (given passthrough) with no pbcopy/xclip and no runtime dependency.
 *
 * It is write-only and UNACKNOWLEDGED: nothing comes back, so a terminal with
 * clipboard access switched off (Terminal.app has no OSC 52 at all; iTerm2 and
 * Ghostty gate it behind a setting) drops it in silence and we cannot tell.
 * That is why the callers confirm what they *sent* and name the caveat rather
 * than claiming the clipboard changed.
 */
export function osc52(text: string): string {
  return `${ESC}]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

/**
 * What a copy tells the captain. It names what was SENT, not what landed: OSC 52
 * is unacknowledged, so the moment of the copy is the only place worth spending
 * a footer on the one way it silently fails.
 */
export function copyReceipt(lines: number): string {
  return `copied ${lines} line${lines === 1 ? "" : "s"} · if nothing pastes, allow clipboard access (OSC 52)`;
}

/** A drag's two endpoints, in absolute row + 0-based visible column. */
export interface SelectionRange {
  anchorRow: number;
  anchorCol: number;
  focusRow: number;
  focusCol: number;
}

/**
 * Order a selection's endpoints top-to-bottom so highlight and copy don't care
 * which direction the user dragged. `bottomCol` is exclusive (the column just
 * past the last selected cell), so the cell the drag ended on is included.
 *
 * Shared by the transcript and the panel: two selection surfaces that disagreed
 * about which end was the top would be two different bugs.
 */
export function normalizeSelection(sel: SelectionRange): {
  top: number;
  bottom: number;
  topCol: number;
  bottomCol: number;
} {
  const forward =
    sel.focusRow > sel.anchorRow ||
    (sel.focusRow === sel.anchorRow && sel.focusCol >= sel.anchorCol);
  return forward
    ? { top: sel.anchorRow, bottom: sel.focusRow, topCol: sel.anchorCol, bottomCol: sel.focusCol + 1 }
    : { top: sel.focusRow, bottom: sel.anchorRow, topCol: sel.focusCol, bottomCol: sel.anchorCol + 1 };
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

/**
 * The doc surface the in-session viewer overlay reads through. Injected so the
 * Tui never touches the filesystem itself: session.ts backs this with the same
 * sandboxed doc tool the model uses (listDocs/readDoc over docs/), so the
 * overlay is structurally incapable of listing or reaching the `.memory/`
 * substrate — it can only ever name a file the sandbox already vetted.
 *
 * `subscribe` wires the overlay to the serialized memory write queue: the
 * listener fires with the bare doc filename after a completed write, which is
 * how the view refreshes live when an agent edits the doc on screen.
 */
export interface DocSource {
  /** Every doc in docs/, sorted. Never includes anything under `.memory/`. */
  list(): Promise<string[]>;
  /** One doc's full text by bare filename. Throws if it can't be read. */
  read(name: string): Promise<string>;
  /** Subscribe to doc-write events; returns an unsubscribe function. */
  subscribe(listener: (name: string) => void): () => void;
}

/**
 * One feature's place in the merge queue, as the panel shows it. Structurally a
 * subset of the session's QueueEntryView — declared here (rather than imported)
 * so the low-level Tui never depends on the session layer, the same way
 * LandingPrepared mirrors the engine's prepare result. The session's real view
 * is assignable to this.
 */
export interface QueuePanelEntry {
  feature: string;
  /** 1-based landing position (1 is the head). */
  position: number;
  isHead: boolean;
  status: "queued" | "head-processing" | "awaiting-checks" | "ready" | "blocked" | "resolving";
  /** Commits awaiting merge on a ready head. */
  commitsReady?: number;
  /** Present on a ready head whose PR reported no CI checks: mergeable, but
   *  nothing verified it. Rendered, never swallowed. */
  ungated?: boolean;
  /** Present when awaiting-checks: how many checks are still running. */
  checksPending?: number;
  /** Present when blocked: the human-readable reason. */
  blockedReason?: string;
  /** Present when blocked: conflict vs a red CI check. */
  blockedKind?: "conflict" | "failed";
  /** Resolver attempts spent so far on this head. */
  resolveAttempts?: number;
}

/** The whole merge queue in landing order, for the panel's queue view. */
export interface QueuePanelView {
  size: number;
  head: QueuePanelEntry | null;
  entries: QueuePanelEntry[];
}

/**
 * The head's inline body on the queue tab: what pressing [m] would land, or why
 * there is no [m] (D-20260724-12). Structurally the session's QueueHeadDetail —
 * declared here, like QueuePanelEntry, so the Tui never depends on the session
 * layer.
 */
export type QueueHeadDetail =
  | {
      kind: "ready";
      feature: string;
      /** The integration branch the PR merges into (e.g. "dev"). */
      target: string;
      /** The per-job commits the merge preserves, oldest first. */
      commits: string[];
      /** What the PR's own CI checks said: the merge's evidence, including the
       *  ungated case (no checks at all). */
      checks?: PanelChecks;
      /** The open pull request [m] merges — its message shown inline, so the
       *  captain reads what will land where the key that lands it lives. The
       *  patch itself is on GitHub (that is where they can comment on it). */
      pr?: PanelPullRequest;
    }
  | {
      kind: "awaiting";
      feature: string;
      target: string;
      commits: string[];
      /** The last read: which checks are still running. */
      checks?: PanelChecks;
      pr?: PanelPullRequest;
    }
  | {
      kind: "blocked";
      feature: string;
      target: string;
      blockedKind?: "conflict" | "failed";
      reason: string;
      /** conflict: the unmerged paths and git's own account of the failing step. */
      conflictFiles?: string[];
      detail?: string;
      /** failed: the checks read, so the panel can name what went red and link
       *  the run that says why. */
      checks?: PanelChecks;
      pr?: PanelPullRequest;
      resolveAttempts?: number;
      maxResolveAttempts?: number;
    };

/**
 * The head's pull request as the panel paints it. Structurally the session's
 * HeadPullRequest — declared here, like QueuePanelEntry, so the Tui never
 * depends on the session layer.
 *
 * `title` + `prose` ARE the composed message the PR carries (D-20260727-10); the
 * Tui never derives either. `prose` is the description with co's fenced evidence
 * block already removed by the source, because those markers are HTML comments
 * GitHub hides and a terminal would print, and what is inside them is the checks
 * and commits this view already renders from `checks`/`commits`. A source that
 * doesn't split falls back to the raw `body`, which is what the panel painted
 * before there was anywhere to split it.
 */
export interface PanelPullRequest {
  number: number;
  url: string;
  title: string;
  body: string;
  prose?: string;
}

/**
 * What a panel-driven edit of the head PR's message did (D-20260727-15). The
 * saved title and prose come back FROM the forge — the session re-reads the pull
 * request after writing it — so the panel repaints from what GitHub stored
 * rather than from the buffer the captain typed.
 */
export interface PrMessageSaveResult {
  saved: boolean;
  /** One line for the queue tab to carry after the popup closes. */
  summary: string;
  /** Present when nothing was written: why. The popup stays open over it. */
  error?: string;
}

/** What a panel-driven merge did, for the flash line. Rejection of the promise
 *  is handled too, so a thrown callback can't wedge the panel mid-merge. */
export interface QueueMergeResult {
  merged: boolean;
  /** One line to flash on the separator when it settles. */
  summary: string;
  /** Present when nothing merged: why. */
  error?: string;
}

/**
 * Backs the Ctrl-O panel's live merge-queue view. Read on demand at paint time
 * (the queue is an in-memory snapshot, so re-reading is cheap and always fresh),
 * so no subscription is needed: every tool turn and dispatch completion already
 * triggers a repaint, which re-reads the queue. Injected like DocSource so the
 * Tui never reaches into the engine.
 *
 * `headDetail` + `merge` are what make the queue tab PANEL-NATIVE: the tab shows
 * the ready head's PR and checks inline and offers a live [m] that merges
 * it directly through `merge`, with no co tool call anywhere in the loop and
 * nothing blocked waiting on the keystroke. Both are optional so a bare list
 * source (and every existing test that injects one) still works — without
 * `merge` the tab is read-only and no [m] is ever offered.
 */
export interface QueuePanelSource {
  view(): QueuePanelView;
  /** The head's inline body, or null when the head has none (empty queue, or a
   *  head still processing / being resolved). */
  headDetail?(): QueueHeadDetail | null;
  /**
   * Merge the ready head. Called ONLY from the [m] keystroke over a head the
   * source itself reports `ready`, at most once at a time (the panel holds a
   * fire-once interlock while it is in flight). Resolves when the merge has
   * landed AND the queue has advanced, so the next paint shows the new head.
   */
  merge?(): Promise<QueueMergeResult>;
  /**
   * Write a new title and description onto the head's pull request — the `e`
   * editor's save (D-20260727-15). Called ONLY from Ctrl-S in that popup, at
   * most once at a time (the popup locks while it is in flight).
   *
   * `body` is PROSE ONLY: the popup never loads co's fenced evidence block and
   * never sends one, and the implementation splices the existing block back
   * around this text. Saving merges nothing and changes no queue state.
   * Absent (like `merge`) means the tab is read-only and `e` is refused.
   *
   * `prNumber` is the pull request the popup was OPENED on. It is a pin, not a
   * lookup: if the head has moved on since (a resolver finished and re-prepared
   * it), the save must fail rather than stamp one PR's message onto another.
   */
  editPrMessage?(message: {
    title: string;
    body: string;
    prNumber: number;
  }): Promise<PrMessageSaveResult>;
}

/**
 * One filed crew review, as the panel's Inbox tab shows it. Structurally a subset
 * of the session's ReviewRecord — declared here rather than imported, like
 * QueuePanelEntry, so the low-level Tui never depends on the session layer. The
 * session's real record is assignable to this.
 */
export interface InboxPanelEntry {
  /** How loudly it landed in the chat when filed: L1 needs a decision, L2 got a
   *  pointer line, L3 was silent. */
  level: "L1" | "L2" | "L3";
  verdict: "accept" | "fix-commit" | "rework";
  /** The one-line summary the list row shows. */
  headline: string;
  /** The full review, shown only in the drill-in. */
  body: string;
  /** ISO 8601 filing time. */
  timestamp: string;
  jobId: string;
  feature?: string;
}

/**
 * Backs the Ctrl-O panel's Inbox tab. Read on demand at paint time, exactly like
 * QueuePanelSource: the store is an in-memory capped list behind a JSON file, so
 * re-reading is cheap and always current, and every filing already triggers a
 * repaint. Injected so the Tui never touches the store or the filesystem.
 */
export interface InboxPanelSource {
  /** The stored reviews, newest first. */
  list(): InboxPanelEntry[];
}

/** Where a tracked feature stands, in one word. Structurally the session's
 *  FeatureActivity — declared here, like QueuePanelEntry, so the low-level Tui
 *  never depends on the session layer. The queue spellings are shared with
 *  QueuePanelEntry's statuses so the two tabs never disagree about a feature
 *  that appears in both. */
export type FeaturePanelStatus =
  | "working"
  | "idle"
  | "queued"
  | "processing"
  | "ready"
  | "blocked"
  | "resolving"
  | "provisioning"
  | "failed"
  | "removed";

/**
 * One tracked feature worktree, as the panel's Home tab shows it: what it is,
 * what is happening to it, and which branch it lives on. Structurally a subset
 * of the session's FeatureOverview.
 */
export interface FeaturePanelEntry {
  /** The feature handle (its created name, or its slug after a restart rebuilt
   *  the record from the worktree on disk). */
  feature: string;
  /** The feature's branch, always `co/feat-<slug>`. */
  branch: string;
  /** The stored one-line description, when the feature has one. A feature
   *  created without an intent renders a placeholder instead. */
  intent?: string;
  status: FeaturePanelStatus;
  /** Whether a crew agent is running or queued in the worktree — shown even when
   *  the status chip is saying something else (a queue position, say). */
  busy: boolean;
  /** 1-based landing position, when the feature is in the merge queue. */
  position?: number;
  /** Present when blocked: conflict vs red build+test. */
  blockedKind?: "conflict" | "failed";
  /** Whether the worktree holds uncommitted changes, when that has been read.
   *  UNDEFINED means nobody has looked — rendered as the plain state word, never
   *  as clean, because "nothing to commit" is a claim and this would not be
   *  evidence for it. Refreshed through the source's `refresh()`. */
  dirty?: boolean;
}

/**
 * Backs the Home tab's worktree list: EVERY tracked feature worktree, not just
 * the ones queued to land. Read fresh at paint time like the queue and the
 * inbox — the session derives it from in-memory state (registry records, jobs,
 * the queue snapshot, the stored intents), so re-reading costs nothing and
 * involves no git call, no filesystem read and no model call. Injected, so the
 * Tui never reaches into the feature layer itself.
 */
export interface FeaturePanelSource {
  /** Every tracked feature, in the order the tab lists them (the session sorts:
   *  closest-to-landing first, then the rest alphabetically). */
  list(): FeaturePanelEntry[];
  /**
   * Re-read whatever `list()` cannot derive for free — today the dirty flag,
   * which costs one `git status` per worktree. Called when the captain opens or
   * switches to the Home tab, NEVER on a paint, and the panel repaints when it
   * resolves. Optional: a source without it simply reports no dirty state.
   */
  refresh?(): Promise<void>;
}

/** One row of the co's at-a-glance task table, as the Home tab paints it.
 *  Structurally the session's TaskRow — declared here, like QueuePanelEntry, so
 *  the low-level Tui never depends on the session layer. */
export interface TaskPanelRow {
  task: string;
  type: string;
  /** One word, by the co's own protocol. Nothing here enforces a vocabulary. */
  status: string;
}

/**
 * Backs the Home tab's task table. Read fresh at paint time like every other
 * panel source — it is an in-memory list behind a small JSON file, so re-reading
 * is free and a table the co rewrote mid-session shows on the next paint without
 * a restart or a subscription.
 */
export interface TaskPanelSource {
  /** The table, in the co's own order. */
  list(): TaskPanelRow[];
}

/**
 * What the landing gate reviews and does - the Ctrl-O overlay's third mode,
 * opened programmatically via openLandingReview when a prepared feature awaits
 * the human's verdict. Injected like DocSource so the Tui never touches git
 * itself: `execute` is the ONLY path to the merge, and the Tui calls it at
 * most once, solely from the [m] keystroke over a mergeable prepare. There is
 * no automatic path.
 */
export interface LandingReview {
  /** Feature name, shown in the header bar. */
  feature: string;
  /** The integration branch the merge would write (e.g. "dev"). */
  target: string;
  /** The prepare outcome under review. Only "green" is mergeable. */
  prepared: LandingPrepared;
  /**
   * Perform the gated merge. Resolves with a one-line confirmation to flash;
   * rejects with the refusal/failure (e.g. a stale green), which the gate
   * surfaces in place. Called at most once per review.
   */
  execute(): Promise<string>;
}

/** A prepare outcome shaped for display. The session layer maps the landing
 *  engine's result onto this, so the Tui stays free of git types. */
export type LandingPrepared =
  | {
      kind: "green";
      commits: string[];
      diff: string;
      /** The pull request [m] would merge, when the prepare opened one. */
      pr?: { number: number; url: string; title: string };
    }
  | { kind: "conflict"; conflictFiles: string[]; detail: string }
  | { kind: "failed"; reason: string; checks?: PanelChecks }
  | { kind: "pending"; reason: string; checks?: PanelChecks };

/**
 * What a pull request's CI checks said, as the panel shows it. Structurally the
 * session's ChecksSummary — declared here, like QueuePanelEntry, so the Tui never
 * depends on the session layer. `ungated` is the one field that must never be
 * rendered as an ordinary green: it means the PR reported NO checks at all, so
 * nothing verified the merge but the captain.
 */
export interface PanelChecks {
  verdict: "passed" | "failed" | "pending" | "none";
  ungated: boolean;
  requiredOnly: boolean;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
  runs: { name: string; bucket: string; link?: string }[];
  ms: number;
  timedOut?: boolean;
}

/** How a landing review ended: the human merged, declined, or dismissed a
 *  review whose merge attempt was refused. Only "merged" moved anything. */
export type LandingGateOutcome = "merged" | "rejected" | "failed";

/**
 * Render a whole markdown document to visual rows through the SAME renderer the
 * transcript uses, so the overlay looks identical to inline output. Tables are
 * laid out from their raw form at `width` (never word-wrapped), honoring the
 * resize re-layout rule; everything else wraps at word boundaries.
 */
export function renderMarkdownDoc(content: string, width: number): string[] {
  const md = new MarkdownRenderer();
  const out: string[] = [];
  const push = (e: Rendered): void => {
    if (e.kind === "table") out.push(...renderTable(e.table, width));
    else out.push(...(e.text === "" ? [""] : wrapLine(e.text, width)));
  };
  for (const l of content.split("\n")) {
    for (const e of md.feed(l, width)) push(e);
  }
  for (const e of md.flushBlock(width)) push(e);
  return out;
}

/** The coloured level chip for a filed review: L1 wants a decision, L2 is a
 *  pointer, L3 was clean. Fixed width, so the list columns line up. */
function levelChip(level: InboxPanelEntry["level"]): string {
  switch (level) {
    case "L1": return c.yellow("[L1]");
    case "L2": return c.cyan("[L2]");
    case "L3": return c.green("[L3]");
  }
}

/** The date part of an ISO timestamp, minute precision, for the review header.
 *  Falls back to the raw string so a hand-written record still shows something. */
function shortStamp(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}

/**
 * One filed review as visual rows: headline, a metadata line (level, verdict,
 * job, feature, when), then the full body through the SAME markdown renderer the
 * transcript and the doc viewer use — the body is prose the co wrote, so it reads
 * identically wherever it appears.
 */
export function renderInboxItem(entry: InboxPanelEntry, width: number): string[] {
  // The two header lines carry a two-space indent, so they are wrapped INSIDE it
  // and the indent re-applied to each row: wrapping drops a leading space run
  // (wrap.ts), which would otherwise leave a long headline flush against the
  // edge while the metadata line under it stayed indented.
  const indented = (s: string): string[] =>
    wrapLine(s, Math.max(1, width - 2)).map((r) => "  " + r);
  const meta = [
    entry.verdict,
    entry.jobId,
    ...(entry.feature ? [`feature ${entry.feature}`] : []),
    ...(entry.timestamp ? [shortStamp(entry.timestamp)] : []),
  ].join(" · ");
  return [
    "",
    ...indented(c.bold(entry.headline)),
    ...indented(levelChip(entry.level) + " " + c.dim(meta)),
    "",
    ...renderMarkdownDoc(entry.body, width),
  ];
}

/** Style one raw patch line the way git colours a diff. The file-header lines
 *  are checked before the +/- content lines, which they'd otherwise match. */
function colorDiffLine(l: string): string {
  if (
    l.startsWith("diff --git") ||
    l.startsWith("index ") ||
    l.startsWith("+++") ||
    l.startsWith("---")
  ) {
    return c.bold(l);
  }
  if (l.startsWith("@@")) return c.cyan(l);
  if (l.startsWith("+")) return c.green(l);
  if (l.startsWith("-")) return c.red(l);
  return l;
}

/** Files touched by a patch, counted from its per-file headers. */
function diffFileCount(diff: string): number {
  let n = 0;
  for (const l of diff.split("\n")) if (l.startsWith("diff --git ")) n++;
  return n;
}

/**
 * Render the landing review's body to visual rows: a summary (commit list,
 * changed-file count) followed by the full diff, every line wrapped so nothing
 * is clipped out of a review. A conflict/failed prepare renders its reason
 * instead - there is no tested state to diff, so there is nothing to merge. A
 * failed merge attempt (status "failed") banners its error at the top.
 */
function renderLandingBody(
  review: LandingReview,
  status: "review" | "merging" | "failed",
  error: string | null,
  width: number,
): string[] {
  const wrap = (s: string): string[] => (s === "" ? [""] : wrapLine(s, width));
  const rows: string[] = [""];
  if (status === "failed") {
    rows.push(...wrap("  " + c.red(`merge failed: ${error ?? "unknown error"}`)));
    rows.push("");
  }
  const p = review.prepared;
  if (p.kind === "conflict") {
    rows.push(...wrap("  " + c.yellow(`rebase onto ${review.target} hit conflicts; there is no tested state to merge`)));
    rows.push("");
    rows.push(...wrap("  conflicted paths:"));
    for (const f of p.conflictFiles) rows.push(...wrap("    " + c.red(f)));
    rows.push("");
    for (const l of p.detail.split("\n")) rows.push(...wrap("  " + c.dim(l)));
    return rows;
  }
  if (p.kind === "failed" || p.kind === "pending") {
    const head =
      p.kind === "failed"
        ? c.red(`the pull request's CI checks failed; there is nothing green to merge`)
        : c.yellow(`the pull request's CI checks have not reported yet; there is nothing to merge yet`);
    rows.push(...wrap("  " + head));
    rows.push("");
    rows.push(...wrap("  " + (p.kind === "failed" ? c.red(p.reason) : c.yellow(p.reason))));
    if (p.checks) {
      rows.push("");
      for (const l of checkRunRows(p.checks)) rows.push(...wrap("  " + l));
    }
    return rows;
  }
  const files = diffFileCount(p.diff);
  const summary =
    `${p.commits.length} commit${p.commits.length === 1 ? "" : "s"} · ` +
    `${files} file${files === 1 ? "" : "s"} changed`;
  rows.push(...wrap("  " + c.bold(summary)));
  if (p.pr) {
    // The merge is the PR's, so name it: [m] here presses `gh pr merge --merge`.
    rows.push(...wrap("  " + c.cyan(`PR #${p.pr.number}`) + " " + p.pr.title));
    rows.push(...wrap("  " + c.dim(p.pr.url)));
  }
  rows.push("");
  if (p.commits.length === 0) {
    rows.push(...wrap("  " + c.yellow(`no commits beyond ${review.target}; nothing to land`)));
    return rows;
  }
  for (const cl of p.commits) {
    const sp = cl.indexOf(" ");
    const styled = sp === -1 ? c.dim(cl) : c.dim(cl.slice(0, sp)) + " " + cl.slice(sp + 1);
    rows.push(...wrap("  " + styled));
  }
  if (p.diff !== "") {
    rows.push("");
    rows.push(...wrap(c.dim(`── diff vs ${review.target} ──`)));
    rows.push("");
    for (const l of p.diff.split("\n")) rows.push(...wrap(colorDiffLine(l)));
  }
  return rows;
}

/**
 * A checks result as one phrase — the line that replaced "build+test green" when
 * the gate became GitHub's (D-20260727-1). The ungated case gets its OWN wording
 * rather than a green one: "no CI checks" is not a pass, it is the absence of a
 * gate, and the captain has to see the difference at a glance.
 */
function checksPhrase(checks: PanelChecks | undefined): string {
  if (!checks) return "checks: not reported";
  const scope = checks.requiredOnly ? "required check" : "check";
  const plural = (n: number): string => (n === 1 ? scope : `${scope}s`);
  switch (checks.verdict) {
    case "none":
      return "no CI checks on this pull request; nothing verified it but you";
    case "passed":
      return `checks green · ${checks.total} ${plural(checks.total)} passed${
        checks.skipped > 0 ? ` (${checks.skipped} skipped)` : ""
      }`;
    case "failed":
      return `checks RED · ${checks.failed} of ${checks.total} ${plural(checks.total)} failed`;
    case "pending":
      return `checks pending · ${checks.pending} of ${checks.total} ${plural(checks.total)} still running${
        checks.timedOut ? " (co stopped waiting)" : ""
      }`;
  }
}

/** One row per check that is not simply passing, with its run link. What a
 *  captain (or a resolver) needs in order to act, without leaving the panel. */
function checkRunRows(checks: PanelChecks | undefined): string[] {
  const rows: string[] = [];
  for (const r of checks?.runs ?? []) {
    if (r.bucket === "pass" || r.bucket === "skipping") continue;
    const mark = r.bucket === "fail" || r.bucket === "cancel" ? c.red("✗") : c.yellow("…");
    rows.push(`  ${mark} ${r.name}${r.link ? " " + c.dim(r.link) : ""}`);
  }
  return rows;
}

/**
 * The queue head's inline body (D-20260724-12): everything the captain needs to
 * decide the [m] that sits right there in the same view.
 *
 * A READY head renders the PULL REQUEST it would merge (D-20260724-13) in two
 * blocks, deliberately separated:
 *
 *   1. THE EVIDENCE — the PR's number and URL and what its CI checks said. This
 *      is the gate, so it leads and stays near the [m].
 *   2. THE MESSAGE (D-20260727-10) — under its own rule: the PR's title, its
 *      description prose, and the commits it carries. This is what the merge
 *      ACCOMPLISHES, which is the other half of the decision and the half the
 *      panel used to bury in a raw body dump.
 *
 * The message is rendered, not echoed: the prose goes through the same markdown
 * renderer the transcript and the doc viewer use, so it reads on screen the way
 * it reads on GitHub. The patch is still not repeated here — it lives at that
 * URL, which is also where the captain edits the message or comments on it
 * before pressing [m].
 *
 * An AWAITING head renders the same two blocks, with what it is still waiting on
 * in place of a verdict — its PR exists and says what it will land, and the only
 * missing thing is CI. A BLOCKED head renders why it cannot merge (and offers no
 * [m] anywhere): the conflicted paths and git's account, or the checks that went
 * red with links to their runs. Every line is wrapped, so nothing is clipped out
 * of a merge decision.
 *
 * The one rendering rule that carries weight: a ready head whose PR reported NO
 * checks is drawn in YELLOW as UNGATED, never in green. co had nothing to verify
 * it with, and the captain's [m] is the only gate — that has to look different
 * from a real green (D-20260727-1).
 */
export function renderQueueHeadDetail(detail: QueueHeadDetail, width: number): string[] {
  const wrap = (s: string): string[] => (s === "" ? [""] : wrapLine(s, width));
  const rows: string[] = [""];
  rows.push(...wrap(c.dim(`── head · ${detail.feature} → ${detail.target} ──`)));
  rows.push("");

  if (detail.kind === "blocked") {
    const kind =
      detail.blockedKind === "conflict"
        ? "rebase conflict"
        : detail.blockedKind === "failed"
          ? "failed CI checks"
          : "not mergeable";
    rows.push(...wrap("  " + c.red(c.bold(`BLOCKED (${kind})`)) + " " + c.dim("— no [m] on this head")));
    rows.push(...wrap("  " + c.red(detail.reason)));
    if (detail.conflictFiles && detail.conflictFiles.length > 0) {
      rows.push("");
      rows.push(...wrap("  conflicted paths:"));
      for (const f of detail.conflictFiles) rows.push(...wrap("    " + c.red(f)));
    }
    if (detail.checks) {
      rows.push("");
      rows.push(...wrap("  " + c.dim(checksPhrase(detail.checks))));
      for (const l of checkRunRows(detail.checks)) rows.push(...wrap("  " + l));
      if (detail.pr) rows.push(...wrap("  " + c.dim(detail.pr.url)));
    }
    if (detail.detail) {
      rows.push("");
      for (const l of detail.detail.split("\n")) rows.push(...wrap("  " + c.dim(l)));
    }
    return rows;
  }

  const pr = detail.pr;
  rows.push(
    ...wrap(
      "  " +
        c.bold(pr ? `PR #${pr.number} → ${detail.target}` : `${detail.feature} → ${detail.target}`) +
        c.dim(` · ${detail.commits.length} commit${detail.commits.length === 1 ? "" : "s"}`),
    ),
  );
  if (pr) rows.push(...wrap("  " + c.dim(pr.url)));
  if (detail.kind === "awaiting") {
    rows.push(...wrap("  " + c.yellow("WAITING on CI") + " " + c.dim("— no [m] until the checks report")));
    rows.push(...wrap("  " + c.yellow(checksPhrase(detail.checks))));
    for (const l of checkRunRows(detail.checks)) rows.push(...wrap("  " + l));
  } else if (detail.checks?.ungated) {
    rows.push(...wrap("  " + c.yellow(c.bold("UNGATED")) + " " + c.yellow(checksPhrase(detail.checks))));
    rows.push(...wrap("  " + c.dim("[m] merges it on your judgment alone — read the PR before you press it.")));
  } else {
    rows.push(...wrap("  " + c.green(checksPhrase(detail.checks))));
  }
  rows.push(...renderPrMessage(pr, detail.commits, detail.target, width));
  return rows;
}

/**
 * The pull request's own message, as the panel shows it back (D-20260727-10):
 * the title, the description prose, and the commits it carries — under a rule of
 * its own, so it never reads as more checks evidence.
 *
 * Nothing here is composed. The title and prose come off the PR (landing.ts
 * composed them; the captain may have rewritten them since on GitHub), and the
 * commit list is the same array the merge preserves. The prose is painted
 * through renderMarkdownDoc — the renderer the transcript, the doc viewer and a
 * filed review all use — so a description reads the same wherever it appears,
 * and it is the prose ONLY: the source strips co's evidence fence, whose checks
 * and commits are already drawn above and beside this.
 */
function renderPrMessage(
  pr: PanelPullRequest | undefined,
  commits: string[],
  target: string,
  width: number,
): string[] {
  const wrap = (s: string): string[] => (s === "" ? [""] : wrapLine(s, width));
  const rows: string[] = [""];
  // No PR (a source that carries none) means no message to show — the commits
  // still are what would land, so they render on their own rather than under a
  // rule announcing a pull request that isn't there.
  if (pr) {
    rows.push(...wrap(c.dim("── pull request ──")), "");
    rows.push(...wrap("  " + c.bold(pr.title)));
    const prose = (pr.prose ?? pr.body).trim();
    if (prose === "") {
      rows.push(...wrap("  " + c.dim("(no description)")));
    } else {
      rows.push("");
      // Indented by the same two columns as everything else in this body; the
      // renderer lays the prose out inside what that leaves.
      for (const r of renderMarkdownDoc(prose, Math.max(20, width - 2))) {
        rows.push(r === "" ? "" : "  " + r);
      }
    }
    rows.push("");
  }
  if (commits.length === 0) {
    rows.push(...wrap("  " + c.yellow(`no commits beyond ${target}; nothing to land`)));
    return rows;
  }
  rows.push(...wrap("  " + c.dim(`commits (${commits.length})`)));
  for (const cl of commits) {
    const sp = cl.indexOf(" ");
    const styled = sp === -1 ? c.dim(cl) : c.dim(cl.slice(0, sp)) + " " + cl.slice(sp + 1);
    rows.push(...wrap("    " + styled));
  }
  return rows;
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
  /**
   * Backs the Ctrl-O panel's doc surface. Omit to disable the feature (the
   * keybinding then flashes a hint instead of opening). session.ts always
   * supplies one bound to the instance's docs/.
   */
  docs?: DocSource;
  /**
   * Backs the Ctrl-O panel's live merge-queue view. Omit off the feature flow
   * (unlinked, or PlainIO); the panel then shows only docs. session.ts supplies
   * one bound to the FeatureManager's queue when linked.
   */
  queue?: QueuePanelSource;
  /**
   * Backs the Ctrl-O panel's Inbox tab (the rolling crew-review record). Omit to
   * drop the tab. session.ts always supplies one bound to the instance's review
   * inbox, linked or not: reviews outlive a link and a filed review must still be
   * readable afterwards.
   */
  inbox?: InboxPanelSource;
  /**
   * Backs the Home tab's worktree list (every tracked feature worktree). Omit
   * off the feature flow (unlinked, or PlainIO) and Home says so where the list
   * would be; session.ts supplies one bound to the FeatureManager when linked.
   */
  features?: FeaturePanelSource;
  /**
   * Backs the Home tab's task table. Omit and Home says the table is unavailable;
   * session.ts always supplies one bound to the instance's task store, linked or
   * not — the table is the co's own and needs no repo.
   */
  tasks?: TaskPanelSource;
}

/**
 * A bounded, ephemeral animation played in its own fixed-height region just
 * above the input bar — the mechanism behind the dispatch flourish and the exit
 * ship. The Tui owns WHEN it draws; visuals.ts owns WHAT it draws.
 *
 * `render` is called with the CURRENT width on every frame (and on every repaint
 * in between), which is what makes the region resize-safe: a SIGWINCH mid-flight
 * simply re-renders at the new width instead of leaving a torn frame. It must
 * always return exactly `rows` rows, because the region's height is subtracted
 * from the transcript viewport and a wobbling height would make the whole screen
 * jump.
 */
export interface AnimationSpec {
  /** Rows for frame `n` at `cols` columns. Must return exactly `rows` entries. */
  render(frame: number, cols: number): string[];
  /** Fixed height of the region, in screen rows. */
  rows: number;
  /** Total frames; the animation ends itself after the last one. Omit to run
   *  until the caller stops it (used by the open-ended dispatch flourish). */
  frames?: number;
  /** Frame budget. ~10-12fps is the house speed: enough to read as motion,
   *  cheap enough that it never competes with a repaint. */
  intervalMs?: number;
  /** Floor on how long the region stays up, honored by settle() only. Keeps a
   *  flourish from flickering past when the work it covers finishes instantly. */
  minDurationMs?: number;
}

/** A running animation. Every method is safe to call more than once. */
export interface AnimationHandle {
  /** False when nothing is animating (degraded context, or the Tui refused).
   *  Callers use it to skip any wait they'd otherwise do for the animation. */
  readonly animating: boolean;
  /** End it now and clear the region. Use where a wait would delay real work. */
  stop(): void;
  /** End it, but not before `minDurationMs` has elapsed. Resolves once cleared;
   *  resolves immediately when nothing is animating. */
  settle(): Promise<void>;
}

/** The handle handed back when there is nothing to animate. */
export const NO_ANIMATION: AnimationHandle = {
  animating: false,
  stop: () => {},
  settle: () => Promise.resolve(),
};

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
  /**
   * Resolve a pending question() with a private sentinel WITHOUT losing the
   * user's half-typed input. Used to hand control back to the session loop when
   * an out-of-band event needs a turn (a finished dispatch wanting a review).
   * No-op if nothing is waiting on input. Returns true if a waiter was woken.
   */
  wake(reason: string): boolean;
  /**
   * Show or clear the armed-dispatch confirm banner (order preview + resolved
   * command + confirm hint) just above the input bar. Null clears it. On the
   * plain non-TTY path this is a no-op — the banner is printed inline instead.
   */
  setConfirmBanner(lines: string[] | null): void;
  /**
   * Play a bounded animation in an ephemeral region above the input bar. Returns
   * a live handle, or NO_ANIMATION when this IO can't animate (PlainIO always;
   * the Tui while a stream is open, the panel is up, or the screen is too small)
   * — so a caller never has to ask permission first, it just checks `animating`.
   * Purely decorative: the caller always writes its own static line as well.
   */
  playAnimation(spec: AnimationSpec): AnimationHandle;
}

/**
 * The sentinel question() resolves with when wake() is called. The session loop
 * recognizes it, runs any pending out-of-band work, then re-prompts — the user's
 * draft input is preserved by the TUI across the wake, so they never lose a
 * half-typed line to a background completion.
 */
export const WAKE_SENTINEL = " co-wake ";

/**
 * Spinner frames for the busy indicator: Claude Code's pulsing asterisk. The
 * glyphs run small → large and then back down, so the star breathes rather than
 * snapping from full size to a dot. The bounce is baked into the array (the two
 * endpoints appear once) instead of being computed, so the cycle is just an
 * index step.
 */
const BUSY_FRAMES = ["·", "✢", "✳", "∗", "✻", "✽", "✻", "∗", "✳", "✢"];
const BUSY_TICK_MS = 120;

/**
 * Frame budget for coalesced repaints (~60fps). Long enough to collapse a burst
 * of streamed token deltas into one write, short enough that typing still feels
 * instant.
 */
const PAINT_INTERVAL_MS = 16;

/**
 * Default frame budget for the decorative visual region: ~11fps. Deliberately an
 * order of magnitude slower than the repaint budget — the region is scenery
 * played during an idle wait, and a full frame per tick is the cost. Anything
 * faster buys no legibility on wave/ship motion and just competes with the work
 * the animation is covering for.
 */
const VISUAL_TICK_MS = 90;

/** Below this width the region can't hold a legible band and a branch label, so
 *  the animation is refused and the caller's static line stands alone. */
const VISUAL_MIN_COLS = 40;

/** Screen rows that must survive OUTSIDE the region (transcript + rule + input)
 *  for it to be worth drawing. A tall region on a short terminal would squeeze
 *  the conversation to nothing, which is a worse trade than no animation. */
const VISUAL_MIN_FREE_ROWS = 8;

/**
 * Single-key selectors for the doc and inbox lists. No arrow key is ever
 * required — pressing the label beside a row opens it. Paging commands
 * (f/b/d/u/j/k/g/G) don't appear as list labels, so nothing collides.
 *
 * TWO keys are deliberately absent, on the same rule: a key the panel reserves
 * GLOBALLY can never be a label, because a row wearing it could never be opened.
 * `i` is the second spelling of Tab (D-20260724-9). The DIGITS are the tab bar's
 * direct jumps — `1`..`4` land on a tab from any view — which is why this
 * alphabet starts at `a` rather than at `1` as it once did. Dropping them keeps
 * every row reachable (the list is 25 labels deep, and both lists say so when
 * they outgrow it) instead of leaving dead labels a captain would press first.
 */
const OVERLAY_LABELS = "abcdefghjklmnopqrstuvwxyz";

/**
 * The persistent Ctrl-O panel (D-20260723-25): the non-modal home for BOTH the
 * user-facing docs AND the live merge queue. Unlike the old modal doc overlay it
 * does NOT auto-pop — the captain opens and closes it with Ctrl-O — and it hosts
 * the merge review in-place rather than through a separate modal surface.
 *
 * It has four home tabs, listed in a persistent bar across the top so the tabs
 * that exist are visible without knowing they do, and switched three ways that
 * never collide: Tab (or `i`) cycles, and `1`..`4` jump straight to one from any
 * view. In order: `home` (the co's task table over every tracked worktree —
 * read-only, it only pages), the `queue` tab ([m] merges the ready head, `e`
 * edits its PR message, and the rest pages its inline body), the `docs` tab
 * (a-z open a doc), and the `inbox` tab (a-z open a filed crew review). Opening
 * a doc drops into a `doc` view; selecting a review drops into an `inboxItem`
 * view. A pending feature_land review adds a fifth `review` tab for as long as it
 * is pending. All the body views page identically. Backspace/Esc walk back out.
 *
 * HOME IS THE LANDING TAB and it acts on nothing (no [m], no selector), which is
 * what lets it be the thing the panel opens on: the first screen of a panel that
 * merges branches must not be one where a stray keypress can merge one.
 *
 * THE QUEUE TAB IS THE MERGE (D-20260724-12). A green head renders its own diff,
 * commits and checks result right there and carries a live [m] that merges
 * it — no co tool call, no gate, nothing waiting on the keystroke. The [m] is a
 * STATE, not a prompt: it is present because the head is green, it stays present
 * until pressed, and it disappears when the head changes. A blocked head renders
 * why instead and offers no [m] at all.
 *
 * `docs` + its loading/error are kept on the panel (not per-view) so switching
 * tabs never reloads them; the review inbox is read fresh from its source at
 * paint time (a cheap in-memory snapshot). The queue is read fresh too, but its
 * ROWS are memoized against a signature (queueSignature) because a ready head's
 * inline diff is expensive to wrap and a paint can happen every frame.
 */
type PanelView =
  /** The landing page: the co's task table, then every tracked feature worktree
   *  with its state, branch and description. A read-only overview — it scrolls,
   *  and nothing on it acts. */
  | { kind: "home" }
  | { kind: "queue" }
  | { kind: "docs" }
  | { kind: "doc"; name: string; content: string; rows: string[]; scroll: number; error: string | null }
  | { kind: "inbox" }
  /** One filed review's full body, drilled into from the inbox list. It carries
   *  the record itself rather than a list index: a review filed while the captain
   *  is reading shifts every index by one, and a resize must never swap the text
   *  under them. */
  | { kind: "inboxItem"; entry: InboxPanelEntry; rows: string[]; scroll: number }
  /** The ready head's full paged diff, drilled into with [d] from the queue tab.
   *  Its rows/scroll live on `pendingReview` (mutated in place), so this carries
   *  no state of its own. */
  | { kind: "review" }
  /** The head PR's message, open in a popup editor over the queue tab (`e`).
   *  Like `review` it carries no state of its own — the buffer lives on
   *  `PanelState.prEdit` and is mutated in place, so a resize (which re-lays
   *  every row) can never swap the text under the captain's caret. */
  | { kind: "prEdit" };

interface PanelState {
  view: PanelView;
  /** The docs/ filenames, sorted; loaded on open and on a write signal. */
  docs: string[];
  docsLoading: boolean;
  docsError: string | null;
  /** Scroll offset of the queue tab. The tab is scroll-bearing now: a ready
   *  head's whole diff renders inline beneath the list (D-20260724-12). */
  queueScroll: number;
  /** Memoized queue rows and the signature they were built for. The tab is
   *  re-rendered from its source every paint, and a paint can happen 60x a
   *  second while the model streams underneath — re-wrapping a large diff that
   *  often would be pure waste, so rows are rebuilt only when something they
   *  depend on actually changed (see queueSignature). */
  queueRows: string[];
  queueSig: string;
  /** Scroll offset of the Home tab. It is sized to fit typical content — a
   *  handful of tasks over five or six worktrees — but the content is unbounded,
   *  so unlike the docs/inbox lists it pages rather than clipping. */
  homeScroll: number;
  /**
   * The copy confirmation, shown in the footer in place of the key hints, or
   * null. Sticky until the next panel key rather than timed out: it mirrors the
   * transcript's finished selection, which stays highlighted as its own receipt
   * until something dismisses it, and a copy is worth confirming for as long as
   * the captain is still looking at what he copied.
   */
  copyNotice: string | null;
  /**
   * Mouse text selection over the panel body, in the SAME shape the transcript
   * uses. `anchorRow`/`focusRow` are absolute indices into the current view's
   * body rows (not screen rows), so the selection survives scrolling mid-drag;
   * the columns are 0-based visible columns. `selecting` is true only during an
   * active left-drag - the highlight persists after release as the visual half
   * of the receipt, until a key or a fresh click clears it.
   */
  selection: SelectionRange | null;
  selecting: boolean;
  /** The body row painted at the top of the viewport in the last paintPanel:
   *  the anchor for mapping a mouse (x, y) back to an absolute body row. */
  lastStart: number;
  /** The open PR message editor, or null. Non-null exactly while the view is
   *  `prEdit`; kept on the panel rather than in the view so the buffer survives
   *  a resize and a repaint by identity. */
  prEdit: PrEditState | null;
}

/**
 * The PR message editor's live state (D-20260727-15): one buffer in `git commit`
 * shape (line 1 the title, a blank line, then the description), the popup's own
 * scroll, and whatever it currently has to say back to the captain.
 *
 * It edits the PROSE ONLY. co's fenced evidence block is split off before the
 * buffer is filled and spliced back on by the save path, so the captain never
 * sees those markers and cannot delete the block by editing around it.
 */
interface PrEditState {
  editor: TextEditor;
  /** The pull request being edited — pinned, so a save can name it and a head
   *  that changed underneath is visible rather than silently retargeted. */
  prNumber: number;
  feature: string;
  /** Top visual row of the popup's viewport. Kept in step with the caret by
   *  scrollToCursor on every paint. */
  scroll: number;
  /** "saving": `gh pr edit` is in flight; every key is ignored until it settles,
   *  the same fire-once interlock the queue merge uses. */
  status: "editing" | "saving";
  /** A refusal or a gh failure, shown inside the popup with the buffer intact. */
  error: string | null;
  /** True once Esc has been pressed on a dirty buffer: the next Esc discards. */
  escPending: boolean;
  /**
   * Bracketed-paste state, kept HERE rather than on the Tui: while the popup is
   * open the panel branch of consume() runs first, so the prompt's paste
   * machinery is never reached and the popup needs its own. `pasting` spans data
   * events (a long description arrives in several) and the buffered content is
   * inserted as ONE literal insert when the end marker lands, so a forty-line
   * body can never be read as forty Enter presses.
   */
  pasting: boolean;
  pasteBuf: string;
  /** True only during an active left-drag inside the popup. The SELECTION lives
   *  in the editor (as buffer offsets); this is just the gesture. */
  dragging: boolean;
  /** A copy receipt or a clear confirmation, shown on the popup's message line
   *  until the next key. Same idea as the panel's copyNotice, scoped to the box. */
  notice: string | null;
}

/**
 * A merge review awaiting the captain's verdict, tracked INDEPENDENTLY of whether
 * the panel is open (openLandingReview sets it and flashes a hint; the captain
 * opens the panel to act). At most one exists at a time — the queue is serial, and
 * feature_land is refused for a queued feature — so a second openLandingReview
 * settles the first as rejected before replacing it.
 *
 * Mutated in place for its whole life: the [m] handler's async continuation holds
 * a reference and checks it against this.pendingReview to know whether the gate is
 * still live, so its identity must survive scrolling and status changes (the same
 * contract the old LandingOverlay had).
 */
interface PendingReview {
  review: LandingReview;
  /** "review": [m] can fire (green prepare only). "merging": execute() is in
   *  flight and every gate key is ignored - the fire-once interlock. "failed":
   *  the merge was refused; [m] stays off (a stale green needs a fresh prepare)
   *  and dismissing is the only exit. */
  status: "review" | "merging" | "failed";
  /** The execute() refusal/failure message when status is "failed". */
  error: string | null;
  /** Rendered summary + full diff for the [d] drill view. Rebuilt on resize/state. */
  rows: string[];
  scroll: number;
  /** Resolve openLandingReview's promise. Idempotent: first call wins. */
  settle: (outcome: LandingGateOutcome) => void;
}

/**
 * A decoded panel keystroke: either a printable char (a doc-list selector, a
 * paging letter, or a review action m/r/d) or a named navigation intent. Kept
 * separate from the editor's `Action` so the two input modes never share a
 * binding by accident.
 */
type OverlayInput =
  | { ch: string }
  | {
      nav:
        | "escape"
        /** Ctrl-O pressed while the panel is up: toggle it shut. */
        | "close"
        | "back"
        | "tab"
        | "up"
        | "down"
        | "pageup"
        | "pagedown"
        | "halfup"
        | "halfdown"
        | "top"
        | "bottom";
    };

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
  /** Pending coalesced frame, if one is scheduled. See paint(). */
  private paintTimer: ReturnType<typeof setTimeout> | null = null;
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
  private selection: SelectionRange | null = null;
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

  // The visual region: a fixed-height band of decorative rows between the
  // confirm banner and the busy line, driven by its own slow timer (see
  // playAnimation). Like `busy` it is ephemeral — nothing here ever reaches the
  // transcript, so the durable record of a dispatch or an exit is the static
  // line the caller committed, identical at every visuals level.
  private visual: AnimationSpec | null = null;
  private visualFrame = 0;
  private visualTimer: ReturnType<typeof setInterval> | null = null;
  /** Resolvers waiting on the running animation to clear (settle/stop). */
  private visualWaiters: Array<() => void> = [];
  /** Wall-clock start of the running animation, for settle()'s minimum. */
  private visualStartedAt = 0;

  // Pending single-line resolver when awaiting input.
  private pendingResolve: ((line: string | null) => void) | null = null;
  private sigintCount = 0;
  // A pending-confirm banner shown above the input bar while a dispatch is armed
  // and awaiting the captain's typed `confirm`. Purely presentational: the
  // interlock itself lives in the session loop, which decides what to do with
  // the typed line. Null when nothing is armed.
  private confirmBanner: string[] | null = null;
  // Armed by a lone ESC; a second consecutive lone ESC clears the input line
  // (matches Claude Code's esc-esc). Any other key disarms it.
  private escPending = false;

  // The persistent Ctrl-O panel: the shared home for docs AND the live merge
  // queue. While `panel` is non-null it takes the whole screen and drives every
  // keystroke (a single keyboard can't feed the panel and the prompt at once),
  // but it is NON-MODAL in the sense that matters: it never auto-pops, the
  // captain opens/closes it with Ctrl-O, and Ctrl-O/Esc always returns to the
  // prompt with the draft intact. The model keeps streaming into the transcript
  // underneath (committed/open are still updated); closing the panel repaints it
  // intact. `docs`/`queue` are the injected sandboxed sources; `unsubscribeDocs`
  // tears down the live doc-refresh listener.
  private readonly docs?: DocSource;
  private readonly queue?: QueuePanelSource;
  private readonly inbox?: InboxPanelSource;
  private readonly features?: FeaturePanelSource;
  private readonly tasks?: TaskPanelSource;
  private panel: PanelState | null = null;
  private unsubscribeDocs: (() => void) | null = null;
  // The panel-native merge (D-20260724-12). `queueMerging` names the feature
  // whose merge is in flight and is the fire-once interlock: while it is set,
  // [m] is a no-op and the tab says what is happening instead of offering the
  // key again. `queueMergeError` holds the last refusal so it banners in place
  // rather than vanishing with a flash the captain may have missed. Neither is
  // an "armed" state — there is nothing to settle, nothing waiting on a human,
  // and no promise held open anywhere: the [m] is just a property of a ready
  // head, present until pressed or until the head's state changes.
  private queueMerging: string | null = null;
  private queueMergeError: string | null = null;
  // True while a bracketed paste is being swallowed on a panel tab (see
  // consumeOverlay). The popup keeps its own paste state, on its own buffer.
  private overlayPasting = false;
  // What the PR message editor has to say on the queue tab after it closes: the
  // save that landed, or the reason `e` had nothing to open. It banners at the
  // top of the tab (like queueMergeError, and for the same reason: a flash on
  // the separator is invisible while the panel owns the screen).
  //
  // `ok` is what it is worth, not just its colour, and it decides how long the
  // line lives (see clearQueueEditReceipt). An ok line is a RECEIPT: the write
  // already landed and the tab beneath it already shows the result, so it is
  // worth exactly as long as the captain is still looking at the tab it landed
  // on, and the next key retires it — the same life the panel's copy receipt
  // has. A not-ok line is not a receipt: a refusal to open, or an edit
  // discarded, is the only record of something that did NOT happen, so it
  // stands until the next thing worth saying replaces it. A failed SAVE is
  // neither — it never reaches this line at all, because the popup stays open
  // over the captain's text and prints it there (see savePrMessage).
  private queueEditNotice: { text: string; ok: boolean } | null = null;
  // A merge review awaiting the captain's [m]/[r]/[d], tracked apart from the
  // panel's open/closed state: openLandingReview sets it and flashes a hint (it
  // never force-opens the panel), and the captain opens the panel to act on it.
  private pendingReview: PendingReview | null = null;

  private onResize = (): void => {
    this.measure();
    this.rewrap();
    this.reflowPanel();
    this.paint();
  };

  constructor(opts: TuiOptions) {
    this.promptLabel = opts.promptLabel;
    this.header = opts.header;
    this.out = opts.out ?? process.stdout;
    this.inp = opts.inp ?? process.stdin;
    this.docs = opts.docs;
    this.queue = opts.queue;
    this.inbox = opts.inbox;
    this.features = opts.features;
    this.tasks = opts.tasks;
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
    // Drop the doc-viewer live-refresh subscription so the write queue doesn't
    // keep calling into a torn-down Tui.
    if (this.unsubscribeDocs) { this.unsubscribeDocs(); this.unsubscribeDocs = null; }
    // A pending merge review at teardown settles as a non-merge so its caller
    // never hangs; mid-merge, the execute continuation delivers the real
    // outcome (see approveLanding).
    if (this.pendingReview && this.pendingReview.status !== "merging") {
      this.pendingReview.settle(this.pendingReview.status === "failed" ? "failed" : "rejected");
    }
    this.pendingReview = null;
    this.panel = null;
    if (this.statusTimer) { clearTimeout(this.statusTimer); this.statusTimer = null; }
    if (this.busyTimer) { clearInterval(this.busyTimer); this.busyTimer = null; }
    // A voyage still under way at teardown ends here: its timer is dropped and
    // anything awaiting it is released, so an exit animation can never outlive
    // the screen it was drawn on or hold the closing sequence up.
    this.stopVisual();
    // Drop any queued frame: we're about to leave the alt screen, so painting
    // it would write into a buffer that's being torn down.
    if (this.paintTimer) { clearTimeout(this.paintTimer); this.paintTimer = null; }
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
    // confirm banner (when armed) + visual region (while animating) + busy line
    // (when working) + separator + wrapped input text rows
    return this.confirmRows() + this.visualRows() + this.busyRows() + 1 + this.inputTextRows();
  }

  /** Rows the armed-dispatch confirm banner occupies (0 when nothing armed). */
  private confirmRows(): number {
    return this.confirmBanner ? this.confirmBanner.length : 0;
  }

  /** Rows the decorative visual region occupies (0 when nothing is playing).
   *  Fixed for the life of an animation, so the screen never jumps mid-flight. */
  private visualRows(): number {
    return this.visual ? this.visual.rows : 0;
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
   *
   * The wrapping itself lives in ./editor, shared with the panel's PR message
   * editor: two editors on one screen must not disagree about where a line
   * breaks or where the caret is inside it.
   */
  private inputLayout(): EditorLayout {
    const avail = Math.max(1, this.cols - visibleWidth(this.promptLabel));
    return layoutBuffer(this.buf, this.cursor, avail);
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
    // Model tokens are landing: scenery yields immediately. playAnimation
    // already refuses to start over an open stream; this is the other direction
    // — a stream that starts while something is playing kills it — so the
    // "never animate during streaming" rule holds no matter the ordering.
    if (this.visual) this.stopVisual();
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
    // Coalesced: this is the per-token streaming path. See paintSoon().
    if (this.active) this.paintSoon();
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

  /**
   * Request a frame within PAINT_INTERVAL_MS, collapsing a burst into one write.
   *
   * Used only on the transcript-growth path (see afterGrow). That path runs once
   * per streamed text delta, so a single reply used to write hundreds of full
   * frames, each clearing and rewriting every visible row. On a fast local
   * terminal that reads as stuttering; over SSH or in a slow emulator the writes
   * throttle the stream itself, so the model looks slower than it is.
   *
   * Everything else — keystrokes, scrolling, selection, the busy spinner — still
   * paints synchronously. Those arrive at human or fixed-tick rates, so
   * coalescing them would trade real input latency for no gain.
   */
  private paintSoon(): void {
    if (!this.active) return;
    if (this.paintTimer) return; // a frame is already queued; it will pick this up
    this.paintTimer = setTimeout(() => {
      this.paintTimer = null;
      this.paint();
    }, PAINT_INTERVAL_MS);
    // Deliberately not unref'd: this is a one-shot a few milliseconds out, and
    // letting it hold the loop open that long guarantees the final frame of a
    // turn actually lands. (The busy spinner's timer does unref — it repeats
    // forever and would otherwise keep the process alive.)
  }

  private paint(): void {
    if (!this.active) return;
    // A synchronous paint satisfies any queued one; leaving the timer armed
    // would just write an identical frame a few milliseconds later.
    if (this.paintTimer) { clearTimeout(this.paintTimer); this.paintTimer = null; }
    // The Ctrl-O panel owns the whole screen while open. The transcript
    // underneath keeps updating (streamed output still lands in the model);
    // closing the panel repaints it.
    if (this.panel) { this.paintPanel(); return; }
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

    // Armed-dispatch confirm banner: sits directly above the busy line/rule when
    // a dispatch is staged and awaiting a typed `confirm`. Painted before the
    // busy line so it reads as a distinct region, not part of the spinner row.
    const confirmRows = this.confirmRows();
    if (this.confirmBanner) {
      for (let cr = 0; cr < this.confirmBanner.length; cr++) {
        frame.push(
          term.moveTo(vp + 1 + cr, 1) + term.clearLine + this.clip(this.confirmBanner[cr]!, this.cols),
        );
      }
    }

    // Visual region: the decorative band (dispatch waves, the exit ship). Its
    // rows are re-rendered at the CURRENT width every frame, so a resize
    // mid-animation re-lays it out instead of tearing; each row is clipped, so a
    // generator that overshoots can never wrap into the row below and garble the
    // frame. A generator that returns too few rows leaves blanks — the region's
    // height is fixed at play time either way.
    const visualRows = this.visualRows();
    if (this.visual) {
      const art = this.visual.render(this.visualFrame, this.cols);
      for (let ar = 0; ar < visualRows; ar++) {
        frame.push(
          term.moveTo(vp + confirmRows + 1 + ar, 1) +
            term.clearLine +
            this.clip(art[ar] ?? "", this.cols),
        );
      }
    }

    // Busy line: the spinner + chore, hard against the left margin on its own
    // row directly above the rule. Only painted while working.
    const busyRows = this.busyRows();
    if (busyRows) {
      frame.push(
        term.moveTo(vp + confirmRows + visualRows + 1, 1) +
          term.clearLine +
          c.cyan(this.clip(this.busyText(), this.cols)),
      );
    }

    // Separator: a horizontal rule, with a scroll hint on the left when not
    // pinned to the bottom and a transient status (e.g. "copied 4 lines") on
    // the right.
    const below = rowsAll.length - (start + vp);
    const scrollHint =
      this.atBottom || below <= 0 ? "" : `more below · ${below} line(s)`;
    const sepRow = vp + confirmRows + visualRows + busyRows + 1;
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
    const { top, bottom, topCol, bottomCol } = normalizeSelection(sel);
    if (absRow < top || absRow > bottom) return line;
    const from = absRow === top ? topCol : 0;
    const to = absRow === bottom ? bottomCol : Number.MAX_SAFE_INTEGER;
    return highlightRange(line, from, to);
  }

  /** The plain text of the current selection, joined with newlines. */
  private selectionText(): string {
    const sel = this.selection;
    if (!sel) return "";
    const { top, bottom, topCol, bottomCol } = normalizeSelection(sel);
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

  /** Drop any flashed status immediately (no repaint). Used when the panel opens
   *  or closes so a stale hint (e.g. "review ready — Ctrl-O") doesn't outlive the
   *  action it prompted. */
  private clearStatus(): void {
    this.status = null;
    if (this.statusTimer) { clearTimeout(this.statusTimer); this.statusTimer = null; }
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

  /**
   * Play a bounded animation in the visual region (see AnimationSpec). Returns
   * NO_ANIMATION — a live-looking handle that does nothing — whenever animating
   * would be wrong, so the caller never has to branch before asking:
   *
   *  - a stream is OPEN: model tokens are landing right now, and scenery must
   *    never compete with them for the frame. This is the structural half of the
   *    "animate only during idle waits" rule; appendStream() is the other half
   *    (it kills a running animation if output starts anyway).
   *  - the Ctrl-O panel is up: it owns the whole screen, so the region isn't
   *    painted at all and the timer would be pure waste.
   *  - the screen is too small: the region is subtracted from the transcript
   *    viewport, and eating the conversation to show scenery is a bad trade.
   *
   * The environment-level decision (CO_VISUALS, NO_COLOR, reduced motion…) is
   * NOT made here — that is visuals.ts's resolveVisuals, which the caller
   * consults to build the spec and its static fallback line. This method only
   * guards what the Tui itself knows: its own state and its own dimensions.
   */
  playAnimation(spec: AnimationSpec): AnimationHandle {
    if (
      !this.active ||
      this.open !== null ||
      this.panel !== null ||
      spec.rows <= 0 ||
      this.cols < VISUAL_MIN_COLS ||
      this.rows - spec.rows < VISUAL_MIN_FREE_ROWS
    ) {
      return NO_ANIMATION;
    }
    // There is one region: a second animation replaces the first (settling its
    // waiters) rather than stacking two bands above the input bar.
    this.stopVisual();

    this.visual = spec;
    this.visualFrame = 0;
    this.visualStartedAt = Date.now();
    const total = spec.frames;
    this.visualTimer = setInterval(
      () => {
        this.visualFrame++;
        // A spec with a frame count ends itself — the ship finishes its voyage
        // and the region clears without the caller doing anything.
        if (total !== undefined && this.visualFrame >= total) {
          this.stopVisual();
          return;
        }
        this.paint();
      },
      Math.max(PAINT_INTERVAL_MS, spec.intervalMs ?? VISUAL_TICK_MS),
    );
    // Scenery never holds the event loop open (same rule as the busy spinner).
    this.visualTimer.unref?.();
    this.paint();

    const mine = spec;
    const cleared = new Promise<void>((resolve) => this.visualWaiters.push(resolve));
    return {
      animating: true,
      stop: () => {
        if (this.visual === mine) this.stopVisual();
      },
      settle: async () => {
        // Already gone (frames exhausted, replaced, or torn down): it had its
        // time on screen, so there is nothing left to wait out.
        if (this.visual !== mine) return cleared;
        const remaining = (spec.minDurationMs ?? 0) - (Date.now() - this.visualStartedAt);
        if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
        if (this.visual === mine) this.stopVisual();
        return cleared;
      },
    };
  }

  /** End whatever is playing in the visual region and release its waiters.
   *  Idempotent, and safe during teardown (it only repaints while active). */
  private stopVisual(): void {
    if (this.visualTimer) {
      clearInterval(this.visualTimer);
      this.visualTimer = null;
    }
    const had = this.visual !== null;
    this.visual = null;
    this.visualFrame = 0;
    const waiters = this.visualWaiters;
    this.visualWaiters = [];
    for (const w of waiters) w();
    if (had && this.active) this.paint();
  }

  /** Drop any active selection and repaint if it was showing. */
  private clearSelection(): void {
    if (!this.selection && !this.selecting) return;
    this.selection = null;
    this.selecting = false;
    this.paint();
  }

  /**
   * Copy `text` to the system clipboard via OSC 52 (see osc52 for the sequence
   * and its silent-failure caveat). Empty selections are ignored.
   */
  private copyToClipboard(text: string): void {
    if (text === "") return;
    this.out.write(osc52(text));
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

  /**
   * Resolve a waiting question() with the wake sentinel, so the session loop can
   * run out-of-band work (a finished dispatch review) and re-prompt. The user's
   * in-progress `buf`/`cursor` are deliberately left untouched — the next
   * question() repaints with their draft intact, so a background completion never
   * eats a half-typed line. No-op (returns false) when nothing is waiting; the
   * caller then holds the event until the next idle prompt.
   */
  wake(_reason: string): boolean {
    const r = this.pendingResolve;
    if (!r) return false;
    this.pendingResolve = null;
    r(WAKE_SENTINEL);
    return true;
  }

  /**
   * Show or clear the armed-dispatch confirm banner above the input bar. Pass the
   * lines to show (order preview + resolved command + the confirm hint), or null
   * to clear it. Presentational only; the loop owns the interlock logic.
   */
  setConfirmBanner(lines: string[] | null): void {
    this.confirmBanner = lines && lines.length ? lines : null;
    this.paint();
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
    // While the Ctrl-O panel is open every key drives the panel, not the prompt.
    // Delegate before any editor parsing so a keystroke can't leak into the
    // buffer underneath. (The model keeps streaming into the transcript beneath
    // the panel; closing it repaints that intact — see closePanel.)
    if (this.panel) return this.consumeOverlay(data, i);

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

      case "open-docs":
        this.togglePanel();
        return;

      case "save":
        // Ctrl-S belongs to the panel's PR message editor. The prompt has
        // nothing to save — Enter sends — so it stays the no-op it always was.
        return;

      case "select-all":
      case "clear-all":
      case "copy":
        // The three buffer-scoped verbs belong to the PR message editor too.
        // The prompt line has no selection and no clipboard of its own, and
        // these bytes did nothing here before the popup learned them, so they
        // go on doing nothing, and the prompt's behaviour is unchanged.
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

  // --- the Ctrl-O panel -------------------------------------------------------
  //
  // The persistent, non-modal home for the instance's user-facing docs AND the
  // live merge queue (D-20260723-25). The captain opens/closes it with Ctrl-O
  // (the same key both ways — see togglePanel and the "close" panel input); it
  // never auto-pops. Four tabs, named in a bar across the top of every view and
  // reachable three ways (Tab, `i`, or the digit the bar shows beside each): the
  // HOME tab is the landing page — the co's task table over EVERY tracked
  // worktree, including the ones still being worked, which the queue never sees;
  // the QUEUE tab shows the ordered features and their state, with the ready
  // head's review actioned in-place ([m] merge / [e] edit its message / [d] drill
  // the full diff); the DOCS tab lists docs/ (selectable by letter) and opens one
  // rendered through the SAME markdown renderer the transcript uses, refreshing
  // live when an agent writes it; the INBOX tab lists the filed crew reviews and
  // opens one's full body on that same surface, and an open doc adds `y` to copy
  // its raw markdown to the system clipboard. The docs read only through the
  // injected DocSource (the sandboxed doc tool — the `.memory/` substrate is
  // never listed or reachable here); the queue, the tasks, the worktrees and the
  // inbox read a fresh in-memory snapshot from their sources at paint time. No
  // step needs an arrow key: tabs are Tab/1-4, selection is a letter, paging is
  // less-style (space/b, j/k, d/u, g/G).

  /** Visible content rows in the panel: full screen minus header + footer. */
  private overlayViewport(): number {
    return Math.max(1, this.rows - 2);
  }

  /** A page step for space/b/PgUp/PgDn: a screenful less one line of overlap. */
  private overlayPage(): number {
    return Math.max(1, this.overlayViewport() - 1);
  }

  /** Ctrl-O: open the panel if closed, close it if open. This is the ONLY way
   *  the panel opens — nothing auto-pops it. */
  private togglePanel(): void {
    if (this.panel) this.closePanel();
    else this.openPanel();
  }

  /**
   * Open the panel. With nothing wired at all and no pending review there is
   * nothing to show, so flash a hint instead (PlainIO/degraded never crashes on
   * the keybind). Otherwise the opening view is: the pending feature_land review
   * when one is waiting (that one IS a gate — it holds a caller open, so it wins
   * the landing spot), else the FIRST tab in the bar, which is HOME whenever
   * there is a Home to show. Home leads because it is the orientation view and
   * because it acts on nothing: the screen a keystroke lands on by default must
   * not be one where a stray press can merge a branch. Subscribes to the doc
   * write queue for live refresh and loads the doc list asynchronously.
   */
  private openPanel(): void {
    if (
      !this.docs && !this.queue && !this.inbox && !this.features && !this.tasks &&
      !this.pendingReview
    ) {
      this.setStatus("panel unavailable");
      return;
    }
    if (this.panel) return;
    this.clearSelection();
    this.clearStatus();
    // The panel takes the whole screen, so anything in the visual region is
    // about to be invisible; end it rather than tick a timer nobody can see.
    this.stopVisual();
    let view: PanelView;
    if (this.pendingReview) {
      // A pending feature_land review lives on its OWN tab now: the queue tab's
      // [m] belongs to the panel-native queue merge, so the two can never share
      // a key space (D-20260724-12).
      view = { kind: "review" };
      this.pendingReview.rows = renderLandingBody(
        this.pendingReview.review,
        this.pendingReview.status,
        this.pendingReview.error,
        this.cols,
      );
      this.pendingReview.scroll = 0;
    } else {
      view = this.homeView(this.panelTabs()[0] ?? "docs");
    }
    this.panel = {
      view,
      docs: [],
      docsLoading: Boolean(this.docs),
      docsError: null,
      queueScroll: 0,
      queueRows: [],
      queueSig: "",
      homeScroll: 0,
      copyNotice: null,
      selection: null,
      selecting: false,
      lastStart: 0,
      prEdit: null,
    };
    if (this.docs) {
      this.unsubscribeDocs = this.docs.subscribe((name) => this.onDocWrite(name));
      void this.loadList();
    }
    if (view.kind === "home") this.refreshHome();
    this.paint();
  }

  /**
   * Ask the feature source to re-read what it cannot derive for free (the dirty
   * flag: one `git status` per worktree), and repaint when it lands. Called when
   * Home is shown and nowhere else — a paint must never trigger I/O, and the one
   * moment the answer matters is the moment the captain is looking at it.
   *
   * Fire-and-forget by design: the tab paints immediately from what the source
   * already knows, and the dirty/clean refinement arrives a frame later. A source
   * with no `refresh` (or one that rejects) simply leaves the rows as they are.
   */
  private refreshHome(): void {
    const refresh = this.features?.refresh;
    if (!refresh || !this.features) return;
    void refresh.call(this.features).then(
      () => {
        if (this.panel) this.paint();
      },
      () => {},
    );
  }

  /** Close the panel and repaint the transcript+editor beneath it, intact. A
   *  pending merge review is NOT settled — it survives closing the panel, so the
   *  captain can reopen and act on it later. */
  private closePanel(): void {
    if (!this.panel) return;
    this.panel = null;
    this.clearStatus();
    if (this.unsubscribeDocs) {
      this.unsubscribeDocs();
      this.unsubscribeDocs = null;
    }
    // Any model output that streamed in while the panel was up is already in the
    // transcript model; this paint reveals it.
    this.paint();
  }

  private async loadList(): Promise<void> {
    if (!this.docs) return;
    try {
      const docs = await this.docs.list();
      if (this.panel) {
        this.panel.docs = docs;
        this.panel.docsLoading = false;
        this.panel.docsError = null;
        // The list just changed under any selection standing on it.
        this.clearPanelSelection();
        this.paint();
      }
    } catch (e) {
      if (this.panel) {
        this.panel.docs = [];
        this.panel.docsLoading = false;
        this.panel.docsError = (e as Error).message;
        this.paint();
      }
    }
  }

  /** Load a doc and switch the panel to showing it, scrolled to the top. */
  private async openDoc(name: string): Promise<void> {
    if (!this.docs || !this.panel) return;
    try {
      const content = await this.docs.read(name);
      if (!this.panel) return; // closed while loading
      this.panel.view = {
        kind: "doc",
        name,
        content,
        rows: renderMarkdownDoc(content, this.cols),
        scroll: 0,
        error: null,
      };
      this.paint();
    } catch (e) {
      if (!this.panel) return;
      this.panel.view = { kind: "doc", name, content: "", rows: [], scroll: 0, error: (e as Error).message };
      this.paint();
    }
  }

  /** Return from a doc to the docs tab (list re-loaded). */
  private backToList(): void {
    if (!this.panel) return;
    this.panel.view = { kind: "docs" };
    this.paint();
    void this.loadList();
  }

  /** The panel's home tabs, IN BAR ORDER, given what's wired and pending: home
   *  (when a task or feature source exists), the queue (when a queue source
   *  exists), docs (when a doc source exists), the review inbox (when an inbox
   *  source exists), and a feature_land review whenever one is pending.
   *
   *  Home leads because it is the landing page and the one tab that acts on
   *  nothing. The review gets its own tab even alongside the queue: the queue
   *  tab's [m] is the panel-native queue merge, and two different merges must
   *  never share one key (D-20260724-12). Tab cycles these; `1`..`4` (and `5`
   *  when a review is pending) index straight into this list. */
  private panelTabs(): PanelView["kind"][] {
    const tabs: PanelView["kind"][] = [];
    if (this.tasks || this.features) tabs.push("home");
    if (this.queue) tabs.push("queue");
    if (this.docs) tabs.push("docs");
    if (this.inbox) tabs.push("inbox");
    if (this.pendingReview) tabs.push("review");
    return tabs;
  }

  /** The one-word label each tab wears in the bar. */
  private static readonly TAB_LABELS: Record<PanelView["kind"], string> = {
    home: "home",
    queue: "queue",
    docs: "docs",
    inbox: "inbox",
    review: "review",
    doc: "docs",
    inboxItem: "inbox",
    prEdit: "queue",
  };

  /** A home tab's view state. Sub-views (doc, inboxItem) are never home tabs, so
   *  anything unrecognised falls back to the first tab that exists. */
  private homeView(kind: PanelView["kind"]): PanelView {
    switch (kind) {
      case "home": return { kind: "home" };
      case "queue": return { kind: "queue" };
      case "docs": return { kind: "docs" };
      case "inbox": return { kind: "inbox" };
      case "review": return { kind: "review" };
      // Sub-views (doc, inboxItem, prEdit) are never home tabs. Fall back to
      // whatever tab is FIRST rather than to a fixed one — a panel may have no
      // queue at all. panelTabs only ever yields home tabs, so this recurses once.
      default: return this.homeView(this.panelTabs()[0] ?? "queue");
    }
  }

  /** Tab (or `i`, its panel-only twin) cycles the home tabs. From a sub-view (a
   *  doc, a filed review) it first pops back to that sub-view's own tab. A no-op
   *  when there's only one tab. */
  private switchTab(): void {
    if (!this.panel) return;
    const v = this.panel.view;
    if (v.kind === "doc") { this.panel.view = { kind: "docs" }; this.paint(); return; }
    if (v.kind === "inboxItem") { this.panel.view = { kind: "inbox" }; this.paint(); return; }
    const tabs = this.panelTabs();
    if (tabs.length < 2) return;
    const cur = tabs.indexOf(v.kind);
    this.gotoTab(tabs[(cur + 1) % tabs.length]!);
  }

  /**
   * `1`..`9`: jump straight to the nth tab in the bar, from ANY view — including
   * out of an open doc or a filed review, which is the whole point of a direct
   * jump. A digit past the end of the bar is a no-op.
   *
   * The digits are reserved panel-wide, which is why the doc and inbox lists are
   * labelled from `a` (see OVERLAY_LABELS): a key that means "tab 2" everywhere
   * cannot also mean "open the second doc" on one tab.
   */
  private jumpTab(index: number): void {
    if (!this.panel) return;
    const tab = this.panelTabs()[index];
    if (!tab) return;
    this.gotoTab(tab);
  }

  /** Land on a home tab: switch the view, run whatever that tab needs on arrival,
   *  and repaint. The single path Tab, `i` and the number keys all take, so no
   *  route onto a tab can skip its arrival work. */
  private gotoTab(kind: PanelView["kind"]): void {
    if (!this.panel) return;
    this.panel.view = this.homeView(kind);
    if (kind === "review" && this.pendingReview) {
      this.pendingReview.rows = renderLandingBody(
        this.pendingReview.review,
        this.pendingReview.status,
        this.pendingReview.error,
        this.cols,
      );
    }
    // Home re-reads the worktrees' dirty state (a git call per worktree, so only
    // ever on arrival).
    if (kind === "home") this.refreshHome();
    this.paint();
    // Landing on docs re-lists so any writes that arrived while it was off screen
    // are picked up (onDocWrite skips the reload when docs aren't showing).
    if (kind === "docs") void this.loadList();
  }

  /**
   * A doc write landed (via the write queue). Refresh the view if it concerns
   * what's on screen: re-read the open doc, or re-list (a create/delete changes
   * the list). This is the live-refresh path the feature is built around.
   */
  private onDocWrite(name: string): void {
    if (!this.panel) return;
    const v = this.panel.view;
    if (v.kind === "doc") {
      if (v.name === name) void this.refreshDoc();
    } else if (v.kind === "docs") {
      void this.loadList();
    }
    // On the queue/review tab a doc write just updates the cached list silently;
    // it re-lists when the captain switches to the docs tab.
  }

  /** Re-read the open doc, preserving the scroll position where it still fits. */
  private async refreshDoc(): Promise<void> {
    if (!this.docs || !this.panel || this.panel.view.kind !== "doc") return;
    const name = this.panel.view.name;
    try {
      const content = await this.docs.read(name);
      if (!this.panel || this.panel.view.kind !== "doc" || this.panel.view.name !== name) return; // moved on
      const changed = this.panel.view.content !== content;
      const rows = renderMarkdownDoc(content, this.cols);
      const scroll = Math.min(this.panel.view.scroll, Math.max(0, rows.length - this.overlayViewport()));
      this.panel.view = { kind: "doc", name, content, rows, scroll, error: null };
      // A receipt is only true of the text it was taken from, and a highlight
      // only of the rows it was dragged over. This is the one refresh path no
      // keystroke passes through (an agent rewrote the doc under the captain),
      // so retire both here rather than let them vouch for content that moved.
      if (changed) this.clearPanelSelection();
      this.paint();
    } catch {
      // Deleted out from under us: drop back to the list rather than show stale.
      if (this.panel && this.panel.view.kind === "doc" && this.panel.view.name === name) this.backToList();
    }
  }

  /** Re-lay the open doc, the pending review body, or a filed review out at the
   *  current width (resize). The docs/inbox tabs re-render from source each paint;
   *  the queue tab re-renders itself because its cache key carries the width. */
  private reflowPanel(): void {
    if (!this.panel) return;
    // A resize re-wraps every row, so a selection made at the old width points
    // at text that has moved. Drop it rather than highlight the wrong cells.
    this.clearPanelSelection();
    const v = this.panel.view;
    if (v.kind === "doc") {
      const rows = renderMarkdownDoc(v.content, this.cols);
      const scroll = Math.min(v.scroll, Math.max(0, rows.length - this.overlayViewport()));
      this.panel.view = { ...v, rows, scroll };
    } else if (v.kind === "inboxItem") {
      const rows = renderInboxItem(v.entry, this.cols);
      const scroll = Math.min(v.scroll, Math.max(0, rows.length - this.overlayViewport()));
      this.panel.view = { ...v, rows, scroll };
    } else if (v.kind === "review" && this.pendingReview) {
      const pr = this.pendingReview;
      pr.rows = renderLandingBody(pr.review, pr.status, pr.error, this.cols);
      pr.scroll = Math.min(pr.scroll, Math.max(0, pr.rows.length - this.overlayViewport()));
    }
  }

  /** The scroll offset + row count of whichever scroll-bearing view is showing,
   *  or null for the non-scrolling docs/inbox list tabs. */
  private scrollTarget(): { get(): number; set(n: number): void; rows: number } | null {
    if (!this.panel) return null;
    const v = this.panel.view;
    if (v.kind === "queue") {
      const panel = this.panel;
      return {
        get: () => panel.queueScroll,
        set: (n) => { panel.queueScroll = n; },
        rows: this.queueBody().length,
      };
    }
    if (v.kind === "home") {
      const panel = this.panel;
      return {
        get: () => panel.homeScroll,
        set: (n) => { panel.homeScroll = n; },
        rows: this.homeTabRows().length,
      };
    }
    if (v.kind === "doc" || v.kind === "inboxItem") {
      return { get: () => v.scroll, set: (n) => { this.panel!.view = { ...v, scroll: n }; }, rows: v.rows.length };
    }
    if (v.kind === "review" && this.pendingReview) {
      const pr = this.pendingReview;
      return { get: () => pr.scroll, set: (n) => { pr.scroll = n; }, rows: pr.rows.length };
    }
    return null;
  }

  private overlayScrollBy(delta: number): void {
    const t = this.scrollTarget();
    if (!t) return;
    const max = Math.max(0, t.rows - this.overlayViewport());
    const next = Math.max(0, Math.min(max, t.get() + delta));
    if (next === t.get()) return;
    t.set(next);
    this.paint();
  }

  private overlayScrollTo(pos: number): void {
    const t = this.scrollTarget();
    if (!t) return;
    const max = Math.max(0, t.rows - this.overlayViewport());
    const next = Math.max(0, Math.min(max, pos));
    if (next === t.get()) return;
    t.set(next);
    this.paint();
  }

  /** Parse one key/sequence while the panel is open. Returns bytes consumed. */
  private consumeOverlay(data: string, i: number): number {
    // The PR message editor takes the keyboard whole while it is open: it needs
    // the EDITOR's decode table (where Ctrl-U kills to line start), not the
    // panel's (where it pages up), so it is routed before any panel translation
    // rather than through dispatchOverlay. It handles its own bracketed paste,
    // into its buffer.
    if (this.panel?.view.kind === "prEdit") return this.consumePrEdit(data, i);

    // A bracketed paste on a panel TAB has nowhere to land, since no view out
    // here is a text buffer, so it is swallowed whole rather than let its
    // characters read as panel keys. That matters more than it sounds: `m` is
    // the merge on the queue tab, and a pasted paragraph containing one would
    // otherwise merge the head. (Reachable the moment pasting into the panel is
    // a normal gesture, which the message editor makes it.)
    if (this.overlayPasting) {
      const end = data.indexOf(PASTE_END, i);
      if (end === -1) return data.length - i; // still mid-paste; await the rest
      this.overlayPasting = false;
      return end - i + PASTE_END.length;
    }
    if (data.startsWith(PASTE_START, i)) {
      this.overlayPasting = true;
      return PASTE_START.length;
    }
    if (data.startsWith(PASTE_END, i)) return PASTE_END.length;

    const ch = data[i]!;
    if (ch === ESC && data[i + 1] === "[") return this.consumeOverlayCsi(data, i);
    // A lone ESC leaves. (Under the Kitty protocol Escape arrives as CSI 27 u,
    // handled below; a bare 0x1b really is an Escape press.)
    if (ch === ESC) {
      this.dispatchOverlay({ nav: "escape" });
      return 1;
    }
    if (ch === "\t") {
      this.dispatchOverlay({ nav: "tab" });
      return 1;
    }
    const input = this.overlayByte(ch);
    if (input) this.dispatchOverlay(input);
    return 1;
  }

  /** Translate a legacy byte into a panel input, or null to ignore it. */
  private overlayByte(ch: string): OverlayInput | null {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 32 && code !== 127) return { ch }; // printable
    switch (code) {
      case 9:
        return { nav: "tab" }; // Tab switches tabs
      case 15:
        return { nav: "close" }; // Ctrl-O — the key that opened the panel closes it
      case 8:
      case 127:
        return { nav: "back" }; // Backspace
      case 2:
        return { nav: "pageup" }; // Ctrl-B
      case 6:
        return { nav: "pagedown" }; // Ctrl-F
      case 4:
        return { nav: "halfdown" }; // Ctrl-D
      case 21:
        return { nav: "halfup" }; // Ctrl-U
    }
    return null; // Enter, other control bytes: nothing to do in the panel
  }

  private consumeOverlayCsi(data: string, i: number): number {
    // Mouse (SGR 1006), same wire format the transcript decodes: the wheel
    // scrolls the body, and a left-drag selects and copies out of it.
    if (data[i + 2] === "<") {
      const end = this.findMouseEnd(data, i + 3);
      if (end === -1) return data.length - i;
      this.handlePanelMouse(data.slice(i + 3, end), data[end] === "M");
      return end - i + 1;
    }

    let j = i + 2;
    while (j < data.length && !/[A-Za-z~]/.test(data[j]!)) j++;
    if (j >= data.length) return data.length - i;
    const final = data[j]!;
    const params = data.slice(i + 2, j);
    const consumed = j - i + 1;

    switch (final) {
      case "u": {
        const ev = parseCsiU(params);
        if (ev) this.dispatchOverlayKey(ev);
        return consumed;
      }
      case "A": this.dispatchOverlay({ nav: "up" }); return consumed;
      case "B": this.dispatchOverlay({ nav: "down" }); return consumed;
      case "C": return consumed; // Right: nothing to do
      case "D": return consumed; // Left: nothing to do (Backspace goes back)
      case "H": this.dispatchOverlay({ nav: "top" }); return consumed;
      case "F": this.dispatchOverlay({ nav: "bottom" }); return consumed;
      case "~": {
        // xterm's modifyOtherKeys spelling of an ordinary key (`CSI 27;mods;code ~`),
        // decoded here for the same reason the editor path decodes it: on a terminal
        // running that mode Ctrl-O would otherwise open the panel and then be unable
        // to close it. Plain CSI ~ keys (PgUp/PgDn/Home/End) parse as null and fall
        // through untouched.
        const other = parseModifyOtherKeys(params);
        if (other) {
          this.dispatchOverlayKey(other);
          return consumed;
        }
        const n = Number.parseInt(params, 10);
        if (n === 5) this.dispatchOverlay({ nav: "pageup" });
        else if (n === 6) this.dispatchOverlay({ nav: "pagedown" });
        else if (n === 1 || n === 7) this.dispatchOverlay({ nav: "top" });
        else if (n === 4 || n === 8) this.dispatchOverlay({ nav: "bottom" });
        return consumed;
      }
      default:
        return consumed;
    }
  }

  /**
   * Route a key decoded from an enhanced protocol (Kitty CSI-u or xterm's
   * modifyOtherKeys) into the panel. Everything but Escape/Tab is folded back
   * onto the legacy byte its raw form would have been, so Ctrl-O closes and
   * Ctrl-F/B/D/U page identically however the terminal spelled them.
   */
  private dispatchOverlayKey(ev: KeyEvent): void {
    if (ev.code === 27) { this.dispatchOverlay({ nav: "escape" }); return; }
    if (ev.code === 9) { this.dispatchOverlay({ nav: "tab" }); return; }
    const raw =
      ev.mods.ctrl && ev.code >= 97 && ev.code <= 122
        ? String.fromCharCode(ev.code - 96)
        : String.fromCodePoint(ev.code);
    const input = this.overlayByte(raw);
    if (input) this.dispatchOverlay(input);
  }

  private dispatchOverlay(input: OverlayInput): void {
    if (!this.panel) return;
    // A standing selection and its receipt are dismissed by the next key,
    // whatever it is, the way any real keystroke clears the transcript's
    // copied-selection highlight. Cleared BEFORE routing so `y` re-sets the
    // receipt on the way through and a repeat copy still reads as a fresh one.
    // It also means every view change clears the selection for free: they are
    // all key-driven, and a row index means something else on the next view.
    this.clearPanelSelection();
    // A landed save's receipt on the queue tab goes the same way, in the same
    // breath and for the same reason. Cleared BEFORE routing so `e` sets a fresh
    // one on the way through, and so the key that dismisses it still does its own
    // job — dismissing is a side effect of the next keystroke, never a key of its
    // own. HERE and not in clearPanelSelection, whose other callers are a doc
    // refresh, a docs-list load and a resize: retiring the receipt on one of
    // those would make it vanish with no keystroke behind it, which is the timed
    // flash this is deliberately not.
    this.clearQueueEditReceipt();
    // Ctrl-O toggles the panel shut from any view — the same key that opened it.
    // It takes each view's OWN escape exit rather than a second, divergent close
    // path, so it inherits their rules (notably the review view's mid-merge
    // lockout: a merge in flight can't be walked away from by any key).
    const ev: OverlayInput = "nav" in input && input.nav === "close" ? { nav: "escape" } : input;
    // Tab switches tabs from any view, and `i` is its second spelling
    // (D-20260724-9). Both live HERE, on the panel's own input path, which is
    // reached only while the panel owns the keyboard — a bare `i` typed at the
    // input line never gets this far and stays the literal character it always
    // was (see consume(): the panel branch is taken before any editor parsing).
    if ("nav" in ev && ev.nav === "tab") { this.switchTab(); return; }
    if ("ch" in ev && ev.ch === "i") { this.switchTab(); return; }
    // The digits jump straight to a tab, from every view, for the same reason
    // Tab lives here: they are the panel's own keys, reserved panel-wide, and no
    // view may shadow them (which is why no list row is labelled with one).
    if ("ch" in ev && ev.ch >= "1" && ev.ch <= "9") {
      this.jumpTab(ev.ch.charCodeAt(0) - "1".charCodeAt(0));
      return;
    }
    switch (this.panel.view.kind) {
      case "home": this.homeTabInput(ev); return;
      case "queue": this.queueTabInput(ev); return;
      case "docs": this.docsTabInput(ev, this.panel); return;
      case "doc": this.overlayDocInput(ev); return;
      case "inbox": this.inboxTabInput(ev); return;
      case "inboxItem": this.inboxItemInput(ev); return;
      case "review": this.reviewViewInput(ev); return;
    }
  }

  /**
   * The queue tab (D-20260724-12). [m] merges the ready head, directly — it is
   * live whenever the head is green and it is simply absent otherwise, so there
   * is no modal state to enter or leave. Everything else pages the body (the
   * ready head's diff renders inline, so this tab scrolls like a doc), and
   * Esc/Backspace/q close the panel.
   *
   * The paging surface is checked BEFORE the exits so `d`/`u` keep their
   * less-style half-page meaning here, and [m] is checked first of all so a
   * merge can never be shadowed by a paging key.
   */
  private queueTabInput(input: OverlayInput): void {
    if ("ch" in input && input.ch === "m") {
      this.mergeReadyHead();
      return;
    }
    // `e` edits the head PR's message (D-20260727-15). Checked beside [m] and
    // before the paging surface for the same reason: an action key must never be
    // shadowed by a scroll key. It writes a title and a body and nothing else —
    // merging is still [m], and still a separate, deliberate keystroke.
    if ("ch" in input && input.ch === "e") {
      this.openPrEditor();
      return;
    }
    if ("nav" in input) {
      if (this.overlayScrollInput(input)) return;
      if (input.nav === "escape" || input.nav === "back") this.closePanel();
      return;
    }
    if (this.overlayScrollInput(input)) return;
    if (input.ch === "q" || input.ch === "Q") this.closePanel();
  }

  /**
   * The Home tab: an overview, and nothing else. It pages like the queue tab
   * (the task table plus a long worktree list can outgrow the screen) and
   * Esc/Backspace/q close the panel, but no key here acts on a feature — landing
   * is the queue's [m], and creating, enqueuing and abandoning are the co's
   * levers. Deliberately no [m] and no selector, so the tab the panel OPENS on
   * can never be the thing that merged something.
   */
  private homeTabInput(input: OverlayInput): void {
    if ("nav" in input) {
      if (this.overlayScrollInput(input)) return;
      if (input.nav === "escape" || input.nav === "back") this.closePanel();
      return;
    }
    if (this.overlayScrollInput(input)) return;
    if (input.ch === "q" || input.ch === "Q") this.closePanel();
  }

  private docsTabInput(input: OverlayInput, panel: PanelState): void {
    if ("nav" in input) {
      if (input.nav === "escape" || input.nav === "back") this.closePanel();
      return; // a labelled list has no line/page navigation
    }
    const ch = input.ch;
    if (ch === "q" || ch === "Q") { this.closePanel(); return; }
    const idx = OVERLAY_LABELS.indexOf(ch.toLowerCase());
    if (idx >= 0 && idx < panel.docs.length) void this.openDoc(panel.docs[idx]!);
  }

  /** The inbox tab: a labelled list, exactly like docs — 1-9/a-z opens that
   *  review's full body. Nothing here can act on the queue or a merge. */
  private inboxTabInput(input: OverlayInput): void {
    if ("nav" in input) {
      if (input.nav === "escape" || input.nav === "back") this.closePanel();
      return; // a labelled list has no line/page navigation
    }
    const ch = input.ch;
    if (ch === "q" || ch === "Q") { this.closePanel(); return; }
    const idx = OVERLAY_LABELS.indexOf(ch.toLowerCase());
    const entries = this.inbox?.list() ?? [];
    if (idx >= 0 && idx < entries.length) this.openInboxItem(idx);
  }

  /** Open one filed review's full body, scrolled to the top. Same paging surface
   *  as a doc and the drilled diff. */
  private openInboxItem(index: number): void {
    if (!this.panel) return;
    const entry = this.inbox?.list()[index];
    if (!entry) return;
    this.panel.view = { kind: "inboxItem", entry, rows: renderInboxItem(entry, this.cols), scroll: 0 };
    this.paint();
  }

  /** A filed review's body: Backspace returns to the inbox list, Esc closes,
   *  everything else pages. There are no actions on a filed review — it is a
   *  record, not a gate. */
  private inboxItemInput(input: OverlayInput): void {
    if ("nav" in input) {
      if (input.nav === "escape") { this.closePanel(); return; }
      if (input.nav === "back") { this.backToInbox(); return; }
      this.overlayScrollInput(input);
      return;
    }
    if (input.ch === "q") { this.closePanel(); return; }
    this.overlayScrollInput(input);
  }

  /** Return from a filed review to the inbox list. */
  private backToInbox(): void {
    if (!this.panel) return;
    this.panel.view = { kind: "inbox" };
    this.paint();
  }

  private overlayDocInput(input: OverlayInput): void {
    if ("nav" in input) {
      if (input.nav === "escape") { this.closePanel(); return; }
      if (input.nav === "back") { this.backToList(); return; }
      this.overlayScrollInput(input);
      return;
    }
    // `y` yanks the whole doc, checked before the paging surface so the copy can
    // never be shadowed by a scroll key. It is the ONLY action on this view, and
    // it lives here rather than in overlayScrollInput so the filed-review body -
    // which shares that paging surface - keeps the key space it already had.
    if (input.ch === "y") { this.copyDoc(); return; }
    if (input.ch === "q") { this.closePanel(); return; }
    this.overlayScrollInput(input);
  }

  /**
   * `y` on an open doc: copy it to the system clipboard via OSC 52.
   *
   * The RAW markdown, not the rows on screen. What the captain wants back is the
   * document he authored - a command cheat-sheet he can paste somewhere useful -
   * and the painted version is ANSI-styled and hard-wrapped to whatever width
   * this terminal happens to be, which pastes as junk. `content` is verbatim
   * what DocSource.read returned, so the clipboard gets the file.
   *
   * Nothing here touches mouse reporting, the Kitty flags or the alt screen: the
   * copy is one escape sequence written mid-frame, which moves no cursor and
   * disturbs no mode. It is the same mechanism the transcript's drag-selection
   * already uses, so a doc copies exactly the way a selection does.
   */
  private copyDoc(): void {
    if (!this.panel || this.panel.view.kind !== "doc") return;
    const { content, error } = this.panel.view;
    if (error !== null || content === "") {
      this.panel.copyNotice = "nothing to copy";
      this.paint();
      return;
    }
    this.copyToClipboard(content);
    this.panel.copyNotice = copyReceipt(countLines(content));
    this.paint();
  }

  // --- selecting text inside the panel ----------------------------------------
  //
  // The panel owns the whole screen while it is up, and mouse reporting stays on
  // underneath it, so the terminal will not do its own click-drag here. It gets
  // the same treatment the transcript already gets: a left-drag highlights the
  // cells in reverse video and, on release, copies the plain text through OSC 52.
  //
  // This works on EVERY panel view, not just a doc - the body is one surface, so
  // a PR link on the queue tab or a paragraph of a filed review copies exactly
  // the way a paragraph of a doc does. It is purely additive: no key binding
  // moves, and a click with no drag copies nothing.
  //
  // What it yields is the RENDERED text, wrapped as painted, which is the whole
  // point of a partial selection. `y` remains the way to take a doc away whole,
  // in its raw markdown.

  /**
   * Handle an SGR mouse report while the panel is up. `body` is "b;x;y" (1-based
   * screen coords); `press` is true for the M terminator (button-down/motion)
   * and false for m (release). Bit layout as in handleMouse: low two bits are
   * the button, 32 is motion, 64 is the wheel.
   */
  private handlePanelMouse(body: string, press: boolean): void {
    const parts = body.split(";");
    const b = Number.parseInt(parts[0] ?? "", 10);
    const x = Number.parseInt(parts[1] ?? "", 10);
    const y = Number.parseInt(parts[2] ?? "", 10);
    if (Number.isNaN(b)) return;

    if (b === 64) { this.overlayScrollBy(-3); return; }
    if (b === 65) { this.overlayScrollBy(3); return; }

    const button = b & 0b11;
    const motion = (b & 32) !== 0;
    if (button !== 0) return;

    if (!motion && press) this.beginPanelSelection(x, y);
    else if (motion && press) this.extendPanelSelection(x, y);
    else if (!press) this.endPanelSelection();
  }

  /**
   * Map a 1-based screen (x, y) to an absolute (row, col) in the current body.
   *
   * Screen row 1 is the header and the last row is the footer, so the body
   * occupies rows 2..rows-1 and `y - 2` is the offset into the viewport. A drag
   * that strays onto the header or the footer clamps into the body instead of
   * being dropped, so running off the top or bottom edge still selects sensibly.
   */
  private panelMouseToCell(x: number, y: number): { row: number; col: number } | null {
    const panel = this.panel;
    if (!panel) return null;
    const rowInView = Math.max(0, Math.min(this.overlayViewport() - 1, y - 2));
    return { row: panel.lastStart + rowInView, col: Math.max(0, x - 1) };
  }

  private beginPanelSelection(x: number, y: number): void {
    const panel = this.panel;
    const cell = this.panelMouseToCell(x, y);
    if (!panel || !cell) return;
    // A fresh drag retires the previous copy's receipt: it described a selection
    // that is about to stop existing.
    panel.copyNotice = null;
    panel.selecting = true;
    panel.selection = {
      anchorRow: cell.row,
      anchorCol: cell.col,
      focusRow: cell.row,
      focusCol: cell.col,
    };
    this.paint();
  }

  private extendPanelSelection(x: number, y: number): void {
    const panel = this.panel;
    if (!panel?.selecting || !panel.selection) return;
    const cell = this.panelMouseToCell(x, y);
    if (!cell) return;
    // Auto-scroll at the body's edges so a selection can span more than one
    // screenful. The rows are absolute, so the anchor stays put as it scrolls.
    if (y <= 2) this.overlayScrollBy(-1);
    else if (y >= this.rows - 1) this.overlayScrollBy(1);
    panel.selection.focusRow = cell.row;
    panel.selection.focusCol = cell.col;
    this.paint();
  }

  /**
   * Left release: finalize. A bare click (press and release on the same cell)
   * selected nothing, so it just dismisses any standing highlight rather than
   * copying an empty string - which is also what makes a stray click on the
   * queue tab harmless.
   */
  private endPanelSelection(): void {
    const panel = this.panel;
    if (!panel?.selecting) return;
    panel.selecting = false;
    const sel = panel.selection;
    const dragged =
      sel != null && (sel.anchorRow !== sel.focusRow || sel.anchorCol !== sel.focusCol);
    const text = dragged ? this.panelSelectionText() : "";
    if (text === "") {
      panel.selection = null;
      this.paint();
      return;
    }
    this.copyToClipboard(text);
    panel.copyNotice = copyReceipt(countLines(text));
    this.paint();
  }

  /** The plain text of the panel's current selection, joined with newlines. */
  private panelSelectionText(): string {
    const sel = this.panel?.selection;
    if (!sel) return "";
    const { top, bottom, topCol, bottomCol } = normalizeSelection(sel);
    const { body } = this.panelFrame();
    const out: string[] = [];
    // Clamped to the real body, so a drag that ran past the end doesn't tack
    // phantom blank lines onto the clipboard.
    for (let r = top; r <= bottom && r < body.length; r++) {
      const from = r === top ? topCol : 0;
      const to = r === bottom ? bottomCol : Number.MAX_SAFE_INTEGER;
      out.push(sliceVisibleText(body[r] ?? "", from, to));
    }
    return out.join("\n");
  }

  /**
   * Overlay the selection highlight onto the body row at absolute index
   * `absRow`. Rows outside the selection come back untouched.
   *
   * An empty row inside the selection is painted as a single highlighted space.
   * highlightRange returns a blank row unchanged (there is nothing to reverse),
   * which in the transcript is invisible but in a doc would tear every selection
   * spanning a paragraph break into stripes. The space is presentational only -
   * the copy reads the original row, so a blank line stays blank.
   */
  private applyPanelSelection(line: string, absRow: number): string {
    const sel = this.panel?.selection;
    if (!sel) return line;
    const { top, bottom, topCol, bottomCol } = normalizeSelection(sel);
    if (absRow < top || absRow > bottom) return line;
    const from = absRow === top ? topCol : 0;
    const to = absRow === bottom ? bottomCol : Number.MAX_SAFE_INTEGER;
    if (line === "" && absRow > top && absRow < bottom) return `${ESC}[7m ${ESC}[27m`;
    return highlightRange(line, from, to);
  }

  /** Drop any panel selection and its receipt. Called wherever the rows beneath
   *  a selection stop meaning what they meant when it was made. */
  private clearPanelSelection(): void {
    const panel = this.panel;
    if (!panel) return;
    if (!panel.selection && !panel.selecting && panel.copyNotice === null) return;
    panel.selection = null;
    panel.selecting = false;
    panel.copyNotice = null;
    this.paint();
  }

  /** Retire the queue tab's save receipt, the way clearPanelSelection retires a
   *  copy one: same rule, same moment, one line each. Only an `ok` line is a
   *  receipt — a refusal or a discarded edit is a standing message and is left
   *  exactly where it is (see queueEditNotice). */
  private clearQueueEditReceipt(): void {
    if (!this.queueEditNotice?.ok) return;
    this.queueEditNotice = null;
    this.paint();
  }

  /** The drilled review view (full paged diff): m/r act, Backspace returns to the
   *  queue tab, Esc closes the panel (the review stays pending — only [r] rejects
   *  it); everything else pages. A merge in flight locks out m/r/Esc/back: it
   *  can't be cancelled or left, so only paging is live until it settles. */
  private reviewViewInput(input: OverlayInput): void {
    const merging = this.pendingReview?.status === "merging";
    if ("nav" in input) {
      if (!merging && input.nav === "escape") { this.closePanel(); return; }
      if (!merging && input.nav === "back") {
        if (this.panel) { this.panel.view = this.queue ? { kind: "queue" } : { kind: "review" }; this.paint(); }
        return;
      }
      this.overlayScrollInput(input);
      return;
    }
    if (!merging) {
      if (input.ch === "m") { this.approveLanding(); return; }
      if (input.ch === "r") { this.rejectReview(); return; }
    }
    this.overlayScrollInput(input);
  }

  /**
   * The less-style paging shared by every scrollable panel body (a doc, the
   * drilled diff): space/f/b page, d/u half, j/k line, g/G ends, plus the nav
   * keys. Escape/back are NOT here - each view owns its exits, so a paging key
   * can never dismiss the panel or a review by accident. Returns false for keys
   * that aren't paging so callers can tell an ignored key from a scrolled one.
   */
  private overlayScrollInput(input: OverlayInput): boolean {
    const half = Math.max(1, Math.floor(this.overlayPage() / 2));
    if ("nav" in input) {
      switch (input.nav) {
        case "up": this.overlayScrollBy(-1); return true;
        case "down": this.overlayScrollBy(1); return true;
        case "pageup": this.overlayScrollBy(-this.overlayPage()); return true;
        case "pagedown": this.overlayScrollBy(this.overlayPage()); return true;
        case "halfup": this.overlayScrollBy(-half); return true;
        case "halfdown": this.overlayScrollBy(half); return true;
        case "top": this.overlayScrollTo(0); return true;
        case "bottom": this.overlayScrollTo(Number.MAX_SAFE_INTEGER); return true;
        default: return false;
      }
    }
    switch (input.ch) {
      case " ":
      case "f": this.overlayScrollBy(this.overlayPage()); return true;
      case "b": this.overlayScrollBy(-this.overlayPage()); return true;
      case "d": this.overlayScrollBy(half); return true;
      case "u": this.overlayScrollBy(-half); return true;
      case "j": this.overlayScrollBy(1); return true;
      case "k": this.overlayScrollBy(-1); return true;
      case "g": this.overlayScrollTo(0); return true;
      case "G": this.overlayScrollTo(Number.MAX_SAFE_INTEGER); return true;
      default: return false;
    }
  }

  // --- the merge review (in-panel) --------------------------------------------
  //
  // The human approval surface between prepareLanding and executeLanding, now
  // hosted INSIDE the panel rather than as a separate modal overlay. A prepared
  // feature is registered as `pendingReview` (tracked apart from the panel's
  // open/closed state); the panel's queue tab shows its summary + action bar, and
  // [d] drills into the full paged diff. The merge fires ONLY from the [m]
  // keystroke here — review.execute() is called nowhere else, never on a timer,
  // never on close. openLandingReview no longer force-opens the screen: it flashes
  // a hint and lets the captain open the panel (D-20260723-25).

  /**
   * Register a prepared feature for the captain's verdict and wait for it.
   * Resolves "merged" after review.execute() succeeds, "rejected" when dismissed
   * with no merge ([r] or session teardown), and "failed" when a merge attempt
   * was refused and then dismissed. Does NOT open the panel — it flashes a hint;
   * the captain opens the panel (Ctrl-O) to act. A second review settles any
   * prior one as rejected first (serial queue: there is only ever one at a time).
   */
  openLandingReview(review: LandingReview): Promise<LandingGateOutcome> {
    return new Promise((resolve) => {
      // Displace any prior pending review (shouldn't happen in the serial flow,
      // but never strand a caller): settle it as rejected unless mid-merge.
      const prior = this.pendingReview;
      if (prior && prior.status !== "merging") prior.settle("rejected");
      let settled = false;
      const pr: PendingReview = {
        review,
        status: "review",
        error: null,
        rows: [],
        scroll: 0,
        settle: (outcome) => {
          if (settled) return;
          settled = true;
          resolve(outcome);
        },
      };
      pr.rows = renderLandingBody(review, pr.status, pr.error, this.cols);
      this.pendingReview = pr;
      // If the panel is open on the queue tab, the new review shows immediately;
      // otherwise flash a hint so the captain knows to open it. Never auto-pop.
      if (this.panel) this.paint();
      else this.setStatus(`review ready for ${review.feature} — press Ctrl-O to review & merge`);
    });
  }

  /**
   * The queue tab's [m] (D-20260724-12): merge the ready head, now. This is the
   * whole happy path — no gate is opened, no promise is armed, no tool call is
   * made, and nothing anywhere is parked waiting on this keystroke; the co is
   * free the entire time and finds out only if the NEXT head comes back blocked.
   *
   * It is a strict no-op unless the source itself reports a ready head with
   * commits: a blocked, processing or resolving head has no [m] at all, so a
   * stray press does nothing. Fire-once while in flight (queueMerging), for the
   * same reason the gate's [m] was: a double-tap must not mint two merges.
   */
  private mergeReadyHead(): void {
    const merge = this.queue?.merge;
    if (!this.queue || !merge || this.queueMerging) return;
    const head = this.mergeableHead();
    if (!head) return;

    this.queueMerging = head.feature;
    this.queueMergeError = null;
    this.paint();
    const done = (): void => {
      this.queueMerging = null;
      // The body is a different head now (or gone): start it at the top rather
      // than stranding the captain deep in the previous head's diff.
      if (this.panel) this.panel.queueScroll = 0;
    };
    void merge.call(this.queue).then(
      (res) => {
        done();
        if (!res.merged) this.queueMergeError = res.error ?? res.summary;
        this.paint();
        this.setStatus(res.summary);
      },
      (e: unknown) => {
        done();
        this.queueMergeError = e instanceof Error ? e.message : String(e);
        this.paint();
      },
    );
  }

  /**
   * The [m] keystroke - the ONE call site of review.execute(), and therefore the
   * only way a merge can happen. Fire-once: flipping to "merging" synchronously
   * makes a repeat press a no-op before the promise ever settles. Success settles
   * "merged" and clears the review with the confirmation flashed; refusal/failure
   * keeps the review with the error rendered in place and [m] off — the cure for a
   * stale green is a fresh prepare, not a retry from here.
   */
  private approveLanding(): void {
    const pr = this.pendingReview;
    if (!pr) return;
    const p = pr.review.prepared;
    if (pr.status !== "review" || p.kind !== "green" || p.commits.length === 0) return;
    pr.status = "merging";
    pr.rows = renderLandingBody(pr.review, pr.status, pr.error, this.cols);
    this.paint();
    void pr.review.execute().then(
      (confirmation) => {
        pr.settle("merged");
        if (this.pendingReview !== pr) return; // displaced since (shouldn't happen)
        this.pendingReview = null;
        this.leaveSettledReview();
        this.paint();
        this.setStatus(confirmation);
      },
      (e: unknown) => {
        pr.status = "failed";
        pr.error = e instanceof Error ? e.message : String(e);
        pr.rows = renderLandingBody(pr.review, pr.status, pr.error, this.cols);
        pr.scroll = 0; // the error banners at the top; make sure it's seen
        if (this.pendingReview === pr) this.paint();
      },
    );
  }

  /** [r]: dismiss the review with no merge. From "review" this is a rejection
   *  (the feature's branch and worktree stay intact); from "failed" it closes a
   *  review whose merge attempt was refused. Ignored mid-merge: a merge in flight
   *  can't be cancelled, so it waits for its outcome. Returns to the queue tab. */
  private rejectReview(): void {
    const pr = this.pendingReview;
    if (!pr || pr.status === "merging") return;
    pr.settle(pr.status === "failed" ? "failed" : "rejected");
    this.pendingReview = null;
    this.leaveSettledReview();
    this.paint();
  }

  /** After a feature_land review is settled (merged/rejected), leave its view.
   *  Fall back to the first remaining home tab — the queue if one is wired, else
   *  docs, else the inbox — and close the panel when nothing else is left to show
   *  (a review-only panel). */
  private leaveSettledReview(): void {
    if (!this.panel) return;
    if (this.panel.view.kind !== "review") return;
    const next = this.panelTabs().find((t) => t !== "review");
    if (next) this.panel.view = this.homeView(next);
    else this.closePanel();
  }

  // --- the PR message editor (in-panel popup) ---------------------------------
  //
  // `e` on a queue head whose pull request exists opens a small popup over the
  // tab holding that PR's own prose: line 1 the title, a blank line, then the
  // description (D-20260727-15). Ctrl-S writes it to GitHub through the injected
  // `editPrMessage`; Esc cancels, warning once when the buffer is dirty.
  //
  // Three properties are load-bearing:
  //
  //  - IT EDITS PROSE ONLY. co's fenced evidence block never enters the buffer
  //    (the source hands the panel a body already split at the fence) and never
  //    leaves it, so the captain cannot see, break or delete the block that the
  //    harness regenerates on every head processing.
  //  - IT IS THE SAME EDITOR AS THE PROMPT. The buffer model, the wrapping and
  //    the cursor mapping are ./editor's, shared with the input bar; the keys
  //    come off the same decode table. There are no modes to enter and nothing
  //    new to learn — except that Enter inserts a newline here, because a
  //    description is prose and there is nothing to send.
  //  - SAVING NEVER MERGES. It writes a title and a body and nothing else: the
  //    head's status, its checks, its `[m]` and the queue's order are exactly
  //    where they were, and `[m]` remains a separate, deliberate keystroke.

  /**
   * The popup's geometry, derived from the screen every time it is needed rather
   * than stored: a resize then re-lays it out instead of tearing (the same rule
   * the animation region follows). `textRows` is the buffer viewport's height;
   * the box also carries two borders and one message line.
   *
   * IT TAKES THE MAJORITY OF THE TERMINAL, because the job it exists for is
   * replacing a whole description, and fourteen rows of a forty-line body is a
   * keyhole. Both axes are a percentage of the screen with a floor and a ceiling:
   *
   *   width  90% of the columns, min 32, max 120 (never wider than cols - 2)
   *   height 90% of the panel body (rows - 2), min 7, max 44 rows
   *
   * The floors keep it usable on a small terminal (the clamp to cols-2 / the body
   * height wins over them, so the box never overflows a screen too small to hold
   * its own minimum); the ceilings stop a full-screen terminal from producing a
   * 200-column line length nobody can read a sentence across.
   */
  private prEditBox(): { left: number; top: number; width: number; textRows: number } {
    const width = Math.max(
      1,
      Math.min(this.cols - 2, Math.max(32, Math.min(120, Math.floor(this.cols * 0.9)))),
    );
    // The panel body is rows 2..rows-1; the box lives inside that, never over
    // the tab bar or the footer.
    const body = Math.max(1, this.rows - 2);
    const height = Math.max(4, Math.min(body, Math.max(7, Math.min(44, Math.floor(body * 0.9)))));
    const textRows = Math.max(1, height - 3);
    const left = 1 + Math.max(0, Math.floor((this.cols - width) / 2));
    const top = Math.max(2, Math.min(1 + Math.floor((this.rows - height) / 2), this.rows - height));
    return { left, top, width, textRows };
  }

  /** Columns of buffer text inside the box (border + one space on each side). */
  private prEditWidth(): number {
    return Math.max(1, this.prEditBox().width - 4);
  }

  /**
   * `e` on the queue tab: open the head PR's message in the popup.
   *
   * A strict no-op with a stated reason unless there is something to edit — a
   * wired edit callback and a head that actually HAS a pull request. A head
   * still processing, or one whose prepare never got as far as opening a PR, has
   * no message to rewrite, and saying so beats a popup over nothing.
   */
  private openPrEditor(): void {
    const panel = this.panel;
    if (!panel) return;
    const refuse = (text: string): void => {
      this.queueEditNotice = { text, ok: false };
      this.paint();
    };
    if (!this.queue?.editPrMessage) {
      refuse("editing a pull request message isn't available in this session.");
      return;
    }
    const detail = this.queue.headDetail?.() ?? null;
    const pr = detail?.pr;
    if (!detail || !pr) {
      refuse("this head has no pull request yet — nothing to edit. One opens when the head is processed.");
      return;
    }
    // `prose` is the body with co's evidence fence already split off by the
    // source. A source that doesn't split falls back to the raw body, exactly as
    // the painted message does.
    const prose = (pr.prose ?? pr.body).trim();
    panel.prEdit = {
      editor: new TextEditor(joinMessage(pr.title, prose)),
      prNumber: pr.number,
      feature: detail.feature,
      scroll: 0,
      status: "editing",
      error: null,
      escPending: false,
      pasting: false,
      pasteBuf: "",
      dragging: false,
      notice: null,
    };
    panel.view = { kind: "prEdit" };
    this.queueEditNotice = null;
    this.clearPanelSelection();
    this.paint();
  }

  /** Leave the editor for the queue tab underneath, optionally leaving a line
   *  behind on it. Never called while a save is in flight. */
  private closePrEditor(notice?: { text: string; ok: boolean }): void {
    const panel = this.panel;
    if (!panel) return;
    // A save can land mid-paste (the popup closes on success while the terminal
    // is still feeding us the payload). Hand the paste over to the tab's own
    // swallower rather than let its remaining bytes arrive as panel keys.
    if (panel.prEdit?.pasting) this.overlayPasting = true;
    panel.prEdit = null;
    if (panel.view.kind === "prEdit") panel.view = { kind: "queue" };
    if (notice) this.queueEditNotice = notice;
    this.paint();
  }

  /** Esc: cancel. A clean buffer leaves at once; a dirty one warns first and
   *  discards on the second consecutive Esc, so a whole rewritten description is
   *  never one stray keypress from gone. */
  private escapePrEditor(wasEscPending: boolean): void {
    const state = this.panel?.prEdit;
    if (!state) return;
    if (state.editor.dirty && !wasEscPending) {
      state.escPending = true;
      this.paint();
      return;
    }
    this.closePrEditor(
      state.editor.dirty
        ? { text: `discarded the unsaved edit to PR #${state.prNumber}`, ok: false }
        : undefined,
    );
  }

  /**
   * Parse one key/sequence while the PR editor owns the keyboard. Mirrors the
   * prompt's consume(): the same escape/CSI shapes, decoded by the same table,
   * so every binding behaves identically in both editors.
   */
  private consumePrEdit(data: string, i: number): number {
    const state = this.panel?.prEdit;
    if (!state) return 1;
    const saving = state.status === "saving";
    const ch = data[i]!;

    // Inside a bracketed paste every byte is opaque content, accumulated across
    // as many data events as the paste spans, and never parsed as keys. This is
    // the whole reason a multi-line description can be pasted at all: without it
    // the embedded newlines arrive as Enter presses and the CSI sequences in a
    // pasted diff arrive as arrow keys.
    if (state.pasting) return this.consumePrEditPaste(state, data, i);

    // The start of one. Checked before the generic CSI dispatch because the
    // marker itself begins with ESC [.
    if (data.startsWith(PASTE_START, i)) {
      state.pasting = true;
      state.pasteBuf = "";
      return PASTE_START.length;
    }
    // A stray end marker with no start (a paste that began before the popup
    // opened): swallow it rather than type its bytes.
    if (data.startsWith(PASTE_END, i)) return PASTE_END.length;

    // Alt+Enter as an ESC prefix, checked before the generic ESC dispatch for
    // the same reason the prompt checks it: otherwise it reads as a lone Escape.
    if (ch === ESC && (data[i + 1] === "\r" || data[i + 1] === "\n")) {
      if (!saving) this.prEditAction({ kind: "newline" });
      return 2;
    }
    if (ch === ESC && data[i + 1] === "[") return this.consumePrEditCsi(data, i);
    if (ch === ESC) {
      if (!saving) this.prEditAction({ kind: "escape" });
      return 1;
    }
    if (!saving) this.prEditAction(classifyByte(ch));
    return 1;
  }

  /**
   * Consume bytes while inside the popup's bracketed paste. Everything up to
   * PASTE_END is content; a chunk that ends without the marker is buffered and
   * we stay `pasting` for the next data event. Returns bytes consumed.
   *
   * The whole payload lands as ONE insert, so a 40-line body costs one repaint
   * and one undo-able edit rather than 2,000 keystrokes' worth of both.
   */
  private consumePrEditPaste(state: PrEditState, data: string, i: number): number {
    const end = data.indexOf(PASTE_END, i);
    if (end === -1) {
      state.pasteBuf += data.slice(i);
      return data.length - i;
    }
    state.pasteBuf += data.slice(i, end);
    const text = state.pasteBuf;
    state.pasting = false;
    state.pasteBuf = "";
    // A save in flight swallows the paste rather than queueing it: the same
    // fire-once interlock every other key obeys while gh is running.
    if (state.status !== "saving" && text !== "") {
      state.notice = null;
      state.escPending = false;
      // TextEditor.insert normalises CR/CRLF and strips the control bytes a
      // paste can carry, and replaces the selection when there is one, so
      // "select all, paste" swaps a description out in one gesture.
      state.editor.insert(text);
      this.paint();
    }
    return end - i + PASTE_END.length;
  }

  /** The CSI half of the editor's input: arrows, Home/End, Delete, the enhanced
   *  protocols' spellings, and mouse reports, which belong to the EDITOR while
   *  the popup is open (text selection), never to the panel underneath it. The
   *  handoff is this one branch: the panel's own drag handler is unreachable
   *  from here, and it resumes the moment the popup closes and the panel's input
   *  path takes CSI again. */
  private consumePrEditCsi(data: string, i: number): number {
    if (data[i + 2] === "<") {
      const end = this.findMouseEnd(data, i + 3);
      if (end === -1) return data.length - i;
      this.handlePrEditMouse(data.slice(i + 3, end), data[end] === "M");
      return end - i + 1;
    }
    let j = i + 2;
    while (j < data.length && !/[A-Za-z~]/.test(data[j]!)) j++;
    if (j >= data.length) return data.length - i;
    const final = data[j]!;
    const params = data.slice(i + 2, j);
    const consumed = j - i + 1;

    const state = this.panel?.prEdit;
    if (!state || state.status === "saving") return consumed;

    switch (final) {
      case "u": {
        const ev = parseCsiU(params);
        if (ev) this.prEditAction(classify(ev));
        return consumed;
      }
      case "A": this.prEditMoveRow(-1); return consumed;
      case "B": this.prEditMoveRow(1); return consumed;
      case "C": this.prEditEdit(() => state.editor.right()); return consumed;
      case "D": this.prEditEdit(() => state.editor.left()); return consumed;
      case "H": this.prEditAction({ kind: "home" }); return consumed;
      case "F": this.prEditAction({ kind: "end" }); return consumed;
      case "~": {
        const other = parseModifyOtherKeys(params);
        if (other) {
          this.prEditAction(classify(other));
          return consumed;
        }
        const n = Number.parseInt(params, 10);
        if (n === 3) this.prEditEdit(() => state.editor.deleteForward());
        else if (n === 5) this.prEditPage(-1);
        else if (n === 6) this.prEditPage(1);
        else if (n === 1 || n === 7) this.prEditAction({ kind: "home" });
        else if (n === 4 || n === 8) this.prEditAction({ kind: "end" });
        return consumed;
      }
      default:
        return consumed;
    }
  }

  /**
   * Apply one decoded action to the buffer. Every binding the prompt has means
   * the same thing here, with exactly two deliberate differences: Enter inserts
   * a newline instead of sending (a description is prose, and Ctrl-S is the
   * commit), and Ctrl-O leaves through this view's own exit rather than closing
   * the panel out from under an unsaved buffer.
   */
  private prEditAction(action: Action): void {
    const state = this.panel?.prEdit;
    if (!state || state.status === "saving") return;
    const editor = state.editor;
    // Only another Escape consumes the discard arming; every other key disarms.
    const wasEscPending = state.escPending;
    if (action.kind !== "escape" && action.kind !== "open-docs") state.escPending = false;
    // A receipt describes a selection that the next key is about to change, so
    // it is retired here, and re-set below by the keys that earn a new one.
    state.notice = null;

    switch (action.kind) {
      case "insert":
        editor.insert(action.text);
        break;
      // A bare Enter and every modified spelling of it do the same thing here.
      case "newline":
      case "submit":
        editor.insert("\n");
        break;
      case "backspace":
        editor.backspace();
        break;
      case "home":
        editor.home();
        break;
      case "end":
        editor.end();
        break;
      case "kill-to-start":
        editor.killToStart();
        break;
      case "kill-to-end":
        editor.killToEnd();
        break;
      // The three buffer-scoped verbs. Ctrl-A/E/U/K stay line-scoped, because a
      // description is many lines and they mean what they mean everywhere else,
      // so wholesale work gets keys of its own.
      case "select-all":
        editor.selectAll();
        break;
      case "clear-all": {
        // A cut, not a wipe: what it removes goes to the clipboard first, so the
        // one key that can empty a forty-line body never empties it into nothing.
        const gone = editor.clearAll();
        if (gone !== "") {
          this.copyToClipboard(gone);
          state.notice = `cleared · ${countLines(gone)} line${countLines(gone) === 1 ? "" : "s"} on the clipboard`;
        }
        break;
      }
      case "copy": {
        // The selection, or the whole buffer when nothing is selected: the same
        // "give me this bit" / "give me the lot" pair the doc view has.
        const text = editor.selectedText() || editor.text;
        if (text === "") break;
        this.copyToClipboard(text);
        state.notice = copyReceipt(countLines(text));
        break;
      }
      case "save":
        this.savePrMessage();
        return;
      case "escape":
      case "open-docs":
        this.escapePrEditor(wasEscPending);
        return;
      // Tab, Ctrl-C and Ctrl-D have nothing to do in this buffer, and must not
      // fall through to the panel's meanings for them (switch tab, quit).
      case "tab":
      case "interrupt":
      case "eof":
      case "none":
        break;
    }
    this.paint();
  }

  // --- selecting text inside the popup -----------------------------------------
  //
  // The popup owns the mouse for as long as it is open (consumePrEditCsi routes
  // every report here, and the panel's own drag handler is not reachable from
  // that path). A left-drag selects TEXT, not painted cells: the endpoints are
  // buffer offsets, so the selection survives a re-wrap, and therefore a resize,
  // where the panel's row/col selection has to be dropped. On release the
  // selected text goes to the system clipboard through the same OSC 52 write the
  // panel and the transcript use.

  /**
   * An SGR mouse report while the popup is open. Same wire format and bit layout
   * as handleMouse: low two bits the button, 32 motion, 64 the wheel.
   */
  private handlePrEditMouse(body: string, press: boolean): void {
    const state = this.panel?.prEdit;
    if (!state || state.status === "saving") return;
    const parts = body.split(";");
    const b = Number.parseInt(parts[0] ?? "", 10);
    const x = Number.parseInt(parts[1] ?? "", 10);
    const y = Number.parseInt(parts[2] ?? "", 10);
    if (Number.isNaN(b)) return;

    // The wheel scrolls by MOVING THE CARET, the way PgUp/PgDn already do here.
    // The popup's scroll is derived from the caret on every paint (see
    // prEditFrame), so this keeps one invariant (the caret is always on screen
    // and the hardware cursor is always where the text cursor is) instead of
    // introducing a second, free-floating scroll that a keystroke would snap back.
    if (b === 64) { this.prEditScroll(-1, 3); return; }
    if (b === 65) { this.prEditScroll(1, 3); return; }

    const button = b & 0b11;
    const motion = (b & 32) !== 0;
    if (button !== 0) return;

    if (!motion && press) this.beginPrEditSelection(x, y);
    else if (motion && press) this.extendPrEditSelection(x, y);
    else if (!press) this.endPrEditSelection();
  }

  /** Scroll by moving the caret `steps` visual rows, and repaint. */
  private prEditScroll(delta: 1 | -1, steps: number): void {
    const state = this.panel?.prEdit;
    if (!state || state.status === "saving") return;
    state.escPending = false;
    state.notice = null;
    const width = this.prEditWidth();
    for (let n = 0; n < steps; n++) {
      if (!state.editor.moveRow(delta, width)) break;
    }
    this.paint();
  }

  /**
   * Map a 1-based screen (x, y) onto a visual (row, col) of the buffer.
   *
   * `inside` is false when the point is off the box's text area entirely, and a
   * press there starts nothing. A DRAG that strays off the top or the bottom
   * targets the row just outside the viewport instead, which pulls the scroll by
   * one (the caret follows the drag, and the viewport follows the caret), so a
   * selection can run past a screenful in either direction.
   */
  private prEditCellAt(
    state: PrEditState,
    x: number,
    y: number,
  ): { row: number; col: number; inside: boolean } {
    const box = this.prEditBox();
    const firstRow = box.top + 1; // row 0 of the box is the top border
    const firstCol = box.left + 2; // "│" + one space
    const inner = Math.max(1, box.width - 4);
    const col = Math.max(0, x - firstCol);
    const inside =
      y >= firstRow && y < firstRow + box.textRows && x >= firstCol && x < firstCol + inner;
    let row: number;
    if (y < firstRow) row = state.scroll - 1;
    else if (y >= firstRow + box.textRows) row = state.scroll + box.textRows;
    else row = state.scroll + (y - firstRow);
    return { row: Math.max(0, row), col, inside };
  }

  /** Left press: anchor a selection at that character, and put the caret there.
   *  A press outside the box's text area only dismisses a standing selection,
   *  because a stray click on the queue underneath must not start one. */
  private beginPrEditSelection(x: number, y: number): void {
    const state = this.panel?.prEdit;
    if (!state || state.status === "saving") return;
    const cell = this.prEditCellAt(state, x, y);
    state.notice = null;
    state.escPending = false;
    if (!cell.inside) {
      state.editor.clearSelection();
      state.dragging = false;
      this.paint();
      return;
    }
    state.dragging = true;
    state.editor.anchorAt(state.editor.offsetAt(cell.row, cell.col, this.prEditWidth()));
    this.paint();
  }

  private extendPrEditSelection(x: number, y: number): void {
    const state = this.panel?.prEdit;
    if (!state || !state.dragging || state.status === "saving") return;
    const cell = this.prEditCellAt(state, x, y);
    state.editor.extendTo(state.editor.offsetAt(cell.row, cell.col, this.prEditWidth()));
    this.paint();
  }

  /** Left release: a drag that selected something copies it, the same way a drag
   *  over the panel body does. A bare click selected nothing and copies nothing:
   *  it just moved the caret, which is what a click in a text box is for. */
  private endPrEditSelection(): void {
    const state = this.panel?.prEdit;
    if (!state || !state.dragging) return;
    state.dragging = false;
    const text = state.editor.selectedText();
    if (text === "") {
      this.paint();
      return;
    }
    this.copyToClipboard(text);
    state.notice = copyReceipt(countLines(text));
    this.paint();
  }

  /** Run a buffer mutation and repaint. The scroll follows on the next paint. */
  private prEditEdit(fn: () => void): void {
    const state = this.panel?.prEdit;
    if (!state || state.status === "saving") return;
    state.escPending = false;
    state.notice = null;
    fn();
    this.paint();
  }

  /** Up/Down: one visual row, clamped at both ends. There is no history here to
   *  fall through to, since this buffer is the only thing the keys address. */
  private prEditMoveRow(delta: 1 | -1): void {
    this.prEditScroll(delta, 1);
  }

  /** PgUp/PgDn: a viewport of rows at a time, by the same clamped row move. */
  private prEditPage(delta: 1 | -1): void {
    this.prEditScroll(delta, this.prEditBox().textRows);
  }

  /**
   * Ctrl-S: write the buffer to the pull request.
   *
   * Fire-once while in flight, like the queue merge. An empty title is refused
   * HERE, before anything is sent, with the buffer left exactly as it is — gh
   * would reject it anyway, and a refusal the captain can act on beats a stack
   * trace from a subprocess. A failed save is the same: the popup stays open
   * over the captain's text with the failure printed in it, so an edit is never
   * silently dropped. Only a save that actually landed closes the popup, and
   * what the tab paints afterwards is what the source read back from GitHub.
   */
  private savePrMessage(): void {
    const state = this.panel?.prEdit;
    if (!state || state.status === "saving") return;
    const source = this.queue;
    const save = source?.editPrMessage;
    if (!source || !save) {
      state.error = "editing a pull request message isn't available in this session.";
      this.paint();
      return;
    }
    const { title, body } = state.editor.message();
    if (title === "") {
      state.error = "line 1 is the title and it is empty — a pull request needs one. Nothing was sent.";
      this.paint();
      return;
    }
    state.status = "saving";
    state.error = null;
    state.escPending = false;
    this.paint();
    void save.call(source, { title, body, prNumber: state.prNumber }).then(
      (res) => {
        if (this.panel?.prEdit !== state) return; // closed or replaced since
        state.status = "editing";
        if (res.saved) {
          this.closePrEditor({ text: res.summary, ok: true });
          return;
        }
        state.error = res.error ?? res.summary;
        this.paint();
      },
      (e: unknown) => {
        if (this.panel?.prEdit !== state) return;
        state.status = "editing";
        state.error = e instanceof Error ? e.message : String(e);
        this.paint();
      },
    );
  }

  /**
   * The popup as painted rows, plus where the caret goes inside it (viewport
   * coordinates: row 0 is the first text row).
   *
   * The viewport scroll is recomputed here from the caret rather than tracked by
   * the key handlers, so every path that moves the caret — typing, arrows, a
   * kill, a resize that re-wraps everything — keeps it on screen for free.
   */
  private prEditFrame(state: PrEditState): { rows: string[]; cursorRow: number; cursorCol: number } {
    const { width, textRows } = this.prEditBox();
    const inner = Math.max(1, width - 4);
    const layout = state.editor.layout(inner);
    state.scroll = scrollToCursor(state.scroll, layout.cursorRow, textRows, layout.segs.length);

    const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - visibleWidth(s)));
    // The two borders carry the two things worth carrying: what is being edited,
    // and how to leave. Built as plain text and dimmed whole, so a colour reset
    // inside can't cancel the border's own styling.
    const border = (label: string, open: string, close: string): string => {
      const lead = "─ " + this.clip(label, Math.max(0, width - 6)) + " ";
      const fill = Math.max(0, width - visibleWidth(lead) - 2);
      return c.dim(open + lead + "─".repeat(fill) + close);
    };
    // The title line is the first BUFFER line, however many visual rows it takes.
    const titleEnd = state.editor.text.indexOf("\n");
    const sel = state.editor.selection;
    const rows: string[] = [
      border(`edit PR #${state.prNumber} · ${state.feature}`, "┌", "┐"),
    ];
    for (let r = 0; r < textRows; r++) {
      const idx = state.scroll + r;
      const seg = layout.segs[idx];
      const start = layout.starts[idx];
      const isTitle = seg !== undefined && start !== undefined && (titleEnd === -1 || start < titleEnd);
      let text = seg === undefined ? "" : isTitle ? c.bold(seg) : seg;
      if (sel && seg !== undefined && start !== undefined) {
        text = this.highlightSelectedRow(text, seg, start, layout.starts[idx + 1], sel);
      }
      rows.push(c.dim("│") + " " + pad(text, inner) + " " + c.dim("│"));
    }
    rows.push(c.dim("│") + " " + pad(this.prEditMessage(state, inner), inner) + " " + c.dim("│"));
    rows.push(border(this.prEditKeys(state, width), "└", "┘"));
    return { rows, cursorRow: layout.cursorRow - state.scroll, cursorCol: layout.cursorCol };
  }

  /**
   * Paint the part of one visual row that falls inside the selection.
   *
   * The row's span is [start, next) in BUFFER offsets, which is what makes this
   * width-agnostic: the same characters highlight at any wrapping. A row whose
   * newline is inside the selection highlights to its end (and an empty row
   * inside the selection gets one reversed space) so a multi-line selection
   * reads as one block instead of tearing into stripes at every line break,
   * the same rule applyPanelSelection follows, for the same reason.
   */
  private highlightSelectedRow(
    painted: string,
    seg: string,
    start: number,
    next: number | undefined,
    sel: { start: number; end: number },
  ): string {
    const stop = next ?? start + seg.length;
    if (sel.end <= start || sel.start > stop) return painted;
    const from = Math.max(0, Math.min(seg.length, sel.start - start));
    // A selection running past this row's end covers its line break too.
    const to = sel.end >= stop && stop > start ? seg.length : Math.max(0, Math.min(seg.length, sel.end - start));
    if (seg === "" && sel.start <= start && sel.end > start) return `${ESC}[7m ${ESC}[27m`;
    if (to <= from) return painted;
    return highlightRange(painted, from, to);
  }

  /**
   * The keys on the popup's bottom border, in tiers: the widest run that fits.
   * Save and cancel are never dropped (they are the two ways out); the wholesale
   * verbs go before them, and the drag hint goes first, because the gesture is
   * self-revealing where a key is not.
   */
  private prEditKeys(state: PrEditState, width: number): string {
    if (state.status === "saving") return "saving…";
    const room = Math.max(0, width - 6);
    const tiers = [
      "Ctrl-S save · Esc cancel · drag select · Ctrl-G all · Ctrl-X clear · Ctrl-Y copy",
      "Ctrl-S save · Esc cancel · Ctrl-G all · Ctrl-X clear · Ctrl-Y copy",
      "Ctrl-S save · Esc cancel · Ctrl-G all · Ctrl-X clear",
      "Ctrl-S save · Esc cancel",
    ];
    return tiers.find((t) => t.length <= room) ?? tiers[tiers.length - 1]!;
  }

  /** The popup's one message line: what it needs to say, most urgent first. */
  private prEditMessage(state: PrEditState, width: number): string {
    if (state.status === "saving") return c.cyan(this.clip(`writing PR #${state.prNumber}…`, width));
    if (state.escPending) {
      return c.yellow(this.clip("unsaved changes — Esc again to discard them", width));
    }
    if (state.error) return c.red(this.clip(state.error, width));
    // A copy/clear receipt outranks the dirty hint: it names something that just
    // happened, and it is gone on the next key either way.
    if (state.notice) {
      const terse = state.notice.replace("if nothing pastes, allow", "allow");
      return c.cyan(this.clip(visibleWidth(state.notice) <= width ? state.notice : terse, width));
    }
    if (state.editor.selection) {
      const n = countLines(state.editor.selectedText());
      return c.dim(this.clip(`${n} line${n === 1 ? "" : "s"} selected · Ctrl-Y copies · typing replaces`, width));
    }
    if (state.editor.dirty) return c.dim(this.clip("edited · Ctrl-S writes it to GitHub", width));
    return c.dim(this.clip("line 1 is the title · Enter inserts a newline", width));
  }

  /** Paint the full-screen panel: tab bar, content viewport, footer. */
  /**
   * What the panel is showing right now: which TAB the current view belongs to,
   * the detail that names it when the view is a sub-view of that tab (an open
   * doc's filename, a filed review's level), the body rows, and the body row the
   * viewport starts at.
   *
   * ONE source of truth for the view switch, read by the paint, the tab bar and
   * the mouse-selection copy alike — so a drag can only ever copy the rows that
   * were actually painted under it, and the bar can only ever highlight the tab
   * the body came from. The queue body is fetched before its scroll is read
   * because queueBody() clamps that scroll to the freshly-built row count.
   */
  private panelFrame(): {
    tab: PanelView["kind"];
    suffix: string;
    body: string[];
    start: number;
  } {
    const panel = this.panel;
    if (!panel) return { tab: "home", suffix: "", body: [], start: 0 };
    const v = panel.view;
    if (v.kind === "home") {
      const body = this.homeTabRows();
      // A feature landing (or being abandoned) shortens the list; never strand
      // the view past its end.
      const max = Math.max(0, body.length - this.overlayViewport());
      if (panel.homeScroll > max) panel.homeScroll = max;
      return { tab: "home", suffix: "", body, start: panel.homeScroll };
    }
    if (v.kind === "queue" || v.kind === "prEdit") {
      // The message editor is a POPUP over this tab, not a view of its own: the
      // queue stays painted underneath it (paintPanel overlays the box), so the
      // captain never loses sight of the head they are writing about.
      const body = this.queueBody();
      const suffix = panel.prEdit ? `edit PR #${panel.prEdit.prNumber}` : "";
      return { tab: "queue", suffix, body, start: panel.queueScroll };
    }
    if (v.kind === "docs") return { tab: "docs", suffix: "", body: this.docsTabRows(panel), start: 0 };
    if (v.kind === "doc") return { tab: "docs", suffix: v.name, body: v.rows, start: v.scroll };
    if (v.kind === "inbox") return { tab: "inbox", suffix: "", body: this.inboxTabRows(), start: 0 };
    if (v.kind === "inboxItem") {
      return {
        tab: "inbox",
        suffix: `${v.entry.level} ${v.entry.verdict}`,
        body: v.rows,
        start: v.scroll,
      };
    }
    const pr = this.pendingReview;
    return {
      tab: "review",
      suffix: pr ? `${pr.review.feature} → ${pr.review.target}` : "",
      body: pr ? pr.rows : ["", "  " + c.dim("no review is pending.")],
      start: pr ? pr.scroll : 0,
    };
  }

  private paintPanel(): void {
    const panel = this.panel;
    if (!panel) return;
    const w = this.cols;
    const vp = this.overlayViewport();
    const { tab, suffix, body, start } = this.panelFrame();
    panel.lastStart = start; // anchor for mapping mouse (x, y) → absolute body row

    const frame: string[] = [term.moveTo(1, 1) + term.clearLine + this.overlayHeader(tab, suffix)];
    for (let r = 0; r < vp; r++) {
      const absRow = start + r;
      const lineText = this.applyPanelSelection(body[absRow] ?? "", absRow);
      frame.push(term.moveTo(2 + r, 1) + term.clearLine + this.clip(lineText, w));
    }
    frame.push(term.moveTo(this.rows, 1) + term.clearLine + this.panelFooter(body.length, start, vp));

    // The PR message editor rides ON TOP of whatever the tab painted: its rows
    // are laid over the middle of the body, so the head it is about stays
    // visible around it. It is also the one panel view with a real text cursor,
    // so the caret is placed and shown instead of hidden.
    const edit = panel.view.kind === "prEdit" ? panel.prEdit : null;
    if (edit) {
      const box = this.prEditBox();
      const { rows: boxRows, cursorRow, cursorCol } = this.prEditFrame(edit);
      for (let r = 0; r < boxRows.length; r++) {
        frame.push(term.moveTo(box.top + r, box.left) + this.clip(boxRows[r]!, w));
      }
      frame.push(term.moveTo(box.top + 1 + cursorRow, box.left + 2 + cursorCol) + term.showCursor);
    } else {
      // Every other panel view has no text cursor; hide the hardware caret.
      frame.push(term.hideCursor);
    }
    this.out.write(frame.join(""));
  }

  /**
   * The tab bar: every tab the panel has, numbered, across the top of every view.
   *
   * This is the panel's only discovery surface. Before it, the tabs existed but
   * nothing on screen said so — the panel was usable by someone who already knew
   * Tab cycled it, and by nobody else. So each tab is drawn with the digit that
   * jumps to it (`2 queue`), and the ACTIVE one is drawn distinctly: cut out of
   * the reversed bar (reversed-off, so it reads as the raised tab) with colour,
   * and bracketed as `[2 queue]` when colour is off, because "which one am I on"
   * must not be a thing only a colour terminal can answer.
   *
   * `suffix` names what a SUB-VIEW of the active tab is showing (an open doc's
   * filename, a filed review's level, the PR the popup is editing) and rides
   * inside the active tab's own segment — `[3 docs · plan.md]` — so the bar says
   * where you are and what you are looking at in one line.
   *
   * It degrades in that order of value: the detail goes first, then the labels
   * (leaving `1 2 3 4`, which still says how many tabs there are and which one
   * you are on), and only a terminal too narrow even for that gets a clipped bar.
   * A tab is never dropped from the list, because a tab you cannot see is a tab
   * you do not know exists — which is the whole reason the bar is here.
   */
  private overlayHeader(active: PanelView["kind"], suffix = ""): string {
    const w = this.cols;
    const tabs = this.panelTabs();
    const activeTab = Tui.TAB_LABELS[active];
    const segments = (detail: boolean, labels: boolean): string[] =>
      tabs.map((t, i) => {
        const label = labels ? `${i + 1} ${Tui.TAB_LABELS[t]}` : `${i + 1}`;
        const on = Tui.TAB_LABELS[t] === activeTab;
        const text = on && detail && suffix !== "" ? `${label} · ${suffix}` : label;
        if (!colorEnabled) return on ? `[${text}]` : ` ${text} `;
        // Inside a reversed bar, turning the reverse OFF is what makes a segment
        // stand out — the active tab reads as a cut-out rather than as more of
        // the same block.
        return on ? `${ESC}[27m ${text} ${ESC}[7m` : ` ${text} `;
      });
    const width = (segs: string[]): number => segs.reduce((n, s) => n + visibleWidth(s), 0);
    const tiers = [segments(true, true), segments(false, true), segments(false, false)];
    const segs = tiers.find((t) => width(t) <= w) ?? tiers[tiers.length - 1]!;
    const bar = this.clip(segs.join(""), w) + " ".repeat(Math.max(0, w - width(segs)));
    return colorEnabled ? `${ESC}[7m${bar}${ESC}[27m` : bar;
  }

  /**
   * The queue tab's body, memoized. Rebuilt only when something it depends on
   * changed — the queue snapshot, the head's detail, the merge state, or the
   * width. Without this, streaming model output underneath would re-wrap a
   * possibly-huge inline diff on every 60fps frame for no reason.
   *
   * Also clamps the tab's scroll to the fresh row count, so a body that shrank
   * (the head merged and the next one is smaller) can't leave the view stranded
   * past its end.
   */
  private queueBody(): string[] {
    const panel = this.panel;
    if (!panel) return this.queueTabRows();
    const sig = this.queueSignature();
    if (sig !== panel.queueSig) {
      panel.queueRows = this.queueTabRows();
      panel.queueSig = sig;
    }
    const max = Math.max(0, panel.queueRows.length - this.overlayViewport());
    if (panel.queueScroll > max) panel.queueScroll = max;
    return panel.queueRows;
  }

  /** A cheap identity for everything the queue tab renders from. The detail's
   *  body is identified by its sizes rather than its content: a diff that
   *  changed at all changed the head, which changes the rest of the key. */
  private queueSignature(): string {
    if (!this.queue) return "none";
    const view = this.queue.view();
    const d = this.queue.headDetail?.() ?? null;
    const checksKey = (k: PanelChecks | undefined): string =>
      k ? `${k.verdict}:${k.total}:${k.failed}:${k.pending}:${k.ungated ? "u" : ""}` : "-";
    const detailKey = !d
      ? "-"
      : d.kind === "blocked"
        ? `b:${d.feature}:${d.blockedKind ?? "-"}:${d.reason.length}:${(d.detail ?? "").length}:${checksKey(d.checks)}`
        : `${d.kind === "ready" ? "r" : "w"}:${d.feature}:${d.commits.length}:${d.pr?.number ?? -1}:${
            d.pr?.body.length ?? 0
          }:${d.pr?.prose?.length ?? -1}:${checksKey(d.checks)}`;
    const entries = view.entries
      .map(
        (e) =>
          `${e.feature}/${e.status}/${e.commitsReady ?? ""}/${e.ungated ? "u" : ""}/${
            e.checksPending ?? ""
          }/${e.blockedKind ?? ""}/${e.resolveAttempts ?? ""}`,
      )
      .join(",");
    return `${this.cols}|${this.queueMerging ?? ""}|${this.queueMergeError ?? ""}|${
      this.queueEditNotice?.text ?? ""
    }|${entries}|${detailKey}`;
  }

  /**
   * The live merge queue as rows: the head first with its state, then the rest in
   * landing order, then the head's INLINE body — a ready head's commits, PR and
   * checks evidence, or a blocked head's reason (D-20260724-12). Everything
   * needed to decide the merge, in the same view as the key that performs it.
   * Read fresh from the QueuePanelSource.
   */
  private queueTabRows(): string[] {
    if (!this.queue) {
      return ["", "  " + c.dim("The merge queue isn't available in this session.")];
    }
    const view = this.queue.view();
    const rows: string[] = [""];
    if (this.queueMergeError) {
      rows.push("  " + c.red(`merge failed: ${this.queueMergeError}`));
      rows.push("");
    }
    if (this.queueEditNotice) {
      const n = this.queueEditNotice;
      rows.push("  " + (n.ok ? c.green(n.text) : c.yellow(n.text)));
      rows.push("");
    }
    if (view.size === 0) {
      rows.push("  " + c.dim("The merge queue is empty."));
      rows.push("  " + c.dim("Enqueue a finished feature (feature_enqueue) to line it up to land."));
      return rows;
    }
    for (const e of view.entries) {
      rows.push(...this.queueEntryRows(e));
    }
    // The head is position 1 (head-only invariant); derive it from entries so a
    // source that leaves `head` unset still drives the affordance.
    const detail = this.queue.headDetail?.() ?? null;
    const mergeable = this.mergeableHead();
    if (this.queueMerging) {
      rows.push("");
      rows.push("  " + c.cyan(`merging ${this.queueMerging}…`));
    } else if (mergeable) {
      rows.push("");
      const what = mergeable.prNumber
        ? ` to merge PR #${mergeable.prNumber}${mergeable.target ? ` into ${mergeable.target}` : ""}`
        : mergeable.target
          ? ` to merge it into ${mergeable.target}`
          : " to merge it";
      rows.push("  " + c.dim("this head is ready — press ") + c.cyan("m") + c.dim(what));
    }
    if (detail) {
      rows.push(...renderQueueHeadDetail(detail, this.cols));
    }
    return rows;
  }

  /** One queue entry as one or two rows: the position/feature/state line, plus a
   *  detail line for a blocked/ready/resolving head. */
  private queueEntryRows(e: QueuePanelEntry): string[] {
    const marker = e.isHead ? c.cyan("▸") : " ";
    const pos = c.dim(`${e.position}.`);
    const state = this.queueStateLabel(e);
    const line = `${marker} ${pos} ${e.feature}  ${state}`;
    const rows = ["  " + line];
    if (e.isHead) {
      if (e.status === "ready" && e.commitsReady !== undefined) {
        rows.push("      " + c.dim(`${e.commitsReady} commit${e.commitsReady === 1 ? "" : "s"} ready to land`));
        if (e.ungated) {
          rows.push("      " + c.yellow("no CI checks on its PR — merging is your judgment, not a green"));
        }
      } else if (e.status === "awaiting-checks") {
        rows.push(
          "      " +
            c.yellow(
              e.checksPending
                ? `waiting on ${e.checksPending} CI check${e.checksPending === 1 ? "" : "s"} on its pull request`
                : "waiting on its pull request's CI checks",
            ),
        );
      } else if (e.status === "blocked" && e.blockedReason) {
        rows.push("      " + c.red(e.blockedReason));
        if (e.blockedKind) {
          const spent = e.resolveAttempts ?? 0;
          rows.push(
            "      " +
              c.dim(
                spent > 0
                  ? `resolver attempts: ${spent} — the co can send a fresh agent again, or fix by hand`
                  : `the co can dispatch a fresh agent to fix it in its worktree (you confirm it)`,
              ),
          );
        }
      } else if (e.status === "resolving") {
        rows.push("      " + c.yellow(`a fresh crew agent is resolving this in its worktree (attempt ${e.resolveAttempts ?? 1})`));
      }
    }
    return rows;
  }

  /** The coloured one-word state chip for a queue entry. */
  private queueStateLabel(e: QueuePanelEntry): string {
    switch (e.status) {
      case "ready": return e.ungated ? c.yellow("[ready: ungated]") : c.green("[ready]");
      case "head-processing": return c.cyan("[processing]");
      case "awaiting-checks": return c.yellow("[awaiting checks]");
      case "resolving": return c.yellow("[resolving]");
      case "blocked": return c.red(`[blocked${e.blockedKind ? `: ${e.blockedKind === "conflict" ? "conflict" : "checks"}` : ""}]`);
      case "queued": return c.dim("[queued]");
    }
  }

  /**
   * The inbox tab as selectable rows, newest first: "1) [L2] fix-commit  the
   * headline". Level and verdict lead because they're what the captain scans for;
   * the body is one keypress away. Read fresh from the InboxPanelSource, so a
   * review filed while the panel is open shows on the next paint.
   */
  private inboxTabRows(): string[] {
    if (!this.inbox) return ["", "  " + c.dim("No review inbox in this session.")];
    const entries = this.inbox.list();
    if (entries.length === 0) {
      return [
        "",
        "  " + c.dim("No reviews filed yet."),
        "  " + c.dim("Every crew run the co reviews lands here — the last 20, newest first."),
      ];
    }
    const rows: string[] = [""];
    entries.forEach((e, idx) => {
      const label = OVERLAY_LABELS[idx];
      if (label === undefined) return; // beyond the label alphabet (cap keeps us inside it)
      // Laid out to the width HERE, like every other tab's rows. A row handed to
      // the painter wider than the screen falls into clip(), which truncates by
      // word-wrapping, and a wrap point drops a leading space run (wrap.ts). The
      // long entries would lose the two-space indent the short ones keep, and the
      // list's left edge would go ragged.
      const lead =
        "  " + c.cyan(`${label})`) + " " + levelChip(e.level) + " " +
          c.dim(e.verdict.padEnd(10)) + " ";
      rows.push(lead + clipCell(e.headline, this.cols - visibleWidth(lead)));
    });
    return rows;
  }

  /**
   * The Home tab: the panel's landing page, in two blocks — the co's at-a-glance
   * task table, then every tracked feature worktree.
   *
   * The two answer the two questions the captain opens the panel with. The table
   * is what we are doing (it used to exist only as prose the co re-printed into
   * the chat; it is a stored, painted thing now). The worktree list is what is in
   * flight — the view the queue tab cannot give, because the queue holds only
   * what has been marked done and everything still being worked is invisible
   * there.
   *
   * Both are read fresh from their sources, so a table rewritten or a feature
   * created while the panel is open shows on the next paint — and rebuilt at the
   * CURRENT width every paint, so a resize re-wraps everything here for free.
   *
   * A worktree's description is the one thing on its row that says what the work
   * is FOR, and cutting it with an ellipsis removed the overflow while leaving
   * the information unreadable — which was the complaint. So text that outgrows
   * its room wraps instead, and a long row costs a line or two rather than its
   * meaning.
   */
  private homeTabRows(): string[] {
    return [...this.taskTableRows(), "", ...this.worktreeRows()];
  }

  /** The task table: three columns, sized to their content and capped so one long
   *  row can never push Status off a narrow screen. */
  private taskTableRows(): string[] {
    const rows: string[] = ["", "  " + c.dim("tasks")];
    if (!this.tasks) return [...rows, ...this.homeNote("The task table isn't available in this session.")];
    const table = this.tasks.list();
    if (table.length === 0) {
      return [
        ...rows,
        ...this.homeNote("Nothing on the table."),
        ...this.homeNote("The co keeps a handful of live items here — ask it where things stand."),
      ];
    }
    // Columns hug their content — a Task column stretched to the width would put
    // Type and Status somewhere off by the right edge, with a river of blank
    // between. The task column is the one that gives when the terminal is narrow,
    // and it takes what the other two leave.
    const typeW = Math.min(12, Math.max(4, ...table.map((t) => t.type.length)));
    const statusW = Math.min(12, Math.max(6, ...table.map((t) => t.status.length)));
    const taskW = Math.max(
      8,
      Math.min(
        Math.max(4, ...table.map((t) => t.task.length)),
        this.cols - 4 - typeW - statusW - 4,
      ),
    );
    // Padded by VISIBLE width, never by String.padEnd: a status chip carries
    // colour, and padding the raw string would count the escape bytes as
    // characters and collapse the column.
    const line = (task: string, type: string, status: string): string =>
      `${pad(clipCell(task, taskW), taskW)}  ${pad(clipCell(type, typeW), typeW)}  ${clipCell(status, statusW)}`;
    rows.push("  " + c.dim(line("Task", "Type", "Status")));
    for (const t of table) {
      rows.push("  " + line(t.task, c.dim(t.type), this.taskStatusLabel(t.status)));
    }
    return rows;
  }

  /** A task's status, coloured by what it says. The vocabulary is the co's own,
   *  so this recognises the words that carry a warning and leaves the rest plain
   *  rather than pretending to know every word it might pick. */
  private taskStatusLabel(status: string): string {
    const s = status.toLowerCase();
    if (/block|stuck|fail|red/.test(s)) return c.red(status);
    if (/done|ready|green|shipped|landed/.test(s)) return c.green(status);
    if (/wait|pending|review|queue/.test(s)) return c.yellow(status);
    return status;
  }

  /** A line of explanation under a Home heading, wrapped rather than clipped. */
  private homeNote(text: string): string[] {
    return flowRow("  ", text, this.cols, c.dim);
  }

  /**
   * Every tracked feature worktree: the handle, its state, its branch and its
   * intent. The intent is the one thing git can't say about a branch — what it is
   * FOR — read straight from the stored text. No model call is made to describe
   * anything, at paint time or ever, and a feature that never got an intent says
   * so rather than showing a blank.
   */
  private worktreeRows(): string[] {
    const head: string[] = ["  " + c.dim("Worktrees"), ""];
    if (!this.features) {
      return [...head, ...this.homeNote("Feature worktrees aren't available in this session (not linked).")];
    }
    const entries = this.features.list();
    if (entries.length === 0) {
      return [
        ...head,
        ...this.homeNote("No feature worktrees yet."),
        ...this.homeNote("Each feature the co creates gets its own branch and checkout, and shows up here."),
      ];
    }
    // Columns as wide as their widest cell so the list reads DOWN — the states in
    // one column, the branches in another — rather than as ragged prose. The caps
    // bound the PADDING, not the text: a name or branch past its cap overflows
    // its own column instead of being cut, so it costs that one row's alignment
    // and never a character. Chips are measured by VISIBLE width: they carry
    // colour, and padding the raw string would count the escapes.
    const chips = entries.map((e) => {
      const crew = e.busy && e.status !== "working" ? " " + c.cyan("[crew]") : "";
      return this.featureStateLabel(e) + crew;
    });
    const nameW = Math.min(20, Math.max(...entries.map((e) => e.feature.length)));
    const chipW = Math.min(22, Math.max(...chips.map((s) => visibleWidth(s))));
    const branchW = Math.min(24, Math.max(...entries.map((e) => e.branch.length)));
    const rows = [...head];
    entries.forEach((e, idx) => {
      rows.push(...this.worktreeLines(e, chips[idx]!, nameW, chipW, branchW));
    });
    return rows;
  }

  /**
   * One worktree: marker, handle, state, branch, description.
   *
   * One line when the description fits beside the columns, which is the typical
   * row and the reason six worktrees usually stay six rows. When it doesn't fit,
   * the description drops underneath at a hanging indent and wraps to the FULL
   * width — reading it across the panel beats reading it down a narrow gutter,
   * and either way it is all there. The head keeps its own line in that case so
   * the columns above and below it still line up; only a head that outgrows the
   * terminal itself is packed across lines.
   */
  private worktreeLines(
    e: FeaturePanelEntry,
    chip: string,
    nameW: number,
    chipW: number,
    branchW: number,
  ): string[] {
    // A marker on the two states that want the eye: one that can be merged right
    // now, and one that is holding the queue up.
    const marker = e.status === "ready" ? c.green("▸") : e.status === "blocked" ? c.red("▸") : " ";
    const name = c.bold(e.feature);
    const branch = c.dim(e.branch);
    const head = `  ${marker} ${pad(name, nameW)}  ${pad(chip, chipW)}  ${pad(branch, branchW)}`;
    // Folded to one logical line before it is wrapped: a row is a row, and a
    // stored newline would otherwise punch through the panel's own layout.
    const intent = e.intent?.replace(/\s+/g, " ").trim();
    const text = intent ?? "no description — created without an intent";
    const style = intent ? undefined : c.dim;
    if (this.cols - visibleWidth(head) - 2 >= visibleWidth(text)) {
      return [`${head}  ${style ? style(text) : text}`];
    }
    const rows =
      visibleWidth(head) <= this.cols
        ? [head.replace(/\s+$/, "")]
        : packRow(`  ${marker} `, [name, chip, branch], this.cols, WORKTREE_HANG);
    return [...rows, ...flowRow(" ".repeat(WORKTREE_HANG), text, this.cols, style)];
  }

  /** The coloured one-word state chip for a feature, mirroring the queue tab's
   *  vocabulary for the states the two share.
   *
   *  `idle` is the one that resolves further, because "tracked, nothing running,
   *  not enqueued" is not a state — it is the ABSENCE of the other states, and it
   *  told the captain nothing. With the worktree's dirty flag read (see
   *  FeaturePanelEntry.dirty) it becomes `clean` or `dirty`: whether there is
   *  uncommitted work sitting in that checkout is the only question left about a
   *  feature nothing else is happening to. Unread, it stays `idle` — never
   *  `clean`, which would be a claim nobody checked.
   *
   *  The `[crew]` marker beside the chip (see worktreeRows) is separate: an
   *  enqueued feature's queue state and a live agent are both worth seeing, so
   *  neither hides the other. */
  private featureStateLabel(e: FeaturePanelEntry): string {
    switch (e.status) {
      case "working": return c.cyan("[crew running]");
      case "idle":
        if (e.dirty === true) return c.yellow("[dirty]");
        if (e.dirty === false) return c.dim("[clean]");
        return c.dim("[idle]");
      case "queued": return c.dim(`[queued${e.position === undefined ? "" : ` #${e.position}`}]`);
      case "processing": return c.cyan("[processing]");
      case "ready": return c.green("[ready to merge]");
      case "resolving": return c.yellow("[resolving]");
      case "blocked":
        return c.red(
          `[blocked${e.blockedKind ? `: ${e.blockedKind === "conflict" ? "conflict" : "build+test"}` : ""}]`,
        );
      case "provisioning": return c.dim("[provisioning]");
      case "failed": return c.red("[provision failed]");
      case "removed": return c.dim("[worktree gone]");
    }
  }

  /** The docs tab as selectable rows: "a) plan.md". */
  private docsTabRows(panel: PanelState): string[] {
    if (!this.docs) return ["", "  " + c.dim("No doc surface in this session.")];
    if (panel.docsLoading) return ["", "  " + c.dim("loading…")];
    if (panel.docsError) return ["", "  " + c.yellow(panel.docsError)];
    if (panel.docs.length === 0) {
      return [
        "",
        "  " + c.dim("No documents yet."),
        "  " + c.dim("Docs live in docs/ and show up here once the co writes one."),
      ];
    }
    const rows: string[] = [""];
    panel.docs.forEach((name, idx) => {
      const label = OVERLAY_LABELS[idx];
      if (label === undefined) return; // beyond the label alphabet; noted below
      rows.push("  " + c.cyan(`${label})`) + " " + name);
    });
    if (panel.docs.length > OVERLAY_LABELS.length) {
      rows.push("", "  " + c.dim(`(${panel.docs.length - OVERLAY_LABELS.length} more not shown)`));
    }
    return rows;
  }

  /**
   * The panel footer: the active view's key hints on the left, a scroll position
   * indicator on the right. The queue tab's hints depend on whether a review is
   * live; a review view carries the merge action bar, built piecewise so the
   * action keys stand out (an inner colour reset would cancel a blanket dim).
   */
  private panelFooter(total: number, start: number, vp: number): string {
    const w = this.cols;
    const v = this.panel?.view;
    // Home tabs offer the switch hint whenever there's somewhere to switch to.
    // The bar across the top already shows the numbers, so the hint names the
    // cycle key and points at them rather than spelling every digit out.
    const onHomeTab =
      v?.kind === "home" || v?.kind === "queue" || v?.kind === "docs" || v?.kind === "inbox";
    const tabHint = onHomeTab && this.panelTabs().length > 1 ? "Tab/1-9 tabs · " : "";

    // Built before the hints: the doc view sizes its hint run against whatever
    // the indicator leaves, so the copy key isn't the thing that gets clipped.
    let right = "";
    if (total > vp) {
      const below = total - (start + vp);
      right = below > 0 ? `${below} more below ` : "end ";
    }

    // A standing copy receipt speaks for every view, because a drag selects on
    // every view. It yields to a merge in flight: "merging…" is the one thing on
    // this line that must not be covered, and it lasts seconds at most.
    const notice = this.panel?.copyNotice;
    const merging = this.queueMerging !== null || this.pendingReview?.status === "merging";

    let left: string;
    if (notice && !merging) {
      // The receipt takes the position indicator's room too when it needs it:
      // the indicator is one keypress from coming back, whereas a half-printed
      // "71 mo" is just debris. The caveat is the part that must survive a
      // narrow terminal, so the lead-in is what shortens.
      const terse = notice.replace("if nothing pastes, allow", "allow");
      left = ` ${c.cyan(2 + visibleWidth(notice) <= w ? notice : terse)} `;
      right = "";
    } else if (v?.kind === "prEdit") {
      // The popup carries its own keys on its bottom border; the footer names
      // what is being written, so the two never disagree about which PR it is.
      const edit = this.panel?.prEdit;
      left = edit
        ? " " +
          (edit.status === "saving"
            ? c.cyan(`writing PR #${edit.prNumber}…`)
            : c.cyan("Ctrl-S") + c.dim(` save PR #${edit.prNumber} · `) + c.cyan("Esc") + c.dim(" cancel")) +
          " "
        : " ";
    } else if (v?.kind === "review") {
      left = " " + this.reviewActionBar() + " ";
    } else if (v?.kind === "queue") {
      // The [m] hint is a plain function of the head's state — it appears when
      // the head goes green and stays until it is pressed or the head changes.
      // Nothing here is armed or awaited (D-20260724-12).
      // `e` is advertised on the same rule as [m]: only where it would actually
      // fire — a head that has a pull request, in a session wired to edit one.
      const edit = this.editableHead();
      const editHint = edit ? c.cyan("e") + c.dim(" edit message · ") : "";
      if (this.queueMerging) {
        left = " " + c.cyan(`merging ${this.queueMerging}…`) + " ";
      } else if (this.mergeableHead()) {
        const m = this.mergeableHead();
        left = " " + c.cyan("m") + c.dim(`${m?.prNumber ? ` merge PR #${m.prNumber}` : " merge"} · `) +
          editHint + c.dim(`space/b page · ${tabHint}Esc close`) + " ";
      } else {
        left = " " + editHint + c.dim("space/b page · " + tabHint + "Esc close") + " ";
      }
    } else if (v?.kind === "home") {
      // Nothing here acts, so the bar advertises only paging and the exits.
      left = ` ${c.dim("space/b page · " + tabHint + "Esc close")} `;
    } else if (v?.kind === "docs" || v?.kind === "inbox") {
      left = ` a-z open · ${tabHint}Esc close `;
    } else if (v?.kind === "doc") {
      // `y` is the only ACTION key on a doc, so it leads and is coloured the way
      // the queue tab leads with its [m]. The run shortens to fit beside the
      // position indicator rather than letting clip() eat its end: a hint that
      // is always truncated away is a hint nobody discovers. The drag hint is
      // first out, because the gesture is self-revealing where a key is not -
      // you drag, the highlight appears, the receipt names what it took.
      const room = w - 2 - visibleWidth(right); // the leading space + the `y`
      const tiers = [
        " copy · drag select · space/b page · j/k line · g/G ends · Backspace back · Esc close ",
        " copy · space/b page · j/k line · g/G ends · Backspace back · Esc close ",
        " copy · space/b page · Backspace back · Esc close ",
      ];
      left = " " + c.cyan("y") + (tiers.find((t) => t.length <= room) ?? tiers[tiers.length - 1]!);
    } else {
      // a filed review body: the shared paging surface, no actions of its own
      left = " space/b page · j/k line · g/G ends · Backspace back · Esc close ";
    }

    const fill = Math.max(0, w - visibleWidth(left) - visibleWidth(right));
    return this.clip(left + c.dim("─".repeat(fill)) + c.dim(right), w);
  }

  /**
   * Whether [m] is live right now, and on what. ONE predicate, used by the
   * handler, the in-body hint and the footer alike, so the key can never be
   * advertised somewhere it wouldn't fire (or fire where it isn't offered).
   *
   * Live means: the source reports a ready head, it exposes a merge, and — when
   * it also exposes a head body — that body is a ready one with something to
   * land. A source with no `headDetail` at all is trusted on its view, so a
   * minimal list source still works; one that HAS a body must agree with it.
   */
  private mergeableHead(): { feature: string; target?: string; prNumber?: number } | null {
    if (!this.queue?.merge) return null;
    const view = this.queue.view();
    const head = view.head ?? view.entries[0] ?? null;
    if (!head || !head.isHead || head.status !== "ready") return null;
    // No body source: trust the view, and say nothing about a target we were
    // never told (the integration branch is the session's to name, not ours).
    if (!this.queue.headDetail) return { feature: head.feature };
    const detail = this.queue.headDetail();
    if (!detail || detail.kind !== "ready" || detail.commits.length === 0) return null;
    return {
      feature: detail.feature,
      target: detail.target,
      ...(detail.pr ? { prNumber: detail.pr.number } : {}),
    };
  }

  /**
   * Whether `e` is live right now, and on which pull request. The twin of
   * mergeableHead, and for the same reason: ONE predicate behind the key and the
   * hint that advertises it, so the editor can never be offered over a head with
   * no PR (or hidden on one that has one).
   */
  private editableHead(): { prNumber: number } | null {
    if (!this.queue?.editPrMessage) return null;
    const pr = this.queue.headDetail?.()?.pr;
    return pr ? { prNumber: pr.number } : null;
  }

  /** The drilled review view's action bar: [m] armed only for a mergeable prepare
   *  still under review; every other state names why it's off. */
  private reviewActionBar(): string {
    const pr = this.pendingReview;
    if (!pr) return c.dim("no review pending · Backspace back · Esc close");
    if (pr.status === "merging") return c.cyan(`merging into ${pr.review.target}…`);
    const p = pr.review.prepared;
    const mergeable = pr.status === "review" && p.kind === "green" && p.commits.length > 0;
    if (mergeable) {
      return c.cyan("m") + c.dim(" merge · ") + c.cyan("r") +
        c.dim(" reject · space/b page · Esc close");
    }
    const why =
      pr.status === "failed" ? "merge failed"
      : p.kind === "conflict" ? "conflict"
      : p.kind === "failed" ? "checks red"
      : p.kind === "pending" ? "checks pending"
      : "nothing to land";
    return c.dim(`m disabled (${why}) · `) + c.cyan("r") +
      c.dim(" close · space/b page · Esc close");
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
