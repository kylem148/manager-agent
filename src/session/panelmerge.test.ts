import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { instancePaths } from "../paths.js";
import { defaultDispatchConfig } from "./dispatchconfig.js";
import { DispatchRegistry } from "./registry.js";
import { FeatureManager } from "./features.js";
import { queueMergeNotice } from "./session.js";
import { defaultWorktreeBase } from "./worktrees.js";
import { Tui, type InStream, type OutStream, type QueuePanelSource } from "../tui/tui.js";
import { stripAnsi } from "../tui/wrap.js";
import { makeFakeForge, type FakeForge } from "./forgefake.test.js";
import type { ChecksPolicy } from "./checks.js";

/** No wall-clock in a unit test: the checks poll sleeps instantly and neither
 *  deadline buys a second look. With no checks seeded on the fake forge, every
 *  head here comes back green-but-UNGATED, which is exactly what a repo with no
 *  CI looks like. */
const FAST_CHECKS: ChecksPolicy = { timeoutMs: 0, graceMs: 0, intervalMs: 1, sleep: async () => {} };

/**
 * END-TO-END for the panel-native merge (D-20260724-12): a REAL Tui wired to a
 * REAL FeatureManager over a REAL throwaway git repo, driven by the literal byte
 * an `m` keypress puts on stdin.
 *
 * The other suites each prove one layer with the next one faked — the queue's
 * state machine against a scripted executeLanding (mergequeue.test.ts), the
 * panel's rendering and keys against a scripted merge callback
 * (tui/overlay.test.ts), the levers against real git (features.test.ts). This
 * one deliberately fakes NOTHING in between: the keystroke goes in one end and
 * `dev` moves at the other, through exactly the wiring session.ts builds. It is
 * the closest thing to the captain pressing the key that can run without a
 * terminal; only the physical keyboard and the terminal's own repaint are out of
 * reach here.
 *
 * What it pins: the [m] merges the head's PULL REQUEST and nothing else does;
 * the worktree is torn down while the branch ref is kept; the queue advances and
 * the NEXT head auto-processes against the new `origin/dev` so its own [m] is
 * live; a blocked head offers no [m] and produces the notice that reaches the
 * co; and the LOCAL `dev` ref — checked out in the primary tree here, as it is
 * in the captain's real repo — is never written by any of it.
 *
 * The forge is the in-memory fake (forgefake.test.ts): the merge commits are
 * real git objects, but nothing leaves the machine.
 */

process.setMaxListeners(0);

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

/** Let queued microtasks (and the panel's merge continuation) run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

/**
 * Wait for a condition, polling. The [m] path is REAL git — a rebase, a
 * checks read, a merge, then the next head's whole prepare — so it settles on
 * git's schedule, not on a fixed sleep. Polling for the outcome is both honest
 * (it waits for the actual thing) and fast (it returns the moment it happens).
 */
async function waitFor(what: string, cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await settle();
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
}

interface Fixture {
  repo: string;
  forge: FakeForge;
  /** The integration tip as the remote holds it — the only dev that moves. */
  originDev: () => string;
  features: FeatureManager;
  tui: Tui;
  /** Push raw bytes at the Tui exactly as a terminal would. */
  send(bytes: string): void;
  frame(): string;
  /** Notices the wiring decided the co is owed — session.ts's queueNotices. */
  notices: string[];
  /** Whether the input loop was woken (session.ts's io.wake). */
  wakes: number;
  cleanup(): Promise<void>;
}

/**
 * Build the real chain. The queue panel source is the SAME shape session.ts
 * installs — view + headDetail + a merge that calls mergeReadyHead and then asks
 * queueMergeNotice what the co is owed — so this exercises that wiring rather
 * than a test-local imitation of it.
 */
async function makeFixture(): Promise<Fixture> {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "co-panel-")));
  const repo = path.join(root, "repo");
  await fsp.mkdir(repo);
  run(repo, ["init", "-q", "-b", "main"]);
  run(repo, ["config", "user.email", "test@test"]);
  run(repo, ["config", "user.name", "test"]);
  run(repo, ["config", "commit.gpgsign", "false"]);
  await fsp.writeFile(path.join(repo, "file.txt"), "base\n", "utf8");
  run(repo, ["add", "."]);
  run(repo, ["commit", "-q", "-m", "init"]);
  // The captain's checkout: dev exists locally and IS checked out here — the
  // state that made a local merge impossible and a PR merge irrelevant to.
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
  const registry = new DispatchRegistry({
    paths,
    config,
    onComplete: () => {},
    ghosttyAvailable: false,
    pollIntervalMs: 10_000,
    installHook: async () => ({ configDir: "/fake", changed: true }),
  });

  const notices: string[] = [];
  const state = { wakes: 0 };

  // The Tui must exist before the FeatureManager (it is the gate host) and the
  // FeatureManager before the queue source reads it — the same ordering dance
  // session.ts does, resolved the same way: with a closure.
  let features: FeatureManager | null = null;
  const queue: QueuePanelSource = {
    view: () => features?.queueView() ?? { size: 0, head: null, entries: [] },
    headDetail: () => features?.headDetail() ?? null,
    merge: async () => {
      const res = await features!.mergeReadyHead();
      const notice = queueMergeNotice(res);
      if (notice) {
        notices.push(notice);
        state.wakes++;
      }
      return { merged: res.merged, summary: res.summary, ...(res.error ? { error: res.error } : {}) };
    },
  };

  const writes: string[] = [];
  let listener: ((d: string) => void) | null = null;
  const out: OutStream = { write: (s) => writes.push(String(s)), columns: 80, rows: 30 };
  const inp: InStream = {
    isTTY: true,
    setRawMode: () => {},
    resume: () => {},
    pause: () => {},
    setEncoding: () => {},
    on: (_e, l) => (listener = l),
    removeListener: () => (listener = null),
  };
  const tui = new Tui({ promptLabel: "you > ", out, inp, queue });
  tui.start();

  features = new FeatureManager({
    registry,
    repoPath: repo,
    run: forge.run,
    gateHost: tui,
    checks: FAST_CHECKS,
  });

  return {
    repo,
    forge,
    originDev: () => forge.branches.get("dev")!,
    features,
    tui,
    send: (bytes) => listener?.(bytes),
    frame: () => stripAnsi(writes[writes.length - 1] ?? ""),
    notices,
    get wakes() {
      return state.wakes;
    },
    cleanup: async () => {
      tui.stop();
      registry.stop();
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

const CTRL_O = "\x0f";

test("e2e: the panel's [m] merges the head's PR, advances the queue, and the next head's [m] goes live", async () => {
  const fx = await makeFixture();
  try {
    const a = await fx.features.create("alpha");
    const b = await fx.features.create("beta");
    await commitIn(a.feature.worktreePath, "a.txt", "a\n", "job: alpha slice");
    await commitIn(b.feature.worktreePath, "b.txt", "b\n", "job: beta slice");
    const devStart = fx.originDev();
    const localDevStart = run(fx.repo, ["rev-parse", "dev"]);
    const mainStart = run(fx.repo, ["rev-parse", "main"]);

    // Enqueue both. The head figures itself out; nothing asks the captain for
    // anything and no tool opens a gate.
    await fx.features.enqueue("alpha");
    await fx.features.enqueue("beta");
    fx.tui.question();

    // Open the panel: the ready head shows its own evidence and offers [m].
    fx.send(CTRL_O);
    await settle();
    let frame = fx.frame();
    assert.match(frame, /alpha\s+\[ready\]/, "the head is ready in the panel");
    assert.match(frame, /2\.\s*beta\s+\[queued\]/, "beta waits behind it, unprocessed");
    assert.match(frame, /press m to merge PR #1 into dev/, "the [m] is simply present");
    assert.match(frame, /PR #1 → dev · 1 commit/, "with what it would merge");
    assert.match(frame, /checks green · 1 check passed/, "and what its CI checks said");
    assert.match(frame, /job: alpha slice/, "the commit it would land");
    assert.match(frame, /pull\/1/, "the PR's URL, to read or edit it on GitHub");
    assert.match(frame, /Merged with a merge commit/, "and the PR message co composed");
    assert.equal(fx.originDev(), devStart, "showing it merged nothing");

    // THE KEYSTROKE. One byte, no tool call, nothing awaited by the co.
    fx.send("m");
    // Wait on the PANEL, not on the engine: the repaint that shows the advanced
    // queue is the last link in the chain and the thing the captain sees.
    await waitFor(
      "the merge to land and the panel to repaint on the advanced queue",
      () => !fx.frame().includes("merging") && /beta\s+\[ready\]/.test(fx.frame()),
    );

    const devAfterA = fx.originDev();
    assert.notEqual(devAfterA, devStart, "origin/dev advanced on the keypress alone");
    assert.equal(run(fx.repo, ["show", `${devAfterA}:a.txt`]), "a", "alpha's work is on dev");
    assert.equal(run(fx.repo, ["rev-list", "--merges", "--count", devAfterA]), "1", "as a merge commit");
    assert.equal(fx.forge.prs[0]!.state, "MERGED", "its PR is merged");
    assert.ok(!fs.existsSync(a.feature.worktreePath), "alpha's worktree was torn down");
    assert.ok(branchExists(fx.repo, "feat/alpha"), "and its branch ref kept");

    // The queue advanced AND the new head auto-processed against the new dev, so
    // its own [m] is already live without anything else happening.
    frame = fx.frame();
    assert.match(frame, /beta\s+\[ready\]/, "beta became head and processed itself");
    assert.ok(!frame.includes("alpha"), "alpha is gone from the panel");
    assert.match(frame, /press m to merge PR #2 into dev/, "beta's [m] is live now");
    assert.equal(fx.notices.length, 0, "a clean merge owes the co nothing: it is not in this loop");

    // Land beta the same way; the queue empties.
    fx.send("m");
    await waitFor("the second merge to land", () => /merge queue is empty/.test(fx.frame()));
    const devAfterB = fx.originDev();
    assert.equal(run(fx.repo, ["rev-parse", `${devAfterB}^1`]), devAfterA, "beta merged on top of alpha");
    assert.equal(run(fx.repo, ["show", `${devAfterB}:b.txt`]), "b");
    assert.equal(fx.features.queueView().size, 0, "the queue is empty");
    assert.equal(run(fx.repo, ["rev-list", "--merges", "--count", devAfterB]), "2", "two merge commits");

    // The captain's tree is exactly where they left it, throughout: still on
    // dev, still at the same commit, with main untouched. co wrote no local ref.
    assert.equal(run(fx.repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "dev");
    assert.equal(run(fx.repo, ["rev-parse", "dev"]), localDevStart, "the local dev ref never moved");
    assert.equal(run(fx.repo, ["status", "--porcelain"]), "", "and their working tree is untouched");
    assert.equal(run(fx.repo, ["rev-parse", "main"]), mainStart, "main was never touched");
    // Every merge was a merge commit, and no branch was ever deleted remotely.
    const merges = fx.forge.calls.filter((c) => c.startsWith("gh pr merge"));
    assert.deepEqual(merges, ["gh pr merge 1 --merge", "gh pr merge 2 --merge"]);
    assert.ok(!fx.forge.calls.some((c) => /--squash|--rebase|--delete-branch/.test(c)));
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a blocked head shows the block, offers no [m], and reaches the co", async () => {
  const fx = await makeFixture();
  try {
    const left = await fx.features.create("left");
    const right = await fx.features.create("right");
    // Both edit the same line, so right conflicts once left has landed.
    await commitIn(left.feature.worktreePath, "file.txt", "from left\n", "job: left");
    await commitIn(right.feature.worktreePath, "file.txt", "from right\n", "job: right");

    await fx.features.enqueue("left");
    await fx.features.enqueue("right");
    fx.tui.question();
    fx.send(CTRL_O);
    await settle();
    assert.match(fx.frame(), /left\s+\[ready\]/);

    // Merge left. The advance leaves right BLOCKED by a real rebase conflict.
    fx.send("m");
    await waitFor(
      "the merge to land and the new head to come back blocked",
      () => fx.features.queueView().head?.status === "blocked",
    );

    const frame = fx.frame();
    assert.match(frame, /right\s+\[blocked: conflict\]/, "the new head is blocked");
    assert.match(frame, /BLOCKED \(rebase conflict\)/, "the panel shows the block");
    assert.match(frame, /no \[m\] on this head/, "and offers no merge");
    assert.match(frame, /file\.txt/, "naming the conflicted path");

    // A blocked head is exactly when the co IS engaged — without the captain
    // having to re-explain any of it.
    assert.equal(fx.wakes, 1, "the input loop was woken");
    assert.equal(fx.notices.length, 1);
    const notice = fx.notices[0]!;
    assert.match(notice, /BLOCKED by a rebase conflict/);
    assert.match(notice, /'right'/, "it names the blocked head");
    assert.match(notice, /feature_resolve_head/, "and points at the confirm-gated resolver");
    assert.match(notice, /type `confirm`/, "stating the resolver is still gated");

    // The keystroke does nothing at all on a blocked head.
    const devBefore = fx.originDev();
    fx.send("m");
    await settle();
    assert.equal(fx.originDev(), devBefore, "[m] on a blocked head merges nothing");
    assert.equal(fx.forge.prFor("feat/right"), undefined, "a blocked head never opened a PR");
    assert.ok(branchExists(fx.repo, "feat/right"), "right's branch is intact for a resolver");
    assert.equal(fx.notices.length, 1, "and no second notice was minted");
  } finally {
    await fx.cleanup();
  }
});

test("queueMergeNotice: silence on the happy path, a decision on a blocked head or a refusal", () => {
  const base = { feature: "x", queue: { size: 0, head: null, entries: [] } };

  // Merged, nothing behind it: the co is not told.
  assert.equal(
    queueMergeNotice({ ...base, merged: true, outcome: "merged", summary: "merged x", head: null }),
    null,
  );
  // Merged, next head fine: still silence.
  assert.equal(
    queueMergeNotice({
      ...base,
      merged: true,
      outcome: "merged",
      summary: "merged x",
      head: { feature: "y", position: 1, isHead: true, status: "ready" },
    }),
    null,
  );
  // The co's tool reporting the panel owns it: nothing to say either.
  assert.equal(
    queueMergeNotice({ ...base, merged: false, outcome: "panel", summary: "ready", head: null }),
    null,
  );

  // Merged, next head blocked: the co is engaged, with the resolver offered.
  const blocked = queueMergeNotice({
    ...base,
    merged: true,
    outcome: "merged",
    summary: "merged x",
    head: {
      feature: "y",
      position: 1,
      isHead: true,
      status: "blocked",
      blockedKind: "failed",
      blockedReason: "PR #7: 1 of 2 checks failed: test (ubuntu)",
    },
  });
  assert.match(blocked ?? "", /BLOCKED by a red CI check/);
  assert.match(blocked ?? "", /1 of 2 checks failed: test \(ubuntu\)/);
  assert.match(blocked ?? "", /feature_resolve_head/);

  // A refused merge: also the co's business.
  const refused = queueMergeNotice({
    ...base,
    merged: false,
    outcome: "failed",
    summary: "refused",
    error: "'feat/x' has moved since prepare",
    head: { feature: "x", position: 1, isHead: true, status: "ready" },
  });
  assert.match(refused ?? "", /REFUSED: 'feat\/x' has moved since prepare/);
  assert.match(refused ?? "", /Nothing was written to dev/);
});
