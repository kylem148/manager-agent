import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHECKS_GRACE_MS, CHECKS_INTERVAL_MS, CHECKS_TIMEOUT_MS, type ChecksPolicy } from "./checks.js";
import {
  executeLanding,
  prepareLanding,
  type LandingOptions,
  type PrepareGreen,
} from "./landing.js";
import { provisionWorktree } from "./worktrees.js";
import { makeFakeForge, type FakeCheck, type FakeForge } from "./forgefake.test.js";

/**
 * Tests for the landing engine, against real throwaway git repos (the local half
 * IS git plumbing; faking git would prove nothing) with the REMOTE half — fetch,
 * push, and every gh call, `gh pr checks` included — served by the fake forge.
 * Nothing here reaches the network, needs the gh binary, or needs a GitHub
 * account, and co runs no build or test of its own to recurse into.
 *
 * Every test asserts the hard invariants alongside its subject:
 *  - the LOCAL `dev` ref never moves. The fixture deliberately CHECKS DEV OUT in
 *    the primary tree, which is the state that made the old local merge
 *    impossible; the whole point of the PR flow is that this is now irrelevant.
 *  - `main` is never moved.
 *  - nothing is pushed and no PR is opened when the REBASE fails; a red CI check,
 *    by contrast, necessarily has a PR — it is the PR's own checks that went red.
 */

/** No wall-clock in a unit test: the poll sleeps instantly and neither deadline
 *  gives the loop a second look unless a test asks for one. */
const FAST: ChecksPolicy = { timeoutMs: 0, graceMs: 0, intervalMs: 1, sleep: async () => {} };

const pass = (name: string, required = false): FakeCheck => ({ name, bucket: "pass", required });

function run(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${res.status}): ${res.stderr}`);
  }
  return res.stdout.trim();
}

interface Fixture {
  root: string;
  repo: string;
  base: string;
  forge: FakeForge;
  /** LandingOptions wired to this repo and the fake forge. */
  opts(checks?: ChecksPolicy): LandingOptions;
  cleanup(): Promise<void>;
}

async function makeRepo(): Promise<Fixture> {
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
  // The captain's own checkout: `dev` exists locally AND is checked out in the
  // primary tree. Nothing co does may write it.
  run(repo, ["branch", "dev", "main"]);
  run(repo, ["checkout", "-q", "dev"]);
  const forge = makeFakeForge(repo, { dev: run(repo, ["rev-parse", "dev"]) });
  return {
    root,
    repo,
    base,
    forge,
    opts: (checks = FAST) => ({
      repoPath: repo,
      baseDir: base,
      run: forge.run,
      checks,
    }),
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

function sha(repo: string, ref: string): string {
  return run(repo, ["rev-parse", ref]);
}

function branchExists(repo: string, branch: string): boolean {
  return (
    spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo })
      .status === 0
  );
}

async function commitIn(worktree: string, file: string, content: string, msg: string): Promise<void> {
  await fsp.writeFile(path.join(worktree, file), content, "utf8");
  run(worktree, ["add", file]);
  run(worktree, ["commit", "-qm", msg]);
}

/** Provision a feature worktree through the real code path (which verifies the
 *  remote and cuts from origin/dev). */
function provision(f: Fixture, feature: string): ReturnType<typeof provisionWorktree> {
  return provisionWorktree({ repoPath: f.repo, baseDir: f.base, run: f.forge.run }, feature);
}

/** Prepare and assert it came back green. */
async function prepareGreen(f: Fixture, feature: string, checks?: ChecksPolicy): Promise<PrepareGreen> {
  const res = await prepareLanding(f.opts(checks), feature);
  assert.equal(res.kind, "green", `expected green, got ${JSON.stringify(res)}`);
  return res as PrepareGreen;
}

test("the checks wait is bounded by default: a real timeout, a real interval, a real grace", () => {
  // Bounded, not infinite — a stuck workflow must leave a WAITING head, not hang
  // whoever called prepare. The numbers are policy; that they are finite is not.
  assert.ok(CHECKS_TIMEOUT_MS > 0 && Number.isFinite(CHECKS_TIMEOUT_MS));
  assert.ok(CHECKS_INTERVAL_MS > 0 && CHECKS_INTERVAL_MS < CHECKS_TIMEOUT_MS);
  assert.ok(CHECKS_GRACE_MS > 0 && CHECKS_GRACE_MS <= CHECKS_TIMEOUT_MS);
});

test("prepareLanding rebases onto origin/dev, pushes, and opens the PR — the local dev ref never moves", async () => {
  const f = await makeRepo();
  try {
    const rec = await provision(f, "alpha");
    await commitIn(rec.worktreePath, "alpha.txt", "alpha work\n", "job: alpha work");
    const localDevBefore = sha(f.repo, "dev");
    const mainBefore = sha(f.repo, "main");
    const originDevBefore = f.forge.branches.get("dev")!;

    const res = await prepareGreen(f, "alpha");
    assert.equal(res.branch, "co/feat-alpha");
    assert.equal(res.devSha, originDevBefore, "the base is the origin/dev tip");
    assert.equal(res.featureSha, sha(f.repo, res.branch), "featureSha is the branch tip");
    assert.match(res.diff, /\+alpha work/);
    assert.equal(res.commits.length, 1);
    assert.match(res.commits[0] ?? "", /job: alpha work$/);

    // Published: the rebased tip is on the remote, and a PR into dev is open.
    assert.equal(res.pushed, true);
    assert.equal(f.forge.branches.get("co/feat-alpha"), res.featureSha, "the TESTED sha was pushed");
    assert.equal(res.pr?.created, true);
    const pr = f.forge.prFor("co/feat-alpha")!;
    assert.equal(pr.base, "dev");
    assert.equal(pr.title, "job: alpha work", "a one-commit feature takes that commit's subject");
    assert.match(pr.body, /### Checks/);
    assert.match(pr.body, /job: alpha work/, "the commit list is in the PR body");
    assert.match(pr.body, /merge commit/, "the PR states how it will be merged");

    // Non-destructive locally: the captain's dev and main are byte-identical.
    assert.equal(sha(f.repo, "dev"), localDevBefore);
    assert.equal(sha(f.repo, "main"), mainBefore);
    assert.equal(f.forge.branches.get("dev"), originDevBefore, "origin/dev is untouched by a prepare");
    // The branch really sits on the origin/dev tip now.
    assert.equal(run(f.repo, ["merge-base", "origin/dev", res.branch]), originDevBefore);
  } finally {
    await f.cleanup();
  }
});

test("executeLanding merges the PR as a merge commit, keeps the branch, and removes only the worktree", async () => {
  const f = await makeRepo();
  try {
    const rec = await provision(f, "feat");
    await commitIn(rec.worktreePath, "one.txt", "1\n", "job: first slice");
    await commitIn(rec.worktreePath, "two.txt", "2\n", "job: second slice");
    const localDevBefore = sha(f.repo, "dev");
    const mainBefore = sha(f.repo, "main");

    const green = await prepareGreen(f, "feat");
    const landed = await executeLanding(f.opts(), "feat", {
      featureSha: green.featureSha,
      devSha: green.devSha,
      prNumber: green.pr!.number,
    });

    // The merge happened ON THE FORGE, with two parents: the old dev tip and
    // the tested feature tip — exactly what `--merge` mints.
    assert.equal(f.forge.branches.get("dev"), landed.mergeSha);
    assert.equal(sha(f.repo, `${landed.mergeSha}^1`), landed.previousDevSha);
    assert.equal(sha(f.repo, `${landed.mergeSha}^2`), green.featureSha);
    assert.equal(landed.pr.number, green.pr!.number);
    assert.equal(f.forge.prs[0]!.state, "MERGED");
    // gh was asked for a merge commit and nothing else.
    const mergeCall = f.forge.calls.find((c) => c.startsWith("gh pr merge"))!;
    assert.match(mergeCall, /--merge$/);
    assert.ok(!f.forge.calls.some((c) => /--squash|--rebase|--delete-branch/.test(c)));

    // The per-job atomic commits survive, un-squashed, reachable from the merge.
    const subjects = run(f.repo, ["log", "--format=%s", landed.mergeSha]);
    assert.match(subjects, /job: first slice/);
    assert.match(subjects, /job: second slice/);
    assert.equal(run(f.repo, ["show", `${landed.mergeSha}:one.txt`]), "1");
    assert.equal(run(f.repo, ["show", `${landed.mergeSha}:two.txt`]), "2");

    // Teardown: the worktree is gone, the BRANCH REF IS KEPT.
    assert.equal(landed.teardown.worktreeRemoved, true);
    assert.equal(landed.teardown.branchDeleted, false);
    assert.match(landed.teardown.branchKeptReason ?? "", /kept by policy/);
    assert.ok(!fs.existsSync(rec.worktreePath));
    assert.ok(branchExists(f.repo, rec.branch), "the branch ref outlives the worktree");

    // co wrote nothing local: dev is where the captain left it, main untouched.
    assert.equal(sha(f.repo, "dev"), localDevBefore, "the local dev ref is never written");
    assert.equal(sha(f.repo, "main"), mainBefore);
    assert.equal(sha(f.repo, "origin/dev"), landed.mergeSha, "co learned of the merge by fetching");
  } finally {
    await f.cleanup();
  }
});

test("serial landing: B rebases onto the A-updated origin/dev, so its checks run on the combined state", async () => {
  const f = await makeRepo();
  try {
    // Both features cut from the same origin/dev tip, before either lands.
    const a = await provision(f, "aaa");
    const b = await provision(f, "bbb");
    await commitIn(a.worktreePath, "a.txt", "from a\n", "job: a work");
    await commitIn(b.worktreePath, "b.txt", "from b\n", "job: b work");
    const localDevBefore = sha(f.repo, "dev");

    const greenA = await prepareGreen(f, "aaa");
    const landedA = await executeLanding(f.opts(), "aaa", {
      featureSha: greenA.featureSha,
      devSha: greenA.devSha,
    });

    // B's prepare must rebase onto the origin/dev A just moved, so the tree its
    // PR's checks run against holds BOTH features — the combined state. co runs
    // nothing itself; what it owes is that rebase, so that is what is asserted.
    const greenB = await prepareGreen(f, "bbb");
    assert.equal(greenB.devSha, landedA.mergeSha, "B was rebased onto the A-updated tip");
    assert.equal(run(b.worktreePath, ["cat-file", "-e", `${greenB.featureSha}:a.txt`]), "");
    assert.equal(run(b.worktreePath, ["cat-file", "-e", `${greenB.featureSha}:b.txt`]), "");
    const landedB = await executeLanding(f.opts(), "bbb", {
      featureSha: greenB.featureSha,
      devSha: greenB.devSha,
    });

    // Two distinct merge commits, in order, and both features' work in dev.
    assert.equal(run(f.repo, ["rev-list", "--merges", "--count", landedB.mergeSha]), "2");
    assert.equal(f.forge.branches.get("dev"), landedB.mergeSha);
    assert.equal(sha(f.repo, `${landedB.mergeSha}^1`), landedA.mergeSha);
    assert.equal(run(f.repo, ["show", `${landedB.mergeSha}:a.txt`]), "from a");
    assert.equal(run(f.repo, ["show", `${landedB.mergeSha}:b.txt`]), "from b");
    assert.equal(sha(f.repo, "dev"), localDevBefore);
    assert.equal(f.forge.prs.length, 2, "one PR per feature");
  } finally {
    await f.cleanup();
  }
});

test("two features touching the same line: the second reports conflict, pushes nothing and opens no PR", async () => {
  const f = await makeRepo();
  try {
    const a = await provision(f, "left");
    const b = await provision(f, "right");
    await commitIn(a.worktreePath, "file.txt", "from left\n", "job: left edit");
    await commitIn(b.worktreePath, "file.txt", "from right\n", "job: right edit");

    const greenA = await prepareGreen(f, "left");
    await executeLanding(f.opts(), "left", { featureSha: greenA.featureSha, devSha: greenA.devSha });

    const originDev = f.forge.branches.get("dev")!;
    const bBefore = sha(f.repo, b.branch);
    const pushesBefore = f.forge.pushes.length;
    const res = await prepareLanding(f.opts(), "right");
    assert.equal(res.kind, "conflict");
    if (res.kind !== "conflict") return;
    assert.deepEqual(res.conflictFiles, ["file.txt"]);
    assert.ok(res.detail.length > 0, "the conflict carries git's account of the failing step");

    // The abort restored everything, and nothing reached the forge.
    assert.equal(f.forge.branches.get("dev"), originDev);
    assert.equal(sha(f.repo, b.branch), bBefore);
    assert.equal(run(b.worktreePath, ["status", "--porcelain"]), "");
    assert.equal(run(b.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]), b.branch);
    assert.equal(f.forge.pushes.length, pushesBefore, "a conflict pushes nothing");
    assert.equal(f.forge.prFor(b.branch), undefined, "and opens no PR");
  } finally {
    await f.cleanup();
  }
});

test("a red CI check returns failed, names what went red, and leaves the work intact", async () => {
  const f = await makeRepo();
  try {
    const rec = await provision(f, "redone");
    await commitIn(rec.worktreePath, "red.txt", "red\n", "job: red work");
    const originDev = f.forge.branches.get("dev")!;
    // The PR does not exist yet, so seed the checks by branch: the fake keys them
    // on the PR number, which is 1 for the first PR this repo opens.
    f.forge.checks.set(1, [
      pass("lint"),
      { name: "test (ubuntu)", bucket: "fail", link: "https://github.com/acme/repo/runs/9" },
    ]);

    const res = await prepareLanding(f.opts(), "redone");
    assert.equal(res.kind, "failed");
    if (res.kind !== "failed") return;
    assert.equal(res.checks.verdict, "failed");
    assert.equal(res.checks.failed, 1);
    assert.deepEqual(
      res.checks.runs.filter((r) => r.bucket === "fail").map((r) => r.name),
      ["test (ubuntu)"],
      "the failing check is named, so the resolver can be pointed at it",
    );
    assert.equal(res.devSha, originDev);

    // A red CHECK is the PR's own verdict, so unlike the old local build+test the
    // branch IS published and the PR IS open — that is where the failure is read.
    assert.equal(f.forge.pushes.length, 1);
    assert.equal(res.pr.number, 1);
    assert.match(f.forge.prs[0]!.body, /\*\*red\*\*/, "the PR states the red verdict");
    assert.match(f.forge.prs[0]!.body, /test \(ubuntu\)/, "and names the failing check");

    // The branch is left REBASED holding all the work, worktree clean — the exact
    // state a fix dispatch needs.
    assert.ok(branchExists(f.repo, rec.branch));
    assert.equal(res.featureSha, sha(f.repo, rec.branch));
    assert.match(run(f.repo, ["log", "--format=%s", rec.branch]), /job: red work/);
    assert.equal(run(rec.worktreePath, ["status", "--porcelain"]), "");
    assert.equal(f.forge.branches.get("dev"), originDev, "nothing merged");
  } finally {
    await f.cleanup();
  }
});

test("executeLanding refuses a stale green (origin/dev moved since prepare) until a fresh prepare", async () => {
  const f = await makeRepo();
  try {
    const a = await provision(f, "first");
    const b = await provision(f, "second");
    await commitIn(a.worktreePath, "a.txt", "a\n", "job: a");
    await commitIn(b.worktreePath, "b.txt", "b\n", "job: b");

    // B goes green against the ORIGINAL origin/dev; then A lands, moving it.
    const staleGreenB = await prepareGreen(f, "second");
    const greenA = await prepareGreen(f, "first");
    await executeLanding(f.opts(), "first", { featureSha: greenA.featureSha, devSha: greenA.devSha });

    // A green + B green does not make A+B green: B's combined state was never
    // tested, so the stale green must not merge.
    const devAfterA = f.forge.branches.get("dev")!;
    await assert.rejects(
      executeLanding(f.opts(), "second", {
        featureSha: staleGreenB.featureSha,
        devSha: staleGreenB.devSha,
        prNumber: staleGreenB.pr!.number,
      }),
      /'origin\/dev' moved since prepare[\s\S]*re-process the head/,
    );
    assert.equal(f.forge.branches.get("dev"), devAfterA, "the refusal merged nothing");
    assert.equal(f.forge.prFor(b.branch)?.state, "OPEN", "B's PR is still open");
    assert.ok(fs.existsSync(b.worktreePath));

    // A fresh prepare re-proves B against origin/dev-as-it-is-now, updates the
    // SAME PR rather than opening a second one, and then it lands.
    const freshGreenB = await prepareGreen(f, "second");
    assert.equal(freshGreenB.devSha, devAfterA);
    assert.equal(freshGreenB.pr!.number, staleGreenB.pr!.number, "the PR is reused, not duplicated");
    assert.equal(freshGreenB.pr!.created, false);
    const landedB = await executeLanding(f.opts(), "second", {
      featureSha: freshGreenB.featureSha,
      devSha: freshGreenB.devSha,
      prNumber: freshGreenB.pr!.number,
    });
    assert.equal(f.forge.branches.get("dev"), landedB.mergeSha);
    assert.equal(f.forge.prs.length, 2, "two features, two PRs, no duplicates");
  } finally {
    await f.cleanup();
  }
});

test("executeLanding refuses when the branch grew commits after the prepare it was pinned to", async () => {
  const f = await makeRepo();
  try {
    const rec = await provision(f, "moving");
    await commitIn(rec.worktreePath, "m.txt", "m\n", "job: m");
    const green = await prepareGreen(f, "moving");
    // The crew slipped in another commit after the green.
    await commitIn(rec.worktreePath, "late.txt", "late\n", "job: untested late work");

    const originDev = f.forge.branches.get("dev")!;
    await assert.rejects(
      executeLanding(f.opts(), "moving", { featureSha: green.featureSha, devSha: green.devSha }),
      /moved since prepare/,
    );
    assert.equal(f.forge.branches.get("dev"), originDev);
    assert.equal(f.forge.prFor(rec.branch)?.state, "OPEN");
  } finally {
    await f.cleanup();
  }
});

test("executeLanding refuses when the PR's head on the forge is not the tested tip", async () => {
  const f = await makeRepo();
  try {
    const rec = await provision(f, "raced");
    await commitIn(rec.worktreePath, "r.txt", "r\n", "job: r");
    const green = await prepareGreen(f, "raced");

    // Someone else pushed to the branch after our green: the forge's head is no
    // longer the sha we built and tested.
    f.forge.branches.set(rec.branch, "0000000000000000000000000000000000000000");
    const originDev = f.forge.branches.get("dev")!;
    await assert.rejects(
      executeLanding(f.opts(), "raced", {
        featureSha: green.featureSha,
        devSha: green.devSha,
        prNumber: green.pr!.number,
      }),
      /head on the forge is[\s\S]*not the tested tip/,
    );
    assert.equal(f.forge.branches.get("dev"), originDev, "nothing merged");
    assert.equal(f.forge.prs[0]!.state, "OPEN");
  } finally {
    await f.cleanup();
  }
});

test("a feature with no commits: prepare is green-and-empty with no push or PR, and execute refuses", async () => {
  const f = await makeRepo();
  try {
    await provision(f, "empty");
    const res = await prepareGreen(f, "empty");
    assert.deepEqual(res.commits, []);
    assert.equal(res.diff, "");
    assert.equal(res.pr, undefined, "nothing to land opens no PR");
    assert.deepEqual(f.forge.pushes, []);
    await assert.rejects(executeLanding(f.opts(), "empty"), /nothing to land/);
  } finally {
    await f.cleanup();
  }
});

test("prepareLanding throws on a dirty worktree and on a feature with no worktree, changing nothing", async () => {
  const f = await makeRepo();
  try {
    const rec = await provision(f, "dirty");
    await commitIn(rec.worktreePath, "d.txt", "d\n", "job: d");
    await fsp.writeFile(path.join(rec.worktreePath, "wip.txt"), "not committed\n", "utf8");
    const branchBefore = sha(f.repo, rec.branch);

    await assert.rejects(prepareLanding(f.opts(), "dirty"), /uncommitted changes/);
    assert.equal(sha(f.repo, rec.branch), branchBefore);
    assert.ok(fs.existsSync(path.join(rec.worktreePath, "wip.txt")), "the uncommitted work survives");
    assert.deepEqual(f.forge.pushes, []);

    await assert.rejects(prepareLanding(f.opts(), "never-dispatched"), /no branch/);
  } finally {
    await f.cleanup();
  }
});

test("a missing prerequisite (no gh, not authed, no origin/dev) fails cleanly and writes nothing", async () => {
  const f = await makeRepo();
  try {
    const rec = await provision(f, "prereq");
    await commitIn(rec.worktreePath, "p.txt", "p\n", "job: p");
    const branchBefore = sha(f.repo, rec.branch);

    f.forge.ghInstalled = false;
    await assert.rejects(prepareLanding(f.opts(), "prereq"), /GitHub CLI/);
    f.forge.ghInstalled = true;

    f.forge.ghAuthed = false;
    await assert.rejects(prepareLanding(f.opts(), "prereq"), /gh auth login/);
    f.forge.ghAuthed = true;

    f.forge.hasRemote = false;
    await assert.rejects(prepareLanding(f.opts(), "prereq"), /no 'origin' remote/);
    f.forge.hasRemote = true;

    f.forge.branches.delete("dev");
    run(f.repo, ["update-ref", "-d", "refs/remotes/origin/dev"]);
    await assert.rejects(prepareLanding(f.opts(), "prereq"), /no 'origin\/dev' branch on the remote/);

    // Every refusal left the branch, the worktree and the remote alone.
    assert.equal(sha(f.repo, rec.branch), branchBefore);
    assert.deepEqual(f.forge.pushes, []);
    assert.equal(f.forge.prs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("re-processing an unchanged green updates the PR's evidence without a second push or a second PR", async () => {
  const f = await makeRepo();
  try {
    const rec = await provision(f, "again");
    await commitIn(rec.worktreePath, "a.txt", "a\n", "job: a");

    const first = await prepareGreen(f, "again");
    assert.equal(first.pushed, true);
    assert.equal(first.pr!.created, true);

    const editsBefore = f.forge.calls.filter((c) => c.startsWith("gh pr edit")).length;
    const second = await prepareGreen(f, "again");
    assert.equal(second.featureSha, first.featureSha, "an unmoved origin/dev rebases to the same tip");
    assert.equal(second.pushed, false, "the remote already has this sha");
    assert.equal(second.pr!.number, first.pr!.number);
    assert.equal(second.pr!.created, false);
    assert.equal(f.forge.pushes.length, 1);
    assert.equal(f.forge.prs.length, 1);
    // The evidence carries no timings, so an unchanged re-read rewrites nothing.
    assert.equal(
      f.forge.calls.filter((c) => c.startsWith("gh pr edit")).length,
      editsBefore,
      "identical evidence sends no edit at all",
    );
  } finally {
    await f.cleanup();
  }
});

// --- the checks gate ---------------------------------------------------------

test("NO CI checks at all: the head is green but UNGATED — never an error, never a false red", async () => {
  const f = await makeRepo();
  try {
    const rec = await provision(f, "nocichecks");
    await commitIn(rec.worktreePath, "n.txt", "n\n", "job: n");
    // The fake reports what gh reports for a repo with no CI: exit 1, nothing on
    // stdout, "no checks reported on the '<branch>' branch" on stderr. This is
    // the regression that mattered — co used to treat "cannot verify" as red and
    // wedge the queue behind a head that was perfectly fine.
    assert.equal(f.forge.checks.size, 0);

    const res = await prepareLanding(f.opts(), "nocichecks");
    assert.equal(res.kind, "green", `expected an ungated green, got ${JSON.stringify(res)}`);
    if (res.kind !== "green") return;
    assert.equal(res.checks?.verdict, "none");
    assert.equal(res.checks?.ungated, true, "and it is FLAGGED, not silently passed off as green");
    assert.equal(res.checks?.total, 0);
    assert.equal(res.pr?.number, 1, "it still published and opened its PR");

    // The PR says so in words, so the captain reads it where they read the PR.
    assert.match(f.forge.prs[0]!.body, /\*\*ungated\*\*/);
    assert.match(f.forge.prs[0]!.body, /no CI checks reported/);
    assert.match(f.forge.prs[0]!.body, /human judgment call/);

    // And it really is mergeable: an ungated head is a READY head.
    const landed = await executeLanding(f.opts(), "nocichecks", {
      featureSha: res.featureSha,
      devSha: res.devSha,
      prNumber: res.pr!.number,
    });
    assert.equal(f.forge.branches.get("dev"), landed.mergeSha);
  } finally {
    await f.cleanup();
  }
});

test("a green check set makes a plain green, and the PR states what passed", async () => {
  const f = await makeRepo();
  try {
    const rec = await provision(f, "greenish");
    await commitIn(rec.worktreePath, "g.txt", "g\n", "job: g");
    f.forge.checks.set(1, [pass("build"), pass("test"), { name: "docs", bucket: "skipping" }]);

    const res = await prepareGreen(f, "greenish");
    assert.equal(res.checks?.verdict, "passed");
    assert.equal(res.checks?.ungated, false);
    assert.equal(res.checks?.passed, 2);
    assert.equal(res.checks?.skipped, 1, "a skipped check is not blocking, as on the forge");
    assert.match(f.forge.prs[0]!.body, /\*\*green\*\*/);
  } finally {
    await f.cleanup();
  }
});

test("REQUIRED checks win when branch protection defines them; everything else is ignored", async () => {
  const f = await makeRepo();
  try {
    const rec = await provision(f, "required");
    await commitIn(rec.worktreePath, "r.txt", "r\n", "job: r");
    // A red check that is NOT required must not block: GitHub itself would let
    // this merge, and co mirrors the protected-branch rule rather than inventing
    // a stricter one.
    f.forge.checks.set(1, [
      pass("build", true),
      { name: "flaky-nightly", bucket: "fail" },
    ]);

    const res = await prepareGreen(f, "required");
    assert.equal(res.checks?.requiredOnly, true);
    assert.equal(res.checks?.total, 1, "only the required check was gated on");
    assert.deepEqual(res.checks?.runs.map((r) => r.name), ["build"]);
    assert.ok(
      f.forge.calls.some((c) => c.startsWith("gh pr checks") && c.includes("--required")),
      "the required read is tried first",
    );
  } finally {
    await f.cleanup();
  }
});

test("no REQUIRED checks: the gate falls back to every check the PR reports", async () => {
  const f = await makeRepo();
  try {
    const rec = await provision(f, "unprotected");
    await commitIn(rec.worktreePath, "u.txt", "u\n", "job: u");
    f.forge.checks.set(1, [pass("build"), { name: "test", bucket: "fail" }]);

    const res = await prepareLanding(f.opts(), "unprotected");
    assert.equal(res.kind, "failed", "an unprotected repo is still gated on its CI");
    if (res.kind !== "failed") return;
    assert.equal(res.checks.requiredOnly, false);
    assert.equal(res.checks.total, 2);
  } finally {
    await f.cleanup();
  }
});

test("checks still running: prepare comes back pending, not green and not failed", async () => {
  const f = await makeRepo();
  try {
    const rec = await provision(f, "slowci");
    await commitIn(rec.worktreePath, "s.txt", "s\n", "job: s");
    f.forge.checks.set(1, [pass("lint"), { name: "test", bucket: "pending" }]);

    const res = await prepareLanding(f.opts(), "slowci");
    assert.equal(res.kind, "pending");
    if (res.kind !== "pending") return;
    assert.equal(res.checks.verdict, "pending");
    assert.equal(res.checks.pending, 1);
    assert.equal(res.checks.timedOut, true, "the wait is bounded, and it says when it ran out");
    assert.equal(res.pr.number, 1, "the PR is open and waiting; nothing was rolled back");
  } finally {
    await f.cleanup();
  }
});

test("the bounded wait POLLS: a pending check that turns green inside the window is a green", async () => {
  const f = await makeRepo();
  try {
    const rec = await provision(f, "polled");
    await commitIn(rec.worktreePath, "p.txt", "p\n", "job: p");
    f.forge.checks.set(1, [{ name: "test", bucket: "pending" }]);

    let reads = 0;
    f.forge.onChecksRead = () => {
      reads++;
      // Third look: CI finished.
      if (reads >= 3) f.forge.checks.set(1, [pass("test")]);
    };
    const res = await prepareGreen(f, "polled", {
      timeoutMs: 60_000,
      intervalMs: 1,
      graceMs: 0,
      sleep: async () => {},
    });
    assert.equal(res.checks?.verdict, "passed");
    assert.ok(reads >= 3, `it looked again rather than giving up once (${reads} reads)`);
  } finally {
    await f.cleanup();
  }
});

test("checks that have not APPEARED yet after a push are waited for, then called ungated", async () => {
  const f = await makeRepo();
  try {
    const rec = await provision(f, "lateci");
    await commitIn(rec.worktreePath, "l.txt", "l\n", "job: l");
    let reads = 0;
    f.forge.onChecksRead = () => {
      reads++;
      // GitHub registers the workflow run a beat after the push.
      if (reads >= 4) f.forge.checks.set(1, [pass("build")]);
    };

    const res = await prepareGreen(f, "lateci", {
      timeoutMs: 60_000,
      intervalMs: 1,
      graceMs: 30_000,
      sleep: async () => {},
    });
    assert.equal(res.checks?.verdict, "passed", "a slow-to-appear check is not 'no CI'");
    assert.equal(res.checks?.ungated, false);
    assert.ok(reads >= 4, `the grace window kept looking (${reads} reads)`);
  } finally {
    await f.cleanup();
  }
});

test("a BROKEN checks read throws — it is never mistaken for an ungated pass", async () => {
  const f = await makeRepo();
  try {
    const rec = await provision(f, "ghbroke");
    await commitIn(rec.worktreePath, "b.txt", "b\n", "job: b");
    f.forge.checksError = "HTTP 503: Service unavailable (api.github.com)";

    await assert.rejects(prepareLanding(f.opts(), "ghbroke"), /gh pr checks .*503/);
    assert.equal(f.forge.prs[0]?.state, "OPEN", "the PR it opened is left alone");
    assert.equal(f.forge.branches.get("dev"), sha(f.repo, "dev"), "and nothing merged");
  } finally {
    await f.cleanup();
  }
});

test("co runs no build or test of its own: every command it issues is git or gh", async () => {
  const f = await makeRepo();
  try {
    const rec = await provision(f, "noruns");
    await commitIn(rec.worktreePath, "x.txt", "x\n", "job: x");
    f.forge.checks.set(1, [pass("build")]);
    await prepareGreen(f, "noruns");

    // The forge runner sees every command the engine issues. There is no longer
    // any path that shells out to a project build or test — that was the whole
    // point of the change, so it is asserted rather than assumed.
    for (const call of f.forge.calls) {
      assert.ok(/^(git|gh) /.test(call), `unexpected non-git/gh command: ${call}`);
    }
    assert.ok(!f.forge.calls.some((c) => /npm|yarn|pnpm|make|sh -c/.test(c)));
  } finally {
    await f.cleanup();
  }
});
