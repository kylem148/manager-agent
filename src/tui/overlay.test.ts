import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Tui,
  renderMarkdownDoc,
  type DocSource,
  type InboxPanelEntry,
  type InStream,
  type LandingReview,
  type OutStream,
  type QueueHeadDetail,
  type QueueMergeResult,
  type QueuePanelSource,
  type QueuePanelView,
} from "./tui.js";
import { stripAnsi } from "./wrap.js";

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
  lastFrame(): string;
  lastFramePlain(): string;
  stop(): void;
}

function harness(
  docs?: DocSource,
  cols = 40,
  rows = 12,
  queue?: QueuePanelSource,
  inbox?: { list(): InboxPanelEntry[] },
): Harness {
  let listener: ((d: string) => void) | null = null;
  const writes: string[] = [];
  const out: OutStream = { write: (s) => writes.push(String(s)), columns: cols, rows };
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
  });
  tui.start();
  return {
    tui,
    send: (bytes) => listener?.(bytes),
    lastFrame: () => writes[writes.length - 1] ?? "",
    lastFramePlain: () => stripAnsi(writes[writes.length - 1] ?? ""),
    stop: () => tui.stop(),
  };
}

/** Let the overlay's async list/read settle (microtask flush). */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Let a coalesced repaint land (the ~60fps frame budget, plus slack). */
const frame = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

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
  assert.match(frame, /1\)\s*architecture\.md/);
  assert.match(frame, /2\)\s*plan\.md/);

  // Selecting "1" opens architecture.md, rendered through the markdown renderer.
  h.send("1");
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
  h.send("1"); // open plan.md
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
  h.send("2"); // plan.md (sorted: notes.md=1, plan.md=2)
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
  h.send("1");
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
  h.send("1");
  await settle();
  assert.match(h.lastFramePlain(), /docs · plan\.md/);
  h.send("\x7f"); // Backspace → back to the list
  await settle();
  assert.match(h.lastFramePlain(), /1\)\s*plan\.md/, "back at the list");
  h.send(ESC); // Esc from the list closes
  h.send("done\r");
  assert.equal(await answer, "done");
  h.stop();
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
  h.send("1");
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

test("a failed prepare shows the exit code and output, with [m] disabled", async () => {
  const h = harness(undefined, 60, 12);
  const review = fakeReview({ kind: "failed", exitCode: 3, output: "boom went the suite" });
  const p = openReview(h, review);
  const frame = h.lastFramePlain();
  assert.match(frame, /build\+test failed on the rebased state \(exit 3\)/);
  assert.match(frame, /boom went the suite/, "the suite's own output is shown");
  assert.match(frame, /m disabled \(build\+test red\)/);
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
    new Error("'co/feat-x' is not rebased onto the current 'dev' tip; run prepareLanding again"),
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
  assert.match(h.lastFramePlain(), /1\)\s*plan\.md/, "the doc list is up");
  // Registering a review does NOT grab the screen (non-modal): docs stay up.
  const review = fakeReview(GREEN);
  const p = h.tui.openLandingReview(review);
  await settle();
  assert.match(h.lastFramePlain(), /1\)\s*plan\.md/, "docs still showing; the review didn't take over");
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
function fakeQueue(initial: QueuePanelView): QueuePanelSource & { set(v: QueuePanelView): void } {
  let cur = initial;
  return { view: () => cur, set: (v) => (cur = v) };
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

/** The canonical ready head: one entry, green, with a real patch to show. */
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
  diff: [
    "diff --git a/one.txt b/one.txt",
    "index 0000000..1111111 100644",
    "--- a/one.txt",
    "+++ b/one.txt",
    "@@ -0,0 +1 @@",
    "+hello from the feature",
  ].join("\n"),
  buildTest: { command: "npm run typecheck && npm test", ms: 12_400 },
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
async function renderQueue(view: QueuePanelView): Promise<string> {
  const h = harness(undefined, 72, 20, fakeQueue(view));
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

test("the queue tab distinguishes a conflict block from a red build+test block", async () => {
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
        blockedReason: "build+test failed (exit 2)",
        resolveAttempts: 1,
      },
    ],
  });
  assert.match(redFrame, /red\s+\[blocked: build\+test\]/, "a red block is labelled build+test, distinct from conflict");
  assert.match(redFrame, /resolver attempts: 1/, "spent attempts are surfaced");
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

test("a ready head renders its diff and build+test inline, with a live [m]", async () => {
  const q = mergeableQueue(READY_VIEW, READY_DETAIL);
  const h = harness(undefined, 72, 30, q);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const frame = h.lastFramePlain();
  assert.match(frame, /head-a\s+\[ready\]/, "the head's list row");
  assert.match(frame, /press m to merge it onto dev/, "the affordance names what it does");
  assert.match(frame, /1 commit · 1 file changed/, "the summary counts the merge");
  assert.match(frame, /build\+test green · npm run typecheck && npm test · 12\.4s/, "the evidence is stated");
  assert.match(frame, /abc1234 job: the only slice/, "the commit list is inline");
  assert.match(frame, /\+hello from the feature/, "and so is the diff — no drill needed");
  assert.match(frame, /m\s*merge/, "the footer offers the key");
  assert.equal(q.calls, 0, "showing the head merges nothing");
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
    { kind: "ready", feature: "head-b", target: "dev", commits: ["def job: b"], diff: "+b\n" },
  );
  q.resolveMerge({ merged: true, summary: "merged head-a: abc1234 on dev" });
  await settle();

  const frame = h.lastFramePlain();
  assert.match(frame, /head-b\s+\[ready\]/, "the panel reflects the advanced queue");
  assert.ok(!frame.includes("head-a"), "the merged head is gone from the view");
  assert.match(frame, /press m to merge it onto dev/, "the NEXT head's [m] is live now");
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
    error: "'co/feat-head-a' has moved since prepare",
  });
  await settle();

  const frame = h.lastFramePlain();
  assert.match(frame, /merge failed: 'co\/feat-head-a' has moved since prepare/, "the refusal is visible, not a flash");
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

test("the queue tab pages its inline diff with space/b and jumps with g/G", async () => {
  const long = Array.from({ length: 60 }, (_, i) => `+queue diff line ${i}`).join("\n");
  const q = mergeableQueue(READY_VIEW, { ...READY_DETAIL, diff: `diff --git a/f b/f\n${long}` });
  const h = harness(undefined, 60, 12, q);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const first = h.lastFramePlain();
  assert.match(first, /head-a\s+\[ready\]/, "the list is at the top");

  h.send(" "); // page down into the diff
  const paged = h.lastFramePlain();
  assert.notEqual(paged, first, "space scrolled the tab");
  assert.match(paged, /queue diff line/, "paging reaches the inline diff");

  h.send("G");
  assert.match(h.lastFramePlain(), /queue diff line 59/, "G jumps to the end");
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
  assert.match(h.lastFramePlain(), /1\)\s*plan\.md/, "open");

  h.send(CTRL_O); // the same key closes it
  await settle();
  let frame = h.lastFramePlain();
  assert.ok(!frame.includes("1) plan.md"), "the panel is gone");
  assert.match(frame, /you > /, "the conversation is back");

  h.send(CTRL_O); // and opens it again
  await settle();
  assert.match(h.lastFramePlain(), /1\)\s*plan\.md/, "reopened");

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
    assert.match(h.lastFramePlain(), /1\)\s*plan\.md/, `${name}: open`);
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
  assert.match(h.lastFramePlain(), /1\)\s*plan\.md/, "`i` reached the docs tab");

  h.send("i"); // docs -> queue (cycles, doesn't dead-end)
  await settle();
  assert.match(h.lastFramePlain(), /merge queue is empty/, "`i` cycled back");

  // Tab from the same state lands in the same place: one binding, two spellings.
  h.send("\t");
  await settle();
  assert.match(h.lastFramePlain(), /1\)\s*plan\.md/, "Tab does what `i` did");
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
  assert.match(h.lastFramePlain(), /1\)\s*plan\.md/, "the CSI-u `i` switched tabs");
  h.stop();
});

test("`i` in an open doc pops back to the docs tab, mirroring Tab", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n" });
  const h = harness(docs);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  h.send("1");
  await settle();
  assert.match(h.lastFramePlain(), /docs · plan\.md/, "in the doc");
  h.send("i");
  await settle();
  assert.match(h.lastFramePlain(), /1\)\s*plan\.md/, "`i` popped back to the list");
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

test("no doc is ever labelled `i`, so the tab key can't shadow a selector", async () => {
  const many: Record<string, string> = {};
  for (let n = 1; n <= 18; n++) many[`doc-${String(n).padStart(2, "0")}.md`] = `# ${n}\n`;
  const docs = fakeDocs(many);
  const h = harness(docs, 40, 30);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  const frame = h.lastFramePlain();
  assert.match(frame, /9\)\s*doc-09\.md/, "digits label the first nine");
  assert.match(frame, /h\)\s*doc-17\.md/, "letters carry on to h");
  assert.match(frame, /j\)\s*doc-18\.md/, "and skip straight to j");
  assert.ok(!/\bi\)/.test(frame), "no `i)` label exists to be shadowed");
  // Pressing it with only one tab wired switches nothing and opens nothing.
  h.send("i");
  await settle();
  assert.ok(!h.lastFramePlain().includes("docs · doc-"), "`i` opened no doc");
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
  assert.match(frame, /1\)\s*\[L1\]\s*rework\s+auth middleware never ran/, "newest is first, label 1");
  assert.match(frame, /2\)\s*\[L2\]\s*fix-commit\s+shipped, migration untested/);
  assert.match(frame, /3\)\s*\[L3\]\s*accept\s+rename landed clean/);
  // A list row is a summary: the body stays out of it until you open one.
  assert.ok(!frame.includes("middleware is registered"), "bodies aren't in the list");
  h.stop();
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
  h.send("1");
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
  assert.match(h.lastFramePlain(), /2\)\s*\[L2\]/, "back on the inbox list");
  h.send(ESC);
  h.stop();
});

test("an empty inbox says so rather than showing a blank tab", async () => {
  const h = harness(undefined, 60, 12, undefined, fakeInbox([]));
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /No reviews filed yet/);
  h.send("1"); // a stray selector on an empty list is a no-op, not a crash
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
  assert.match(h.lastFramePlain(), /1\)\s*\[L3\]/);
  // The co files a new one mid-session; the next paint picks it up. Transcript
  // output coalesces its frame (~60fps), so wait for it rather than the tick.
  src.set([REVIEWS[0]!, REVIEWS[2]!]);
  h.tui.appendBlock("something happened");
  await frame();
  assert.match(h.lastFramePlain(), /1\)\s*\[L1\]\s*rework/, "the new review is now first");
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
  assert.match(h.lastFramePlain(), /1\)\s*plan\.md/, "Tab reaches docs");
  h.send("\t");
  await settle();
  assert.match(h.lastFramePlain(), /1\)\s*\[L1\]\s*rework/, "Tab reaches the inbox");
  h.send("\t");
  await settle();
  assert.match(h.lastFramePlain(), /headfeat/, "and wraps back to the queue");

  // Sub-view → its own tab: open a review, Tab pops back to the inbox list.
  h.send("\t");
  h.send("\t");
  await settle();
  h.send("2");
  await settle();
  assert.match(h.lastFramePlain(), /inbox · L2 fix-commit/);
  h.send("\t");
  assert.match(h.lastFramePlain(), /3\)\s*\[L3\]/, "Tab from an open review returns to the list");
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
  assert.match(h.lastFramePlain(), /1\)\s*plan\.md/, "`i` reached docs");

  h.send("i"); // docs -> inbox, the tab that didn't exist when `i` was bound
  await settle();
  assert.match(h.lastFramePlain(), /1\)\s*\[L1\]\s*rework/, "`i` reached the inbox");

  h.send("i"); // inbox -> queue, all three cycled
  await settle();
  assert.match(h.lastFramePlain(), /merge queue is empty/, "`i` wrapped back round");

  // From a filed review's body `i` pops back to the list, exactly as it does
  // from an open doc — the sub-view returns to its own tab, not the next one.
  h.send("i");
  h.send("i");
  await settle();
  h.send("2");
  await settle();
  assert.match(h.lastFramePlain(), /inbox · L2 fix-commit/, "in the review body");
  h.send("i");
  await settle();
  assert.match(h.lastFramePlain(), /3\)\s*\[L3\]/, "`i` returned to the inbox list");
  h.stop();
});

test("no filed review is ever labelled `i`, so its tab key can't shadow a row", async () => {
  // The inbox caps at 20; 20 rows exhaust the digits and run well past where
  // `i` used to sit, which is exactly where a dead label would show up.
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
  assert.match(frame, /h\)\s*\[L3\]\s*accept\s+review 17/, "letters run up to h");
  assert.match(frame, /j\)\s*\[L3\]\s*accept\s+review 18/, "and skip `i` for j");
  assert.ok(!/\bi\)/.test(frame), "no `i)` label exists to be shadowed");
  h.stop();
});

test("Ctrl-O closes the panel from the inbox tab and from an open review", async () => {
  const h = harness(undefined, 72, 16, undefined, fakeInbox(REVIEWS));
  const answer = h.tui.question();

  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /1\)\s*\[L1\]\s*rework/, "on the inbox tab");
  h.send(CTRL_O); // the list takes its own escape exit: the panel closes
  await settle();
  assert.match(h.lastFramePlain(), /you > /, "closed from the list");

  h.send(CTRL_O);
  await settle();
  h.send("1");
  await settle();
  assert.match(h.lastFramePlain(), /inbox · L1 rework/, "drilled into a review");
  h.send(CTRL_O); // and from the body, which Backspace would only pop back from
  await settle();
  assert.match(h.lastFramePlain(), /you > /, "closed from the body");

  h.send("typed\r");
  assert.equal(await answer, "typed", "no toggle leaked a keystroke into the buffer");
  h.stop();
});
