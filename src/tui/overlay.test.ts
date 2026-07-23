import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Tui,
  renderMarkdownDoc,
  type DocSource,
  type InStream,
  type LandingReview,
  type OutStream,
} from "./tui.js";
import { stripAnsi } from "./wrap.js";

/**
 * End-to-end tests for the in-session overlay (Ctrl-O): the doc viewer, and
 * the landing gate that shares its modality, paging, and paint frame. Raw
 * bytes go in one end and we assert on the painted frames and on the calls the
 * overlay makes into its injected sources. The DocSource is faked so nothing
 * touches the filesystem (the real docs/-only sandbox is proved in
 * memory/docs.test.ts); the LandingReview is faked so nothing touches git (the
 * real engine wiring is proved in session/landinggate.test.ts).
 *
 * The invariants that matter here: the overlay is modal (keys drive the viewer,
 * not the prompt), it renders through the shared markdown renderer, it refreshes
 * live off the write-queue subscription, Esc restores the conversation intact,
 * a long doc pages without any arrow key - and for the gate, execute() fires
 * exactly once, from [m] alone, only over a mergeable prepare.
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

function harness(docs?: DocSource, cols = 40, rows = 12): Harness {
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
  const tui = new Tui({ promptLabel: PROMPT, out, inp, docs });
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

test("without a DocSource, Ctrl-O flashes a hint and never opens", async () => {
  const h = harness(undefined); // no docs wired (the degraded path)
  const answer = h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.match(stripAnsi(h.lastFrame()), /doc viewer unavailable/);
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

test("a green prepare shows header, summary, commits, diff, and the armed action bar", async () => {
  const h = harness(undefined, 60, 24); // tall enough that the whole body fits one screen
  const review = fakeReview(GREEN);
  const p = h.tui.openLandingReview(review);
  const frame = h.lastFramePlain();
  assert.match(frame, /landing · gate-ui → dev/, "header names the feature and target");
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
  const p = h.tui.openLandingReview(review);
  h.send("m");
  assert.equal(review.calls, 1, "the keystroke invoked execute");
  assert.match(h.lastFramePlain(), /merging into dev/, "the bar shows the merge in flight");
  // Fire-once: repeats (and dismissal attempts) during the merge are no-ops.
  h.send("m");
  h.send("m");
  h.send("r");
  h.send(ESC);
  assert.equal(review.calls, 1);
  assert.match(h.lastFramePlain(), /landing · gate-ui/, "still open mid-merge");
  review.resolveMerge("landed gate-ui: abc1234 on dev");
  await settle();
  assert.equal(await p, "merged");
  const frame = stripAnsi(h.lastFrame());
  assert.ok(!frame.includes("landing · gate-ui"), "the review dismissed itself");
  assert.match(frame, /landed gate-ui/, "the confirmation flashed");
  assert.match(frame, /you > /, "the conversation is back");
  h.stop();
});

test("[r] and Esc dismiss without ever calling execute", async () => {
  for (const key of ["r", ESC]) {
    const h = harness();
    h.tui.question();
    const review = fakeReview(GREEN);
    const p = h.tui.openLandingReview(review);
    h.send(key);
    assert.equal(await p, "rejected");
    assert.equal(review.calls, 0, "no merge on reject");
    assert.match(h.lastFrame(), /you > /, "the conversation is back");
    h.stop();
  }
});

test("while the gate is open, keystrokes drive it and never the prompt", async () => {
  const h = harness();
  const answer = h.tui.question();
  const review = fakeReview(GREEN);
  const p = h.tui.openLandingReview(review);
  h.send("hello"); // none of these letters are gate bindings
  h.send(ESC);
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
  const p = h.tui.openLandingReview(review);
  const frame = h.lastFramePlain();
  assert.match(frame, /hit conflicts/, "the state is named");
  assert.match(frame, /src\/app\.ts/);
  assert.match(frame, /src\/db\.ts/);
  assert.match(frame, /could not apply/, "git's account is shown");
  assert.match(frame, /m disabled \(conflict\)/, "the bar says why m is off");
  h.send("m");
  assert.equal(review.calls, 0, "a disabled m never reaches execute");
  assert.match(h.lastFramePlain(), /landing · /, "still open");
  h.send("r");
  assert.equal(await p, "rejected");
  h.stop();
});

test("a failed prepare shows the exit code and output, with [m] disabled", async () => {
  const h = harness(undefined, 60, 12);
  const review = fakeReview({ kind: "failed", exitCode: 3, output: "boom went the suite" });
  const p = h.tui.openLandingReview(review);
  const frame = h.lastFramePlain();
  assert.match(frame, /build\+test failed on the rebased state \(exit 3\)/);
  assert.match(frame, /boom went the suite/, "the suite's own output is shown");
  assert.match(frame, /m disabled \(build\+test red\)/);
  h.send("m");
  assert.equal(review.calls, 0);
  h.send(ESC);
  assert.equal(await p, "rejected");
  h.stop();
});

test("a refused merge surfaces the error in place; [m] stays off; dismissal reports failed", async () => {
  const h = harness(undefined, 60, 12);
  h.tui.question();
  const review = fakeReview(GREEN);
  const p = h.tui.openLandingReview(review);
  h.send("m");
  review.rejectMerge(
    new Error("'co/feat-x' is not rebased onto the current 'dev' tip; run prepareLanding again"),
  );
  await settle();
  const frame = h.lastFramePlain();
  assert.match(frame, /merge failed:/, "the refusal banners in place");
  assert.match(frame, /not rebased/, "with the engine's own reason");
  assert.match(frame, /landing · gate-ui/, "the gate survived the failure");
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
  const p = h.tui.openLandingReview(review);
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
  const p = h.tui.openLandingReview(review);
  const frame = h.lastFramePlain();
  assert.match(frame, /nothing to land/);
  assert.match(frame, /m disabled \(nothing to land\)/);
  h.send("m");
  assert.equal(review.calls, 0);
  h.send("r");
  assert.equal(await p, "rejected");
  h.stop();
});

test("opening the gate over the doc viewer replaces it cleanly", async () => {
  const docs = fakeDocs({ "plan.md": "# Plan\n" });
  const h = harness(docs);
  h.tui.question();
  h.send(CTRL_O);
  await settle();
  assert.match(h.lastFramePlain(), /1\)\s*plan\.md/, "the doc list is up");
  const review = fakeReview(GREEN);
  const p = h.tui.openLandingReview(review);
  assert.match(h.lastFramePlain(), /landing · gate-ui/, "the gate took the screen");
  // The doc subscription was torn down with the viewer: a write signal now is
  // a no-op, not a repaint back into doc mode.
  docs.emit("plan.md");
  await settle();
  assert.match(h.lastFramePlain(), /landing · gate-ui/, "the gate is undisturbed");
  h.send(ESC);
  assert.equal(await p, "rejected");
  assert.match(h.lastFrame(), /you > /);
  h.stop();
});

test("stopping the Tui with the gate open settles the review as rejected", async () => {
  const h = harness();
  const review = fakeReview(GREEN);
  const p = h.tui.openLandingReview(review);
  h.stop();
  assert.equal(await p, "rejected", "teardown never strands the caller");
  assert.equal(review.calls, 0);
});
