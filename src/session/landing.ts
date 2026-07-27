import { spawn } from "node:child_process";
import fs from "node:fs";
import {
  fetchRemote,
  mergePr,
  openOrUpdatePr,
  pushFeatureBranch,
  remoteDevSha,
  requireForge,
  viewPr,
  findOpenPr,
  type PullRequest,
} from "./forge.js";
import {
  branchExists,
  featureBranch,
  featureSlug,
  forgeOptions,
  git,
  isWorktreeDirty,
  listWorktrees,
  resolveWorktreeOptions,
  runGit,
  teardownWorktree,
  type TeardownResult,
  type WorktreeOptions,
} from "./worktrees.js";

/**
 * The landing engine: how a finished feature gets onto `dev`. Since
 * D-20260724-13 that happens through a GITHUB PULL REQUEST, server-side, and co
 * never writes the local `dev` ref at any point.
 *
 * WHY THE LOCAL MERGE HAD TO GO. `dev` is checked out in the captain's primary
 * tree. A local merge means writing a ref git refuses to let anything write
 * while it is checked out — the old engine dodged that with plumbing
 * (commit-tree + update-ref) and then had to REFUSE outright whenever dev was
 * checked out anywhere, which is the normal state of the captain's repo. A
 * forge merge removes the write entirely: co pushes a branch and asks GitHub to
 * merge it. The captain's checkout is never touched, and `origin/dev` is the
 * single source of truth about what has landed.
 *
 * Two phases, still deliberately split so a human keystroke can sit between them:
 *
 *  PREPARE (prepareLanding) — non-destructive to `dev`. Fetch, rebase the
 *  feature branch onto the FRESH `origin/dev` tip inside the feature's own
 *  worktree, run the project's combined build+test there, then publish: push the
 *  rebased branch (force-with-lease — a rebase rewrites shas) and open or update
 *  the PR into `dev` with a composed message carrying the commit list and the
 *  build+test evidence. Returns `green` (with the PR), `conflict` (the rebase
 *  stopped; it is aborted and the branch restored byte-for-byte, and nothing is
 *  pushed), or `failed` (build/test red on the combined state; nothing is pushed
 *  and the branch is left rebased so a fix lands in the exact red state).
 *
 *  EXECUTE (executeLanding) — the gated merge. `gh pr merge --merge`, then a
 *  fetch, then teardown of the local worktree ONLY. Two live call sites, both a
 *  keystroke: landinggate's [m] over a feature_land review, and
 *  MergeQueue.mergeReadyHead, which the Ctrl-O panel's [m] fires on a ready
 *  queue head (D-20260724-12). The only path that reaches it with no keystroke
 *  at all is feature_merge_head in a session that HAS no panel (piped/non-TTY),
 *  where there is no key to press.
 *
 * WHY build+test runs on the combined state: feature A green and feature B
 * green does not make A+B green — B may compile against code A just changed.
 * The rebase puts the feature on top of everything already landed, so the
 * build+test that gates the merge sees exactly the tree `dev` will hold. That
 * also makes landings serial by nature: each prepare rebases onto whatever
 * `origin/dev` is at that moment, and executeLanding refuses a green that has
 * gone stale (`origin/dev` moved since the prepare — the A-green + B-green = red
 * hole), sending the head back for a fresh fetch/rebase/build+test.
 *
 * THE TESTED TIP IS THE MERGED TIP. The push publishes exactly the sha the
 * build+test ran on, and before merging, the PR's head on the forge is compared
 * against that sha. A branch someone pushed to in between fails loudly instead
 * of merging something nobody tested.
 *
 * HARD MERGE RULES (enforced in forge.ts, restated because they are contracts):
 * always `--merge`, a real merge commit — never squash, never rebase-merge, so
 * the feature topology and the crew's per-job commits survive. Never
 * `--delete-branch`: refs are kept, only the local checkout is torn down.
 *
 * Safety posture: `main` is never read or written here. The local `dev` ref is
 * never read or written either — `origin/dev` is; the only local refs touched
 * are `co/feat-*` (rebase in prepare, worktree teardown after the merge) and
 * `refs/remotes/*` (via fetch). Deterministic plumbing plus gh — no model.
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

/** The pull request a green prepare opened or refreshed — the thing the panel
 *  renders and the thing [m] merges. */
export interface LandingPullRequest {
  number: number;
  url: string;
  title: string;
  body: string;
  /** True when this prepare opened the PR; false when it refreshed one that was
   *  already open. */
  created: boolean;
}

/** Prepare succeeded: the feature is rebased onto devSha, build+test is green on
 *  that combined state, the branch is pushed, and the PR is open. executeLanding
 *  pins to featureSha AND devSha, so approval covers exactly this state. */
export interface PrepareGreen {
  kind: "green";
  feature: string;
  branch: string;
  /** The `origin/dev` tip the feature was rebased onto — the base of `diff` and
   *  the PR, and the staleness pin the merge re-checks. */
  devSha: string;
  /** The feature tip after the rebase — pushed, PR'd, and merged as-is. */
  featureSha: string;
  /** Full patch of the feature against `origin/dev` (devSha..featureSha). Feeds
   *  the feature_land gate's paged diff; the queue panel shows the PR instead. */
  diff: string;
  /** The per-job atomic commits awaiting merge, oldest first (`<sha> <subject>`).
   *  Empty means the feature holds no commits beyond dev — nothing to land, and
   *  nothing is pushed or PR'd. */
  commits: string[];
  /** The build+test that passed on the combined state — the merge's evidence. */
  buildTest?: BuildTestSummary;
  /** The open PR into `dev`. Absent only when there was nothing to land. */
  pr?: LandingPullRequest;
  /** Whether this prepare actually pushed (false when the remote already had
   *  the rebased sha — a head re-processed against an unmoved `origin/dev`). */
  pushed?: boolean;
}

/** The rebase hit a conflict. It was aborted: the feature branch and its
 *  worktree are byte-for-byte where they were, nothing was pushed, and no PR
 *  was touched. The conflict detail is the input to a re-dispatch decision
 *  (send the crew back in to resolve, or drop the feature). */
export interface PrepareConflict {
  kind: "conflict";
  feature: string;
  branch: string;
  /** The `origin/dev` tip the rebase was attempted onto. */
  devSha: string;
  /** Paths left unmerged at the step that stopped the rebase. */
  conflictFiles: string[];
  /** git's own account of the failing step. */
  detail: string;
}

/** The rebase succeeded but build+test is red on the combined state. Nothing
 *  was pushed and no PR was opened or updated — an unbuildable state never
 *  reaches the forge. The branch is deliberately left REBASED (not rolled
 *  back): the red state only exists on the combined tree, so a fix dispatch
 *  needs the worktree to hold exactly that tree — rolling back would hide the
 *  very failure the crew is being sent in to fix. All feature work is preserved
 *  (same commits, replayed onto dev). */
export interface PrepareFailed {
  kind: "failed";
  feature: string;
  branch: string;
  /** The `origin/dev` tip the feature was rebased onto. */
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

/** What the merge is pinned to. Every field is a refusal if it no longer holds,
 *  so approval can never cover more (or other) work than was reviewed. */
export interface LandingExpectation {
  /** The exact tested tip. A branch that grew commits since is refused. */
  featureSha?: string;
  /** The `origin/dev` tip the green was tested against. A dev that moved since
   *  is refused — that combined state was never built. */
  devSha?: string;
  /** The PR the review covered. Looked up from the branch when omitted. */
  prNumber?: number;
}

export interface LandResult {
  feature: string;
  branch: string;
  /** The merge commit GitHub created on `dev`, when gh reported it. */
  mergeSha: string;
  /** `origin/dev`'s tip before the merge — the merge commit's first parent. */
  previousDevSha: string;
  /** The PR that was merged. */
  pr: { number: number; url: string };
  /** What teardownWorktree did afterwards. The branch is always KEPT. */
  teardown: TeardownResult;
}

/**
 * PREPARE phase: fetch, rebase the feature onto the fresh `origin/dev` tip in
 * its own worktree, run the combined build+test there, and — only if that is
 * green — push the branch and open/refresh its PR. Non-destructive to `dev` in
 * every outcome; see the result types for exactly what each leaves behind.
 *
 * Preconditions are thrown, not classified: a missing prerequisite (no gh, not
 * authenticated, no `origin/dev`), a feature with no branch or no worktree, a
 * worktree not on its branch, or one with uncommitted changes is a
 * caller/lifecycle problem, not a landing outcome — and throwing before touching
 * anything trivially preserves every invariant. The queue turns such a throw
 * into a blocked head carrying the message; the tool layer reports it verbatim.
 */
export async function prepareLanding(opts: LandingOptions, feature: string): Promise<PrepareResult> {
  const r = resolveWorktreeOptions(opts);
  const forge = forgeOptions(opts);
  const slug = featureSlug(feature);
  const branch = featureBranch(feature);

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

  // gh present + authenticated + `origin/dev` reachable, with a fetch inside —
  // so the rebase below targets the tip as it is RIGHT NOW, not as it was.
  await requireForge(forge);

  const devSha = (await remoteDevSha(forge)).trim();
  const beforeSha = (await git(r.repoPath, ["rev-parse", branch])).trim();

  const rebase = await runGit(worktreePath, ["rebase", r.devRef]);
  if (rebase.code !== 0) {
    // Collect the unmerged paths BEFORE aborting — the abort erases them.
    const unmerged = await runGit(worktreePath, ["diff", "--name-only", "--diff-filter=U"]);
    const conflictFiles = unmerged.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    const abort = await runGit(worktreePath, ["rebase", "--abort"]);
    if (abort.code !== 0) {
      // Not a conflict at all (nothing was in progress to abort) — a real
      // failure like a bad ref. Surface both accounts and change nothing more.
      throw new Error(
        `git rebase ${r.devRef} failed in ${worktreePath}: ${rebase.stderr.trim() || rebase.stdout.trim()}` +
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
    // Red never reaches the forge: no push, no PR. Whatever PR may already be
    // open from an earlier green keeps its last evidence rather than being
    // rewritten with a failure the captain can't merge anyway.
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
  const green: PrepareGreen = {
    kind: "green",
    feature,
    branch,
    devSha,
    featureSha,
    diff,
    commits,
    buildTest: summary,
  };
  // Nothing to land: don't push an empty branch or open a PR with no commits.
  // The caller (the queue) treats an empty green as "nothing to land".
  if (commits.length === 0) return green;

  const push = await pushFeatureBranch(forge, branch, featureSha);
  const upsert = await openOrUpdatePr(forge, {
    branch,
    title: composePrTitle(feature, commits),
    body: composePrBody({ feature, branch, target: r.devBranch }),
    evidence: composeEvidence({ commits, devSha, featureSha, devRef: r.devRef, buildTest: summary }),
  });
  green.pushed = push.pushed;
  green.pr = {
    number: upsert.pr.number,
    url: upsert.pr.url,
    title: upsert.pr.title,
    body: upsert.pr.body,
    created: upsert.created,
  };
  return green;
}

/**
 * EXECUTE phase: the single callable the human gate fires on approval. Merges
 * the feature's PR on GitHub with a MERGE COMMIT, fetches so co sees the moved
 * `origin/dev`, and tears down the local worktree. NOTHING local is written but
 * remote-tracking refs and the removal of the feature's checkout.
 *
 * Integrity guards, all throwing before the merge is requested:
 *  - `expect.featureSha` (pass the green's featureSha) pins to exactly the state
 *    that was diffed and tested; a branch that grew commits since is refused.
 *  - `expect.devSha` pins the base: after a fresh fetch, `origin/dev` must still
 *    be where the green was tested. A dev that moved because another feature
 *    landed first fails here — that combined state was never built — and the fix
 *    is simply another prepareLanding (the queue does exactly that).
 *  - the PR must exist, target `dev`, and its head on the forge must equal the
 *    tested sha. The tested tip and the merged tip are the same commit or there
 *    is no merge.
 *
 * The branch ref is KEPT: teardown removes the worktree only, and gh is never
 * passed `--delete-branch`.
 */
export async function executeLanding(
  opts: LandingOptions,
  feature: string,
  expect: LandingExpectation = {},
): Promise<LandResult> {
  const r = resolveWorktreeOptions(opts);
  const forge = forgeOptions(opts);
  const branch = featureBranch(feature);

  if (!(await branchExists(r.repoPath, branch))) {
    throw new Error(`feature '${feature}' has no branch '${branch}' in ${r.repoPath}`);
  }
  await requireForge(forge);

  const featureSha = (await git(r.repoPath, ["rev-parse", branch])).trim();
  if (expect.featureSha && expect.featureSha !== featureSha) {
    throw new Error(
      `'${branch}' has moved since prepare (expected ${expect.featureSha}, found ${featureSha}); ` +
        `run prepareLanding again`,
    );
  }

  // requireForge fetched; read the tip it left us.
  const devSha = (await remoteDevSha(forge)).trim();
  if (expect.devSha && expect.devSha !== devSha) {
    throw new Error(
      `'${r.devRef}' moved since prepare (tested against ${expect.devSha.slice(0, 7)}, now ` +
        `${devSha.slice(0, 7)}); the combined state was never built — re-process the head`,
    );
  }
  if (featureSha === devSha) {
    throw new Error(
      `feature '${feature}' has no commits beyond '${r.devRef}'; nothing to land — tear it down instead`,
    );
  }

  const number = expect.prNumber ?? (await findOpenPr(forge, branch))?.number;
  if (number === undefined) {
    throw new Error(
      `no open pull request from '${branch}' into '${r.devBranch}'; run prepareLanding again to open one`,
    );
  }
  const pr: PullRequest = await viewPr(forge, number);
  if (pr.state && pr.state.toUpperCase() !== "OPEN") {
    throw new Error(`PR #${number} is ${pr.state.toLowerCase()}, not open; nothing to merge`);
  }
  if (pr.baseRefName && pr.baseRefName !== r.devBranch) {
    throw new Error(
      `PR #${number} targets '${pr.baseRefName}', not '${r.devBranch}'; refusing to merge it here`,
    );
  }
  if (pr.headRefOid && pr.headRefOid !== featureSha) {
    throw new Error(
      `PR #${number}'s head on the forge is ${pr.headRefOid.slice(0, 7)}, not the tested tip ` +
        `${featureSha.slice(0, 7)}; the merged tree would not be the tested tree — re-process the head`,
    );
  }

  const merged = await mergePr(forge, number);
  // mergePr already fetched to read the merge commit back; fetch again only if
  // it could not report one, so `origin/dev` is current either way.
  let mergeSha = merged.mergeCommitSha ?? "";
  if (!mergeSha) {
    await fetchRemote(forge);
    mergeSha = (await remoteDevSha(forge)).trim();
  }

  // The PR merged the branch on the forge; the ref stays, the checkout goes.
  const teardown = await teardownWorktree(opts, feature, { keepBranch: true });
  return {
    feature,
    branch,
    mergeSha,
    previousDevSha: devSha,
    pr: { number, url: merged.url || pr.url },
    teardown,
  };
}

// --- the PR message ----------------------------------------------------------

/**
 * The PR title. A single-commit feature takes that commit's own subject (the
 * crew already wrote the one-line summary); anything larger is titled by the
 * feature, because a multi-commit branch has no single subject that is honest.
 * Written once, at create time — an update never overwrites it, so a captain who
 * retitles the PR on GitHub keeps their title.
 */
export function composePrTitle(feature: string, commits: string[]): string {
  if (commits.length === 1) {
    const only = commits[0]!;
    const sp = only.indexOf(" ");
    const subject = sp === -1 ? "" : only.slice(sp + 1).trim();
    if (subject) return subject;
  }
  return feature.trim() || "feature";
}

/** The PR description co writes on create: what this is and how it will be
 *  merged. Everything volatile lives in the evidence block instead, so a
 *  re-processed head refreshes the numbers without touching this prose (or any
 *  the captain has since added around it). */
export function composePrBody(opts: { feature: string; branch: string; target: string }): string {
  return [
    `Feature **${opts.feature}** → \`${opts.target}\`.`,
    ``,
    `\`${opts.branch}\` was rebased onto the current \`${opts.target}\` tip and the project's combined ` +
      `build+test ran on that combined state before this PR opened. The evidence below is regenerated ` +
      `every time the branch is re-processed.`,
    ``,
    `Merged with a merge commit, so the feature's per-job commits and its branch topology survive. ` +
      `The branch ref is kept after the merge.`,
    ``,
  ].join("\n");
}

/** The fenced block co owns inside the PR body: what is in this branch and the
 *  proof it builds on top of the current `dev`. Rewritten on every prepare. */
export function composeEvidence(opts: {
  commits: string[];
  devSha: string;
  featureSha: string;
  devRef: string;
  buildTest?: BuildTestSummary;
}): string {
  const secs = opts.buildTest
    ? opts.buildTest.ms >= 1000
      ? `${(opts.buildTest.ms / 1000).toFixed(1)}s`
      : `${opts.buildTest.ms}ms`
    : "";
  const lines = [
    `### Build + test`,
    opts.buildTest
      ? `**green** — \`${opts.buildTest.command}\` in ${secs}, on the rebased tree.`
      : `**green** on the rebased tree.`,
    ``,
    `Rebased onto \`${opts.devRef}\` @ \`${opts.devSha.slice(0, 7)}\`; tested tip \`${opts.featureSha.slice(0, 7)}\`.`,
    ``,
    `### Commits (${opts.commits.length})`,
    ...opts.commits.map((cl) => {
      const sp = cl.indexOf(" ");
      return sp === -1 ? `- \`${cl}\`` : `- \`${cl.slice(0, sp)}\` ${cl.slice(sp + 1)}`;
    }),
  ];
  return lines.join("\n");
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
