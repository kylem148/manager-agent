import fs from "node:fs";
import { DEFAULT_BUILD_TEST_COMMAND, prepareLanding } from "./landing.js";
import { reviewLanding, type LandingGateHost, type LandingGateResult } from "./landinggate.js";
import {
  MergeQueue,
  type EnqueueResult,
  type MergeHeadResult,
  type QueueEntryView,
  type QueueView,
} from "./mergequeue.js";
import type { DispatchRegistry } from "./registry.js";
import {
  featureBranch,
  featureSlug,
  isWorktreeDirty,
  listWorktrees,
  provisionWorktree,
  reconcileFeatures,
  resolveWorktreeOptions,
  teardownWorktree,
  type FeatureRecord,
  type FeatureReconcileReport,
  type TeardownResult,
  type WorktreeOptions,
} from "./worktrees.js";

/**
 * The co-facing feature levers: the tool layer that lets the co-manager drive
 * the worktree harness end to end — create a feature (provision its worktree),
 * dispatch crew into it (the registry already does the dispatch; targeting is
 * threaded through the tool/session layer), and land it through the Ctrl-O gate.
 *
 * This module is deliberately thin. All the real machinery lives below it:
 * worktrees.ts (git plumbing), the DispatchRegistry (the feature-record map +
 * feature-scoped dispatch), landing.ts (rebase + build+test), and landinggate.ts
 * (the human [m] gate). FeatureManager wraps those into the small verb set the
 * model calls, keeps a single source of truth (the registry's feature map), and
 * returns plain JSON-serializable results so the executor can hand them straight
 * back as tool output.
 *
 * Safety posture is inherited, not re-implemented: create is idempotent and
 * throws with a reconcile pointer on a half-state (provisionWorktree); land only
 * ever merges through the gate's [m] keystroke (reviewLanding is the single live
 * call site of executeLanding); abandon refuses a worktree with uncommitted
 * changes and never force-deletes an unmerged branch (teardownWorktree's guards).
 * The boot reconcile is READ-ONLY over feature state — it rebuilds records and
 * surfaces anomalies, and destroys nothing.
 */

/** Test seams so the levers can be unit-tested against a stubbed-Ghostty
 *  registry + real git without reaching for a live Tui or a real build+test. */
export interface FeatureManagerDeps {
  provision: typeof provisionWorktree;
  teardown: typeof teardownWorktree;
  reconcile: typeof reconcileFeatures;
  prepare: typeof prepareLanding;
  review: typeof reviewLanding;
}

export interface FeatureManagerOptions {
  registry: DispatchRegistry;
  /** The linked repo — the WorktreeOptions.repoPath every lever operates on. */
  repoPath: string;
  /** The human landing gate (the Tui). Absent off a real terminal (PlainIO):
   *  feature_land then reports that landing needs an interactive session. */
  gateHost?: LandingGateHost;
  /** Combined build+test for the landing prepare; defaults to the repo's own
   *  typecheck+test. Injectable so tests run a fast fake. */
  buildTestCommand?: string;
  /** Overrides for the git/gate seams (tests only). */
  deps?: Partial<FeatureManagerDeps>;
}

export interface FeatureView {
  feature: string;
  slug: string;
  branch: string;
  worktreePath: string;
  provisionStatus: FeatureRecord["provisionStatus"];
  /** The intent the co gave at create time, if any. Not persisted across a
   *  restart — the co's own memory holds the durable intent. */
  intent?: string;
  /** Jobs the registry has dispatched under this feature (id + status + label). */
  jobs: { id: string; status: string; label: string }[];
  /** Whether a crew agent is currently running or queued in the worktree. A
   *  feature runs one agent at a time. */
  busy: boolean;
  /** The feature's place in the serial merge queue, when it is enqueued: its
   *  position, whether it is the head, and its queue status (queued /
   *  head-processing / ready / blocked). Absent when the feature isn't queued. */
  queue?: QueueEntryView;
}

export interface CreateResult {
  created: boolean;
  feature: FeatureView;
}

export interface AbandonResult {
  abandoned: boolean;
  /** Present when abandoned: what teardown did (worktree removed, branch kept
   *  or deleted). */
  teardown?: TeardownResult;
  /** Present when refused: why (uncommitted changes in the worktree). */
  reason?: string;
}

export interface LandResult {
  feature: string;
  outcome: LandingGateResult["outcome"];
  /** A one-line human account of what the gate did. */
  summary: string;
  /** The prepare kind the gate reviewed (green/conflict/failed). */
  prepared: LandingGateResult["prepared"]["kind"];
  /** Present on a merge: the merge sha + integration branch. */
  merged?: { mergeSha: string; target: string };
  /** Present when the gate's merge attempt was refused (a stale green, etc.). */
  error?: string;
}

export class FeatureManager {
  private readonly registry: DispatchRegistry;
  private readonly repoPath: string;
  private readonly gateHost?: LandingGateHost;
  private readonly buildTestCommand: string;
  private readonly deps: FeatureManagerDeps;
  /** The serial merge queue (mergequeue.ts). Owns the ordered "done" features
   *  and the head-only state machine; drives the EXISTING prepare + gate through
   *  the deps below. FeatureManager is its host (busy check + record cleanup). */
  private readonly queue: MergeQueue;
  /** Intents keyed by slug, so status/list can echo the feature's purpose. Not
   *  durable: reconcile can't recover an intent from a branch, so a restart
   *  drops it (the co's memory is the durable record). */
  private readonly intents = new Map<string, string>();

  constructor(opts: FeatureManagerOptions) {
    this.registry = opts.registry;
    this.repoPath = opts.repoPath;
    if (opts.gateHost) this.gateHost = opts.gateHost;
    this.buildTestCommand = opts.buildTestCommand ?? DEFAULT_BUILD_TEST_COMMAND;
    this.deps = {
      provision: opts.deps?.provision ?? provisionWorktree,
      teardown: opts.deps?.teardown ?? teardownWorktree,
      reconcile: opts.deps?.reconcile ?? reconcileFeatures,
      prepare: opts.deps?.prepare ?? prepareLanding,
      review: opts.deps?.review ?? reviewLanding,
    };
    this.queue = new MergeQueue({
      repoPath: this.repoPath,
      buildTestCommand: this.buildTestCommand,
      ...(this.gateHost ? { gateHost: this.gateHost } : {}),
      host: {
        isBusy: (feature) => this.isBusy(feature),
        forget: (feature) => {
          this.registry.removeFeature(feature);
          this.intents.delete(safeSlug(feature));
        },
      },
      deps: { prepare: this.deps.prepare, review: this.deps.review },
    });
  }

  /** Whether a crew agent is currently running or queued in the feature's
   *  worktree — a feature is worked one agent at a time, so this gates landing
   *  and queue processing. */
  private isBusy(feature: string): boolean {
    return this.registry
      .jobsForFeature(feature)
      .some((j) => j.status === "running" || j.status === "queued");
  }

  private worktreeOptions(): WorktreeOptions {
    return { repoPath: this.repoPath };
  }

  /** Find a tracked record by feature name OR slug — the two handles a caller
   *  might hold. A restart rebuilds records keyed by slug, so the co may address
   *  a feature it created as "User Auth" by the slug "user-auth" afterward. */
  private findRecord(feature: string): FeatureRecord | undefined {
    const slug = safeSlug(feature);
    return this.registry.listFeatures().find((r) => r.feature === feature || (slug && r.slug === slug));
  }

  private toView(record: FeatureRecord): FeatureView {
    const jobs = this.registry
      .jobsForFeature(record.feature)
      .map((j) => ({ id: j.id, status: j.status, label: j.label }));
    const busy = this.isBusy(record.feature);
    const intent = this.intents.get(record.slug);
    const queue = this.queue.viewFor(record.feature);
    return {
      feature: record.feature,
      slug: record.slug,
      branch: record.branch,
      worktreePath: record.worktreePath,
      provisionStatus: record.provisionStatus,
      ...(intent ? { intent } : {}),
      jobs,
      busy,
      ...(queue ? { queue } : {}),
    };
  }

  /**
   * Provision a feature's worktree off dev and register the record. Runs direct
   * — no confirm gate — because it writes nothing to dev or main (it only cuts a
   * fresh `co/feat-<slug>` branch and its isolated checkout). Idempotent for an
   * intact feature (returns the existing worktree, created: false); throws with
   * a reconcile pointer on a half-state, which the executor surfaces.
   */
  async create(name: string, intent?: string): Promise<CreateResult> {
    const before = this.findRecord(name);
    const alreadyReady =
      before?.provisionStatus === "ready" && fs.existsSync(before.worktreePath);
    const record = await this.deps.provision(this.worktreeOptions(), name);
    this.registry.upsertFeature(record);
    if (intent && intent.trim()) this.intents.set(record.slug, intent.trim());
    return { created: !alreadyReady, feature: this.toView(record) };
  }

  /** Every tracked feature, newest bookkeeping last. */
  list(): FeatureView[] {
    return this.registry.listFeatures().map((r) => this.toView(r));
  }

  /** One feature's full picture, or null if nothing is tracked under that
   *  name/slug. Includes a live dirty check on its worktree. */
  async status(name: string): Promise<(FeatureView & { dirty: boolean }) | null> {
    const record = this.findRecord(name);
    if (!record) return null;
    const dirty =
      fs.existsSync(record.worktreePath) && (await isWorktreeDirty(record.worktreePath));
    return { ...this.toView(record), dirty };
  }

  /**
   * Land a feature: run the landing prepare (rebase onto dev + build+test on the
   * combined state) and open the Ctrl-O gate on the result. The gate IS the
   * confirmation — there is no separate prompt, and the merge fires only if the
   * human presses [m] over a green prepare. On a merge the feature's worktree and
   * branch are torn down (executeLanding), so its registry record is dropped too.
   *
   * Refuses cleanly (never throws) when no interactive gate is available (a
   * piped/non-TTY session) or when the feature isn't tracked.
   */
  async land(name: string): Promise<LandResult> {
    const record = this.findRecord(name);
    const feature = record?.feature ?? name;
    if (!this.gateHost) {
      return {
        feature,
        outcome: "rejected",
        prepared: "failed",
        summary:
          "Landing needs an interactive terminal for the Ctrl-O review gate; this session has none.",
        error: "no landing gate available (non-interactive session)",
      };
    }
    // A feature in the merge queue lands only through its head (strict serial,
    // head-only). The direct feature_land path is for features that were never
    // enqueued; sending a queued one here would bypass the queue's ordering.
    if (this.queue.has(feature)) {
      return {
        feature,
        outcome: "rejected",
        prepared: "failed",
        summary: `'${feature}' is in the merge queue; land it via the queue (feature_merge_head) when it is the head, not directly.`,
        error: "feature is enqueued; merge it as the queue head",
      };
    }
    if (this.isBusy(feature)) {
      return {
        feature,
        outcome: "rejected",
        prepared: "failed",
        summary: `Feature '${feature}' still has a crew agent working; let it finish before landing.`,
        error: "a crew agent is still active in the worktree",
      };
    }

    const result = await this.deps.review(
      this.gateHost,
      { repoPath: this.repoPath, buildTestCommand: this.buildTestCommand },
      feature,
    );

    const target = resolveWorktreeOptions(this.worktreeOptions()).devBranch;
    if (result.outcome === "merged" && result.landed) {
      // The worktree and branch are gone (executeLanding tore them down); drop
      // the record and its intent so list/status reflect reality.
      this.registry.removeFeature(feature);
      if (record) this.intents.delete(record.slug);
      return {
        feature,
        outcome: "merged",
        prepared: result.prepared.kind,
        summary: `landed ${feature}: ${result.landed.mergeSha.slice(0, 7)} on ${target}`,
        merged: { mergeSha: result.landed.mergeSha, target },
      };
    }

    const summary =
      result.outcome === "failed"
        ? `landing ${feature} was refused: ${result.error ?? "the merge could not proceed"}`
        : result.prepared.kind === "green"
          ? `${feature} was ready to land but you declined; nothing merged, branch and worktree intact.`
          : `${feature} is not mergeable (${result.prepared.kind}); the gate showed why and merged nothing.`;
    return {
      feature,
      outcome: result.outcome,
      prepared: result.prepared.kind,
      summary,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  /**
   * Tear a feature's worktree down WITHOUT landing it. Refuses (reports, never
   * forces) a worktree with uncommitted changes: discarding unsaved work is a
   * human's call, not the co's. Committed-but-unmerged work is preserved too —
   * teardownWorktree removes the worktree but keeps an unmerged branch and names
   * why, so nothing is silently lost.
   */
  async abandon(name: string): Promise<AbandonResult> {
    const record = this.findRecord(name);
    const feature = record?.feature ?? name;
    const branch = featureBranch(feature);
    const entry = (await listWorktrees(this.repoPath)).find((w) => w.branch === `refs/heads/${branch}`);
    if (entry && fs.existsSync(entry.path) && (await isWorktreeDirty(entry.path))) {
      return {
        abandoned: false,
        reason:
          `worktree ${entry.path} has uncommitted changes; refusing to abandon '${feature}'. ` +
          `Commit or discard the work in the pane first, or decide deliberately to lose it.`,
      };
    }
    const teardown = await this.deps.teardown(this.worktreeOptions(), feature);
    this.registry.removeFeature(feature);
    if (record) this.intents.delete(record.slug);
    // Drop it from the merge queue too, so an abandoned feature never lingers as
    // a stale entry. If it was the head, this advances the queue and processes
    // the new head against the current dev tip.
    await this.queue.remove(feature);
    return { abandoned: true, teardown };
  }

  // --- serial merge queue -----------------------------------------------------
  //
  // The "mark done" flow (D-20260723-14/-21/-23): features the captain declares
  // done join an ordered queue; only the head is processed at a time (rebase +
  // build+test via the EXISTING landing prepare); a green head is offered for the
  // captain's merge keystroke via the EXISTING gate; on merge the queue advances
  // and the next feature is processed against the new dev tip. See mergequeue.ts.

  /**
   * Enqueue a feature as "done" (mark-done). No confirm gate — enqueue is the
   * trigger, and the only gate in the flow is the merge keystroke on the head.
   * When the feature becomes the head, it is processed immediately (rebase onto
   * the current dev tip + combined build+test); re-enqueuing a blocked head is
   * the retry lever. Reports not-found for a feature that was never created.
   */
  async enqueue(name: string): Promise<
    ({ enqueued: true } & EnqueueResult) | { enqueued: false; feature: string; reason: string }
  > {
    const record = this.findRecord(name);
    if (!record) {
      return {
        enqueued: false,
        feature: name,
        reason: `no feature '${name}' is tracked; create it with feature_create first.`,
      };
    }
    const res = await this.queue.enqueue(record.feature);
    return { enqueued: true, ...res };
  }

  /**
   * Merge the current queue head through the EXISTING [m]/[r] gate. Only a ready
   * (green) head merges; on [m] it lands to dev, tears down, and the queue
   * advances (the new head is processed against the new dev tip). Refuses cleanly
   * — never throws — when there is no head, no interactive gate, the head is busy,
   * or the head is not ready.
   */
  async mergeHead(): Promise<MergeHeadResult> {
    return this.queue.mergeHead();
  }

  /** The full merge-queue snapshot (order + head + per-entry status). */
  queueView(): QueueView {
    return this.queue.view();
  }

  /**
   * Boot reconcile: rebuild feature records from the on-disk worktrees and seed
   * the registry, so a feature survives a session restart. Non-destructive —
   * anomalies (a branch with no worktree, a half-landed branch, a stray dir) are
   * returned for surfacing, never acted on. Records already tracked are
   * overwritten by the fresh on-disk truth.
   */
  async reconcileAtBoot(): Promise<FeatureReconcileReport> {
    const report = await this.deps.reconcile(this.worktreeOptions());
    for (const record of report.records) this.registry.upsertFeature(record);
    return report;
  }
}

/** Slug a name without throwing (an empty/degenerate name just yields ""), so
 *  findRecord can compare defensively rather than blow up on bad input. */
function safeSlug(name: string): string {
  try {
    return featureSlug(name);
  } catch {
    return "";
  }
}
