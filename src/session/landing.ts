import { spawn } from "node:child_process";
import fs from "node:fs";
import {
  branchExists,
  featureBranch,
  featureSlug,
  git,
  isMergedInto,
  isWorktreeDirty,
  listWorktrees,
  resolveWorktreeOptions,
  runGit,
  teardownWorktree,
  type TeardownResult,
  type WorktreeOptions,
} from "./worktrees.js";

/**
 * The landing engine: how a finished feature gets onto `dev`. Two phases,
 * deliberately split so a human keystroke can sit between them:
 *
 *  PREPARE (prepareLanding) — non-destructive. Rebase the feature branch onto
 *  the CURRENT dev tip inside the feature's own worktree, then run the
 *  project's combined build+test there. Returns `green` (with the diff the
 *  future gate will show), `conflict` (the rebase stopped; it is aborted and
 *  the branch restored byte-for-byte), or `failed` (build/test red on the
 *  combined state; the branch is left rebased-but-intact so a fix can be
 *  dispatched into the exact state that failed). dev is never written.
 *
 *  EXECUTE (executeLanding) — the gated write. Merge the green, rebased
 *  feature into dev as a --no-ff merge commit — the per-job atomic commits
 *  are preserved, never squashed (decision D-20260723-9) — then tear the
 *  worktree + branch down via teardownWorktree's existing guards. This is a
 *  separate callable precisely so a human keystroke can sit in front of it.
 *  Two live call sites, both a keystroke: landinggate's [m] over a feature_land
 *  review, and MergeQueue.mergeReadyHead, which the Ctrl-O panel's [m] fires on
 *  a ready queue head (D-20260724-12). The only path that reaches it with no
 *  keystroke at all is feature_merge_head in a session that HAS no panel
 *  (piped/non-TTY), where there is no key to press.
 *
 * WHY build+test runs on the combined state: feature A green and feature B
 * green does not make A+B green — B may compile against code A just changed.
 * The rebase puts the feature on top of everything already landed, so the
 * build+test that gates the merge sees exactly the tree dev will hold. That
 * also makes landings serial by nature: each prepare rebases onto whatever
 * dev is at that moment, and executeLanding refuses a green that has gone
 * stale (dev moved since the prepare — the A-green + B-green = red hole).
 *
 * THE MERGE IS PLUMBING, not a checkout-and-`git merge`: a branch rebased
 * onto dev's tip merges to its own tree, so the merge commit is fully
 * determined — `commit-tree` with the two parents, then a compare-and-swap
 * `update-ref` on dev. No checkout of dev ever exists, so there is nothing
 * to conflict, no temp worktree to leak on a crash, and the CAS turns a
 * concurrent dev move into a loud failure instead of a lost update. The
 * result is indistinguishable from `git merge --no-ff` on a rebased branch.
 *
 * Safety posture, matching worktrees.ts: `main` is never read or written
 * here at all. The only ref this module writes is dev (the merge, CAS'd);
 * the only branches otherwise touched are `co/feat-*` (rebase in prepare,
 * teardown after the merge). Deterministic plumbing — no model, no network.
 */

/** The real default combined build+test: the repo's own typecheck + test
 *  scripts. Injectable via LandingOptions.buildTestCommand so unit tests use
 *  a fast fake instead of recursing into a real suite. */
export const DEFAULT_BUILD_TEST_COMMAND = "npm run typecheck && npm test";

/** Keep only the tail of a build+test's output — a chatty suite can emit
 *  megabytes, and the failure summary lives at the end. */
const OUTPUT_TAIL_LIMIT = 64 * 1024;

export interface LandingOptions extends WorktreeOptions {
  /** The combined build+test command, run via `sh -c` with the rebased
   *  worktree as cwd. Defaults to DEFAULT_BUILD_TEST_COMMAND. */
  buildTestCommand?: string;
}

/** What the combined build+test did, carried on a prepare result so a review
 *  surface can STATE the evidence ("green · npm run typecheck && npm test ·
 *  12.4s") instead of implying it. Optional on the results so a hand-built
 *  PrepareResult (tests, fakes) stays valid. */
export interface BuildTestSummary {
  /** The exact command that ran, in the rebased worktree. */
  command: string;
  /** Wall-clock duration of the run, in milliseconds. */
  ms: number;
}

/** Prepare succeeded: the feature is rebased onto devSha and build+test is
 *  green on that combined state. Everything the gate needs to show is here;
 *  executeLanding pins to featureSha so approval covers exactly this state. */
export interface PrepareGreen {
  kind: "green";
  feature: string;
  branch: string;
  /** The dev tip the feature was rebased onto — the base of `diff`. */
  devSha: string;
  /** The feature tip after the rebase — what executeLanding will merge. */
  featureSha: string;
  /** Full patch of the feature against dev (devSha..featureSha). */
  diff: string;
  /** The per-job atomic commits awaiting merge, oldest first (`<sha> <subject>`).
   *  Empty means the feature holds no commits beyond dev — nothing to land. */
  commits: string[];
  /** The build+test that passed on the combined state — the merge's evidence. */
  buildTest?: BuildTestSummary;
}

/** The rebase hit a conflict. It was aborted: the feature branch and its
 *  worktree are byte-for-byte where they were, and dev was never touched.
 *  The conflict detail is the input to a re-dispatch decision (send the crew
 *  back in to resolve, or drop the feature). */
export interface PrepareConflict {
  kind: "conflict";
  feature: string;
  branch: string;
  /** The dev tip the rebase was attempted onto. */
  devSha: string;
  /** Paths left unmerged at the step that stopped the rebase. */
  conflictFiles: string[];
  /** git's own account of the failing step. */
  detail: string;
}

/** The rebase succeeded but build+test is red on the combined state. dev was
 *  never touched. The branch is deliberately left REBASED (not rolled back):
 *  the red state only exists on the combined tree, so a fix dispatch needs
 *  the worktree to hold exactly that tree — rolling back would hide the very
 *  failure the crew is being sent in to fix. All feature work is preserved
 *  (same commits, replayed onto dev). */
export interface PrepareFailed {
  kind: "failed";
  feature: string;
  branch: string;
  /** The dev tip the feature was rebased onto. */
  devSha: string;
  /** The rebased feature tip the red build+test ran on. */
  featureSha: string;
  exitCode: number;
  /** Combined stdout+stderr tail of the build+test run. */
  output: string;
  /** The build+test that went red, so a review surface can name the command. */
  buildTest?: BuildTestSummary;
}

export type PrepareResult = PrepareGreen | PrepareConflict | PrepareFailed;

export interface LandResult {
  feature: string;
  branch: string;
  /** The --no-ff merge commit now at dev's tip. */
  mergeSha: string;
  /** dev's tip before the merge — the merge commit's first parent. */
  previousDevSha: string;
  /** What teardownWorktree did afterwards (worktree removed, branch deleted). */
  teardown: TeardownResult;
}

/**
 * PREPARE phase: rebase the feature onto the current dev tip in its own
 * worktree and run the combined build+test there. Non-destructive to dev in
 * every outcome; see the result types for exactly what each leaves behind.
 *
 * Preconditions are thrown, not classified: a missing dev branch, a feature
 * with no branch or no worktree, a worktree not on its branch, or one with
 * uncommitted changes is a caller/lifecycle problem, not a landing outcome —
 * and throwing before touching anything trivially preserves every invariant.
 */
export async function prepareLanding(opts: LandingOptions, feature: string): Promise<PrepareResult> {
  const r = resolveWorktreeOptions(opts);
  const slug = featureSlug(feature);
  const branch = featureBranch(feature);

  if (!(await branchExists(r.repoPath, r.devBranch))) {
    throw new Error(`no '${r.devBranch}' branch in ${r.repoPath}; nothing to land onto`);
  }
  if (!(await branchExists(r.repoPath, branch))) {
    throw new Error(`feature '${feature}' has no branch '${branch}' in ${r.repoPath}`);
  }
  const entry = (await listWorktrees(r.repoPath)).find((w) => w.branch === `refs/heads/${branch}`);
  if (!entry || !fs.existsSync(entry.path)) {
    throw new Error(
      `feature '${feature}' (${slug}) has no worktree for '${branch}'; dispatch it first or run reconcile`,
    );
  }
  const worktreePath = entry.path;
  // The rebase acts on the worktree's HEAD; make sure that IS the feature
  // branch (a crew could conceivably have detached or switched it).
  const head = await runGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (head.code !== 0 || head.stdout.trim() !== branch) {
    throw new Error(
      `worktree ${worktreePath} is not on '${branch}' (found '${head.stdout.trim() || "detached HEAD"}')`,
    );
  }
  if (await isWorktreeDirty(worktreePath)) {
    throw new Error(
      `worktree ${worktreePath} has uncommitted changes; landing takes committed work only`,
    );
  }

  const devSha = (await git(r.repoPath, ["rev-parse", r.devBranch])).trim();
  const beforeSha = (await git(r.repoPath, ["rev-parse", branch])).trim();

  const rebase = await runGit(worktreePath, ["rebase", r.devBranch]);
  if (rebase.code !== 0) {
    // Collect the unmerged paths BEFORE aborting — the abort erases them.
    const unmerged = await runGit(worktreePath, ["diff", "--name-only", "--diff-filter=U"]);
    const conflictFiles = unmerged.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    const abort = await runGit(worktreePath, ["rebase", "--abort"]);
    if (abort.code !== 0) {
      // Not a conflict at all (nothing was in progress to abort) — a real
      // failure like a bad ref. Surface both accounts and change nothing more.
      throw new Error(
        `git rebase ${r.devBranch} failed in ${worktreePath}: ${rebase.stderr.trim() || rebase.stdout.trim()}` +
          ` (and --abort exited ${abort.code}: ${abort.stderr.trim()})`,
      );
    }
    const restored = (await git(r.repoPath, ["rev-parse", branch])).trim();
    if (restored !== beforeSha) {
      throw new Error(
        `rebase --abort left '${branch}' at ${restored}, expected ${beforeSha}; refusing to continue`,
      );
    }
    return {
      kind: "conflict",
      feature,
      branch,
      devSha,
      conflictFiles,
      detail: rebase.stderr.trim() || rebase.stdout.trim(),
    };
  }

  const featureSha = (await git(r.repoPath, ["rev-parse", branch])).trim();
  const command = opts.buildTestCommand ?? DEFAULT_BUILD_TEST_COMMAND;
  const startedAt = Date.now();
  const buildTest = await runBuildTest(command, worktreePath);
  const summary: BuildTestSummary = { command, ms: Date.now() - startedAt };
  if (buildTest.code !== 0) {
    return {
      kind: "failed",
      feature,
      branch,
      devSha,
      featureSha,
      exitCode: buildTest.code,
      output: buildTest.output,
      buildTest: summary,
    };
  }

  const diff = await git(r.repoPath, ["diff", `${devSha}..${featureSha}`]);
  const log = await git(r.repoPath, ["log", "--reverse", "--format=%h %s", `${devSha}..${featureSha}`]);
  const commits = log.split("\n").map((l) => l.trim()).filter(Boolean);
  return { kind: "green", feature, branch, devSha, featureSha, diff, commits, buildTest: summary };
}

/**
 * EXECUTE phase: the single callable the human gate fires on approval. Merges
 * the green, rebased feature into dev as a --no-ff merge commit and tears the
 * worktree + branch down. The ONLY ref written is dev.
 *
 * Integrity guards, all throwing before anything is written:
 *  - the current dev tip must be an ancestor of the feature (the feature is
 *    rebased onto dev-as-it-is-now). A green that went stale because another
 *    feature landed first fails here — its combined state was never tested —
 *    and the fix is simply another prepareLanding.
 *  - `expect.featureSha` (pass the green result's featureSha) pins the merge
 *    to exactly the state that was diffed and tested; a branch that grew
 *    commits after the prepare is refused.
 *  - a dev checked out in some worktree is refused: this writes the ref
 *    directly, which would desync that checkout's index and files.
 *  - a feature with no commits beyond dev has nothing to merge; refuse and
 *    point at teardown rather than minting an empty merge commit.
 *
 * The update-ref is a compare-and-swap against the dev tip read above, so
 * even a dev moved between the guard and the write fails loudly.
 */
export async function executeLanding(
  opts: WorktreeOptions,
  feature: string,
  expect: { featureSha?: string } = {},
): Promise<LandResult> {
  const r = resolveWorktreeOptions(opts);
  const branch = featureBranch(feature);

  if (!(await branchExists(r.repoPath, r.devBranch))) {
    throw new Error(`no '${r.devBranch}' branch in ${r.repoPath}; nothing to land onto`);
  }
  if (!(await branchExists(r.repoPath, branch))) {
    throw new Error(`feature '${feature}' has no branch '${branch}' in ${r.repoPath}`);
  }
  const devSha = (await git(r.repoPath, ["rev-parse", r.devBranch])).trim();
  const featureSha = (await git(r.repoPath, ["rev-parse", branch])).trim();
  if (expect.featureSha && expect.featureSha !== featureSha) {
    throw new Error(
      `'${branch}' has moved since prepare (expected ${expect.featureSha}, found ${featureSha}); ` +
        `run prepareLanding again`,
    );
  }
  if (featureSha === devSha) {
    throw new Error(
      `feature '${feature}' has no commits beyond '${r.devBranch}'; nothing to land — tear it down instead`,
    );
  }
  if (!(await isMergedInto(r.repoPath, r.devBranch, branch))) {
    throw new Error(
      `feature '${feature}' is not rebased onto the current '${r.devBranch}' tip; run prepareLanding again`,
    );
  }
  const devCheckout = (await listWorktrees(r.repoPath)).find(
    (w) => w.branch === `refs/heads/${r.devBranch}`,
  );
  if (devCheckout) {
    throw new Error(
      `'${r.devBranch}' is checked out at ${devCheckout.path}; landing writes the ref directly ` +
        `and would desync that checkout`,
    );
  }

  // The feature is rebased onto dev, so the merged tree IS the feature's tree;
  // build the two-parent (--no-ff) merge commit with plumbing and CAS it in.
  const tree = (await git(r.repoPath, ["rev-parse", `${featureSha}^{tree}`])).trim();
  const message = `Merge branch '${branch}' into ${r.devBranch}`;
  const mergeSha = (
    await git(r.repoPath, ["commit-tree", "-p", devSha, "-p", featureSha, "-m", message, tree])
  ).trim();
  await git(r.repoPath, [
    "update-ref",
    "-m",
    `co landing: ${message}`,
    `refs/heads/${r.devBranch}`,
    mergeSha,
    devSha,
  ]);

  const teardown = await teardownWorktree(opts, feature);
  return { feature, branch, mergeSha, previousDevSha: devSha, teardown };
}

/** One build+test run: `sh -c <command>` in the worktree, combined output
 *  captured (tail-limited), exit code returned rather than thrown — a red
 *  suite is a landing outcome, not an exception. */
function runBuildTest(command: string, cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (d: unknown) => {
      output += String(d);
      if (output.length > OUTPUT_TAIL_LIMIT) output = output.slice(-OUTPUT_TAIL_LIMIT);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, output }));
  });
}
