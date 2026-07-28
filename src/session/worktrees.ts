import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { describeSpawnError, requireRemoteDev, spawnCommand, type CommandRunner } from "./forge.js";

/**
 * Git-worktree lifecycle for parallel dispatch — the lowest layer of the
 * feature-isolation scheme. Each "feature" gets its own worktree on a fresh
 * `<type>/<slug>` branch cut from `origin/dev`; a crew agent works there in
 * isolation, and higher layers later rebase the finished branch onto the fresh
 * `origin/dev`, build, test, push it, and land it through a GitHub pull request
 * behind a human gate. This module is only the hands: verify the remote
 * integration branch, provision a worktree, tear one down, and sweep up zombies
 * after a crash. Deterministic plumbing — no model.
 * The dispatch registry consumes provisionWorktree for its feature-scoped
 * dispatches (a crew process launched with cwd = the feature's worktree);
 * landing.ts (the rebase + PR + checks engine) consumes teardownWorktree
 * and the exported git helpers below.
 *
 * OWNERSHIP: which branches are co's. Feature branches carry ordinary
 * Conventional Commits prefixes (`feat/<slug>`, `fix/<slug>`, …), so the NAME
 * proves nothing — the captain's own `feat/login` must never be adopted,
 * rebuilt, or deleted as if co had cut it. The signal is the WORKTREE: co's
 * features are exactly the branches checked out in the worktrees co registered
 * directly under the managed base dir, one directory per slug. Every path that
 * writes (teardown, abandon) resolves a feature's branch from that worktree and
 * from nothing else. Branches co cuts are additionally marked in the repo's
 * local git config (`branch.<name>.comanager-feature = <slug>`), which outlives
 * the checkout and lets the READ-ONLY reconcile passes still recognise a branch
 * whose worktree is gone; the marker reports, it never authorises a deletion.
 * Branches from before conventional naming (`co/feat-<slug>`) are recognised by
 * that prefix too, so features an older build created stay manageable. Nothing
 * is ever renamed.
 *
 * Safety posture (the invariants everything below preserves):
 *  - `main` is human-only: nothing here writes to it, checks it out, or
 *    deletes it.
 *  - THE LOCAL `dev` REF IS NEVER WRITTEN, and never even read (D-20260724-13).
 *    `dev` is checked out in the captain's primary tree; the integration ref
 *    everything here compares against is the remote-tracking `origin/dev`,
 *    advanced only by `git fetch`. The only refs ever created are the feature
 *    branches co cuts itself.
 *  - A feature branch is deleted only on an explicit abandon, only when co owns
 *    it by the worktree rule above, and only when it is truly merged into
 *    `origin/dev` — a merge-base ancestor check, not `git branch -d`'s
 *    HEAD-relative one (HEAD is usually main here, so -d would misjudge).
 *    Unmerged work is kept and reported, never force-dropped. After a PR merge
 *    the branch ref is kept deliberately (teardown's `keepBranch`).
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
 * ISOLATION: a worktree owns its build output outright and may reach nothing
 * outside itself. A fresh checkout has sources only, so provision runs the
 * repo's OWN frozen install to populate node_modules/, and teardown deletes the
 * artifacts again before `git worktree remove` (untracked build output would
 * otherwise block the removal in a repo that does not gitignore it).
 *
 * An earlier build symlinked node_modules/ and dist/ back to the primary tree
 * to skip that install, and it cost a day of the captain's work. `npm ci`
 * begins by reading node_modules and deleting every entry it finds; through a
 * symlink those entries are the PRIMARY tree's, so one crew agent's routine
 * reinstall emptied the captain's dependencies, and the only surviving copy
 * went with the worktree at teardown. Two quieter faults rode along: every
 * worktree build wrote through the dist/ link into the primary's dist, which is
 * the dist the installed `co` actually runs, and a branch's own dependency
 * changes were invisible because it built against the primary's. Sharing one
 * writable directory between two trees is the defect; per-worktree installs are
 * the fix, and the seconds they cost are the price of all three.
 *
 * Git is invoked the way the rest of the dispatch layer shells out
 * (node:child_process spawn) but with an argv array and no shell, so branch
 * names and paths are never re-tokenized.
 */

/** The Conventional Commits types a feature branch may be prefixed with. The
 *  branch reads as a human's would: `feat/login`, `fix/stale-token`. */
export const FEATURE_BRANCH_TYPES = [
  "feat",
  "fix",
  "docs",
  "refactor",
  "chore",
  "test",
  "perf",
  "build",
  "ci",
  "style",
] as const;

export type FeatureBranchType = (typeof FEATURE_BRANCH_TYPES)[number];

/** The type a feature gets when none is supplied. */
export const DEFAULT_FEATURE_BRANCH_TYPE: FeatureBranchType = "feat";

/** The prefix co minted before conventional naming. RECOGNISED, never minted:
 *  existing `co/feat-*` features stay manageable and are never renamed. */
export const LEGACY_FEATURE_BRANCH_PREFIX = "co/feat-";

/** The git-config variable co stamps on a branch it cuts, under that branch's
 *  own section: `branch.<name>.comanager-feature = <slug>`. A durable, name-
 *  independent record that co created the ref, used by the read-only reconcile
 *  passes to still recognise a branch whose worktree has gone. It never
 *  authorises a delete — only a registered worktree does that. */
const OWNERSHIP_CONFIG_VAR = "comanager-feature";

const DEFAULT_DEV_BRANCH = "dev";
const DEFAULT_REMOTE = "origin";

/** Build output a worktree owns privately. NEVER shared with the primary tree:
 *  provision creates node_modules/ here with an install, teardown deletes both
 *  from the worktree, and the dirty check reads them as build output rather than
 *  user work. Order matters only for readability. */
const BUILD_ARTIFACTS = ["node_modules", "dist"] as const;

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
  /** The feature branch: `<type>/<slug>` for anything co cuts now, or whatever
   *  the feature's existing worktree is checked out on (a `co/feat-<slug>` from
   *  an older build). Always read from the worktree, never re-derived from the
   *  feature name. */
  branch: string;
  /** Absolute path of the feature's worktree under the managed base dir. */
  worktreePath: string;
  provisionStatus: ProvisionStatus;
  /** What became of the worktree's dependency install. Present on every record
   *  provision returns; absent on records rebuilt from an older store. A
   *  "failed" here is NOT a failed provision (see installDependencies) but it is
   *  the one thing a caller should surface rather than swallow. */
  dependencies?: DependencyInstall;
}

/** The outcome of a worktree's dependency install.
 *  - installed: the repo's own frozen install ran and succeeded.
 *  - present:   node_modules was already there; nothing to do.
 *  - skipped:   the repo has no lockfile to install from (or is not a Node
 *               package at all), so there is nothing co can honestly run.
 *  - failed:    the install ran and did not succeed. The worktree is still a
 *               valid checkout; its dependencies are simply not there yet. */
export interface DependencyInstall {
  status: "installed" | "present" | "skipped" | "failed";
  /** The command that ran, for the statuses where one did. */
  command?: string;
  /** Why, for the statuses that need a why. */
  reason?: string;
}

export interface WorktreeOptions {
  /** Absolute path of the primary repo (the tree `co link` registered). */
  repoPath: string;
  /** Managed home for feature worktrees, OUTSIDE the repo working tree.
   *  Defaults to a sibling of the repo: `<repo>-worktrees`. */
  baseDir?: string;
  /** The integration branch features are cut from and PR'd into. Default "dev".
   *  Always addressed through the remote (`<remote>/<devBranch>`) — the local
   *  ref of the same name is never read or written. */
  devBranch?: string;
  /** The remote carrying the integration branch. Default "origin". */
  remote?: string;
  /** Injected command runner for everything that touches the remote (fetch,
   *  push, gh). Tests pass a fake; production omits it. */
  run?: CommandRunner;
  /** Injected runner for the worktree's dependency install. A SECOND seam on
   *  purpose: `run` is the remote's, and the fake forge behind it answers every
   *  command with success, which would turn a test of the install into a test of
   *  nothing. Production omits both and gets spawnCommand. */
  installRun?: CommandRunner;
}

export interface ResolvedWorktreeOptions {
  repoPath: string;
  baseDir: string;
  devBranch: string;
  remote: string;
  /** The remote-tracking integration ref, e.g. "origin/dev". THE base for every
   *  cut, rebase and ancestor check in the feature flow. */
  devRef: string;
  run?: CommandRunner;
  installRun?: CommandRunner;
}

/** The default managed worktree home: a sibling dir of the repo. */
export function defaultWorktreeBase(repoPath: string): string {
  const r = path.resolve(repoPath);
  return path.join(path.dirname(r), `${path.basename(r)}-worktrees`);
}

export function resolveWorktreeOptions(opts: WorktreeOptions): ResolvedWorktreeOptions {
  const repoPath = path.resolve(opts.repoPath);
  const baseDir = opts.baseDir ? path.resolve(opts.baseDir) : defaultWorktreeBase(repoPath);
  // A base inside the repo would litter the working tree with nested checkouts;
  // refuse it outright rather than let a config typo degrade the repo.
  if (baseDir === repoPath || baseDir.startsWith(repoPath + path.sep)) {
    throw new Error(`worktree base ${baseDir} must live outside the repo working tree ${repoPath}`);
  }
  const devBranch = opts.devBranch ?? DEFAULT_DEV_BRANCH;
  const remote = opts.remote ?? DEFAULT_REMOTE;
  return {
    repoPath,
    baseDir,
    devBranch,
    remote,
    devRef: `${remote}/${devBranch}`,
    ...(opts.run ? { run: opts.run } : {}),
    ...(opts.installRun ? { installRun: opts.installRun } : {}),
  };
}

/** The ForgeOptions any of these options resolve to — the one place the two
 *  option shapes are bridged, so no caller hand-assembles a forge config. */
export function forgeOptions(opts: WorktreeOptions): {
  repoPath: string;
  remote: string;
  devBranch: string;
  run?: CommandRunner;
} {
  const r = resolveWorktreeOptions(opts);
  return {
    repoPath: r.repoPath,
    remote: r.remote,
    devBranch: r.devBranch,
    ...(r.run ? { run: r.run } : {}),
  };
}

// --- naming ------------------------------------------------------------------

/** Slug a feature name for use in a branch and directory name: lowercase,
 *  alphanumeric runs joined by single dashes, capped at 48 chars. Throws when
 *  nothing survives — a branch named `feat/` would be a footgun. */
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

/** Validate a caller-supplied branch type against the Conventional Commits set,
 *  tolerating case and surrounding space. An absent type is the default (feat);
 *  anything outside the set is refused by name rather than silently coerced —
 *  the branch is a durable artifact and a typo'd prefix would outlive the call. */
export function normalizeFeatureType(type?: string): FeatureBranchType {
  const t = (type ?? "").trim().toLowerCase();
  if (!t) return DEFAULT_FEATURE_BRANCH_TYPE;
  const match = FEATURE_BRANCH_TYPES.find((v) => v === t);
  if (!match) {
    throw new Error(
      `unknown branch type ${JSON.stringify(type)}; use one of ${FEATURE_BRANCH_TYPES.join(", ")}`,
    );
  }
  return match;
}

/** The branch a NEW feature is cut on: `<type>/<slug>`, e.g. `feat/user-auth`.
 *  This mints a name; it does not identify an existing feature. Never use it to
 *  decide a branch is co's — see findFeatureWorktree for that. */
export function featureBranch(feature: string, type?: string): string {
  return `${normalizeFeatureType(type)}/${featureSlug(feature)}`;
}

/** The pre-conventional name for a feature: `co/feat-<slug>`. Only used to
 *  recognise (and refuse to clobber) branches an older build cut. */
export function legacyFeatureBranch(feature: string): string {
  return `${LEGACY_FEATURE_BRANCH_PREFIX}${featureSlug(feature)}`;
}

/** Where a feature's checkout lives: `<baseDir>/<slug>`. This path IS the
 *  ownership signal — a registered worktree here is co's, whatever its branch
 *  is called. */
export function featureWorktreePath(opts: WorktreeOptions, feature: string): string {
  const r = resolveWorktreeOptions(opts);
  return path.join(r.baseDir, featureSlug(feature));
}

// --- git plumbing ------------------------------------------------------------

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git with an argv array (no shell), collecting output. Never throws on a
 *  nonzero exit — callers that need the code (ancestor checks, existence
 *  probes) read it; `git()` below wraps this for must-succeed calls. */
export function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    // A cwd that does not exist raises the same ENOENT as a missing git binary;
    // describeSpawnError is what keeps the two apart. See its comment.
    child.on("error", (e) => reject(describeSpawnError(e as NodeJS.ErrnoException, "git", cwd)));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout: out, stderr: err }));
  });
}

/** Run git and throw with the command and stderr on failure. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const res = await runGit(cwd, args);
  if (res.code !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${res.code}: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res.stdout;
}

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const res = await runGit(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  return res.code === 0;
}

/** Whether ANY ref resolves — used for the remote-tracking integration ref
 *  (`origin/dev`), which is not under refs/heads and so is not a branchExists. */
export async function refExists(repoPath: string, ref: string): Promise<boolean> {
  const res = await runGit(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return res.code === 0 && res.stdout.trim() !== "";
}

/** Whether `branch` is fully contained in `target` — the guard that decides a
 *  feature branch is safe to delete. Exit 1 from --is-ancestor means "no", any
 *  other nonzero is a real error (a missing ref, say) and throws. */
export async function isMergedInto(repoPath: string, branch: string, target: string): Promise<boolean> {
  const res = await runGit(repoPath, ["merge-base", "--is-ancestor", branch, target]);
  if (res.code === 0) return true;
  if (res.code === 1) return false;
  throw new Error(`git merge-base --is-ancestor ${branch} ${target} exited ${res.code}: ${res.stderr.trim()}`);
}

export interface WorktreeEntry {
  path: string;
  /** Full ref (`refs/heads/...`), or null for a detached/bare entry. */
  branch: string | null;
}

/** Parse `git worktree list --porcelain`. The primary tree is the first entry;
 *  detached worktrees carry no branch line and parse as branch: null. */
export async function listWorktrees(repoPath: string): Promise<WorktreeEntry[]> {
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

// --- the linked repo ---------------------------------------------------------

/** What a repoPath turned out to be. `toplevel` is set on the one failure that
 *  has a mechanical fix — a path INSIDE a repo — so a caller can offer the root
 *  instead of just refusing. */
export type RepoPathCheck =
  | { ok: true; repoPath: string }
  | { ok: false; reason: string; toplevel?: string };

/**
 * Is this a usable `repoPath` — the value `co link` stores and every git call in
 * the feature layer runs as its cwd?
 *
 * WHY THIS EXISTS. `repoPath` was trusted from config all the way down to
 * `spawn(..., { cwd })`, so a bad one first surfaced as an ENOENT out of git
 * plumbing at boot, and an ENOENT that (see describeSpawnError) is indis-
 * tinguishable from a missing git. One corrupted value therefore presented as a
 * broken toolchain. It is checked once, up front, where the value is entered and
 * where a session opens, and the answer says what is wrong in the config's terms.
 *
 * THE ROOT IS REQUIRED, not merely somewhere inside the repo, and that is not
 * fussiness. `defaultWorktreeBase` derives the managed worktree home as a
 * SIBLING of repoPath, so a repoPath of `<repo>/frontend` puts the base at
 * `<repo>/frontend-worktrees` — inside the real working tree, which is precisely
 * what this module's WORKTREE HOME rule forbids. `resolveWorktreeOptions` cannot
 * catch that: it compares the base against repoPath alone, and
 * `frontend-worktrees` is not under `frontend/`. Only the git toplevel closes it,
 * and only an async caller can ask git for it. So the invariant is enforced here,
 * at the two entry points, rather than at every use.
 */
export async function checkRepoPath(repoPath: string): Promise<RepoPathCheck> {
  const raw = repoPath.trim();
  if (!raw) return { ok: false, reason: "no repo path is linked" };
  const resolved = path.resolve(raw);
  const st = await fsp.stat(resolved).catch(() => null);
  if (!st) return { ok: false, reason: `${resolved} does not exist` };
  if (!st.isDirectory()) return { ok: false, reason: `${resolved} is not a directory` };

  const top = await runGit(resolved, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || !top.stdout.trim()) {
    return { ok: false, reason: `${resolved} is not a git repository` };
  }
  const toplevel = top.stdout.trim();
  if (!samePath(toplevel, resolved)) {
    return {
      ok: false,
      toplevel,
      reason:
        `${resolved} is inside a git repository but is not its root (${toplevel}). ` +
        `Feature worktrees are created as a sibling of the linked path, so a subdirectory ` +
        `would put them inside the repo's own working tree.`,
    };
  }
  return { ok: true, repoPath: resolved };
}

// --- ownership ---------------------------------------------------------------
//
// The whole of "is this branch co's?" lives here. Nothing below reads a branch
// NAME to answer it: a feature is a registered worktree sitting directly under
// the managed base dir, and its branch is whatever that worktree has checked
// out. A human's `feat/login` in their own tree is invisible to every function
// in this file.

/** One feature as it exists on disk: the checkout co registered, the slug its
 *  directory is named for, and the branch it is actually on. */
export interface FeatureWorktree {
  /** Absolute path of the checkout, as git reports it. */
  path: string;
  /** The directory's own name, which is the feature slug. */
  slug: string;
  /** The branch checked out there — the ONLY authority on a feature's branch. */
  branch: string;
}

/**
 * Every worktree co owns: the registered worktrees that sit DIRECTLY under the
 * managed base dir with a branch checked out. That containment is the ownership
 * test — co created the base dir and puts exactly one checkout per feature in
 * it, so a worktree there is co's by construction, whatever its branch is
 * called, and a worktree anywhere else is not co's however it is named.
 *
 * The primary tree is skipped explicitly (a base dir configured as the repo's
 * parent would otherwise sweep the repo itself in), and so is any detached
 * checkout, which has no branch to manage.
 */
export async function listFeatureWorktrees(opts: WorktreeOptions): Promise<FeatureWorktree[]> {
  const r = resolveWorktreeOptions(opts);
  const base = realpathOr(r.baseDir);
  const out: FeatureWorktree[] = [];
  for (const entry of await listWorktrees(r.repoPath)) {
    if (samePath(entry.path, r.repoPath)) continue;
    const branch = entry.branch?.startsWith("refs/heads/")
      ? entry.branch.slice("refs/heads/".length)
      : null;
    if (!branch) continue;
    const dir = realpathOr(entry.path);
    if (path.dirname(dir) !== base) continue;
    out.push({ path: entry.path, slug: path.basename(dir), branch });
  }
  return out;
}

/** The worktree co owns for a feature (matched by slug, i.e. by directory), or
 *  null when co has no checkout for it. Every caller that is about to act on a
 *  feature's branch resolves it through here. */
export async function findFeatureWorktree(
  opts: WorktreeOptions,
  feature: string,
): Promise<FeatureWorktree | null> {
  const slug = featureSlug(feature);
  const all = await listFeatureWorktrees(opts);
  return all.find((w) => w.slug === slug) ?? null;
}

/** Stamp the ownership marker on a branch co just cut. Written to the repo's
 *  local config, which is shared by every worktree and outlives all of them.
 *  Best-effort on purpose: the marker only feeds read-only reporting, and the
 *  worktree it describes already exists by the time this runs, so a config that
 *  cannot be written must not turn a completed provision into a half-state. */
async function markOwnedBranch(repoPath: string, branch: string, slug: string): Promise<void> {
  try {
    await runGit(repoPath, ["config", "--local", `branch.${branch}.${OWNERSHIP_CONFIG_VAR}`, slug]);
  } catch {
    // Nothing to do: the worktree is the ownership signal that matters.
  }
}

/**
 * The branches co cut that still exist, by the two name-independent signals:
 * the config marker co stamps at provision time, and the legacy `co/feat-*`
 * prefix from before conventional naming. READ-ONLY use only — this feeds the
 * reconcile passes that REPORT a branch whose worktree has gone. A delete is
 * never authorised from here; only a registered worktree authorises that.
 *
 * `git branch -D` drops the whole `branch.<name>` config section with the ref,
 * so a marker cannot outlive its branch through co's own paths; a ref deleted
 * some other way is filtered out against the live ref list anyway.
 */
export async function listOwnedFeatureBranches(
  opts: WorktreeOptions,
): Promise<{ branch: string; slug: string }[]> {
  const r = resolveWorktreeOptions(opts);
  const live = new Set(
    (await git(r.repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const found = new Map<string, string>();

  const marked = await runGit(r.repoPath, [
    "config",
    "--local",
    "--get-regexp",
    `^branch\\..*\\.${OWNERSHIP_CONFIG_VAR}$`,
  ]);
  // Exit 1 is "no matches", which is simply a repo with no marked branches.
  if (marked.code === 0) {
    const suffix = `.${OWNERSHIP_CONFIG_VAR}`;
    for (const line of marked.stdout.split("\n")) {
      const sp = line.indexOf(" ");
      const key = (sp === -1 ? line : line.slice(0, sp)).trim();
      const value = sp === -1 ? "" : line.slice(sp + 1).trim();
      if (!key.startsWith("branch.") || !key.endsWith(suffix)) continue;
      const branch = key.slice("branch.".length, key.length - suffix.length);
      if (!branch || !live.has(branch)) continue;
      found.set(branch, value || branch.slice(branch.lastIndexOf("/") + 1));
    }
  }

  for (const branch of live) {
    if (!branch.startsWith(LEGACY_FEATURE_BRANCH_PREFIX)) continue;
    if (!found.has(branch)) found.set(branch, branch.slice(LEGACY_FEATURE_BRANCH_PREFIX.length));
  }

  return [...found].map(([branch, slug]) => ({ branch, slug }));
}

// --- build artifacts ---------------------------------------------------------

/** The first non-empty line of a command's output, trimmed and bounded: an
 *  install failure's headline, not its transcript. Empty when there is none. */
function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > 160 ? line.slice(0, 157) + "…" : line;
}

/** The install a repo asks for, read off the lockfile it commits.
 *
 *  FROZEN in every case, deliberately: an install that rewrites the lockfile
 *  would leave the worktree dirty, the safety rules read dirty as user work, and
 *  the worktree would then block its own teardown forever. A repo with no
 *  lockfile — or no package.json at all, since `co link` takes any repo — gets
 *  nothing. Guessing an install that writes to the tree is worse than leaving
 *  the crew agent to install as part of its own work. */
function detectInstall(repoPath: string): { command: string; args: string[] } | null {
  const has = (f: string) => fs.existsSync(path.join(repoPath, f));
  if (!has("package.json")) return null;
  if (has("pnpm-lock.yaml")) return { command: "pnpm", args: ["install", "--frozen-lockfile"] };
  if (has("bun.lockb") || has("bun.lock")) return { command: "bun", args: ["install", "--frozen-lockfile"] };
  // Berry renamed the flag. .yarnrc.yml is the marker that a repo is on it.
  if (has("yarn.lock")) {
    const flag = has(".yarnrc.yml") ? "--immutable" : "--frozen-lockfile";
    return { command: "yarn", args: ["install", flag] };
  }
  if (has("package-lock.json")) return { command: "npm", args: ["ci"] };
  return null;
}

/** Give a fresh worktree its OWN dependencies, with the repo's own install.
 *
 *  This is what replaced symlinking node_modules/ back to the primary tree; the
 *  module header records what that cost. Nothing here reads, writes or resolves
 *  any path outside `worktreePath`.
 *
 *  BEST EFFORT. A failed install is reported, never fatal: the worktree is a
 *  perfectly valid checkout either way, the crew agent installs as part of its
 *  work, and refusing to provision a feature over a cold npm cache or a flaky
 *  registry would be a worse trade than handing back a checkout that needs one
 *  command. Idempotent: dependencies already in place are left alone. */
async function installDependencies(
  r: ResolvedWorktreeOptions,
  worktreePath: string,
): Promise<DependencyInstall> {
  const install = detectInstall(r.repoPath);
  if (!install) return { status: "skipped", reason: "no lockfile to install from" };
  if (fs.existsSync(path.join(worktreePath, "node_modules"))) {
    return { status: "present", reason: "node_modules was already provisioned" };
  }
  const command = `${install.command} ${install.args.join(" ")}`;
  const runner = r.installRun ?? spawnCommand;
  // spawnCommand rejects only when the binary is missing; a nonzero exit comes
  // back as a result. Both are the same thing here: no dependencies, say so.
  const res = await runner(install.command, install.args, worktreePath).catch((e: unknown) => ({
    code: -1,
    stdout: "",
    stderr: e instanceof Error ? e.message : String(e),
  }));
  if (res.code === 0) return { status: "installed", command };
  const detail = firstLine(res.stderr) || firstLine(res.stdout) || `exited ${res.code}`;
  return { status: "failed", command, reason: detail };
}

/** Delete a doomed worktree's build output, so `git worktree remove` (which
 *  refuses a tree holding untracked files) can do its job in a repo that does
 *  not gitignore node_modules/ or dist/.
 *
 *  BOTH SHAPES ARE HANDLED because both exist on disk: a real directory, which
 *  is what provision creates now and which is removed outright, and a SYMLINK,
 *  which is what an older build left pointing at the primary tree and which is
 *  only unlinked. The link is never followed. fs.rm does not traverse one
 *  anyway, but the two cases are split explicitly because getting this wrong is
 *  precisely how the primary tree gets destroyed.
 *
 *  Scoped to BUILD_ARTIFACTS inside the worktree. Nothing else is touched and
 *  `--force` is never handed to git. */
async function removeBuildArtifacts(worktreePath: string): Promise<void> {
  for (const name of BUILD_ARTIFACTS) {
    const target = path.join(worktreePath, name);
    const st = await fsp.lstat(target).catch(() => null);
    if (!st) continue;
    if (st.isSymbolicLink()) await fsp.unlink(target);
    else await fsp.rm(target, { recursive: true, force: true });
  }
}

/** Whether a worktree holds user work: any status entry that is not build
 *  output. A whole untracked node_modules/ or dist/ is provisioning, not work,
 *  and in a repo that doesn't gitignore them every provisioned worktree would
 *  otherwise read as dirty forever and never be tearable down.
 *
 *  Only the DIRECTORY ITSELF is excused. Git reports an untracked directory as
 *  one entry ("dist/"), while a modified tracked file under it is reported by
 *  its own path ("dist/app.js"), which does not match and still counts as work.
 *  So a repo that commits its build output is judged normally. */
export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const out = await git(worktreePath, ["status", "--porcelain"]);
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    // Porcelain v1: two status chars, a space, then the path.
    const entryPath = line.slice(3).replace(/\/$/, "");
    if ((BUILD_ARTIFACTS as readonly string[]).includes(entryPath)) continue;
    return true;
  }
  return false;
}

// --- lifecycle ---------------------------------------------------------------

/**
 * Verify the integration branch is reachable on the remote, freshening the
 * remote-tracking ref first. This REPLACED an earlier `ensureDevBranch` that
 * created a local `dev` off `main` (D-20260724-13): co no longer owns `dev` in
 * any sense — it neither creates it nor writes it. `dev` lives on the forge,
 * features are cut from `origin/dev`, and they land on it through a pull
 * request. A repo with no `origin/dev` is a clean, actionable refusal, not
 * something for co to invent.
 */
export async function ensureRemoteDevBranch(
  opts: WorktreeOptions,
): Promise<{ devRef: string; devBranch: string }> {
  const r = resolveWorktreeOptions(opts);
  await requireRemoteDev(forgeOptions(opts));
  return { devRef: r.devRef, devBranch: r.devBranch };
}

/**
 * Provision a feature: a new worktree at `<baseDir>/<slug>` on a fresh
 * `<type>/<slug>` branch cut from the freshly-fetched `origin/dev`, with its own
 * dependencies installed into it. Verifies the remote integration branch first,
 * so a repo that can't support the flow fails here with a clear message instead
 * of halfway through a landing. `type` is a Conventional Commits type (default
 * feat) and is validated before anything is created.
 *
 * NOTHING IS EVER LINKED OUT OF THE WORKTREE. Neither node_modules/ nor dist/ is
 * a symlink into the primary tree, whether the install runs or not — see the
 * module header for what that link cost. The install is the only artifact this
 * creates directly, and a `prepare` script (this repo has one) may build dist/
 * inside the worktree as part of it; both are the worktree's own directories.
 *
 * Idempotent for an already-provisioned feature: the existing worktree is
 * returned AS IT IS — on whatever branch it holds, including a `co/feat-*` one
 * an older build cut — and its dependencies are installed if they are missing.
 * Nothing is renamed and no second branch is minted for a feature that already
 * has a checkout.
 *
 * Any other collision — a leftover branch of either naming scheme without its
 * worktree, an occupied path — throws with a pointer at reconcile/teardown
 * rather than guessing which half-state to destroy.
 */
export async function provisionWorktree(
  opts: WorktreeOptions,
  feature: string,
  extra: { type?: string } = {},
): Promise<FeatureRecord> {
  const r = resolveWorktreeOptions(opts);
  const slug = featureSlug(feature);
  const branch = featureBranch(feature, extra.type);
  const worktreePath = featureWorktreePath(opts, feature);

  await ensureRemoteDevBranch(opts);

  // Ownership is the worktree, so idempotency asks the worktree — not the name
  // a fresh provision would have picked.
  const existing = await findFeatureWorktree(opts, feature);
  if (existing) {
    if (!samePath(existing.path, worktreePath) || !fs.existsSync(existing.path)) {
      throw new Error(
        `feature '${feature}' already has a worktree registered at ${existing.path}; ` +
          `run reconcile or teardown before re-provisioning`,
      );
    }
    const dependencies = await installDependencies(r, worktreePath);
    return {
      feature,
      slug,
      branch: existing.branch,
      worktreePath,
      provisionStatus: "ready",
      dependencies,
    };
  }
  // Both naming schemes are checked. The conventional name may be the captain's
  // own branch, which co must not cut over or adopt; a bare `co/feat-<slug>` is
  // a feature an older build left behind, and minting a second branch for the
  // same slug would silently orphan it. Either way: refuse, destroy nothing.
  for (const taken of [branch, legacyFeatureBranch(feature)]) {
    if (await branchExists(r.repoPath, taken)) {
      throw new Error(
        `branch '${taken}' already exists and is not a feature co provisioned; ` +
          `run reconcile or teardown first, or use a different name or type`,
      );
    }
  }
  if (fs.existsSync(worktreePath)) {
    throw new Error(`worktree path ${worktreePath} is already occupied; run reconcile first`);
  }

  await fsp.mkdir(r.baseDir, { recursive: true });
  // Cut from the remote-tracking ref, never a local `dev`: the feature must be
  // based on what the forge actually has, and `--no-track` keeps the new branch
  // from adopting `origin/dev` as its upstream (it pushes to its own name).
  await git(r.repoPath, ["worktree", "add", worktreePath, "-b", branch, "--no-track", r.devRef]);
  await markOwnedBranch(r.repoPath, branch, slug);
  const dependencies = await installDependencies(r, worktreePath);
  return { feature, slug, branch, worktreePath, provisionStatus: "ready", dependencies };
}

export interface TeardownResult {
  branch: string;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  /** Set when the branch was kept: it holds work not merged into dev. */
  branchKeptReason?: string;
}

/**
 * Tear a feature down: remove its worktree, prune stale worktree metadata, and
 * — unless told to keep it — delete its branch. Tolerant of an already-removed
 * worktree (a second teardown is a no-op reporting false on both flags).
 *
 * `keepBranch` is how a LANDED feature is torn down (D-20260724-13): the PR
 * merged the branch on the forge, so the branch ref is deliberately kept and
 * only the local checkout goes away. Nothing here ever passes `--delete-branch`
 * to gh either — the remote ref is the forge's and the captain's.
 *
 * Two things it will NOT do: remove a worktree with uncommitted changes
 * (`git worktree remove` without --force refuses, and the refusal is
 * surfaced, not overridden) and, on an abandon, delete a branch that isn't
 * fully merged into `origin/dev` — the merge-base ancestor check is the guard,
 * and only a branch that passes it is deleted (with -D, because -d judges
 * against HEAD, which is the primary tree's branch). An unmerged branch is kept
 * and named in the result.
 *
 * WHICH BRANCH IT ACTS ON is never guessed from the feature name. It is the one
 * the feature's registered worktree has checked out; failing that (the checkout
 * is already gone) the caller's own record via `extra.branch`; failing that the
 * legacy `co/feat-<slug>`, which is a name only co ever minted. A conventional
 * `<type>/<slug>` is never assumed, so a human branch that happens to match a
 * feature's slug is not reachable from here.
 */
export async function teardownWorktree(
  opts: WorktreeOptions,
  feature: string,
  extra: { keepBranch?: boolean; branch?: string } = {},
): Promise<TeardownResult> {
  const r = resolveWorktreeOptions(opts);

  const owned = await findFeatureWorktree(opts, feature);
  const branch = owned?.branch ?? extra.branch ?? legacyFeatureBranch(feature);

  let worktreeRemoved = false;
  if (owned && fs.existsSync(owned.path)) {
    await removeBuildArtifacts(owned.path);
    await git(r.repoPath, ["worktree", "remove", owned.path]);
    worktreeRemoved = true;
  }
  // Prune BEFORE the branch delete: a crashed run can leave metadata for a
  // worktree whose directory is gone, and git refuses to delete a branch it
  // still believes is checked out there.
  await git(r.repoPath, ["worktree", "prune"]);

  let branchDeleted = false;
  let branchKeptReason: string | undefined;
  if (await branchExists(r.repoPath, branch)) {
    if (extra.keepBranch) {
      branchKeptReason = `branch '${branch}' is kept by policy; only its worktree was removed`;
    } else {
      const devExists = await refExists(r.repoPath, r.devRef);
      if (devExists && (await isMergedInto(r.repoPath, branch, r.devRef))) {
        await git(r.repoPath, ["branch", "-D", branch]);
        branchDeleted = true;
      } else {
        branchKeptReason = devExists
          ? `branch '${branch}' has commits not merged into '${r.devRef}'`
          : `no '${r.devRef}' ref to verify the merge against`;
      }
    }
  }
  return { branch, worktreeRemoved, branchDeleted, ...(branchKeptReason ? { branchKeptReason } : {}) };
}

export interface ReconcileReport {
  /** Zombie worktrees removed (registered, clean, and under the managed base —
   *  i.e. co's own). */
  removedWorktrees: string[];
  /** Feature branches deleted. Since branch refs are kept after a PR merge
   *  (D-20260724-13) this sweep deletes none and the list stays empty; it is
   *  retained so a caller's reporting shape does not change. */
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
 *  2. Registered worktrees co owns (directly under the managed base): remove
 *     the clean ones; a worktree with uncommitted work is kept (reported).
 *     Everything else — the primary tree, anything detached, any worktree the
 *     captain made elsewhere — is never touched, whatever its branch is called.
 *  3. Branches co cut (config marker, or the legacy prefix) with no remaining
 *     worktree: KEPT, and reported. Branch refs outlive their worktrees by
 *     policy now that features land through a PR (D-20260724-13) — a merged
 *     branch is the normal steady state, not a zombie — so this pass deletes
 *     nothing. No other ref is ever considered either way.
 *  4. Stray directories under the managed base that git no longer knows about
 *     (registration lost mid-crash): removed only after verifying the dir's
 *     `.git` file points into THIS repo's worktree metadata; anything else in
 *     the base dir is kept and reported.
 *
 * `keep` names features (by name or slug) or full branch names to leave alone —
 * the seam for a future caller with in-flight features.
 */
export async function reconcileWorktrees(
  opts: WorktreeOptions,
  extra: { keep?: string[] } = {},
): Promise<ReconcileReport> {
  const r = resolveWorktreeOptions(opts);
  // A keep entry is a branch name if it looks like one (branches are prefixed,
  // slugs never contain a slash); otherwise it names a feature.
  const keepBranches = new Set((extra.keep ?? []).filter((k) => k.includes("/")));
  const keepSlugs = new Set(
    (extra.keep ?? []).filter((k) => !k.includes("/")).map((k) => safeFeatureSlug(k)).filter(Boolean),
  );
  const report: ReconcileReport = { removedWorktrees: [], removedBranches: [], removedStrays: [], kept: [] };

  await git(r.repoPath, ["worktree", "prune"]);

  // Pass 2: the worktrees co owns.
  for (const entry of await listFeatureWorktrees(opts)) {
    if (keepBranches.has(entry.branch) || keepSlugs.has(entry.slug)) {
      report.kept.push({ ref: entry.branch, reason: "listed as in-flight" });
      continue;
    }
    if (!fs.existsSync(entry.path)) continue; // pruned above; defensive
    if (await isWorktreeDirty(entry.path)) {
      report.kept.push({ ref: entry.path, reason: "worktree has uncommitted work" });
      continue;
    }
    await removeBuildArtifacts(entry.path);
    await git(r.repoPath, ["worktree", "remove", entry.path]);
    report.removedWorktrees.push(entry.path);
  }

  // Pass 3: feature branches left with no worktree. Kept either way — a branch
  // whose PR has merged is kept on purpose, and an unmerged one holds work.
  const remaining = await listWorktrees(r.repoPath);
  const stillAttached = new Set(remaining.map((w) => w.branch).filter((b): b is string => b !== null));
  const devExists = await refExists(r.repoPath, r.devRef);
  for (const { branch, slug } of await listOwnedFeatureBranches(opts)) {
    if (keepBranches.has(branch) || keepSlugs.has(slug)) continue;
    if (stillAttached.has(`refs/heads/${branch}`)) continue;
    if (!devExists) {
      report.kept.push({ ref: branch, reason: `no '${r.devRef}' ref to verify the merge against` });
      continue;
    }
    report.kept.push({
      ref: branch,
      reason: (await isMergedInto(r.repoPath, branch, r.devRef))
        ? `landed in '${r.devRef}'; branch refs are kept`
        : `not merged into '${r.devRef}'`,
    });
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

// --- boot reconcile (non-destructive) ----------------------------------------

/** Slug a name without throwing, so a degenerate keep entry is ignored rather
 *  than blowing up a sweep. */
function safeFeatureSlug(name: string): string {
  try {
    return featureSlug(name);
  } catch {
    return "";
  }
}

/** What a boot reconcile could not cleanly account for. Every anomaly is
 *  SURFACED for a human/the co to resolve; reconcileFeatures never acts on one. */
export type FeatureAnomalyKind =
  /** A branch co cut, with no worktree, that is NOT merged into `origin/dev`:
   *  it holds unmerged work but its checkout is gone (a crashed run, a manually-
   *  removed worktree). Re-provision or investigate before the work is lost.
   *
   *  Its counterpart — a branch with no worktree that IS contained in
   *  `origin/dev` — is NOT an anomaly any more (D-20260724-13). That is exactly
   *  what a landed feature looks like: the PR merged, the worktree was torn down,
   *  the branch ref was kept on purpose. Reporting it would mean flagging every
   *  feature ever landed on every boot. */
  | "branch-without-worktree"
  /** A directory under the managed base that git does not list as a worktree:
   *  an orphaned checkout (registration lost) or something foreign. Never ours
   *  to delete blindly, so it is reported for a human to judge. */
  | "stray-directory";

export interface FeatureAnomaly {
  kind: FeatureAnomalyKind;
  /** The branch name or directory path the anomaly concerns. */
  ref: string;
  /** A one-line human-readable account of what was found and what it implies. */
  detail: string;
}

export interface FeatureReconcileReport {
  /** Feature records rebuilt from the worktrees on disk, keyed by slug (the
   *  original human name is not recoverable from a directory, so `feature` is
   *  set to the slug). Ready to seed the in-memory registry. */
  records: FeatureRecord[];
  /** Everything that could not be turned into a clean record. Surfaced, never
   *  destroyed. */
  anomalies: FeatureAnomaly[];
}

/**
 * Boot reconcile: rebuild the in-memory feature picture from what is actually on
 * disk, so a feature (1 feature → 1 worktree → 1 branch) survives a session
 * restart. This is the READ counterpart to reconcileWorktrees' crash-cleanup
 * sweep, and it is deliberately NON-DESTRUCTIVE: it prunes only git's own stale
 * metadata (directories already gone), never removes a branch, worktree, or
 * directory, and reports anything it can't cleanly account for as an anomaly for
 * a human to resolve.
 *
 * Why not reuse reconcileWorktrees at boot: that sweep removes every clean
 * feature worktree not in its `keep` list. At boot the in-memory feature map is
 * empty, so it would tear down every in-progress feature — the exact opposite
 * of surviving a restart.
 *
 *  - Every worktree co owns (registered, directly under the managed base) whose
 *    directory exists becomes a ready record, on whatever branch it holds. That
 *    is what makes a feature survive a restart without co ever having to guess
 *    an ownership prefix — and what keeps a `co/feat-*` feature from an older
 *    build manageable under exactly the same rules.
 *  - A branch co cut with no worktree is an anomaly ONLY when it is not
 *    contained in `origin/dev` (`branch-without-worktree`: unmerged work whose
 *    checkout is gone). A branch that IS contained is a landed feature whose ref
 *    was kept by policy — the normal state, reported as nothing at all. A branch
 *    co did NOT cut is not co's business and is never reported at all.
 *  - A directory under the managed base that git doesn't list as a worktree is a
 *    `stray-directory` anomaly (an orphaned checkout or something foreign).
 */
export async function reconcileFeatures(opts: WorktreeOptions): Promise<FeatureReconcileReport> {
  const r = resolveWorktreeOptions(opts);
  const records: FeatureRecord[] = [];
  const anomalies: FeatureAnomaly[] = [];

  // Clear metadata for worktrees whose directory is already gone. This is the
  // only mutation reconcileFeatures makes, and it touches nothing real — it just
  // stops a deleted dir from masquerading as a live worktree below.
  await git(r.repoPath, ["worktree", "prune"]);

  const worktrees = await listWorktrees(r.repoPath);
  const devExists = await refExists(r.repoPath, r.devRef);

  // Pass 1: the worktrees co owns → a ready record each.
  const registeredPaths = new Set(worktrees.map((w) => realpathOr(w.path)));
  const attached = new Set(
    worktrees
      .map((w) => w.branch)
      .filter((b): b is string => Boolean(b?.startsWith("refs/heads/")))
      .map((b) => b.slice("refs/heads/".length)),
  );
  for (const entry of await listFeatureWorktrees(opts)) {
    if (!fs.existsSync(entry.path)) continue; // pruned above; defensive
    records.push({
      feature: entry.slug,
      slug: entry.slug,
      branch: entry.branch,
      worktreePath: entry.path,
      provisionStatus: "ready",
    });
  }

  // Pass 2: branches co cut that have no worktree.
  for (const { branch } of await listOwnedFeatureBranches(opts)) {
    if (attached.has(branch)) continue;
    // Contained in origin/dev = landed, worktree torn down, ref kept by policy.
    // That is the resting state of every feature co has ever landed; silence.
    if (devExists && (await isMergedInto(r.repoPath, branch, r.devRef))) continue;
    anomalies.push({
      kind: "branch-without-worktree",
      ref: branch,
      detail: devExists
        ? `branch '${branch}' has commits not in '${r.devRef}' but its worktree is gone — ` +
          `unmerged work whose checkout was lost. Re-provision or investigate before dropping it.`
        : `branch '${branch}' exists with no worktree and there is no '${r.devRef}' to compare against.`,
    });
  }

  // Pass 3: directories under the managed base git doesn't list as worktrees.
  if (fs.existsSync(r.baseDir)) {
    for (const name of await fsp.readdir(r.baseDir)) {
      const dir = path.join(r.baseDir, name);
      if (registeredPaths.has(realpathOr(dir))) continue;
      const st = await fsp.lstat(dir).catch(() => null);
      if (!st?.isDirectory()) continue;
      const ours = await isOrphanedFeatureWorktree(dir, r.repoPath);
      anomalies.push({
        kind: "stray-directory",
        ref: dir,
        detail: ours
          ? `${dir} looks like an orphaned worktree of this repo (its registration was lost). ` +
            `Left in place; a human should confirm before removing it.`
          : `${dir} sits in the worktree base but git does not track it as a worktree. Left untouched.`,
      });
    }
  }

  return { records, anomalies };
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
