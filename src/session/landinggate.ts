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
 * in the Tui's overlay (summary + paged diff + action bar); the merge happens
 * ONLY if the human presses [m] there over a green prepare. This module is the
 * single live call site of executeLanding, and it reaches it exclusively
 * through the LandingReview.execute callback the overlay fires on that
 * keystroke - there is no code path that merges without it.
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
 */
export async function reviewLanding(
  host: LandingGateHost,
  opts: LandingOptions,
  feature: string,
): Promise<LandingGateResult> {
  const prepared = await prepareLanding(opts, feature);
  const target = resolveWorktreeOptions(opts).devBranch;
  let landed: LandResult | undefined;
  let error: string | undefined;

  const outcome = await host.openLandingReview({
    feature,
    target,
    prepared: toView(prepared),
    execute: async () => {
      // Reached only from the overlay's [m] handler, and only on a green.
      if (prepared.kind !== "green") {
        throw new Error(`prepare was ${prepared.kind}, not green; nothing tested to merge`);
      }
      try {
        landed = await executeLanding(opts, feature, { featureSha: prepared.featureSha });
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        throw e;
      }
      return `landed ${feature}: ${landed.mergeSha.slice(0, 7)} on ${target}`;
    },
  });
  return { prepared, outcome, landed, error };
}

/** Strip the engine's prepare result down to what the overlay shows. */
function toView(p: PrepareResult): LandingPrepared {
  switch (p.kind) {
    case "green":
      return { kind: "green", commits: p.commits, diff: p.diff };
    case "conflict":
      return { kind: "conflict", conflictFiles: p.conflictFiles, detail: p.detail };
    case "failed":
      return { kind: "failed", exitCode: p.exitCode, output: p.output };
  }
}
