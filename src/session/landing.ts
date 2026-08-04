import fs from "node:fs";
import { awaitPrChecks, checksLine, failedChecks, type ChecksPolicy, type ChecksSummary } from "./checks.js";
import {
  ensurePr,
  fetchRemote,
  mergePr,
  patchPrMessage,
  pushFeatureBranch,
  remoteDevSha,
  requireForge,
  splitEvidence,
  updatePrEvidence,
  viewPr,
  findOpenPr,
  type PrMessagePatch,
  type PrPriorMessage,
  type PullRequest,
} from "./forge.js";
import {
  DEFAULT_FEATURE_BRANCH_TYPE,
  FEATURE_BRANCH_TYPES,
  branchExists,
  featureSlug,
  findFeatureWorktree,
  forgeOptions,
  git,
  isWorktreeDirty,
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
 *  worktree, push the rebased branch (force-with-lease — a rebase rewrites
 *  shas), open or reuse the PR into `dev`, and then READ that PR's GitHub checks
 *  (D-20260727-1). Returns `green` (checks passed, or the PR has none at all —
 *  an UNGATED ready), `conflict` (the rebase stopped; it is aborted and the
 *  branch restored byte-for-byte, and nothing is pushed), `failed` (a check went
 *  red), or `pending` (checks were still running when the bounded wait expired).
 *
 *  EXECUTE (executeLanding) — the gated merge. `gh pr merge --merge`, then a
 *  fetch, then teardown of the local worktree ONLY. Two live call sites, both a
 *  keystroke: landinggate's [m] over a feature_land review, and
 *  MergeQueue.mergeReadyHead, which the Ctrl-O panel's [m] fires on a ready
 *  queue head (D-20260724-12). The only path that reaches it with no keystroke
 *  at all is feature_merge_head in a session that HAS no panel (piped/non-TTY),
 *  where there is no key to press.
 *
 * CO RUNS NO BUILD AND NO TEST (D-20260727-1). It used to: a combined build+test
 * on the rebased worktree, from a command it had to guess. GitHub already runs
 * the real thing against the real combined state, and already blocks the merge
 * on it, so co reads that verdict instead of reproducing it. What co still owns
 * is the TEXTUAL half of the gate — the rebase onto the current `origin/dev` —
 * because that is git's question, not CI's. See checks.ts for why the guess had
 * to go and what each verdict means.
 *
 * WHY THE REBASE COMES FIRST: feature A green and feature B green does not make
 * A+B green — B may compile against code A just changed. The rebase puts the
 * feature on top of everything already landed, and GitHub's `pull_request`
 * workflows test a merge of the PR head with its base, so the checks that gate
 * the merge see exactly the tree `dev` will hold. That also makes landings
 * serial by nature: each prepare rebases onto whatever `origin/dev` is at that
 * moment, and executeLanding refuses a green that has gone stale (`origin/dev`
 * moved since the prepare — the A-green + B-green = red hole), sending the head
 * back for a fresh fetch/rebase/checks read.
 *
 * A RED STATE NOW REACHES THE FORGE, and must: the checks that judge it are the
 * forge's, and they cannot run on a PR that does not exist. So unlike the old
 * local build+test, a `failed` prepare has already pushed and opened its PR —
 * which is also where the captain and the resolver read what went wrong. Nothing
 * red ever MERGES; that guarantee is unchanged and lives in the queue's ready
 * gate and executeLanding's pins.
 *
 * THE CHECKED TIP IS THE MERGED TIP. The push publishes exactly the sha the
 * checks ran on, and before merging, the PR's head on the forge is compared
 * against that sha. A branch someone pushed to in between fails loudly instead
 * of merging something nobody checked.
 *
 * HARD MERGE RULES (enforced in forge.ts, restated because they are contracts):
 * always `--merge`, a real merge commit — never squash, never rebase-merge, so
 * the feature topology and the crew's per-job commits survive. Never
 * `--delete-branch`: refs are kept, only the local checkout is torn down.
 *
 * Safety posture: `main` is never read or written here. The local `dev` ref is
 * never read or written either — `origin/dev` is; the only local refs touched
 * are the feature branches co provisioned, resolved from their own worktrees
 * and never from their names (rebase in prepare, worktree teardown after the
 * merge), and `refs/remotes/*` (via fetch). Deterministic plumbing plus gh — no
 * model.
 */

export interface LandingOptions extends WorktreeOptions {
  /** How long co waits on the PR's CI checks, and how often it looks. Defaults
   *  live in checks.ts; tests inject a no-op sleep. */
  checks?: ChecksPolicy;
}

/** The pull request a prepare opened or reused — the thing the panel
 *  renders and the thing [m] merges. */
export interface LandingPullRequest {
  number: number;
  url: string;
  title: string;
  body: string;
  /** True when this prepare opened the PR; false when it refreshed one that was
   *  already open. */
  created: boolean;
  /** Present when this prepare rewrote the MESSAGE of a PR that was already
   *  open, because a message was passed on the call that drove it: what that
   *  pull request said immediately beforehand (D-20260804-1). Absent whenever
   *  nothing of the sort happened, which is the usual case. */
  messageReplaced?: PrPriorMessage;
}

/** Prepare succeeded: the feature is rebased onto devSha, the branch is pushed,
 *  the PR is open, and its checks came back green — or it has none at all, in
 *  which case this is still a ready head but an UNGATED one (`checks.ungated`),
 *  merged on the captain's judgment rather than on CI. executeLanding pins to
 *  featureSha AND devSha, so approval covers exactly this state. */
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
  /** What GitHub's checks said — the merge's evidence, including the ungated
   *  case. Absent only when there was nothing to land (no PR, so no checks). */
  checks?: ChecksSummary;
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

/** The rebase was clean, the branch is pushed and the PR is open — and one of
 *  its CI checks came back RED. The direct analog of the old red build+test:
 *  the head blocks and feature_resolve_head applies. The branch is deliberately
 *  left REBASED (not rolled back): the failure only exists on the combined tree,
 *  so a fix dispatch needs the worktree to hold exactly that tree. All feature
 *  work is preserved (same commits, replayed onto dev), and the PR stays open —
 *  it is where the failing run is read. */
export interface PrepareFailed {
  kind: "failed";
  feature: string;
  branch: string;
  /** The `origin/dev` tip the feature was rebased onto. */
  devSha: string;
  /** The rebased feature tip the checks ran on. */
  featureSha: string;
  /** The per-job commits the PR carries. */
  commits: string[];
  /** The checks read, including exactly which ones failed and where to read them. */
  checks: ChecksSummary;
  /** The PR the red checks ran on. Unlike a local build, a check cannot exist
   *  without a PR, so this is always present. */
  pr: LandingPullRequest;
}

/** The rebase was clean, the branch is pushed and the PR is open — and its CI
 *  checks were STILL RUNNING when co's bounded wait expired. Not a failure and
 *  not a green: the head simply waits, and re-processing it reads the checks
 *  again. Nothing is rolled back. */
export interface PreparePending {
  kind: "pending";
  feature: string;
  branch: string;
  devSha: string;
  featureSha: string;
  commits: string[];
  /** The checks as of the last read — which ones are still running. */
  checks: ChecksSummary;
  pr: LandingPullRequest;
}

export type PrepareResult = PrepareGreen | PrepareConflict | PrepareFailed | PreparePending;

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
 * its own worktree, push it, open or reuse its PR, and read that PR's GitHub
 * checks. Non-destructive to `dev` in every outcome; see the result types for
 * exactly what each leaves behind.
 *
 * Preconditions are thrown, not classified: a missing prerequisite (no gh, not
 * authenticated, no `origin/dev`), a feature with no worktree, a worktree not on
 * its branch, or one with uncommitted changes is a caller/lifecycle problem, not
 * a landing outcome — and throwing before touching anything trivially preserves
 * every invariant. The queue turns such a throw into a blocked head carrying the
 * message; the tool layer reports it verbatim.
 *
 * The branch is read off the feature's registered worktree, never derived from
 * its name: co lands the branch it actually provisioned, and a same-named branch
 * it did not create is not reachable from here.
 *
 * `authored` is the PR message the co wrote for this feature at enqueue time
 * (stored per slug in featurestore.ts and handed down by the queue). Each field
 * falls back independently to the mechanical composition below, and it is only
 * ever used to CREATE the pull request — an open PR's title and prose are the
 * captain's, and a stored message never rewrites them.
 *
 * `update` is the different thing that looks the same: the halves the co passed
 * on THIS call. Those DO reach an already-open pull request (D-20260804-1), and
 * the PR's prior title and body come back on the result so the caller can report
 * what was overwritten. The two are kept apart on purpose — if the stored message
 * were the one that wrote, every automatic re-processing would quietly revert a
 * captain's edit on GitHub, which is exactly what `authored` must not do.
 */
export async function prepareLanding(
  opts: LandingOptions,
  feature: string,
  authored?: AuthoredPrMessage,
  update?: AuthoredPrMessage,
): Promise<PrepareResult> {
  const r = resolveWorktreeOptions(opts);
  const forge = forgeOptions(opts);
  const slug = featureSlug(feature);

  const owned = await findFeatureWorktree(opts, feature);
  if (!owned || !fs.existsSync(owned.path)) {
    throw new Error(
      `feature '${feature}' (${slug}) has no worktree under ${r.baseDir}; dispatch it first or run reconcile`,
    );
  }
  const branch = owned.branch;
  if (!(await branchExists(r.repoPath, branch))) {
    throw new Error(`feature '${feature}' has no branch '${branch}' in ${r.repoPath}`);
  }
  const worktreePath = owned.path;
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
  const diff = await git(r.repoPath, ["diff", `${devSha}..${featureSha}`]);
  const log = await git(r.repoPath, ["log", "--reverse", "--format=%h %s", `${devSha}..${featureSha}`]);
  const commits = log.split("\n").map((l) => l.trim()).filter(Boolean);
  const green: PrepareGreen = { kind: "green", feature, branch, devSha, featureSha, diff, commits };
  // Nothing to land: don't push an empty branch or open a PR with no commits.
  // The caller (the queue) treats an empty green as "nothing to land".
  if (commits.length === 0) return green;

  // Publish first, THEN read the verdict. The checks that gate this merge are
  // GitHub's, run against this PR, so the PR has to exist before there is
  // anything to read (D-20260727-1). The evidence block is written twice for
  // that reason: once on create, saying the checks are the gate, and once more
  // below with what they actually said.
  const push = await pushFeatureBranch(forge, branch, featureSha);
  const evidenceOf = (checks?: ChecksSummary): string =>
    composeEvidence({ commits, devSha, featureSha, devRef: r.devRef, ...(checks ? { checks } : {}) });
  const message = composePrMessage({ feature, commits, branch, ...(authored ? { authored } : {}) });
  const patch = prMessagePatch(update);
  const ensured = await ensurePr(forge, {
    branch,
    title: message.title,
    body: message.body,
    evidence: evidenceOf(),
    ...(patch ? { update: patch } : {}),
  });

  // Wait out anything still running, within bounds. The grace window for "no
  // checks reported yet" applies only when this prepare actually published
  // something — that is the one moment GitHub might not have registered a
  // workflow run yet, and "not created yet" must never read as "no CI".
  const checks = await awaitPrChecks(forge, ensured.pr.number, opts.checks, {
    published: push.pushed || ensured.created,
  });
  const refreshed = await updatePrEvidence(forge, ensured.pr, evidenceOf(checks));
  const pr: LandingPullRequest = {
    number: refreshed.pr.number,
    url: refreshed.pr.url,
    title: refreshed.pr.title,
    body: refreshed.pr.body,
    created: ensured.created,
    ...(ensured.replaced ? { messageReplaced: ensured.replaced } : {}),
  };

  if (checks.verdict === "failed") {
    return { kind: "failed", feature, branch, devSha, featureSha, commits, checks, pr };
  }
  if (checks.verdict === "pending") {
    return { kind: "pending", feature, branch, devSha, featureSha, commits, checks, pr };
  }
  // passed, or none at all — an ungated ready, flagged as such on the summary.
  green.pushed = push.pushed;
  green.checks = checks;
  green.pr = pr;
  return green;
}

/**
 * The feature branch's tip AS IT IS RIGHT NOW, read from the local repo: no
 * fetch, no remote, no gh, nothing written.
 *
 * This is the staleness question a cached prepare result has to answer before it
 * can be served again (D-20260803-1). A PrepareGreen describes exactly ONE sha —
 * the tip it rebased, pushed, PR'd and read the checks on — so the moment the
 * branch moves off that sha the result describes nothing that exists, and "is
 * this head ready?" is the wrong question to be asking of it.
 *
 * Undefined when the branch cannot be read at all (deleted, repo gone, git
 * broken). That is deliberately NOT reported as "unchanged": an unanswerable
 * question is not a yes, and the caller re-processes rather than serving a green
 * nobody could verify.
 */
export async function branchTipSha(
  opts: WorktreeOptions,
  branch: string,
): Promise<string | undefined> {
  try {
    const r = resolveWorktreeOptions(opts);
    const res = await runGit(r.repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    const sha = res.stdout.trim();
    return res.code === 0 && sha ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** A message write that landed on an already-open pull request. */
export interface OpenPrMessageUpdate {
  /** The pull request as co left it. */
  pr: { number: number; url: string; title: string; body: string };
  /** What it said immediately before the write. Absent when the passed halves
   *  already matched the PR, in which case nothing was sent. */
  replaced?: PrPriorMessage;
}

/**
 * Write a PASSED PR message onto the feature branch's already-open pull request,
 * and report what it replaced — with NO git at all: no fetch, no rebase, no push,
 * no checks read (D-20260804-1).
 *
 * This is the whole of what a re-enqueue does when the branch has not moved. The
 * head's cached green still describes the sha the branch is on, so there is
 * nothing to re-derive and nothing to publish; the only thing that has changed is
 * the words, and the words are one `gh pr edit`. Rebasing and pushing a head that
 * is already green just to carry a sentence would drop it to awaiting-checks for
 * no reason at all.
 *
 * Returns undefined when the branch has no open PR — the message stays stored,
 * and the prepare that eventually opens the PR composes it in.
 */
export async function updateOpenPrMessage(
  opts: LandingOptions,
  branch: string,
  update: AuthoredPrMessage,
): Promise<OpenPrMessageUpdate | undefined> {
  const patch = prMessagePatch(update);
  if (!patch) return undefined;
  const forge = forgeOptions(opts);
  const existing = await findOpenPr(forge, branch);
  if (!existing) return undefined;
  const patched = await patchPrMessage(forge, existing, patch);
  return {
    pr: {
      number: patched.pr.number,
      url: patched.pr.url,
      title: patched.pr.title,
      body: patched.pr.body,
    },
    ...(patched.replaced ? { replaced: patched.replaced } : {}),
  };
}

/**
 * An authored message as a forge patch: normalised the same way a stored one is
 * (a one-line title, prose with any evidence fence stripped) and reduced to the
 * halves that actually carry text. Undefined when nothing usable was passed,
 * which is what makes an omitted — or blank — field mean "leave it alone" all the
 * way down to the pull request.
 */
function prMessagePatch(update?: AuthoredPrMessage): PrMessagePatch | undefined {
  if (!update) return undefined;
  const patch: PrMessagePatch = {};
  const title = authoredPrTitle(update.title);
  if (title) patch.title = title;
  const prose = authoredPrBody(update.body);
  if (prose) patch.prose = prose;
  return patch.title === undefined && patch.prose === undefined ? undefined : patch;
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

  // Same rule as prepare: the branch is the one this feature's own worktree has
  // checked out. No worktree, no landing.
  const owned = await findFeatureWorktree(opts, feature);
  if (!owned) {
    throw new Error(
      `feature '${feature}' has no worktree under ${r.baseDir}; re-provision it or run reconcile`,
    );
  }
  const branch = owned.branch;
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
  const teardown = await teardownWorktree(opts, feature, { keepBranch: true, branch });
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

/** The human half of a pull request: what co writes into it, and what the panel
 *  reads back out of it. */
export interface PrMessage {
  title: string;
  body: string;
}

/**
 * A PR message the CO WROTE, rather than one composed from the branch's shape.
 *
 * The co knows what a feature is for and what the crew actually built, so it is
 * the natural author of the pull request's message; the mechanical composition
 * below only ever knew the commit subjects and the feature handle, which reads
 * like the machine boilerplate it is. The co attaches this at `feature_enqueue`
 * — the single, once-per-landing moment a feature is declared done — and the
 * harness stores it per feature and consumes it here. No model call happens
 * anywhere in the queue.
 *
 * Both fields are optional and INDEPENDENT: whichever half is missing falls back
 * to the mechanical composition for that half alone.
 */
export interface AuthoredPrMessage {
  title?: string;
  body?: string;
}

/**
 * The whole composed message for a feature's PR, in ONE call. The rules live in
 * composePrTitle/composePrBody below; this is the seam that keeps them reachable
 * as a unit, so the message a head carries is composed in exactly one place and
 * anything that wants to show it back (the Ctrl-O queue tab, D-20260727-10) can
 * reuse the composition instead of re-deriving it and drifting.
 *
 * An authored message (`opts.authored`) wins per field; the mechanical rules are
 * the fallback for whatever it does not carry, so this stays the one composition
 * either way.
 */
export function composePrMessage(opts: {
  feature: string;
  commits: string[];
  branch?: string;
  authored?: AuthoredPrMessage;
}): PrMessage {
  const title = authoredPrTitle(opts.authored?.title);
  const body = authoredPrBody(opts.authored?.body);
  return {
    title: title ?? composePrTitle(opts.feature, opts.commits, opts.branch),
    body: body ? `${body}\n` : composePrBody({ feature: opts.feature, commits: opts.commits }),
  };
}

/**
 * Normalise an authored PR title: one line, collapsed whitespace, trimmed —
 * undefined when there is nothing usable. A title is a single line on GitHub, so
 * a stray newline is folded rather than passed through to gh.
 */
export function authoredPrTitle(raw?: string): string | undefined {
  const line = (raw ?? "").replace(/\s+/g, " ").trim();
  return line === "" ? undefined : line;
}

/**
 * Normalise an authored PR body to the human prose the evidence fence is
 * appended to, or "" when there is nothing usable.
 *
 * The fence strip is the load-bearing part. co's evidence block is regenerated on
 * every prepare and spliced onto the body (forge.ts spliceEvidence), so evidence
 * that leaked INTO the authored prose would be a second, frozen copy of the
 * checks and commits — stale the moment the head re-processes. Stripping it here,
 * with the same splitter the panel reads bodies back through, means the stored
 * message can only ever be prose. Applied at both ends: when the message is
 * stored, and again here, so a hand-edited store cannot smuggle a fence in.
 */
export function authoredPrBody(raw?: string): string {
  return splitEvidence(raw ?? "").prose.trim();
}

/**
 * The MECHANICAL PR title — the fallback for a feature the co did not author a
 * title for, and unchanged by that arrival.
 *
 * Written the way a person would write it. A single-commit branch
 * takes that commit's own subject (already a Conventional Commits line); a
 * multi-commit branch has no single honest subject, so it is titled
 * `<type>: <feature>` from the branch's own conventional type. Written once, at
 * create time — an update never overwrites it, so a captain who retitles the PR
 * on GitHub keeps their title.
 */
export function composePrTitle(feature: string, commits: string[], branch?: string): string {
  if (commits.length === 1) {
    const only = commits[0]!;
    const sp = only.indexOf(" ");
    const subject = sp === -1 ? "" : only.slice(sp + 1).trim();
    if (subject) return subject;
  }
  const name = feature.trim() || "feature";
  return `${branchType(branch)}: ${name.toLowerCase()}`;
}

/** The conventional type a branch carries (`fix/stale-token` → "fix"), falling
 *  back to the default for anything else — an older `co/feat-*` name, a branch
 *  with no prefix at all, or one whose prefix isn't a conventional type. */
function branchType(branch?: string): string {
  const slash = branch?.indexOf("/") ?? -1;
  const prefix = slash > 0 ? branch!.slice(0, slash) : "";
  return FEATURE_BRANCH_TYPES.find((t) => t === prefix) ?? DEFAULT_FEATURE_BRANCH_TYPE;
}

/** The MECHANICAL PR description — the fallback for a feature the co did not
 *  author a body for: a plain one-line summary of what the branch does, the way a
 *  developer opening a PR would write it. Everything volatile — the commit
 *  list, the checks result — lives in the evidence block below, so a
 *  re-processed head refreshes the numbers without touching this prose (or any
 *  the captain has since added around it). */
export function composePrBody(opts: { feature: string; commits: string[] }): string {
  const name = sentenceCase(opts.feature.trim() || "this branch");
  const summary = opts.commits.length > 1 ? `${name}, in ${opts.commits.length} commits.` : `${name}.`;
  return [summary, ``].join("\n");
}

/** Capitalise a feature handle for use as a sentence ("user auth" → "User
 *  auth"), leaving an already-capitalised or non-alphabetic start alone. */
function sentenceCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The fenced block co owns inside the PR body: what is in this branch, what it
 *  was rebased onto, and what the PR's own checks made of it. Rewritten on every
 *  prepare — and deliberately free of anything that changes on its own (no
 *  timings), so re-processing an unchanged head sends no edit at all. */
export function composeEvidence(opts: {
  commits: string[];
  devSha: string;
  featureSha: string;
  devRef: string;
  checks?: ChecksSummary;
}): string {
  const lines = [
    `### Checks`,
    checksEvidence(opts.checks),
    ``,
    `Rebased onto \`${opts.devRef}\` @ \`${opts.devSha.slice(0, 7)}\`; checked tip \`${opts.featureSha.slice(0, 7)}\`.`,
    ``,
    `### Commits (${opts.commits.length})`,
    ...opts.commits.map((cl) => {
      const sp = cl.indexOf(" ");
      return sp === -1 ? `- \`${cl}\`` : `- \`${cl.slice(0, sp)}\` ${cl.slice(sp + 1)}`;
    }),
  ];
  return lines.join("\n");
}

/** The checks line inside the evidence block. The no-checks case is stated in
 *  full rather than left blank: an ungated merge is a thing the captain should
 *  read on the PR, not a silence. */
function checksEvidence(checks?: ChecksSummary): string {
  if (!checks) {
    return `This pull request's own CI is the merge gate; the result lands here once it reports.`;
  }
  switch (checks.verdict) {
    case "none":
      return (
        `**ungated** — ${checksLine(checks)}. Merging it is a human judgment call; co has nothing to ` +
        `verify against.`
      );
    case "passed":
      return `**green** — ${checksLine(checks)}.`;
    case "failed": {
      const names = failedChecks(checks).map((r) => (r.link ? `[${r.name}](${r.link})` : `\`${r.name}\``));
      return `**red** — ${checks.failed} of ${checks.total} checks failed: ${names.join(", ")}.`;
    }
    case "pending":
      return `**pending** — ${checksLine(checks)} when co last looked.`;
  }
}
