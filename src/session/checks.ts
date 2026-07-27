import { readPrChecks, type CheckRun, type ForgeOptions, type PrChecksRead } from "./forge.js";

/**
 * The CI-checks gate: the layer that turns "what does GitHub think of this pull
 * request" into a verdict the landing engine can act on (D-20260727-1).
 *
 * WHY THIS REPLACED CO'S OWN BUILD+TEST. The landing engine used to run a
 * combined build+test itself, on the rebased worktree, from a command it had to
 * GUESS (`npm run typecheck && npm test`). That guess is wrong the moment the
 * repo isn't npm — and a wrong guess doesn't fail softly: `npm test` with no
 * package.json exits 254, which read as a red suite and wedged the queue behind
 * a head that was perfectly fine. Meanwhile GitHub was already testing exactly
 * the state that matters: a `pull_request` workflow runs against a merge of the
 * PR head and its base, which is the same combined state the rebase produces,
 * and branch protection already blocks the merge on the result.
 *
 * So co stopped being a build runner. It rebases (the TEXTUAL half of the gate,
 * which is git's and therefore co's), pushes, opens the PR, and READS the
 * SEMANTIC half off the forge. co no longer needs to know how to build or test
 * any repo, and there is nothing left to auto-detect.
 *
 * THE FOUR OUTCOMES, and why none of them is an error:
 *  - passed  — every check co gated on is green. The head is mergeable.
 *  - failed  — at least one is red (or cancelled). The direct analog of the old
 *              red build+test: the head blocks and the resolver applies.
 *  - pending — checks are still running. A bounded poll waits for them; if the
 *              bound expires the head sits in a WAITING state, not a failed one.
 *  - none    — the PR reported no checks at all. This is the load-bearing case:
 *              a repo with no CI must yield a READY head, flagged UNGATED so the
 *              captain knows their judgment is the only gate, and must NEVER be
 *              an error or a false red. That failure mode is what this whole
 *              module exists to avoid repeating.
 *
 * A genuinely broken read (gh missing, unauthenticated, rate-limited) is neither
 * of those four: readPrChecks throws, the landing engine lets it out, and the
 * queue turns it into a blocked head carrying gh's own message. Never a silent
 * ungated pass.
 */

/** What co gated on, once the checks settled (or the wait ran out). */
export type ChecksVerdict = "passed" | "failed" | "pending" | "none";

export interface ChecksSummary {
  verdict: ChecksVerdict;
  /** True when the PR reported NO checks: there is no CI to gate on, so the head
   *  is mergeable but on human judgment alone. Always surfaced, never silent. */
  ungated: boolean;
  /** True when branch protection defines required checks and only those were
   *  gated on; false when this is every check reported on the PR. */
  requiredOnly: boolean;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  /** Skipped checks. GitHub treats a skipped required check as satisfied, and so
   *  does this: counted apart, but not blocking. */
  skipped: number;
  /** Every check that was gated on, so a surface can NAME what went red. */
  runs: CheckRun[];
  /** Wall-clock co spent reading and waiting on the checks, in ms. */
  ms: number;
  /** True when the bounded wait expired with checks still running. */
  timedOut?: boolean;
}

/** How long co is willing to wait on CI, and how often it looks. Injectable
 *  end to end (LandingOptions → MergeQueue → FeatureManager) so tests drive the
 *  poll loop without sleeping and a slow project can widen the bound. */
export interface ChecksPolicy {
  /** Bound on the whole wait for pending checks. Default CHECKS_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Gap between reads while checks are pending. Default CHECKS_INTERVAL_MS. */
  intervalMs?: number;
  /** How long to keep looking for checks that have not APPEARED yet, right after
   *  a fresh push, before concluding the PR is genuinely ungated. GitHub takes a
   *  moment to register a workflow run, and "no checks yet" must never be
   *  mistaken for "no CI". Default CHECKS_GRACE_MS. */
  graceMs?: number;
  /** Injected by tests so a poll costs no wall-clock. */
  sleep?: (ms: number) => Promise<void>;
}

/** The bounded wait: long enough for ordinary CI, short enough that a stuck
 *  workflow leaves the head visibly WAITING instead of hanging the caller. */
export const CHECKS_TIMEOUT_MS = 5 * 60_000;
/** How often the wait re-reads `gh pr checks`. */
export const CHECKS_INTERVAL_MS = 10_000;
/** How long "no checks reported" is treated as "not created yet" after a push. */
export const CHECKS_GRACE_MS = 30_000;

const sleepFor = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Count one read's buckets into a verdict. A red beats a pending (GitHub blocks
 *  the merge either way, and surfacing the failure immediately is what lets the
 *  resolver start), and an all-skipped set is a pass, as it is on the forge. */
export function summarizeChecks(read: PrChecksRead, ms: number): ChecksSummary {
  const runs = read.runs ?? [];
  if (runs.length === 0) {
    return {
      verdict: "none",
      ungated: true,
      requiredOnly: read.requiredOnly,
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      skipped: 0,
      runs: [],
      ms,
    };
  }
  let passed = 0;
  let failed = 0;
  let pending = 0;
  let skipped = 0;
  for (const r of runs) {
    switch (r.bucket) {
      case "pass":
        passed++;
        break;
      case "fail":
      case "cancel":
        failed++;
        break;
      case "skipping":
        skipped++;
        break;
      default:
        pending++;
    }
  }
  return {
    verdict: failed > 0 ? "failed" : pending > 0 ? "pending" : "passed",
    ungated: false,
    requiredOnly: read.requiredOnly,
    total: runs.length,
    passed,
    failed,
    pending,
    skipped,
    runs,
    ms,
  };
}

/**
 * Read the PR's checks, waiting out anything still running, within bounds.
 *
 * Two different deadlines, because "still running" and "not there at all" are
 * different questions. Pending checks are waited on up to `timeoutMs`, and a
 * timeout returns the pending summary with `timedOut` — a WAITING state, never a
 * failure. "No checks reported" is waited on only for the grace window, and only
 * when this prepare actually published something (a fresh push or a new PR), the
 * one moment GitHub might not have registered the run yet; on a re-read of an
 * unchanged head there is nothing to wait for and the ungated answer is
 * immediate.
 */
export async function awaitPrChecks(
  forge: ForgeOptions,
  number: number,
  policy: ChecksPolicy = {},
  opts: { published?: boolean } = {},
): Promise<ChecksSummary> {
  const timeoutMs = Math.max(0, policy.timeoutMs ?? CHECKS_TIMEOUT_MS);
  const intervalMs = Math.max(1, policy.intervalMs ?? CHECKS_INTERVAL_MS);
  const graceMs = opts.published ? Math.min(policy.graceMs ?? CHECKS_GRACE_MS, timeoutMs) : 0;
  const sleep = policy.sleep ?? sleepFor;
  // A hard poll bound as well as a clock bound: an injected sleep that doesn't
  // advance the clock (every test) must still terminate.
  const maxPolls = Math.ceil(timeoutMs / intervalMs) + 2;

  const started = Date.now();
  let summary = summarizeChecks({ runs: null, requiredOnly: false }, 0);
  for (let poll = 0; poll < maxPolls; poll++) {
    const read = await readPrChecks(forge, number);
    summary = summarizeChecks(read, Date.now() - started);
    if (summary.verdict === "passed" || summary.verdict === "failed") return summary;
    const deadline = summary.verdict === "none" ? graceMs : timeoutMs;
    const left = deadline - summary.ms;
    if (left <= 0) break;
    await sleep(Math.min(intervalMs, left));
  }
  return summary.verdict === "pending" ? { ...summary, timedOut: true } : summary;
}

/** The checks that blocked the merge — what a resolver is sent at and what a
 *  panel names. Cancelled counts: it did not pass, and GitHub blocks on it. */
export function failedChecks(summary: ChecksSummary): CheckRun[] {
  return summary.runs.filter((r) => r.bucket === "fail" || r.bucket === "cancel");
}

/** The checks still running, for a "waiting on CI" line. */
export function pendingChecks(summary: ChecksSummary): CheckRun[] {
  return summary.runs.filter(
    (r) => r.bucket !== "fail" && r.bucket !== "cancel" && r.bucket !== "pass" && r.bucket !== "skipping",
  );
}

/** One line of prose for a checks result, used wherever co has to say what the
 *  gate found in words (the PR evidence block, a blocked head's reason, a tool
 *  result). Kept here so every surface says the same thing. */
export function checksLine(summary: ChecksSummary): string {
  const scope = summary.requiredOnly ? "required check" : "check";
  const plural = (n: number): string => (n === 1 ? scope : `${scope}s`);
  switch (summary.verdict) {
    case "none":
      return "no CI checks reported on this pull request — nothing gates it automatically";
    case "passed":
      return `${summary.total} ${plural(summary.total)} passed${
        summary.skipped > 0 ? ` (${summary.skipped} skipped)` : ""
      }`;
    case "failed": {
      const names = failedChecks(summary).map((r) => r.name);
      return `${summary.failed} of ${summary.total} ${plural(summary.total)} failed: ${names.join(", ")}`;
    }
    case "pending": {
      const names = pendingChecks(summary).map((r) => r.name);
      return `${summary.pending} of ${summary.total} ${plural(summary.total)} still running${
        names.length > 0 ? `: ${names.join(", ")}` : ""
      }`;
    }
  }
}
