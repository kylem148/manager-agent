import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Tui,
  clipCell,
  flowRow,
  normalizeSelection,
  osc52,
  packRow,
  pad,
  renderInboxItem,
  renderMarkdownDoc,
  type DocSource,
  type FeaturePanelEntry,
  type FeaturePanelSource,
  type InboxPanelEntry,
  type InStream,
  type LandingReview,
  type OutStream,
  type PanelChecks,
  type QueueHeadDetail,
  type QueueMergeResult,
  type QueuePanelSource,
  type QueuePanelView,
  type TaskPanelRow,
  type TaskPanelSource,
} from "./tui.js";
import { stripAnsi, visibleWidth } from "./wrap.js";

/** A checks summary for the panel, counted from the runs so a test only states
 *  the verdict and the checks it cares about. */
function panelChecks(
  verdict: PanelChecks["verdict"],
  runs: { name: string; bucket: string; link?: string }[] = [],
): PanelChecks {
  return {
    verdict,
    ungated: verdict === "none",
    requiredOnly: false,
    total: runs.length,
    passed: runs.filter((r) => r.bucket === "pass").length,
    failed: runs.filter((r) => r.bucket === "fail" || r.bucket === "cancel").length,
    pending: runs.filter((r) => r.bucket === "pending").length,
    skipped: runs.filter((r) => r.bucket === "skipping").length,
    runs,
    ms: 10,
  };
}

/**
 * End-to-end tests for the Ctrl-O panel: the doc surface, and the merge review
 * that now lives INSIDE the panel and shares its paging and paint frame. Raw
 * bytes go in one end and we assert on the painted frames and on the calls the
 * panel makes into its injected sources. The DocSource is faked so nothing
 * touches the filesystem (the real docs/-only sandbox is proved in
 * memory/docs.test.ts); the LandingReview is faked so nothing touches git (the
 * real engine wiring is proved in session/landinggate.test.ts).
 *
 * The invariants that matter here: the panel does NOT auto-pop (registering a
 * review flashes a hint; the captain opens it with Ctrl-O), while open every key
 * drives the panel and never the prompt, it renders through the shared markdown
 * renderer, it refreshes live off the write-queue subscription, Esc restores the
 * conversation intact, a long body pages without any arrow key - and for the
 * review, execute() fires exactly once, from [m] alone, only over a mergeable
 * prepare. A review with no queue/docs source opens straight to the diff.
 */

process.setMaxListeners(0);

const PROMPT = "you > ";
const CTRL_O = "\x0f";
const ESC = "\x1b";

/** A scriptable DocSource with a manual write-signal emitter. */
function fakeDocs(initial: Record<string, string>): DocSource & {
  set(name: string, content: string): void;
  remove(name: string): void;
  emit(name: string): void;
  listCalls: number;
} {
  const store = new Map(Object.entries(initial));
  const listeners = new Set<(name: string) => void>();
  const api = {
    listCalls: 0,
    list(): Promise<string[]> {
      api.listCalls++;
      return Promise.resolve([...store.keys()].sort());
    },
    read(name: string): Promise<string> {
      const v = store.get(name);
      if (v === undefined) return Promise.reject(new Error(`no doc ${name}`));
      return Promise.resolve(v);
    },
    subscribe(listener: (name: string) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(name: string, content: string): void {
      store.set(name, content);
    },
    remove(name: string): void {
      store.delete(name);
    },
    emit(name: string): void {
      for (const l of listeners) l(name);
    },
  };
  return api;
}

interface Harness {
  tui: Tui;
  send(bytes: string): void;
  /** Resize the terminal the way SIGWINCH does, with the panel still open. */
  resize(cols: number, rows: number): void;
  /** The width the terminal currently reports. */
  cols(): number;
  lastFrame(): string;
  lastFramePlain(): string;
  /** Every byte written to the terminal, for assertions about sequences that
   *  are NOT a frame (the OSC 52 clipboard write rides alongside one). */
  writes(): string[];
  stop(): void;
}

function harness(
  docs?: DocSource,
  cols = 40,
  rows = 12,
  queue?: QueuePanelSource,
  inbox?: { list(): InboxPanelEntry[] },
  features?: FeaturePanelSource,
  tasks?: TaskPanelSource,
): Harness {
  let listener: ((d: string) => void) | null = null;
  const writes: string[] = [];
  const size = { cols, rows };
  const out: OutStream = {
    write: (s) => writes.push(String(s)),
    get columns(): number {
      return size.cols;
    },
    get rows(): number {
      return size.rows;
    },
  };
  const inp: InStream = {
    isTTY: true,
    setRawMode: () => {},
    resume: () => {},
    pause: () => {},
    setEncoding: () => {},
    on: (_e, l) => (listener = l),
    removeListener: () => (listener = null),
  };
  const tui = new Tui({
    promptLabel: PROMPT,
    out,
    inp,
    docs,
    ...(queue ? { queue } : {}),
    ...(inbox ? { inbox } : {}),
    ...(features ? { features } : {}),
    ...(tasks ? { tasks } : {}),
  });
  tui.start();
  return {
    tui,
    send: (bytes) => listener?.(bytes),
    resize: (c, r) => {
      size.cols = c;
      size.rows = r;
      process.emit("SIGWINCH");
    },
    cols: () => size.cols,
    lastFrame: () => writes[writes.length - 1] ?? "",
    lastFramePlain: () => stripAnsi(writes[writes.length - 1] ?? ""),
    writes: () => writes,
    stop: () => tui.stop(),
  };
}

/** Let the overlay's async list/read settle (microtask flush). */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Let a coalesced repaint land (the ~60fps frame budget, plus slack). */
const frame = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

// --- the column arithmetic behind Home's two blocks --------------------------
//
// Written with the escapes in by hand, because `colorEnabled` is false under a
// test runner: a rendered frame here carries no ANSI at all, so a frame
// assertion can never catch the one mistake these are for — counting escape
// bytes as columns, which collapses a column the moment the app runs on a real
// terminal.

test("pad fills to VISIBLE width, so a coloured cell still lines up", () => {
  assert.equal(visibleWidth(pad("fix", 8)), 8);
  const coloured = "\x1b[2mfix\x1b[0m";
  assert.equal(visibleWidth(pad(coloured, 8)), 8, "the escapes are not columns");
  assert.ok(pad(coloured, 8).startsWith(coloured), "and the styling survives intact");
  assert.equal(pad("already wider", 4), "already wider", "never truncates — that's clipCell's job");
  // The bug this exists to prevent: padEnd counts the escape bytes and pads
  // nothing at all.
  assert.equal(visibleWidth(coloured.padEnd(8)), 3, "which is exactly what padEnd gets wrong");
});

test("clipCell cuts within a width, marks the cut, and closes any style it cut", () => {
  assert.equal(clipCell("short", 20), "short", "a cell that fits is untouched");

  // A word too long to break is hard-split — which is what a branch name or a
  // feature handle always is — and fills the column exactly.
  const handle = clipCell("a-very-long-feature-name", 10);
  assert.equal(visibleWidth(handle), 10);
  assert.ok(handle.endsWith("…"), "a truncated cell says so");

  // Prose breaks on a word instead, so a truncated intent reads as words. The
  // width is an upper bound; the caller pads the column out.
  const intent = clipCell("stripe checkout with saved cards", 12);
  assert.equal(intent, "stripe…");
  assert.ok(visibleWidth(intent) <= 12, "never wider than its column");

  const styled = clipCell("\x1b[2mstripe checkout with saved cards\x1b[0m", 12);
  assert.ok(visibleWidth(styled) <= 12, "measured in columns, not bytes");
  assert.ok(styled.endsWith("\x1b[0m"), "and the colour is closed, so it can't bleed down the row");
  assert.equal(clipCell("anything", 0), "", "no room is no cell, not a crash");
});

// --- flowRow / packRow: the wrap that replaced the clip ----------------------
//
// The Home tab's descriptions used to be cut with an ellipsis, which removed the
// overflow and left the text unreadable — the actual complaint. These two are
// the arithmetic that fixes it, and the properties below are the whole contract:
// nothing wider than the width, and nothing lost.

/** The words of a set of flowed rows, with the indent and the lead removed, so a
 *  test can ask whether every character survived the wrap. */
function words(rows: string[]): string[] {
  return rows.join(" ").split(/\s+/).filter((w) => w !== "");
}

test("flowRow wraps a long description on word boundaries and loses nothing", () => {
  const text =
    "the resolver rebases the feature onto the current origin/dev tip and pushes it back with a lease";
  const rows = flowRow("  building   ", text, 48);

  assert.ok(rows.length > 1, "a description longer than the width is more than one row");
  for (const row of rows) {
    assert.ok(visibleWidth(row) <= 48, `no row is wider than the width: ${JSON.stringify(row)}`);
  }
  // Word boundaries, not columns: no row ends mid-word.
  assert.deepEqual(words(rows).slice(1), text.split(" "), "every word survives, in order");
  assert.equal(words(rows)[0], "building", "and the lead is still the lead");
});

test("flowRow indents continuations to the column the text started in", () => {
  const rows = flowRow("  queued     ", "one two three four five six seven eight", 24);
  assert.ok(rows.length > 1);
  for (const row of rows.slice(1)) {
    assert.match(row, /^ {13}\S/, "a continuation hangs under the text, not under the row");
  }
});

test("flowRow styles each row separately, so a colour cannot bleed past the wrap", () => {
  // colorEnabled is false under a test runner, so the style function stands in
  // for c.dim: what matters is that it is applied per row and never spans one.
  const rows = flowRow("  ", "a description with several words in it", 16, (s) => `<${s}>`);
  assert.ok(rows.length > 1);
  for (const row of rows) assert.match(row, /^ +<[^<>]*>$/, `styled whole: ${JSON.stringify(row)}`);
});

test("flowRow survives the degenerate widths without a crash or an empty row", () => {
  assert.deepEqual(flowRow("", "", 40), [""], "no text is one empty row, not none");
  const narrow = flowRow("          ", "supercalifragilistic", 8);
  assert.ok(narrow.length >= 1);
  assert.deepEqual(words(narrow).join(""), "supercalifragilistic", "hard-split, never dropped");
});

test("packRow lays a head across lines when its columns outgrow the terminal", () => {
  const rows = packRow("  ▸ ", ["checkout", "[ready to merge]", "co/feat-checkout"], 28, 6);
  assert.ok(rows.length > 1, "it did not fit on one");
  for (const row of rows) assert.ok(visibleWidth(row) <= 28, JSON.stringify(row));
  assert.deepEqual(words(rows), ["▸", "checkout", "[ready", "to", "merge]", "co/feat-checkout"]);
  for (const row of rows.slice(1)) assert.match(row, /^ {6}\S/, "continuations hang");

  // One token wider than the whole row is hard-split rather than dropped.
  const long = packRow("  ▸ ", ["co/feat-a-very-long-branch-name-indeed"], 20, 6);
  for (const row of long) assert.ok(visibleWidth(row) <= 20, JSON.stringify(row));
  assert.equal(words(long).slice(1).join(""), "co/feat-a-very-long-branch-name-indeed");
});

// --- renderMarkdownDoc (the shared-renderer reuse) --------------------------

test("renderMarkdownDoc styles headings and keeps tables un-wrapped", () => {
  const rows = renderMarkdownDoc("# Title\n\nsome prose\n", 40);
  const plain = rows.map(stripAnsi);
  assert.ok(plain.includes("Title"), "heading text survives");
  assert.ok(!plain.join("\n").includes("# Title"), "the # marker is styling, not literal");

  const table = "| a | b |\n| - | - |\n| 1 | 2 |\n";
  const trows = renderMarkdownDoc(table, 40).map(stripAnsi);
  // A box-drawn table, not raw pipes wrapped as prose.
  assert.ok(trows.some((r) => r.includes("│")), "table is laid out with box chars");
});

// --- open / list / select ---------------------------------------------------

test("Ctrl-O opens a list of docs selectable by letter, no arrow key needed", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n", "architecture.md": "# Arch\n" });
  const h = harness(docs);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const frame = h.lastFramePlain();
  assert.match(frame, /docs/, "header names the overlay");
  // Sorted: architecture.md is label 1, plan.md is label 2.
  assert.match(frame, /a\)\s*architecture\.md/);
  assert.match(frame, /b\)\s*plan\.md/);

  // Selecting "1" opens architecture.md, rendered through the markdown renderer.
  h.send("a");
  await settle();
  const doc = h.lastFramePlain();
  assert.match(doc, /docs · architecture\.md/, "header shows the open doc");
  assert.match(doc, /Arch/);
  assert.ok(!doc.includes("# Arch"), "rendered, not raw markdown");
  h.stop();
});

test("while the overlay is open, keystrokes drive the viewer and never the prompt", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n" });
  const h = harness(docs);
  const answer = h.tui.question();
  h.send(CTRL_O);
  await settle();
  // Type letters that would otherwise land in the input buffer.
  h.send("hello");
  await settle();
  // Close and submit: the buffer must be empty, proving nothing leaked in.
  h.send(ESC);
  h.send("real\r");
  assert.equal(await answer, "real");
  h.stop();
});

// --- live refresh ------------------------------------------------------------

test("a write to the open doc refreshes the view live", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n\noriginal body\n" });
  const h = harness(docs);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a"); // open plan.md
  await settle();
  assert.match(h.lastFramePlain(), /original body/);

  // An agent rewrites the doc and the write queue signals it.
  docs.set("plan.md", "# Plan\n\nrewritten body\n");
  docs.emit("plan.md");
  await settle();
  const frame = h.lastFramePlain();
  assert.match(frame, /rewritten body/, "the view reloaded on the write signal");
  assert.ok(!frame.includes("original body"), "stale content is gone");
  h.stop();
});

test("a write to a different doc does not disturb the open doc", async () => {
  const docs = fakeDocs({ "plan.md": "plan body\n", "notes.md": "notes body\n" });
  const h = harness(docs);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("b"); // plan.md (sorted: notes.md=1, plan.md=2)
  await settle();
  assert.match(h.lastFramePlain(), /plan body/);
  docs.set("notes.md", "notes changed\n");
  docs.emit("notes.md");
  await settle();
  assert.match(h.lastFramePlain(), /plan body/, "unrelated write left the view alone");
  h.stop();
});

test("the doc list refreshes when a doc is created while it's showing", async () => {
  const docs = fakeDocs({ "plan.md": "x\n" });
  const h = harness(docs);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.ok(!h.lastFramePlain().includes("fresh.md"));
  docs.set("fresh.md", "y\n");
  docs.emit("fresh.md");
  await settle();
  assert.match(h.lastFramePlain(), /fresh\.md/, "the new doc appears in the list");
  h.stop();
});

// --- Esc restores the conversation ------------------------------------------

test("Esc closes the overlay and restores output that arrived while it was open", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n" });
  const h = harness(docs);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  // Model output streams into the transcript underneath the overlay.
  h.tui.appendBlock("streamed while hidden");
  await settle();
  // The overlay is still what's painted (modal), not the transcript line.
  assert.ok(!h.lastFramePlain().includes("streamed while hidden"), "overlay hides the transcript");
  // Esc drops back to the conversation, which now includes that output.
  h.send(ESC);
  await settle();
  assert.match(h.lastFramePlain(), /streamed while hidden/, "restored intact, with new output");
  assert.match(h.lastFrame(), /you > /, "the input prompt is back");
  h.stop();
});

// --- paging without arrow keys ----------------------------------------------

test("a doc longer than the screen pages with space/b and jumps with g/G", async () => {
  const long = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
  const docs = fakeDocs({ "long.md": long });
  const h = harness(docs, 40, 12);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a");
  await settle();
  // Rows concatenate once ANSI (incl. cursor moves) is stripped, so the top of
  // the doc reads as "line 1line 2…". That adjacency is the top-of-page marker.
  assert.match(h.lastFramePlain(), /line 1line 2/, "starts at the top");

  h.send(" "); // page down
  await settle();
  const paged = h.lastFramePlain();
  assert.ok(!paged.includes("line 1line 2"), "paged past the first screen");

  h.send("G"); // jump to bottom
  await settle();
  assert.match(h.lastFramePlain(), /line 100/, "G reaches the end");

  h.send("g"); // jump back to top
  await settle();
  assert.match(h.lastFramePlain(), /line 1line 2/, "g returns to the top");

  h.send("b"); // page up at the top is a no-op, must not crash
  await settle();
  assert.match(h.lastFramePlain(), /line 1line 2/);
  h.stop();
});

test("Backspace in a doc returns to the list; Esc from a doc closes entirely", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n" });
  const h = harness(docs);
  const answer = h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a");
  await settle();
  assert.match(h.lastFramePlain(), /docs · plan\.md/);
  h.send("\x7f"); // Backspace → back to the list
  await settle();
  assert.match(h.lastFramePlain(), /a\)\s*plan\.md/, "back at the list");
  h.send(ESC); // Esc from the list closes
  h.send("done\r");
  assert.equal(await answer, "done");
  h.stop();
});

// --- copying a doc out (y / OSC 52) ------------------------------------------
//
// The panel owns the whole keyboard AND swallows the mouse (only the wheel gets
// through), so no drag can select inside it and the terminal's own click-drag is
// off while mouse reporting is on. Getting a doc out is therefore a KEY. What it
// must put on the clipboard is the RAW markdown the captain authored, not the
// ANSI-styled, width-wrapped rows on screen.

/** Pull the payload out of the OSC 52 write among a run of terminal writes, or
 *  null if nothing asked for the clipboard. */
function clipboardPayload(writes: string[]): string | null {
  for (const w of writes) {
    const m = /\x1b]52;c;([A-Za-z0-9+/=]*)\x07/.exec(w);
    if (m) return Buffer.from(m[1]!, "base64").toString("utf8");
  }
  return null;
}

test("osc52 wraps base64 in the clipboard-write sequence", () => {
  assert.equal(osc52("hi"), `\x1b]52;c;${Buffer.from("hi").toString("base64")}\x07`);
  // Non-ASCII survives the round trip as UTF-8, so a doc with a box-drawing
  // table or a curly quote copies as itself.
  const text = "héllo — ✓";
  const m = /\x1b]52;c;(.*)\x07/.exec(osc52(text));
  assert.equal(Buffer.from(m![1]!, "base64").toString("utf8"), text);
});

test("y on an open doc copies its RAW markdown, not the rendered rows", async () => {
  const source = "# Cheat sheet\n\n- `co link` registers a repo\n- `co pane` picks the pane\n";
  const docs = fakeDocs({ "cheatsheet.md": source });
  const h = harness(docs, 72, 16);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a"); // open cheatsheet.md
  await settle();
  // The screen shows it rendered: the markers are styling, not literal text.
  assert.ok(!h.lastFramePlain().includes("# Cheat sheet"), "rendered on screen");

  const before = h.writes().length;
  h.send("y");
  await settle();
  const copied = clipboardPayload(h.writes().slice(before));
  assert.equal(copied, source, "the clipboard gets the file, byte for byte");
  h.stop();
});

test("the doc footer advertises y, and the copy confirms with the OSC 52 caveat", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n\nline one\nline two\n" });
  const h = harness(docs, 100, 16);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a");
  await settle();
  assert.match(h.lastFramePlain(), /y copy/, "the key is discoverable before it's pressed");

  h.send("y");
  await settle();
  const confirmed = h.lastFramePlain();
  assert.match(confirmed, /copied 4 lines/, "the receipt names what was sent");
  // OSC 52 is unacknowledged, so the caveat has to ride with the confirmation.
  assert.match(confirmed, /allow clipboard access/, "the silent-failure caveat is surfaced");

  // Sticky until the next key, then the hints come back.
  h.send("j");
  await settle();
  assert.ok(!h.lastFramePlain().includes("copied 4 lines"), "the next key dismisses it");
  assert.match(h.lastFramePlain(), /y copy/, "the hints return");
  h.stop();
});

test("a live rewrite of the copied doc retires the receipt, which no longer vouches for it", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n\noriginal body\n" });
  const h = harness(docs, 100, 16);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a");
  await settle();
  h.send("y");
  await settle();
  assert.match(h.lastFramePlain(), /copied 3 lines/);

  // An agent rewrites the doc: the clipboard still holds the OLD text, so the
  // confirmation must not keep standing over the new content.
  docs.set("plan.md", "# Plan\n\nrewritten body\n");
  docs.emit("plan.md");
  await settle();
  const after = h.lastFramePlain();
  assert.match(after, /rewritten body/, "the refresh landed");
  assert.ok(!after.includes("copied 3 lines"), "the stale receipt is gone");
  assert.match(after, /y copy/, "and the hints are back");
  h.stop();
});

test("on a narrow terminal the copy hint survives and the scroll indicator still fits", async () => {
  const long = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
  const docs = fakeDocs({ "long.md": long });
  const h = harness(docs, 72, 12);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a");
  await settle();
  const footer = h.lastFramePlain();
  // The hint run is shortened rather than clipped, so BOTH the new key and the
  // position indicator survive a width that couldn't hold the full run.
  assert.match(footer, /y copy/, "the copy key is still advertised");
  assert.match(footer, /more below/, "and the scroll indicator wasn't pushed off");

  // The receipt keeps the caveat at a width that can't hold the full sentence:
  // the lead-in shortens, the "allow clipboard access" part never does.
  const narrow = harness(docs, 56, 12);
  narrow.tui.question();
  narrow.send(CTRL_O);
  await settle();
  narrow.send("a");
  await settle();
  narrow.send("y");
  await settle();
  const receipt = narrow.lastFramePlain();
  assert.match(receipt, /allow clipboard access \(OSC 52\)/, "the caveat survives");
  assert.ok(!receipt.includes("if nothing pastes"), "the lead-in is what gave way");
  narrow.stop();
  h.stop();
});

test("y stays scoped to a doc: it copies nothing from a filed review body", async () => {
  const entry: InboxPanelEntry = {
    level: "L1",
    verdict: "rework",
    headline: "auth middleware never ran",
    body: "Went wrong: the middleware is registered after the route.",
    timestamp: "2026-07-24T11:05:00.000Z",
    jobId: "job-003",
  };
  const h = harness(undefined, 72, 16, undefined, { list: () => [entry] });
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a"); // drill into the filed review
  await settle();
  assert.match(h.lastFramePlain(), /inbox · L1 rework/, "in a filed review body");

  const before = h.writes().length;
  h.send("y");
  await settle();
  assert.equal(clipboardPayload(h.writes().slice(before)), null, "no clipboard write");
  // And the inbox body's own footer is untouched by the doc view's new key.
  assert.ok(!h.lastFramePlain().includes("y copy"), "the hint is the doc view's alone");
  h.stop();
});

test("y on a doc that failed to load says so instead of copying an empty string", async () => {
  const docs = fakeDocs({ "gone.md": "# Gone\n" });
  const h = harness(docs, 72, 16);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  docs.remove("gone.md"); // deleted between the list and the open
  h.send("a");
  await settle();

  const before = h.writes().length;
  h.send("y");
  await settle();
  assert.equal(clipboardPayload(h.writes().slice(before)), null, "nothing reaches the clipboard");
  assert.match(h.lastFramePlain(), /nothing to copy/);
  h.stop();
});

test("y does not disturb paging, back, or close on a doc", async () => {
  const body = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
  const docs = fakeDocs({ "plan.md": body });
  const h = harness(docs, 72, 12);
  const answer = h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a");
  await settle();
  h.send("y"); // copy, then keep navigating with the confirmation standing
  await settle();
  h.send(" "); // space still pages (same top-of-page marker as the paging test)
  await settle();
  assert.ok(!h.lastFramePlain().includes("line 1line 2"), "space paged past the top");
  h.send("g"); // g still returns to the top
  await settle();
  assert.match(h.lastFramePlain(), /line 1line 2/, "g returns to the top");
  h.send("\x7f"); // Backspace still returns to the list
  await settle();
  assert.match(h.lastFramePlain(), /a\)\s*plan\.md/);
  h.send(ESC);
  h.send("done\r");
  assert.equal(await answer, "done", "and the prompt never saw any of it");
  h.stop();
});

// --- selecting text inside the panel with the mouse ---------------------------
//
// The panel keeps mouse reporting on and owns the whole screen, so the terminal
// will not do its own click-drag here. It gets the transcript's treatment: a
// left-drag highlights and, on release, copies through OSC 52. This is what
// makes a PARTIAL copy possible - `y` takes a whole doc, a drag takes the bit
// you actually want, on any view.

/** An SGR 1006 mouse report. Screen coords are 1-based; the panel body starts at
 *  row 2 (row 1 is the header, the last row is the footer). */
const mousePress = (x: number, y: number): string => `\x1b[<0;${x};${y}M`;
const mouseDrag = (x: number, y: number): string => `\x1b[<32;${x};${y}M`;
const mouseRelease = (x: number, y: number): string => `\x1b[<0;${x};${y}m`;

test("a left-drag over a doc selects those cells and copies them on release", async () => {
  // Three short lines, so the body rows map predictably onto screen rows 2,3,4…
  const docs = fakeDocs({ "notes.md": "alpha\nbravo\ncharlie\n" });
  const h = harness(docs, 60, 12);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a");
  await settle();
  assert.match(h.lastFramePlain(), /alpha/, "the doc is on screen");

  const before = h.writes().length;
  // Drag across "alpha" only: columns 1..5 on its row. The row is read back out
  // of the frame rather than assumed - the renderer may prepend a blank line.
  const alphaRow = docRowOf(h, "alpha");
  h.send(mousePress(1, alphaRow));
  h.send(mouseDrag(5, alphaRow));
  h.send(mouseRelease(5, alphaRow));
  await settle();
  assert.equal(clipboardPayload(h.writes().slice(before)), "alpha", "just the dragged cells");
  h.stop();
});

/** The 1-based screen row a body line was painted on, read back out of the last
 *  frame's cursor-positioning sequences. Keeps the mouse tests honest about
 *  where the renderer actually put things. */
function docRowOf(h: Harness, needle: string): number {
  const frame = h.lastFrame();
  const re = /\x1b\[(\d+);1H\x1b\[2K([^\x1b]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(frame)) !== null) {
    if (stripAnsi(m[2]!).includes(needle)) return Number(m[1]);
  }
  throw new Error(`no painted row contains ${JSON.stringify(needle)}`);
}

test("a multi-row drag copies whole interior rows and partial end rows", async () => {
  const docs = fakeDocs({ "notes.md": "alpha\nbravo\ncharlie\n" });
  const h = harness(docs, 60, 12);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a");
  await settle();
  const top = docRowOf(h, "alpha");

  const before = h.writes().length;
  // From column 3 of "alpha" through column 4 of "charlie": the interior row
  // comes whole, the two end rows are cut at the drag's columns.
  h.send(mousePress(3, top));
  h.send(mouseDrag(4, top + 2));
  h.send(mouseRelease(4, top + 2));
  await settle();
  assert.equal(clipboardPayload(h.writes().slice(before)), "pha\nbravo\nchar");
  h.stop();
});

test("dragging upward copies the same text as dragging downward", async () => {
  const docs = fakeDocs({ "notes.md": "alpha\nbravo\ncharlie\n" });
  const h = harness(docs, 60, 12);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a");
  await settle();
  const top = docRowOf(h, "alpha");

  const before = h.writes().length;
  h.send(mousePress(4, top + 2)); // start at the bottom, drag up
  h.send(mouseDrag(3, top));
  h.send(mouseRelease(3, top));
  await settle();
  assert.equal(clipboardPayload(h.writes().slice(before)), "pha\nbravo\nchar");
  h.stop();
});

test("the dragged cells are highlighted, and the receipt names what was copied", async () => {
  const docs = fakeDocs({ "notes.md": "alpha\nbravo\ncharlie\n" });
  const h = harness(docs, 60, 12);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a");
  await settle();
  const top = docRowOf(h, "alpha");

  h.send(mousePress(1, top));
  h.send(mouseDrag(5, top));
  await settle();
  // Reverse video is on while the drag is live, so the selection is visible.
  assert.match(h.lastFrame(), /\x1b\[7malpha\x1b\[27m/, "the dragged cells are highlighted");

  h.send(mouseRelease(5, top));
  await settle();
  assert.match(h.lastFramePlain(), /copied 1 line\b/, "singular for one row");
  assert.match(h.lastFramePlain(), /allow clipboard access/, "with the OSC 52 caveat");
  h.stop();
});

test("a selection spanning a paragraph break reads as continuous but copies a real blank line", async () => {
  const docs = fakeDocs({ "notes.md": "alpha\n\nbravo\n" });
  const h = harness(docs, 60, 12);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a");
  await settle();
  const top = docRowOf(h, "alpha");

  const before = h.writes().length;
  h.send(mousePress(1, top));
  h.send(mouseDrag(5, top + 2)); // through the blank row between them
  await settle();
  // highlightRange has nothing to reverse on an empty row, so without the filler
  // the selection would tear into stripes at every paragraph break.
  assert.match(h.lastFrame(), /\x1b\[7m \x1b\[27m/, "the blank row is highlighted through");

  h.send(mouseRelease(5, top + 2));
  await settle();
  // The filler is presentational only: the clipboard gets a genuine empty line,
  // not a stray space.
  assert.equal(clipboardPayload(h.writes().slice(before)), "alpha\n\nbravo");
  h.stop();
});

test("a click with no drag copies nothing and just dismisses the highlight", async () => {
  const docs = fakeDocs({ "notes.md": "alpha\nbravo\n" });
  const h = harness(docs, 60, 12);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a");
  await settle();
  const top = docRowOf(h, "alpha");

  const before = h.writes().length;
  h.send(mousePress(3, top));
  h.send(mouseRelease(3, top)); // pressed and released on the same cell
  await settle();
  assert.equal(clipboardPayload(h.writes().slice(before)), null, "nothing copied");
  assert.ok(!h.lastFramePlain().includes("copied"), "and nothing claimed");
  h.stop();
});

test("the next keypress clears the selection and its receipt", async () => {
  const docs = fakeDocs({ "notes.md": "alpha\nbravo\ncharlie\n" });
  const h = harness(docs, 60, 12);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a");
  await settle();
  const top = docRowOf(h, "alpha");

  h.send(mousePress(1, top));
  h.send(mouseDrag(5, top));
  h.send(mouseRelease(5, top));
  await settle();
  assert.match(h.lastFramePlain(), /copied 1 line/);

  h.send("j"); // any key
  await settle();
  assert.ok(!h.lastFramePlain().includes("copied 1 line"), "the receipt is gone");
  assert.ok(!h.lastFrame().includes("\x1b[7malpha"), "and so is the highlight");
  h.stop();
});

test("the wheel still scrolls the panel, and a drag never fires the queue's [m]", async () => {
  const long = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
  const docs = fakeDocs({ "long.md": long });
  const h = harness(docs, 60, 12);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a");
  await settle();
  assert.match(h.lastFramePlain(), /line 1line 2/, "at the top");
  h.send("\x1b[<65;10;5M"); // wheel down
  await settle();
  assert.ok(!h.lastFramePlain().includes("line 1line 2"), "the wheel still scrolls");
  h.stop();
});

test("a drag selects on the inbox tab too, not just on a doc", async () => {
  const entry: InboxPanelEntry = {
    level: "L1",
    verdict: "rework",
    headline: "auth middleware never ran",
    body: "zulu\nyankee\n",
    timestamp: "2026-07-24T11:05:00.000Z",
    jobId: "job-003",
  };
  const h = harness(undefined, 72, 14, undefined, { list: () => [entry] });
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a"); // drill into the filed review
  await settle();
  const row = docRowOf(h, "zulu");

  const before = h.writes().length;
  h.send(mousePress(1, row));
  h.send(mouseDrag(4, row));
  h.send(mouseRelease(4, row));
  await settle();
  assert.equal(clipboardPayload(h.writes().slice(before)), "zulu", "the body surface selects too");
  h.stop();
});

test("normalizeSelection orders endpoints the same whichever way the drag went", () => {
  const down = normalizeSelection({ anchorRow: 1, anchorCol: 2, focusRow: 3, focusCol: 4 });
  const up = normalizeSelection({ anchorRow: 3, anchorCol: 4, focusRow: 1, focusCol: 2 });
  assert.deepEqual(down, { top: 1, bottom: 3, topCol: 2, bottomCol: 5 });
  assert.deepEqual(up, down, "direction is not information");
  // A single cell still selects that one cell (bottomCol is exclusive).
  assert.deepEqual(normalizeSelection({ anchorRow: 2, anchorCol: 7, focusRow: 2, focusCol: 7 }), {
    top: 2, bottom: 2, topCol: 7, bottomCol: 8,
  });
});

// --- empty + degraded --------------------------------------------------------

test("an empty docs/ shows a friendly message, not a crash", async () => {
  const docs = fakeDocs({});
  const h = harness(docs);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /No documents yet/);
  // A stray selector on an empty list does nothing and doesn't throw.
  h.send("a");
  await settle();
  h.send(ESC);
  h.stop();
});

test("with no docs, no queue and no review, Ctrl-O flashes a hint and never opens", async () => {
  const h = harness(undefined); // nothing wired (the degraded path)
  const answer = h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.match(stripAnsi(h.lastFrame()), /panel unavailable/);
  // Input still works normally — nothing became modal.
  h.send("still typing\r");
  assert.equal(await answer, "still typing");
  h.stop();
});

// --- the landing gate ---------------------------------------------------------

/** A scriptable LandingReview whose execute() the test resolves or rejects by
 *  hand, so the merging window is observable. Counts calls to prove
 *  fire-once. */
function fakeReview(prepared: LandingReview["prepared"]): LandingReview & {
  calls: number;
  resolveMerge(msg: string): void;
  rejectMerge(err: Error): void;
} {
  let res: ((s: string) => void) | null = null;
  let rej: ((e: Error) => void) | null = null;
  const api = {
    feature: "gate-ui",
    target: "dev",
    prepared,
    calls: 0,
    execute(): Promise<string> {
      api.calls++;
      return new Promise<string>((resolve, reject) => {
        res = resolve;
        rej = reject;
      });
    },
    resolveMerge(msg: string): void {
      res?.(msg);
    },
    rejectMerge(err: Error): void {
      rej?.(err);
    },
  };
  return api;
}

const GREEN: LandingReview["prepared"] = {
  kind: "green",
  commits: ["abc1234 job: first slice", "def5678 job: second slice"],
  diff: [
    "diff --git a/one.txt b/one.txt",
    "index 0000000..1111111 100644",
    "--- a/one.txt",
    "+++ b/one.txt",
    "@@ -0,0 +1 @@",
    "+hello from the feature",
  ].join("\n"),
};

/**
 * Register a review and open the panel onto it. With no queue/docs wired (the
 * default for these gate tests) the panel opens straight to the review diff.
 * Returns the outcome promise. Registering first flashes a hint (no auto-pop),
 * exactly as the session sees it.
 */
function openReview(h: Harness, review: LandingReview): Promise<"merged" | "rejected" | "failed"> {
  const p = h.tui.openLandingReview(review);
  assert.match(stripAnsi(h.lastFrame()), /press Ctrl-O/, "registering flashes a hint, does not auto-pop");
  h.send(CTRL_O);
  return p as Promise<"merged" | "rejected" | "failed">;
}

test("registering a review does not auto-pop; Ctrl-O opens it", async () => {
  const h = harness(undefined, 60, 24);
  const review = fakeReview(GREEN);
  const p = h.tui.openLandingReview(review);
  // The transcript/prompt is still what's painted — the panel did NOT open.
  assert.ok(!h.lastFramePlain().includes("review · gate-ui"), "no auto-pop");
  assert.match(stripAnsi(h.lastFrame()), /press Ctrl-O/, "a hint points at Ctrl-O");
  h.send(CTRL_O);
  assert.match(h.lastFramePlain(), /review · gate-ui → dev/, "Ctrl-O opens onto the review");
  h.send("r");
  assert.equal(await p, "rejected");
  h.stop();
});

test("a green prepare shows header, summary, commits, diff, and the armed action bar", async () => {
  const h = harness(undefined, 60, 24); // tall enough that the whole body fits one screen
  const review = fakeReview(GREEN);
  const p = openReview(h, review);
  const frame = h.lastFramePlain();
  assert.match(frame, /review · gate-ui → dev/, "header names the feature and target");
  assert.match(frame, /2 commits · 1 file changed/, "summary counts commits and files");
  assert.match(frame, /job: first slice/, "commit list is shown");
  assert.match(frame, /\+hello from the feature/, "the diff body is shown");
  assert.match(frame, /m merge · r reject/, "the action bar is armed");
  assert.equal(review.calls, 0, "showing the gate merges nothing");
  h.send("r");
  assert.equal(await p, "rejected");
  h.stop();
});

test("[m] fires the merge exactly once, dismisses on success, and flashes the confirmation", async () => {
  const h = harness();
  h.tui.question();
  const review = fakeReview(GREEN);
  const p = openReview(h, review);
  h.send("m");
  assert.equal(review.calls, 1, "the keystroke invoked execute");
  assert.match(h.lastFramePlain(), /merging into dev/, "the bar shows the merge in flight");
  // Fire-once: repeats (and dismissal attempts) during the merge are no-ops.
  h.send("m");
  h.send("m");
  h.send("r");
  h.send(ESC);
  assert.equal(review.calls, 1);
  assert.match(h.lastFramePlain(), /review · gate-ui/, "still open mid-merge");
  review.resolveMerge("landed gate-ui: abc1234 on dev");
  await settle();
  assert.equal(await p, "merged");
  const frame = stripAnsi(h.lastFrame());
  assert.ok(!frame.includes("review · gate-ui"), "the panel closed itself (nothing left to show)");
  assert.match(frame, /landed gate-ui/, "the confirmation flashed");
  assert.match(frame, /you > /, "the conversation is back");
  h.stop();
});

test("[r] rejects without ever calling execute", async () => {
  const h = harness();
  h.tui.question();
  const review = fakeReview(GREEN);
  const p = openReview(h, review);
  h.send("r");
  assert.equal(await p, "rejected");
  assert.equal(review.calls, 0, "no merge on reject");
  assert.match(h.lastFrame(), /you > /, "the conversation is back");
  h.stop();
});

test("Esc closes the panel but leaves the review pending; reopening lands back on it", async () => {
  const h = harness();
  h.tui.question();
  const review = fakeReview(GREEN);
  const p = openReview(h, review);
  let settled = false;
  void p.then(() => (settled = true));
  h.send(ESC); // closes the panel — but does NOT reject (non-modal)
  await settle();
  assert.equal(settled, false, "the review is still pending after Esc");
  assert.match(h.lastFrame(), /you > /, "the conversation is back");
  // Reopening lands straight back on the still-pending review.
  h.send(CTRL_O);
  assert.match(h.lastFramePlain(), /review · gate-ui/, "reopened onto the same review");
  h.send("r");
  assert.equal(await p, "rejected");
  assert.equal(review.calls, 0);
  h.stop();
});

test("while the panel is open, keystrokes drive it and never the prompt", async () => {
  const h = harness();
  const answer = h.tui.question();
  const review = fakeReview(GREEN);
  const p = openReview(h, review);
  h.send("hello"); // 'e','l','o' aren't bindings; must not leak into the buffer
  h.send("r"); // reject to settle the promise
  assert.equal(await p, "rejected");
  h.send("real\r");
  assert.equal(await answer, "real", "nothing leaked into the input buffer");
  h.stop();
});

test("a conflict prepare shows the paths and why, with [m] disabled", async () => {
  const h = harness(undefined, 60, 12);
  const review = fakeReview({
    kind: "conflict",
    conflictFiles: ["src/app.ts", "src/db.ts"],
    detail: "could not apply abc1234... job: right edit",
  });
  const p = openReview(h, review);
  const frame = h.lastFramePlain();
  assert.match(frame, /hit conflicts/, "the state is named");
  assert.match(frame, /src\/app\.ts/);
  assert.match(frame, /src\/db\.ts/);
  assert.match(frame, /could not apply/, "git's account is shown");
  assert.match(frame, /m disabled \(conflict\)/, "the bar says why m is off");
  h.send("m");
  assert.equal(review.calls, 0, "a disabled m never reaches execute");
  assert.match(h.lastFramePlain(), /review · /, "still open");
  h.send("r");
  assert.equal(await p, "rejected");
  h.stop();
});

test("a red-checks prepare names the failing check and links it, with [m] disabled", async () => {
  const h = harness(undefined, 60, 12);
  const review = fakeReview({
    kind: "failed",
    reason: "PR #7: 1 of 2 checks failed: test (ubuntu)",
    checks: panelChecks("failed", [
      { name: "build", bucket: "pass" },
      { name: "test (ubuntu)", bucket: "fail", link: "https://ci.example/9" },
    ]),
  });
  const p = openReview(h, review);
  const frame = h.lastFramePlain();
  assert.match(frame, /CI checks failed/);
  assert.match(frame, /1 of 2 checks failed: test \(ubuntu\)/, "the reason names the check");
  assert.match(frame, /ci\.example\/9/, "and links the run that says why");
  assert.match(frame, /m disabled \(checks red\)/);
  h.send("m");
  assert.equal(review.calls, 0);
  h.send("r");
  assert.equal(await p, "rejected");
  h.stop();
});

test("a still-pending prepare says so and disables [m] — waiting is not a failure", async () => {
  const h = harness(undefined, 60, 12);
  const review = fakeReview({
    kind: "pending",
    reason: "PR #7: 1 of 1 checks still running: test",
    checks: panelChecks("pending", [{ name: "test", bucket: "pending" }]),
  });
  const p = openReview(h, review);
  const frame = h.lastFramePlain();
  assert.match(frame, /have not reported yet/);
  assert.match(frame, /still running: test/);
  assert.match(frame, /m disabled \(checks pending\)/);
  h.send("m");
  assert.equal(review.calls, 0);
  h.send("r");
  assert.equal(await p, "rejected");
  h.stop();
});

test("a refused merge surfaces the error in place; [m] stays off; dismissal reports failed", async () => {
  const h = harness(undefined, 60, 12);
  h.tui.question();
  const review = fakeReview(GREEN);
  const p = openReview(h, review);
  h.send("m");
  review.rejectMerge(
    new Error("'feat/x' is not rebased onto the current 'dev' tip; run prepareLanding again"),
  );
  await settle();
  const frame = h.lastFramePlain();
  assert.match(frame, /merge failed:/, "the refusal banners in place");
  assert.match(frame, /not rebased/, "with the engine's own reason");
  assert.match(frame, /review · gate-ui/, "the review survived the failure");
  h.send("m"); // the refusal disarms m: a stale green needs a fresh prepare
  assert.equal(review.calls, 1);
  h.send("r");
  assert.equal(await p, "failed");
  assert.match(h.lastFrame(), /you > /, "the session is intact");
  h.stop();
});

test("a long diff pages with space and jumps with g/G", async () => {
  // Wide enough that the footer keeps its right-hand position indicator next
  // to the full action bar.
  const h = harness(undefined, 70, 12);
  const lines = Array.from({ length: 100 }, (_, i) => `+line ${i + 1}`);
  const review = fakeReview({
    kind: "green",
    commits: ["abc1234 j"],
    diff: ["diff --git a/f b/f", "@@ -0,0 +100 @@", ...lines].join("\n"),
  });
  const p = openReview(h, review);
  assert.match(h.lastFramePlain(), /\+line 1(?!\d)/, "starts at the top");
  assert.match(h.lastFramePlain(), /more below/, "the bar shows there is more");
  h.send(" ");
  h.send(" ");
  const paged = h.lastFramePlain();
  assert.ok(!/\+line 1(?!\d)/.test(paged), "paged past the first screen");
  assert.match(paged, /\+line 19/);
  h.send("G");
  assert.match(h.lastFramePlain(), /\+line 100/, "G reaches the end");
  h.send("g");
  assert.match(h.lastFramePlain(), /\+line 1(?!\d)/, "g returns to the top");
  assert.equal(review.calls, 0, "paging never merges");
  h.send("r");
  assert.equal(await p, "rejected");
  h.stop();
});

test("a green with no commits shows nothing-to-land and [m] is off", async () => {
  const h = harness();
  const review = fakeReview({ kind: "green", commits: [], diff: "" });
  const p = openReview(h, review);
  const frame = h.lastFramePlain();
  assert.match(frame, /nothing to land/);
  assert.match(frame, /m disabled \(nothing to land\)/);
  h.send("m");
  assert.equal(review.calls, 0);
  h.send("r");
  assert.equal(await p, "rejected");
  h.stop();
});

test("a review registered while the docs tab is open coexists; Tab reaches it", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n" });
  const h = harness(docs);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /a\)\s*plan\.md/, "the doc list is up");
  // Registering a review does NOT grab the screen (non-modal): docs stay up.
  const review = fakeReview(GREEN);
  const p = h.tui.openLandingReview(review);
  await settle();
  assert.match(h.lastFramePlain(), /a\)\s*plan\.md/, "docs still showing; the review didn't take over");
  // Tab reaches the review (no queue is wired, so review is its own tab).
  h.send("\t");
  assert.match(h.lastFramePlain(), /review · gate-ui/, "Tab switched to the pending review");
  // The doc subscription is still live: a write updates the cached list, and Tab
  // back to docs shows it.
  docs.set("fresh.md", "y\n");
  docs.emit("fresh.md");
  await settle();
  h.send("\t"); // review -> docs
  await settle();
  assert.match(h.lastFramePlain(), /fresh\.md/, "docs refreshed underneath");
  h.send("\t"); // docs -> review
  h.send("r");
  assert.equal(await p, "rejected");
  h.stop();
});

test("stopping the Tui with a review pending settles it as rejected", async () => {
  const h = harness();
  const review = fakeReview(GREEN);
  const p = h.tui.openLandingReview(review); // pending, panel never opened
  h.stop();
  assert.equal(await p, "rejected", "teardown never strands the caller");
  assert.equal(review.calls, 0);
});

// --- the queue tab -----------------------------------------------------------

/** A queue source whose snapshot the test swaps between paints, to prove the
 *  panel reads the queue fresh (no cached view). */
function fakeQueue(
  initial: QueuePanelView,
  detail: QueueHeadDetail | null = null,
): QueuePanelSource & { set(v: QueuePanelView): void } {
  let cur = initial;
  return { view: () => cur, headDetail: () => detail, set: (v) => (cur = v) };
}

const emptyQueue: QueuePanelView = { size: 0, head: null, entries: [] };

/**
 * A full panel-native queue source: a snapshot, the head's inline body, and a
 * merge the test resolves by hand so the in-flight window is observable. Counts
 * merge calls to prove [m] fires once and fires only over a ready head — the two
 * properties that matter now the merge has no gate in front of it.
 */
function mergeableQueue(
  view: QueuePanelView,
  detail: QueueHeadDetail | null,
): QueuePanelSource & {
  calls: number;
  set(v: QueuePanelView, d?: QueueHeadDetail | null): void;
  resolveMerge(res: QueueMergeResult): void;
  rejectMerge(e: Error): void;
} {
  let curView = view;
  let curDetail = detail;
  let res: ((r: QueueMergeResult) => void) | null = null;
  let rej: ((e: Error) => void) | null = null;
  const api = {
    calls: 0,
    view: () => curView,
    headDetail: () => curDetail,
    merge(): Promise<QueueMergeResult> {
      api.calls++;
      return new Promise<QueueMergeResult>((resolve, reject) => {
        res = resolve;
        rej = reject;
      });
    },
    set(v: QueuePanelView, d?: QueueHeadDetail | null): void {
      curView = v;
      if (d !== undefined) curDetail = d;
    },
    resolveMerge(r: QueueMergeResult): void {
      res?.(r);
    },
    rejectMerge(e: Error): void {
      rej?.(e);
    },
  };
  return api;
}

/** The canonical ready head: one entry, green, with the PR [m] would merge. */
const READY_VIEW: QueuePanelView = {
  size: 2,
  head: null,
  entries: [
    { feature: "head-a", position: 1, isHead: true, status: "ready", commitsReady: 1 },
    { feature: "head-b", position: 2, isHead: false, status: "queued" },
  ],
};

const READY_DETAIL: QueueHeadDetail = {
  kind: "ready",
  feature: "head-a",
  target: "dev",
  commits: ["abc1234 job: the only slice"],
  checks: panelChecks("passed", [
    { name: "build", bucket: "pass" },
    { name: "test", bucket: "pass" },
  ]),
  pr: {
    number: 42,
    url: "https://github.com/acme/repo/pull/42",
    title: "job: the only slice",
    body: "Feature **head-a** → `dev`.\n\nhello from the feature\n",
  },
};

test("Ctrl-O opens the queue tab first when a queue is wired; an empty queue says so", async () => {
  const q = fakeQueue(emptyQueue);
  const h = harness(undefined, 60, 16, q);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const frame = h.lastFramePlain();
  assert.match(frame, /queue/, "the header names the queue tab");
  assert.match(frame, /merge queue is empty/, "an empty queue is stated, not blank");
  h.stop();
});

/** Open the panel over a one-shot queue snapshot and return the painted frame. */
async function renderQueue(view: QueuePanelView, detail: QueueHeadDetail | null = null): Promise<string> {
  const h = harness(undefined, 72, 20, fakeQueue(view, detail));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const frame = h.lastFramePlain();
  h.stop();
  return frame;
}

test("the queue tab renders queued + ready with head position and commit count", async () => {
  const frame = await renderQueue({
    size: 5,
    head: null,
    entries: [
      { feature: "ready-one", position: 1, isHead: true, status: "ready", commitsReady: 2 },
      { feature: "next-up", position: 2, isHead: false, status: "queued" },
      { feature: "later", position: 3, isHead: false, status: "queued" },
    ],
  });
  assert.match(frame, /1\.\s*ready-one\s+\[ready\]/, "the ready head with its position");
  assert.match(frame, /2 commits ready to land/, "a ready head shows its commit count");
  assert.match(frame, /2\.\s*next-up\s+\[queued\]/, "a follower is queued");
});

test("the queue tab renders a head being processed", async () => {
  const frame = await renderQueue({
    size: 1,
    head: null,
    entries: [{ feature: "proc", position: 1, isHead: true, status: "head-processing" }],
  });
  assert.match(frame, /proc\s+\[processing\]/, "a head being prepared shows processing");
});

test("the queue tab distinguishes a conflict block from a red-checks block", async () => {
  const conflictFrame = await renderQueue({
    size: 1,
    head: null,
    entries: [
      {
        feature: "cft",
        position: 1,
        isHead: true,
        status: "blocked",
        blockedKind: "conflict",
        blockedReason: "rebase conflict in src/app.ts",
      },
    ],
  });
  assert.match(conflictFrame, /cft\s+\[blocked: conflict\]/, "a conflict block is labelled conflict");
  assert.match(conflictFrame, /rebase conflict in src\/app\.ts/, "the reason is shown");
  assert.match(conflictFrame, /fresh agent/, "the resolver route is offered for a fixable block");

  const redFrame = await renderQueue({
    size: 1,
    head: null,
    entries: [
      {
        feature: "red",
        position: 1,
        isHead: true,
        status: "blocked",
        blockedKind: "failed",
        blockedReason: "PR #7: 1 of 2 checks failed: test (ubuntu)",
        resolveAttempts: 1,
      },
    ],
  });
  assert.match(redFrame, /red\s+\[blocked: checks\]/, "a red block is labelled checks, distinct from conflict");
  assert.match(redFrame, /1 of 2 checks failed/, "the reason names what CI said");
  assert.match(redFrame, /resolver attempts: 1/, "spent attempts are surfaced");
});

test("an UNGATED ready head is drawn as ungated, never as a green — the captain is the only gate", async () => {
  const frame = await renderQueue(
    {
      size: 1,
      head: null,
      entries: [
        { feature: "solo", position: 1, isHead: true, status: "ready", commitsReady: 2, ungated: true },
      ],
    },
    {
      kind: "ready",
      feature: "solo",
      target: "dev",
      commits: ["abc1234 job: solo"],
      checks: panelChecks("none", []),
      pr: { number: 3, url: "https://github.com/acme/repo/pull/3", title: "solo", body: "" },
    },
  );
  // The regression this guards: a repo with no CI must not look like a repo
  // whose CI passed. It is mergeable, and it says why nothing verified it.
  assert.match(frame, /solo\s+\[ready: ungated\]/, "the chip says ungated, not ready");
  assert.match(frame, /no CI checks on its PR/, "the list row says why");
  assert.match(frame, /UNGATED/, "and the body leads with it");
  assert.match(frame, /your judgment/);
  assert.ok(!/checks green/.test(frame), "nothing claims a green that never happened");
});

test("a head awaiting CI says what it is waiting on, and offers no [m]", async () => {
  const q = mergeableQueue(
    {
      size: 1,
      head: null,
      entries: [
        { feature: "slow", position: 1, isHead: true, status: "awaiting-checks", checksPending: 2 },
      ],
    },
    {
      kind: "awaiting",
      feature: "slow",
      target: "dev",
      commits: ["abc1234 job: slow"],
      checks: panelChecks("pending", [
        { name: "build", bucket: "pass" },
        { name: "test (ubuntu)", bucket: "pending", link: "https://ci.example/1" },
        { name: "e2e", bucket: "pending" },
      ]),
      pr: { number: 4, url: "https://github.com/acme/repo/pull/4", title: "slow", body: "" },
    },
  );
  const h = harness(undefined, 72, 30, q);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const frame = h.lastFramePlain();
  assert.match(frame, /slow\s+\[awaiting checks\]/);
  assert.match(frame, /waiting on 2 CI checks/);
  assert.match(frame, /WAITING on CI/);
  assert.match(frame, /test \(ubuntu\)/, "the pending checks are named");
  assert.ok(!/press m/.test(frame), "no [m] is offered on a head that is not ready");
  h.send("m");
  assert.equal(q.calls, 0, "and pressing it does nothing");
  h.stop();
});

test("the queue tab shows a resolving head with its attempt", async () => {
  const frame = await renderQueue({
    size: 1,
    head: null,
    entries: [
      { feature: "res", position: 1, isHead: true, status: "resolving", blockedKind: "conflict", resolveAttempts: 2 },
    ],
  });
  assert.match(frame, /res\s+\[resolving\]/, "a resolving head is labelled resolving");
  assert.match(frame, /attempt 2/, "the current attempt is shown");
});

// --- the panel-native merge (D-20260724-12) ----------------------------------
//
// The head figures itself out and then simply CARRIES an [m]. These tests pin
// the properties that replaced the old blocking gate: the ready head's evidence
// renders in the same view as the key; the key merges directly, once; it is a
// dead no-op on anything that isn't green; and nothing anywhere is awaiting the
// keystroke — there is no promise to settle and no review to reject.

test("a ready head renders its PR and checks inline, with a live [m]", async () => {
  const q = mergeableQueue(READY_VIEW, READY_DETAIL);
  const h = harness(undefined, 72, 30, q);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const frame = h.lastFramePlain();
  assert.match(frame, /head-a\s+\[ready\]/, "the head's list row");
  assert.match(frame, /press m to merge PR #42 into dev/, "the affordance names what it does");
  assert.match(frame, /PR #42 → dev · 1 commit/, "the summary counts the merge");
  assert.match(frame, /pull\/42/, "the PR's URL is there to open or edit it");
  assert.match(frame, /checks green · 2 checks passed/, "the evidence is stated");
  assert.match(frame, /abc1234 job: the only slice/, "the commit list is inline");
  assert.match(frame, /hello from the feature/, "and so is the PR message — no drill needed");
  assert.match(frame, /m\s*merge/, "the footer offers the key");
  assert.equal(q.calls, 0, "showing the head merges nothing");
  h.stop();
});

test("a ready head shows the PR's own message — title, description, commits — and never co's fence", async () => {
  // The loop this closes: the composed message is what actually goes to GitHub,
  // and the panel used to dump the raw body (fence markers, a second copy of the
  // checks and commits) or nothing at all. Now it paints the message and lets
  // the evidence block above it be the evidence (D-20260727-10).
  const body = [
    "Checkout flow, in 2 commits.",
    "",
    "<!-- co:evidence -->",
    "### Checks",
    "**green** — 1 check passed.",
    "",
    "### Commits (2)",
    "- `abc1234` job: card form",
    "- `def5678` job: totals",
    "<!-- /co:evidence -->",
  ].join("\n");
  const q = fakeQueue(
    {
      size: 1,
      head: null,
      entries: [{ feature: "checkout", position: 1, isHead: true, status: "ready", commitsReady: 2 }],
    },
    {
      kind: "ready",
      feature: "checkout",
      target: "dev",
      commits: ["abc1234 job: card form", "def5678 job: totals"],
      checks: panelChecks("passed", [{ name: "ci", bucket: "pass" }]),
      pr: {
        number: 9,
        url: "https://github.com/acme/repo/pull/9",
        title: "feat: checkout flow",
        body,
        prose: "Checkout flow, in 2 commits.",
      },
    },
  );
  const h = harness(undefined, 72, 30, q);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const frame = h.lastFramePlain();

  assert.match(frame, /── pull request ──/, "the message gets a block of its own");
  assert.match(frame, /feat: checkout flow/, "the PR title is shown back");
  assert.match(frame, /Checkout flow, in 2 commits\./, "and the description prose");
  assert.match(frame, /commits \(2\)/, "with the commits it carries");
  assert.match(frame, /abc1234 job: card form/);
  assert.match(frame, /def5678 job: totals/);
  assert.match(frame, /checks green/, "the checks evidence is still there, above and separate");
  // The fence is co's plumbing: HTML comments GitHub hides, wrapping checks and
  // a commit list this view already draws itself. None of it belongs on screen.
  assert.ok(!frame.includes("co:evidence"), "no fence marker is painted");
  assert.ok(!frame.includes("### Checks"), "and no raw markdown out of the block it fences");
  assert.ok(!frame.includes("- `abc1234`"), "the commits are not painted twice");
  h.stop();
});

test("a head awaiting CI still shows what its PR will land — only the verdict is missing", async () => {
  const q = fakeQueue(
    {
      size: 1,
      head: null,
      entries: [{ feature: "slow", position: 1, isHead: true, status: "awaiting-checks", checksPending: 1 }],
    },
    {
      kind: "awaiting",
      feature: "slow",
      target: "dev",
      commits: ["abc1234 job: the slice"],
      checks: panelChecks("pending", [{ name: "ci", bucket: "pending" }]),
      pr: {
        number: 11,
        url: "https://github.com/acme/repo/pull/11",
        title: "feat: slow thing",
        body: "Slow thing.",
        prose: "Slow thing.",
      },
    },
  );
  const h = harness(undefined, 72, 30, q);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const frame = h.lastFramePlain();
  assert.match(frame, /WAITING on CI/, "the wait still leads");
  assert.match(frame, /feat: slow thing/, "and the message is readable while it waits");
  assert.match(frame, /Slow thing\./);
  assert.match(frame, /commits \(1\)/);
  h.stop();
});

test("a PR with no description says so rather than showing an empty block", async () => {
  const q = fakeQueue(
    {
      size: 1,
      head: null,
      entries: [{ feature: "bare", position: 1, isHead: true, status: "ready", commitsReady: 1 }],
    },
    {
      kind: "ready",
      feature: "bare",
      target: "dev",
      commits: ["abc1234 job: bare"],
      checks: panelChecks("passed", [{ name: "ci", bucket: "pass" }]),
      pr: { number: 12, url: "https://github.com/acme/repo/pull/12", title: "feat: bare", body: "", prose: "" },
    },
  );
  const h = harness(undefined, 72, 30, q);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const frame = h.lastFramePlain();
  assert.match(frame, /feat: bare/, "the title is still the title");
  assert.match(frame, /\(no description\)/, "an empty description is stated, not blank");
  assert.match(frame, /abc1234 job: bare/, "and the commits still show what lands");
  h.stop();
});

test("[m] merges the ready head directly, once, and the panel shows the advance", async () => {
  const q = mergeableQueue(READY_VIEW, READY_DETAIL);
  const h = harness(undefined, 72, 20, q);
  h.tui.question();
  h.send(CTRL_O);
  await settle();

  h.send("m");
  assert.equal(q.calls, 1, "the keystroke merged, with no tool call and no gate");
  assert.match(h.lastFramePlain(), /merging head-a/, "the tab says what is in flight");
  // Fire-once: repeats during the merge are no-ops.
  h.send("m");
  h.send("m");
  assert.equal(q.calls, 1);

  // The engine advances the queue before resolving, exactly as mergeReadyHead
  // does (merge, teardown, advance, process the next head).
  q.set(
    { size: 1, head: null, entries: [{ feature: "head-b", position: 1, isHead: true, status: "ready", commitsReady: 2 }] },
    {
      kind: "ready",
      feature: "head-b",
      target: "dev",
      commits: ["def job: b"],
      pr: { number: 43, url: "https://github.com/acme/repo/pull/43", title: "b", body: "b" },
    },
  );
  q.resolveMerge({ merged: true, summary: "merged head-a: abc1234 on dev" });
  await settle();

  const frame = h.lastFramePlain();
  assert.match(frame, /head-b\s+\[ready\]/, "the panel reflects the advanced queue");
  assert.ok(!frame.includes("head-a"), "the merged head is gone from the view");
  assert.match(frame, /press m to merge PR #43 into dev/, "the NEXT head's [m] is live now");
  h.stop();
});

test("[m] is a no-op on a blocked head, and the block is shown instead", async () => {
  const q = mergeableQueue(
    {
      size: 1,
      head: null,
      entries: [
        {
          feature: "stuck",
          position: 1,
          isHead: true,
          status: "blocked",
          blockedKind: "conflict",
          blockedReason: "rebase conflict in src/app.ts",
        },
      ],
    },
    {
      kind: "blocked",
      feature: "stuck",
      target: "dev",
      blockedKind: "conflict",
      reason: "rebase conflict in src/app.ts",
      conflictFiles: ["src/app.ts"],
      detail: "could not apply 1234567",
      resolveAttempts: 0,
      maxResolveAttempts: 3,
    },
  );
  const h = harness(undefined, 72, 24, q);
  h.tui.question();
  h.send(CTRL_O);
  await settle();

  const frame = h.lastFramePlain();
  assert.match(frame, /stuck\s+\[blocked: conflict\]/);
  assert.match(frame, /BLOCKED \(rebase conflict\)/, "the block leads the body");
  assert.match(frame, /no \[m\] on this head/, "and says plainly there is no merge here");
  assert.match(frame, /src\/app\.ts/, "the conflicted path is named");
  assert.match(frame, /could not apply/, "git's own account is shown");
  assert.ok(!/m\s+merge/.test(frame), "the footer offers no merge key");

  h.send("m");
  h.send("m");
  assert.equal(q.calls, 0, "[m] on a blocked head does nothing at all");
  h.stop();
});

test("[m] is a no-op on a head that is still processing", async () => {
  const q = mergeableQueue(
    { size: 1, head: null, entries: [{ feature: "proc", position: 1, isHead: true, status: "head-processing" }] },
    null,
  );
  const h = harness(undefined, 72, 16, q);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /proc\s+\[processing\]/);
  h.send("m");
  assert.equal(q.calls, 0, "there is nothing green to merge yet");
  h.stop();
});

test("a refused merge banners in place and leaves the head where it is", async () => {
  const q = mergeableQueue(READY_VIEW, READY_DETAIL);
  const h = harness(undefined, 72, 24, q);
  h.tui.question();
  h.send(CTRL_O);
  await settle();

  h.send("m");
  assert.equal(q.calls, 1);
  q.resolveMerge({
    merged: false,
    summary: "merging head-a was refused",
    error: "'feat/head-a' has moved since prepare",
  });
  await settle();

  const frame = h.lastFramePlain();
  assert.match(frame, /merge failed: 'feat\/head-a' has moved since prepare/, "the refusal is visible, not a flash");
  assert.match(frame, /head-a\s+\[ready\]/, "the head is still there");
  // And the key still works afterwards: nothing latched shut.
  h.send("m");
  assert.equal(q.calls, 2, "[m] is live again after a refusal");
  h.stop();
});

test("a merge callback that throws is caught and reported, never wedging the panel", async () => {
  const q = mergeableQueue(READY_VIEW, READY_DETAIL);
  const h = harness(undefined, 72, 24, q);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("m");
  q.rejectMerge(new Error("git exploded"));
  await settle();
  assert.match(h.lastFramePlain(), /merge failed: git exploded/);
  h.send("m");
  assert.equal(q.calls, 2, "the in-flight interlock released");
  h.stop();
});

test("the queue tab pages its inline PR body with space/b and jumps with g/G", async () => {
  const long = Array.from({ length: 60 }, (_, i) => `queue body line ${i}`).join("\n");
  const q = mergeableQueue(READY_VIEW, {
    ...READY_DETAIL,
    pr: { ...READY_DETAIL.pr!, body: long },
  });
  const h = harness(undefined, 60, 12, q);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const first = h.lastFramePlain();
  assert.match(first, /head-a\s+\[ready\]/, "the list is at the top");

  h.send(" "); // page down into the PR body
  const paged = h.lastFramePlain();
  assert.notEqual(paged, first, "space scrolled the tab");
  assert.match(paged, /queue body line/, "paging reaches the inline PR message");

  h.send("G");
  assert.match(h.lastFramePlain(), /queue body line 59/, "G jumps to the end");
  h.send("g");
  assert.match(h.lastFramePlain(), /head-a\s+\[ready\]/, "g returns to the top");
  // A merge is still one keystroke away from anywhere in the body.
  h.send("m");
  assert.equal(q.calls, 1, "[m] is not shadowed by the paging keys");
  h.stop();
});

test("a queue source with no merge callback offers no [m] and stays read-only", async () => {
  const q = fakeQueue({
    size: 1,
    head: null,
    entries: [{ feature: "readonly", position: 1, isHead: true, status: "ready", commitsReady: 1 }],
  });
  const h = harness(undefined, 72, 16, q);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const frame = h.lastFramePlain();
  assert.match(frame, /readonly\s+\[ready\]/);
  assert.ok(!/press m to merge/.test(frame), "no affordance without a merge callback");
  h.send("m"); // must not throw
  await settle();
  assert.match(h.lastFramePlain(), /readonly\s+\[ready\]/, "still fine");
  h.stop();
});

test("a source with a merge but no head body still offers [m], without naming a target it wasn't told", async () => {
  // The tolerant branch of the one [m]-is-live predicate: trust the view when
  // there is no body source, but never invent an integration branch name.
  let calls = 0;
  const q: QueuePanelSource = {
    view: () => ({
      size: 1,
      head: null,
      entries: [{ feature: "bodyless", position: 1, isHead: true, status: "ready", commitsReady: 1 }],
    }),
    merge: async () => {
      calls++;
      return { merged: true, summary: "merged bodyless" };
    },
  };
  const h = harness(undefined, 72, 16, q);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const frame = h.lastFramePlain();
  assert.match(frame, /press m to merge it$|press m to merge it\s/, "the hint omits the unknown target");
  assert.ok(!frame.includes("merge it onto"), "and does not guess one");
  h.send("m");
  assert.equal(calls, 1, "the key still merges");
  h.stop();
});

test("a feature_land review keeps its own tab and its own [m] alongside the queue", async () => {
  // The two merges must never share a key: the queue tab's [m] is the queue's,
  // and a pending feature_land review lives on its own tab with m/r as before.
  const q = mergeableQueue(READY_VIEW, READY_DETAIL);
  const h = harness(undefined, 72, 24, q);
  h.tui.question();
  const review = fakeReview(GREEN);
  const p = h.tui.openLandingReview(review);
  h.send(CTRL_O);
  await settle();
  // A pending review wins the landing spot, since it is a caller held open.
  assert.match(h.lastFramePlain(), /review · gate-ui → dev/, "opens onto the review");

  h.send("\t"); // review -> queue (tabs cycle round)
  await settle();
  assert.match(h.lastFramePlain(), /head-a\s+\[ready\]/, "Tab reaches the queue tab");
  h.send("m");
  assert.equal(q.calls, 1, "the queue tab's [m] merged the queue head");
  assert.equal(review.calls, 0, "and never touched the feature_land review");
  q.resolveMerge({ merged: true, summary: "merged head-a" });
  await settle();

  // The review is still pending on its own tab, with its own keys.
  h.send("\t");
  await settle();
  assert.match(h.lastFramePlain(), /review · gate-ui/, "the review tab survived the queue merge");
  h.send("r");
  assert.equal(await p, "rejected");
  h.stop();
});

// --- the panel keybinds: Ctrl-O toggles, `i` mirrors Tab (D-20260724-9) -------
//
// The context split is the whole point of these: the panel's key space is live
// ONLY while the panel owns the keyboard, so `i` cycles tabs there and stays an
// ordinary typed letter at the input line. Ctrl-O is now one key for both
// directions, in every spelling a terminal can send it.

test("Ctrl-O toggles: the key that opened the panel closes it, and reopens it", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n" });
  const h = harness(docs);
  const answer = h.tui.question();

  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /a\)\s*plan\.md/, "open");

  h.send(CTRL_O); // the same key closes it
  await settle();
  let frame = h.lastFramePlain();
  assert.ok(!frame.includes("1) plan.md"), "the panel is gone");
  assert.match(frame, /you > /, "the conversation is back");

  h.send(CTRL_O); // and opens it again
  await settle();
  assert.match(h.lastFramePlain(), /a\)\s*plan\.md/, "reopened");

  // Neither the open nor the close leaked a keystroke into the input buffer.
  h.send(CTRL_O);
  await settle();
  h.send("typed\r");
  assert.equal(await answer, "typed");
  h.stop();
});

test("Ctrl-O closes the panel in its enhanced-protocol spellings too", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n" });
  for (const [name, seq] of [
    ["Kitty CSI-u", "\x1b[111;5u"],
    ["xterm modifyOtherKeys", "\x1b[27;5;111~"],
  ] as const) {
    const h = harness(docs);
    h.tui.question();
    h.send(CTRL_O);
    await settle();
    assert.match(h.lastFramePlain(), /a\)\s*plan\.md/, `${name}: open`);
    h.send(seq);
    await settle();
    assert.match(h.lastFramePlain(), /you > /, `${name}: closed`);
    h.stop();
  }
});

test("Ctrl-O leaves a merge in flight alone, exactly as Esc does", async () => {
  const h = harness(); // no docs/queue: the panel opens straight onto the review
  h.tui.question();
  const review = fakeReview(GREEN);
  const p = openReview(h, review);
  h.send("m");
  assert.equal(review.calls, 1);
  h.send(CTRL_O); // the mid-merge lockout wins over the toggle
  assert.match(h.lastFramePlain(), /review · gate-ui/, "still open mid-merge");
  review.resolveMerge("landed gate-ui: abc1234 on dev");
  await settle();
  assert.equal(await p, "merged");
  h.stop();
});

test("`i` cycles the panel's tabs identically to Tab", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n" });
  const h = harness(docs, 60, 16, fakeQueue(emptyQueue));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /merge queue is empty/, "opens on the queue tab");

  h.send("i"); // queue -> docs
  await settle();
  assert.match(h.lastFramePlain(), /a\)\s*plan\.md/, "`i` reached the docs tab");

  h.send("i"); // docs -> queue (cycles, doesn't dead-end)
  await settle();
  assert.match(h.lastFramePlain(), /merge queue is empty/, "`i` cycled back");

  // Tab from the same state lands in the same place: one binding, two spellings.
  h.send("\t");
  await settle();
  assert.match(h.lastFramePlain(), /a\)\s*plan\.md/, "Tab does what `i` did");
  h.stop();
});

test("`i` cycles tabs in the protocol's CSI-u spelling too", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n" });
  const h = harness(docs, 60, 16, fakeQueue(emptyQueue));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("\x1b[105u"); // a bare `i` reported as CSI 105 u
  await settle();
  assert.match(h.lastFramePlain(), /a\)\s*plan\.md/, "the CSI-u `i` switched tabs");
  h.stop();
});

test("`i` in an open doc pops back to the docs tab, mirroring Tab", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n" });
  const h = harness(docs);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a");
  await settle();
  assert.match(h.lastFramePlain(), /docs · plan\.md/, "in the doc");
  h.send("i");
  await settle();
  assert.match(h.lastFramePlain(), /a\)\s*plan\.md/, "`i` popped back to the list");
  h.stop();
});

test("with the panel closed, `i` is a literal typed character and never a tab switch", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n" });
  const h = harness(docs);
  const answer = h.tui.question();
  // Straight typing: every `i` lands in the buffer.
  h.send("indistinguishable inis");
  await settle();
  assert.match(h.lastFramePlain(), /indistinguishable inis/, "the input line shows what was typed");
  // And after the panel has been opened and toggled shut, the editor still owns `i`.
  h.send(CTRL_O);
  await settle();
  h.send(CTRL_O);
  await settle();
  h.send(" i\r");
  assert.equal(await answer, "indistinguishable inis i", "nothing intercepted the i's");
  h.stop();
});

test("no doc is labelled `i` or with a digit, so no panel key can shadow a selector", async () => {
  const many: Record<string, string> = {};
  for (let n = 1; n <= 18; n++) many[`doc-${String(n).padStart(2, "0")}.md`] = `# ${n}\n`;
  const docs = fakeDocs(many);
  const h = harness(docs, 40, 30);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const frame = h.lastFramePlain();
  assert.match(frame, /a\)\s*doc-01\.md/, "the alphabet starts at a — the digits are the tab bar's");
  assert.match(frame, /h\)\s*doc-08\.md/, "letters carry on to h");
  assert.match(frame, /j\)\s*doc-09\.md/, "and skip straight to j");
  assert.ok(!/\bi\)/.test(frame), "no `i)` label exists to be shadowed");
  assert.ok(!/\b[1-9]\)/.test(frame), "and no digit label either");
  // Pressing either with only one tab wired switches nothing and opens nothing.
  h.send("i");
  await settle();
  assert.ok(!h.lastFramePlain().includes("docs · doc-"), "`i` opened no doc");
  h.send("1");
  await settle();
  assert.ok(!h.lastFramePlain().includes("docs · doc-"), "and neither did `1`");
  h.stop();
});

// --- the inbox tab -------------------------------------------------------------
//
// The rolling record of filed crew reviews (D-20260724-8). It is a READ surface:
// a list of what the co filed, newest first, each drilling into its full body.
// Nothing here can merge, reject, or act on anything — that's the queue tab's
// job, and keeping the two key spaces apart is why they're separate tabs.

/** An inbox source whose snapshot the test swaps between paints, to prove the
 *  panel reads it fresh (no cached list) — the same contract as fakeQueue. */
function fakeInbox(initial: InboxPanelEntry[]): {
  list(): InboxPanelEntry[];
  set(v: InboxPanelEntry[]): void;
} {
  let cur = initial;
  return { list: () => cur, set: (v) => (cur = v) };
}

const REVIEWS: InboxPanelEntry[] = [
  {
    level: "L1",
    verdict: "rework",
    headline: "auth middleware never ran",
    body: "Went wrong: the middleware is registered after the route.\n\nVerdict: rework.",
    timestamp: "2026-07-24T11:05:00.000Z",
    jobId: "job-003",
    feature: "auth",
  },
  {
    level: "L2",
    verdict: "fix-commit",
    headline: "shipped, migration untested",
    body: "Went right: endpoint ships.\n\nVerdict: fix-commit.",
    timestamp: "2026-07-24T10:40:00.000Z",
    jobId: "job-002",
  },
  {
    level: "L3",
    verdict: "accept",
    headline: "rename landed clean",
    body: "All criteria met.\n\nVerdict: accept.",
    timestamp: "2026-07-24T09:12:00.000Z",
    jobId: "job-001",
  },
];

test("the inbox tab lists filed reviews newest-first with level, verdict and headline", async () => {
  const h = harness(undefined, 72, 16, undefined, fakeInbox(REVIEWS));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const frame = h.lastFramePlain();
  assert.match(frame, /inbox/, "the header names the inbox tab");
  assert.match(frame, /a\)\s*\[L1\]\s*rework\s+auth middleware never ran/, "newest is first, label 1");
  assert.match(frame, /b\)\s*\[L2\]\s*fix-commit\s+shipped, migration untested/);
  assert.match(frame, /c\)\s*\[L3\]\s*accept\s+rename landed clean/);
  // A list row is a summary: the body stays out of it until you open one.
  assert.ok(!frame.includes("middleware is registered"), "bodies aren't in the list");
  h.stop();
});

/** The panel's rows as PAINTED, split out of the frame by the cursor moves that
 *  place them. lastFramePlain() abuts the rows, which hides a row's indent. */
function paintedRows(h: Harness): string[] {
  return h.lastFrame().split(/\x1b\[\d+;1H/).slice(1).map(stripAnsi);
}

test("every inbox row keeps its two-space indent when the headline runs past the edge", async () => {
  // Each painted row goes through clip(), which truncates by word-wrapping, and
  // a wrap point drops a leading space run (wrap.ts). An entry built wider than
  // the screen therefore came back flush against the left edge while its shorter
  // neighbours stayed indented, so the list's left margin went ragged entry by
  // entry. The rows are laid out to the width now, so none of them reach clip().
  const long: InboxPanelEntry[] = REVIEWS.map((r, i) => ({
    ...r,
    headline: `entry ${i + 1} with a headline far past the right-hand edge of this panel`,
  }));
  const h = harness(undefined, 60, 14, undefined, fakeInbox([...long, ...REVIEWS]));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const rows = paintedRows(h).filter((r) => /\w\) \[L\d\]/.test(r));
  assert.equal(rows.length, 6, "a row per entry, long and short alike");
  for (const r of rows) {
    assert.match(r, /^ {2}\S/, `indented by exactly two: ${JSON.stringify(r)}`);
    assert.ok(r.length <= 60, `laid out inside the width: ${r.length} in ${JSON.stringify(r)}`);
  }
  h.stop();
});

test("a drilled-in review keeps its header indent when the headline wraps", () => {
  const entry: InboxPanelEntry = {
    ...REVIEWS[0]!,
    headline: "a headline long enough that it has to wrap onto a second visual row here",
  };
  const rows = renderInboxItem(entry, 40).map(stripAnsi);
  assert.equal(rows[0], "", "the entry opens with one blank line and no more");
  const header = rows.slice(1, rows.indexOf("", 1));
  assert.ok(header.length > 2, "the headline and metadata both wrapped");
  for (const r of header) {
    assert.match(r, /^ {2}\S/, `header row indented by exactly two: ${JSON.stringify(r)}`);
  }
});

test("selecting a review drills into its full body and pages; Backspace returns to the list", async () => {
  const long = Array.from({ length: 60 }, (_, i) => `body line ${i + 1}`).join("\n");
  const entries: InboxPanelEntry[] = [
    { ...REVIEWS[0]!, body: long },
    ...REVIEWS.slice(1),
  ];
  const h = harness(undefined, 72, 16, undefined, fakeInbox(entries));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a");
  await settle();
  const opened = h.lastFramePlain();
  assert.match(opened, /inbox · L1 rework/, "the header names the open review");
  assert.match(opened, /auth middleware never ran/, "the headline leads the body view");
  assert.match(opened, /job-003/, "the metadata line names the job");
  // Painted rows abut in the frame, so the first two lines prove the top.
  assert.match(opened, /body line 1body line 2/);
  assert.ok(!opened.includes("body line 60"), "a long body starts at the top");

  h.send(" "); // page down, the same less-style paging docs and diffs use
  assert.ok(!h.lastFramePlain().includes("body line 1body line 2"), "paged past the start");
  h.send("G");
  assert.match(h.lastFramePlain(), /body line 60/, "G jumps to the end");

  h.send("\x7f"); // Backspace
  assert.match(h.lastFramePlain(), /b\)\s*\[L2\]/, "back on the inbox list");
  h.send(ESC);
  h.stop();
});

test("an empty inbox says so rather than showing a blank tab", async () => {
  const h = harness(undefined, 60, 12, undefined, fakeInbox([]));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /No reviews filed yet/);
  h.send("a"); // a stray selector on an empty list is a no-op, not a crash
  await settle();
  h.send(ESC);
  h.stop();
});

test("the inbox reads its source fresh: a review filed while the panel is open shows up", async () => {
  const src = fakeInbox([REVIEWS[2]!]);
  const h = harness(undefined, 72, 16, undefined, src);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /a\)\s*\[L3\]/);
  // The co files a new one mid-session; the next paint picks it up. Transcript
  // output coalesces its frame (~60fps), so wait for it rather than the tick.
  src.set([REVIEWS[0]!, REVIEWS[2]!]);
  h.tui.appendBlock("something happened");
  await frame();
  assert.match(h.lastFramePlain(), /a\)\s*\[L1\]\s*rework/, "the new review is now first");
  h.stop();
});

test("Tab cycles queue → docs → inbox and back, and each tab keeps its own keys", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n" });
  const q = fakeQueue({
    size: 1,
    head: null,
    entries: [{ feature: "headfeat", position: 1, isHead: true, status: "queued" }],
  });
  const h = harness(docs, 72, 16, q, fakeInbox(REVIEWS));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /headfeat/, "opens on the queue tab, as before");
  h.send("\t");
  await settle();
  assert.match(h.lastFramePlain(), /a\)\s*plan\.md/, "Tab reaches docs");
  h.send("\t");
  await settle();
  assert.match(h.lastFramePlain(), /a\)\s*\[L1\]\s*rework/, "Tab reaches the inbox");
  h.send("\t");
  await settle();
  assert.match(h.lastFramePlain(), /headfeat/, "and wraps back to the queue");

  // Sub-view → its own tab: open a review, Tab pops back to the inbox list.
  h.send("\t");
  h.send("\t");
  await settle();
  h.send("b");
  await settle();
  assert.match(h.lastFramePlain(), /inbox · L2 fix-commit/);
  h.send("\t");
  assert.match(h.lastFramePlain(), /c\)\s*\[L3\]/, "Tab from an open review returns to the list");
  h.stop();
});

test("with only an inbox wired, Ctrl-O opens it and keystrokes never reach the prompt", async () => {
  const h = harness(undefined, 72, 16, undefined, fakeInbox(REVIEWS));
  const answer = h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /rename landed clean/);
  h.send("hello"); // would otherwise land in the input buffer
  await settle();
  h.send(ESC);
  h.send("real\r");
  assert.equal(await answer, "real");
  h.stop();
});

// --- the panel keybinds meet the inbox tab -----------------------------------
//
// `i`/Ctrl-O (D-20260724-9) and the inbox tab (D-20260724-8) were built against
// a two-tab panel and a queue/docs panel respectively; these pin the behaviour
// where they meet. `i` is safe as the inbox's tab key for the same reason it is
// safe as the docs': it isn't in OVERLAY_LABELS, so it can't shadow a row.

test("`i` cycles the third tab too, and pops back out of an open review", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n" });
  const h = harness(docs, 72, 16, fakeQueue(emptyQueue), fakeInbox(REVIEWS));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /merge queue is empty/, "opens on the queue tab");

  h.send("i"); // queue -> docs
  await settle();
  assert.match(h.lastFramePlain(), /a\)\s*plan\.md/, "`i` reached docs");

  h.send("i"); // docs -> inbox, the tab that didn't exist when `i` was bound
  await settle();
  assert.match(h.lastFramePlain(), /a\)\s*\[L1\]\s*rework/, "`i` reached the inbox");

  h.send("i"); // inbox -> queue, all three cycled
  await settle();
  assert.match(h.lastFramePlain(), /merge queue is empty/, "`i` wrapped back round");

  // From a filed review's body `i` pops back to the list, exactly as it does
  // from an open doc — the sub-view returns to its own tab, not the next one.
  h.send("i");
  h.send("i");
  await settle();
  h.send("b");
  await settle();
  assert.match(h.lastFramePlain(), /inbox · L2 fix-commit/, "in the review body");
  h.send("i");
  await settle();
  assert.match(h.lastFramePlain(), /c\)\s*\[L3\]/, "`i` returned to the inbox list");
  h.stop();
});

test("no filed review is labelled `i` or with a digit, so no panel key shadows a row", async () => {
  // The inbox caps at 20, which runs well past where `i` sits — exactly where a
  // dead label would show up — and the whole list is inside the 25-label
  // alphabet, so dropping the digits costs the inbox nothing.
  const many: InboxPanelEntry[] = Array.from({ length: 20 }, (_, n) => ({
    ...REVIEWS[2]!,
    headline: `review ${String(n + 1).padStart(2, "0")}`,
    jobId: `job-${String(n + 1).padStart(3, "0")}`,
  }));
  const h = harness(undefined, 72, 30, undefined, fakeInbox(many));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const frame = h.lastFramePlain();
  assert.match(frame, /a\)\s*\[L3\]\s*accept\s+review 01/, "the first row is `a`, not `1`");
  assert.match(frame, /h\)\s*\[L3\]\s*accept\s+review 08/, "letters run up to h");
  assert.match(frame, /j\)\s*\[L3\]\s*accept\s+review 09/, "and skip `i` for j");
  assert.match(frame, /u\)\s*\[L3\]\s*accept\s+review 20/, "and the last of the 20 still has one");
  assert.ok(!/\bi\)/.test(frame), "no `i)` label exists to be shadowed");
  assert.ok(!/\b[1-9]\)/.test(frame), "and no digit label either");
  h.stop();
});

test("Ctrl-O closes the panel from the inbox tab and from an open review", async () => {
  const h = harness(undefined, 72, 16, undefined, fakeInbox(REVIEWS));
  const answer = h.tui.question();

  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /a\)\s*\[L1\]\s*rework/, "on the inbox tab");
  h.send(CTRL_O); // the list takes its own escape exit: the panel closes
  await settle();
  assert.match(h.lastFramePlain(), /you > /, "closed from the list");

  h.send(CTRL_O);
  await settle();
  h.send("a");
  await settle();
  assert.match(h.lastFramePlain(), /inbox · L1 rework/, "drilled into a review");
  h.send(CTRL_O); // and from the body, which Backspace would only pop back from
  await settle();
  assert.match(h.lastFramePlain(), /you > /, "closed from the body");

  h.send("typed\r");
  assert.equal(await answer, "typed", "no toggle leaked a keystroke into the buffer");
  h.stop();
});


// --- the Home tab (the task table over every tracked worktree) ----------------
//
// The panel's landing page, and the two questions it answers: what are we doing
// (the co's at-a-glance task table, stored and painted rather than re-printed
// into the chat), and what is in flight (every tracked worktree, including the
// ones still being worked, which the queue never sees because it holds only what
// has been marked done). It is read-only by construction — no selector, no [m] —
// so the tests below assert both what it shows and what it deliberately cannot
// do, which is what lets it be the tab Ctrl-O opens on.

function fakeFeatures(
  initial: FeaturePanelEntry[],
): FeaturePanelSource & { set(v: FeaturePanelEntry[]): void; refreshes: number } {
  let cur = initial;
  const api = {
    refreshes: 0,
    list: () => cur,
    set: (v: FeaturePanelEntry[]) => (cur = v),
    refresh: () => {
      api.refreshes++;
      return Promise.resolve();
    },
  };
  return api;
}

/**
 * A task source with the captain's three writes wired, standing in for the real
 * store: one table, addressed by exact row text, refusing what the store refuses
 * (a duplicate row, a row that isn't there) rather than throwing. It refuses
 * nothing on a row COUNT, because the store no longer does either.
 *
 * `writes` records what the panel actually asked for, which is the half a frame
 * assertion cannot see — a key that repaints a row it never persisted would look
 * identical on screen.
 */
type FakeTasks = TaskPanelSource & {
  set(v: TaskPanelRow[]): void;
  writes: string[];
  /** Set to refuse the next write with this message, as a duplicate row would. */
  refuse: string | null;
};

function fakeTasks(initial: TaskPanelRow[], opts: { readOnly?: boolean } = {}): FakeTasks {
  let cur = initial;
  const api: FakeTasks = {
    list: () => cur,
    set: (v) => (cur = v),
    writes: [],
    refuse: null,
  };
  if (opts.readOnly) return api;
  const guard = (what: string): { ok: boolean; message?: string } | null => {
    api.writes.push(what);
    if (api.refuse === null) return null;
    const message = api.refuse;
    api.refuse = null;
    return { ok: false, message };
  };
  api.add = (task) => {
    const refused = guard(`add:${task}`);
    if (refused) return Promise.resolve(refused);
    if (cur.some((r) => r.task === task)) {
      return Promise.resolve({ ok: false, message: `The table already holds "${task}".` });
    }
    cur = [...cur, { task, status: "queued" }];
    return Promise.resolve({ ok: true });
  };
  api.setStatus = (task, status) => {
    const refused = guard(`status:${task}:${status}`);
    if (refused) return Promise.resolve(refused);
    cur = cur.map((r) => (r.task === task ? { ...r, status } : r));
    return Promise.resolve({ ok: true });
  };
  // Rewrites the text IN PLACE, like the store: same status, same index. A fake
  // that appended instead would hide the one thing the panel test is for.
  api.rename = (task, next) => {
    const refused = guard(`rename:${task}:${next}`);
    if (refused) return Promise.resolve(refused);
    cur = cur.map((r) => (r.task === task ? { ...r, task: next } : r));
    return Promise.resolve({ ok: true });
  };
  api.retire = (task) => {
    const refused = guard(`retire:${task}`);
    if (refused) return Promise.resolve(refused);
    cur = cur.filter((r) => r.task !== task);
    return Promise.resolve({ ok: true });
  };
  return api;
}

const FEATURES: FeaturePanelEntry[] = [
  {
    feature: "checkout",
    branch: "co/feat-checkout",
    intent: "stripe checkout with saved cards",
    status: "ready",
    busy: false,
    position: 1,
  },
  {
    feature: "user-auth",
    branch: "co/feat-user-auth",
    intent: "passkey login for the web app",
    status: "queued",
    busy: false,
    position: 2,
  },
  {
    feature: "search",
    branch: "co/feat-search",
    intent: "full-text search over the docs tier",
    status: "working",
    busy: true,
  },
];

const TASKS: TaskPanelRow[] = [
  { task: "ctrl-o overhaul", status: "building" },
  { task: "bedrock retry backoff", status: "queued" },
  { task: "pricing table refresh", status: "queued" },
];

test("Home shows the task table above the worktree list", async () => {
  const h = harness(undefined, 90, 24, undefined, undefined, fakeFeatures(FEATURES), fakeTasks(TASKS));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const frame = h.lastFramePlain();

  // The table first: status in a fixed left column, then the name. No Type.
  assert.match(frame, /building\s+ctrl-o overhaul/);
  assert.match(frame, /queued\s+bedrock retry backoff/);
  // Then the worktrees, one line each, carrying all four facts.
  assert.match(frame, /checkout\s+\[ready to merge\]\s+co\/feat-checkout\s+stripe checkout with saved cards/);
  assert.match(frame, /user-auth\s+\[queued #2\]\s+co\/feat-user-auth\s+passkey login for the web app/);
  // The whole point of the list: a feature still being worked, which the queue
  // never sees.
  assert.match(frame, /search\s+\[crew running\]\s+co\/feat-search\s+full-text search over the docs tier/);

  // Order is load-bearing: the table is what the tab is FOR, so it leads.
  const rows = screenRows(h);
  const tableAt = rows.findIndex((r) => /ctrl-o overhaul/.test(r));
  const treesAt = rows.findIndex((r) => /co\/feat-checkout/.test(r));
  assert.ok(tableAt > 0, "the table is painted");
  assert.ok(treesAt > 0, "and so are the worktrees");
  assert.ok(tableAt < treesAt, "tasks above worktrees");
  h.stop();
});

test("Home is the tab Ctrl-O opens on, ahead of the queue", async () => {
  const q = mergeableQueue(READY_VIEW, READY_DETAIL);
  const h = harness(fakeDocs({ "plan.md": "# Plan\n" }), 90, 24, q, fakeInbox(REVIEWS), fakeFeatures(FEATURES), fakeTasks(TASKS));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /ctrl-o overhaul/, "the panel lands on Home");
  assert.ok(!h.lastFramePlain().includes("head-a"), "not on the queue");
  h.stop();
});

test("Home merges nothing: [m] there never reaches the ready head one tab away", async () => {
  const q = mergeableQueue(READY_VIEW, READY_DETAIL);
  const h = harness(undefined, 90, 24, q, undefined, fakeFeatures(FEATURES), fakeTasks(TASKS));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /ctrl-o overhaul/, "on Home");
  h.send("m");
  await settle();
  assert.equal(q.calls, 0, "no merge fired from Home");
  // Nor does any other action key: the tab has none at all.
  h.send("e");
  h.send("r");
  await settle();
  assert.equal(q.calls, 0);
  assert.match(h.lastFramePlain(), /ctrl-o overhaul/, "and Home is still just showing");
  h.stop();
});

test("an empty task table says so rather than showing a blank block", async () => {
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures(FEATURES), fakeTasks([]));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /Nothing on the table/);
  assert.match(h.lastFramePlain(), /co\/feat-checkout/, "the worktrees are still listed under it");
  h.stop();
});

test("with no feature source, Home is still the task table and says why the list is empty", async () => {
  // An unlinked instance: no repo, no worktrees, but the table is the co's own.
  const h = harness(undefined, 80, 20, undefined, undefined, undefined, fakeTasks(TASKS));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const frame = h.lastFramePlain();
  assert.match(frame, /building\s+ctrl-o overhaul/, "the table is there");
  assert.match(frame, /aren't available in this session \(not linked\)/, "and the gap is explained");
  h.stop();
});

test("the task table reads its source fresh: a table rewritten mid-session shows up", async () => {
  const tasks = fakeTasks(TASKS);
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures(FEATURES), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /ctrl-o overhaul/);
  // What the task_table tool does, from the panel's point of view: the whole
  // table is replaced, and the next paint shows it. No restart, no subscription.
  tasks.set([{ task: "landing the panel", status: "building" }]);
  h.tui.appendBlock("something happened");
  await frame();
  const painted = h.lastFramePlain();
  assert.match(painted, /building\s+landing the panel/, "the new table is painted");
  assert.ok(!painted.includes("ctrl-o overhaul"), "and the old rows are gone");
  h.stop();
});

test("the task table is a spaced status-first list, with no Type column", async () => {
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures([]), fakeTasks(TASKS));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const rows = screenRows(h);
  const heading = rows.findIndex((r) => r.trim() === "Tasks");
  assert.ok(heading > 0, "the block is headed");
  assert.equal(rows[heading + 1], "", "with a blank line under the heading");

  // Status first, in a column the eye can run down: every task name starts at
  // the same column, whichever status word is in front of it.
  const listed = TASKS.map((t) => rows.find((r) => r.includes(t.task)) ?? "");
  for (const [i, row] of listed.entries()) {
    assert.ok(row !== "", `row ${i} is painted`);
    assert.match(row, /^ {2}(building|queued) /, "indented, status leading");
    assert.equal(row.indexOf(TASKS[i]!.task), 13, "and the names line up in one column");
    // The dropped column is really gone, not just unlabelled: the name is the
    // end of the row.
    assert.ok(row.endsWith(TASKS[i]!.task), `nothing follows the name: ${JSON.stringify(row)}`);
  }
  assert.ok(!rows.some((r) => /\bType\b/.test(r)), "and no header names it either");
  h.stop();
});

test("a feature with no intent renders a placeholder, never a blank tail", async () => {
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures([
    { feature: "nameless", branch: "co/feat-nameless", status: "idle", busy: false },
  ]), fakeTasks([]));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const frame = h.lastFramePlain();
  assert.match(frame, /nameless\s+\[idle\]\s+co\/feat-nameless/);
  assert.match(frame, /no description/);
  h.stop();
});

// --- nothing on Home runs off the right edge ---------------------------------
//
// The captain's complaint: the description beside a worktree is the only thing on
// the row that says what the work is FOR, and it ran off the edge. It was cut
// with an ellipsis, which is the same information loss with tidier punctuation.
// So it wraps now, and these pin the property that matters — the WHOLE text is on
// screen, at any width, across a resize.

const LONG_INTENT =
  "rebase the blocked head onto the current origin/dev tip, re-push it with a lease, " +
  "and read the pull request's real checks back before the queue offers a merge again";

/** The painted panel body as one whitespace-normalized string, so a test can ask
 *  whether a description survived the wrap instead of where each piece landed. */
function painted(h: Harness): string {
  return screenRows(h).join(" ").replace(/\s+/g, " ").trim();
}

test("a description too long for its row wraps, and every word of it is on screen", async () => {
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures([
    { feature: "resolver", branch: "co/feat-resolver", intent: LONG_INTENT, status: "blocked", busy: false },
  ]), fakeTasks([]));
  h.tui.question();
  h.send(CTRL_O);
  await settle();

  const rows = screenRows(h);
  assert.ok(painted(h).includes(LONG_INTENT), "the whole description is readable");
  assert.ok(!painted(h).includes("…"), "nothing was cut to get it there");
  // It is more than one row, and the continuations read as part of the row above
  // rather than as new entries in the list.
  const started = rows.findIndex((r) => r.includes("rebase the blocked head"));
  assert.ok(started > 0);
  assert.match(rows[started + 1]!, /^ {6}\S/, "the tail hangs under the row it belongs to");
  h.stop();
});

test("a resize re-wraps the descriptions, with nothing stale and nothing clipped", async () => {
  const h = harness(undefined, 120, 24, undefined, undefined, fakeFeatures([
    { feature: "resolver", branch: "co/feat-resolver", intent: LONG_INTENT, status: "idle", busy: false },
  ]), fakeTasks(TASKS));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const wide = screenRows(h).filter((r) => r !== "").length;
  assert.ok(painted(h).includes(LONG_INTENT), "readable at 120 columns");

  // Narrow the terminal under the open panel: the rows are rebuilt at the new
  // width, so the same text takes more of them and still says all of it.
  h.resize(60, 24);
  await settle();
  assert.ok(painted(h).includes(LONG_INTENT), "and still readable at 60");
  assert.ok(!painted(h).includes("…"), "no row was cut to fit the narrower screen");
  assert.ok(
    screenRows(h).filter((r) => r !== "").length > wide,
    "the same content really did re-wrap into more rows",
  );
  for (const row of screenRows(h)) {
    assert.ok(visibleWidth(row) <= h.cols(), `inside the new width: ${JSON.stringify(row)}`);
  }
  h.stop();
});

test("a long branch name is wrapped with the row, never ellipsized out of it", async () => {
  const branch = "co/feat-ctrl-o-home-tab-readability-pass";
  const h = harness(undefined, 64, 20, undefined, undefined, fakeFeatures([
    { feature: "home-cleanup", branch, intent: "make the panel readable", status: "idle", busy: false },
  ]), fakeTasks([]));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.ok(painted(h).includes(branch), "the whole branch is there");
  assert.ok(painted(h).includes("make the panel readable"), "and so is the description");
  h.stop();
});

test("an empty worktree list says so rather than showing a blank block", async () => {
  const h = harness(undefined, 72, 12, undefined, undefined, fakeFeatures([]), fakeTasks([]));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /No feature worktrees yet/);
  h.send("a"); // a stray key on an empty tab is a no-op, not a crash
  await settle();
  h.send(ESC);
  h.stop();
});

test("the state word tracks reality: dirty, clean, crew, queue position, block", async () => {
  const h = harness(undefined, 90, 24, undefined, undefined, fakeFeatures([
    {
      feature: "wip-dirty",
      branch: "feat/wip-dirty",
      intent: "uncommitted work sitting in the tree",
      status: "idle",
      busy: false,
      dirty: true,
    },
    {
      feature: "wip-clean",
      branch: "feat/wip-clean",
      intent: "committed, not yet enqueued",
      status: "idle",
      busy: false,
      dirty: false,
    },
    {
      feature: "unknown",
      branch: "feat/unknown",
      intent: "nobody has looked at this tree yet",
      status: "idle",
      busy: false,
    },
    {
      feature: "blocked-one",
      branch: "feat/blocked-one",
      intent: "the one that conflicts",
      status: "blocked",
      busy: false,
      position: 1,
      blockedKind: "conflict",
    },
    {
      feature: "red-build",
      branch: "feat/red-build",
      intent: "green alone, red combined",
      status: "blocked",
      busy: false,
      position: 3,
      blockedKind: "failed",
    },
    {
      feature: "resolving-one",
      branch: "feat/resolving-one",
      intent: "being fixed by a fresh agent",
      status: "resolving",
      busy: true,
      position: 2,
    },
  ]), fakeTasks([]));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const frame = h.lastFramePlain();
  assert.match(frame, /wip-dirty\s+\[dirty\]/, "uncommitted work is not just 'idle'");
  assert.match(frame, /wip-clean\s+\[clean\]/);
  // Unread is UNKNOWN, never clean: "nothing to commit" is a claim, and nobody
  // checked.
  assert.match(frame, /unknown\s+\[idle\]/);
  assert.match(frame, /blocked-one\s+\[blocked: conflict\]/);
  assert.match(frame, /red-build\s+\[blocked: build\+test\]/);
  // A live agent is never hidden by the queue chip it sits behind.
  assert.match(frame, /resolving-one\s+\[resolving\]\s+\[crew\]/);
  h.stop();
});

test("opening Home asks the source to re-read the dirty flags, and repaints when it lands", async () => {
  const features = fakeFeatures(FEATURES);
  const h = harness(undefined, 80, 20, undefined, undefined, features, fakeTasks([]));
  h.tui.question();
  assert.equal(features.refreshes, 0, "nothing is read before the panel opens");
  h.send(CTRL_O);
  await settle();
  assert.equal(features.refreshes, 1, "opening Home asks once");
  // Paging does NOT re-ask: a git call per worktree per keystroke would be absurd.
  h.send("j");
  h.send("k");
  await settle();
  assert.equal(features.refreshes, 1, "and only on arrival");
  h.stop();
});

test("Home pages a long list; nothing is silently clipped", async () => {
  const many: FeaturePanelEntry[] = Array.from({ length: 30 }, (_, n) => ({
    feature: `feat-${String(n + 1).padStart(2, "0")}`,
    branch: `feat/feat-${String(n + 1).padStart(2, "0")}`,
    intent: `intent number ${n + 1}`,
    status: "idle" as const,
    busy: false,
  }));
  const h = harness(undefined, 80, 14, undefined, undefined, fakeFeatures(many), fakeTasks(TASKS));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /ctrl-o overhaul/, "starts at the top, on the table");
  assert.ok(!h.lastFramePlain().includes("feat-30"), "the tail is off screen, not dropped");
  h.send("G");
  await settle();
  assert.match(h.lastFramePlain(), /feat-30/, "G reaches the end");
  h.send("g");
  await settle();
  assert.match(h.lastFramePlain(), /ctrl-o overhaul/, "g returns to the top");
  h.stop();
});

// --- a table taller than the pane --------------------------------------------
//
// The row cap is gone from the store, so the table can now outgrow the panel.
// Home was already ONE scrolling body — viewport clamped to the row count, paged
// by space/b/d/u/g/G — and that is deliberately still the whole mechanism: a
// display ceiling would leave rows selectable but unpaintable, and `x` would then
// retire something the captain could not see. What the ceiling would have given
// is the count, so the heading takes that job when the block stops fitting.
//
// A frame assertion cannot judge how this LOOKS on a real terminal. What it can
// hold is that the panel paints exactly its viewport, that nothing is clipped or
// lost, that every row is reachable, and that the far end is still editable.

const MANY_TASKS: TaskPanelRow[] = Array.from({ length: 24 }, (_, n) => ({
  task: `task number ${String(n + 1).padStart(2, "0")}`,
  status: "queued" as const,
}));

test("a table taller than the pane paints its viewport and nothing else", async () => {
  const h = harness(undefined, 80, 14, undefined, undefined, fakeFeatures(FEATURES), fakeTasks(MANY_TASKS));
  h.tui.question();
  h.send(CTRL_O);
  await settle();

  // The panel is a fixed grid: one bar, a viewport, one footer. A body longer
  // than the viewport must change none of that.
  const rows = screenRows(h);
  assert.equal(rows.length, 14, "the frame is still exactly the screen");
  for (const r of rows) assert.ok(visibleWidth(r) <= 80, `row overflows the width: ${JSON.stringify(r)}`);

  assert.match(h.lastFramePlain(), /task number 01/, "it opens at the top of the table");
  assert.ok(!h.lastFramePlain().includes("task number 24"), "the tail is off screen, not dropped");
  assert.match(screenRows(h).at(-1) ?? "", /more below/, "and the footer says there is more");

  h.send("G");
  await settle();
  assert.match(h.lastFramePlain(), /task number 24/, "G reaches the last row");
  assert.match(h.lastFramePlain(), /co\/feat-checkout/, "and the worktrees are still under it");
  h.send("g");
  await settle();
  assert.match(h.lastFramePlain(), /task number 01/, "g returns to the top");
  h.stop();
});

test("the heading counts the rows once the block outgrows the pane, and not before", async () => {
  const short = harness(undefined, 80, 24, undefined, undefined, fakeFeatures([]), fakeTasks(TASKS));
  short.tui.question();
  short.send(CTRL_O);
  await settle();
  assert.match(short.lastFramePlain(), /\bTasks\b/, "a table you can see is just `Tasks`");
  assert.ok(!/Tasks \(\d+\)/.test(short.lastFramePlain()), "no count on a table that fits");
  short.stop();

  const tall = harness(undefined, 80, 14, undefined, undefined, fakeFeatures([]), fakeTasks(MANY_TASKS));
  tall.tui.question();
  tall.send(CTRL_O);
  await settle();
  assert.match(tall.lastFramePlain(), /Tasks \(24\)/, "the count is the overflow indicator");
  tall.stop();
});

test("every row of a long table is selectable, painted when selected, and editable", async () => {
  const tasks = fakeTasks(MANY_TASKS);
  const h = harness(undefined, 80, 14, undefined, undefined, fakeFeatures([]), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();

  // Walk the cursor to the last row. The paint has to follow it: a selection on
  // a row that is never painted is the failure a display ceiling would have
  // introduced, and it is `x` that would act on it.
  for (let n = 0; n < 24; n++) h.send("j");
  await settle();
  assert.match(selectedRow(h), /task number 24/, "the cursor is on the last row");
  assert.match(h.lastFramePlain(), /task number 24/, "and that row is on screen");

  h.send("x");
  await settle();
  assert.deepEqual(tasks.writes, ["retire:task number 24"], "the far end of the table is editable");
  assert.equal(tasks.list().length, 23);
  h.stop();
});

test("`a` puts a sixth row on a five-row table: the panel has no cap of its own", async () => {
  const five: TaskPanelRow[] = Array.from({ length: 5 }, (_, n) => ({
    task: `task ${n + 1}`,
    status: "queued" as const,
  }));
  const tasks = fakeTasks(five);
  const h = harness(undefined, 80, 24, undefined, undefined, fakeFeatures([]), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a");
  h.send("a sixth thing");
  h.send("\r");
  await settle();
  assert.deepEqual(tasks.writes, ["add:a sixth thing"], "the write was asked for, not refused ahead of time");
  assert.equal(tasks.list().length, 6, "and it landed");
  assert.match(h.lastFramePlain(), /a sixth thing/, "painted as an ordinary row");
  assert.ok(!h.lastFramePlain().includes("maximum"), "with nothing said about a limit");
  h.stop();
});

test("Home reads its feature source fresh: a feature created while the panel is open shows up", async () => {
  const src = fakeFeatures([FEATURES[2]!]);
  const h = harness(undefined, 80, 20, undefined, undefined, src, fakeTasks([]));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.ok(!h.lastFramePlain().includes("checkout"), "only the one feature to start");
  src.set([FEATURES[0]!, FEATURES[2]!]);
  h.tui.appendBlock("something happened");
  await frame();
  assert.match(h.lastFramePlain(), /checkout\s+\[ready to merge\]/, "the new feature is listed");
  h.stop();
});

test("with only a task source wired, Ctrl-O opens Home and keystrokes never reach the prompt", async () => {
  const h = harness(undefined, 80, 20, undefined, undefined, undefined, fakeTasks(TASKS));
  const answer = h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /ctrl-o overhaul/, "Home is the only tab");
  h.send("hello");
  await settle();
  h.send(ESC);
  h.send("real\r");
  assert.equal(await answer, "real", "nothing typed on the tab leaked into the buffer");
  h.stop();
});

test("Ctrl-O closes the panel from Home", async () => {
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures(FEATURES), fakeTasks(TASKS));
  const answer = h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /co\/feat-checkout/);
  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /you > /, "closed with the key that opened it");
  h.send("typed\r");
  assert.equal(await answer, "typed");
  h.stop();
});

// --- editing the task table from Home ----------------------------------------
//
// The table has two writers now (D-20260729-3): the co, through its tool, and
// the captain, right here. What these pin is the rule that lets that live on the
// tab the panel OPENS on — no single stray keystroke may change anything. `a`
// opens a field and writes only what is submitted; `x` and `s` do nothing at all
// until a row has been deliberately selected. Nothing is selected on open.
//
// The colours and the on-screen look are the captain's to judge; what a test can
// hold is which row is marked, which write was asked for, and which keys did
// nothing.

const ARROW_UP = "\x1b[A";
const ARROW_DOWN = "\x1b[B";

/** The painted task rows, in order: the marked one carries the ▸. The heading
 *  carries a row count when the block outgrows the pane, so it is matched by
 *  prefix rather than by equality. */
function taskRows(h: Harness): string[] {
  const rows = screenRows(h);
  const head = rows.findIndex((r) => /^Tasks( \(\d+\))?$/.test(r.trim()));
  const out: string[] = [];
  for (let i = head + 1; i < rows.length; i++) {
    if (rows[i]!.trim() === "Worktrees") break;
    if (/\b(building|queued|new)\b/.test(rows[i]!)) out.push(rows[i]!);
  }
  return out;
}

/** The row currently marked with ▸, or "" when nothing is selected. */
function selectedRow(h: Harness): string {
  return taskRows(h).find((r) => r.trimStart().startsWith("▸")) ?? "";
}

test("Home opens with nothing selected, and x/s do nothing until something is", async () => {
  const tasks = fakeTasks(TASKS);
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures(FEATURES), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.equal(selectedRow(h), "", "the tab lands inert: no row is marked");

  // The two mutating keys, pressed with nothing selected. This is the property
  // that lets Home stay the landing tab: they must not act on "the first row",
  // "the last row", or anything else.
  h.send("x");
  h.send("s");
  await settle();
  assert.deepEqual(tasks.writes, [], "no write was even attempted");
  assert.deepEqual(tasks.list(), TASKS, "and the table is untouched");
  assert.equal(selectedRow(h), "", "still nothing selected");
  h.stop();
});

test("arrows and j/k move the selection; Esc clears it and leaves the tab inert", async () => {
  const tasks = fakeTasks(TASKS);
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures(FEATURES), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();

  h.send(ARROW_DOWN);
  await settle();
  assert.match(selectedRow(h), /ctrl-o overhaul/, "down from nothing takes the first row");
  h.send("j");
  await settle();
  assert.match(selectedRow(h), /bedrock retry backoff/, "j moves down");
  h.send(ARROW_UP);
  await settle();
  assert.match(selectedRow(h), /ctrl-o overhaul/, "and up moves back");
  h.send("k");
  await settle();
  assert.match(selectedRow(h), /ctrl-o overhaul/, "clamped at the top rather than wrapping");

  // Only one row is ever marked.
  assert.equal(taskRows(h).filter((r) => r.trimStart().startsWith("▸")).length, 1);

  h.send(ESC);
  await settle();
  assert.equal(selectedRow(h), "", "Esc drops the selection");
  assert.match(h.lastFramePlain(), /ctrl-o overhaul/, "and the panel is still open");
  h.send(ESC);
  await settle();
  assert.match(h.lastFramePlain(), /you > /, "a second Esc, with nothing selected, closes it");
  h.stop();
});

test("`x` retires the highlighted row and drops the selection with it", async () => {
  const tasks = fakeTasks(TASKS);
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures(FEATURES), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("j");
  h.send("j");
  await settle();
  assert.match(selectedRow(h), /bedrock retry backoff/);

  h.send("x");
  await settle();
  assert.deepEqual(tasks.writes, ["retire:bedrock retry backoff"], "the named row, and only it");
  assert.deepEqual(tasks.list().map((t) => t.task), ["ctrl-o overhaul", "pricing table refresh"]);
  // The selection goes with it, so a second press cannot fall onto a neighbour.
  assert.equal(selectedRow(h), "");
  h.send("x");
  await settle();
  assert.equal(tasks.writes.length, 1, "and the second press wrote nothing");
  h.stop();
});

test("`s` toggles the highlighted row between building and queued", async () => {
  const tasks = fakeTasks(TASKS);
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures(FEATURES), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("j"); // ctrl-o overhaul, which is building
  await settle();

  h.send("s");
  await settle();
  assert.deepEqual(tasks.writes, ["status:ctrl-o overhaul:queued"]);
  assert.equal(tasks.list()[0]!.status, "queued");
  assert.match(selectedRow(h), /queued\s+ctrl-o overhaul/, "the row is repainted, still selected");

  h.send("s");
  await settle();
  assert.equal(tasks.list()[0]!.status, "building", "and it toggles back");
  h.stop();
});

test("`a` adds only what is submitted: Enter stores it, Esc stores nothing", async () => {
  const tasks = fakeTasks([]);
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures([]), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();

  // Opened, typed into, then abandoned: nothing reaches the store.
  h.send("a");
  h.send("a task I thought better of");
  await settle();
  assert.match(h.lastFramePlain(), /a task I thought better of/, "the field shows what is typed");
  h.send(ESC);
  await settle();
  assert.deepEqual(tasks.writes, [], "Esc wrote nothing");
  assert.deepEqual(tasks.list(), []);
  assert.match(h.lastFramePlain(), /Nothing on the table/, "the field is gone");

  // And the same field, submitted.
  h.send("a");
  h.send("wire the panel");
  h.send("\r");
  await settle();
  assert.deepEqual(tasks.writes, ["add:wire the panel"]);
  assert.deepEqual(tasks.list(), [{ task: "wire the panel", status: "queued" }], "always queued");
  assert.match(h.lastFramePlain(), /queued\s+wire the panel/, "and it is painted as a row");
  assert.equal(selectedRow(h), "", "a fresh row is not selected: the tab stays inert");
  h.stop();
});

test("the add field owns the keyboard: digits are text, not a jump to tab 2", async () => {
  const tasks = fakeTasks([]);
  const q = mergeableQueue(READY_VIEW, READY_DETAIL);
  const h = harness(undefined, 90, 20, q, undefined, fakeFeatures([]), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a");
  // Every one of these means something on the tab underneath: 2 jumps to the
  // queue, x retires, q closes, m would merge one tab over.
  h.send("2 fix the xmq parser");
  h.send("\r");
  await settle();
  assert.deepEqual(tasks.writes, ["add:2 fix the xmq parser"]);
  assert.equal(q.calls, 0, "and nothing merged on the way through");
  assert.match(h.lastFramePlain(), /2 fix the xmq parser/, "still on Home, with the row");
  h.stop();
});

test("a refused add keeps the field open with the text, and says why", async () => {
  const tasks = fakeTasks([]);
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures([]), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  tasks.refuse = 'The table already holds "one too many".';
  h.send("a");
  h.send("one too many");
  h.send("\r");
  await settle();
  const frame = h.lastFramePlain();
  assert.match(frame, /The table already holds/, "the refusal is printed");
  assert.match(frame, /one too many/, "with the typed text still there to edit");
  assert.deepEqual(tasks.list(), [], "and nothing was stored");
  h.stop();
});

test("a selection whose row the co retired mid-session simply stops being one", async () => {
  const tasks = fakeTasks(TASKS);
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures([]), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("j");
  h.send("j");
  await settle();
  assert.match(selectedRow(h), /bedrock retry backoff/);

  // The other writer moves the table under the captain's cursor.
  tasks.set([TASKS[0]!, TASKS[2]!]);
  h.tui.appendBlock("the co did something");
  await frame();
  assert.equal(selectedRow(h), "", "the selection is gone, not slid onto the next row");
  h.send("x");
  await settle();
  assert.deepEqual(tasks.writes, [], "so x is a no-op rather than retiring a row nobody chose");
  h.stop();
});

// --- `e`: rewriting a row's text in place ------------------------------------
//
// The row's text used to be immutable, so a typo cost the row its status and its
// place (retire, re-add, and it comes back queued at the bottom). `e` opens the
// same one-line field `a` uses, prefilled, and what it writes replaces the row's
// words and nothing else.
//
// The half a frame assertion cannot see is the SELECTION: a rename that moved
// the store and not the highlight leaves the captain marked on text that no
// longer exists, which reads as no selection at all and silently disarms the
// next key he presses. So every test here checks where the ▸ ended up.

const CTRL_S = "\x13";

test("`e` opens the field prefilled with the selected row, and Ctrl-S commits it", async () => {
  const tasks = fakeTasks(TASKS);
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures(FEATURES), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("j"); // ctrl-o overhaul
  await settle();

  h.send("e");
  await settle();
  assert.match(h.lastFramePlain(), /ctrl-o overhaul/, "the field opens on the row's own text");

  // The caret opens at the END of the prefilled text, so a fix appends rather
  // than pushing the row's words along in front of it.
  h.send(" v2");
  await settle();
  assert.match(h.lastFramePlain(), /ctrl-o overhaul v2/);
  assert.deepEqual(tasks.writes, [], "nothing is written while the field is open");

  h.send(CTRL_S);
  await settle();
  assert.deepEqual(tasks.writes, ["rename:ctrl-o overhaul:ctrl-o overhaul v2"]);
  assert.deepEqual(tasks.list(), [
    // Same status, same place: the two things retire-and-re-add would have lost.
    { task: "ctrl-o overhaul v2", status: "building" },
    { task: "bedrock retry backoff", status: "queued" },
    { task: "pricing table refresh", status: "queued" },
  ]);
  assert.match(selectedRow(h), /ctrl-o overhaul v2/, "and the selection came with it");
  h.stop();
});

test("Enter commits the rename too, since the field is one line", async () => {
  const tasks = fakeTasks(TASKS);
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures([]), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("j");
  h.send("e");
  h.send(" reworded");
  h.send("\r");
  await settle();
  assert.deepEqual(tasks.writes, ["rename:ctrl-o overhaul:ctrl-o overhaul reworded"]);
  assert.match(selectedRow(h), /ctrl-o overhaul reworded/);
  h.stop();
});

test("Esc leaves the row exactly as it was, selection included", async () => {
  const tasks = fakeTasks(TASKS);
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures([]), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("j");
  h.send("e");
  h.send(" and something I thought better of");
  await settle();
  assert.match(h.lastFramePlain(), /thought better of/, "the field shows what is typed");

  h.send(ESC);
  await settle();
  assert.deepEqual(tasks.writes, [], "Esc wrote nothing");
  assert.deepEqual(tasks.list(), TASKS, "the row is untouched");
  assert.ok(!h.lastFramePlain().includes("thought better of"), "the field is gone");
  assert.match(selectedRow(h), /ctrl-o overhaul/, "and the row is still the selected one");
  h.stop();
});

test("`e` with nothing selected does nothing at all, exactly like `x`", async () => {
  const tasks = fakeTasks(TASKS);
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures(FEATURES), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.equal(selectedRow(h), "", "the tab lands inert");

  h.send("e");
  await settle();
  // No field, no write, and no keyboard grabbed: the next keys are the tab's
  // own, which is what "does nothing" has to mean for a key that can open an
  // editor. `2` still jumps a tab, so nothing swallowed it.
  assert.deepEqual(tasks.writes, []);
  assert.deepEqual(tasks.list(), TASKS);
  assert.equal(selectedRow(h), "");
  h.send("j");
  await settle();
  assert.match(selectedRow(h), /ctrl-o overhaul/, "and the tab's own keys still work");
  h.stop();
});

test("an unchanged rename is not written at all, and keeps the selection", async () => {
  const tasks = fakeTasks(TASKS);
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures([]), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("j");
  h.send("e");
  h.send(CTRL_S);
  await settle();
  assert.deepEqual(tasks.writes, [], "opening the field and changing nothing costs no write");
  assert.deepEqual(tasks.list(), TASKS);
  assert.match(selectedRow(h), /ctrl-o overhaul/);
  h.stop();
});

test("emptying the field cancels rather than erasing the row's text", async () => {
  const tasks = fakeTasks(TASKS);
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures([]), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("j");
  h.send("e");
  h.send("\x15"); // Ctrl-U: kill the line
  h.send(CTRL_S);
  await settle();
  assert.deepEqual(tasks.writes, [], "a blank row is not a row, so nothing is written");
  assert.deepEqual(tasks.list(), TASKS);
  h.stop();
});

test("a refused rename keeps the field open with the text, and leaves the selection put", async () => {
  const tasks = fakeTasks(TASKS);
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures([]), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("j");
  tasks.refuse = 'Another row already reads "bedrock retry backoff".';
  h.send("e");
  h.send("\x15bedrock retry backoff");
  h.send(CTRL_S);
  await settle();
  const frame = h.lastFramePlain();
  assert.match(frame, /Another row already reads/, "the refusal is printed");
  assert.match(frame, /bedrock retry backoff/, "with the typed text still there to edit");
  assert.deepEqual(tasks.list(), TASKS, "and nothing was stored");
  h.send(ESC);
  await settle();
  assert.match(selectedRow(h), /ctrl-o overhaul/, "the row it refused to rename is still selected");
  h.stop();
});

test("the rename field owns the keyboard: `x` is text, not a retire", async () => {
  const tasks = fakeTasks(TASKS);
  const q = mergeableQueue(READY_VIEW, READY_DETAIL);
  const h = harness(undefined, 90, 20, q, undefined, fakeFeatures([]), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("j");
  h.send("e");
  // Every one of these acts on the tab underneath: 2 jumps to the queue, x
  // retires, q closes, m would merge one tab over.
  h.send("\x15" + "2 fix the xmq parser");
  h.send(CTRL_S);
  await settle();
  assert.deepEqual(tasks.writes, ["rename:ctrl-o overhaul:2 fix the xmq parser"]);
  assert.equal(q.calls, 0, "and nothing merged on the way through");
  assert.match(selectedRow(h), /2 fix the xmq parser/, "still on Home, on the renamed row");
  h.stop();
});

test("a source with no write hooks paints the table and says the keys aren't available", async () => {
  const tasks = fakeTasks(TASKS, { readOnly: true });
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures([]), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("a");
  await settle();
  assert.match(h.lastFramePlain(), /adding a task isn't available/);
  h.send("j");
  h.send("x");
  await settle();
  assert.match(h.lastFramePlain(), /retiring a task isn't available/);
  h.send("e");
  await settle();
  assert.match(h.lastFramePlain(), /renaming a task isn't available/);
  assert.deepEqual(tasks.list(), TASKS);
  h.stop();
});

// --- building rows paint first -----------------------------------------------
//
// A display order only (D-20260729-5): the store keeps insertion order, and the
// same shared helper the tool and the live-state block call decides what the
// captain sees. What matters on this tab is that the CURSOR walks the painted
// order too — a highlight that moved through the stored sequence while the eye
// read another would be unusable the first time `s` moved a row.

const UNSORTED: TaskPanelRow[] = [
  { task: "waiting first", status: "queued" },
  { task: "waiting second", status: "queued" },
  { task: "being worked", status: "building" },
];

test("the tab paints building rows above queued ones, whatever order they were stored in", async () => {
  const tasks = fakeTasks(UNSORTED);
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures([]), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.deepEqual(
    taskRows(h).map((r) => r.trim().replace(/^▸\s*/, "")),
    ["building   being worked", "queued     waiting first", "queued     waiting second"],
    "building first, and the stored order kept under it",
  );
  assert.deepEqual(
    tasks.list().map((t) => t.task),
    ["waiting first", "waiting second", "being worked"],
    "the STORE is untouched: this is a view of it",
  );
  h.stop();
});

test("j/k walk the painted order, not the stored one", async () => {
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures([]), fakeTasks(UNSORTED));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("j");
  await settle();
  assert.match(selectedRow(h), /being worked/, "down from nothing takes the row painted first");
  h.send("j");
  await settle();
  assert.match(selectedRow(h), /waiting first/, "then the one under it on screen");
  h.stop();
});

test("`s` re-sorts the row on the next paint, and the highlight follows it", async () => {
  const tasks = fakeTasks(UNSORTED);
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures([]), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("j");
  h.send("j"); // "waiting first", painted second
  await settle();
  assert.match(selectedRow(h), /waiting first/);

  h.send("s");
  await settle();
  assert.deepEqual(tasks.writes, ["status:waiting first:building"]);
  assert.deepEqual(
    taskRows(h).map((r) => r.trim().replace(/^▸\s*/, "")),
    // Above "being worked", not below it: inside the building group the STORED
    // order still decides, and "waiting first" was stored first. A toggle moves
    // a row between groups; it never appends it to the end of one.
    ["building   waiting first", "building   being worked", "queued     waiting second"],
    "it moved up into the building group, keeping its stored order inside it",
  );
  // The selection is held as TEXT, which is what lets it ride the move.
  assert.match(selectedRow(h), /waiting first/, "and the highlight went with the row");
  assert.deepEqual(
    tasks.list().map((t) => t.task),
    ["waiting first", "waiting second", "being worked"],
    "with the stored order still untouched",
  );
  h.stop();
});

test("retiring a row disturbs the order of nothing else", async () => {
  const tasks = fakeTasks(UNSORTED);
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures([]), tasks);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("j"); // "being worked", painted first
  h.send("x");
  await settle();
  assert.deepEqual(
    taskRows(h).map((r) => r.trim()),
    ["queued     waiting first", "queued     waiting second"],
    "the rest are where they were",
  );
  h.stop();
});

test("the rename field paints in the row's own place, under the row's own status", async () => {
  const h = harness(undefined, 80, 20, undefined, undefined, fakeFeatures([]), fakeTasks(UNSORTED));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("j"); // "being worked", the building row, painted first
  h.send("e");
  await settle();
  const rows = taskRows(h).map((r) => r.trim());
  // Rewriting a task's wording must not look like moving it, so the field sits
  // where the row does and keeps its status word — `new` would be a lie.
  assert.equal(rows.length, 3, "still three rows: the field IS the row");
  assert.match(rows[0]!, /^building\s+being worked/);
  assert.match(rows[1]!, /^queued\s+waiting first/);
  h.stop();
});

test("Home's footer names the keys, because nothing else can", async () => {
  const h = harness(undefined, 90, 20, undefined, undefined, fakeFeatures([]), fakeTasks(TASKS));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const footer = screenRows(h).at(-1) ?? "";
  assert.match(footer, /a add/);
  assert.match(footer, /e edit/);
  assert.match(footer, /x retire/);
  assert.match(footer, /s status/);
  assert.match(footer, /space\/b page/, "and paging is still what it always was");

  // While the field is open the footer names its two keys instead — and names
  // the right verb, because the two openings commit different things.
  h.send("a");
  await settle();
  const typing = screenRows(h).at(-1) ?? "";
  assert.match(typing, /Enter add the task/);
  assert.match(typing, /Esc cancel/);

  h.send(ESC);
  h.send("j");
  h.send("e");
  await settle();
  const renaming = screenRows(h).at(-1) ?? "";
  assert.match(renaming, /Enter rename the task/);
  assert.match(renaming, /Esc cancel/);
  h.stop();
});

// --- the tab bar and the number keys -----------------------------------------
//
// The panel's discovery surface. Before it, the tabs existed and nothing said
// so: Tab cycled them and you either knew that or you didn't. The bar names
// every tab on every view with the digit that jumps to it, which is also why no
// list row is labelled with a digit any more (see the label tests above).

/**
 * The last painted frame as screen rows, in order. The panel writes one
 * `moveTo(row, 1) + clearLine + text` chunk per row, so splitting on the move is
 * how a test reads the screen the way a captain does — which row is above which.
 */
function screenRows(h: Harness): string[] {
  return h
    .lastFrame()
    .split(/\x1b\[\d+;1H/)
    .slice(1)
    .map((r) => stripAnsi(r).replace(/\s+$/, ""));
}

/** The panel's top line — the tab bar — with ANSI stripped. */
function bar(h: Harness): string {
  return screenRows(h)[0] ?? "";
}

/** The tab bar's numbered labels, in bar order, with the active one's brackets
 *  dropped — `["1 home", "2 queue", ...]`. Ordering is asserted from this rather
 *  than from one big regex, because the active tab is bracketed and would break
 *  any sequence pattern the moment it moved. */
function tabsOf(h: Harness): string[] {
  return [...bar(h).matchAll(/\d [a-z]+/g)].map((m) => m[0]);
}

test("every tab is named in a bar at the top, on every tab, with the active one distinct", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n" });
  const q = mergeableQueue(READY_VIEW, READY_DETAIL);
  const h = harness(docs, 90, 24, q, fakeInbox(REVIEWS), fakeFeatures(FEATURES), fakeTasks(TASKS));
  h.tui.question();
  h.send(CTRL_O);
  await settle();

  // Every tab, numbered, in bar order, on the tab the panel opened on.
  assert.deepEqual(tabsOf(h), ["1 home", "2 queue", "3 docs", "4 inbox"]);
  assert.ok(bar(h).includes("[1 home]"), "and the active one is marked");

  // The bar is on EVERY tab, and the mark moves with the view.
  for (const [key, active] of [["2", "2 queue"], ["3", "3 docs"], ["4", "4 inbox"]] as const) {
    h.send(key);
    await settle();
    assert.deepEqual(
      tabsOf(h),
      ["1 home", "2 queue", "3 docs", "4 inbox"],
      `${active}: every tab still listed`,
    );
    assert.ok(bar(h).includes(`[${active}]`), `${active}: is marked active`);
  }
  h.stop();
});

test("the bar follows into a sub-view and names what is open", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n" });
  const h = harness(docs, 90, 24, undefined, fakeInbox(REVIEWS), undefined, fakeTasks(TASKS));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("2"); // docs
  await settle();
  h.send("a"); // open the doc
  await settle();
  assert.ok(bar(h).includes("[2 docs · plan.md]"), "the open doc rides in its own tab's segment");
  assert.match(bar(h), /1 home/, "and the other tabs are still listed");

  h.send("3"); // straight out of the doc to the inbox
  await settle();
  h.send("a");
  await settle();
  assert.ok(bar(h).includes("[3 inbox · L1 rework]"), "a filed review names itself the same way");
  h.stop();
});

test("1-9 jump straight to a tab, from any view, and a digit past the end does nothing", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n" });
  const q = mergeableQueue(READY_VIEW, READY_DETAIL);
  const h = harness(docs, 90, 24, q, fakeInbox(REVIEWS), fakeFeatures(FEATURES), fakeTasks(TASKS));
  h.tui.question();
  h.send(CTRL_O);
  await settle();

  h.send("4");
  await settle();
  assert.match(h.lastFramePlain(), /a\)\s*\[L1\]\s*rework/, "4 lands on the inbox");
  h.send("2");
  await settle();
  assert.match(h.lastFramePlain(), /head-a/, "2 lands on the queue");
  h.send("1");
  await settle();
  assert.match(h.lastFramePlain(), /ctrl-o overhaul/, "1 lands on home");

  // Out of a sub-view too — the whole point of a direct jump.
  h.send("3");
  await settle();
  h.send("a");
  await settle();
  assert.match(h.lastFramePlain(), /docs · plan\.md/, "in an open doc");
  h.send("1");
  await settle();
  assert.match(h.lastFramePlain(), /ctrl-o overhaul/, "1 jumped straight out of the doc");

  // A digit past the last tab is a no-op, not a crash and not a blank view.
  h.send("9");
  await settle();
  assert.match(h.lastFramePlain(), /ctrl-o overhaul/, "still on home");
  h.stop();
});

test("the numbers index the bar as it actually is, so a pending review is reachable by digit", async () => {
  const q = mergeableQueue(READY_VIEW, READY_DETAIL);
  const h = harness(undefined, 90, 24, q, undefined, undefined, fakeTasks(TASKS));
  h.tui.question();
  const review = fakeReview(GREEN);
  const p = h.tui.openLandingReview(review);
  h.send(CTRL_O);
  await settle();
  // A pending review still wins the landing spot — it holds a caller open.
  assert.match(h.lastFramePlain(), /review · gate-ui → dev/);
  assert.deepEqual(tabsOf(h), ["1 home", "2 queue", "3 review"], "and it takes the third slot");
  h.send("1");
  await settle();
  assert.match(h.lastFramePlain(), /ctrl-o overhaul/, "1 still means home");
  h.send("3");
  await settle();
  assert.match(h.lastFramePlain(), /review · gate-ui/, "3 comes back to the review");
  h.send("r");
  assert.equal(await p, "rejected");
  h.stop();
});

test("Tab and `i` still cycle in bar order, home first", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n" });
  const q = mergeableQueue(READY_VIEW, READY_DETAIL);
  const h = harness(docs, 90, 24, q, fakeInbox(REVIEWS), fakeFeatures(FEATURES), fakeTasks(TASKS));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /ctrl-o overhaul/, "opens on home");
  h.send("\t");
  await settle();
  assert.match(h.lastFramePlain(), /head-a/, "Tab reaches the queue");
  h.send("\t");
  await settle();
  assert.match(h.lastFramePlain(), /a\)\s*plan\.md/, "Tab reaches docs");
  h.send("\t");
  await settle();
  assert.match(h.lastFramePlain(), /a\)\s*\[L1\]\s*rework/, "Tab reaches the inbox");
  h.send("\t");
  await settle();
  assert.match(h.lastFramePlain(), /ctrl-o overhaul/, "and wraps back to home");

  // `i` is the same cycle, unchanged.
  h.send("i");
  await settle();
  assert.match(h.lastFramePlain(), /head-a/, "`i` cycles identically");
  // And the queue tab's [m] is untouched by any of it.
  h.send("m");
  await settle();
  assert.equal(q.calls, 1, "the queue tab's [m] still merges from the queue tab");
  q.resolveMerge({ merged: true, summary: "merged" });
  await frame();
  h.stop();
});

test("with one tab the bar still names it, and Tab is a no-op", async () => {
  const h = harness(undefined, 60, 16, undefined, undefined, undefined, fakeTasks(TASKS));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.ok(bar(h).includes("[1 home]"), "one tab, named and marked");
  h.send("\t");
  await settle();
  assert.ok(bar(h).includes("[1 home]"), "and nowhere to cycle to");
  h.stop();
});

test("on a narrow terminal the tabs survive; the sub-view detail is what gives way", async () => {
  const docs = fakeDocs({ "a-rather-long-document-name.md": "# Long\n" });
  const q = mergeableQueue(READY_VIEW, READY_DETAIL);
  const h = harness(docs, 34, 16, q, fakeInbox(REVIEWS), fakeFeatures(FEATURES), fakeTasks(TASKS));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("3");
  await settle();
  h.send("a");
  await settle();
  const line = bar(h);
  assert.match(line, /1 home/, "every tab is still named");
  assert.match(line, /4 inbox/, "including the last one");
  assert.ok(!line.includes("a-rather-long-document-name"), "the detail dropped instead of a tab");
  // And the doc itself is still open underneath.
  assert.match(h.lastFramePlain(), /Long/);
  h.stop();
});

test("on a terminal too narrow even for the labels, the numbers still stand", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n" });
  const q = mergeableQueue(READY_VIEW, READY_DETAIL);
  const h = harness(docs, 22, 12, q, fakeInbox(REVIEWS), fakeFeatures(FEATURES), fakeTasks(TASKS));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  // A tab is never dropped: a tab you cannot see is a tab you don't know exists.
  assert.deepEqual(tabsOf(h).length, 0, "the labels are gone at this width");
  assert.match(bar(h), /\[1\]\s*2\s+3\s+4/, "but all four tabs are still numbered");
  assert.ok(bar(h).includes("[1]"), "and the active one is still marked");
  // The numbers still work at that width, which is the point of keeping them.
  h.send("2");
  await settle();
  assert.ok(bar(h).includes("[2]"));
  assert.match(h.lastFramePlain(), /head-a/, "and the queue is what showed up");
  h.stop();
});
