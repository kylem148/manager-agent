import { spawn } from "node:child_process";

/**
 * The forge layer: everything that talks to the REMOTE — `git fetch`, `git push`,
 * and the GitHub CLI. It exists because co no longer merges features into `dev`
 * locally (D-20260724-13). `dev` is checked out in the captain's primary tree, so
 * a local merge means writing a ref git refuses to let us write while it is
 * checked out; and a local-only `dev` is a lie the moment the repo has a remote.
 * Features now integrate the way humans do: rebase onto the fresh `origin/dev`,
 * push the branch, open a PR, and merge that PR server-side.
 *
 * THE SHAPE. Every command — git and gh alike — goes through one injectable
 * `CommandRunner`. That is the module's whole design: one seam, so the entire
 * remote surface can be unit-tested with no network, no gh binary, and no
 * fixture repo pretending to be GitHub. Production passes nothing and gets
 * `spawnCommand`; tests pass a fake and assert on the exact argv.
 *
 * It is also where co READS the merge gate rather than being it (D-20260727-1):
 * `gh pr checks` reports what GitHub's own CI made of the PR, and that is the
 * only build/test verdict in the whole flow. co runs no suite of its own.
 *
 * HARD RULES encoded here, not left to callers:
 *  - the merge is ALWAYS `gh pr merge --merge` — a MERGE COMMIT. Never --squash,
 *    never --rebase: the feature-branch topology is the point (D-20260723-9), and
 *    a squash would destroy the per-job commits the crew wrote.
 *  - `--delete-branch` is NEVER passed. Branch refs are kept after a merge; only
 *    the local worktree checkout is torn down.
 *  - pushes are `--force-with-lease` against the sha we actually observed, because
 *    a rebase rewrites shas and a blind `--force` would clobber whatever moved
 *    under us. A branch the remote has never seen is a plain create, no force.
 *  - nothing here checks out, pulls, or resets anything. The only local refs it
 *    writes are remote-tracking refs, via `git fetch`. The captain's `dev`
 *    checkout is never touched.
 */

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** How forge runs a command. `command` is the binary ("git" / "gh"), `args` an
 *  argv array (never a shell string — branch names and PR bodies are data). */
export type CommandRunner = (command: string, args: string[], cwd: string) => Promise<CommandResult>;

/** The real runner: spawn with an argv array and no shell, collecting output.
 *  Never throws on a nonzero exit — callers read the code. */
export const spawnCommand: CommandRunner = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) => reject(e));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

export interface ForgeOptions {
  /** The primary repo. Every command runs with this as cwd, which is also how
   *  `gh` resolves which GitHub repo it is talking about. */
  repoPath: string;
  /** The remote that carries the integration branch. Default "origin". */
  remote: string;
  /** The integration branch on the remote — PRs target it. Default "dev". */
  devBranch: string;
  /** Injected for tests; production omits it and gets spawnCommand. */
  run?: CommandRunner;
}

/** A prereq check's answer. `reason` is written for the captain, not a log: it
 *  says what is missing AND what to do about it. */
export type PrereqCheck = { ok: true } | { ok: false; reason: string };

/** One pull request as co reads it back from gh. */
export interface PullRequest {
  number: number;
  url: string;
  title: string;
  body: string;
  /** The sha at the PR's head on the FORGE — what a merge would actually merge.
   *  Compared against the locally-tested tip before any merge. */
  headRefOid?: string;
  baseRefName?: string;
  state?: string;
}

/** What ensurePr did, so a caller can report it honestly. */
export interface PrEnsureResult {
  pr: PullRequest;
  /** True when this call created the PR; false when one was already open. */
  created: boolean;
}

/** What updatePrEvidence did. */
export interface PrEvidenceResult {
  pr: PullRequest;
  /** True when the body actually changed and was sent; false when the evidence
   *  was already identical and nothing was written. */
  bodyUpdated: boolean;
}

/** gh's own bucketing of one check's state, straight off `gh pr checks --json`:
 *  it collapses the many GitHub states into five. */
export type CheckBucket = "pass" | "fail" | "pending" | "skipping" | "cancel";

/** One CI check on a pull request, as gh reports it. */
export interface CheckRun {
  name: string;
  bucket: CheckBucket;
  /** GitHub's raw state (SUCCESS, FAILURE, IN_PROGRESS, …). */
  state: string;
  /** Where a human reads the run. Surfaced so a red check is one click away. */
  link?: string;
  workflow?: string;
  description?: string;
}

/** One read of a PR's checks. */
export interface PrChecksRead {
  /** Every check the gate should consider, or NULL when the forge reported no
   *  checks at all on this PR. Null is not an error: a repo with no CI is
   *  ungated, and that is a state to surface, not to fail on. */
  runs: CheckRun[] | null;
  /** True when branch protection defines required checks and these are only
   *  those; false when this is every check reported on the PR. */
  requiredOnly: boolean;
}

/** The remote-tracking ref for the integration branch (`origin/dev`). Every
 *  rebase, diff base and staleness check in the landing engine uses this — never
 *  the local `dev`, which co does not read and never writes. */
export function devRef(o: Pick<ForgeOptions, "remote" | "devBranch">): string {
  return `${o.remote}/${o.devBranch}`;
}

function runner(o: ForgeOptions): CommandRunner {
  return o.run ?? spawnCommand;
}

async function exec(o: ForgeOptions, command: string, args: string[]): Promise<CommandResult> {
  return runner(o)(command, args, o.repoPath);
}

/** Run and throw with the command and stderr on a nonzero exit. */
async function execOrThrow(o: ForgeOptions, command: string, args: string[]): Promise<string> {
  const res = await exec(o, command, args);
  if (res.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${res.code}: ${res.stderr.trim() || res.stdout.trim()}`,
    );
  }
  return res.stdout;
}

// --- prerequisites -----------------------------------------------------------

/**
 * Can we reach the remote integration branch at all? A remote named `<remote>`
 * must exist and, after a fetch, `<remote>/<devBranch>` must resolve.
 *
 * co deliberately does NOT create `dev` on the remote when it is missing: that
 * would be co inventing the integration branch of someone's repo. It says so and
 * stops.
 */
export async function checkRemotePrereqs(o: ForgeOptions): Promise<PrereqCheck> {
  const remote = await exec(o, "git", ["remote", "get-url", o.remote]);
  if (remote.code !== 0) {
    return {
      ok: false,
      reason:
        `no '${o.remote}' remote in ${o.repoPath} — co integrates features through GitHub pull requests, ` +
        `so the repo needs a remote. Add one with \`git remote add ${o.remote} <url>\`.`,
    };
  }
  const fetched = await exec(o, "git", ["fetch", o.remote]);
  if (fetched.code !== 0) {
    return {
      ok: false,
      reason: `\`git fetch ${o.remote}\` failed: ${fetched.stderr.trim() || fetched.stdout.trim()}`,
    };
  }
  const ref = await exec(o, "git", ["rev-parse", "--verify", "--quiet", `refs/remotes/${devRef(o)}`]);
  if (ref.code !== 0 || !ref.stdout.trim()) {
    return {
      ok: false,
      reason:
        `no '${devRef(o)}' branch on the remote. Features integrate by opening a pull request into ` +
        `'${o.devBranch}', so that branch has to exist on ${o.remote} first — push it once by hand. ` +
        `co never creates it.`,
    };
  }
  return { ok: true };
}

/**
 * Everything the PR flow needs: the gh CLI installed, authenticated, and the
 * remote integration branch reachable. Checked in that order so the message
 * names the FIRST thing that is missing rather than a downstream symptom.
 */
export async function checkForgePrereqs(o: ForgeOptions): Promise<PrereqCheck> {
  const version = await exec(o, "gh", ["--version"]);
  if (version.code !== 0) {
    return {
      ok: false,
      reason:
        `the GitHub CLI (\`gh\`) is not installed or not on PATH. co integrates features by opening and ` +
        `merging pull requests, which it does through gh — install it from https://cli.github.com.`,
    };
  }
  const auth = await exec(o, "gh", ["auth", "status"]);
  if (auth.code !== 0) {
    return {
      ok: false,
      reason:
        `\`gh\` is installed but not authenticated: ${auth.stderr.trim() || auth.stdout.trim() || "gh auth status failed"}. ` +
        `Run \`gh auth login\`.`,
    };
  }
  return checkRemotePrereqs(o);
}

/** checkForgePrereqs, as a throw. The landing engine's precondition style:
 *  preconditions are thrown, not classified (the queue turns the throw into a
 *  blocked head with this exact message; the tool layer reports it verbatim). */
export async function requireForge(o: ForgeOptions): Promise<void> {
  const check = await checkForgePrereqs(o);
  if (!check.ok) throw new Error(check.reason);
}

/** checkRemotePrereqs, as a throw — for the paths that need `origin/dev` but no
 *  gh at all (cutting a feature worktree). */
export async function requireRemoteDev(o: ForgeOptions): Promise<void> {
  const check = await checkRemotePrereqs(o);
  if (!check.ok) throw new Error(check.reason);
}

// --- git against the remote --------------------------------------------------

/**
 * Update the remote-tracking refs. This is the ONLY way co learns that `dev`
 * moved, and it is deliberately the only remote-state operation in the whole
 * flow that co performs on its own initiative: a fetch writes nothing but
 * `refs/remotes/*`, never a checkout, never the captain's tree.
 */
export async function fetchRemote(o: ForgeOptions): Promise<void> {
  await execOrThrow(o, "git", ["fetch", o.remote]);
}

/** The remote integration branch's current tip. Throws when it is missing —
 *  callers run requireRemoteDev/requireForge first, so that is a real fault. */
export async function remoteDevSha(o: ForgeOptions): Promise<string> {
  const out = await execOrThrow(o, "git", ["rev-parse", `refs/remotes/${devRef(o)}`]);
  return out.trim();
}

/** A feature branch's tip AS THE REMOTE HAS IT, or null when the remote has
 *  never seen it. Doubles as the lease value for the next push. */
export async function remoteBranchSha(o: ForgeOptions, branch: string): Promise<string | null> {
  const res = await exec(o, "git", [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/${o.remote}/${branch}`,
  ]);
  const sha = res.stdout.trim();
  return res.code === 0 && sha ? sha : null;
}

export interface PushResult {
  /** True when the push actually ran; false when the remote already had this sha. */
  pushed: boolean;
  /** True when the branch did not exist on the remote (a create, not a force). */
  created: boolean;
}

/**
 * Publish the rebased feature branch.
 *
 * A rebase rewrites shas, so this is necessarily a force push — but never a bare
 * `--force`. The lease is the sha we OBSERVED on the remote a moment ago (from
 * the fetch that preceded the rebase), so a branch someone else moved in between
 * fails loudly instead of being overwritten. A branch the remote has never seen
 * is a plain create with no force at all.
 *
 * A no-op when the remote already holds exactly this sha (a head re-processed
 * against an unchanged `dev` rebases to the same commit), so re-processing does
 * not spam the branch with identical pushes.
 */
export async function pushFeatureBranch(
  o: ForgeOptions,
  branch: string,
  localSha: string,
): Promise<PushResult> {
  const remoteSha = await remoteBranchSha(o, branch);
  if (remoteSha === localSha) return { pushed: false, created: false };
  const args =
    remoteSha === null
      ? ["push", o.remote, `${branch}:refs/heads/${branch}`]
      : ["push", `--force-with-lease=${branch}:${remoteSha}`, o.remote, `${branch}:refs/heads/${branch}`];
  const res = await exec(o, "git", args);
  if (res.code !== 0) {
    const detail = res.stderr.trim() || res.stdout.trim();
    throw new Error(
      remoteSha === null
        ? `pushing '${branch}' to ${o.remote} failed: ${detail}`
        : `pushing the rebased '${branch}' to ${o.remote} failed: ${detail}. ` +
          `The lease expected ${remoteSha.slice(0, 7)} — if someone else moved the branch, re-process the head.`,
    );
  }
  return { pushed: true, created: remoteSha === null };
}

// --- pull requests -----------------------------------------------------------

const PR_JSON_FIELDS = "number,url,title,body,headRefOid,baseRefName,state";

function parsePr(raw: unknown): PullRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.number !== "number") return null;
  return {
    number: o.number,
    url: typeof o.url === "string" ? o.url : "",
    title: typeof o.title === "string" ? o.title : "",
    body: typeof o.body === "string" ? o.body : "",
    ...(typeof o.headRefOid === "string" ? { headRefOid: o.headRefOid } : {}),
    ...(typeof o.baseRefName === "string" ? { baseRefName: o.baseRefName } : {}),
    ...(typeof o.state === "string" ? { state: o.state } : {}),
  };
}

function parseJson(out: string, what: string): unknown {
  try {
    return JSON.parse(out.trim() || "null");
  } catch {
    throw new Error(`could not read ${what} from gh: ${out.trim().slice(0, 200)}`);
  }
}

/** The open PR from `branch` into the integration branch, or null. */
export async function findOpenPr(o: ForgeOptions, branch: string): Promise<PullRequest | null> {
  const out = await execOrThrow(o, "gh", [
    "pr",
    "list",
    "--head",
    branch,
    "--base",
    o.devBranch,
    "--state",
    "open",
    "--limit",
    "1",
    "--json",
    PR_JSON_FIELDS,
  ]);
  const parsed = parseJson(out, `the open PRs for '${branch}'`);
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  return parsePr(parsed[0]);
}

/** One PR's current state on the forge — the authority on what a merge would
 *  actually merge (headRefOid) and on what a merge produced (mergeCommit). */
export async function viewPr(
  o: ForgeOptions,
  number: number,
): Promise<PullRequest & { mergeCommitSha?: string }> {
  const out = await execOrThrow(o, "gh", [
    "pr",
    "view",
    String(number),
    "--json",
    `${PR_JSON_FIELDS},mergeCommit`,
  ]);
  const parsed = parseJson(out, `PR #${number}`);
  const pr = parsePr(parsed);
  if (!pr) throw new Error(`gh returned no readable PR #${number}`);
  const mc = (parsed as Record<string, unknown>).mergeCommit;
  const oid = mc && typeof mc === "object" ? (mc as Record<string, unknown>).oid : undefined;
  return { ...pr, ...(typeof oid === "string" && oid ? { mergeCommitSha: oid } : {}) };
}

/** The markers that fence co's own evidence block inside a PR body. Everything
 *  between them is co's to rewrite on each re-processing; everything outside is
 *  the captain's and is never touched. */
export const EVIDENCE_OPEN = "<!-- co:evidence -->";
export const EVIDENCE_CLOSE = "<!-- /co:evidence -->";

/**
 * Splice a fresh evidence block into an existing PR body, preserving every word
 * the captain wrote around it. The PR is a human artifact once it exists — they
 * may retitle it, rewrite the description, add reviewers — so co edits exactly
 * one fenced region and nothing else. A body with no fence (the captain replaced
 * it wholesale) gets the block appended rather than silently going stale.
 */
export function spliceEvidence(body: string, evidence: string): string {
  const block = `${EVIDENCE_OPEN}\n${evidence.trim()}\n${EVIDENCE_CLOSE}`;
  const start = body.indexOf(EVIDENCE_OPEN);
  const end = body.indexOf(EVIDENCE_CLOSE);
  if (start !== -1 && end !== -1 && end > start) {
    return body.slice(0, start) + block + body.slice(end + EVIDENCE_CLOSE.length);
  }
  return body.trim() ? `${body.trimEnd()}\n\n${block}\n` : `${block}\n`;
}

/**
 * Make sure the feature has an open PR into the integration branch, and return
 * it. Creating one writes the whole message co composes: title, description, and
 * the fenced evidence block. An already-open PR is returned UNTOUCHED — its
 * title and prose are the captain's, and its evidence is refreshed separately by
 * updatePrEvidence once there is something new to say.
 *
 * The split exists because the PR has to exist BEFORE its verdict is known: the
 * checks that gate the merge run on the forge, against this PR, so co opens it
 * first and writes the result into it afterwards (D-20260727-1).
 */
export async function ensurePr(
  o: ForgeOptions,
  spec: { branch: string; title: string; body: string; evidence: string },
): Promise<PrEnsureResult> {
  const existing = await findOpenPr(o, spec.branch);
  if (existing) return { pr: existing, created: false };

  const body = spliceEvidence(spec.body, spec.evidence);
  const out = await execOrThrow(o, "gh", [
    "pr",
    "create",
    "--base",
    o.devBranch,
    "--head",
    spec.branch,
    "--title",
    spec.title,
    "--body",
    body,
  ]);
  const created = (await findOpenPr(o, spec.branch)) ?? {
    number: prNumberFromUrl(out) ?? 0,
    url: out.trim().split(/\s+/).pop() ?? "",
    title: spec.title,
    body,
  };
  return { pr: created, created: true };
}

/**
 * Rewrite ONLY the fenced evidence block inside a PR's body. The title and the
 * surrounding prose stay exactly as the captain left them, because a head that
 * re-processes (dev moved, a fix landed, checks finished) must refresh its
 * evidence without reverting a human's edits. If the evidence is already
 * identical, nothing is sent at all.
 */
export async function updatePrEvidence(
  o: ForgeOptions,
  pr: PullRequest,
  evidence: string,
): Promise<PrEvidenceResult> {
  const nextBody = spliceEvidence(pr.body, evidence);
  if (nextBody.trim() === pr.body.trim()) return { pr, bodyUpdated: false };
  await execOrThrow(o, "gh", ["pr", "edit", String(pr.number), "--body", nextBody]);
  return { pr: { ...pr, body: nextBody }, bodyUpdated: true };
}

// --- checks ------------------------------------------------------------------

const CHECK_JSON_FIELDS = "name,state,bucket,link,workflow,description";

/**
 * gh's message when there is nothing to report — either the PR has no checks at
 * all, or (`--required`) branch protection defines none. gh exits 1 for this,
 * exactly as it does for a real fault, so the MESSAGE is the only way to tell
 * "nothing to gate on" from "gh broke". Everything else nonzero is a fault and
 * is thrown, so co can never mistake a broken read for an ungated PR.
 */
const NO_CHECKS = /no (?:required )?checks reported/i;

const BUCKETS = new Set<string>(["pass", "fail", "pending", "skipping", "cancel"]);

function parseCheck(raw: unknown): CheckRun | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) return null;
  // An unrecognised bucket (a newer gh) counts as PENDING, never as a pass: the
  // worst it can cost is a bounded wait, where the other default would be a
  // green co never actually saw.
  const bucket =
    typeof o.bucket === "string" && BUCKETS.has(o.bucket) ? (o.bucket as CheckBucket) : "pending";
  return {
    name,
    bucket,
    state: typeof o.state === "string" ? o.state : "",
    ...(typeof o.link === "string" && o.link ? { link: o.link } : {}),
    ...(typeof o.workflow === "string" && o.workflow ? { workflow: o.workflow } : {}),
    ...(typeof o.description === "string" && o.description ? { description: o.description } : {}),
  };
}

/** One `gh pr checks` read. Null means gh said there is nothing to report. */
async function readChecks(
  o: ForgeOptions,
  number: number,
  required: boolean,
): Promise<CheckRun[] | null> {
  const args = ["pr", "checks", String(number), "--json", CHECK_JSON_FIELDS];
  if (required) args.push("--required");
  const res = await exec(o, "gh", args);
  const out = res.stdout.trim();
  if (out) {
    // With --json, gh prints the list and exits 0 even when checks FAILED — the
    // verdict is in the buckets, never in the exit code.
    const parsed = parseJson(out, `the checks on PR #${number}`);
    if (!Array.isArray(parsed)) {
      throw new Error(`gh returned no readable check list for PR #${number}`);
    }
    return parsed.map(parseCheck).filter((c): c is CheckRun => c !== null);
  }
  if (res.code === 0) return null;
  if (NO_CHECKS.test(res.stderr)) return null;
  throw new Error(
    `\`gh pr checks ${number}${required ? " --required" : ""}\` exited ${res.code}: ` +
      `${res.stderr.trim() || res.stdout.trim() || "no output"}`,
  );
}

/**
 * What GitHub's CI makes of this PR, right now — the semantic half of the merge
 * gate, the way a protected branch reads it (D-20260727-1).
 *
 * REQUIRED CHECKS WIN. If branch protection on the base defines required checks,
 * those alone decide, because those alone are what GitHub itself would block the
 * merge on. Only when there are none does this fall back to every check reported
 * on the PR, so a repo with CI but no protection rules is still gated on its CI.
 * A PR with no checks at all comes back `runs: null` — ungated, not failed.
 */
export async function readPrChecks(o: ForgeOptions, number: number): Promise<PrChecksRead> {
  const required = await readChecks(o, number, true);
  if (required && required.length > 0) return { runs: required, requiredOnly: true };
  return { runs: await readChecks(o, number, false), requiredOnly: false };
}

/** The PR number out of a `gh pr create` URL ("…/pull/42"). Only a fallback:
 *  the authoritative read is findOpenPr right after the create. */
function prNumberFromUrl(out: string): number | null {
  const m = /\/pull\/(\d+)/.exec(out);
  return m ? Number(m[1]) : null;
}

export interface PrMergeResult {
  number: number;
  /** The merge commit the forge created, when gh could tell us. */
  mergeCommitSha?: string;
  url: string;
}

/**
 * MERGE THE PR — the one write that lands a feature on `dev`, and it happens
 * SERVER-SIDE. `--merge` is not a preference, it is the contract: a merge commit
 * keeps the feature branch visible in the graph and keeps the crew's per-job
 * commits intact. `--delete-branch` is deliberately absent — the ref is kept.
 *
 * co's local `dev` is not written here, or anywhere: the merge happens on the
 * forge, and co learns about it by fetching afterwards.
 */
export async function mergePr(o: ForgeOptions, number: number): Promise<PrMergeResult> {
  const res = await exec(o, "gh", ["pr", "merge", String(number), "--merge"]);
  if (res.code !== 0) {
    throw new Error(
      `\`gh pr merge ${number} --merge\` failed: ${res.stderr.trim() || res.stdout.trim()}`,
    );
  }
  // The forge assigns the merge commit; read it back rather than guessing.
  await fetchRemote(o);
  const after = await viewPr(o, number);
  return {
    number,
    url: after.url,
    ...(after.mergeCommitSha ? { mergeCommitSha: after.mergeCommitSha } : {}),
  };
}
