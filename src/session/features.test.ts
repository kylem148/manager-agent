import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { instancePaths, type InstancePaths } from "../paths.js";
import { defaultDispatchConfig } from "./dispatchconfig.js";
import { DispatchRegistry } from "./registry.js";
import { FeatureManager, featureActivity } from "./features.js";
import { FeatureStore } from "./featurestore.js";
import type { QueueEntryView } from "./mergequeue.js";
import { composePrMessage } from "./landing.js";
import { splitEvidence } from "./forge.js";
import { makeExecutor, newSideEffects, toolDefinitions } from "./tools.js";
import type { ResearchConfig } from "../config.js";
import {
  featureBranch,
  provisionWorktree,
  reconcileFeatures,
  defaultWorktreeBase,
} from "./worktrees.js";
import type { LandingGateHost } from "./landinggate.js";
import type { ActiveAgent } from "./lanes.js";
import type { LandingReview } from "../tui/tui.js";
import { makeFakeForge, type FakeForge } from "./forgefake.test.js";
import type { ChecksPolicy } from "./checks.js";

/** No wall-clock in a unit test: the checks poll sleeps instantly and neither
 *  deadline buys a second look. With no checks seeded on the fake forge, every
 *  head here comes back green-but-UNGATED, which is exactly what a repo with no
 *  CI looks like. */
const FAST_CHECKS: ChecksPolicy = { timeoutMs: 0, graceMs: 0, intervalMs: 1, sleep: async () => {} };

/**
 * Tests for the co-facing feature levers (features.ts), against real throwaway
 * git repos — the levers are thin wrappers over git plumbing, so the subject is
 * what git ends up doing — with the whole remote surface (fetch, push, gh) served
 * by the fake forge. No network, no gh binary, no GitHub account.
 *
 * `dev` here lives ONLY on the fake remote, and the fixture checks the local
 * `dev` out in the primary tree: that is the captain's real setup, and it is
 * exactly what the old local merge could not cope with. Every landing assertion
 * reads `fx.originDev()`, because that is now the only dev co ever moves.
 *
 * The DispatchRegistry is real but built with ghosttyAvailable: false (no panes
 * needed here; the feature-scoped DISPATCH cwd is proved in registry.test.ts)
 * and a stub installHook so the suite never mutates the developer's ~/.claude.
 * The landing gate is a scripted host, the same stand-in landinggate.test.ts
 * uses for the human's [m]/[r] keystroke.
 */

function run(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed (${res.status}): ${res.stderr}`);
  return res.stdout.trim();
}

function branchExists(repo: string, branch: string): boolean {
  return (
    spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo }).status === 0
  );
}

async function commitIn(worktree: string, file: string, content: string, msg: string): Promise<void> {
  await fsp.writeFile(path.join(worktree, file), content, "utf8");
  run(worktree, ["add", file]);
  run(worktree, ["commit", "-qm", msg]);
}

interface Fixture {
  repo: string;
  base: string;
  registry: DispatchRegistry;
  features: FeatureManager;
  forge: FakeForge;
  /** The instance paths the fixture's state (captures, the feature store) lives
   *  under — the same tier a real session writes to. */
  paths: InstancePaths;
  /** The integration tip as the remote holds it — the only dev co moves. */
  originDev: () => string;
  /** WorktreeOptions for calling the plumbing directly in a test. */
  opts: { repoPath: string; run: FakeForge["run"] };
  /** Build a FRESH manager over the SAME repo and the same on-disk instance
   *  state, with an empty registry: a session restart, in one call. */
  restart: () => Promise<FeatureManager>;
  cleanup: () => Promise<void>;
}

/** A real repo + registry + FeatureManager. The manager operates on the repo's
 *  DEFAULT worktree base (a sibling dir) so it matches what the registry's
 *  provision path uses; `base` is that dir. The checks poll never sleeps. */
async function makeFixture(gateHost?: LandingGateHost): Promise<Fixture> {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "co-feat-")));
  const repo = path.join(root, "repo");
  await fsp.mkdir(repo);
  run(repo, ["init", "-q", "-b", "main"]);
  run(repo, ["config", "user.email", "test@test"]);
  run(repo, ["config", "user.name", "test"]);
  run(repo, ["config", "commit.gpgsign", "false"]);
  await fsp.writeFile(path.join(repo, "file.txt"), "hello\n", "utf8");
  run(repo, ["add", "."]);
  run(repo, ["commit", "-q", "-m", "init"]);
  // The captain's checkout: dev exists locally and is checked out here. co must
  // never write it — every landing goes to the remote through a PR.
  run(repo, ["branch", "dev", "main"]);
  run(repo, ["checkout", "-q", "dev"]);
  const forge = makeFakeForge(repo, { dev: run(repo, ["rev-parse", "dev"]) });
  // Every PR in these fixtures reports one passing check, so the ordinary path is
  // an ordinary green. The no-checks (ungated) path has its own tests.
  forge.defaultChecks = [{ name: "ci", bucket: "pass" }];

  const paths = instancePaths(path.join(root, "home"), "inst");
  await fsp.mkdir(paths.captures, { recursive: true });
  const config = defaultDispatchConfig();
  config.repoPath = repo;

  const registries: DispatchRegistry[] = [];
  const makeRegistry = (): DispatchRegistry => {
    const r = new DispatchRegistry({
      paths,
      config,
      onComplete: () => {},
      ghosttyAvailable: false,
      pollIntervalMs: 10_000,
      installHook: async () => ({ configDir: "/fake", changed: true }),
    });
    registries.push(r);
    return r;
  };
  // A real, file-backed intent store under the instance's .dispatch/ — the same
  // one a session loads at start — so what a test writes is what a restart reads.
  const makeManager = async (reg: DispatchRegistry): Promise<FeatureManager> =>
    new FeatureManager({
      registry: reg,
      repoPath: repo,
      run: forge.run,
      store: await FeatureStore.load(paths),
      ...(gateHost ? { gateHost } : {}),
      checks: FAST_CHECKS,
    });

  const registry = makeRegistry();
  const features = await makeManager(registry);
  return {
    repo,
    base: defaultWorktreeBase(repo),
    registry,
    features,
    forge,
    paths,
    originDev: () => forge.branches.get("dev")!,
    opts: { repoPath: repo, run: forge.run },
    restart: async () => makeManager(makeRegistry()),
    cleanup: async () => {
      for (const r of registries) r.stop();
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

test("feature_create provisions a worktree off origin/dev and registers the record; a second create is idempotent", async () => {
  const fx = await makeFixture();
  try {
    const res = await fx.features.create("User Auth", "add login");
    assert.equal(res.created, true);
    assert.equal(res.feature.slug, "user-auth");
    assert.equal(res.feature.branch, "feat/user-auth");
    assert.equal(res.feature.provisionStatus, "ready");
    assert.equal(res.feature.intent, "add login");
    // A real worktree exists on the feature branch, cut from origin/dev.
    assert.ok(fs.existsSync(res.feature.worktreePath));
    assert.equal(run(res.feature.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]), "feat/user-auth");
    assert.equal(run(res.feature.worktreePath, ["rev-parse", "HEAD"]), fx.originDev());
    // The captain's own checkout is untouched: still on dev, still at its tip.
    assert.equal(run(fx.repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "dev");
    assert.equal(run(fx.repo, ["status", "--porcelain"]), "");
    // The registry now tracks it.
    assert.equal(fx.registry.getFeature("User Auth")?.slug, "user-auth");

    // Idempotent: creating again returns the same worktree, created: false.
    const again = await fx.features.create("User Auth");
    assert.equal(again.created, false);
    assert.equal(again.feature.worktreePath, res.feature.worktreePath);
  } finally {
    await fx.cleanup();
  }
});

test("feature_create names the branch for the conventional type it is given", async () => {
  const fx = await makeFixture();
  try {
    const res = await fx.features.create("Stale Token", "the refresh path", "fix");
    assert.equal(res.feature.branch, "fix/stale-token");
    assert.equal(res.feature.slug, "stale-token", "the slug, the dir and the record stay type-free");
    assert.equal(run(res.feature.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]), "fix/stale-token");

    // A type outside the Conventional Commits set is refused before anything is
    // cut, and the failed feature leaves no trace.
    await assert.rejects(fx.features.create("Some Thing", undefined, "wip"), /unknown branch type/);
    assert.equal(fx.features.list().find((f) => f.slug === "some-thing"), undefined);
    assert.ok(!branchExists(fx.repo, "wip/some-thing"));
    assert.ok(!branchExists(fx.repo, "feat/some-thing"));
  } finally {
    await fx.cleanup();
  }
});

test("a branch of the captain's that looks like a feature is never adopted, landed or abandoned", async () => {
  const fx = await makeFixture();
  try {
    // Their own branch, in their own worktree, named exactly as ours would be.
    const theirs = path.join(fx.repo, "..", "captains-tree");
    run(fx.repo, ["worktree", "add", "-q", theirs, "-b", "feat/their-thing", "main"]);

    const report = await fx.features.reconcileAtBoot();
    assert.deepEqual(report.records, [], "startup rebuilds nothing from it");
    assert.deepEqual(report.anomalies, [], "and reports nothing about it either");
    assert.deepEqual(fx.features.list(), []);

    // Abandon can't reach it: no worktree of co's under the base, so there is
    // nothing to tear down and nothing whose branch could be deleted.
    const res = await fx.features.abandon("their thing");
    assert.equal(res.abandoned, true, "it reports a clean no-op");
    assert.equal(res.teardown?.worktreeRemoved, false);
    assert.equal(res.teardown?.branchDeleted, false);
    assert.ok(branchExists(fx.repo, "feat/their-thing"), "their branch survives untouched");
    assert.ok(fs.existsSync(theirs), "and so does their checkout");
  } finally {
    await fx.cleanup();
  }
});

test("a legacy co/feat-* feature is rebuilt from its worktree and lands on its own branch, unrenamed", async () => {
  const fx = await makeFixture();
  try {
    // Exactly what an older build left on disk: the checkout at <base>/<slug>,
    // on the old branch name, with committed work on it.
    await provisionWorktree(fx.opts, "seed"); // gets origin/dev into the repo
    await fsp.mkdir(fx.base, { recursive: true });
    const legacyPath = path.join(fx.base, "prompt-fixes");
    run(fx.repo, ["worktree", "add", "-q", legacyPath, "-b", "co/feat-prompt-fixes", "origin/dev"]);
    await commitIn(legacyPath, "p.txt", "prompt work\n", "docs: sharpen the orders protocol");

    // Startup finds it by its worktree and tracks it on the branch it holds.
    const report = await fx.features.reconcileAtBoot();
    const rebuilt = report.records.find((r) => r.slug === "prompt-fixes");
    assert.ok(rebuilt, "the legacy feature is rebuilt");
    assert.equal(rebuilt.branch, "co/feat-prompt-fixes");
    assert.deepEqual(report.anomalies, []);

    // It lands through the ordinary queue: its OWN branch is what gets pushed,
    // PR'd and merged. Nothing is renamed anywhere along the way.
    const enq = await fx.features.enqueue("prompt-fixes");
    assert.equal(enq.enqueued, true);
    if (!enq.enqueued) return;
    assert.equal(enq.head?.status, "ready");
    assert.equal(fx.forge.prFor("co/feat-prompt-fixes")?.base, "dev", "the PR is from the legacy branch");

    const merged = await fx.features.mergeReadyHead();
    assert.equal(merged.merged, true);
    assert.equal(run(fx.repo, ["show", `${fx.originDev()}:p.txt`]), "prompt work");
    assert.ok(!fs.existsSync(legacyPath), "its worktree was torn down");
    assert.ok(branchExists(fx.repo, "co/feat-prompt-fixes"), "and its branch ref kept, under its old name");
    assert.ok(!branchExists(fx.repo, "feat/prompt-fixes"), "no conventional twin was ever created");
  } finally {
    await fx.cleanup();
  }
});

test("feature_status reports dirty state and jobs; a missing feature returns null", async () => {
  const fx = await makeFixture();
  try {
    await fx.features.create("cleanup");
    const clean = await fx.features.status("cleanup");
    assert.ok(clean);
    assert.equal(clean.dirty, false);

    // Dirty the worktree with an uncommitted file.
    await fsp.writeFile(path.join(clean.worktreePath, "scratch.txt"), "wip\n", "utf8");
    const dirty = await fx.features.status("cleanup");
    assert.equal(dirty?.dirty, true);

    assert.equal(await fx.features.status("nope"), null);
  } finally {
    await fx.cleanup();
  }
});

test("feature_abandon tears down a clean worktree and deletes its merged/unstarted branch", async () => {
  const fx = await makeFixture();
  try {
    const created = await fx.features.create("scrap");
    const branch = created.feature.branch;
    assert.ok(fs.existsSync(created.feature.worktreePath));

    const res = await fx.features.abandon("scrap");
    assert.equal(res.abandoned, true);
    assert.equal(res.teardown?.worktreeRemoved, true);
    // A fresh feature has no commits beyond dev, so it is "merged" and the branch is deleted.
    assert.equal(res.teardown?.branchDeleted, true);
    assert.ok(!fs.existsSync(created.feature.worktreePath));
    assert.ok(!branchExists(fx.repo, branch));
    assert.equal(fx.registry.getFeature("scrap"), undefined, "the record is dropped");
  } finally {
    await fx.cleanup();
  }
});

test("feature_abandon REFUSES a dirty worktree and forces nothing", async () => {
  const fx = await makeFixture();
  try {
    const created = await fx.features.create("risky");
    await fsp.writeFile(path.join(created.feature.worktreePath, "wip.txt"), "unsaved\n", "utf8");

    const res = await fx.features.abandon("risky");
    assert.equal(res.abandoned, false);
    assert.match(res.reason ?? "", /uncommitted changes/);
    // Nothing was destroyed.
    assert.ok(fs.existsSync(created.feature.worktreePath));
    assert.ok(branchExists(fx.repo, created.feature.branch));
    assert.ok(fx.registry.getFeature("risky"), "the record survives a refused abandon");
  } finally {
    await fx.cleanup();
  }
});

test("feature_abandon keeps a committed-but-unmerged branch and reports why", async () => {
  const fx = await makeFixture();
  try {
    const created = await fx.features.create("wip-feature");
    // Commit real work: now the branch has commits not in dev.
    await commitIn(created.feature.worktreePath, "real.txt", "work\n", "job: real work");

    const res = await fx.features.abandon("wip-feature");
    assert.equal(res.abandoned, true, "a CLEAN worktree (committed work) can be abandoned");
    assert.equal(res.teardown?.worktreeRemoved, true);
    assert.equal(res.teardown?.branchDeleted, false, "but the unmerged branch is KEPT");
    assert.match(res.teardown?.branchKeptReason ?? "", /not merged into 'origin\/dev'/);
    assert.ok(branchExists(fx.repo, created.feature.branch), "the branch survives to preserve the work");
  } finally {
    await fx.cleanup();
  }
});

// --- feature_land through a scripted gate ------------------------------------

/** A host that behaves like a human pressing [m] over a green (and dismissing
 *  anything else) — the same stand-in landinggate.test.ts uses. */
function approvingHost(seen: LandingReview[]): LandingGateHost {
  return {
    async openLandingReview(review) {
      seen.push(review);
      if (review.prepared.kind !== "green") return "rejected";
      try {
        await review.execute();
        return "merged";
      } catch {
        return "failed";
      }
    },
  };
}

/**
 * Pretend crew agents are live in a feature's worktree, with the roles they
 * hold. The registry derives its active-agent list from real running jobs, and a
 * real job needs a Ghostty pane these fixtures deliberately do not have — so the
 * list is stubbed on the registry INSTANCE. `hasActiveWriter` is left alone on
 * purpose: it is implemented over `activeAgents`, so stubbing the one keeps the
 * two answers consistent instead of letting a test set up a state the real
 * registry could never produce.
 */
function crewIn(fx: Fixture, agents: Record<string, ActiveAgent[]>): void {
  (fx.registry as unknown as { activeAgents: (f: string) => ActiveAgent[] }).activeAgents = (f) =>
    agents[f] ?? [];
}

function rejectingHost(seen: LandingReview[]): LandingGateHost {
  return {
    async openLandingReview(review) {
      seen.push(review);
      return "rejected";
    },
  };
}

test("feature_land runs prepare, opens the gate, and merges on [m]; the record is dropped", async () => {
  const seen: LandingReview[] = [];
  const fx = await makeFixture(approvingHost(seen));
  try {
    const created = await fx.features.create("ship-it");
    await commitIn(created.feature.worktreePath, "one.txt", "1\n", "job: slice");

    const res = await fx.features.land("ship-it");
    assert.equal(res.outcome, "merged");
    assert.equal(res.prepared, "green");
    assert.ok(res.merged);
    // The gate saw the real prepare, and it saw the PR it would merge.
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.feature, "ship-it");
    const gated = seen[0]!.prepared;
    assert.equal(gated.kind, "green");
    if (gated.kind === "green") assert.equal(gated.pr?.number, res.merged.pr.number);
    // origin/dev moved to the merge commit; the worktree went, the branch stayed.
    assert.equal(fx.originDev(), res.merged.mergeSha);
    assert.equal(fx.forge.prs[0]!.state, "MERGED");
    assert.ok(!fs.existsSync(created.feature.worktreePath), "the worktree is torn down");
    assert.ok(branchExists(fx.repo, created.feature.branch), "the branch ref is kept after a PR merge");
    assert.equal(fx.registry.getFeature("ship-it"), undefined, "the record is dropped after landing");
  } finally {
    await fx.cleanup();
  }
});

test("feature_land opens the gate but [r] merges nothing and leaves the feature intact", async () => {
  const seen: LandingReview[] = [];
  const fx = await makeFixture(rejectingHost(seen));
  try {
    const created = await fx.features.create("keep-me");
    await commitIn(created.feature.worktreePath, "k.txt", "k\n", "job: k");
    const devBefore = fx.originDev();

    const res = await fx.features.land("keep-me");
    assert.equal(res.outcome, "rejected");
    assert.equal(res.prepared, "green");
    assert.equal(fx.originDev(), devBefore, "rejection merged nothing");
    assert.equal(fx.forge.prs[0]!.state, "OPEN", "the PR stays open for another look");
    assert.ok(branchExists(fx.repo, created.feature.branch));
    assert.ok(fx.registry.getFeature("keep-me"), "a rejected feature stays tracked");
  } finally {
    await fx.cleanup();
  }
});

test("feature_land reports cleanly with no gate (non-interactive session), touching nothing", async () => {
  const fx = await makeFixture(/* no gateHost */);
  try {
    const created = await fx.features.create("headless");
    await commitIn(created.feature.worktreePath, "h.txt", "h\n", "job: h");

    const res = await fx.features.land("headless");
    assert.equal(res.outcome, "rejected");
    assert.match(res.error ?? "", /no landing gate/);
    assert.ok(branchExists(fx.repo, created.feature.branch), "nothing was landed or torn down");
  } finally {
    await fx.cleanup();
  }
});

// --- boot reconcile ----------------------------------------------------------

test("reconcileAtBoot rebuilds a record from an on-disk worktree with an empty registry", async () => {
  const fx = await makeFixture();
  try {
    // Provision a worktree directly (as a prior session would have), bypassing
    // the manager so its registry starts empty — exactly the restart case.
    const rec = await provisionWorktree(fx.opts, "survivor");
    assert.equal(fx.registry.getFeature("survivor"), undefined, "registry is empty before reconcile");

    const report = await fx.features.reconcileAtBoot();
    assert.equal(report.anomalies.length, 0);
    assert.equal(report.records.length, 1);
    assert.equal(report.records[0]!.slug, "survivor");
    // The record is seeded into the registry, keyed by slug.
    const tracked = fx.registry.getFeature("survivor");
    assert.ok(tracked);
    assert.equal(tracked.branch, "feat/survivor");
    assert.equal(tracked.worktreePath, rec.worktreePath);
    assert.equal(tracked.provisionStatus, "ready");
  } finally {
    await fx.cleanup();
  }
});

test("a feature's intent SURVIVES a restart: the record is rebuilt from git, the description from the store", async () => {
  const fx = await makeFixture();
  try {
    await fx.features.create("User Auth", "passkey login for the web app");
    await fx.features.create("checkout", "stripe checkout with saved cards");
    // It is on disk, under the instance's .dispatch/ tier, before anything else
    // happens — not flushed at exit, where a crash would lose it.
    assert.ok(fs.existsSync(fx.paths.featureStore), "the intents are persisted immediately");

    // A restart: a brand-new registry (empty) and a brand-new manager that
    // re-reads the store from disk, over the same worktrees.
    const next = await fx.restart();
    assert.deepEqual(next.list(), [], "the fresh registry knows nothing yet");

    const report = await next.reconcileAtBoot();
    assert.equal(report.records.length, 2, "both worktrees are rebuilt from disk");

    // The rebuilt record is keyed by slug (the human name isn't recoverable from
    // a branch) and carries the description the previous session authored.
    const auth = await next.status("user-auth");
    assert.ok(auth, "addressable by slug after a restart");
    assert.equal(auth.branch, "feat/user-auth");
    assert.equal(auth.intent, "passkey login for the web app", "the intent survived");
    // The original handle still resolves too, through the same slug match.
    assert.equal((await next.status("User Auth"))?.intent, "passkey login for the web app");
    assert.equal((await next.status("checkout"))?.intent, "stripe checkout with saved cards");

    // And it reaches the panel's Home tab, which is the whole point.
    const overview = next.overview();
    assert.deepEqual(
      overview.map((f) => [f.feature, f.intent, f.status, f.branch]),
      [
        ["checkout", "stripe checkout with saved cards", "idle", "feat/checkout"],
        ["user-auth", "passkey login for the web app", "idle", "feat/user-auth"],
      ],
      "every tracked worktree, described, alphabetical while none is queued",
    );
  } finally {
    await fx.cleanup();
  }
});

test("a feature created without an intent survives a restart too, with no description", async () => {
  const fx = await makeFixture();
  try {
    await fx.features.create("nameless");
    const next = await fx.restart();
    await next.reconcileAtBoot();
    const [row] = next.overview();
    assert.ok(row);
    assert.equal(row.feature, "nameless");
    assert.equal(row.intent, undefined, "no intent, and nothing invented to fill the gap");
    assert.equal(row.status, "idle");
  } finally {
    await fx.cleanup();
  }
});

test("a landed feature's intent is dropped from the store, so the slug can be reused clean", async () => {
  const fx = await makeFixture(approvingHost([]));
  try {
    const created = await fx.features.create("shortlived", "the first go at it");
    await commitIn(created.feature.worktreePath, "f.txt", "work\n", "job: the work");
    const res = await fx.features.land("shortlived");
    assert.equal(res.outcome, "merged", res.summary);

    // The record is gone and so is its description — nothing lingers to be
    // attached to a later feature that happens to slug the same way.
    const store = await FeatureStore.load(fx.paths);
    assert.equal(store.intent("shortlived"), undefined);
    assert.equal(store.prMessage("shortlived"), undefined, "its PR message goes with it");

    const next = await fx.restart();
    await next.reconcileAtBoot();
    assert.deepEqual(next.overview(), [], "nothing tracked, nothing described");
  } finally {
    await fx.cleanup();
  }
});

test("a live WRITER blocks landing, enqueuing and abandoning", async () => {
  const seen: LandingReview[] = [];
  const fx = await makeFixture(approvingHost(seen));
  try {
    const created = await fx.features.create("busy-one", "someone is in here");
    await commitIn(created.feature.worktreePath, "f.txt", "work\n", "job: the work");
    crewIn(fx, { "busy-one": [{ jobId: "job-001", lane: "writer", agentName: "cc" }] });

    // The queue will not rebase a checkout out from under a writer: the head is
    // held "queued" rather than processed.
    const enq = await fx.features.enqueue("busy-one");
    assert.equal(enq.enqueued, true);
    assert.equal(enq.head?.status, "queued", "held, not rebased under the writer");
    assert.match(enq.summary, /a crew agent is still working it/);

    // Landing refuses, and names the writer rather than saying "an agent". On a
    // feature of its own, because an enqueued feature is refused earlier for a
    // different reason (it lands as the queue head or not at all).
    const direct = await fx.features.create("busy-two", "someone is in here too");
    await commitIn(direct.feature.worktreePath, "f.txt", "work\n", "job: the work");
    crewIn(fx, {
      "busy-one": [{ jobId: "job-001", lane: "writer", agentName: "cc" }],
      "busy-two": [{ jobId: "job-001", lane: "writer", agentName: "cc" }],
    });
    const landed = await fx.features.land("busy-two");
    assert.equal(landed.outcome, "rejected");
    assert.match(landed.summary, /WRITING crew agent \(job-001 \[cc\]\)/);

    // So does abandoning: tearing the checkout down under a live writer
    // destroys work that has not reached the index yet.
    const dropped = await fx.features.abandon("busy-one");
    assert.equal(dropped.abandoned, false);
    assert.match(dropped.reason ?? "", /WRITING crew agent \(job-001 \[cc\]\)/);
    assert.ok(fs.existsSync(created.feature.worktreePath), "and the worktree is still there");
    assert.deepEqual(seen, [], "the landing gate was never even opened");
  } finally {
    await fx.cleanup();
  }
});

test("a live READER blocks nothing: a feature with only auditors in it lands normally", async () => {
  const seen: LandingReview[] = [];
  const fx = await makeFixture(approvingHost(seen));
  try {
    const created = await fx.features.create("audited", "an auditor is reading it");
    await commitIn(created.feature.worktreePath, "f.txt", "work\n", "job: the work");
    crewIn(fx, { audited: [{ jobId: "job-002", lane: "reader", agentName: "cc" }] });

    // The role is visible, and the two questions are kept apart: something IS
    // running here, and yet nothing is writing.
    const status = await fx.features.status("audited");
    assert.equal(status?.busy, true, "an agent is live, and the panel must not hide it");
    assert.equal(status?.writerActive, false, "but nothing is writing");
    assert.deepEqual(status?.agents, [{ jobId: "job-002", lane: "reader", agentName: "cc" }]);
    // feature_list carries the same roles, for the same reason.
    assert.deepEqual(fx.features.list().find((f) => f.slug === "audited")?.agents, [
      { jobId: "job-002", lane: "reader", agentName: "cc" },
    ]);

    // The reader holds no index and leaves no bytes, so the head processes.
    const enq = await fx.features.enqueue("audited");
    assert.equal(enq.head?.status, "ready", "the head rebased and went green with the reader still live");

    // And it merges, with the reader still in the worktree.
    const merged = await fx.features.mergeReadyHead();
    assert.equal(merged.merged, true, merged.summary);
  } finally {
    await fx.cleanup();
  }
});

test("a reader does not stop feature_land or feature_abandon either", async () => {
  const seen: LandingReview[] = [];
  const fx = await makeFixture(approvingHost(seen));
  try {
    const landing = await fx.features.create("read-while-landing", "audited on the way out");
    await commitIn(landing.feature.worktreePath, "f.txt", "work\n", "job: the work");
    crewIn(fx, {
      "read-while-landing": [{ jobId: "job-003", lane: "reader" }],
      "read-while-dropping": [{ jobId: "job-004", lane: "reader" }],
    });
    const res = await fx.features.land("read-while-landing");
    assert.equal(res.outcome, "merged", res.summary);

    const dropping = await fx.features.create("read-while-dropping", "audited on the way out");
    assert.ok(fs.existsSync(dropping.feature.worktreePath));
    const dropped = await fx.features.abandon("read-while-dropping");
    assert.equal(dropped.abandoned, true, dropped.reason);
  } finally {
    await fx.cleanup();
  }
});

test("the features overview lists queued and unqueued side by side, closest-to-landing first", async () => {
  const fx = await makeFixture();
  try {
    const queued = await fx.features.create("zeta-queued", "goes first because it is queued");
    await commitIn(queued.feature.worktreePath, "z.txt", "z\n", "job: z");
    await fx.features.create("alpha-idle", "still being worked");
    await fx.features.enqueue("zeta-queued");

    const rows = fx.features.overview();
    assert.equal(rows.length, 2, "the unqueued feature is here too — the queue would never show it");
    // Queue order wins over the alphabet: the queued feature leads even though
    // its name sorts last.
    assert.equal(rows[0]!.feature, "zeta-queued");
    assert.equal(rows[0]!.position, 1);
    assert.equal(rows[0]!.status, "ready", "the head processed to green");
    assert.equal(rows[0]!.busy, false);
    assert.equal(rows[1]!.feature, "alpha-idle");
    assert.equal(rows[1]!.status, "idle");
    assert.equal(rows[1]!.position, undefined);
    assert.equal(rows[1]!.intent, "still being worked");
    // Every row names the branch, so the tab can be read without the co.
    assert.deepEqual(rows.map((r) => r.branch), ["feat/zeta-queued", "feat/alpha-idle"]);

    // A blocked/resolving head reports as such, with its kind, so the tab agrees
    // with the queue tab about the same feature.
    const started = fx.features.beginResolveHead();
    assert.equal(started.started, false, "a green head has nothing to resolve");
    assert.equal(fx.features.overview()[0]!.status, "ready", "and nothing changed under it");
  } finally {
    await fx.cleanup();
  }
});

test("the overview's dirty flag is refreshed on demand, and unknown until it is", async () => {
  const fx = await makeFixture();
  try {
    const created = await fx.features.create("wip", "half-finished work");

    // Never guessed: before anyone asks, the row says nothing about the tree
    // rather than claiming it is clean.
    assert.equal(fx.features.overview()[0]!.dirty, undefined, "unknown until asked");

    await fx.features.refreshDirty();
    assert.equal(fx.features.overview()[0]!.dirty, false, "a fresh worktree is clean");

    await fsp.writeFile(path.join(created.feature.worktreePath, "scratch.txt"), "wip\n", "utf8");
    assert.equal(fx.features.overview()[0]!.dirty, false, "the cache is not a live read");
    await fx.features.refreshDirty();
    assert.equal(fx.features.overview()[0]!.dirty, true, "and the refresh sees the change");

    // A feature that goes away takes its cached flag with it.
    await fsp.rm(path.join(created.feature.worktreePath, "scratch.txt"));
    await fx.features.abandon("wip");
    await fx.features.refreshDirty();
    assert.deepEqual(fx.features.overview(), []);
  } finally {
    await fx.cleanup();
  }
});

test("feature status derivation: provisioning wins, then the queue, then a live crew agent", () => {
  // The panel's chip, decided from state the session already holds — no git call
  // and no model call, at paint time or ever.
  const q = (status: QueueEntryView["status"], extra: Partial<QueueEntryView> = {}): QueueEntryView => ({
    feature: "f",
    position: 1,
    isHead: true,
    status,
    ...extra,
  });

  // A half-provisioned worktree wins outright: nothing else about it is worth
  // reading, and a `removed` record must never read as a provision failure.
  assert.equal(featureActivity("provisioning", null, true), "provisioning");
  assert.equal(featureActivity("failed", q("ready"), false), "failed");
  assert.equal(featureActivity("removed", null, false), "removed");

  // Then the queue, even with an agent running: a resolver working a blocked
  // head is `resolving`, which says more than a generic `working` would.
  assert.equal(featureActivity("ready", q("queued"), false), "queued");
  assert.equal(featureActivity("ready", q("head-processing"), false), "processing");
  assert.equal(featureActivity("ready", q("ready"), false), "ready");
  assert.equal(featureActivity("ready", q("blocked", { blockedKind: "conflict" }), false), "blocked");
  assert.equal(featureActivity("ready", q("resolving"), true), "resolving");

  // Outside the queue: an agent in the worktree is `working`, and a feature
  // simply being worked by the captain is `idle`.
  assert.equal(featureActivity("ready", null, true), "working");
  assert.equal(featureActivity("ready", null, false), "idle");
  assert.equal(featureActivity("ready", undefined, false), "idle");
});

test("reconcileFeatures surfaces a branch-without-worktree anomaly for unmerged work, destroying nothing", async () => {
  const fx = await makeFixture();
  try {
    const rec = await provisionWorktree(fx.opts, "orphan");
    await commitIn(rec.worktreePath, "w.txt", "unmerged\n", "job: unmerged work");
    // Remove just the worktree, leaving the branch with unmerged commits.
    run(fx.repo, ["worktree", "remove", "--force", rec.worktreePath]);

    const report = await reconcileFeatures(fx.opts);
    assert.equal(report.records.length, 0);
    assert.equal(report.anomalies.length, 1);
    assert.equal(report.anomalies[0]!.kind, "branch-without-worktree");
    assert.match(report.anomalies[0]!.detail, /unmerged work/);
    // The branch is untouched — surfaced, not destroyed.
    assert.ok(branchExists(fx.repo, rec.branch));
  } finally {
    await fx.cleanup();
  }
});

test("reconcileFeatures says NOTHING about a landed branch whose worktree is gone: that is the resting state", async () => {
  const fx = await makeFixture();
  try {
    // A branch contained in origin/dev with no worktree is exactly what every
    // landed feature leaves behind now that refs are kept. Reporting it would
    // mean flagging the whole history on every boot.
    const rec = await provisionWorktree(fx.opts, "halfway");
    run(fx.repo, ["worktree", "remove", "--force", rec.worktreePath]);

    const report = await reconcileFeatures(fx.opts);
    assert.equal(report.records.length, 0);
    assert.deepEqual(report.anomalies, [], "a landed, kept branch is not an anomaly");
    assert.equal(featureBranch("halfway"), rec.branch);
    assert.ok(branchExists(fx.repo, rec.branch), "and it is certainly not destroyed");
  } finally {
    await fx.cleanup();
  }
});

test("reconcileFeatures flags a stray directory under the base and leaves it in place", async () => {
  const fx = await makeFixture();
  try {
    // A directory in the worktree base that git does not track as a worktree.
    await fsp.mkdir(fx.base, { recursive: true });
    const stray = path.join(fx.base, "not-a-worktree");
    await fsp.mkdir(stray);
    await fsp.writeFile(path.join(stray, "junk.txt"), "junk\n", "utf8");

    const report = await reconcileFeatures(fx.opts);
    const strayAnomaly = report.anomalies.find((a) => a.kind === "stray-directory");
    assert.ok(strayAnomaly, "the stray dir is surfaced");
    assert.equal(strayAnomaly.ref, stray);
    assert.ok(fs.existsSync(stray), "the stray dir is left untouched");
  } finally {
    await fx.cleanup();
  }
});

test("reconcileFeatures rebuilds a record AND surfaces an anomaly side by side", async () => {
  const fx = await makeFixture();
  try {
    const live = await provisionWorktree(fx.opts, "alive");
    const gone = await provisionWorktree(fx.opts, "gone");
    await commitIn(gone.worktreePath, "g.txt", "x\n", "job: work");
    run(fx.repo, ["worktree", "remove", "--force", gone.worktreePath]);

    const report = await reconcileFeatures(fx.opts);
    assert.deepEqual(
      report.records.map((r) => r.slug),
      ["alive"],
      "the live worktree rebuilds a record",
    );
    assert.equal(report.anomalies.length, 1);
    assert.equal(report.anomalies[0]!.kind, "branch-without-worktree");
    assert.ok(fs.existsSync(live.worktreePath));
  } finally {
    await fx.cleanup();
  }
});

// --- serial merge queue (end to end, real git + scripted gate) ---------------

test("merge queue: enqueue two, head processes to ready, the panel's [m] merges its PR and the second advances onto the NEW origin/dev", async () => {
  // A gate host is wired but must never be touched: since D-20260724-12 a queue
  // head merges through the PANEL, not through the feature_land review gate.
  const seen: LandingReview[] = [];
  const fx = await makeFixture(approvingHost(seen));
  try {
    const a = await fx.features.create("alpha");
    const b = await fx.features.create("beta");
    await commitIn(a.feature.worktreePath, "a.txt", "a\n", "job: alpha");
    await commitIn(b.feature.worktreePath, "b.txt", "b\n", "job: beta");
    const devStart = fx.originDev();

    // Enqueue alpha: it becomes head and is processed (rebase + PR + checks) to ready.
    const eA = await fx.features.enqueue("alpha");
    assert.equal(eA.enqueued, true);
    if (!eA.enqueued) return;
    assert.equal(eA.head?.feature, "alpha");
    assert.equal(eA.head?.status, "ready");
    assert.equal(eA.head?.commitsReady, 1);

    // Enqueue beta: alpha stays the ready head; beta waits queued, UNprocessed.
    const eB = await fx.features.enqueue("beta");
    if (!eB.enqueued) return;
    assert.equal(eB.head?.feature, "alpha");
    assert.equal(eB.entry.position, 2);
    assert.equal(eB.entry.status, "queued");
    assert.equal(fx.originDev(), devStart, "dev has not moved yet");

    // The captain presses [m] on the ready head in the panel.
    const m1 = await fx.features.mergeReadyHead();
    assert.equal(m1.merged, true);
    assert.equal(m1.feature, "alpha");
    const devAfterA = fx.originDev();
    assert.equal(devAfterA, m1.mergeSha);
    assert.notEqual(devAfterA, devStart, "origin/dev advanced to alpha's merge");
    assert.equal(m1.pr?.number, 1, "the merge went through alpha's PR");
    assert.ok(!fs.existsSync(a.feature.worktreePath), "alpha's worktree is torn down");
    assert.ok(branchExists(fx.repo, "feat/alpha"), "alpha's branch ref is kept");
    assert.equal(fx.registry.getFeature("alpha"), undefined, "alpha's record dropped");

    // The queue advanced: beta is now head and was processed AGAINST the new dev.
    assert.equal(m1.head?.feature, "beta");
    assert.equal(m1.head?.status, "ready");

    // Merge beta: it lands on top of alpha's dev, and the queue empties.
    const m2 = await fx.features.mergeReadyHead();
    assert.equal(m2.merged, true);
    assert.equal(m2.feature, "beta");
    assert.equal(m2.head, null, "the queue is now empty");
    assert.equal(fx.features.queueView().size, 0);
    const devAfterB = fx.originDev();
    assert.equal(devAfterB, m2.mergeSha);
    assert.equal(run(fx.repo, ["rev-parse", `${devAfterB}^1`]), devAfterA, "beta merged on top of alpha's dev");
    // Both features' work is on origin/dev, as two serial merge commits.
    assert.equal(run(fx.repo, ["show", `${devAfterB}:a.txt`]), "a");
    assert.equal(run(fx.repo, ["show", `${devAfterB}:b.txt`]), "b");
    assert.equal(run(fx.repo, ["rev-list", "--merges", "--count", devAfterB]), "2");
    assert.equal(fx.forge.prs.length, 2, "one PR per feature, both merged");
    assert.ok(fx.forge.prs.every((pr) => pr.state === "MERGED"));
    // The captain's checkout never moved, and no gh call ever deleted a branch.
    assert.equal(run(fx.repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "dev");
    assert.equal(run(fx.repo, ["rev-parse", "dev"]), devStart, "the LOCAL dev ref is never written");
    assert.ok(!fx.forge.calls.some((c) => /--delete-branch|--squash|--rebase/.test(c)));
    assert.equal(seen.length, 0, "no review gate was ever opened: the merge is panel-native");
  } finally {
    await fx.cleanup();
  }
});

test("a head whose origin/dev moved under it is re-validated, not merged: refuse, re-fetch, re-rebase, re-test", async () => {
  const fx = await makeFixture();
  try {
    const a = await fx.features.create("late");
    await commitIn(a.feature.worktreePath, "a.txt", "a\n", "job: late");
    const enq = await fx.features.enqueue("late");
    assert.equal(enq.enqueued, true);
    if (!enq.enqueued) return;
    assert.equal(enq.head?.status, "ready", "green against the origin/dev it was tested on");
    const testedBase = fx.originDev();

    // Someone else merges something into dev on GitHub while the head sits
    // ready. The green now covers a combined state that was never built.
    const tree = run(fx.repo, ["rev-parse", `${testedBase}^{tree}`]);
    const moved = run(fx.repo, ["commit-tree", "-p", testedBase, "-m", "someone else landed", tree]);
    fx.forge.branches.set("dev", moved);

    const res = await fx.features.mergeReadyHead();
    assert.equal(res.merged, false, "the stale green does not merge");
    assert.equal(res.outcome, "failed");
    assert.match(res.error ?? "", /'origin\/dev' moved since prepare/);
    assert.equal(fx.originDev(), moved, "and nothing was merged into it");
    assert.equal(fx.forge.prs[0]!.state, "OPEN");

    // The refusal re-processed the head against the NEW tip: fetched, rebased
    // and its checks read again, so what the panel offers next is honest.
    assert.equal(res.head?.feature, "late");
    assert.equal(res.head?.status, "ready", "green again, on the moved base this time");
    const detail = fx.features.headDetail();
    assert.equal(detail?.kind, "ready");
    assert.equal(
      run(fx.repo, ["merge-base", moved, "feat/late"]),
      moved,
      "the branch really sits on the moved origin/dev now",
    );

    // Now it merges, on top of what the other landing left.
    const second = await fx.features.mergeReadyHead();
    assert.equal(second.merged, true);
    assert.equal(run(fx.repo, ["rev-parse", `${fx.originDev()}^1`]), moved);
  } finally {
    await fx.cleanup();
  }
});

test("a missing prerequisite blocks the head with the fix, and never crashes the tool call", async () => {
  const fx = await makeFixture();
  try {
    const a = await fx.features.create("needs-gh");
    await commitIn(a.feature.worktreePath, "a.txt", "a\n", "job: a");
    fx.forge.ghInstalled = false;

    // enqueue must not throw: a prerequisite problem is a blocked head carrying
    // the message the captain has to act on.
    const enq = await fx.features.enqueue("needs-gh");
    assert.equal(enq.enqueued, true);
    if (!enq.enqueued) return;
    assert.equal(enq.head?.status, "blocked");
    assert.match(enq.head?.blockedReason ?? "", /GitHub CLI/);
    assert.equal(enq.head?.blockedKind, undefined, "not a conflict or a red suite: no resolver for this");
    assert.equal(fx.features.planResolveHead().ok, false, "and no agent is offered for it");

    // [m] on it does nothing, and nothing was pushed or PR'd.
    const m = await fx.features.mergeReadyHead();
    assert.equal(m.merged, false);
    assert.deepEqual(fx.forge.pushes, []);
    assert.equal(fx.forge.prs.length, 0);

    // Install gh: the same head re-processes to ready with no other change.
    fx.forge.ghInstalled = true;
    const retry = await fx.features.enqueue("needs-gh");
    assert.equal(retry.enqueued, true);
    if (!retry.enqueued) return;
    assert.equal(retry.head?.status, "ready");
    assert.equal(fx.forge.prs.length, 1, "and only now is a PR opened");
  } finally {
    await fx.cleanup();
  }
});

test("enqueue refuses a feature that was never created", async () => {
  const fx = await makeFixture();
  try {
    const res = await fx.features.enqueue("ghost");
    assert.equal(res.enqueued, false);
    if (res.enqueued) return;
    assert.match(res.reason, /no feature 'ghost'/);
  } finally {
    await fx.cleanup();
  }
});

test("feature_merge_head merges NOTHING in a session that has a panel: [m] is the captain's", async () => {
  // The retired blocking path (D-20260724-12). With a panel wired, the co's tool
  // must return at once, merge nothing, and point at the live [m] — never park
  // the agent loop on a keystroke.
  const seen: LandingReview[] = [];
  const fx = await makeFixture(approvingHost(seen));
  try {
    const a = await fx.features.create("panel-owned");
    await commitIn(a.feature.worktreePath, "p.txt", "p\n", "job: p");
    const enq = await fx.features.enqueue("panel-owned");
    assert.equal(enq.enqueued, true);
    if (!enq.enqueued) return;
    assert.equal(enq.head?.status, "ready");
    const devBefore = fx.originDev();

    const res = await fx.features.mergeHead();
    assert.equal(res.merged, false, "the co's tool never merges when a panel exists");
    assert.equal(res.outcome, "panel");
    assert.match(res.summary, /\[m\]/, "it points the co at the panel affordance");
    assert.equal(fx.originDev(), devBefore, "origin/dev did not move");
    assert.equal(fx.forge.prs[0]!.state, "OPEN", "the PR is still waiting on the keystroke");
    assert.equal(seen.length, 0, "and no gate was opened to wait on");
    assert.equal(fx.features.queueView().head?.status, "ready", "the head is untouched and still ready");

    // The panel path still merges it, as the captain's keystroke would.
    const m = await fx.features.mergeReadyHead();
    assert.equal(m.merged, true);
    assert.notEqual(fx.originDev(), devBefore);
  } finally {
    await fx.cleanup();
  }
});

test("feature_merge_head IS the merge in a session with no panel (the non-interactive fallback)", async () => {
  // No gateHost: a piped/non-TTY session, where there is no [m] to press at all.
  const fx = await makeFixture();
  try {
    const a = await fx.features.create("headless");
    await commitIn(a.feature.worktreePath, "h.txt", "h\n", "job: h");
    await fx.features.enqueue("headless");
    const devBefore = fx.originDev();

    const res = await fx.features.mergeHead();
    assert.equal(res.merged, true, "with no panel the fallback merges directly");
    assert.equal(res.outcome, "merged");
    assert.equal(fx.originDev(), res.mergeSha);
    assert.notEqual(fx.originDev(), devBefore);
    assert.equal(fx.forge.prs[0]!.state, "MERGED", "through the PR, like every other merge");
    assert.ok(!fs.existsSync(a.feature.worktreePath), "teardown followed the merge");
    assert.ok(branchExists(fx.repo, "feat/headless"), "and kept the branch ref");
  } finally {
    await fx.cleanup();
  }
});

test("headDetail feeds the panel the ready head's PR, commits and checks evidence", async () => {
  const fx = await makeFixture();
  try {
    const a = await fx.features.create("detailed");
    await commitIn(a.feature.worktreePath, "d.txt", "detail\n", "job: detail");
    await fx.features.enqueue("detailed");

    const ready = fx.features.headDetail();
    assert.equal(ready?.kind, "ready");
    if (ready?.kind !== "ready") return;
    assert.equal(ready.feature, "detailed");
    assert.equal(ready.target, "dev");
    assert.equal(ready.commits.length, 1);
    assert.match(ready.commits[0] ?? "", /job: detail/);
    assert.equal(ready.pr?.number, 1, "the PR the [m] would merge");
    assert.match(ready.pr?.url ?? "", /\/pull\/1$/);
    assert.match(ready.pr?.body ?? "", /### Checks/, "with the evidence co composed");
    assert.match(ready.pr?.body ?? "", /job: detail/, "and the commit list");
    // The message the panel paints, straight off the PR: the title composed for
    // it, and the description with co's fenced evidence split away (the panel
    // draws checks and commits from the structured fields beside it). Composed
    // in exactly one place — landing.ts — and read back here, never re-derived.
    const composed = composePrMessage({
      feature: "detailed",
      commits: ready.commits,
      branch: "feat/detailed",
    });
    assert.equal(ready.pr?.title, composed.title, "the title IS the composed title");
    assert.equal(ready.pr?.prose, composed.body.trim(), "and the prose IS the composed body");
    assert.doesNotMatch(ready.pr?.prose ?? "", /co:evidence|### Checks|### Commits/,
      "with nothing of the evidence block left in it to paint");
    assert.equal(ready.checks?.verdict, "passed", "the checks that passed are stated");
    assert.deepEqual(ready.checks?.runs.map((r) => r.name), ["ci"], "and named");
    assert.equal(ready.checks?.ungated, false);
  } finally {
    await fx.cleanup();
  }
});

test("feature_enqueue writes the pull request: the co's own title and body, with the fence on top", async () => {
  const fx = await makeFixture();
  try {
    const a = await fx.features.create("passkeys", "passkey login for the web app");
    await commitIn(a.feature.worktreePath, "auth.ts", "login\n", "job: passkey ceremony");

    const title = "Add passkey login to the web app";
    const body = "Passwords were the last thing keeping the support queue busy, so login goes through a passkey now.";
    const enq = await fx.features.enqueue("passkeys", { prTitle: title, prBody: body });
    assert.equal(enq.enqueued, true);
    if (!enq.enqueued) return;
    assert.equal(enq.head?.status, "ready");
    assert.deepEqual(enq.prMessage, { title: "authored", body: "authored" }, "the co wrote both halves");

    // The pull request carries them verbatim; co's block is the only thing added.
    const pr = fx.forge.prFor("feat/passkeys")!;
    assert.equal(pr.title, title);
    const parts = splitEvidence(pr.body);
    assert.equal(parts.prose, body);
    assert.match(parts.evidence, /### Checks/, "the evidence still regenerates");
    assert.match(parts.evidence, /job: passkey ceremony/, "with the commit list inside the fence");
    assert.doesNotMatch(parts.prose, /### Checks|### Commits|<!--/, "and none of it in the prose");

    // The mechanical composition is NOT what the captain reads, which is the point.
    const detail = fx.features.headDetail();
    assert.equal(detail?.kind, "ready");
    if (detail?.kind !== "ready") return;
    const mechanical = composePrMessage({ feature: "passkeys", commits: detail.commits, branch: "feat/passkeys" });
    assert.notEqual(pr.title, mechanical.title);
    assert.equal(detail.pr?.title, title, "and the panel paints the message off the PR");
    assert.equal(detail.pr?.prose, body);

    // Persisted the moment it is given, keyed by slug, under .dispatch/.
    const store = await FeatureStore.load(fx.paths);
    assert.deepEqual(store.prMessage("passkeys"), { prTitle: title, prBody: body });
    assert.equal(store.intent("passkeys"), "passkey login for the web app", "beside the intent, not instead of it");
  } finally {
    await fx.cleanup();
  }
});

test("with no message given, the pull request falls back to the mechanical composition", async () => {
  const fx = await makeFixture();
  try {
    const a = await fx.features.create("plain");
    await commitIn(a.feature.worktreePath, "p.txt", "p\n", "job: the plain slice");
    await commitIn(a.feature.worktreePath, "q.txt", "q\n", "job: the other slice");

    const enq = await fx.features.enqueue("plain");
    assert.equal(enq.enqueued, true);
    if (!enq.enqueued) return;
    assert.deepEqual(enq.prMessage, { title: "mechanical", body: "mechanical" });

    const detail = fx.features.headDetail();
    assert.equal(detail?.kind, "ready");
    if (detail?.kind !== "ready") return;
    const expected = composePrMessage({ feature: "plain", commits: detail.commits, branch: "feat/plain" });
    const pr = fx.forge.prFor("feat/plain")!;
    assert.equal(pr.title, expected.title, "the old rules still apply when nothing was authored");
    assert.equal(splitEvidence(pr.body).prose, expected.body.trim());

    // Nothing is stored for a feature whose message was never authored.
    assert.equal((await FeatureStore.load(fx.paths)).prMessage("plain"), undefined);
  } finally {
    await fx.cleanup();
  }
});

test("a re-enqueue with no message reuses the one co wrote — across a restart and a resolver run", async () => {
  const fx = await makeFixture();
  try {
    const base = await fx.features.create("base");
    const follow = await fx.features.create("recovery");
    await commitIn(base.feature.worktreePath, "file.txt", "from base\n", "job: base");
    await commitIn(follow.feature.worktreePath, "file.txt", "from recovery\n", "job: recovery codes");

    // Land base so dev holds the conflicting change.
    await fx.features.enqueue("base");
    assert.equal((await fx.features.mergeReadyHead()).merged, true);

    // The co authors the message on the enqueue that BLOCKS: the rebase
    // conflicts, so no PR is opened at all. The message has to survive to
    // whenever the PR is finally opened, or the authored text is lost for good.
    const title = "Add recovery codes to the login flow";
    const body = "A lost device must not be a lost account, so enrolment now hands out one-time codes.";
    const first = await fx.features.enqueue("recovery", { prTitle: title, prBody: body });
    assert.equal(first.enqueued, true);
    if (!first.enqueued) return;
    assert.equal(first.head?.status, "blocked");
    assert.equal(first.head?.blockedKind, "conflict");
    assert.equal(fx.forge.prFor("feat/recovery"), undefined, "a conflicted head opened no PR");

    // A restart: a brand-new manager, an empty registry and queue, and a store
    // re-read from disk. Everything about the feature comes back from disk here.
    const next = await fx.restart();
    await next.reconcileAtBoot();

    // The resolver's work, in the feature's own worktree: rebase and resolve.
    const wt = follow.feature.worktreePath;
    const reb = spawnSync("git", ["rebase", "origin/dev"], { cwd: wt, encoding: "utf8" });
    assert.notEqual(reb.status, 0, "the rebase really conflicts (as the block reported)");
    await fsp.writeFile(path.join(wt, "file.txt"), "from base\nfrom recovery\n", "utf8");
    run(wt, ["add", "file.txt"]);
    assert.equal(
      spawnSync("git", ["rebase", "--continue"], {
        cwd: wt,
        encoding: "utf8",
        env: { ...process.env, GIT_EDITOR: "true" },
      }).status,
      0,
      "the agent completed the rebase",
    );

    // The retry passes NO message. The PR opens for the first time here, and it
    // opens with what the previous session's co wrote.
    const retry = await next.enqueue("recovery");
    assert.equal(retry.enqueued, true);
    if (!retry.enqueued) return;
    assert.equal(retry.head?.status, "ready");
    assert.deepEqual(retry.prMessage, { title: "authored", body: "authored" }, "not reverted to mechanical");

    const pr = fx.forge.prFor("feat/recovery")!;
    assert.equal(pr.title, title);
    assert.equal(splitEvidence(pr.body).prose, body);
    assert.deepEqual((await FeatureStore.load(fx.paths)).prMessage("recovery"), { prTitle: title, prBody: body });
  } finally {
    await fx.cleanup();
  }
});

test("each half of the PR message overrides on its own; omitting one keeps what is stored", async () => {
  const fx = await makeFixture();
  try {
    const a = await fx.features.create("halves");
    await commitIn(a.feature.worktreePath, "h.txt", "h\n", "job: halves");

    await fx.features.enqueue("halves", { prTitle: "First title", prBody: "First body." });
    // A body-only re-enqueue replaces the body and leaves the title alone; a
    // title-only one does the reverse.
    const second = await fx.features.enqueue("halves", { prBody: "Second body, better argued." });
    assert.equal(second.enqueued, true);
    if (!second.enqueued) return;
    assert.deepEqual(second.prMessage, { title: "authored", body: "authored" });
    assert.deepEqual((await FeatureStore.load(fx.paths)).prMessage("halves"), {
      prTitle: "First title",
      prBody: "Second body, better argued.",
    });

    await fx.features.enqueue("halves", { prTitle: "Second title" });
    assert.deepEqual((await FeatureStore.load(fx.paths)).prMessage("halves"), {
      prTitle: "Second title",
      prBody: "Second body, better argued.",
    });

    // The PR itself was opened by the FIRST enqueue and is a human artifact from
    // then on: co refreshes only its fenced evidence, never the title or the
    // prose the captain may have edited on GitHub.
    const pr = fx.forge.prFor("feat/halves")!;
    assert.equal(pr.title, "First title", "an open PR's title is not rewritten");
    assert.equal(splitEvidence(pr.body).prose, "First body.");
  } finally {
    await fx.cleanup();
  }
});

test("the captain's in-panel edit rewrites the PR and the stored message, and keeps the fence", async () => {
  const fx = await makeFixture();
  try {
    const a = await fx.features.create("checkout", "stripe checkout with saved cards");
    await commitIn(a.feature.worktreePath, "pay.ts", "pay\n", "job: the card form");
    await fx.features.enqueue("checkout", {
      prTitle: "Add saved cards to checkout",
      prBody: "The co's first draft.",
    });
    const before = fx.forge.prFor("feat/checkout")!;
    const evidenceBefore = splitEvidence(before.body).evidence;
    assert.match(evidenceBefore, /### Checks/, "there is a real block to preserve");

    const res = await fx.features.editHeadPrMessage({
      title: "Add saved cards to checkout, and fix the totals",
      body: "The totals drifted whenever a promo applied late.\n\nSaved cards are the visible half.",
    });

    // 1. GitHub holds the new message — and it is what came BACK from the forge.
    const pr = fx.forge.prFor("feat/checkout")!;
    assert.equal(pr.title, "Add saved cards to checkout, and fix the totals");
    const parts = splitEvidence(pr.body);
    assert.equal(
      parts.prose,
      "The totals drifted whenever a promo applied late.\n\nSaved cards are the visible half.",
    );
    assert.equal(res.title, pr.title, "the result is read back off the PR, not echoed from the buffer");
    assert.equal(res.prose, parts.prose);
    assert.equal(res.prNumber, pr.number);

    // 2. The evidence block survived EXACTLY once, unchanged.
    assert.equal(pr.body.match(/<!-- co:evidence -->/g)?.length, 1, "one fence, still");
    assert.equal(pr.body.match(/<!-- \/co:evidence -->/g)?.length, 1);
    assert.equal(parts.evidence, evidenceBefore, "and co's block is byte-for-byte what it was");
    assert.match(parts.evidence, /job: the card form/);

    // 3. The store carries it too, so a later re-processing can't resurrect the
    //    superseded message.
    assert.deepEqual((await FeatureStore.load(fx.paths)).prMessage("checkout"), {
      prTitle: "Add saved cards to checkout, and fix the totals",
      prBody: "The totals drifted whenever a promo applied late.\n\nSaved cards are the visible half.",
    });

    // 4. The panel repaints from it immediately — no re-processing needed.
    const detail = fx.features.headDetail();
    assert.equal(detail?.kind, "ready", "and the head is still exactly as ready as it was");
    assert.equal(detail?.pr?.title, pr.title);
    assert.equal(detail?.pr?.prose, parts.prose);
    assert.equal(fx.features.queueView().head?.status, "ready", "the queue did not move");
    assert.ok(!fx.forge.calls.some((c) => c.includes("pr merge")), "and nothing merged");
  } finally {
    await fx.cleanup();
  }
});

test("an edit that empties the description really empties it, in both places", async () => {
  const fx = await makeFixture();
  try {
    const a = await fx.features.create("terse");
    await commitIn(a.feature.worktreePath, "t.txt", "t\n", "job: terse");
    await fx.features.enqueue("terse", { prTitle: "A title", prBody: "A description to delete." });

    await fx.features.editHeadPrMessage({ title: "A title", body: "   \n\n  " });
    const pr = fx.forge.prFor("feat/terse")!;
    assert.equal(splitEvidence(pr.body).prose, "", "the description is gone from the PR");
    assert.match(splitEvidence(pr.body).evidence, /### Checks/, "the evidence is not");
    assert.equal(
      (await FeatureStore.load(fx.paths)).prMessage("terse")?.prBody,
      undefined,
      "and a deleted description cannot come back from the store",
    );
  } finally {
    await fx.cleanup();
  }
});

test("an edit with an empty title is refused outright — nothing is written anywhere", async () => {
  const fx = await makeFixture();
  try {
    const a = await fx.features.create("titled");
    await commitIn(a.feature.worktreePath, "t.txt", "t\n", "job: titled");
    await fx.features.enqueue("titled", { prTitle: "The only title", prBody: "Body." });
    const before = { ...fx.forge.prFor("feat/titled")! };

    await assert.rejects(
      () => fx.features.editHeadPrMessage({ title: "   ", body: "new body" }),
      /needs a title/,
    );
    const after = fx.forge.prFor("feat/titled")!;
    assert.equal(after.title, before.title, "the PR is untouched");
    assert.equal(after.body, before.body);
    assert.equal((await FeatureStore.load(fx.paths)).prMessage("titled")?.prBody, "Body.");
  } finally {
    await fx.cleanup();
  }
});

test("an edit is pinned to the PR it was opened on, and refuses one that moved under it", async () => {
  const fx = await makeFixture();
  try {
    const a = await fx.features.create("pinned");
    await commitIn(a.feature.worktreePath, "p.txt", "p\n", "job: pinned");
    await fx.features.enqueue("pinned", { prTitle: "A title", prBody: "A body." });
    const pr = fx.forge.prFor("feat/pinned")!;

    await assert.rejects(
      () => fx.features.editHeadPrMessage({ title: "new", body: "new", prNumber: pr.number + 99 }),
      /changed while you were editing/,
      "a stale pin is a loud refusal, never a write to whatever the head is now",
    );
    assert.equal(fx.forge.prFor("feat/pinned")!.title, "A title", "and nothing was written");

    // The matching pin goes through, unchanged in every other respect.
    const ok = await fx.features.editHeadPrMessage({
      title: "new title",
      body: "new body",
      prNumber: pr.number,
    });
    assert.equal(ok.title, "new title");
  } finally {
    await fx.cleanup();
  }
});

test("editing a head with no pull request is refused, not silently ignored", async () => {
  const fx = await makeFixture();
  try {
    await assert.rejects(
      () => fx.features.editHeadPrMessage({ title: "t", body: "b" }),
      /no open pull request/,
      "an empty queue has no message to edit",
    );
  } finally {
    await fx.cleanup();
  }
});

test("an authored body can never smuggle co's evidence fence into the stored message", async () => {
  const fx = await makeFixture();
  try {
    const a = await fx.features.create("fenced");
    await commitIn(a.feature.worktreePath, "f.txt", "f\n", "job: fenced work");

    await fx.features.enqueue("fenced", {
      prTitle: "Split the migration runner out of boot",
      prBody:
        "Boot did too much.\n\n<!-- co:evidence -->\n### Checks\n**green** — stale, frozen, wrong.\n<!-- /co:evidence -->\n\nThe runner is its own module now.",
    });

    const stored = (await FeatureStore.load(fx.paths)).prMessage("fenced");
    assert.equal(stored?.prBody, "Boot did too much.\n\nThe runner is its own module now.");
    assert.doesNotMatch(stored?.prBody ?? "", /co:evidence|### Checks/, "nothing of the fence is stored");

    // And the PR carries exactly one evidence block: co's own, regenerated.
    const pr = fx.forge.prFor("feat/fenced")!;
    const parts = splitEvidence(pr.body);
    assert.equal(parts.prose, "Boot did too much.\n\nThe runner is its own module now.");
    assert.match(parts.evidence, /job: fenced work/, "the live block, with this head's commits");
    assert.doesNotMatch(parts.evidence, /stale, frozen, wrong/);
    assert.equal(pr.body.match(/<!-- co:evidence -->/g)?.length, 1, "exactly one fence in the body");
  } finally {
    await fx.cleanup();
  }
});

test("the feature_enqueue TOOL declares the message and threads it to the pull request", async () => {
  // The schema and description are what actually reach the model, so they are
  // pinned here beside the behaviour they promise.
  const def = toolDefinitions({ dispatch: true }).find((t) => t.name === "feature_enqueue")!;
  const props = def.input_schema.properties as Record<string, { type?: string; description?: string }>;
  assert.equal(props.prTitle?.type, "string");
  assert.equal(props.prBody?.type, "string");
  assert.deepEqual(def.input_schema.required, ["name"], "both halves are optional");
  assert.match(props.prTitle?.description ?? "", /concise imperative line/);
  assert.match(props.prBody?.description ?? "", /what the PR accomplishes and why/);
  assert.match(def.description, /pass `prTitle` and `prBody`/, "the description tells co to write it");
  assert.match(def.description, /keeps the message you already wrote/, "and that omitting preserves it");

  const fx = await makeFixture();
  try {
    const a = await fx.features.create("tooled");
    await commitIn(a.feature.worktreePath, "t.txt", "t\n", "job: tooled");
    const execute = makeExecutor({
      paths: fx.paths,
      research: {} as ResearchConfig,
      effects: newSideEffects(),
      features: fx.features,
    });
    let n = 0;
    const call = (input: Record<string, unknown>) =>
      execute({ type: "tool_use", id: `t${++n}`, name: "feature_enqueue", input });

    const res = await call({
      name: "tooled",
      prTitle: "Let co author the PR message",
      prBody: "The mechanical title only ever knew the commit subject.",
    });
    assert.ok(!res.is_error, String(res.content));
    const out = JSON.parse(String(res.content));
    assert.equal(out.enqueued, true);
    assert.deepEqual(out.prMessage, { title: "authored", body: "authored" });
    const pr = fx.forge.prFor("feat/tooled")!;
    assert.equal(pr.title, "Let co author the PR message");
    assert.equal(splitEvidence(pr.body).prose, "The mechanical title only ever knew the commit subject.");

    // The retry shape — same tool, name only — keeps what was authored.
    const again = JSON.parse(String((await call({ name: "tooled" })).content));
    assert.deepEqual(again.prMessage, { title: "authored", body: "authored" });
    assert.deepEqual((await FeatureStore.load(fx.paths)).prMessage("tooled"), {
      prTitle: "Let co author the PR message",
      prBody: "The mechanical title only ever knew the commit subject.",
    });
  } finally {
    await fx.cleanup();
  }
});

test("feature_land refuses a feature that is in the merge queue (it must land via the head)", async () => {
  const seen: LandingReview[] = [];
  const fx = await makeFixture(approvingHost(seen));
  try {
    const a = await fx.features.create("queued-one");
    await commitIn(a.feature.worktreePath, "q.txt", "q\n", "job: q");
    await fx.features.enqueue("queued-one");

    const res = await fx.features.land("queued-one");
    assert.equal(res.outcome, "rejected");
    assert.match(res.error ?? "", /enqueued/);
    assert.equal(seen.length, 0, "the direct-land gate never opened for a queued feature");
    assert.ok(branchExists(fx.repo, "feat/queued-one"), "nothing was landed");
  } finally {
    await fx.cleanup();
  }
});

test("abandoning the head removes it from the queue and advances to the next", async () => {
  const fx = await makeFixture();
  try {
    const a = await fx.features.create("drop-me");
    const b = await fx.features.create("keep-me");
    await commitIn(a.feature.worktreePath, "a.txt", "a\n", "job: a");
    await commitIn(b.feature.worktreePath, "b.txt", "b\n", "job: b");
    await fx.features.enqueue("drop-me");
    await fx.features.enqueue("keep-me");
    assert.equal(fx.features.queueView().head?.feature, "drop-me");

    const res = await fx.features.abandon("drop-me");
    assert.equal(res.abandoned, true);

    const q = fx.features.queueView();
    assert.equal(q.size, 1);
    assert.equal(q.head?.feature, "keep-me");
    assert.equal(q.head?.status, "ready", "the new head was processed on advance");
  } finally {
    await fx.cleanup();
  }
});

test("a real rebase conflict blocks the head and the panel merge refuses to land it", async () => {
  const seen: LandingReview[] = [];
  const fx = await makeFixture(approvingHost(seen));
  try {
    const a = await fx.features.create("left");
    const b = await fx.features.create("right");
    await commitIn(a.feature.worktreePath, "file.txt", "from left\n", "job: left");
    await commitIn(b.feature.worktreePath, "file.txt", "from right\n", "job: right");

    // Land left first so dev holds the conflicting change.
    await fx.features.enqueue("left");
    assert.equal((await fx.features.mergeReadyHead()).merged, true);

    // Enqueue right: rebasing its file.txt edit onto the left-updated dev conflicts.
    const eb = await fx.features.enqueue("right");
    assert.equal(eb.enqueued, true);
    if (!eb.enqueued) return;
    assert.equal(eb.head?.feature, "right");
    assert.equal(eb.head?.status, "blocked");
    assert.match(eb.head?.blockedReason ?? "", /conflict/);

    // The blocked head holds the queue; the merge refuses and writes nothing.
    const devBefore = fx.originDev();
    const mr = await fx.features.mergeReadyHead();
    assert.equal(mr.merged, false);
    assert.equal(mr.outcome, "not-ready");
    assert.equal(fx.originDev(), devBefore, "a blocked head merges nothing");
    assert.equal(fx.forge.prFor("feat/right"), undefined, "a conflicted head never opened a PR");
    assert.ok(branchExists(fx.repo, "feat/right"), "right's branch is intact for a fix");
    // The aborted rebase left right's worktree clean and on its branch.
    assert.equal(run(b.feature.worktreePath, ["status", "--porcelain"]), "");
    assert.equal(run(b.feature.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]), "feat/right");
  } finally {
    await fx.cleanup();
  }
});

test("the resolve path: a conflict-blocked head is fixed by a fresh agent in its worktree, re-processes to ready, then merges", async () => {
  const seen: LandingReview[] = [];
  const fx = await makeFixture(approvingHost(seen));
  try {
    const a = await fx.features.create("base");
    const b = await fx.features.create("follow");
    await commitIn(a.feature.worktreePath, "file.txt", "from base\n", "job: base");
    await commitIn(b.feature.worktreePath, "file.txt", "from follow\n", "job: follow");

    // Land base so dev holds the conflicting change, then enqueue follow (blocks).
    await fx.features.enqueue("base");
    assert.equal((await fx.features.mergeReadyHead()).merged, true);
    const eb = await fx.features.enqueue("follow");
    assert.equal(eb.enqueued, true);
    if (!eb.enqueued) return;
    assert.equal(eb.head?.status, "blocked");
    assert.equal(eb.head?.blockedKind, "conflict", "distinguished as a conflict, not a red build");

    // Plan the resolve: it must target follow's OWN branch, never dev.
    const plan = fx.features.planResolveHead();
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.feature, "follow");
    assert.equal(plan.kind, "conflict");
    assert.equal(plan.attempt, 1);
    assert.match(plan.order, /feat\/follow/, "the order names the feature branch");
    assert.match(
      plan.order,
      /add nothing else: no `Co-Authored-By`/,
      "and forbids an attribution trailer on the resolution commit",
    );
    assert.match(plan.order, /NEVER check out, merge into, or push/i, "the order forbids touching dev");
    assert.match(plan.order, /do not push the branch/i, "the order forbids pushing or PR'ing");
    assert.match(plan.order, /git rebase origin\/dev/, "and names the remote-tracking base");

    // Fire (the confirm-gated dispatch would have launched); mark it resolving.
    const started = fx.features.beginResolveHead();
    assert.equal(started.started, true);
    assert.equal(fx.features.isResolvingHead("follow"), true);
    assert.equal(fx.features.queueView().head?.status, "resolving");

    // Simulate the fresh agent's work IN follow's worktree: rebase onto dev and
    // resolve the conflict (keep both intents), commit — never touching dev.
    const wt = b.feature.worktreePath;
    const devBefore = fx.originDev();
    // A rebase onto origin/dev conflicts; the agent resolves file.txt and continues.
    const reb = spawnSync("git", ["rebase", "origin/dev"], { cwd: wt, encoding: "utf8" });
    assert.notEqual(reb.status, 0, "the rebase really conflicts (as the block reported)");
    await fsp.writeFile(path.join(wt, "file.txt"), "from base\nfrom follow\n", "utf8");
    run(wt, ["add", "file.txt"]);
    const cont = spawnSync("git", ["rebase", "--continue"], {
      cwd: wt,
      encoding: "utf8",
      env: { ...process.env, GIT_EDITOR: "true" },
    });
    assert.equal(cont.status, 0, "the agent completed the rebase");
    assert.equal(run(wt, ["status", "--porcelain"]), "", "the agent left the worktree clean");
    assert.equal(fx.originDev(), devBefore, "the agent never moved dev");
    assert.deepEqual(fx.forge.pushes.filter((p) => p.startsWith("feat/follow")), [],
      "and never pushed its branch: publishing is the queue's job");

    // The agent finished: re-process the head. It rebases cleanly now and the
    // its PR's one check passes, so it goes ready.
    const done = await fx.features.onResolveDone("follow");
    assert.equal(done.head?.feature, "follow");
    assert.equal(done.head?.status, "ready", "the resolved head is ready to merge");

    // And it merges from the panel like any ready head; dev advances.
    const merge = await fx.features.mergeReadyHead();
    assert.equal(merge.merged, true);
    assert.equal(merge.feature, "follow");
    assert.notEqual(fx.originDev(), devBefore, "origin/dev advanced on the merge");
    assert.equal(run(fx.repo, ["show", `${fx.originDev()}:file.txt`]), "from base\nfrom follow");
    assert.ok(!fs.existsSync(wt), "teardown followed the merge");
    assert.ok(branchExists(fx.repo, "feat/follow"), "and kept the branch ref");
  } finally {
    await fx.cleanup();
  }
});

test("planResolveHead refuses when the head is not blocked by a fixable conflict/red", async () => {
  const fx = await makeFixture();
  try {
    // A ready head has nothing for a resolver to do.
    const a = await fx.features.create("ready-feat");
    await commitIn(a.feature.worktreePath, "a.txt", "a\n", "job: a");
    await fx.features.enqueue("ready-feat");
    assert.equal(fx.features.queueView().head?.status, "ready");
    const plan = fx.features.planResolveHead();
    assert.equal(plan.ok, false, "a ready head can't be resolved");

    // An empty queue likewise.
    await fx.features.abandon("ready-feat");
    assert.equal(fx.features.planResolveHead().ok, false);
  } finally {
    await fx.cleanup();
  }
});

test("feature_list and feature_status surface queue position and head state", async () => {
  const fx = await makeFixture();
  try {
    const a = await fx.features.create("head-feat");
    const b = await fx.features.create("tail-feat");
    await commitIn(a.feature.worktreePath, "a.txt", "a\n", "job: a");
    await commitIn(b.feature.worktreePath, "b.txt", "b\n", "job: b");
    await fx.features.enqueue("head-feat");
    await fx.features.enqueue("tail-feat");

    const list = fx.features.list();
    const head = list.find((f) => f.slug === "head-feat")!;
    const tail = list.find((f) => f.slug === "tail-feat")!;
    assert.equal(head.queue?.position, 1);
    assert.equal(head.queue?.isHead, true);
    assert.equal(head.queue?.status, "ready");
    assert.equal(tail.queue?.position, 2);
    assert.equal(tail.queue?.isHead, false);
    assert.equal(tail.queue?.status, "queued");

    const status = await fx.features.status("tail-feat");
    assert.equal(status?.queue?.position, 2);
    assert.equal(status?.queue?.status, "queued");

    // A feature that was never enqueued carries no queue field.
    await fx.features.create("solo-feat");
    const solo = await fx.features.status("solo-feat");
    assert.equal(solo?.queue, undefined);
  } finally {
    await fx.cleanup();
  }
});
