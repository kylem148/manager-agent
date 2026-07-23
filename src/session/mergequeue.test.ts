import { test } from "node:test";
import assert from "node:assert/strict";
import { MergeQueue } from "./mergequeue.js";
import type { LandingGateHost, LandingGateResult } from "./landinggate.js";
import type {
  PrepareConflict,
  PrepareFailed,
  PrepareGreen,
  PrepareResult,
  prepareLanding,
  reviewLanding,
} from "./landing.js";

/**
 * State-machine tests for the serial merge queue. These use FAKE landing deps —
 * a scripted prepare and a scripted gate — so every transition (ready, blocked,
 * advance, retry, busy, empty) is driven deterministically without a git repo or
 * a live terminal. The real prepare/gate/merge integration (a green head through
 * a real repo and scripted gate, then advancing onto the new dev tip) is proved
 * against actual git in features.test.ts.
 */

function green(feature: string, commits = 1): PrepareGreen {
  return {
    kind: "green",
    feature,
    branch: `co/feat-${feature}`,
    devSha: "dev0",
    featureSha: `feat-${feature}`,
    diff: "+work\n",
    commits: Array.from({ length: commits }, (_, i) => `c${i} job: ${feature} slice ${i}`),
  };
}
function conflict(feature: string): PrepareConflict {
  return {
    kind: "conflict",
    feature,
    branch: `co/feat-${feature}`,
    devSha: "dev0",
    conflictFiles: ["file.txt"],
    detail: "could not apply",
  };
}
function failed(feature: string): PrepareFailed {
  return {
    kind: "failed",
    feature,
    branch: `co/feat-${feature}`,
    devSha: "dev0",
    featureSha: `feat-${feature}`,
    exitCode: 2,
    output: "boom went the suite",
  };
}

interface Harness {
  queue: MergeQueue;
  /** Per-feature prepare behaviour; missing feature defaults to green-1. Swap a
   *  function to model a retry that flips blocked -> green. */
  prepareFn: Map<string, () => PrepareResult>;
  prepareCalls: string[];
  reviewCalls: string[];
  /** What the scripted gate does on the next mergeHead. */
  gate: { outcome: "merged" | "rejected" | "failed"; error?: string };
  busy: Set<string>;
  forgotten: string[];
}

function makeHarness(opts: { gate?: boolean } = {}): Harness {
  const prepareFn = new Map<string, () => PrepareResult>();
  const prepareCalls: string[] = [];
  const reviewCalls: string[] = [];
  const busy = new Set<string>();
  const forgotten: string[] = [];
  const h = { prepareFn, prepareCalls, reviewCalls, busy, forgotten } as Harness;
  h.gate = { outcome: "merged" };

  const fakePrepare: typeof prepareLanding = async (_opts, feature) => {
    prepareCalls.push(feature);
    const fn = prepareFn.get(feature) ?? (() => green(feature));
    return fn();
  };

  const fakeReview: typeof reviewLanding = async (_host, _opts, feature, prepared) => {
    reviewCalls.push(feature);
    const g = h.gate;
    const result: LandingGateResult = { prepared: prepared!, outcome: g.outcome };
    if (g.outcome === "merged") {
      result.landed = {
        feature,
        branch: `co/feat-${feature}`,
        mergeSha: `merge-${feature}`,
        previousDevSha: "dev0",
        teardown: { branch: `co/feat-${feature}`, worktreeRemoved: true, branchDeleted: true },
      };
    } else if (g.outcome === "failed") {
      result.error = g.error ?? "the merge could not proceed";
    }
    return result;
  };

  const gateHost: LandingGateHost = { openLandingReview: async () => "rejected" };
  h.queue = new MergeQueue({
    repoPath: "/fake/repo",
    buildTestCommand: "true",
    ...(opts.gate === false ? {} : { gateHost }),
    host: { isBusy: (f) => busy.has(f), forget: (f) => forgotten.push(f) },
    deps: { prepare: fakePrepare, review: fakeReview },
  });
  return h;
}

/** The head-only invariant: every non-head entry is "queued", and at most one
 *  entry (the head) is ever anything else. */
function assertHeadOnly(q: MergeQueue): void {
  const v = q.view();
  v.entries.forEach((e, i) => {
    if (i > 0) assert.equal(e.status, "queued", `non-head '${e.feature}' must be queued`);
  });
  const active = v.entries.filter((e) => e.status !== "queued");
  assert.ok(active.length <= 1, "at most one non-queued entry");
  if (active.length === 1) assert.ok(active[0]!.isHead, "the only active entry is the head");
}

test("empty queue: mergeHead and processHead are clean no-ops", async () => {
  const h = makeHarness();
  assert.equal(h.queue.view().size, 0);
  assert.equal(h.queue.view().head, null);

  const proc = await h.queue.processHead();
  assert.equal(proc.processed, false);
  assert.equal(proc.head, null);

  const merge = await h.queue.mergeHead();
  assert.equal(merge.merged, false);
  assert.equal(merge.outcome, "empty");
  assert.equal(h.prepareCalls.length, 0);
  assert.equal(h.reviewCalls.length, 0);
});

test("enqueue processes the head to ready; later features stay queued (head-only, no speculation)", async () => {
  const h = makeHarness();

  const a = await h.queue.enqueue("aaa");
  assert.equal(a.alreadyQueued, false);
  assert.equal(a.head?.feature, "aaa");
  assert.equal(a.head?.status, "ready");
  assert.equal(a.head?.commitsReady, 1);
  assert.deepEqual(h.prepareCalls, ["aaa"], "the head was processed");

  const b = await h.queue.enqueue("bbb");
  assert.equal(b.head?.feature, "aaa", "the head is unchanged");
  assert.equal(b.entry.position, 2);
  assert.equal(b.entry.status, "queued");
  // The key invariant: a non-head feature is NEVER speculatively prepared.
  assert.deepEqual(h.prepareCalls, ["aaa"], "bbb was not prepared while behind the head");

  assertHeadOnly(h.queue);
  assert.deepEqual(
    h.queue.view().entries.map((e) => [e.feature, e.status]),
    [["aaa", "ready"], ["bbb", "queued"]],
  );
});

test("enqueue is idempotent: re-enqueuing a ready head keeps its place and does not re-process", async () => {
  const h = makeHarness();
  await h.queue.enqueue("aaa");
  const again = await h.queue.enqueue("aaa");
  assert.equal(again.alreadyQueued, true);
  assert.equal(again.head?.status, "ready");
  assert.deepEqual(h.prepareCalls, ["aaa"], "a ready head is not re-prepared");
  assert.equal(h.queue.view().size, 1);
});

test("a rebase conflict blocks the head and it holds the queue", async () => {
  const h = makeHarness();
  h.prepareFn.set("aaa", () => conflict("aaa"));

  const a = await h.queue.enqueue("aaa");
  assert.equal(a.head?.status, "blocked");
  assert.match(a.head?.blockedReason ?? "", /conflict/);

  await h.queue.enqueue("bbb");
  assertHeadOnly(h.queue);
  // The blocked head still holds position 1; bbb waits behind it, unprocessed.
  assert.deepEqual(
    h.queue.view().entries.map((e) => e.feature),
    ["aaa", "bbb"],
  );

  // Merging is refused while the head is blocked — nothing merges, nothing advances.
  const merge = await h.queue.mergeHead();
  assert.equal(merge.merged, false);
  assert.equal(merge.outcome, "not-ready");
  assert.equal(h.reviewCalls.length, 0, "the gate never opened for a blocked head");
  assert.equal(h.forgotten.length, 0);
  assert.equal(h.queue.headFeature(), "aaa", "the blocked head still holds the queue");
});

test("a red build+test blocks the head", async () => {
  const h = makeHarness();
  h.prepareFn.set("aaa", () => failed("aaa"));
  const a = await h.queue.enqueue("aaa");
  assert.equal(a.head?.status, "blocked");
  assert.match(a.head?.blockedReason ?? "", /build\+test failed \(exit 2\)/);
});

test("a green head with no commits is blocked as nothing-to-land, not offered for merge", async () => {
  const h = makeHarness();
  h.prepareFn.set("aaa", () => green("aaa", 0));
  const a = await h.queue.enqueue("aaa");
  assert.equal(a.head?.status, "blocked");
  assert.match(a.head?.blockedReason ?? "", /nothing to land/);
});

test("a prepare precondition failure (thrown) becomes a blocked head, not a crash", async () => {
  const h = makeHarness();
  h.prepareFn.set("aaa", () => {
    throw new Error("worktree gone; run reconcile");
  });
  const a = await h.queue.enqueue("aaa");
  assert.equal(a.head?.status, "blocked");
  assert.match(a.head?.blockedReason ?? "", /worktree gone/);
});

test("advance on merge: the head merges via the gate, the queue advances, the new head is processed against the new dev", async () => {
  const h = makeHarness();
  await h.queue.enqueue("aaa");
  await h.queue.enqueue("bbb");
  assert.deepEqual(h.prepareCalls, ["aaa"], "only the head was processed so far");

  const merge = await h.queue.mergeHead();
  assert.equal(merge.merged, true);
  assert.equal(merge.outcome, "merged");
  assert.equal(merge.feature, "aaa");
  assert.equal(merge.mergeSha, "merge-aaa");
  assert.equal(merge.target, "dev");
  assert.deepEqual(h.forgotten, ["aaa"], "the merged feature's record was dropped");

  // The queue advanced and processed the NEW head — bbb was prepared only now,
  // AFTER aaa landed and moved dev (advance-processes-against-new-dev).
  assert.deepEqual(h.reviewCalls, ["aaa"], "the gate opened once, for aaa");
  assert.deepEqual(h.prepareCalls, ["aaa", "bbb"], "bbb processed only after aaa merged");
  assert.equal(merge.head?.feature, "bbb");
  assert.equal(merge.head?.status, "ready");
  assertHeadOnly(h.queue);

  // Merge the second: the queue empties.
  const merge2 = await h.queue.mergeHead();
  assert.equal(merge2.merged, true);
  assert.equal(merge2.feature, "bbb");
  assert.equal(merge2.head, null);
  assert.equal(h.queue.view().size, 0);
  assert.deepEqual(h.forgotten, ["aaa", "bbb"]);
});

test("mergeHead reuses the head's already-computed green: exactly one prepare, one gate", async () => {
  const h = makeHarness();
  await h.queue.enqueue("solo"); // one prepare (to ready)
  const merge = await h.queue.mergeHead();
  assert.equal(merge.merged, true);
  // The gate ran once, and prepare was NOT called a second time before it — the
  // ready head's green was handed straight to the gate.
  assert.deepEqual(h.reviewCalls, ["solo"]);
  assert.deepEqual(h.prepareCalls, ["solo"], "no redundant re-prepare at merge time");
});

test("a declined merge ([r]) leaves the head in place, ready, and merges nothing", async () => {
  const h = makeHarness();
  h.gate = { outcome: "rejected" };
  await h.queue.enqueue("aaa");
  await h.queue.enqueue("bbb");

  const merge = await h.queue.mergeHead();
  assert.equal(merge.merged, false);
  assert.equal(merge.outcome, "rejected");
  assert.equal(merge.head?.feature, "aaa");
  assert.equal(merge.head?.status, "ready");
  assert.equal(h.forgotten.length, 0);
  assert.equal(h.queue.headFeature(), "aaa", "the head still holds the queue");
  assert.deepEqual(h.prepareCalls, ["aaa"], "a rejection does not re-process");
});

test("an executeLanding refusal (failed gate) re-processes the head so its state stays honest", async () => {
  const h = makeHarness();
  h.gate = { outcome: "failed", error: "not rebased onto the current 'dev' tip" };
  await h.queue.enqueue("aaa");

  const merge = await h.queue.mergeHead();
  assert.equal(merge.merged, false);
  assert.equal(merge.outcome, "failed");
  assert.match(merge.error ?? "", /not rebased/);
  // Re-processed after the refusal: prepare ran a second time.
  assert.deepEqual(h.prepareCalls, ["aaa", "aaa"]);
  assert.equal(merge.head?.status, "ready", "the fresh prepare put it back to ready");
  assert.equal(h.forgotten.length, 0);
});

test("remove drops a queued feature; removing the head advances and processes the next", async () => {
  const h = makeHarness();
  await h.queue.enqueue("aaa");
  await h.queue.enqueue("bbb");
  await h.queue.enqueue("ccc");

  // Remove a non-head: order preserved, no advance-processing.
  const rmMid = await h.queue.remove("bbb");
  assert.equal(rmMid.removed, true);
  assert.equal(rmMid.wasHead, false);
  assert.deepEqual(h.queue.view().entries.map((e) => e.feature), ["aaa", "ccc"]);
  assert.deepEqual(h.prepareCalls, ["aaa"], "removing a non-head processes nothing");

  // Remove the head: ccc becomes head and is processed now.
  const rmHead = await h.queue.remove("aaa");
  assert.equal(rmHead.wasHead, true);
  assert.equal(rmHead.head?.feature, "ccc");
  assert.equal(rmHead.head?.status, "ready");
  assert.deepEqual(h.prepareCalls, ["aaa", "ccc"]);

  // Removing something not queued is a clean no-op.
  const rmNone = await h.queue.remove("zzz");
  assert.equal(rmNone.removed, false);
});

test("re-enqueuing a blocked head retries it (blocked -> green on the fix)", async () => {
  const h = makeHarness();
  h.prepareFn.set("aaa", () => conflict("aaa"));
  const first = await h.queue.enqueue("aaa");
  assert.equal(first.head?.status, "blocked");

  // The captain resolves the conflict; the next prepare would go green.
  h.prepareFn.set("aaa", () => green("aaa"));
  const retry = await h.queue.enqueue("aaa");
  assert.equal(retry.alreadyQueued, true);
  assert.equal(retry.head?.status, "ready");
  assert.deepEqual(h.prepareCalls, ["aaa", "aaa"], "the retry re-processed the head");
});

test("a busy head is not processed until the crew frees it; merge is refused meanwhile", async () => {
  const h = makeHarness();
  h.busy.add("aaa");

  const enq = await h.queue.enqueue("aaa");
  assert.equal(enq.head?.status, "queued", "a busy head is not rebased under a live agent");
  assert.equal(h.prepareCalls.length, 0);

  const merge = await h.queue.mergeHead();
  assert.equal(merge.merged, false);
  assert.equal(merge.outcome, "busy");
  assert.equal(h.reviewCalls.length, 0);

  // Crew finishes; the next enqueue processes it.
  h.busy.delete("aaa");
  const again = await h.queue.enqueue("aaa");
  assert.equal(again.head?.status, "ready");
  assert.deepEqual(h.prepareCalls, ["aaa"]);
});

test("with no interactive gate, mergeHead refuses cleanly and merges nothing", async () => {
  const h = makeHarness({ gate: false });
  await h.queue.enqueue("aaa");
  const merge = await h.queue.mergeHead();
  assert.equal(merge.merged, false);
  assert.equal(merge.outcome, "no-gate");
  assert.equal(h.reviewCalls.length, 0);
  assert.equal(h.queue.headFeature(), "aaa", "the head is untouched");
});
