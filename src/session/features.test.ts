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
