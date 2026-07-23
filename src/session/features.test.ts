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

/**
 * Tests for the co-facing feature levers (features.ts), against real throwaway
 * git repos — the levers are thin wrappers over git plumbing, so the subject is
 * what git ends up doing. The DispatchRegistry is real but built with
 * ghosttyAvailable: false (no panes needed here; the feature-scoped DISPATCH cwd
 * is proved in registry.test.ts) and a stub installHook so the suite never
 * mutates the developer's ~/.claude. The landing gate is a scripted host, the
 * same stand-in landinggate.test.ts uses for the human's [m]/[r] keystroke.
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
    ...(gateHost ? { gateHost } : {}),
    buildTestCommand: "true",
  });
  return {
    repo,
    base: defaultWorktreeBase(repo),
    registry,
    features,
    cleanup: async () => {
      registry.stop();
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

test("feature_create provisions a worktree off dev and registers the record; a second create is idempotent", async () => {
  const fx = await makeFixture();
  try {
    const res = await fx.features.create("User Auth", "add login");
    assert.equal(res.created, true);
    assert.equal(res.feature.slug, "user-auth");
    assert.equal(res.feature.branch, "co/feat-user-auth");
    assert.equal(res.feature.provisionStatus, "ready");
    assert.equal(res.feature.intent, "add login");
    // A real worktree exists on the feature branch, cut from dev; main is untouched.
    assert.ok(fs.existsSync(res.feature.worktreePath));
    assert.equal(run(res.feature.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]), "co/feat-user-auth");
    assert.ok(branchExists(fx.repo, "dev"), "dev was created off main");
    assert.equal(run(fx.repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
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
    assert.match(res.teardown?.branchKeptReason ?? "", /not merged into 'dev'/);
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
    // The gate saw the real prepare; dev moved to the merge; teardown followed.
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.feature, "ship-it");
    assert.equal(run(fx.repo, ["rev-parse", "dev"]), res.merged.mergeSha);
    assert.ok(!branchExists(fx.repo, created.feature.branch), "the branch is torn down after the merge");
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
    const devBefore = run(fx.repo, ["rev-parse", "dev"]);

    const res = await fx.features.land("keep-me");
    assert.equal(res.outcome, "rejected");
    assert.equal(res.prepared, "green");
    assert.equal(run(fx.repo, ["rev-parse", "dev"]), devBefore, "rejection wrote nothing");
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
    const rec = await provisionWorktree({ repoPath: fx.repo }, "survivor");
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
    const rec = await provisionWorktree({ repoPath: fx.repo }, "orphan");
    await commitIn(rec.worktreePath, "w.txt", "unmerged\n", "job: unmerged work");
    // Remove just the worktree, leaving the branch with unmerged commits.
    run(fx.repo, ["worktree", "remove", "--force", rec.worktreePath]);

    const report = await reconcileFeatures({ repoPath: fx.repo });
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

test("reconcileFeatures flags a merged branch with no worktree as half-landed", async () => {
  const fx = await makeFixture();
  try {
    // A fresh feature branch equals dev (no divergence): fully contained in dev.
    const rec = await provisionWorktree({ repoPath: fx.repo }, "halfway");
    run(fx.repo, ["worktree", "remove", "--force", rec.worktreePath]);

    const report = await reconcileFeatures({ repoPath: fx.repo });
    assert.equal(report.records.length, 0);
    assert.equal(report.anomalies.length, 1);
    assert.equal(report.anomalies[0]!.kind, "half-landed");
    assert.equal(report.anomalies[0]!.ref, featureBranch("halfway"));
    assert.ok(branchExists(fx.repo, rec.branch), "still not destroyed");
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

    const report = await reconcileFeatures({ repoPath: fx.repo });
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
    const live = await provisionWorktree({ repoPath: fx.repo }, "alive");
    const gone = await provisionWorktree({ repoPath: fx.repo }, "gone");
    await commitIn(gone.worktreePath, "g.txt", "x\n", "job: work");
    run(fx.repo, ["worktree", "remove", "--force", gone.worktreePath]);

    const report = await reconcileFeatures({ repoPath: fx.repo });
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

test("merge queue: enqueue two, head processes to ready, [m] merges and the second advances onto the NEW dev", async () => {
  const seen: LandingReview[] = [];
  const fx = await makeFixture(approvingHost(seen));
  try {
    const a = await fx.features.create("alpha");
    const b = await fx.features.create("beta");
    await commitIn(a.feature.worktreePath, "a.txt", "a\n", "job: alpha");
    await commitIn(b.feature.worktreePath, "b.txt", "b\n", "job: beta");
    const devStart = run(fx.repo, ["rev-parse", "dev"]);

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
    assert.equal(run(fx.repo, ["rev-parse", "dev"]), devStart, "dev has not moved yet");

    // Merge the head (alpha) through the gate -> [m].
    const m1 = await fx.features.mergeHead();
    assert.equal(m1.merged, true);
    assert.equal(m1.feature, "alpha");
    const devAfterA = run(fx.repo, ["rev-parse", "dev"]);
    assert.equal(devAfterA, m1.mergeSha);
    assert.notEqual(devAfterA, devStart, "dev advanced to alpha's merge");
    assert.ok(!branchExists(fx.repo, "co/feat-alpha"), "alpha's worktree/branch torn down");
    assert.equal(fx.registry.getFeature("alpha"), undefined, "alpha's record dropped");

    // The queue advanced: beta is now head and was processed AGAINST the new dev.
    assert.equal(m1.head?.feature, "beta");
    assert.equal(m1.head?.status, "ready");

    // Merge beta: it lands on top of alpha's dev, and the queue empties.
    const m2 = await fx.features.mergeHead();
    assert.equal(m2.merged, true);
    assert.equal(m2.feature, "beta");
    assert.equal(m2.head, null, "the queue is now empty");
    assert.equal(fx.features.queueView().size, 0);
    const devAfterB = run(fx.repo, ["rev-parse", "dev"]);
    assert.equal(devAfterB, m2.mergeSha);
    assert.equal(run(fx.repo, ["rev-parse", "dev^1"]), devAfterA, "beta merged on top of alpha's dev");
    // Both features' work is on dev, as two serial merge commits; main untouched.
    assert.equal(run(fx.repo, ["show", "dev:a.txt"]), "a");
    assert.equal(run(fx.repo, ["show", "dev:b.txt"]), "b");
    assert.equal(run(fx.repo, ["rev-list", "--merges", "--count", "dev"]), "2");
    assert.equal(run(fx.repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
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

test("a real rebase conflict blocks the head and mergeHead refuses to land it", async () => {
  const seen: LandingReview[] = [];
  const fx = await makeFixture(approvingHost(seen));
  try {
    const a = await fx.features.create("left");
    const b = await fx.features.create("right");
    await commitIn(a.feature.worktreePath, "file.txt", "from left\n", "job: left");
    await commitIn(b.feature.worktreePath, "file.txt", "from right\n", "job: right");

    // Land left first so dev holds the conflicting change.
    await fx.features.enqueue("left");
    assert.equal((await fx.features.mergeHead()).merged, true);

    // Enqueue right: rebasing its file.txt edit onto the left-updated dev conflicts.
    const eb = await fx.features.enqueue("right");
    assert.equal(eb.enqueued, true);
    if (!eb.enqueued) return;
    assert.equal(eb.head?.feature, "right");
    assert.equal(eb.head?.status, "blocked");
    assert.match(eb.head?.blockedReason ?? "", /conflict/);

    // The blocked head holds the queue; mergeHead refuses and writes nothing.
    const devBefore = run(fx.repo, ["rev-parse", "dev"]);
    const mr = await fx.features.mergeHead();
    assert.equal(mr.merged, false);
    assert.equal(mr.outcome, "not-ready");
    assert.equal(run(fx.repo, ["rev-parse", "dev"]), devBefore, "a blocked head merges nothing");
    assert.ok(branchExists(fx.repo, "co/feat-right"), "right's branch is intact for a fix");
    // The aborted rebase left right's worktree clean and on its branch.
    assert.equal(run(b.feature.worktreePath, ["status", "--porcelain"]), "");
    assert.equal(run(b.feature.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]), "co/feat-right");
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
