import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";

/**
 * Git-worktree lifecycle for parallel dispatch — the lowest layer of the
 * feature-isolation scheme. Each "feature" gets its own worktree on a fresh
 * `co/feat-<slug>` branch cut from the `dev` integration branch; a crew agent
 * works there in isolation, and higher layers later rebase the finished branch
 * onto dev, build, test, and merge behind a human gate. This module is only
 * the hands: ensure dev exists, provision a worktree, tear one down, and sweep
 * up zombies after a crash. Deterministic plumbing — no model, no network —
 * and NOT yet wired into the live dispatch flow.
 *
 * Safety posture (the invariants everything below preserves):
 *  - `main` is human-only: nothing here writes to it, checks it out, or
 *    deletes it. It is read exactly once, as the base for creating `dev`.
 *  - The only ref ever created besides `co/feat-*` branches is `dev`
 *    (create-only, off main); the only refs ever deleted are `co/feat-*`.
 *  - A branch is deleted only when it is truly merged into dev — a merge-base
 *    ancestor check, not `git branch -d`'s HEAD-relative one (HEAD is usually
 *    main here, so -d would misjudge). Unmerged work is kept and reported,
 *    never force-dropped.
 *  - A worktree with uncommitted changes is never removed: teardown throws,
 *    reconcile keeps it with a reason.
 *
 * WORKTREE HOME: worktrees live in a managed directory OUTSIDE the repo's
 * working tree — one inside it would show up as untracked files and confuse
 * every tool that walks the tree. Default: a sibling of the repo named
 * `<repo>-worktrees` (e.g. ~/code/app → ~/code/app-worktrees), so it is
 * per-repo, survives reboots (unlike a tmpdir), and is obvious in a file
 * listing. Override with `baseDir`; a base inside the repo is rejected.
 *
 * BUILDABILITY: a fresh worktree checks out sources only — node_modules/ and
 * dist/ are gitignored, so it wouldn't build without an install. Instead of
 * reinstalling per feature, provision symlinks both from the primary tree
 * (when they exist there). The links are this module's own artifacts:
 * teardown and reconcile unlink them before `git worktree remove` (a
 * non-ignored symlink would read as an untracked file and block removal), and
 * the dirty check sees through them so they never make a worktree look like
 * it holds user work.
 *
 * Git is invoked the way the rest of the dispatch layer shells out
 * (node:child_process spawn) but with an argv array and no shell, so branch
 * names and paths are never re-tokenized.
 */

export const FEATURE_BRANCH_PREFIX = "co/feat-";
const DEFAULT_DEV_BRANCH = "dev";
const DEFAULT_BASE_BRANCH = "main";

/** The build artifacts provision links from the primary tree so a worktree is
 *  buildable without an install. Order matters only for readability. */
const LINKED_ARTIFACTS = ["node_modules", "dist"] as const;

/** Where a feature's provision stands. This module returns "ready" (provision
 *  completed) or throws; "provisioning" and "failed" exist for higher layers
 *  that record a provision before/after awaiting it, "removed" for after a
 *  teardown. */
export type ProvisionStatus = "provisioning" | "ready" | "failed" | "removed";

/** The minimal per-feature record higher layers (the dispatch registry) track:
 *  where the feature's isolated checkout lives and on which branch. */
export interface FeatureRecord {
  /** The feature name as given — the human handle. */
  feature: string;
  /** The slug derived from the name; the branch and worktree dir both use it. */
  slug: string;
  /** The feature branch, always `co/feat-<slug>`. */
  branch: string;
  /** Absolute path of the feature's worktree under the managed base dir. */
  worktreePath: string;
  provisionStatus: ProvisionStatus;
}

export interface WorktreeOptions {
  /** Absolute path of the primary repo (the tree `co link` registered). */
  repoPath: string;
  /** Managed home for feature worktrees, OUTSIDE the repo working tree.
   *  Defaults to a sibling of the repo: `<repo>-worktrees`. */
  baseDir?: string;
  /** The integration branch features are cut from. Default "dev". */
  devBranch?: string;
  /** The branch dev is created off when missing. Default "main"; never
   *  written, only read. */
  baseBranch?: string;
}

interface ResolvedOptions {
  repoPath: string;
  baseDir: string;
  devBranch: string;
  baseBranch: string;
}

/** The default managed worktree home: a sibling dir of the repo. */
export function defaultWorktreeBase(repoPath: string): string {
  const r = path.resolve(repoPath);
  return path.join(path.dirname(r), `${path.basename(r)}-worktrees`);
}

function resolveOptions(opts: WorktreeOptions): ResolvedOptions {
  const repoPath = path.resolve(opts.repoPath);
  const baseDir = opts.baseDir ? path.resolve(opts.baseDir) : defaultWorktreeBase(repoPath);
  // A base inside the repo would litter the working tree with nested checkouts;
  // refuse it outright rather than let a config typo degrade the repo.
  if (baseDir === repoPath || baseDir.startsWith(repoPath + path.sep)) {
    throw new Error(`worktree base ${baseDir} must live outside the repo working tree ${repoPath}`);
  }
  return {
    repoPath,
    baseDir,
    devBranch: opts.devBranch ?? DEFAULT_DEV_BRANCH,
    baseBranch: opts.baseBranch ?? DEFAULT_BASE_BRANCH,
  };
}

// --- naming ------------------------------------------------------------------

/** Slug a feature name for use in a branch and directory name: lowercase,
 *  alphanumeric runs joined by single dashes, capped at 48 chars. Throws when
 *  nothing survives — a branch named `co/feat-` would be a footgun. */
export function featureSlug(feature: string): string {
  const slug = feature
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  if (!slug) throw new Error(`feature name ${JSON.stringify(feature)} yields an empty slug`);
  return slug;
}

/** The branch a feature lives on: `co/feat-<slug>`. */
export function featureBranch(feature: string): string {
  return `${FEATURE_BRANCH_PREFIX}${featureSlug(feature)}`;
}

// --- git plumbing ------------------------------------------------------------

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git with an argv array (no shell), collecting output. Never throws on a
 *  nonzero exit — callers that need the code (ancestor checks, existence
 *  probes) read it; `git()` below wraps this for must-succeed calls. */
function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout: out, stderr: err }));
  });
}

/** Run git and throw with the command and stderr on failure. */
async function git(cwd: string, args: string[]): Promise<string> {
  const res = await runGit(cwd, args);
  if (res.code !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${res.code}: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res.stdout;
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const res = await runGit(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  return res.code === 0;
}

/** Whether `branch` is fully contained in `target` — the guard that decides a
 *  feature branch is safe to delete. Exit 1 from --is-ancestor means "no", any
 *  other nonzero is a real error (a missing ref, say) and throws. */
async function isMergedInto(repoPath: string, branch: string, target: string): Promise<boolean> {
  const res = await runGit(repoPath, ["merge-base", "--is-ancestor", branch, target]);
  if (res.code === 0) return true;
  if (res.code === 1) return false;
  throw new Error(`git merge-base --is-ancestor ${branch} ${target} exited ${res.code}: ${res.stderr.trim()}`);
}

interface WorktreeEntry {
  path: string;
  /** Full ref (`refs/heads/...`), or null for a detached/bare entry. */
  branch: string | null;
}

/** Parse `git worktree list --porcelain`. The primary tree is the first entry;
 *  detached worktrees carry no branch line and parse as branch: null. */
async function listWorktrees(repoPath: string): Promise<WorktreeEntry[]> {
  const out = await git(repoPath, ["worktree", "list", "--porcelain"]);
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: null };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length);
    }
  }
  if (current) entries.push(current);
  return entries;
}

/** Realpath when the path exists, resolve otherwise — path comparisons must
 *  survive macOS's /var → /private/var symlink, which makes git report a
 *  different spelling of the same directory than the caller passed in. */
function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function samePath(a: string, b: string): boolean {
  return realpathOr(a) === realpathOr(b);
}

// --- build-artifact links ----------------------------------------------------

/** Symlink node_modules/ (and dist/ if present) from the primary tree into the
 *  worktree so it builds without an install. Skips anything already present in
 *  the worktree — never replaces real content with a link. Idempotent. */
async function linkArtifacts(repoPath: string, worktreePath: string): Promise<void> {
  for (const name of LINKED_ARTIFACTS) {
    const source = path.join(repoPath, name);
    const target = path.join(worktreePath, name);
    if (!fs.existsSync(source)) continue;
    const existing = await fsp.lstat(target).catch(() => null);
    if (existing) continue;
    await fsp.symlink(source, target, "dir");
  }
}

/** Remove the artifact links this module created (and only links — a real dir
 *  named node_modules is someone's work and stays). Run before
 *  `git worktree remove`: a non-ignored symlink counts as an untracked file
 *  and would block the removal. */
async function unlinkArtifacts(worktreePath: string): Promise<void> {
  for (const name of LINKED_ARTIFACTS) {
    const target = path.join(worktreePath, name);
    const st = await fsp.lstat(target).catch(() => null);
    if (st?.isSymbolicLink()) await fsp.unlink(target);
  }
}

/** Whether a worktree holds user work: any status entry that is not one of our
 *  own artifact symlinks. The links are provisioning plumbing, not work — in a
 *  repo that doesn't gitignore them they'd show as untracked and make every
 *  provisioned worktree read as dirty forever. */
async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const out = await git(worktreePath, ["status", "--porcelain"]);
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    // Porcelain v1: two status chars, a space, then the path.
    const entryPath = line.slice(3).replace(/\/$/, "");
    if ((LINKED_ARTIFACTS as readonly string[]).includes(entryPath)) {
      const st = await fsp.lstat(path.join(worktreePath, entryPath)).catch(() => null);
      if (st?.isSymbolicLink()) continue;
    }
    return true;
  }
  return false;
}

// --- lifecycle ---------------------------------------------------------------

/**
 * Ensure the `dev` integration branch exists, creating it off `main` when
 * missing. Create-only and idempotent: an existing dev is never moved, and
 * main is only ever read. No checkout happens — `git branch dev main` writes
 * a ref, nothing else.
 */
export async function ensureDevBranch(opts: WorktreeOptions): Promise<{ created: boolean; devBranch: string }> {
  const r = resolveOptions(opts);
  if (await branchExists(r.repoPath, r.devBranch)) return { created: false, devBranch: r.devBranch };
  if (!(await branchExists(r.repoPath, r.baseBranch))) {
    throw new Error(
      `cannot create '${r.devBranch}': base branch '${r.baseBranch}' does not exist in ${r.repoPath}`,
    );
  }
  await git(r.repoPath, ["branch", r.devBranch, r.baseBranch]);
  return { created: true, devBranch: r.devBranch };
}

/**
 * Provision a feature: a new worktree at `<baseDir>/<slug>` on a fresh
 * `co/feat-<slug>` branch cut from dev, with build artifacts symlinked from
 * the primary tree. Ensures dev first, so this works on a repo that has never
 * seen the flow.
 *
 * Idempotent for an already-provisioned feature (same branch, same path): the
 * existing worktree is returned, artifacts re-linked. Any OTHER collision — a
 * leftover branch without its worktree, the worktree registered elsewhere, an
 * occupied path — throws with a pointer at reconcile/teardown rather than
 * guessing which half-state to destroy.
 */
export async function provisionWorktree(opts: WorktreeOptions, feature: string): Promise<FeatureRecord> {
  const r = resolveOptions(opts);
  const slug = featureSlug(feature);
  const branch = `${FEATURE_BRANCH_PREFIX}${slug}`;
  const worktreePath = path.join(r.baseDir, slug);

  await ensureDevBranch(r);

  const existing = (await listWorktrees(r.repoPath)).find((w) => w.branch === `refs/heads/${branch}`);
  if (existing) {
    if (!samePath(existing.path, worktreePath) || !fs.existsSync(existing.path)) {
      throw new Error(
        `feature '${feature}' already has a worktree registered at ${existing.path}; ` +
          `run reconcile or teardown before re-provisioning`,
      );
    }
    await linkArtifacts(r.repoPath, worktreePath);
    return { feature, slug, branch, worktreePath, provisionStatus: "ready" };
  }
  if (await branchExists(r.repoPath, branch)) {
    throw new Error(`branch '${branch}' already exists without a worktree; run reconcile or teardown first`);
  }
  if (fs.existsSync(worktreePath)) {
    throw new Error(`worktree path ${worktreePath} is already occupied; run reconcile first`);
  }

  await fsp.mkdir(r.baseDir, { recursive: true });
  await git(r.repoPath, ["worktree", "add", worktreePath, "-b", branch, r.devBranch]);
  await linkArtifacts(r.repoPath, worktreePath);
  return { feature, slug, branch, worktreePath, provisionStatus: "ready" };
}

export interface TeardownResult {
  branch: string;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  /** Set when the branch was kept: it holds work not merged into dev. */
  branchKeptReason?: string;
}

/**
 * Tear a feature down: remove its worktree, delete its branch, prune stale
 * worktree metadata. Tolerant of an already-removed worktree (a second
 * teardown is a no-op reporting false on both flags).
 *
 * Two things it will NOT do: remove a worktree with uncommitted changes
 * (`git worktree remove` without --force refuses, and the refusal is
 * surfaced, not overridden) and delete a branch that isn't fully merged into
 * dev — the merge-base ancestor check is the guard, and only a branch that
 * passes it is deleted (with -D, because -d judges against HEAD, which is the
 * primary tree's branch, not dev). An unmerged branch is kept and named in
 * the result.
 */
export async function teardownWorktree(opts: WorktreeOptions, feature: string): Promise<TeardownResult> {
  const r = resolveOptions(opts);
  const slug = featureSlug(feature);
  const branch = `${FEATURE_BRANCH_PREFIX}${slug}`;

  let worktreeRemoved = false;
  const entry = (await listWorktrees(r.repoPath)).find((w) => w.branch === `refs/heads/${branch}`);
  if (entry && fs.existsSync(entry.path)) {
    await unlinkArtifacts(entry.path);
    await git(r.repoPath, ["worktree", "remove", entry.path]);
    worktreeRemoved = true;
  }
  // Prune BEFORE the branch delete: a crashed run can leave metadata for a
  // worktree whose directory is gone, and git refuses to delete a branch it
  // still believes is checked out there.
  await git(r.repoPath, ["worktree", "prune"]);

  let branchDeleted = false;
  let branchKeptReason: string | undefined;
  if (await branchExists(r.repoPath, branch)) {
    const devExists = await branchExists(r.repoPath, r.devBranch);
    if (devExists && (await isMergedInto(r.repoPath, branch, r.devBranch))) {
      await git(r.repoPath, ["branch", "-D", branch]);
      branchDeleted = true;
    } else {
      branchKeptReason = devExists
        ? `branch '${branch}' has commits not merged into '${r.devBranch}'`
        : `no '${r.devBranch}' branch to verify the merge against`;
    }
  }
  return { branch, worktreeRemoved, branchDeleted, ...(branchKeptReason ? { branchKeptReason } : {}) };
}

export interface ReconcileReport {
  /** Zombie worktrees removed (registered, clean, co/feat-* only). */
  removedWorktrees: string[];
  /** co/feat-* branches deleted — each verified merged into dev first. */
  removedBranches: string[];
  /** Unregistered leftover dirs removed from the managed base (each verified
   *  to be one of our orphaned worktrees before deletion). */
  removedStrays: string[];
  /** Everything deliberately left alone, with why. */
  kept: { ref: string; reason: string }[];
}

/**
 * Startup sweep: detect and clean what a crashed run left behind. Safe to run
 * any time — every removal is guarded, and anything questionable is kept and
 * reported instead of deleted.
 *
 * Four passes:
 *  1. `git worktree prune` — clears metadata whose directory is already gone.
 *  2. Registered `co/feat-*` worktrees: remove the clean ones; a worktree with
 *     uncommitted work is kept (reported). Non-feature worktrees — the primary
 *     tree, anything detached, any user worktree — are never touched.
 *  3. `co/feat-*` branches with no remaining worktree: deleted only when
 *     merged into dev (which includes the freshly-provisioned-then-crashed
 *     case, where the branch still equals dev). Unmerged branches are kept.
 *     No other ref is ever considered.
 *  4. Stray directories under the managed base that git no longer knows about
 *     (registration lost mid-crash): removed only after verifying the dir's
 *     `.git` file points into THIS repo's worktree metadata; anything else in
 *     the base dir is kept and reported.
 *
 * `keep` names features (or full `co/feat-*` branch names) to leave alone —
 * the seam for a future caller with in-flight features.
 */
export async function reconcileWorktrees(
  opts: WorktreeOptions,
  extra: { keep?: string[] } = {},
): Promise<ReconcileReport> {
  const r = resolveOptions(opts);
  const keepBranches = new Set(
    (extra.keep ?? []).map((k) => (k.startsWith(FEATURE_BRANCH_PREFIX) ? k : featureBranch(k))),
  );
  const report: ReconcileReport = { removedWorktrees: [], removedBranches: [], removedStrays: [], kept: [] };

  await git(r.repoPath, ["worktree", "prune"]);

  // Pass 2: registered feature worktrees.
  for (const entry of await listWorktrees(r.repoPath)) {
    const branch = entry.branch?.startsWith("refs/heads/") ? entry.branch.slice("refs/heads/".length) : null;
    if (!branch || !branch.startsWith(FEATURE_BRANCH_PREFIX)) continue;
    if (keepBranches.has(branch)) {
      report.kept.push({ ref: branch, reason: "listed as in-flight" });
      continue;
    }
    if (!fs.existsSync(entry.path)) continue; // pruned above; defensive
    if (await isWorktreeDirty(entry.path)) {
      report.kept.push({ ref: entry.path, reason: "worktree has uncommitted work" });
      continue;
    }
    await unlinkArtifacts(entry.path);
    await git(r.repoPath, ["worktree", "remove", entry.path]);
    report.removedWorktrees.push(entry.path);
  }

  // Pass 3: feature branches left with no worktree.
  const remaining = await listWorktrees(r.repoPath);
  const stillAttached = new Set(remaining.map((w) => w.branch).filter((b): b is string => b !== null));
  const devExists = await branchExists(r.repoPath, r.devBranch);
  const refsOut = await git(r.repoPath, [
    "for-each-ref",
    "--format=%(refname:short)",
    `refs/heads/${FEATURE_BRANCH_PREFIX}*`,
  ]);
  for (const branch of refsOut.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (keepBranches.has(branch) || stillAttached.has(`refs/heads/${branch}`)) continue;
    if (!devExists) {
      report.kept.push({ ref: branch, reason: `no '${r.devBranch}' branch to verify the merge against` });
      continue;
    }
    if (await isMergedInto(r.repoPath, branch, r.devBranch)) {
      await git(r.repoPath, ["branch", "-D", branch]);
      report.removedBranches.push(branch);
    } else {
      report.kept.push({ ref: branch, reason: `not merged into '${r.devBranch}'` });
    }
  }

  // Pass 4: unregistered leftovers in the managed base dir.
  if (fs.existsSync(r.baseDir)) {
    const registered = new Set(remaining.map((w) => realpathOr(w.path)));
    for (const name of await fsp.readdir(r.baseDir)) {
      const dir = path.join(r.baseDir, name);
      if (registered.has(realpathOr(dir))) continue;
      const st = await fsp.lstat(dir).catch(() => null);
      if (!st?.isDirectory() || !(await isOrphanedFeatureWorktree(dir, r.repoPath))) {
        report.kept.push({ ref: dir, reason: "not one of this repo's worktrees; not removing" });
        continue;
      }
      await fsp.rm(dir, { recursive: true, force: true });
      report.removedStrays.push(dir);
    }
  }

  await git(r.repoPath, ["worktree", "prune"]);
  return report;
}

/** Whether a directory is one of OUR orphaned worktrees: its `.git` file (a
 *  linked worktree has a file, not a dir) names a gitdir under this repo's
 *  .git/worktrees/. This is the guard before reconcile rm -rf's anything the
 *  registry no longer lists — a dir that fails it is reported, never deleted. */
async function isOrphanedFeatureWorktree(dir: string, repoPath: string): Promise<boolean> {
  const gitFile = path.join(dir, ".git");
  const st = await fsp.lstat(gitFile).catch(() => null);
  if (!st?.isFile()) return false;
  const content = (await fsp.readFile(gitFile, "utf8").catch(() => "")).trim();
  const m = /^gitdir:\s*(.+)$/.exec(content);
  if (!m) return false;
  const gitdir = realpathOr(path.resolve(dir, m[1]!));
  // The metadata dir may itself be gone (that is what orphaned it), so compare
  // against both spellings of the repo's metadata root.
  const metaRoot = path.join(repoPath, ".git", "worktrees");
  return (
    gitdir.startsWith(metaRoot + path.sep) || gitdir.startsWith(realpathOr(metaRoot) + path.sep)
  );
}
