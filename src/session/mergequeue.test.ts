import { test } from "node:test";
import assert from "node:assert/strict";
import { MergeQueue, MAX_RESOLVE_ATTEMPTS } from "./mergequeue.js";
import type { ChecksSummary } from "./checks.js";
import type {
  executeLanding,
  PrepareConflict,
  PrepareFailed,
  PrepareGreen,
  PreparePending,
  PrepareResult,
  prepareLanding,
} from "./landing.js";

/**
 * State-machine tests for the serial merge queue. These use FAKE landing deps —
 * a scripted prepare and a scripted merge — so every transition (ready, blocked,
 * advance, retry, busy, empty) is driven deterministically without a git repo.
 * The real prepare/merge integration (a green head through a real repo, then
 * advancing onto the new dev tip) is proved against actual git in features.test.ts.
 *
 * Since D-20260724-12 the merge is PANEL-NATIVE: mergeReadyHead just does the
 * merge, because the keystroke that reached it was the authorisation. There is no
 * gate host here, nothing is awaited on a human, and the queue has no idea a
 * terminal exists — which is exactly what these tests pin down.
 */

/** A checks summary in whatever shape a test needs. `runs` carries the names a
 *  surface is expected to echo back. */
function checks(partial: Partial<ChecksSummary> & Pick<ChecksSummary, "verdict">): ChecksSummary {
  const runs = partial.runs ?? [];
  return {
    ungated: partial.verdict === "none",
    requiredOnly: false,
    total: runs.length,
    passed: runs.filter((r) => r.bucket === "pass").length,
    failed: runs.filter((r) => r.bucket === "fail" || r.bucket === "cancel").length,
    pending: runs.filter((r) => r.bucket === "pending").length,
    skipped: runs.filter((r) => r.bucket === "skipping").length,
    ms: 12,
    ...partial,
    runs,
  };
}

const PR = {
  number: 7,
  url: `https://github.com/acme/repo/pull/7`,
  title: "work",
  body: "why and what",
  created: true,
};

function green(feature: string, commits = 1, checksSummary?: ChecksSummary): PrepareGreen {
  return {
    kind: "green",
    feature,
    branch: `feat/${feature}`,
    devSha: "dev0",
    featureSha: `feat-${feature}`,
    diff: "+work\n",
    commits: Array.from({ length: commits }, (_, i) => `c${i} job: ${feature} slice ${i}`),
    checks:
      checksSummary ??
      checks({ verdict: "passed", runs: [{ name: "build", bucket: "pass", state: "SUCCESS" }] }),
    pr: { ...PR, title: `${feature} work` },
  };
}

/** A green head whose PR reported NO checks: mergeable, but nothing verified it. */
function ungated(feature: string, commits = 1): PrepareGreen {
  return green(feature, commits, checks({ verdict: "none", runs: [] }));
}
function conflict(feature: string): PrepareConflict {
  return {
    kind: "conflict",
    feature,
    branch: `feat/${feature}`,
    devSha: "dev0",
    conflictFiles: ["file.txt"],
    detail: "could not apply",
  };
}
function failed(feature: string): PrepareFailed {
  return {
    kind: "failed",
    feature,
    branch: `feat/${feature}`,
    devSha: "dev0",
    featureSha: `feat-${feature}`,
    commits: [`c0 job: ${feature}`],
    checks: checks({
      verdict: "failed",
      runs: [
        { name: "build", bucket: "pass", state: "SUCCESS" },
        { name: "test (ubuntu)", bucket: "fail", state: "FAILURE", link: "https://ci/9" },
      ],
    }),
    pr: { ...PR, title: `${feature} work` },
  };
}
function pending(feature: string): PreparePending {
  return {
    kind: "pending",
    feature,
    branch: `co/feat-${feature}`,
    devSha: "dev0",
    featureSha: `feat-${feature}`,
    commits: [`c0 job: ${feature}`],
    checks: checks({
      verdict: "pending",
      timedOut: true,
      runs: [{ name: "test", bucket: "pending", state: "IN_PROGRESS" }],
    }),
    pr: { ...PR, title: `${feature} work` },
  };
}

interface Harness {
  queue: MergeQueue;
  /** Per-feature prepare behaviour; missing feature defaults to green-1. Swap a
   *  function to model a retry that flips blocked -> green. */
  prepareFn: Map<string, () => PrepareResult>;
  prepareCalls: string[];
  /** Every executeLanding the queue drove: `<feature>@<pinned featureSha>`. The
   *  pin is recorded because it is the safety property — a merge may only ever
   *  cover the exact state the head was tested at. */
  mergeCalls: string[];
  /** Set to make the next executeLanding throw, the way a stale green does. */
  executeError: string | null;
  busy: Set<string>;
  forgotten: string[];
}

function makeHarness(): Harness {
  const prepareFn = new Map<string, () => PrepareResult>();
  const prepareCalls: string[] = [];
  const mergeCalls: string[] = [];
  const busy = new Set<string>();
  const forgotten: string[] = [];
  const h = { prepareFn, prepareCalls, mergeCalls, busy, forgotten } as Harness;
  h.executeError = null;

  const fakePrepare: typeof prepareLanding = async (_opts, feature) => {
    prepareCalls.push(feature);
    const fn = prepareFn.get(feature) ?? (() => green(feature));
    return fn();
  };

  const fakeExecute: typeof executeLanding = async (_opts, feature, expect) => {
    // The pin is recorded in full: the tested tip, the origin/dev it was tested
    // against, and the PR the captain reviewed. All three are the safety story.
    mergeCalls.push(
      `${feature}@${expect?.featureSha ?? "-"}+${expect?.devSha ?? "-"}#${expect?.prNumber ?? "-"}`,
    );
    if (h.executeError) throw new Error(h.executeError);
    return {
      feature,
      branch: `feat/${feature}`,
      mergeSha: `merge-${feature}`,
      previousDevSha: "dev0",
      pr: { number: 7, url: "https://github.com/acme/repo/pull/7" },
      teardown: {
        branch: `feat/${feature}`,
        worktreeRemoved: true,
        branchDeleted: false,
        branchKeptReason: "kept by policy",
      },
    };
  };

  h.queue = new MergeQueue({
    repoPath: "/fake/repo",
    host: { isBusy: (f) => busy.has(f), forget: (f) => forgotten.push(f) },
    deps: { prepare: fakePrepare, execute: fakeExecute },
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

test("empty queue: mergeReadyHead and processHead are clean no-ops", async () => {
  const h = makeHarness();
  assert.equal(h.queue.view().size, 0);
  assert.equal(h.queue.view().head, null);
  assert.equal(h.queue.headDetail(), null, "an empty queue has no head body to render");

  const proc = await h.queue.processHead();
  assert.equal(proc.processed, false);
  assert.equal(proc.head, null);

  const merge = await h.queue.mergeReadyHead();
  assert.equal(merge.merged, false);
  assert.equal(merge.outcome, "empty");
  assert.equal(h.prepareCalls.length, 0);
  assert.equal(h.mergeCalls.length, 0);
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
  const merge = await h.queue.mergeReadyHead();
  assert.equal(merge.merged, false);
  assert.equal(merge.outcome, "not-ready");
  assert.equal(h.mergeCalls.length, 0, "no merge was even attempted on a blocked head");
  assert.equal(h.forgotten.length, 0);
  assert.equal(h.queue.headFeature(), "aaa", "the blocked head still holds the queue");
});

test("a red CI check blocks the head, and the reason names the check", async () => {
  const h = makeHarness();
  h.prepareFn.set("aaa", () => failed("aaa"));
  const a = await h.queue.enqueue("aaa");
  assert.equal(a.head?.status, "blocked");
  assert.equal(a.head?.blockedKind, "failed");
  assert.match(a.head?.blockedReason ?? "", /PR #7/);
  assert.match(a.head?.blockedReason ?? "", /test \(ubuntu\)/);
});

test("checks still running leave the head AWAITING, not blocked and not ready", async () => {
  const h = makeHarness();
  h.prepareFn.set("aaa", () => pending("aaa"));
  const a = await h.queue.enqueue("aaa");
  assert.equal(a.head?.status, "awaiting-checks");
  assert.equal(a.head?.checksPending, 1);
  assert.equal(a.head?.blockedKind, undefined, "waiting on CI is not a block");
  assert.equal(a.head?.blockedReason, undefined);
  assert.match(a.summary, /WAITING on its pull request's CI checks/);

  // It holds the queue: no [m], nothing behind it is touched.
  const behind = await h.queue.enqueue("bbb");
  assert.equal(behind.entry.status, "queued");
  assert.deepEqual(h.prepareCalls, ["aaa"], "nothing behind an awaiting head is prepared");
  const m = await h.queue.mergeReadyHead();
  assert.equal(m.merged, false);
  assert.equal(m.outcome, "not-ready");
  assert.equal(h.mergeCalls.length, 0);

  // Re-enqueuing it is the re-read lever, and CI having finished makes it ready.
  h.prepareFn.set("aaa", () => green("aaa"));
  const again = await h.queue.enqueue("aaa");
  assert.equal(again.head?.status, "ready");
});

test("a head whose PR reports NO checks is READY, flagged ungated, and merges", async () => {
  const h = makeHarness();
  h.prepareFn.set("aaa", () => ungated("aaa"));
  const a = await h.queue.enqueue("aaa");
  // The anti-regression: co could not verify it, and that is a state to report,
  // never an error and never a red that wedges the queue.
  assert.equal(a.head?.status, "ready");
  assert.equal(a.head?.ungated, true);
  assert.match(a.summary, /UNGATED/);
  assert.match(a.summary, /NO CI checks/);

  const d = h.queue.headDetail();
  assert.equal(d?.kind, "ready");
  if (d?.kind !== "ready") return;
  assert.equal(d.checks?.ungated, true, "the panel is told, so it can colour it differently");

  const m = await h.queue.mergeReadyHead();
  assert.equal(m.merged, true, "an ungated head is mergeable — the captain is the gate");
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

test("advance on merge: the head merges, the queue advances, the new head is processed against the new dev", async () => {
  const h = makeHarness();
  await h.queue.enqueue("aaa");
  await h.queue.enqueue("bbb");
  assert.deepEqual(h.prepareCalls, ["aaa"], "only the head was processed so far");

  const merge = await h.queue.mergeReadyHead();
  assert.equal(merge.merged, true);
  assert.equal(merge.outcome, "merged");
  assert.equal(merge.feature, "aaa");
  assert.equal(merge.mergeSha, "merge-aaa");
  assert.equal(merge.target, "dev");
  assert.deepEqual(h.forgotten, ["aaa"], "the merged feature's record was dropped");

  // The queue advanced and processed the NEW head — bbb was prepared only now,
  // AFTER aaa landed and moved dev (advance-processes-against-new-dev). This is
  // what makes the next [m] live by the time the keystroke's merge resolves.
  assert.deepEqual(
    h.mergeCalls,
    ["aaa@feat-aaa+dev0#7"],
    "one merge, pinned to the tested tip, its base, and the reviewed PR",
  );
  assert.deepEqual(h.prepareCalls, ["aaa", "bbb"], "bbb processed only after aaa merged");
  assert.equal(merge.head?.feature, "bbb");
  assert.equal(merge.head?.status, "ready");
  assertHeadOnly(h.queue);

  // Merge the second: the queue empties.
  const merge2 = await h.queue.mergeReadyHead();
  assert.equal(merge2.merged, true);
  assert.equal(merge2.feature, "bbb");
  assert.equal(merge2.head, null);
  assert.equal(h.queue.view().size, 0);
  assert.deepEqual(h.forgotten, ["aaa", "bbb"]);
});

test("mergeReadyHead reuses the head's already-computed green: exactly one prepare, one merge", async () => {
  const h = makeHarness();
  await h.queue.enqueue("solo"); // one prepare (to ready)
  const merge = await h.queue.mergeReadyHead();
  assert.equal(merge.merged, true);
  // The merge ran once, pinned to the prepared sha, and prepare was NOT re-run:
  // the panel's [m] must not pay for a second checks read.
  assert.deepEqual(h.mergeCalls, ["solo@feat-solo+dev0#7"]);
  assert.deepEqual(h.prepareCalls, ["solo"], "no redundant re-prepare at merge time");
});

test("an executeLanding refusal re-processes the head so its state stays honest", async () => {
  const h = makeHarness();
  h.executeError = "not rebased onto the current 'dev' tip";
  await h.queue.enqueue("aaa");

  const merge = await h.queue.mergeReadyHead();
  assert.equal(merge.merged, false);
  assert.equal(merge.outcome, "failed");
  assert.match(merge.error ?? "", /not rebased/);
  // Re-processed after the refusal: prepare ran a second time, so what the panel
  // paints next is the truth rather than the green that just failed.
  assert.deepEqual(h.prepareCalls, ["aaa", "aaa"]);
  assert.equal(merge.head?.status, "ready", "the fresh prepare put it back to ready");
  assert.equal(h.forgotten.length, 0, "nothing was torn down by a refused merge");
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

  const merge = await h.queue.mergeReadyHead();
  assert.equal(merge.merged, false);
  assert.equal(merge.outcome, "busy");
  assert.equal(h.mergeCalls.length, 0);

  // Crew finishes; the next enqueue processes it.
  h.busy.delete("aaa");
  const again = await h.queue.enqueue("aaa");
  assert.equal(again.head?.status, "ready");
  assert.deepEqual(h.prepareCalls, ["aaa"]);
});

// --- what the panel reads and presses (D-20260724-12) ------------------------

test("headDetail carries a ready head's PR, commits and checks evidence", async () => {
  const h = makeHarness();
  h.prepareFn.set("aaa", () => green("aaa", 2));
  await h.queue.enqueue("aaa");

  const d = h.queue.headDetail();
  assert.ok(d, "a ready head has a body to render");
  assert.equal(d?.kind, "ready");
  if (d?.kind !== "ready") return;
  assert.equal(d.feature, "aaa");
  assert.equal(d.target, "dev");
  assert.equal(d.commits.length, 2, "the per-job commits the merge preserves");
  assert.equal(d.pr?.number, 7, "the PR the [m] would merge");
  assert.equal(d.pr?.title, "aaa work");
  assert.equal(d.checks?.verdict, "passed", "the evidence, stated not implied");
  assert.deepEqual(d.checks?.runs.map((r) => r.name), ["build"]);
});

test("headDetail carries an awaiting head's PR and what it is still waiting on", async () => {
  const h = makeHarness();
  h.prepareFn.set("aaa", () => pending("aaa"));
  await h.queue.enqueue("aaa");
  const d = h.queue.headDetail();
  assert.equal(d?.kind, "awaiting");
  if (d?.kind !== "awaiting") return;
  assert.equal(d.pr?.number, 7);
  assert.equal(d.checks?.verdict, "pending");
  assert.deepEqual(d.checks?.runs.map((r) => r.name), ["test"]);
});

test("headDetail carries a blocked head's kind and detail, and no ready body", async () => {
  const hc = makeHarness();
  hc.prepareFn.set("aaa", () => conflict("aaa"));
  await hc.queue.enqueue("aaa");
  const dc = hc.queue.headDetail();
  assert.equal(dc?.kind, "blocked");
  if (dc?.kind !== "blocked") return;
  assert.equal(dc.blockedKind, "conflict");
  assert.deepEqual(dc.conflictFiles, ["file.txt"]);
  assert.equal(dc.detail, "could not apply");
  assert.equal(dc.maxResolveAttempts, MAX_RESOLVE_ATTEMPTS, "the panel can state the bound");

  const hf = makeHarness();
  hf.prepareFn.set("aaa", () => failed("aaa"));
  await hf.queue.enqueue("aaa");
  const df = hf.queue.headDetail();
  assert.equal(df?.kind, "blocked");
  if (df?.kind !== "blocked") return;
  assert.equal(df.blockedKind, "failed");
  assert.equal(df.checks?.verdict, "failed");
  assert.deepEqual(
    df.checks?.runs.filter((r) => r.bucket === "fail").map((r) => r.name),
    ["test (ubuntu)"],
    "the panel can name what went red and link the run",
  );
  assert.equal(df.pr?.number, 7, "and point at the PR where it is read");
});

test("headDetail is null for a head that is merely processing or being resolved", async () => {
  const h = makeHarness();
  h.prepareFn.set("aaa", () => conflict("aaa"));
  await h.queue.enqueue("aaa");
  h.queue.beginResolve();
  assert.equal(h.queue.view().head?.status, "resolving");
  assert.equal(h.queue.headDetail(), null, "a resolving head has no mergeable/blocked body");
});

test("mergeReadyHead needs no gate host and never waits on anything but git", async () => {
  // The whole point of the panel-native shape: the queue has no terminal, no
  // host and no promise held open for a human — the keystroke already happened.
  const h = makeHarness();
  await h.queue.enqueue("aaa");
  const merge = await h.queue.mergeReadyHead();
  assert.equal(merge.merged, true, "a ready head merges outright");
  assert.deepEqual(h.mergeCalls, ["aaa@feat-aaa+dev0#7"]);
  assert.equal(h.queue.view().size, 0);
});

// --- Part B: conflict vs red distinction + the resolve path ------------------

test("a conflict-blocked head carries blockedKind 'conflict'; a red one carries 'failed'", async () => {
  const hc = makeHarness();
  hc.prepareFn.set("aaa", () => conflict("aaa"));
  const c1 = await hc.queue.enqueue("aaa");
  assert.equal(c1.head?.status, "blocked");
  assert.equal(c1.head?.blockedKind, "conflict", "a rebase conflict is flagged as conflict");

  const hf = makeHarness();
  hf.prepareFn.set("aaa", () => failed("aaa"));
  const f1 = await hf.queue.enqueue("aaa");
  assert.equal(f1.head?.status, "blocked");
  assert.equal(f1.head?.blockedKind, "failed", "a red CI check is flagged as failed");
});

test("a lifecycle-blocked head (thrown prepare) has NO blockedKind and can't be resolved", async () => {
  const h = makeHarness();
  h.prepareFn.set("aaa", () => {
    throw new Error("worktree gone; run reconcile");
  });
  await h.queue.enqueue("aaa");
  const v = h.queue.view();
  assert.equal(v.head?.status, "blocked");
  assert.equal(v.head?.blockedKind, undefined, "a lifecycle failure isn't a fixable conflict/red");
  const gate = h.queue.canResolveHead();
  assert.equal(gate.ok, false, "a resolver has nothing to do on a lifecycle block");
});

test("canResolveHead gates on state: empty, not-blocked, and blocked-fixable", async () => {
  const h = makeHarness();
  assert.equal(h.queue.canResolveHead().ok, false, "empty queue: nothing to resolve");

  await h.queue.enqueue("aaa"); // ready
  assert.equal(h.queue.canResolveHead().ok, false, "a ready head is not resolvable");

  const h2 = makeHarness();
  h2.prepareFn.set("aaa", () => conflict("aaa"));
  await h2.queue.enqueue("aaa");
  const gate = h2.queue.canResolveHead();
  assert.equal(gate.ok, true);
  if (gate.ok) {
    assert.equal(gate.feature, "aaa");
    assert.equal(gate.kind, "conflict");
    assert.equal(gate.attempt, 1, "the first resolve is attempt 1");
  }
});

test("beginResolve marks the head 'resolving' and counts the attempt; a busy resolving head is held, not reset", async () => {
  const h = makeHarness();
  h.prepareFn.set("aaa", () => conflict("aaa"));
  await h.queue.enqueue("aaa");

  const started = h.queue.beginResolve();
  assert.equal(started.started, true);
  const v = h.queue.view();
  assert.equal(v.head?.status, "resolving");
  assert.equal(v.head?.resolveAttempts, 1);
  assert.equal(v.head?.blockedKind, "conflict", "it still records WHAT is being resolved");

  // While the resolver agent owns the worktree, processHead must not reset the
  // resolving head back to queued (that would lose the in-flight marker).
  h.busy.add("aaa");
  await h.queue.processHead();
  assert.equal(h.queue.view().head?.status, "resolving", "a busy resolving head stays resolving");
});

test("resolving -> re-process -> ready when the agent's fix goes green", async () => {
  const h = makeHarness();
  h.prepareFn.set("aaa", () => conflict("aaa"));
  await h.queue.enqueue("aaa");
  await h.queue.enqueue("bbb"); // a follower that must NOT be touched
  h.queue.beginResolve();
  assert.equal(h.queue.view().head?.status, "resolving");

  // The resolver agent committed a fix; the next prepare goes green.
  h.prepareFn.set("aaa", () => green("aaa"));
  const done = await h.queue.onResolveDone("aaa");
  assert.equal(done.head?.feature, "aaa");
  assert.equal(done.head?.status, "ready", "a green re-process makes the head ready");
  assertHeadOnly(h.queue);
  // The follower was never speculatively prepared through any of this.
  assert.deepEqual(h.prepareCalls, ["aaa", "aaa"], "only the head re-processed; bbb untouched");
});

test("resolving -> re-process -> blocked again keeps the attempt count (the bound holds)", async () => {
  const h = makeHarness();
  h.prepareFn.set("aaa", () => conflict("aaa"));
  await h.queue.enqueue("aaa");
  h.queue.beginResolve();
  assert.equal(h.queue.view().head?.resolveAttempts, 1);

  // The agent didn't fix it: still conflicted.
  const done = await h.queue.onResolveDone("aaa");
  assert.equal(done.head?.status, "blocked");
  assert.equal(done.head?.blockedKind, "conflict");
  assert.equal(h.queue.view().head?.resolveAttempts, 1, "the spent attempt is preserved across the re-block");
});

test("the retry bound: after MAX_RESOLVE_ATTEMPTS the head stays blocked and canResolveHead refuses", async () => {
  const h = makeHarness();
  h.prepareFn.set("aaa", () => conflict("aaa"));
  await h.queue.enqueue("aaa");

  for (let i = 1; i <= MAX_RESOLVE_ATTEMPTS; i++) {
    const gate = h.queue.canResolveHead();
    assert.equal(gate.ok, true, `attempt ${i} is allowed`);
    if (gate.ok) assert.equal(gate.attempt, i);
    const started = h.queue.beginResolve();
    assert.equal(started.started, true);
    await h.queue.onResolveDone("aaa"); // still conflicted each time
  }

  const after = h.queue.canResolveHead();
  assert.equal(after.ok, false, "past the bound, no more resolvers");
  if (!after.ok) assert.match(after.reason, /limit/);
  assert.equal(h.queue.view().head?.status, "blocked", "the head stays blocked, holding the queue");
  assert.equal(h.queue.headFeature(), "aaa");
});

test("onResolveDone is a no-op when the resolving head advanced or changed under it", async () => {
  const h = makeHarness();
  h.prepareFn.set("aaa", () => conflict("aaa"));
  await h.queue.enqueue("aaa");
  h.queue.beginResolve();

  // A stale completion for a feature that isn't the resolving head.
  const stale = await h.queue.onResolveDone("bbb");
  assert.equal(stale.processed, false);
  assert.equal(h.queue.view().head?.status, "resolving", "the real head is untouched by a stale done");
});

test("a resolved-green head then merges from the panel and advances normally", async () => {
  const h = makeHarness();
  h.prepareFn.set("aaa", () => conflict("aaa"));
  await h.queue.enqueue("aaa");
  await h.queue.enqueue("bbb");
  h.queue.beginResolve();
  h.prepareFn.set("aaa", () => green("aaa"));
  await h.queue.onResolveDone("aaa");

  const merge = await h.queue.mergeReadyHead();
  assert.equal(merge.merged, true, "a resolved head merges like any ready head");
  assert.equal(merge.feature, "aaa");
  assert.equal(merge.head?.feature, "bbb", "the queue advanced to the follower");
  assert.deepEqual(h.forgotten, ["aaa"]);
});
