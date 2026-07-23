import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureDevBranch,
  featureBranch,
  featureSlug,
  provisionWorktree,
  reconcileWorktrees,
  teardownWorktree,
  defaultWorktreeBase,
} from "./worktrees.js";

/**
 * Tests for the worktree lifecycle harness, run against a real throwaway git
 * repo — the module IS git plumbing, so faking git would prove nothing. Each
 * test builds a fresh repo with a main branch, a commit, a .gitignore matching
 * the real repo's posture (node_modules/ and dist/ ignored), and fake build
 * artifacts to symlink. The managed worktree base is a sibling dir inside the
 * same tmp root, mirroring the default layout.
 *
 * The tmp root is realpath'd up front: macOS spells os.tmpdir() as /var/...
 * while git reports the /private/var/... realpath, and the module's path
 * comparisons must not be fooled by that (nor the tests').
 */

function run(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${res.status}): ${res.stderr}`);
  }
  return res.stdout.trim();
}

async function makeRepo(): Promise<{
  root: string;
  repo: string;
  base: string;
  cleanup: () => Promise<void>;
}> {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "co-worktree-")));
  const repo = path.join(root, "repo");
  const base = path.join(root, "worktrees");
  await fsp.mkdir(repo);
  run(repo, ["init", "-q", "-b", "main"]);
  run(repo, ["config", "user.email", "test@test"]);
  run(repo, ["config", "user.name", "test"]);
  run(repo, ["config", "commit.gpgsign", "false"]);
  await fsp.writeFile(path.join(repo, "file.txt"), "hello\n", "utf8");
  await fsp.writeFile(path.join(repo, ".gitignore"), "node_modules/\ndist/\n", "utf8");
  run(repo, ["add", "."]);
  run(repo, ["commit", "-q", "-m", "init"]);
  // Fake build artifacts in the primary tree, for provision to symlink.
  await fsp.mkdir(path.join(repo, "node_modules"));
  await fsp.writeFile(path.join(repo, "node_modules", "marker.txt"), "deps\n", "utf8");
  await fsp.mkdir(path.join(repo, "dist"));
  await fsp.writeFile(path.join(repo, "dist", "marker.txt"), "build\n", "utf8");
  return { root, repo, base, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

function sha(repo: string, ref: string): string {
  return run(repo, ["rev-parse", ref]);
}

function branchExists(repo: string, branch: string): boolean {
  const res = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: repo,
    encoding: "utf8",
  });
  return res.status === 0;
}

test("featureSlug normalizes names and featureBranch prefixes them", () => {
  assert.equal(featureSlug("My Fancy Feature!"), "my-fancy-feature");
  assert.equal(featureSlug("auth"), "auth");
  assert.equal(featureSlug("  spaces  and__underscores  "), "spaces-and-underscores");
  assert.equal(featureBranch("My Fancy Feature!"), "co/feat-my-fancy-feature");
  // Nothing usable survives: refuse rather than mint `co/feat-`.
  assert.throws(() => featureSlug("!!!"), /empty slug/);
});

test("defaultWorktreeBase is a sibling of the repo, outside its working tree", () => {
  assert.equal(defaultWorktreeBase("/code/app"), "/code/app-worktrees");
});

test("ensureDevBranch creates dev off main once, idempotently, without touching main", async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const mainBefore = sha(repo, "main");
    const first = await ensureDevBranch({ repoPath: repo });
    assert.equal(first.created, true);
    assert.equal(sha(repo, "dev"), mainBefore, "dev starts at main's tip");

    // Idempotent: a second call creates nothing and moves nothing — even after
    // main advances, an existing dev stays where it was.
    await fsp.writeFile(path.join(repo, "file.txt"), "more\n", "utf8");
    run(repo, ["commit", "-qam", "advance main"]);
    const second = await ensureDevBranch({ repoPath: repo });
    assert.equal(second.created, false);
    assert.equal(sha(repo, "dev"), mainBefore, "an existing dev is never moved");
    assert.equal(run(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "main", "no checkout happened");
  } finally {
    await cleanup();
  }
});

test("ensureDevBranch refuses when the base branch does not exist", async () => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "co-worktree-")));
  try {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo);
    run(repo, ["init", "-q", "-b", "main"]); // unborn main: no commit, no ref
    await assert.rejects(ensureDevBranch({ repoPath: repo }), /base branch 'main' does not exist/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("provisionWorktree cuts co/feat-<slug> from dev with build artifacts symlinked", async () => {
  const { repo, base, cleanup } = await makeRepo();
  try {
    // Make dev and main genuinely different, so "based off dev" is provable:
    // dev is created at today's main, then main advances past it.
    await ensureDevBranch({ repoPath: repo });
    await fsp.writeFile(path.join(repo, "file.txt"), "main moved on\n", "utf8");
    run(repo, ["commit", "-qam", "advance main"]);
    const mainSha = sha(repo, "main");
    const devSha = sha(repo, "dev");
    assert.notEqual(mainSha, devSha);

    const rec = await provisionWorktree({ repoPath: repo, baseDir: base }, "My Feature");
    assert.equal(rec.branch, "co/feat-my-feature");
    assert.equal(rec.worktreePath, path.join(base, "my-feature"));
    assert.equal(rec.provisionStatus, "ready");

    // A real checkout on the feature branch, at dev's tip — not main's.
    assert.ok(fs.existsSync(path.join(rec.worktreePath, "file.txt")));
    assert.equal(run(rec.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]), rec.branch);
    assert.equal(sha(rec.worktreePath, "HEAD"), devSha);

    // Buildable without an install: both artifacts are symlinks to the primary.
    for (const name of ["node_modules", "dist"]) {
      const link = path.join(rec.worktreePath, name);
      assert.ok((await fsp.lstat(link)).isSymbolicLink(), `${name} is a symlink`);
      assert.equal(await fsp.readlink(link), path.join(repo, name));
      assert.equal(await fsp.readFile(path.join(link, "marker.txt"), "utf8"), name === "dist" ? "build\n" : "deps\n");
    }

    assert.equal(sha(repo, "main"), mainSha, "main untouched");
  } finally {
    await cleanup();
  }
});

test("provisionWorktree is idempotent for a provisioned feature and rejects half-states", async () => {
  const { repo, base, cleanup } = await makeRepo();
  try {
    const first = await provisionWorktree({ repoPath: repo, baseDir: base }, "auth");
    const again = await provisionWorktree({ repoPath: repo, baseDir: base }, "auth");
    assert.deepEqual(again, first, "re-provisioning an intact feature returns the same record");

    // A leftover branch with no worktree is a half-state: refuse, point at
    // reconcile, and above all don't guess which side to destroy.
    run(repo, ["branch", "co/feat-leftover", "dev"]);
    await assert.rejects(
      provisionWorktree({ repoPath: repo, baseDir: base }, "leftover"),
      /already exists without a worktree/,
    );
    assert.ok(branchExists(repo, "co/feat-leftover"), "the refusal deleted nothing");
  } finally {
    await cleanup();
  }
});

test("a worktree base inside the repo working tree is rejected", async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    await assert.rejects(
      provisionWorktree({ repoPath: repo, baseDir: path.join(repo, "wt") }, "x"),
      /outside the repo working tree/,
    );
  } finally {
    await cleanup();
  }
});

test("teardownWorktree removes the worktree, deletes the merged branch, prunes, and tolerates a repeat", async () => {
  const { repo, base, cleanup } = await makeRepo();
  try {
    const rec = await provisionWorktree({ repoPath: repo, baseDir: base }, "done-feature");
    const result = await teardownWorktree({ repoPath: repo, baseDir: base }, "done-feature");
    assert.equal(result.worktreeRemoved, true);
    assert.equal(result.branchDeleted, true, "a branch still equal to dev is merged, hence deletable");
    assert.ok(!fs.existsSync(rec.worktreePath), "worktree dir is gone");
    assert.ok(!branchExists(repo, rec.branch), "branch is gone");
    const meta = await fsp.readdir(path.join(repo, ".git", "worktrees")).catch(() => []);
    assert.deepEqual(meta, [], "no stale worktree metadata remains");

    // Already removed: a second teardown is a quiet no-op, not an error.
    const repeat = await teardownWorktree({ repoPath: repo, baseDir: base }, "done-feature");
    assert.equal(repeat.worktreeRemoved, false);
    assert.equal(repeat.branchDeleted, false);
  } finally {
    await cleanup();
  }
});

test("teardownWorktree keeps a branch with unmerged commits and says why", async () => {
  const { repo, base, cleanup } = await makeRepo();
  try {
    const rec = await provisionWorktree({ repoPath: repo, baseDir: base }, "in-progress");
    await fsp.writeFile(path.join(rec.worktreePath, "work.txt"), "unmerged\n", "utf8");
    run(rec.worktreePath, ["add", "work.txt"]);
    run(rec.worktreePath, ["commit", "-qm", "feature work"]);

    const result = await teardownWorktree({ repoPath: repo, baseDir: base }, "in-progress");
    assert.equal(result.worktreeRemoved, true, "a clean worktree is removable even when ahead");
    assert.equal(result.branchDeleted, false);
    assert.match(result.branchKeptReason ?? "", /not merged into 'dev'/);
    assert.ok(branchExists(repo, rec.branch), "the unmerged branch survives");
  } finally {
    await cleanup();
  }
});

test("teardownWorktree refuses to destroy uncommitted work", async () => {
  const { repo, base, cleanup } = await makeRepo();
  try {
    const rec = await provisionWorktree({ repoPath: repo, baseDir: base }, "dirty");
    await fsp.writeFile(path.join(rec.worktreePath, "wip.txt"), "not committed\n", "utf8");
    await assert.rejects(teardownWorktree({ repoPath: repo, baseDir: base }, "dirty"), /worktree remove/);
    assert.ok(fs.existsSync(rec.worktreePath), "the dirty worktree is still there");
    assert.ok(branchExists(repo, rec.branch), "and so is its branch");
  } finally {
    await cleanup();
  }
});

test("reconcileWorktrees removes zombies, keeps dirty work, and never touches unrelated refs", async () => {
  const { repo, base, cleanup } = await makeRepo();
  try {
    // A clean provisioned worktree at startup IS the zombie: nothing is in
    // flight, so a crashed run must have left it.
    const zombie = await provisionWorktree({ repoPath: repo, baseDir: base }, "zombie");
    const dirty = await provisionWorktree({ repoPath: repo, baseDir: base }, "dirty-one");
    await fsp.writeFile(path.join(dirty.worktreePath, "wip.txt"), "precious\n", "utf8");
    run(repo, ["branch", "keep-me"]); // an unrelated user branch
    const mainSha = sha(repo, "main");
    const devSha = sha(repo, "dev");

    const report = await reconcileWorktrees({ repoPath: repo, baseDir: base });
    assert.deepEqual(report.removedWorktrees, [zombie.worktreePath]);
    assert.deepEqual(report.removedBranches, [zombie.branch]);
    assert.ok(!fs.existsSync(zombie.worktreePath));
    assert.ok(!branchExists(repo, zombie.branch));

    // The dirty worktree was kept with a reason, its branch untouched.
    assert.ok(report.kept.some((k) => k.ref === dirty.worktreePath && /uncommitted/.test(k.reason)));
    assert.ok(fs.existsSync(path.join(dirty.worktreePath, "wip.txt")));
    assert.ok(branchExists(repo, dirty.branch));

    // Non-co/feat-* refs are outside reconcile's world entirely.
    assert.ok(branchExists(repo, "keep-me"));
    assert.equal(sha(repo, "main"), mainSha);
    assert.equal(sha(repo, "dev"), devSha);
  } finally {
    await cleanup();
  }
});

test("reconcileWorktrees prunes metadata for a worktree whose directory was deleted", async () => {
  const { repo, base, cleanup } = await makeRepo();
  try {
    const rec = await provisionWorktree({ repoPath: repo, baseDir: base }, "gone");
    await fsp.rm(rec.worktreePath, { recursive: true, force: true }); // the crash

    const report = await reconcileWorktrees({ repoPath: repo, baseDir: base });
    assert.deepEqual(report.removedBranches, [rec.branch], "the freed branch is swept too");
    assert.ok(!branchExists(repo, rec.branch));
    const meta = await fsp.readdir(path.join(repo, ".git", "worktrees")).catch(() => []);
    assert.deepEqual(meta, [], "stale metadata pruned");
  } finally {
    await cleanup();
  }
});

test("reconcileWorktrees removes a stray dir whose registration was lost, keeps foreign dirs", async () => {
  const { repo, base, cleanup } = await makeRepo();
  try {
    const rec = await provisionWorktree({ repoPath: repo, baseDir: base }, "stray");
    // Lose the registration but not the directory — the inverse crash of the
    // test above. git no longer lists the worktree; the dir remains.
    await fsp.rm(path.join(repo, ".git", "worktrees", "stray"), { recursive: true, force: true });
    // A foreign dir in the base that is NOT one of our worktrees must survive.
    const foreign = path.join(base, "not-ours");
    await fsp.mkdir(foreign);
    await fsp.writeFile(path.join(foreign, "data.txt"), "hands off\n", "utf8");

    const report = await reconcileWorktrees({ repoPath: repo, baseDir: base });
    assert.deepEqual(report.removedStrays, [rec.worktreePath]);
    assert.ok(!fs.existsSync(rec.worktreePath));
    assert.deepEqual(report.removedBranches, [rec.branch]);
    assert.ok(fs.existsSync(path.join(foreign, "data.txt")), "foreign dir untouched");
    assert.ok(report.kept.some((k) => k.ref === foreign));
  } finally {
    await cleanup();
  }
});

test("reconcileWorktrees leaves a feature named in keep fully alone", async () => {
  const { repo, base, cleanup } = await makeRepo();
  try {
    const active = await provisionWorktree({ repoPath: repo, baseDir: base }, "active");
    const report = await reconcileWorktrees({ repoPath: repo, baseDir: base }, { keep: ["active"] });
    assert.deepEqual(report.removedWorktrees, []);
    assert.deepEqual(report.removedBranches, []);
    assert.ok(report.kept.some((k) => k.ref === active.branch && /in-flight/.test(k.reason)));
    assert.ok(fs.existsSync(active.worktreePath));
    assert.ok(branchExists(repo, active.branch));
  } finally {
    await cleanup();
  }
});
