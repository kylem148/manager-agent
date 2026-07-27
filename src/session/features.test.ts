import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { instancePaths } from "../paths.js";
import { defaultDispatchConfig } from "./dispatchconfig.js";
import { DispatchRegistry } from "./registry.js";
import { FeatureManager } from "./features.js";
import {
  featureBranch,
  provisionWorktree,
  reconcileFeatures,
  defaultWorktreeBase,
} from "./worktrees.js";
import type { LandingGateHost } from "./landinggate.js";
import type { LandingReview } from "../tui/tui.js";
import { makeFakeForge, type FakeForge } from "./forgefake.test.js";

/**
 * Tests for the co-facing feature levers (features.ts), against real throwaway
 * git repos — the levers are thin wrappers over git plumbing, so the subject is
 * what git ends up doing — with the whole remote surface (fetch, push, gh) served
 * by the fake forge. No network, no gh binary, no GitHub account.
 *
 * `dev` here lives ONLY on the fake remote, and the fixture checks the local
 * `dev` out in the primary tree: that is the captain's real setup, and it is
 * exactly what the old local merge could not cope with. Every landing assertion
 * reads `fx.originDev()`, because that is now the only dev co ever moves.
 *
 * The DispatchRegistry is real but built with ghosttyAvailable: false (no panes
 * needed here; the feature-scoped DISPATCH cwd is proved in registry.test.ts)
 * and a stub installHook so the suite never mutates the developer's ~/.claude.
 * The landing gate is a scripted host, the same stand-in landinggate.test.ts
 * uses for the human's [m]/[r] keystroke.
 */

function run(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed (${res.status}): ${res.stderr}`);
  return res.stdout.trim();
}

function branchExists(repo: string, branch: string): boolean {
  return (
    spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo }).status === 0
  );
}

async function commitIn(worktree: string, file: string, content: string, msg: string): Promise<void> {
  await fsp.writeFile(path.join(worktree, file), content, "utf8");
  run(worktree, ["add", file]);
  run(worktree, ["commit", "-qm", msg]);
}

interface Fixture {
  repo: string;
  base: string;
  registry: DispatchRegistry;
  features: FeatureManager;
  forge: FakeForge;
  /** The integration tip as the remote holds it — the only dev co moves. */
  originDev: () => string;
  /** WorktreeOptions for calling the plumbing directly in a test. */
  opts: { repoPath: string; run: FakeForge["run"] };
  cleanup: () => Promise<void>;
}

/** A real repo + registry + FeatureManager. The manager operates on the repo's
 *  DEFAULT worktree base (a sibling dir) so it matches what the registry's
 *  provision path uses; `base` is that dir. buildTestCommand is a fast `true`. */
async function makeFixture(gateHost?: LandingGateHost): Promise<Fixture> {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "co-feat-")));
  const repo = path.join(root, "repo");
  await fsp.mkdir(repo);
  run(repo, ["init", "-q", "-b", "main"]);
  run(repo, ["config", "user.email", "test@test"]);
  run(repo, ["config", "user.name", "test"]);
  run(repo, ["config", "commit.gpgsign", "false"]);
  await fsp.writeFile(path.join(repo, "file.txt"), "hello\n", "utf8");
  run(repo, ["add", "."]);
  run(repo, ["commit", "-q", "-m", "init"]);
  // The captain's checkout: dev exists locally and is checked out here. co must
  // never write it — every landing goes to the remote through a PR.
  run(repo, ["branch", "dev", "main"]);
  run(repo, ["checkout", "-q", "dev"]);
  const forge = makeFakeForge(repo, { dev: run(repo, ["rev-parse", "dev"]) });

  const paths = instancePaths(path.join(root, "home"), "inst");
  await fsp.mkdir(paths.captures, { recursive: true });
  const config = defaultDispatchConfig();
  config.repoPath = repo;

  const registry = new DispatchRegistry({
    paths,
    config,
    onComplete: () => {},
    ghosttyAvailable: false,
    pollIntervalMs: 10_000,
    installHook: async () => ({ configDir: "/fake", changed: true }),
  });
  const features = new FeatureManager({
    registry,
    repoPath: repo,
    run: forge.run,
    ...(gateHost ? { gateHost } : {}),
    buildTestCommand: "true",
  });
  return {
    repo,
    base: defaultWorktreeBase(repo),
    registry,
    features,
    forge,
    originDev: () => forge.branches.get("dev")!,
    opts: { repoPath: repo, run: forge.run },
    cleanup: async () => {
      registry.stop();
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

test("feature_create provisions a worktree off origin/dev and registers the record; a second create is idempotent", async () => {
  const fx = await makeFixture();
  try {
    const res = await fx.features.create("User Auth", "add login");
    assert.equal(res.created, true);
    assert.equal(res.feature.slug, "user-auth");
    assert.equal(res.feature.branch, "co/feat-user-auth");
    assert.equal(res.feature.provisionStatus, "ready");
    assert.equal(res.feature.intent, "add login");
    // A real worktree exists on the feature branch, cut from origin/dev.
    assert.ok(fs.existsSync(res.feature.worktreePath));
    assert.equal(run(res.feature.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]), "co/feat-user-auth");
    assert.equal(run(res.feature.worktreePath, ["rev-parse", "HEAD"]), fx.originDev());
    // The captain's own checkout is untouched: still on dev, still at its tip.
    assert.equal(run(fx.repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "dev");
    assert.equal(run(fx.repo, ["status", "--porcelain"]), "");
    // The registry now tracks it.
    assert.equal(fx.registry.getFeature("User Auth")?.slug, "user-auth");

    // Idempotent: creating again returns the same worktree, created: false.
    const again = await fx.features.create("User Auth");
    assert.equal(again.created, false);
    assert.equal(again.feature.worktreePath, res.feature.worktreePath);
  } finally {
    await fx.cleanup();
  }
});

test("feature_status reports dirty state and jobs; a missing feature returns null", async () => {
  const fx = await makeFixture();
  try {
    await fx.features.create("cleanup");
    const clean = await fx.features.status("cleanup");
    assert.ok(clean);
    assert.equal(clean.dirty, false);

    // Dirty the worktree with an uncommitted file.
    await fsp.writeFile(path.join(clean.worktreePath, "scratch.txt"), "wip\n", "utf8");
    const dirty = await fx.features.status("cleanup");
    assert.equal(dirty?.dirty, true);

    assert.equal(await fx.features.status("nope"), null);
  } finally {
    await fx.cleanup();
  }
});

test("feature_abandon tears down a clean worktree and deletes its merged/unstarted branch", async () => {
  const fx = await makeFixture();
  try {
    const created = await fx.features.create("scrap");
    const branch = created.feature.branch;
    assert.ok(fs.existsSync(created.feature.worktreePath));

    const res = await fx.features.abandon("scrap");
    assert.equal(res.abandoned, true);
    assert.equal(res.teardown?.worktreeRemoved, true);
    // A fresh feature has no commits beyond dev, so it is "merged" and the branch is deleted.
    assert.equal(res.teardown?.branchDeleted, true);
    assert.ok(!fs.existsSync(created.feature.worktreePath));
    assert.ok(!branchExists(fx.repo, branch));
    assert.equal(fx.registry.getFeature("scrap"), undefined, "the record is dropped");
  } finally {
    await fx.cleanup();
  }
});

test("feature_abandon REFUSES a dirty worktree and forces nothing", async () => {
  const fx = await makeFixture();
  try {
    const created = await fx.features.create("risky");
    await fsp.writeFile(path.join(created.feature.worktreePath, "wip.txt"), "unsaved\n", "utf8");

    const res = await fx.features.abandon("risky");
    assert.equal(res.abandoned, false);
    assert.match(res.reason ?? "", /uncommitted changes/);
    // Nothing was destroyed.
    assert.ok(fs.existsSync(created.feature.worktreePath));
    assert.ok(branchExists(fx.repo, created.feature.branch));
    assert.ok(fx.registry.getFeature("risky"), "the record survives a refused abandon");
  } finally {
    await fx.cleanup();
  }
});

test("feature_abandon keeps a committed-but-unmerged branch and reports why", async () => {
  const fx = await makeFixture();
  try {
    const created = await fx.features.create("wip-feature");
    // Commit real work: now the branch has commits not in dev.
    await commitIn(created.feature.worktreePath, "real.txt", "work\n", "job: real work");

    const res = await fx.features.abandon("wip-feature");
    assert.equal(res.abandoned, true, "a CLEAN worktree (committed work) can be abandoned");
    assert.equal(res.teardown?.worktreeRemoved, true);
    assert.equal(res.teardown?.branchDeleted, false, "but the unmerged branch is KEPT");
    assert.match(res.teardown?.branchKeptReason ?? "", /not merged into 'origin\/dev'/);
    assert.ok(branchExists(fx.repo, created.feature.branch), "the branch survives to preserve the work");
  } finally {
    await fx.cleanup();
  }
});

// --- feature_land through a scripted gate ------------------------------------

/** A host that behaves like a human pressing [m] over a green (and dismissing
 *  anything else) — the same stand-in landinggate.test.ts uses. */
function approvingHost(seen: LandingReview[]): LandingGateHost {
  return {
    async openLandingReview(review) {
      seen.push(review);
      if (review.prepared.kind !== "green") return "rejected";
      try {
        await review.execute();
        return "merged";
      } catch {
        return "failed";
      }
    },
  };
}

function rejectingHost(seen: LandingReview[]): LandingGateHost {
  return {
    async openLandingReview(review) {
      seen.push(review);
      return "rejected";
    },
  };
}

test("feature_land runs prepare, opens the gate, and merges on [m]; the record is dropped", async () => {
  const seen: LandingReview[] = [];
  const fx = await makeFixture(approvingHost(seen));
  try {
    const created = await fx.features.create("ship-it");
    await commitIn(created.feature.worktreePath, "one.txt", "1\n", "job: slice");

    const res = await fx.features.land("ship-it");
    assert.equal(res.outcome, "merged");
    assert.equal(res.prepared, "green");
    assert.ok(res.merged);
    // The gate saw the real prepare, and it saw the PR it would merge.
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.feature, "ship-it");
    const gated = seen[0]!.prepared;
    assert.equal(gated.kind, "green");
    if (gated.kind === "green") assert.equal(gated.pr?.number, res.merged.pr.number);
    // origin/dev moved to the merge commit; the worktree went, the branch stayed.
    assert.equal(fx.originDev(), res.merged.mergeSha);
    assert.equal(fx.forge.prs[0]!.state, "MERGED");
    assert.ok(!fs.existsSync(created.feature.worktreePath), "the worktree is torn down");
    assert.ok(branchExists(fx.repo, created.feature.branch), "the branch ref is kept after a PR merge");
    assert.equal(fx.registry.getFeature("ship-it"), undefined, "the record is dropped after landing");
  } finally {
    await fx.cleanup();
  }
});

test("feature_land opens the gate but [r] merges nothing and leaves the feature intact", async () => {
  const seen: LandingReview[] = [];
  const fx = await makeFixture(rejectingHost(seen));
  try {
    const created = await fx.features.create("keep-me");
    await commitIn(created.feature.worktreePath, "k.txt", "k\n", "job: k");
    const devBefore = fx.originDev();

    const res = await fx.features.land("keep-me");
    assert.equal(res.outcome, "rejected");
    assert.equal(res.prepared, "green");
    assert.equal(fx.originDev(), devBefore, "rejection merged nothing");
    assert.equal(fx.forge.prs[0]!.state, "OPEN", "the PR stays open for another look");
    assert.ok(branchExists(fx.repo, created.feature.branch));
    assert.ok(fx.registry.getFeature("keep-me"), "a rejected feature stays tracked");
  } finally {
    await fx.cleanup();
  }
});

test("feature_land reports cleanly with no gate (non-interactive session), touching nothing", async () => {
  const fx = await makeFixture(/* no gateHost */);
  try {
    const created = await fx.features.create("headless");
    await commitIn(created.feature.worktreePath, "h.txt", "h\n", "job: h");

    const res = await fx.features.land("headless");
    assert.equal(res.outcome, "rejected");
    assert.match(res.error ?? "", /no landing gate/);
    assert.ok(branchExists(fx.repo, created.feature.branch), "nothing was landed or torn down");
  } finally {
    await fx.cleanup();
  }
});

// --- boot reconcile ----------------------------------------------------------

test("reconcileAtBoot rebuilds a record from an on-disk worktree with an empty registry", async () => {
  const fx = await makeFixture();
  try {
    // Provision a worktree directly (as a prior session would have), bypassing
    // the manager so its registry starts empty — exactly the restart case.
    const rec = await provisionWorktree(fx.opts, "survivor");
    assert.equal(fx.registry.getFeature("survivor"), undefined, "registry is empty before reconcile");

    const report = await fx.features.reconcileAtBoot();
    assert.equal(report.anomalies.length, 0);
    assert.equal(report.records.length, 1);
    assert.equal(report.records[0]!.slug, "survivor");
    // The record is seeded into the registry, keyed by slug.
    const tracked = fx.registry.getFeature("survivor");
    assert.ok(tracked);
    assert.equal(tracked.branch, "co/feat-survivor");
    assert.equal(tracked.worktreePath, rec.worktreePath);
    assert.equal(tracked.provisionStatus, "ready");
  } finally {
    await fx.cleanup();
  }
});

test("reconcileFeatures surfaces a branch-without-worktree anomaly for unmerged work, destroying nothing", async () => {
  const fx = await makeFixture();
  try {
    const rec = await provisionWorktree(fx.opts, "orphan");
    await commitIn(rec.worktreePath, "w.txt", "unmerged\n", "job: unmerged work");
    // Remove just the worktree, leaving the branch with unmerged commits.
    run(fx.repo, ["worktree", "remove", "--force", rec.worktreePath]);

    const report = await reconcileFeatures(fx.opts);
    assert.equal(report.records.length, 0);
    assert.equal(report.anomalies.length, 1);
    assert.equal(report.anomalies[0]!.kind, "branch-without-worktree");
    assert.match(report.anomalies[0]!.detail, /unmerged work/);
    // The branch is untouched — surfaced, not destroyed.
    assert.ok(branchExists(fx.repo, rec.branch));
  } finally {
    await fx.cleanup();
  }
});

test("reconcileFeatures says NOTHING about a landed branch whose worktree is gone: that is the resting state", async () => {
  const fx = await makeFixture();
  try {
    // A branch contained in origin/dev with no worktree is exactly what every
    // landed feature leaves behind now that refs are kept. Reporting it would
    // mean flagging the whole history on every boot.
    const rec = await provisionWorktree(fx.opts, "halfway");
    run(fx.repo, ["worktree", "remove", "--force", rec.worktreePath]);

    const report = await reconcileFeatures(fx.opts);
    assert.equal(report.records.length, 0);
    assert.deepEqual(report.anomalies, [], "a landed, kept branch is not an anomaly");
    assert.equal(featureBranch("halfway"), rec.branch);
    assert.ok(branchExists(fx.repo, rec.branch), "and it is certainly not destroyed");
  } finally {
    await fx.cleanup();
  }
});

test("reconcileFeatures flags a stray directory under the base and leaves it in place", async () => {
  const fx = await makeFixture();
  try {
    // A directory in the worktree base that git does not track as a worktree.
    await fsp.mkdir(fx.base, { recursive: true });
    const stray = path.join(fx.base, "not-a-worktree");
    await fsp.mkdir(stray);
    await fsp.writeFile(path.join(stray, "junk.txt"), "junk\n", "utf8");

    const report = await reconcileFeatures(fx.opts);
    const strayAnomaly = report.anomalies.find((a) => a.kind === "stray-directory");
    assert.ok(strayAnomaly, "the stray dir is surfaced");
    assert.equal(strayAnomaly.ref, stray);
    assert.ok(fs.existsSync(stray), "the stray dir is left untouched");
  } finally {
    await fx.cleanup();
  }
});

test("reconcileFeatures rebuilds a record AND surfaces an anomaly side by side", async () => {
  const fx = await makeFixture();
  try {
    const live = await provisionWorktree(fx.opts, "alive");
    const gone = await provisionWorktree(fx.opts, "gone");
    await commitIn(gone.worktreePath, "g.txt", "x\n", "job: work");
    run(fx.repo, ["worktree", "remove", "--force", gone.worktreePath]);

    const report = await reconcileFeatures(fx.opts);
    assert.deepEqual(
      report.records.map((r) => r.slug),
      ["alive"],
      "the live worktree rebuilds a record",
    );
    assert.equal(report.anomalies.length, 1);
    assert.equal(report.anomalies[0]!.kind, "branch-without-worktree");
    assert.ok(fs.existsSync(live.worktreePath));
  } finally {
    await fx.cleanup();
  }
});

// --- serial merge queue (end to end, real git + scripted gate) ---------------

test("merge queue: enqueue two, head processes to ready, the panel's [m] merges its PR and the second advances onto the NEW origin/dev", async () => {
  // A gate host is wired but must never be touched: since D-20260724-12 a queue
  // head merges through the PANEL, not through the feature_land review gate.
  const seen: LandingReview[] = [];
  const fx = await makeFixture(approvingHost(seen));
  try {
    const a = await fx.features.create("alpha");
    const b = await fx.features.create("beta");
    await commitIn(a.feature.worktreePath, "a.txt", "a\n", "job: alpha");
    await commitIn(b.feature.worktreePath, "b.txt", "b\n", "job: beta");
    const devStart = fx.originDev();

    // Enqueue alpha: it becomes head and is processed (rebase + build+test) to ready.
    const eA = await fx.features.enqueue("alpha");
    assert.equal(eA.enqueued, true);
    if (!eA.enqueued) return;
    assert.equal(eA.head?.feature, "alpha");
    assert.equal(eA.head?.status, "ready");
    assert.equal(eA.head?.commitsReady, 1);

    // Enqueue beta: alpha stays the ready head; beta waits queued, UNprocessed.
    const eB = await fx.features.enqueue("beta");
    if (!eB.enqueued) return;
    assert.equal(eB.head?.feature, "alpha");
    assert.equal(eB.entry.position, 2);
    assert.equal(eB.entry.status, "queued");
    assert.equal(fx.originDev(), devStart, "dev has not moved yet");

    // The captain presses [m] on the ready head in the panel.
    const m1 = await fx.features.mergeReadyHead();
    assert.equal(m1.merged, true);
    assert.equal(m1.feature, "alpha");
    const devAfterA = fx.originDev();
    assert.equal(devAfterA, m1.mergeSha);
    assert.notEqual(devAfterA, devStart, "origin/dev advanced to alpha's merge");
    assert.equal(m1.pr?.number, 1, "the merge went through alpha's PR");
    assert.ok(!fs.existsSync(a.feature.worktreePath), "alpha's worktree is torn down");
    assert.ok(branchExists(fx.repo, "co/feat-alpha"), "alpha's branch ref is kept");
    assert.equal(fx.registry.getFeature("alpha"), undefined, "alpha's record dropped");

    // The queue advanced: beta is now head and was processed AGAINST the new dev.
    assert.equal(m1.head?.feature, "beta");
    assert.equal(m1.head?.status, "ready");

    // Merge beta: it lands on top of alpha's dev, and the queue empties.
    const m2 = await fx.features.mergeReadyHead();
    assert.equal(m2.merged, true);
    assert.equal(m2.feature, "beta");
    assert.equal(m2.head, null, "the queue is now empty");
    assert.equal(fx.features.queueView().size, 0);
    const devAfterB = fx.originDev();
    assert.equal(devAfterB, m2.mergeSha);
    assert.equal(run(fx.repo, ["rev-parse", `${devAfterB}^1`]), devAfterA, "beta merged on top of alpha's dev");
    // Both features' work is on origin/dev, as two serial merge commits.
    assert.equal(run(fx.repo, ["show", `${devAfterB}:a.txt`]), "a");
    assert.equal(run(fx.repo, ["show", `${devAfterB}:b.txt`]), "b");
    assert.equal(run(fx.repo, ["rev-list", "--merges", "--count", devAfterB]), "2");
    assert.equal(fx.forge.prs.length, 2, "one PR per feature, both merged");
    assert.ok(fx.forge.prs.every((pr) => pr.state === "MERGED"));
    // The captain's checkout never moved, and no gh call ever deleted a branch.
    assert.equal(run(fx.repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "dev");
    assert.equal(run(fx.repo, ["rev-parse", "dev"]), devStart, "the LOCAL dev ref is never written");
    assert.ok(!fx.forge.calls.some((c) => /--delete-branch|--squash|--rebase/.test(c)));
    assert.equal(seen.length, 0, "no review gate was ever opened: the merge is panel-native");
  } finally {
    await fx.cleanup();
  }
});

test("a head whose origin/dev moved under it is re-validated, not merged: refuse, re-fetch, re-rebase, re-test", async () => {
  const fx = await makeFixture();
  try {
    const a = await fx.features.create("late");
    await commitIn(a.feature.worktreePath, "a.txt", "a\n", "job: late");
    const enq = await fx.features.enqueue("late");
    assert.equal(enq.enqueued, true);
    if (!enq.enqueued) return;
    assert.equal(enq.head?.status, "ready", "green against the origin/dev it was tested on");
    const testedBase = fx.originDev();

    // Someone else merges something into dev on GitHub while the head sits
    // ready. The green now covers a combined state that was never built.
    const tree = run(fx.repo, ["rev-parse", `${testedBase}^{tree}`]);
    const moved = run(fx.repo, ["commit-tree", "-p", testedBase, "-m", "someone else landed", tree]);
    fx.forge.branches.set("dev", moved);

    const res = await fx.features.mergeReadyHead();
    assert.equal(res.merged, false, "the stale green does not merge");
    assert.equal(res.outcome, "failed");
    assert.match(res.error ?? "", /'origin\/dev' moved since prepare/);
    assert.equal(fx.originDev(), moved, "and nothing was merged into it");
    assert.equal(fx.forge.prs[0]!.state, "OPEN");

    // The refusal re-processed the head against the NEW tip: fetched, rebased
    // and build+tested again, so what the panel offers next is honest.
    assert.equal(res.head?.feature, "late");
    assert.equal(res.head?.status, "ready", "green again, on the moved base this time");
    const detail = fx.features.headDetail();
    assert.equal(detail?.kind, "ready");
    assert.equal(
      run(fx.repo, ["merge-base", moved, "co/feat-late"]),
      moved,
      "the branch really sits on the moved origin/dev now",
    );

    // Now it merges, on top of what the other landing left.
    const second = await fx.features.mergeReadyHead();
    assert.equal(second.merged, true);
    assert.equal(run(fx.repo, ["rev-parse", `${fx.originDev()}^1`]), moved);
  } finally {
    await fx.cleanup();
  }
});

test("a missing prerequisite blocks the head with the fix, and never crashes the tool call", async () => {
  const fx = await makeFixture();
  try {
    const a = await fx.features.create("needs-gh");
    await commitIn(a.feature.worktreePath, "a.txt", "a\n", "job: a");
    fx.forge.ghInstalled = false;

    // enqueue must not throw: a prerequisite problem is a blocked head carrying
    // the message the captain has to act on.
    const enq = await fx.features.enqueue("needs-gh");
    assert.equal(enq.enqueued, true);
    if (!enq.enqueued) return;
    assert.equal(enq.head?.status, "blocked");
    assert.match(enq.head?.blockedReason ?? "", /GitHub CLI/);
    assert.equal(enq.head?.blockedKind, undefined, "not a conflict or a red suite: no resolver for this");
    assert.equal(fx.features.planResolveHead().ok, false, "and no agent is offered for it");

    // [m] on it does nothing, and nothing was pushed or PR'd.
    const m = await fx.features.mergeReadyHead();
    assert.equal(m.merged, false);
    assert.deepEqual(fx.forge.pushes, []);
    assert.equal(fx.forge.prs.length, 0);

    // Install gh: the same head re-processes to ready with no other change.
    fx.forge.ghInstalled = true;
    const retry = await fx.features.enqueue("needs-gh");
    assert.equal(retry.enqueued, true);
    if (!retry.enqueued) return;
    assert.equal(retry.head?.status, "ready");
    assert.equal(fx.forge.prs.length, 1, "and only now is a PR opened");
  } finally {
    await fx.cleanup();
  }
});

test("enqueue refuses a feature that was never created", async () => {
  const fx = await makeFixture();
  try {
    const res = await fx.features.enqueue("ghost");
    assert.equal(res.enqueued, false);
    if (res.enqueued) return;
    assert.match(res.reason, /no feature 'ghost'/);
  } finally {
    await fx.cleanup();
  }
});

test("feature_merge_head merges NOTHING in a session that has a panel: [m] is the captain's", async () => {
  // The retired blocking path (D-20260724-12). With a panel wired, the co's tool
  // must return at once, merge nothing, and point at the live [m] — never park
  // the agent loop on a keystroke.
  const seen: LandingReview[] = [];
  const fx = await makeFixture(approvingHost(seen));
  try {
    const a = await fx.features.create("panel-owned");
    await commitIn(a.feature.worktreePath, "p.txt", "p\n", "job: p");
    const enq = await fx.features.enqueue("panel-owned");
    assert.equal(enq.enqueued, true);
    if (!enq.enqueued) return;
    assert.equal(enq.head?.status, "ready");
    const devBefore = fx.originDev();

    const res = await fx.features.mergeHead();
    assert.equal(res.merged, false, "the co's tool never merges when a panel exists");
    assert.equal(res.outcome, "panel");
    assert.match(res.summary, /\[m\]/, "it points the co at the panel affordance");
    assert.equal(fx.originDev(), devBefore, "origin/dev did not move");
    assert.equal(fx.forge.prs[0]!.state, "OPEN", "the PR is still waiting on the keystroke");
    assert.equal(seen.length, 0, "and no gate was opened to wait on");
    assert.equal(fx.features.queueView().head?.status, "ready", "the head is untouched and still ready");

    // The panel path still merges it, as the captain's keystroke would.
    const m = await fx.features.mergeReadyHead();
    assert.equal(m.merged, true);
    assert.notEqual(fx.originDev(), devBefore);
  } finally {
    await fx.cleanup();
  }
});

test("feature_merge_head IS the merge in a session with no panel (the non-interactive fallback)", async () => {
  // No gateHost: a piped/non-TTY session, where there is no [m] to press at all.
  const fx = await makeFixture();
  try {
    const a = await fx.features.create("headless");
    await commitIn(a.feature.worktreePath, "h.txt", "h\n", "job: h");
    await fx.features.enqueue("headless");
    const devBefore = fx.originDev();

    const res = await fx.features.mergeHead();
    assert.equal(res.merged, true, "with no panel the fallback merges directly");
    assert.equal(res.outcome, "merged");
    assert.equal(fx.originDev(), res.mergeSha);
    assert.notEqual(fx.originDev(), devBefore);
    assert.equal(fx.forge.prs[0]!.state, "MERGED", "through the PR, like every other merge");
    assert.ok(!fs.existsSync(a.feature.worktreePath), "teardown followed the merge");
    assert.ok(branchExists(fx.repo, "co/feat-headless"), "and kept the branch ref");
  } finally {
    await fx.cleanup();
  }
});

test("headDetail feeds the panel the ready head's PR, commits and build+test evidence", async () => {
  const fx = await makeFixture();
  try {
    const a = await fx.features.create("detailed");
    await commitIn(a.feature.worktreePath, "d.txt", "detail\n", "job: detail");
    await fx.features.enqueue("detailed");

    const ready = fx.features.headDetail();
    assert.equal(ready?.kind, "ready");
    if (ready?.kind !== "ready") return;
    assert.equal(ready.feature, "detailed");
    assert.equal(ready.target, "dev");
    assert.equal(ready.commits.length, 1);
    assert.match(ready.commits[0] ?? "", /job: detail/);
    assert.equal(ready.pr?.number, 1, "the PR the [m] would merge");
    assert.match(ready.pr?.url ?? "", /\/pull\/1$/);
    assert.match(ready.pr?.body ?? "", /Build \+ test/, "with the evidence co composed");
    assert.match(ready.pr?.body ?? "", /job: detail/, "and the commit list");
    assert.equal(ready.buildTest?.command, "true", "the build+test that passed is named");
    assert.ok((ready.buildTest?.ms ?? -1) >= 0, "and timed");
  } finally {
    await fx.cleanup();
  }
});

test("feature_land refuses a feature that is in the merge queue (it must land via the head)", async () => {
  const seen: LandingReview[] = [];
  const fx = await makeFixture(approvingHost(seen));
  try {
    const a = await fx.features.create("queued-one");
    await commitIn(a.feature.worktreePath, "q.txt", "q\n", "job: q");
    await fx.features.enqueue("queued-one");

    const res = await fx.features.land("queued-one");
    assert.equal(res.outcome, "rejected");
    assert.match(res.error ?? "", /enqueued/);
    assert.equal(seen.length, 0, "the direct-land gate never opened for a queued feature");
    assert.ok(branchExists(fx.repo, "co/feat-queued-one"), "nothing was landed");
  } finally {
    await fx.cleanup();
  }
});

test("abandoning the head removes it from the queue and advances to the next", async () => {
  const fx = await makeFixture();
  try {
    const a = await fx.features.create("drop-me");
    const b = await fx.features.create("keep-me");
    await commitIn(a.feature.worktreePath, "a.txt", "a\n", "job: a");
    await commitIn(b.feature.worktreePath, "b.txt", "b\n", "job: b");
    await fx.features.enqueue("drop-me");
    await fx.features.enqueue("keep-me");
    assert.equal(fx.features.queueView().head?.feature, "drop-me");

    const res = await fx.features.abandon("drop-me");
    assert.equal(res.abandoned, true);

    const q = fx.features.queueView();
    assert.equal(q.size, 1);
    assert.equal(q.head?.feature, "keep-me");
    assert.equal(q.head?.status, "ready", "the new head was processed on advance");
  } finally {
    await fx.cleanup();
  }
});

test("a real rebase conflict blocks the head and the panel merge refuses to land it", async () => {
  const seen: LandingReview[] = [];
  const fx = await makeFixture(approvingHost(seen));
  try {
    const a = await fx.features.create("left");
    const b = await fx.features.create("right");
    await commitIn(a.feature.worktreePath, "file.txt", "from left\n", "job: left");
    await commitIn(b.feature.worktreePath, "file.txt", "from right\n", "job: right");

    // Land left first so dev holds the conflicting change.
    await fx.features.enqueue("left");
    assert.equal((await fx.features.mergeReadyHead()).merged, true);

    // Enqueue right: rebasing its file.txt edit onto the left-updated dev conflicts.
    const eb = await fx.features.enqueue("right");
    assert.equal(eb.enqueued, true);
    if (!eb.enqueued) return;
    assert.equal(eb.head?.feature, "right");
    assert.equal(eb.head?.status, "blocked");
    assert.match(eb.head?.blockedReason ?? "", /conflict/);

    // The blocked head holds the queue; the merge refuses and writes nothing.
    const devBefore = fx.originDev();
    const mr = await fx.features.mergeReadyHead();
    assert.equal(mr.merged, false);
    assert.equal(mr.outcome, "not-ready");
    assert.equal(fx.originDev(), devBefore, "a blocked head merges nothing");
    assert.equal(fx.forge.prFor("co/feat-right"), undefined, "a conflicted head never opened a PR");
    assert.ok(branchExists(fx.repo, "co/feat-right"), "right's branch is intact for a fix");
    // The aborted rebase left right's worktree clean and on its branch.
    assert.equal(run(b.feature.worktreePath, ["status", "--porcelain"]), "");
    assert.equal(run(b.feature.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]), "co/feat-right");
  } finally {
    await fx.cleanup();
  }
});

test("the resolve path: a conflict-blocked head is fixed by a fresh agent in its worktree, re-processes to ready, then merges", async () => {
  const seen: LandingReview[] = [];
  const fx = await makeFixture(approvingHost(seen));
  try {
    const a = await fx.features.create("base");
    const b = await fx.features.create("follow");
    await commitIn(a.feature.worktreePath, "file.txt", "from base\n", "job: base");
    await commitIn(b.feature.worktreePath, "file.txt", "from follow\n", "job: follow");

    // Land base so dev holds the conflicting change, then enqueue follow (blocks).
    await fx.features.enqueue("base");
    assert.equal((await fx.features.mergeReadyHead()).merged, true);
    const eb = await fx.features.enqueue("follow");
    assert.equal(eb.enqueued, true);
    if (!eb.enqueued) return;
    assert.equal(eb.head?.status, "blocked");
    assert.equal(eb.head?.blockedKind, "conflict", "distinguished as a conflict, not a red build");

    // Plan the resolve: it must target follow's OWN branch, never dev.
    const plan = fx.features.planResolveHead();
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.feature, "follow");
    assert.equal(plan.kind, "conflict");
    assert.equal(plan.attempt, 1);
    assert.match(plan.order, /co\/feat-follow/, "the order names the feature branch");
    assert.match(plan.order, /NEVER check out, merge into, or push/i, "the order forbids touching dev");
    assert.match(plan.order, /do not push the branch/i, "the order forbids pushing or PR'ing");
    assert.match(plan.order, /git rebase origin\/dev/, "and names the remote-tracking base");

    // Fire (the confirm-gated dispatch would have launched); mark it resolving.
    const started = fx.features.beginResolveHead();
    assert.equal(started.started, true);
    assert.equal(fx.features.isResolvingHead("follow"), true);
    assert.equal(fx.features.queueView().head?.status, "resolving");

    // Simulate the fresh agent's work IN follow's worktree: rebase onto dev and
    // resolve the conflict (keep both intents), commit — never touching dev.
    const wt = b.feature.worktreePath;
    const devBefore = fx.originDev();
    // A rebase onto origin/dev conflicts; the agent resolves file.txt and continues.
    const reb = spawnSync("git", ["rebase", "origin/dev"], { cwd: wt, encoding: "utf8" });
    assert.notEqual(reb.status, 0, "the rebase really conflicts (as the block reported)");
    await fsp.writeFile(path.join(wt, "file.txt"), "from base\nfrom follow\n", "utf8");
    run(wt, ["add", "file.txt"]);
    const cont = spawnSync("git", ["rebase", "--continue"], {
      cwd: wt,
      encoding: "utf8",
      env: { ...process.env, GIT_EDITOR: "true" },
    });
    assert.equal(cont.status, 0, "the agent completed the rebase");
    assert.equal(run(wt, ["status", "--porcelain"]), "", "the agent left the worktree clean");
    assert.equal(fx.originDev(), devBefore, "the agent never moved dev");
    assert.deepEqual(fx.forge.pushes.filter((p) => p.startsWith("co/feat-follow")), [],
      "and never pushed its branch: publishing is the queue's job");

    // The agent finished: re-process the head. It rebases cleanly now and the
    // build+test (`true`) is green, so it goes ready.
    const done = await fx.features.onResolveDone("follow");
    assert.equal(done.head?.feature, "follow");
    assert.equal(done.head?.status, "ready", "the resolved head is ready to merge");

    // And it merges from the panel like any ready head; dev advances.
    const merge = await fx.features.mergeReadyHead();
    assert.equal(merge.merged, true);
    assert.equal(merge.feature, "follow");
    assert.notEqual(fx.originDev(), devBefore, "origin/dev advanced on the merge");
    assert.equal(run(fx.repo, ["show", `${fx.originDev()}:file.txt`]), "from base\nfrom follow");
    assert.ok(!fs.existsSync(wt), "teardown followed the merge");
    assert.ok(branchExists(fx.repo, "co/feat-follow"), "and kept the branch ref");
  } finally {
    await fx.cleanup();
  }
});

test("planResolveHead refuses when the head is not blocked by a fixable conflict/red", async () => {
  const fx = await makeFixture();
  try {
    // A ready head has nothing for a resolver to do.
    const a = await fx.features.create("ready-feat");
    await commitIn(a.feature.worktreePath, "a.txt", "a\n", "job: a");
    await fx.features.enqueue("ready-feat");
    assert.equal(fx.features.queueView().head?.status, "ready");
    const plan = fx.features.planResolveHead();
    assert.equal(plan.ok, false, "a ready head can't be resolved");

    // An empty queue likewise.
    await fx.features.abandon("ready-feat");
    assert.equal(fx.features.planResolveHead().ok, false);
  } finally {
    await fx.cleanup();
  }
});

test("feature_list and feature_status surface queue position and head state", async () => {
  const fx = await makeFixture();
  try {
    const a = await fx.features.create("head-feat");
    const b = await fx.features.create("tail-feat");
    await commitIn(a.feature.worktreePath, "a.txt", "a\n", "job: a");
    await commitIn(b.feature.worktreePath, "b.txt", "b\n", "job: b");
    await fx.features.enqueue("head-feat");
    await fx.features.enqueue("tail-feat");

    const list = fx.features.list();
    const head = list.find((f) => f.slug === "head-feat")!;
    const tail = list.find((f) => f.slug === "tail-feat")!;
    assert.equal(head.queue?.position, 1);
    assert.equal(head.queue?.isHead, true);
    assert.equal(head.queue?.status, "ready");
    assert.equal(tail.queue?.position, 2);
    assert.equal(tail.queue?.isHead, false);
    assert.equal(tail.queue?.status, "queued");

    const status = await fx.features.status("tail-feat");
    assert.equal(status?.queue?.position, 2);
    assert.equal(status?.queue?.status, "queued");

    // A feature that was never enqueued carries no queue field.
    await fx.features.create("solo-feat");
    const solo = await fx.features.status("solo-feat");
    assert.equal(solo?.queue, undefined);
  } finally {
    await fx.cleanup();
  }
});
