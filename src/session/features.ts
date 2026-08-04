import fs from "node:fs";
import { checksLine, failedChecks, type ChecksPolicy } from "./checks.js";
import { splitEvidence, updatePrMessage, viewPr, type CommandRunner } from "./forge.js";
import {
  authoredPrBody,
  authoredPrTitle,
  executeLanding,
  prepareLanding,
  type AuthoredPrMessage,
  type LandingOptions,
} from "./landing.js";
import { FeatureStore } from "./featurestore.js";
import { reviewLanding, type LandingGateHost, type LandingGateResult } from "./landinggate.js";
import {
  MergeQueue,
  MAX_RESOLVE_ATTEMPTS,
  type EnqueueResult,
  type MergeHeadResult,
  type ProcessHeadResult,
  type QueueEntryView,
  type QueueHeadDetail,
  type QueueView,
} from "./mergequeue.js";
import type { DispatchRegistry } from "./registry.js";
import type { ActiveAgent } from "./lanes.js";
import {
  featureBranch,
  featureSlug,
  findFeatureWorktree,
  forgeOptions,
  isWorktreeDirty,
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
 * threaded through the tool/session layer), and land it — as a GitHub pull
 * request into `dev` (D-20260724-13) — through the Ctrl-O gate.
 *
 * This module is deliberately thin. All the real machinery lives below it:
 * worktrees.ts (git plumbing), the DispatchRegistry (the feature-record map +
 * feature-scoped dispatch), landing.ts (rebase + PR + checks), and landinggate.ts
 * (the human [m] gate). FeatureManager wraps those into the small verb set the
 * model calls, keeps a single source of truth (the registry's feature map), and
 * returns plain JSON-serializable results so the executor can hand them straight
 * back as tool output.
 *
 * Safety posture is inherited, not re-implemented: create is idempotent and
 * throws with a reconcile pointer on a half-state (provisionWorktree); every
 * merge in an interactive session is a human keystroke (feature_land through the
 * gate's [m], a queue head through the panel's [m] — the co calls neither);
 * abandon refuses a worktree with uncommitted changes and never force-deletes an
 * unmerged branch (teardownWorktree's guards).
 * The boot reconcile is READ-ONLY over feature state — it rebuilds records and
 * surfaces anomalies, and destroys nothing.
 */

/** Test seams so the levers can be unit-tested against a stubbed-Ghostty
 *  registry + real git without reaching for a live Tui or a real forge. */
export interface FeatureManagerDeps {
  provision: typeof provisionWorktree;
  teardown: typeof teardownWorktree;
  reconcile: typeof reconcileFeatures;
  prepare: typeof prepareLanding;
  /** The feature_land human gate (still gated, still the only path that route
   *  takes to a merge). The QUEUE does not use it — its merge is the panel's. */
  review: typeof reviewLanding;
  /** The queue's merge: the panel's [m] and the non-TTY fallback both land
   *  through this. Injectable so the levers can be tested without a real merge. */
  execute: typeof executeLanding;
}

export interface FeatureManagerOptions {
  registry: DispatchRegistry;
  /** The linked repo — the WorktreeOptions.repoPath every lever operates on. */
  repoPath: string;
  /** The remote carrying the integration branch. Default "origin". */
  remote?: string;
  /** Injected runner for everything that touches the remote (fetch/push/gh).
   *  Tests pass a fake so no network and no gh binary are involved. */
  run?: CommandRunner;
  /** The human landing gate (the Tui). Absent off a real terminal (PlainIO):
   *  feature_land then reports that landing needs an interactive session. */
  gateHost?: LandingGateHost;
  /** How long the landing prepare waits on a PR's CI checks, and how often it
   *  looks. Defaults live in checks.ts; tests inject a no-op sleep. */
  checks?: ChecksPolicy;
  /** Durable per-feature prose — intents and authored PR messages
   *  (featurestore.ts) — loaded from the instance's `.dispatch/features.json` at
   *  session start. Omit for an in-memory store — the pre-persistence behaviour,
   *  and what tests get by default. */
  store?: FeatureStore;
  /** Overrides for the git/gate seams (tests only). */
  deps?: Partial<FeatureManagerDeps>;
}

export interface FeatureView {
  feature: string;
  slug: string;
  branch: string;
  worktreePath: string;
  provisionStatus: FeatureRecord["provisionStatus"];
  /** The intent the co gave at create time, if any. Persisted per slug
   *  (featurestore.ts), so it survives a restart and is still there for a record
   *  the boot reconcile rebuilt from the worktree on disk. */
  intent?: string;
  /** Jobs the registry has dispatched under this feature (id + status + label). */
  jobs: { id: string; status: string; label: string }[];
  /** Whether ANY crew agent is currently running in the worktree, of either
   *  role. Use `writerActive` for the question that gates landing. */
  busy: boolean;
  /** The agents live in the worktree right now, each with its role: `writer`
   *  (full access) or `reader` (the gated read-only audit lane). Empty when
   *  nothing is running. */
  agents: ActiveAgent[];
  /** Whether one of those agents is a WRITER. This is what blocks enqueuing,
   *  landing and abandoning; a worktree with only readers in it lands normally. */
  writerActive: boolean;
  /** The feature's place in the serial merge queue, when it is enqueued: its
   *  position, whether it is the head, and its queue status (queued /
   *  head-processing / awaiting-checks / ready / blocked). Absent when the
   *  feature isn't queued. */
  queue?: QueueEntryView;
}

export interface CreateResult {
  created: boolean;
  feature: FeatureView;
}

/**
 * Where a feature stands right now, in ONE word, for the panel's Home tab.
 * Derived entirely from state the session already holds — the registry's jobs,
 * the merge queue, the record's provision status. No git call, no model call,
 * nothing that costs anything to compute at paint time.
 *
 * The merge-queue statuses keep their queue spellings so the two tabs agree
 * about a feature that is in both.
 */
export type FeatureActivity =
  /** A crew agent is running in the worktree, and the feature is not in the
   *  merge queue. */
  | "working"
  /** Tracked, nothing running, not enqueued: work in the worktree, or waiting to
   *  be enqueued. The resting state. */
  | "idle"
  /** In the merge queue behind the head. */
  | "queued"
  /** The head, being rebased + build+tested right now. */
  | "processing"
  /** The head, green: its [m] is live in the queue tab. */
  | "ready"
  /** The head, blocked on a rebase conflict, a red build+test, or a missing
   *  prerequisite. */
  | "blocked"
  /** The head, with a fresh crew agent resolving it in its own worktree. */
  | "resolving"
  /** The worktree is still being provisioned. */
  | "provisioning"
  /** Provisioning failed; there is no usable checkout. */
  | "failed"
  /** The worktree was torn down while the record was still tracked. Nothing in
   *  the flow leaves a feature here today; it exists so the record's own
   *  `removed` provision status can never masquerade as a provision failure. */
  | "removed";

/**
 * One feature as the Ctrl-O Home tab shows it: what it is, where it is, and
 * what is happening to it. This is the overview the queue tab deliberately does
 * NOT give — the queue holds only the features the captain has marked done, and
 * everything still being worked is invisible there.
 */
export interface FeatureOverview {
  /** The feature handle (the name it was created under, or its slug after a
   *  restart rebuilt the record from the worktree). */
  feature: string;
  slug: string;
  branch: string;
  /** The stored one-line description, when the co gave one at create time. */
  intent?: string;
  status: FeatureActivity;
  /** Whether a crew agent is running in the worktree. Reported
   *  separately from `status` because an enqueued feature's queue state is the
   *  more useful chip, and a resolver agent working a blocked head must still be
   *  visible. */
  busy: boolean;
  /** 1-based landing position, when the feature is in the merge queue. */
  position?: number;
  /** Present when blocked: conflict vs red build+test. */
  blockedKind?: "conflict" | "failed";
  /**
   * Whether the worktree holds uncommitted changes, as of the last
   * `refreshDirty()`. Undefined means "not asked yet" and renders as the plain
   * state word rather than as clean — the one thing this must never do is claim
   * a tree is clean because nobody looked.
   *
   * It is the one field here that costs a git call, so unlike everything else in
   * this shape it is READ FROM A CACHE rather than derived per call: the panel
   * repaints many times a second and `git status` per worktree per frame would be
   * absurd. The panel asks for a refresh when the captain opens the Home tab.
   */
  dirty?: boolean;
}

export interface AbandonResult {
  abandoned: boolean;
  /** Present when abandoned: what teardown did (worktree removed, branch kept
   *  or deleted). */
  teardown?: TeardownResult;
  /** Present when refused: why (uncommitted changes in the worktree). */
  reason?: string;
}

/** resolveHead's plan: the head is resolvable and here is the fresh-agent order
 *  to arm (confirm-gated), or a refusal with the reason. The order is scoped to
 *  the head's OWN worktree/branch — it never touches dev. */
export type ResolveHeadPlan =
  | { ok: true; feature: string; kind: "conflict" | "failed"; attempt: number; maxAttempts: number; order: string }
  | { ok: false; reason: string };

/** Where each half of the enqueued feature's PR message comes from: the co's own
 *  authored text, or landing.ts's mechanical composition. Reported by enqueue so
 *  a bare re-enqueue visibly reuses what was authored earlier. */
export interface PrMessageOrigin {
  title: "authored" | "mechanical";
  body: "authored" | "mechanical";
}

/** What a captain's in-panel edit of the head PR's message left on the forge —
 *  read back FROM GitHub after the write, so the panel repaints from the truth
 *  rather than from the buffer that was typed (D-20260727-15). */
export interface PrMessageEditResult {
  feature: string;
  prNumber: number;
  url: string;
  /** The title GitHub now holds. */
  title: string;
  /** The description GitHub now holds, with co's evidence fence split back off. */
  prose: string;
}

export interface LandResult {
  feature: string;
  outcome: LandingGateResult["outcome"];
  /** A one-line human account of what the gate did. */
  summary: string;
  /** The prepare kind the gate reviewed (green/conflict/failed). */
  prepared: LandingGateResult["prepared"]["kind"];
  /** Present on a merge: the merge commit, the integration branch, and the PR
   *  that carried it. */
  merged?: { mergeSha: string; target: string; pr: { number: number; url: string } };
  /** Present when the gate's merge attempt was refused (a stale green, etc.). */
  error?: string;
}

export class FeatureManager {
  private readonly registry: DispatchRegistry;
  private readonly repoPath: string;
  private readonly remote: string | undefined;
  private readonly run: CommandRunner | undefined;
  private readonly gateHost?: LandingGateHost;
  private readonly checks: ChecksPolicy | undefined;
  private readonly deps: FeatureManagerDeps;
  /** The serial merge queue (mergequeue.ts). Owns the ordered "done" features
   *  and the head-only state machine; drives the EXISTING prepare + gate through
   *  the deps below. FeatureManager is its host (busy check + record cleanup). */
  private readonly queue: MergeQueue;
  /** The co's authored prose keyed by slug: the intent, so status/list and the
   *  panel's Home tab can show what a feature is FOR, and the PR title/body
   *  written at enqueue, which the queue hands to landing.ts on every head
   *  processing. Durable: git can rebuild everything else about a feature from its
   *  worktree, but not what the co wrote, so those fields are persisted under
   *  `.dispatch/features.json` (featurestore.ts) and read back at session start. */
  private readonly store: FeatureStore;
  /** Slug → "has uncommitted changes", as of the last refreshDirty(). The only
   *  thing on the panel's overview that costs a git call, so it is cached rather
   *  than derived: see refreshDirty. A slug that is absent is UNKNOWN, never
   *  clean. */
  private readonly dirty = new Map<string, boolean>();

  constructor(opts: FeatureManagerOptions) {
    this.registry = opts.registry;
    this.repoPath = opts.repoPath;
    this.remote = opts.remote;
    this.run = opts.run;
    if (opts.gateHost) this.gateHost = opts.gateHost;
    this.checks = opts.checks;
    this.store = opts.store ?? FeatureStore.ephemeral();
    this.deps = {
      provision: opts.deps?.provision ?? provisionWorktree,
      teardown: opts.deps?.teardown ?? teardownWorktree,
      reconcile: opts.deps?.reconcile ?? reconcileFeatures,
      prepare: opts.deps?.prepare ?? prepareLanding,
      review: opts.deps?.review ?? reviewLanding,
      execute: opts.deps?.execute ?? executeLanding,
    };
    this.queue = new MergeQueue({
      repoPath: this.repoPath,
      ...(this.checks ? { checks: this.checks } : {}),
      ...(this.remote ? { remote: this.remote } : {}),
      ...(this.run ? { run: this.run } : {}),
      host: {
        // WRITER-only, deliberately. The queue's question is "may I rebase and
        // push this worktree out from under whatever is in it", and only a
        // writer can be mid-edit or hold the index. A read-only auditor reading
        // the tree does not stop a landing (D-20260729-6).
        isBusy: (feature) => this.hasWriter(feature),
        forget: (feature) => {
          this.registry.removeFeature(feature);
          // Fire-and-forget: the in-memory drop is synchronous, and the file
          // rewrite never rejects (see FeatureStore.persist).
          void this.store.forget(safeSlug(feature));
        },
        prMessage: (feature) => this.authoredPrMessage(feature),
      },
      deps: { prepare: this.deps.prepare, execute: this.deps.execute },
    });
  }

  /** Whether ANY crew agent is currently running in the feature's worktree,
   *  reader or writer. This is the panel's "something is happening here" chip,
   *  never a gate — see hasWriter for that. */
  private isBusy(feature: string): boolean {
    return this.registry.activeAgents(feature).length > 0;
  }

  /** Whether a WRITING agent is live in the worktree. The gate on every verb
   *  that moves or destroys the checkout (enqueue via the queue host, land,
   *  abandon): a reader holds no index and leaves no bytes, so it blocks
   *  nothing. */
  private hasWriter(feature: string): boolean {
    return this.registry.hasActiveWriter(feature);
  }

  /** One line naming the live writers, for a refusal message. */
  private describeWriters(feature: string): string {
    const writers = this.registry
      .activeAgents(feature)
      .filter((a) => a.lane === "writer")
      .map((a) => (a.agentName ? `${a.jobId} [${a.agentName}]` : a.jobId));
    return writers.join(", ");
  }

  /**
   * The PR message the co authored for a feature, in landing.ts's vocabulary.
   * Read from the durable store by slug, so it survives a restart and is found
   * again for a record the boot reconcile rebuilt from the worktree. Undefined
   * (or a half-empty message) simply leaves landing.ts's mechanical composition
   * to fill that half in.
   */
  private authoredPrMessage(feature: string): AuthoredPrMessage | undefined {
    const slug = this.findRecord(feature)?.slug ?? safeSlug(feature);
    const stored = slug ? this.store.prMessage(slug) : undefined;
    if (!stored) return undefined;
    return {
      ...(stored.prTitle ? { title: stored.prTitle } : {}),
      ...(stored.prBody ? { body: stored.prBody } : {}),
    };
  }

  private worktreeOptions(): WorktreeOptions {
    return {
      repoPath: this.repoPath,
      ...(this.remote ? { remote: this.remote } : {}),
      ...(this.run ? { run: this.run } : {}),
    };
  }

  /** The worktree options plus the checks policy — what the landing engine takes. */
  private landingOptions(): LandingOptions {
    return { ...this.worktreeOptions(), ...(this.checks ? { checks: this.checks } : {}) };
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
    const agents = this.registry.activeAgents(record.feature);
    const intent = this.store.intent(record.slug);
    const queue = this.queue.viewFor(record.feature);
    return {
      feature: record.feature,
      slug: record.slug,
      branch: record.branch,
      worktreePath: record.worktreePath,
      provisionStatus: record.provisionStatus,
      ...(intent ? { intent } : {}),
      jobs,
      busy: agents.length > 0,
      agents,
      writerActive: agents.some((a) => a.lane === "writer"),
      ...(queue ? { queue } : {}),
    };
  }

  /**
   * Provision a feature's worktree off dev and register the record. Runs direct
   * — no confirm gate — because it writes nothing to dev or main (it only cuts a
   * fresh `<type>/<slug>` branch and its isolated checkout). `type` is a
   * Conventional Commits type (default feat), validated by the plumbing before
   * anything is created. Idempotent for an intact feature (returns the existing
   * worktree on its existing branch, created: false); throws with a reconcile
   * pointer on a half-state, which the executor surfaces.
   */
  async create(name: string, intent?: string, type?: string): Promise<CreateResult> {
    const before = this.findRecord(name);
    const alreadyReady =
      before?.provisionStatus === "ready" && fs.existsSync(before.worktreePath);
    const record = await this.deps.provision(this.worktreeOptions(), name, {
      ...(type ? { type } : {}),
    });
    this.registry.upsertFeature(record);
    // Persisted before the view is built, so the create result already carries
    // what a later restart will read back. A blank intent leaves whatever an
    // earlier create stored alone (FeatureStore.setIntent).
    if (intent) await this.store.setIntent(record.slug, intent);
    return { created: !alreadyReady, feature: this.toView(record) };
  }

  /** Every tracked feature, newest bookkeeping last. */
  list(): FeatureView[] {
    return this.registry.listFeatures().map((r) => this.toView(r));
  }

  /**
   * Every tracked feature as the Ctrl-O Home tab shows it — the at-a-glance
   * overview of everything in flight, not just what is queued to land. Pure
   * in-memory derivation (registry records + jobs + the queue snapshot + the
   * stored intent), so the panel can call it fresh on every paint the way it
   * already does for the queue.
   *
   * Ordered the way the captain reads it: whatever is closest to landing first
   * (the merge queue, in its own landing order), then everything still being
   * worked, alphabetically — a stable order, so a row never moves under the eye
   * because a job started somewhere else.
   */
  overview(): FeatureOverview[] {
    const rows = this.registry.listFeatures().map((record) => {
      const queue = this.queue.viewFor(record.feature);
      const busy = this.isBusy(record.feature);
      const intent = this.store.intent(record.slug);
      const dirty = this.dirty.get(record.slug);
      return {
        feature: record.feature,
        slug: record.slug,
        branch: record.branch,
        ...(intent ? { intent } : {}),
        status: featureActivity(record.provisionStatus, queue, busy),
        busy,
        ...(queue ? { position: queue.position } : {}),
        ...(queue?.blockedKind ? { blockedKind: queue.blockedKind } : {}),
        ...(dirty === undefined ? {} : { dirty }),
      } satisfies FeatureOverview;
    });
    return rows.sort((a, b) => {
      const pa = a.position ?? Number.MAX_SAFE_INTEGER;
      const pb = b.position ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      return a.slug.localeCompare(b.slug);
    });
  }

  /**
   * Re-read every tracked worktree's dirty flag into the cache `overview()`
   * reports from. One `git status --porcelain` per worktree, all of them at once,
   * and a worktree that fails to answer (removed under us, a git that errored)
   * drops out of the cache rather than being recorded as clean.
   *
   * Called by the panel when the captain opens the Home tab — the one moment the
   * answer is about to be looked at — never on a paint and never on a timer. It
   * NEVER REJECTS: an overview that shows a state word without the clean/dirty
   * refinement is a small loss; a panel key that throws is not.
   */
  async refreshDirty(): Promise<void> {
    const records = this.registry.listFeatures();
    const live = new Set(records.map((r) => r.slug));
    for (const slug of [...this.dirty.keys()]) {
      if (!live.has(slug)) this.dirty.delete(slug); // landed or abandoned since
    }
    await Promise.all(
      records.map(async (record) => {
        try {
          if (!fs.existsSync(record.worktreePath)) {
            this.dirty.delete(record.slug);
            return;
          }
          this.dirty.set(record.slug, await isWorktreeDirty(record.worktreePath));
        } catch {
          // Unknown beats wrong: the row shows its plain state word instead.
          this.dirty.delete(record.slug);
        }
      }),
    );
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
   * Land a feature: run the landing prepare (fetch, rebase onto `origin/dev`,
   * push, open/refresh its PR, read that PR's checks) and open the
   * Ctrl-O gate on the result. The gate IS the confirmation — there is no separate
   * prompt, and the merge (`gh pr merge --merge`) fires only if the human presses
   * [m] over a green prepare. On a merge the feature's worktree is torn down and
   * its branch ref kept, so its registry record is dropped too.
   *
   * Refuses cleanly (never throws) when no interactive gate is available (a
   * piped/non-TTY session), when the feature isn't tracked, or when a prerequisite
   * is missing (no gh, not authenticated, no `origin/dev`).
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
        summary: `'${feature}' is in the merge queue; it lands as the queue head, when the captain presses [m] on it in the Ctrl-O panel — not through a direct land.`,
        error: "feature is enqueued; it merges as the queue head",
      };
    }
    // Only a WRITER blocks. A read-only auditor in the same worktree is reading
    // a tree the landing is about to rebase, which costs it a stale view and
    // costs the landing nothing (D-20260729-6).
    if (this.hasWriter(feature)) {
      return {
        feature,
        outcome: "rejected",
        prepared: "failed",
        summary: `Feature '${feature}' still has a WRITING crew agent (${this.describeWriters(
          feature,
        )}); let it finish before landing.`,
        error: "a writing crew agent is still active in the worktree",
      };
    }

    const target = resolveWorktreeOptions(this.worktreeOptions()).devBranch;
    let result: LandingGateResult;
    try {
      result = await this.deps.review(this.gateHost, this.landingOptions(), feature);
    } catch (e) {
      // A prepare precondition failed — a missing prerequisite (no gh, not
      // authenticated, no origin/dev) or a lifecycle problem. Report it, don't
      // crash the tool call: the captain needs the message, not a stack.
      const error = e instanceof Error ? e.message : String(e);
      return {
        feature,
        outcome: "rejected",
        prepared: "failed",
        summary: `'${feature}' could not be prepared for landing: ${error}`,
        error,
      };
    }

    if (result.outcome === "merged" && result.landed) {
      // The worktree is gone and the branch ref kept (executeLanding tore only
      // the checkout down); drop the record and its intent so list/status
      // reflect reality.
      this.registry.removeFeature(feature);
      if (record) await this.store.forget(record.slug);
      return {
        feature,
        outcome: "merged",
        prepared: result.prepared.kind,
        summary:
          `landed ${feature}: PR #${result.landed.pr.number} merged into ${target} ` +
          `(${result.landed.mergeSha.slice(0, 7)})`,
        merged: { mergeSha: result.landed.mergeSha, target, pr: result.landed.pr },
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
   *
   * The feature is identified by its own worktree, so this can only ever act on
   * a checkout co provisioned; the tracked record's branch is passed through as
   * the fallback for the case where that checkout is already gone.
   *
   * A live WRITER refuses it outright, ahead of the dirty check: tearing a
   * checkout down under an agent that is mid-edit destroys work that has not
   * reached the index yet, and the dirty check alone would only catch it by
   * luck. A live READER does not refuse it (D-20260729-6) — it holds nothing.
   */
  async abandon(name: string): Promise<AbandonResult> {
    const record = this.findRecord(name);
    const feature = record?.feature ?? name;
    if (this.hasWriter(feature)) {
      return {
        abandoned: false,
        reason:
          `'${feature}' still has a WRITING crew agent (${this.describeWriters(feature)}); refusing to ` +
          `tear its worktree down underneath it. Let it finish, or stop it in its pane, then abandon.`,
      };
    }
    const entry = await findFeatureWorktree(this.worktreeOptions(), feature);
    if (entry && fs.existsSync(entry.path) && (await isWorktreeDirty(entry.path))) {
      return {
        abandoned: false,
        reason:
          `worktree ${entry.path} has uncommitted changes; refusing to abandon '${feature}'. ` +
          `Commit or discard the work in the pane first, or decide deliberately to lose it.`,
      };
    }
    const teardown = await this.deps.teardown(this.worktreeOptions(), feature, {
      ...(record?.branch ? { branch: record.branch } : {}),
    });
    this.registry.removeFeature(feature);
    if (record) await this.store.forget(record.slug);
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
  // PR checks via the EXISTING landing prepare); a green head simply CARRIES a
  // live [m] in the Ctrl-O panel (D-20260724-12) until the captain presses it; on
  // merge the queue advances and the next feature is processed against the new
  // dev tip. The co is not in that loop — it engages only on a blocked head.
  // See mergequeue.ts.

  /**
   * Enqueue a feature as "done" (mark-done). No confirm gate — enqueue is the
   * trigger, and the only gate in the flow is the merge keystroke on the head.
   * When the feature becomes the head, it is processed immediately (rebase onto
   * the current dev tip, pushed, PR'd, and its PR's checks read); a green head then simply carries
   * a live [m] in the panel until the captain presses it. Re-enqueuing a blocked
   * head is the retry lever. Reports not-found for a feature never created.
   *
   * THE PR MESSAGE IS AUTHORED HERE. Enqueue is the one, once-per-landing moment
   * the co declares a feature done, so it is where the co attaches the pull
   * request's title and description — the alternative was landing.ts's mechanical
   * composition, which only ever knew the commit subjects. `message` is stored
   * per feature (durably, so it survives a restart) and consumed by every later
   * head processing; each field is an independent override, and OMITTING one
   * leaves whatever is stored intact. A bare re-enqueue after a resolver run
   * therefore reuses the co's message rather than reverting to the fallback.
   *
   * AND IT REACHES AN ALREADY-OPEN PULL REQUEST (D-20260804-1). Storing it was
   * only ever half the job: a message passed for a feature whose PR was already
   * open used to sit in the store and never be delivered, so the pull request
   * went on saying whatever the first enqueue composed. The halves passed on THIS
   * call are handed to the queue as well as stored, and the PR's prior title and
   * body come back on the result (`prMessageReplaced`) so the co can see what it
   * overwrote. Only the passed halves travel: the stored message stays create-only,
   * or every automatic re-process would revert a captain's edit on GitHub.
   */
  async enqueue(
    name: string,
    message?: { prTitle?: string; prBody?: string },
  ): Promise<
    | ({ enqueued: true; prMessage: PrMessageOrigin } & EnqueueResult)
    | { enqueued: false; feature: string; reason: string }
  > {
    const record = this.findRecord(name);
    if (!record) {
      return {
        enqueued: false,
        feature: name,
        reason: `no feature '${name}' is tracked; create it with feature_create first.`,
      };
    }
    // Stored BEFORE the queue processes the head, because processing is what
    // opens the PR — the message has to be on disk by the time it is read back.
    // Normalised on the way in: a one-line title, and prose with any evidence
    // fence stripped, so co's regenerated block can never be frozen into the
    // authored body.
    const prTitle = authoredPrTitle(message?.prTitle);
    const prBody = authoredPrBody(message?.prBody);
    await this.store.setPrMessage(record.slug, {
      ...(prTitle ? { prTitle } : {}),
      ...(prBody ? { prBody } : {}),
    });
    // The same halves again, this time as what was passed NOW rather than what is
    // stored — the queue writes these onto an open PR and leaves the rest alone.
    const passed: AuthoredPrMessage = {
      ...(prTitle ? { title: prTitle } : {}),
      ...(prBody ? { body: prBody } : {}),
    };
    const res = await this.queue.enqueue(
      record.feature,
      passed.title === undefined && passed.body === undefined ? undefined : passed,
    );
    return { enqueued: true, prMessage: this.prMessageOrigin(record.slug), ...res };
  }

  /** Whether the head's PR message is the co's own or landing.ts's mechanical
   *  fallback — reported back on enqueue so the co can see at a glance that the
   *  message it wrote (this call or an earlier one) is the one in play. */
  private prMessageOrigin(slug: string): PrMessageOrigin {
    const stored = this.store.prMessage(slug);
    return {
      title: stored?.prTitle ? "authored" : "mechanical",
      body: stored?.prBody ? "authored" : "mechanical",
    };
  }

  /**
   * MERGE THE READY HEAD — the panel's [m] (D-20260724-12). Merges the head's
   * pull request on GitHub, tears its worktree down (keeping the branch ref),
   * advances the queue, and processes the new head against the freshly-fetched
   * `origin/dev`, all in one call and with nothing waiting on a human: the
   * keystroke that got here IS the authorisation. Only a `ready`
   * (green) head merges; anything else is refused cleanly with the reason and
   * writes nothing. Never throws.
   *
   * The session wires this behind the Tui's queue-panel `merge` callback, so the
   * ONLY thing that reaches it in an interactive session is that keystroke. The
   * co never calls it; feature_merge_head below is deliberately not this.
   */
  async mergeReadyHead(): Promise<MergeHeadResult> {
    return this.queue.mergeReadyHead();
  }

  /**
   * feature_merge_head — the co-facing verb, kept ONLY as a non-interactive
   * fallback (D-20260724-12). It is no longer the merge path and it never blocks
   * the co's loop on a keystroke:
   *
   *  - Interactive session (a panel exists): merges NOTHING and returns at once,
   *    reporting the head's state and that the live `[m]` in the Ctrl-O queue tab
   *    is the captain's to press. The co is free; there is nothing to wait for.
   *  - No panel (piped/non-TTY): there is no key to press, so the ready head is
   *    merged directly — same guards, same executeLanding, same `gh pr merge
   *    --merge`.
   */
  async mergeHead(): Promise<MergeHeadResult> {
    if (!this.gateHost) return this.queue.mergeReadyHead();
    const view = this.queue.view();
    const head = view.head;
    const summary = !head
      ? "the merge queue is empty; nothing to merge."
      : head.status === "ready"
        ? `head '${head.feature}' is ready and its [m] is already live in the captain's Ctrl-O queue tab (with its pull request and what its CI checks said). Merging is their keystroke, not a tool call — say it's ready and move on; do NOT wait for it.`
        : `head '${head.feature}' is ${head.status}${
            head.blockedReason ? ` (${head.blockedReason})` : ""
          }; there is no [m] to press until it is green.`;
    return {
      merged: false,
      outcome: "panel",
      feature: head?.feature ?? "",
      summary,
      head,
      queue: view,
    };
  }

  /** The full merge-queue snapshot (order + head + per-entry status). */
  queueView(): QueueView {
    return this.queue.view();
  }

  /** The head's inline body for the panel's queue tab: a ready head's commits +
   *  PR + checks evidence, or a blocked head's reason. Null for anything
   *  else. Read fresh at paint time by the Tui's injected queue source. */
  headDetail(): QueueHeadDetail | null {
    return this.queue.headDetail();
  }

  /**
   * REWRITE THE HEAD PR'S MESSAGE — the panel's `e` (D-20260727-15). The captain
   * edits the title and the prose in a popup over the queue tab and presses
   * Ctrl-S; this is the whole save.
   *
   * It writes in two places on purpose, and neither is optional:
   *
   *  1. THE PULL REQUEST, through `gh pr edit`. The open PR is the artifact that
   *     merges, so it is the one that has to say the right thing. co's fenced
   *     evidence block is carried across untouched by forge.updatePrMessage —
   *     the captain never sees it and cannot delete it.
   *  2. THE FEATURE STORE. The stored message is read on EVERY head processing,
   *     so leaving it alone would let a superseded message come back the next
   *     time a PR is created for this feature. `allowClear` is passed for the
   *     same reason: a description the captain deleted must stay deleted.
   *
   * Then the PR is read back from the forge and the head's cached copy replaced
   * with it, so what the panel repaints is what GitHub stored — not the buffer
   * that was typed. If the write lands but the re-read fails (a network blip
   * between two gh calls), the composed body stands in rather than failing an
   * edit that already succeeded.
   *
   * Merges NOTHING and touches no checks, no gate and no queue order: the head's
   * status, its `[m]`, and everything behind it are exactly as they were.
   */
  async editHeadPrMessage(message: {
    title: string;
    body: string;
    /** The PR the caller MEANT — the one the editor was opened on. Pinned, so a
     *  head that was re-prepared while the captain typed fails loudly instead of
     *  having another pull request's message stamped onto it. */
    prNumber?: number;
  }): Promise<PrMessageEditResult> {
    const head = this.queue.headPr();
    if (!head) {
      throw new Error("the merge-queue head has no open pull request; there is no message to edit.");
    }
    if (message.prNumber !== undefined && message.prNumber !== head.pr.number) {
      throw new Error(
        `the queue head's pull request changed while you were editing (#${message.prNumber} → ` +
          `#${head.pr.number}); nothing was written — re-open the editor on the new one.`,
      );
    }
    const title = authoredPrTitle(message.title);
    if (!title) throw new Error("a pull request needs a title; line 1 of the editor is empty.");
    const prose = authoredPrBody(message.body);

    const forge = forgeOptions(this.worktreeOptions());
    const written = await updatePrMessage(forge, head.pr, { title, prose });
    const slug = this.findRecord(head.feature)?.slug ?? featureSlug(head.feature);
    await this.store.setPrMessage(slug, { prTitle: title, prBody: prose }, { allowClear: true });

    let fresh = written;
    try {
      fresh = await viewPr(forge, head.pr.number);
    } catch {
      // The edit is already on GitHub; a failed read-back is not a failed save.
    }
    this.queue.updateHeadPrMessage({ number: head.pr.number, title: fresh.title, body: fresh.body });
    return {
      feature: head.feature,
      prNumber: head.pr.number,
      url: fresh.url || head.pr.url,
      title: fresh.title,
      prose: splitEvidence(fresh.body).prose,
    };
  }

  /**
   * Plan a fresh-agent resolve of the blocked head (D-20260723-24). Checks the
   * head is resolvable (blocked by a conflict or a red CI check, under the retry
   * bound) and, if so, drafts the crew ORDER scoped to the feature's OWN worktree
   * and branch: rebase onto the current dev tip, resolve the conflict, fix
   * whatever CI called out, commit — never touching dev. Returns the plan (which
   * the tool arms as a confirm-gated, feature-scoped dispatch) or a refusal. This
   * does NOT dispatch or change queue state; beginResolveHead does that at fire.
   *
   * The order NAMES the failing checks (and links them) when the block is a red
   * check: co cannot run the suite itself, so the one useful thing it can hand a
   * resolver is exactly what GitHub said went wrong.
   */
  planResolveHead(): ResolveHeadPlan {
    const gate = this.queue.canResolveHead();
    if (!gate.ok) return { ok: false, reason: gate.reason };
    const record = this.findRecord(gate.feature);
    // The record's branch is the real one (it came from the worktree). The
    // projection behind it is only for a queued feature whose record somehow
    // went missing — order prose, not a ref anything acts on.
    const branch = record?.branch ?? featureBranch(gate.feature);
    const target = resolveWorktreeOptions(this.worktreeOptions()).devBranch;
    const detail = this.queue.headDetail();
    const blocked = detail?.kind === "blocked" ? detail : undefined;
    const order = buildResolveOrder({
      feature: gate.feature,
      branch,
      target,
      kind: gate.kind,
      reason: this.queue.viewFor(gate.feature)?.blockedReason ?? "",
      ...(blocked?.pr ? { prNumber: blocked.pr.number, prUrl: blocked.pr.url } : {}),
      failedChecks: blocked?.checks
        ? failedChecks(blocked.checks).map((r) => (r.link ? `${r.name} (${r.link})` : r.name))
        : [],
      ...(blocked?.checks ? { checksSummary: checksLine(blocked.checks) } : {}),
    });
    return {
      ok: true,
      feature: gate.feature,
      kind: gate.kind,
      attempt: gate.attempt,
      maxAttempts: MAX_RESOLVE_ATTEMPTS,
      order,
    };
  }

  /**
   * Mark the head "resolving" once a resolver dispatch has actually fired (the
   * captain confirmed). Counts the attempt against the retry bound. Called by the
   * session's fire path, not at arm time, so a cancelled arm never burns an
   * attempt. Returns the started head view or a refusal (the head changed under us).
   */
  beginResolveHead(): { started: true; head: QueueEntryView } | { started: false; reason: string } {
    return this.queue.beginResolve();
  }

  /**
   * Re-process the head after its resolver agent finished. Green -> ready; still
   * blocked -> blocked (attempt count preserved for the bound). A no-op if the
   * feature is no longer the resolving head. Called from the session's completion
   * drain for a feature that was being resolved.
   */
  async onResolveDone(feature: string): Promise<ProcessHeadResult> {
    return this.queue.onResolveDone(feature);
  }

  /** Whether a given feature is the current head AND being resolved — so the
   *  session's completion handler knows to re-process it when its agent finishes. */
  isResolvingHead(feature: string): boolean {
    const head = this.queue.view().head;
    return Boolean(head && head.status === "resolving" && head.feature === feature);
  }

  /**
   * Boot reconcile: rebuild feature records from the on-disk worktrees and seed
   * the registry, so a feature survives a session restart. Non-destructive —
   * anomalies (a stray dir under the managed base) are
   * returned for surfacing, never acted on. Records already tracked are
   * overwritten by the fresh on-disk truth.
   *
   * A rebuilt record carries its description with it: the record comes from git,
   * the intent comes from the persisted store (loaded at session start and keyed
   * by the same slug the branch name yields), so `list`/`status`/`overview` show
   * what a recovered feature is FOR and not just where it lives.
   */
  async reconcileAtBoot(): Promise<FeatureReconcileReport> {
    const report = await this.deps.reconcile(this.worktreeOptions());
    for (const record of report.records) this.registry.upsertFeature(record);
    return report;
  }
}

/**
 * One feature's state as a single word, from what the session already knows.
 *
 * Precedence is deliberate. A half-provisioned worktree wins outright — there is
 * no usable checkout, so nothing else about the feature is worth reading. Then
 * the MERGE QUEUE, because once a feature is enqueued its queue state is the
 * thing the captain is waiting on (a resolver agent working a blocked head shows
 * as `resolving`, not as a generic `working`, which is the more useful of the
 * two). A crew agent running outside the queue is `working`, and everything else
 * is `idle`: created, maybe committed, not yet lined up to land. `busy` is
 * carried alongside either way, so an agent is never invisible.
 */
export function featureActivity(
  provisionStatus: FeatureRecord["provisionStatus"],
  queue: QueueEntryView | null | undefined,
  busy: boolean,
): FeatureActivity {
  if (provisionStatus === "provisioning") return "provisioning";
  if (provisionStatus === "failed") return "failed";
  if (provisionStatus === "removed") return "removed";
  if (queue) {
    switch (queue.status) {
      case "queued": return "queued";
      case "head-processing": return "processing";
      case "ready": return "ready";
      case "blocked": return "blocked";
      case "resolving": return "resolving";
    }
  }
  return busy ? "working" : "idle";
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

/**
 * The order handed to a fresh crew agent to unblock a merge-queue head, run in
 * the feature's OWN worktree (the dispatch is feature-scoped, so cwd is already
 * that checkout on its branch). The mandate is narrow and load-bearing: rebase
 * the feature branch onto the current dev tip, resolve whatever blocked it, get
 * the pull request's checks green, and commit — all on the feature branch, NEVER
 * touching dev. The queue re-processes the head after the agent finishes, so the
 * agent doesn't merge anything; it only makes the branch mergeable.
 *
 * The order does NOT name a build or test command, because co does not know one
 * and no longer pretends to (D-20260727-1). What it hands over instead is what
 * CI actually reported — the failing check names and their run links — and the
 * instruction to verify the way the repo verifies. The agent is in the repo; it
 * can read the workflow.
 */
function buildResolveOrder(opts: {
  feature: string;
  branch: string;
  target: string;
  kind: "conflict" | "failed";
  reason: string;
  /** The failing checks, "name (link)", when the block is a red check. */
  failedChecks: string[];
  /** One line of what the checks read said. */
  checksSummary?: string;
  prNumber?: number;
  prUrl?: string;
}): string {
  const { feature, branch, target, kind, reason, failedChecks: failing, checksSummary } = opts;
  const prRef = opts.prNumber ? `PR #${opts.prNumber}${opts.prUrl ? ` (${opts.prUrl})` : ""}` : "its pull request";
  const diagnosis =
    kind === "conflict"
      ? `Rebasing ${branch} onto origin/${target} hit merge conflicts.`
      : `${branch} rebases onto origin/${target} cleanly, but the CI checks on ${prRef} are failing.`;
  const verify =
    kind === "conflict"
      ? `3. Verify the branch the way this repo verifies (read its CI workflow and run the same commands locally). ` +
        `The merge gate is ${prRef}'s own checks, so match what they run.`
      : `3. Fix what CI reported. Read the failing runs above, reproduce them locally the way this repo does ` +
        `(its CI workflow names the commands), and fix until they would pass.`;
  const lines = [
    `You are resolving a blocked merge-queue head for the feature "${feature}".`,
    ``,
    `You are already in this feature's isolated worktree, checked out on ${branch}. Work ONLY here.`,
    ``,
    `Situation: ${diagnosis}`,
    ...(reason ? [`Queue diagnosis: ${reason}`] : []),
    ...(checksSummary ? [`Checks: ${checksSummary}`] : []),
    ...(failing.length > 0 ? [``, `Failing checks:`, ...failing.map((c) => `- ${c}`)] : []),
    ``,
    `Do this, in order:`,
    `1. \`git fetch origin\`, then rebase ${branch} onto the current remote tip: \`git rebase origin/${target}\`.`,
    `2. Resolve any conflicts so the rebase completes cleanly. Keep both sides' intent; do not drop work.`,
    verify,
    `4. Commit your resolution on ${branch} (the rebase's conflict resolutions plus any fixes) in Conventional`,
    `   Commits form, e.g. \`fix(${feature}): resolve rebase onto ${target}\`. Write the commit message EXACTLY as you`,
    `   compose it and add nothing else: no \`Co-Authored-By\`, no "Generated with", no agent or tool attribution`,
    `   trailer of any kind. Leave the worktree clean.`,
    ``,
    `HARD RULES:`,
    `- NEVER check out, merge into, or push ${target} (dev) or main. You only ever touch ${branch} in this worktree.`,
    `- Do not push the branch and do not open or merge a pull request. The queue pushes ${branch} and opens its PR`,
    `  itself, and the captain merges that PR once its checks are green. Your job ends at a clean commit.`,
    `- Leave the worktree clean (no uncommitted changes) so the queue can re-process it.`,
    ``,
    `When the rebase is clean, what CI called out is fixed, and everything is committed, you are done. The queue`,
    `re-pushes the branch and re-reads ${prRef}'s checks; those are the verdict, not your own say-so.`,
  ];
  return lines.join("\n");
}
