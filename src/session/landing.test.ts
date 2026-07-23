import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_BUILD_TEST_COMMAND,
  executeLanding,
  prepareLanding,
  type PrepareGreen,
} from "./landing.js";
import { provisionWorktree } from "./worktrees.js";

/**
 * Tests for the landing engine, against real throwaway git repos (the engine
 * IS git plumbing; faking git would prove nothing) with an injected fake
 * build+test — a tiny sh command, never the real suite, so nothing recurses
 * into a full typecheck+test run from inside a unit test.
 *
 * Every test asserts the two hard invariants alongside its subject: `main` is
 * never moved, and a prepare in any outcome leaves `dev` byte-identical.
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
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "co-landing-")));
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

async function commitIn(worktree: string, file: string, content: string, msg: string): Promise<void> {
  await fsp.writeFile(path.join(worktree, file), content, "utf8");
  run(worktree, ["add", file]);
  run(worktree, ["commit", "-qm", msg]);
}

/** Prepare with a green fake and assert it came back green. */
async function prepareGreen(
  opts: { repoPath: string; baseDir: string },
  feature: string,
  buildTestCommand = "true",
): Promise<PrepareGreen> {
  const res = await prepareLanding({ ...opts, buildTestCommand }, feature);
  assert.equal(res.kind, "green", `expected green, got ${JSON.stringify(res)}`);
  return res as PrepareGreen;
}

test("the default build+test is the repo's own typecheck + test scripts", () => {
  assert.equal(DEFAULT_BUILD_TEST_COMMAND, "npm run typecheck && npm test");
});

test("prepareLanding rebases onto the current dev tip and returns green with the diff, never touching dev", async () => {
  const { repo, base, cleanup } = await makeRepo();
  try {
    const rec = await provisionWorktree({ repoPath: repo, baseDir: base }, "alpha");
    await commitIn(rec.worktreePath, "alpha.txt", "alpha work\n", "job: alpha work");
    const devBefore = sha(repo, "dev");
    const mainBefore = sha(repo, "main");

    const res = await prepareGreen({ repoPath: repo, baseDir: base }, "alpha");
    assert.equal(res.branch, "co/feat-alpha");
    assert.equal(res.devSha, devBefore);
    assert.equal(res.featureSha, sha(repo, res.branch), "featureSha is the branch tip");
    assert.match(res.diff, /\+alpha work/);
    assert.equal(res.commits.length, 1);
    assert.match(res.commits[0] ?? "", /job: alpha work$/);

    // Non-destructive: dev and main are byte-identical to before.
    assert.equal(sha(repo, "dev"), devBefore);
    assert.equal(sha(repo, "main"), mainBefore);
    // The branch really sits on dev's tip now.
    assert.equal(run(repo, ["merge-base", "dev", res.branch]), devBefore);
  } finally {
    await cleanup();
  }
});

test("executeLanding lands a --no-ff merge commit preserving per-job commits, then tears down", async () => {
  const { repo, base, cleanup } = await makeRepo();
  try {
    const rec = await provisionWorktree({ repoPath: repo, baseDir: base }, "feat");
    await commitIn(rec.worktreePath, "one.txt", "1\n", "job: first slice");
    await commitIn(rec.worktreePath, "two.txt", "2\n", "job: second slice");
    const mainBefore = sha(repo, "main");

    const green = await prepareGreen({ repoPath: repo, baseDir: base }, "feat");
    const landed = await executeLanding({ repoPath: repo, baseDir: base }, "feat", {
      featureSha: green.featureSha,
    });

    // A true merge commit at dev's tip: first parent the old dev, second the
    // feature tip — exactly what `git merge --no-ff` would have minted.
    assert.equal(sha(repo, "dev"), landed.mergeSha);
    assert.equal(sha(repo, "dev^1"), landed.previousDevSha);
    assert.equal(sha(repo, "dev^2"), green.featureSha);
    assert.equal(run(repo, ["log", "-1", "--format=%s", "dev"]), "Merge branch 'co/feat-feat' into dev");
    // The per-job atomic commits survive, un-squashed, reachable from dev.
    const subjects = run(repo, ["log", "--format=%s", "dev"]);
    assert.match(subjects, /job: first slice/);
    assert.match(subjects, /job: second slice/);
    // The landed tree holds the work.
    assert.equal(run(repo, ["show", "dev:one.txt"]), "1");
    assert.equal(run(repo, ["show", "dev:two.txt"]), "2");

    // Teardown ran: worktree and branch are gone.
    assert.equal(landed.teardown.worktreeRemoved, true);
    assert.equal(landed.teardown.branchDeleted, true);
    assert.ok(!fs.existsSync(rec.worktreePath));
    assert.ok(!branchExists(repo, rec.branch));

    assert.equal(sha(repo, "main"), mainBefore, "main is never written");
  } finally {
    await cleanup();
  }
});

test("serial landing: B rebases onto the A-updated dev, build+test sees the combined state, two merge commits result", async () => {
  const { repo, base, cleanup } = await makeRepo();
  try {
    // Both features cut from the same dev tip, before either lands.
    const a = await provisionWorktree({ repoPath: repo, baseDir: base }, "aaa");
    const b = await provisionWorktree({ repoPath: repo, baseDir: base }, "bbb");
    await commitIn(a.worktreePath, "a.txt", "from a\n", "job: a work");
    await commitIn(b.worktreePath, "b.txt", "from b\n", "job: b work");
    const mainBefore = sha(repo, "main");

    const greenA = await prepareGreen({ repoPath: repo, baseDir: base }, "aaa");
    const landedA = await executeLanding({ repoPath: repo, baseDir: base }, "aaa", {
      featureSha: greenA.featureSha,
    });

    // B's prepare must rebase onto the dev A just moved — and its build+test
    // runs on the COMBINED state: this fake only passes if A's file is present
    // in B's worktree alongside B's own.
    const greenB = await prepareGreen(
      { repoPath: repo, baseDir: base },
      "bbb",
      "test -f a.txt && test -f b.txt",
    );
    assert.equal(greenB.devSha, landedA.mergeSha, "B was rebased onto the A-updated dev tip");
    const landedB = await executeLanding({ repoPath: repo, baseDir: base }, "bbb", {
      featureSha: greenB.featureSha,
    });

    // Two distinct merge commits, in order, and both features' work in dev.
    assert.equal(run(repo, ["rev-list", "--merges", "--count", "dev"]), "2");
    assert.equal(sha(repo, "dev"), landedB.mergeSha);
    assert.equal(sha(repo, "dev^1"), landedA.mergeSha);
    assert.equal(run(repo, ["show", "dev:a.txt"]), "from a");
    assert.equal(run(repo, ["show", "dev:b.txt"]), "from b");
    assert.equal(sha(repo, "main"), mainBefore);
  } finally {
    await cleanup();
  }
});

test("two features touching the same line: the second reports conflict and nothing moves", async () => {
  const { repo, base, cleanup } = await makeRepo();
  try {
    const a = await provisionWorktree({ repoPath: repo, baseDir: base }, "left");
    const b = await provisionWorktree({ repoPath: repo, baseDir: base }, "right");
    await commitIn(a.worktreePath, "file.txt", "from left\n", "job: left edit");
    await commitIn(b.worktreePath, "file.txt", "from right\n", "job: right edit");

    const greenA = await prepareGreen({ repoPath: repo, baseDir: base }, "left");
    await executeLanding({ repoPath: repo, baseDir: base }, "left", { featureSha: greenA.featureSha });

    const devBefore = sha(repo, "dev");
    const bBefore = sha(repo, b.branch);
    const res = await prepareLanding({ repoPath: repo, baseDir: base, buildTestCommand: "true" }, "right");
    assert.equal(res.kind, "conflict");
    if (res.kind !== "conflict") return;
    assert.deepEqual(res.conflictFiles, ["file.txt"]);
    assert.ok(res.detail.length > 0, "the conflict carries git's account of the failing step");

    // The abort restored everything: dev byte-identical, B's branch untouched,
    // B's worktree clean with no rebase in progress.
    assert.equal(sha(repo, "dev"), devBefore);
    assert.equal(sha(repo, b.branch), bBefore);
    assert.equal(run(b.worktreePath, ["status", "--porcelain"]), "");
    assert.equal(run(b.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]), b.branch);
  } finally {
    await cleanup();
  }
});

test("a red build+test returns failed with the output, leaving dev untouched and the work intact", async () => {
  const { repo, base, cleanup } = await makeRepo();
  try {
    const rec = await provisionWorktree({ repoPath: repo, baseDir: base }, "redone");
    await commitIn(rec.worktreePath, "red.txt", "red\n", "job: red work");
    const devBefore = sha(repo, "dev");

    const res = await prepareLanding(
      { repoPath: repo, baseDir: base, buildTestCommand: "echo boom went the suite >&2; exit 3" },
      "redone",
    );
    assert.equal(res.kind, "failed");
    if (res.kind !== "failed") return;
    assert.equal(res.exitCode, 3);
    assert.match(res.output, /boom went the suite/);
    assert.equal(res.devSha, devBefore);

    // dev untouched; the branch is left REBASED but holds all the work, and
    // the worktree is clean — the exact red state, ready for a fix dispatch.
    assert.equal(sha(repo, "dev"), devBefore);
    assert.ok(branchExists(repo, rec.branch));
    assert.equal(res.featureSha, sha(repo, rec.branch));
    assert.match(run(repo, ["log", "--format=%s", rec.branch]), /job: red work/);
    assert.equal(run(rec.worktreePath, ["status", "--porcelain"]), "");
  } finally {
    await cleanup();
  }
});

test("executeLanding refuses a stale green (dev moved since prepare) until a fresh prepare", async () => {
  const { repo, base, cleanup } = await makeRepo();
  try {
    const a = await provisionWorktree({ repoPath: repo, baseDir: base }, "first");
    const b = await provisionWorktree({ repoPath: repo, baseDir: base }, "second");
    await commitIn(a.worktreePath, "a.txt", "a\n", "job: a");
    await commitIn(b.worktreePath, "b.txt", "b\n", "job: b");

    // B goes green against the ORIGINAL dev tip; then A lands, moving dev.
    const staleGreenB = await prepareGreen({ repoPath: repo, baseDir: base }, "second");
    const greenA = await prepareGreen({ repoPath: repo, baseDir: base }, "first");
    await executeLanding({ repoPath: repo, baseDir: base }, "first", { featureSha: greenA.featureSha });

    // A green + B green does not make A+B green: B's combined state was never
    // tested, so the stale green must not merge.
    const devAfterA = sha(repo, "dev");
    await assert.rejects(
      executeLanding({ repoPath: repo, baseDir: base }, "second", {
        featureSha: staleGreenB.featureSha,
      }),
      /not rebased onto the current 'dev' tip/,
    );
    assert.equal(sha(repo, "dev"), devAfterA, "the refusal wrote nothing");
    assert.ok(branchExists(repo, b.branch));
    assert.ok(fs.existsSync(b.worktreePath));

    // A fresh prepare re-proves B against dev-as-it-is-now, and then it lands.
    const freshGreenB = await prepareGreen({ repoPath: repo, baseDir: base }, "second");
    assert.equal(freshGreenB.devSha, devAfterA);
    const landedB = await executeLanding({ repoPath: repo, baseDir: base }, "second", {
      featureSha: freshGreenB.featureSha,
    });
    assert.equal(sha(repo, "dev"), landedB.mergeSha);
  } finally {
    await cleanup();
  }
});

test("executeLanding refuses when the branch grew commits after the prepare it was pinned to", async () => {
  const { repo, base, cleanup } = await makeRepo();
  try {
    const rec = await provisionWorktree({ repoPath: repo, baseDir: base }, "moving");
    await commitIn(rec.worktreePath, "m.txt", "m\n", "job: m");
    const green = await prepareGreen({ repoPath: repo, baseDir: base }, "moving");
    // The crew slipped in another commit after the green.
    await commitIn(rec.worktreePath, "late.txt", "late\n", "job: untested late work");

    const devBefore = sha(repo, "dev");
    await assert.rejects(
      executeLanding({ repoPath: repo, baseDir: base }, "moving", { featureSha: green.featureSha }),
      /moved since prepare/,
    );
    assert.equal(sha(repo, "dev"), devBefore);
    assert.ok(branchExists(repo, rec.branch));
  } finally {
    await cleanup();
  }
});

test("a feature with no commits beyond dev: prepare is green-and-empty, execute refuses to mint an empty merge", async () => {
  const { repo, base, cleanup } = await makeRepo();
  try {
    await provisionWorktree({ repoPath: repo, baseDir: base }, "empty");
    const res = await prepareGreen({ repoPath: repo, baseDir: base }, "empty");
    assert.deepEqual(res.commits, []);
    assert.equal(res.diff, "");
    await assert.rejects(
      executeLanding({ repoPath: repo, baseDir: base }, "empty"),
      /nothing to land/,
    );
  } finally {
    await cleanup();
  }
});

test("prepareLanding throws on a dirty worktree and on a feature with no worktree, changing nothing", async () => {
  const { repo, base, cleanup } = await makeRepo();
  try {
    const rec = await provisionWorktree({ repoPath: repo, baseDir: base }, "dirty");
    await commitIn(rec.worktreePath, "d.txt", "d\n", "job: d");
    await fsp.writeFile(path.join(rec.worktreePath, "wip.txt"), "not committed\n", "utf8");
    const devBefore = sha(repo, "dev");
    const branchBefore = sha(repo, rec.branch);

    await assert.rejects(
      prepareLanding({ repoPath: repo, baseDir: base, buildTestCommand: "true" }, "dirty"),
      /uncommitted changes/,
    );
    assert.equal(sha(repo, "dev"), devBefore);
    assert.equal(sha(repo, rec.branch), branchBefore);
    assert.ok(fs.existsSync(path.join(rec.worktreePath, "wip.txt")), "the uncommitted work survives");

    await assert.rejects(
      prepareLanding({ repoPath: repo, baseDir: base, buildTestCommand: "true" }, "never-dispatched"),
      /no branch/,
    );
  } finally {
    await cleanup();
  }
});

test("executeLanding refuses while dev is checked out somewhere", async () => {
  const { repo, base, cleanup } = await makeRepo();
  try {
    const rec = await provisionWorktree({ repoPath: repo, baseDir: base }, "held");
    await commitIn(rec.worktreePath, "h.txt", "h\n", "job: h");
    const green = await prepareGreen({ repoPath: repo, baseDir: base }, "held");

    const devCheckout = path.join(path.dirname(base), "dev-checkout");
    run(repo, ["worktree", "add", devCheckout, "dev"]);
    try {
      const devBefore = sha(repo, "dev");
      await assert.rejects(
        executeLanding({ repoPath: repo, baseDir: base }, "held", { featureSha: green.featureSha }),
        /checked out at/,
      );
      assert.equal(sha(repo, "dev"), devBefore);
    } finally {
      run(repo, ["worktree", "remove", devCheckout]);
    }
  } finally {
    await cleanup();
  }
});
