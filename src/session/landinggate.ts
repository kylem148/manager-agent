import {
  executeLanding,
  prepareLanding,
  type LandingOptions,
  type LandResult,
  type PrepareResult,
} from "./landing.js";
import { resolveWorktreeOptions } from "./worktrees.js";
import type { LandingGateOutcome, LandingPrepared, LandingReview } from "../tui/tui.js";

/**
 * The human landing gate: the review surface that sits between prepareLanding
 * and executeLanding. reviewLanding prepares a feature and presents the result
 * in the Tui's overlay (summary + the PR it opened + paged diff + action bar);
 * the merge happens ONLY if the human presses [m] there over a green prepare.
 * This module is the single live call site of executeLanding for the direct
 * feature_land route, and it reaches it exclusively through the
 * LandingReview.execute callback the overlay fires on that keystroke - there is
 * no code path that merges without it. Since D-20260724-13 that merge is
 * `gh pr merge --merge` on the feature's pull request, not a local write.
 *
 * The co's orchestration tools that trigger a review are a later slice; for
 * now callers (and tests) invoke reviewLanding directly.
 */

/** The one Tui capability the gate needs, narrowed from Tui so tests can
 *  drive the flow with a scripted host and so nothing else of the screen is
 *  reachable from here. Tui satisfies it structurally. */
export interface LandingGateHost {
  openLandingReview(review: LandingReview): Promise<LandingGateOutcome>;
}

/** Everything one review reports back: what prepare found, what the human
 *  did, and what the merge did. */
export interface LandingGateResult {
  prepared: PrepareResult;
  outcome: LandingGateOutcome;
  /** The merge record - present exactly when outcome is "merged". */
  landed?: LandResult;
  /** The executeLanding refusal/failure - present exactly when "failed". */
  error?: string;
}

/**
 * Prepare `feature` and open the landing gate on the result.
 *
 * A green prepare arms [m]: pressing it runs executeLanding pinned to the
 * exact sha the diff and build+test covered, so approval can never merge more
 * than what was reviewed. [r]/Esc dismisses with no merge, leaving the branch
 * and worktree intact. A conflict or failed prepare opens the gate too - the
 * human sees why the feature is not mergeable - but [m] is disabled there. An
 * executeLanding refusal (e.g. a green gone stale because another feature
 * landed first) surfaces in the gate and comes back as outcome "failed"; the
 * cure is simply another reviewLanding for a fresh prepare.
 *
 * `prepared` lets a caller that has ALREADY run prepareLanding (the merge queue
 * processes its head to decide ready/blocked before ever opening a gate) hand
 * that exact result in, so the gate shows it without a second rebase +
 * build+test. It changes nothing else: [m] still runs executeLanding pinned to
 * the same featureSha, so the shas guard the merge exactly as a fresh prepare
 * would (a branch that moved since is refused with "moved since prepare"). Omit
 * it and the gate prepares itself, exactly as feature_land does.
 */
export async function reviewLanding(
  host: LandingGateHost,
  opts: LandingOptions,
  feature: string,
  prepared?: PrepareResult,
): Promise<LandingGateResult> {
  const preparedResult = prepared ?? (await prepareLanding(opts, feature));
  const target = resolveWorktreeOptions(opts).devBranch;
  let landed: LandResult | undefined;
  let error: string | undefined;

  const outcome = await host.openLandingReview({
    feature,
    target,
    prepared: toView(preparedResult),
    execute: async () => {
      // Reached only from the overlay's [m] handler, and only on a green.
      if (preparedResult.kind !== "green") {
        throw new Error(`prepare was ${preparedResult.kind}, not green; nothing tested to merge`);
      }
      try {
        landed = await executeLanding(opts, feature, {
          featureSha: preparedResult.featureSha,
          devSha: preparedResult.devSha,
          ...(preparedResult.pr ? { prNumber: preparedResult.pr.number } : {}),
        });
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        throw e;
      }
      return `merged PR #${landed.pr.number}: ${feature} → ${target} (${landed.mergeSha.slice(0, 7)})`;
    },
  });
  return { prepared: preparedResult, outcome, landed, error };
}

/** Strip the engine's prepare result down to what the overlay shows. */
function toView(p: PrepareResult): LandingPrepared {
  switch (p.kind) {
    case "green":
      return {
        kind: "green",
        commits: p.commits,
        diff: p.diff,
        ...(p.pr ? { pr: { number: p.pr.number, url: p.pr.url, title: p.pr.title } } : {}),
      };
    case "conflict":
      return { kind: "conflict", conflictFiles: p.conflictFiles, detail: p.detail };
    case "failed":
      return { kind: "failed", exitCode: p.exitCode, output: p.output };
  }
}
