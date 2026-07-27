import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reviewLanding, type LandingGateHost } from "./landinggate.js";
import { executeLanding, prepareLanding, type PrepareGreen } from "./landing.js";
import { provisionWorktree } from "./worktrees.js";
import { Tui, type InStream, type LandingReview, type OutStream } from "../tui/tui.js";
import { stripAnsi } from "../tui/wrap.js";
import { makeFakeForge, type FakeForge } from "./forgefake.test.js";

/**
 * Tests for the landing gate's engine wiring, against real throwaway git repos
 * (same rationale as landing.test.ts: the subject IS what git ends up doing)
 * with the remote surface served by the fake forge — no network, no gh binary.
 * Scripted hosts stand in for the human's keystroke; the last test drives a
 * real Tui with raw bytes so the whole chain [m] -> executeLanding -> a merged
 * PR is proved end to end. The overlay's own state machine (fire-once,
 * disabled [m], error-in-place) is proved frame-by-frame in tui/overlay.test.ts.
 */

function run(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${res.status}): ${res.stderr}`);
  }
  return res.stdout.trim();
}

interface Fixture {
  root: string;
  repo: string;
  base: string;
  forge: FakeForge;
  /** The integration tip as the remote holds it. */
  originDev: () => string;
  /** LandingOptions for this repo, wired to the fake forge. */
  opts: (buildTestCommand?: string) => {
    repoPath: string;
    baseDir: string;
    run: FakeForge["run"];
    buildTestCommand: string;
  };
  cleanup: () => Promise<void>;
}

async function makeRepo(): Promise<Fixture> {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "co-gate-")));
  const repo = path.join(root, "repo");
  const base = path.join(root, "worktrees");
  await fsp.mkdir(repo);
  run(repo, ["init", "-q", "-b", "main"]);
  run(repo, ["config", "user.email", "test@test"]);
  run(repo, ["config", "user.name", "test"]);
  run(repo, ["config", "commit.gpgsign", "false"]);
  await fsp.writeFile(path.join(repo, "file.txt"), "hello\n", "utf8");
  run(repo, ["add", "."]);
  run(repo, ["commit", "-q", "-m", "init"]);
  run(repo, ["branch", "dev", "main"]);
  run(repo, ["checkout", "-q", "dev"]); // the captain's own checkout of dev
  const forge = makeFakeForge(repo, { dev: run(repo, ["rev-parse", "dev"]) });
  return {
    root,
    repo,
    base,
    forge,
    originDev: () => forge.branches.get("dev")!,
    opts: (buildTestCommand = "true") => ({
      repoPath: repo,
      baseDir: base,
      run: forge.run,
      buildTestCommand,
    }),
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

function sha(repo: string, ref: string): string {
  return run(repo, ["rev-parse", ref]);
}

function branchExists(repo: string, branch: string): boolean {
  const res = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: repo,
    encoding: "utf8",
  });
  return res.status === 0;
}

async function commitIn(worktree: string, file: string, content: string, msg: string): Promise<void> {
  await fsp.writeFile(path.join(worktree, file), content, "utf8");
  run(worktree, ["add", file]);
  run(worktree, ["commit", "-qm", msg]);
}

/** A host that behaves like a human pressing [m] over a green, and dismissing
 *  anything else - the same decisions the overlay's key handlers make. */
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

/** A host that behaves like a human pressing [r]: never touches execute. */
function rejectingHost(seen: LandingReview[]): LandingGateHost {
  return {
    async openLandingReview(review) {
      seen.push(review);
      return "rejected";
    },
  };
}

test("an approved green lands the merge pinned to the reviewed sha, then tears down", async () => {
  const f = await makeRepo();
  try {
    const rec = await provisionWorktree({ repoPath: f.repo, baseDir: f.base, run: f.forge.run }, "ship");
    await commitIn(rec.worktreePath, "one.txt", "1\n", "job: first slice");
    await commitIn(rec.worktreePath, "two.txt", "2\n", "job: second slice");
    const mainBefore = sha(f.repo, "main");
    const seen: LandingReview[] = [];

    const res = await reviewLanding(
      approvingHost(seen),
      f.opts(),
      "ship",
    );

    assert.equal(res.outcome, "merged");
    assert.equal(res.prepared.kind, "green");
    if (res.prepared.kind !== "green") return;
    assert.ok(res.landed, "the merge record is returned");
    assert.equal(res.error, undefined);
    // dev really moved to the gate's merge commit, second-parented on the
    // exact sha the review covered.
    assert.equal(f.originDev(), res.landed.mergeSha);
    assert.equal(sha(f.repo, `${res.landed.mergeSha}^2`), res.prepared.featureSha);
    assert.equal(run(f.repo, ["show", `${res.landed.mergeSha}:one.txt`]), "1");
    assert.equal(run(f.repo, ["show", `${res.landed.mergeSha}:two.txt`]), "2");
    assert.equal(res.landed.pr.number, res.prepared.pr?.number, "it merged the PR the gate showed");
    // The review the host saw carried the goods the human judges by.
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.feature, "ship");
    assert.equal(seen[0]!.target, "dev");
    if (seen[0]!.prepared.kind === "green") {
      assert.equal(seen[0]!.prepared.commits.length, 2);
      assert.match(seen[0]!.prepared.diff, /\+1/);
      assert.equal(seen[0]!.prepared.pr?.number, 1, "the gate named the PR it would merge");
    }
    // Teardown ran on the checkout only; the branch ref is kept. main untouched.
    assert.ok(branchExists(f.repo, rec.branch), "the branch ref outlives the merge");
    assert.ok(!fs.existsSync(rec.worktreePath));
    assert.equal(sha(f.repo, "main"), mainBefore);
    assert.equal(sha(f.repo, "dev"), mainBefore, "the LOCAL dev ref is never written");
  } finally {
    await f.cleanup();
  }
});

test("a rejected green merges nothing and leaves branch and worktree intact", async () => {
  const f = await makeRepo();
  try {
    const rec = await provisionWorktree({ repoPath: f.repo, baseDir: f.base, run: f.forge.run }, "keep");
    await commitIn(rec.worktreePath, "k.txt", "k\n", "job: k");
    const devBefore = f.originDev();
    const seen: LandingReview[] = [];

    const res = await reviewLanding(
      rejectingHost(seen),
      f.opts(),
      "keep",
    );

    assert.equal(res.outcome, "rejected");
    assert.equal(res.landed, undefined);
    assert.equal(res.error, undefined);
    assert.equal(f.originDev(), devBefore, "rejection merged nothing");
    assert.ok(branchExists(f.repo, rec.branch), "the branch survives");
    assert.ok(fs.existsSync(rec.worktreePath), "the worktree survives");
  } finally {
    await f.cleanup();
  }
});

test("a conflicting feature reaches the gate as conflict and can only be dismissed", async () => {
  const f = await makeRepo();
  try {
    const a = await provisionWorktree({ repoPath: f.repo, baseDir: f.base, run: f.forge.run }, "left");
    const b = await provisionWorktree({ repoPath: f.repo, baseDir: f.base, run: f.forge.run }, "right");
    await commitIn(a.worktreePath, "file.txt", "from left\n", "job: left edit");
    await commitIn(b.worktreePath, "file.txt", "from right\n", "job: right edit");

    await reviewLanding(
      approvingHost([]),
      f.opts(),
      "left",
    );
    const devAfterLeft = f.originDev();
    const seen: LandingReview[] = [];

    const res = await reviewLanding(
      approvingHost(seen),
      f.opts(),
      "right",
    );

    assert.equal(res.prepared.kind, "conflict");
    assert.equal(res.outcome, "rejected", "a conflict is never mergeable, even by an approver");
    if (seen[0]!.prepared.kind === "conflict") {
      assert.deepEqual(seen[0]!.prepared.conflictFiles, ["file.txt"]);
    }
    assert.equal(f.originDev(), devAfterLeft, "nothing moved");
    assert.ok(branchExists(f.repo, b.branch));
  } finally {
    await f.cleanup();
  }
});

test("a green gone stale under the open gate: execute refuses, outcome is failed, nothing is written", async () => {
  const f = await makeRepo();
  try {
    const a = await provisionWorktree({ repoPath: f.repo, baseDir: f.base, run: f.forge.run }, "first");
    const b = await provisionWorktree({ repoPath: f.repo, baseDir: f.base, run: f.forge.run }, "second");
    await commitIn(a.worktreePath, "a.txt", "a\n", "job: a");
    await commitIn(b.worktreePath, "b.txt", "b\n", "job: b");

    const greenA = await prepareLanding(
      f.opts(),
      "first",
    );
    assert.equal(greenA.kind, "green");

    // While the human is looking at B's green, A lands and moves dev - the
    // A-green + B-green = red hole the pinned execute must refuse.
    const host: LandingGateHost = {
      async openLandingReview(review) {
        await executeLanding(f.opts(), "first", {
          featureSha: (greenA as PrepareGreen).featureSha,
          devSha: (greenA as PrepareGreen).devSha,
        });
        try {
          await review.execute();
          return "merged";
        } catch {
          return "failed";
        }
      },
    };
    const res = await reviewLanding(
      host,
      f.opts(),
      "second",
    );

    assert.equal(res.outcome, "failed");
    assert.equal(res.landed, undefined);
    assert.match(res.error ?? "", /'origin\/dev' moved since prepare/);
    // origin/dev holds only A's landing; B is intact, ready for a fresh prepare.
    assert.equal(run(f.repo, ["rev-list", "--merges", "--count", f.originDev()]), "1");
    assert.ok(branchExists(f.repo, b.branch));
    assert.ok(fs.existsSync(b.worktreePath));
  } finally {
    await f.cleanup();
  }
});

test("a precomputed green is gated as-is, without a second prepare/build+test", async () => {
  const f = await makeRepo();
  try {
    const rec = await provisionWorktree({ repoPath: f.repo, baseDir: f.base, run: f.forge.run }, "prebaked");
    await commitIn(rec.worktreePath, "p.txt", "p\n", "job: p");

    // The merge queue prepares its head (a passing build+test) to decide it's
    // ready, THEN opens the gate with that exact result.
    const green = await prepareLanding(
      f.opts(),
      "prebaked",
    );
    assert.equal(green.kind, "green");
    const seen: LandingReview[] = [];

    // Pass the precomputed green AND a build+test that would fail if it ran. It
    // must not run: the gate shows the handed-in green and [m] merges it.
    const res = await reviewLanding(
      approvingHost(seen),
      f.opts("exit 1"),
      "prebaked",
      green,
    );

    assert.equal(res.outcome, "merged");
    assert.equal(res.prepared, green, "the gate carried the handed-in prepare, unmodified");
    assert.equal(seen[0]!.prepared.kind, "green", "no re-prepare turned it red");
    assert.equal(f.originDev(), res.landed?.mergeSha);
    assert.ok(!fs.existsSync(rec.worktreePath), "teardown followed the merge");
    assert.ok(branchExists(f.repo, rec.branch), "and kept the branch ref");
  } finally {
    await f.cleanup();
  }
});

// --- end to end through a real Tui -------------------------------------------

interface TuiHarness {
  tui: Tui;
  send(bytes: string): void;
  lastFramePlain(): string;
  stop(): void;
}

function tuiHarness(cols = 80, rows = 24): TuiHarness {
  let listener: ((d: string) => void) | null = null;
  const writes: string[] = [];
  const out: OutStream = { write: (s) => writes.push(String(s)), columns: cols, rows };
  const inp: InStream = {
    isTTY: true,
    setRawMode: () => {},
    resume: () => {},
    pause: () => {},
    setEncoding: () => {},
    on: (_e, l) => (listener = l),
    removeListener: () => (listener = null),
  };
  const tui = new Tui({ promptLabel: "you > ", out, inp });
  tui.start();
  return {
    tui,
    send: (bytes) => listener?.(bytes),
    lastFramePlain: () => stripAnsi(writes[writes.length - 1] ?? ""),
    stop: () => tui.stop(),
  };
}

/** Poll until the async prepare inside reviewLanding has opened the gate. */
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("end to end: [r] then [m] on a real Tui drive the real engine", async () => {
  const f = await makeRepo();
  const h = tuiHarness();
  try {
    const rec = await provisionWorktree({ repoPath: f.repo, baseDir: f.base, run: f.forge.run }, "e2e");
    await commitIn(rec.worktreePath, "e.txt", "e2e work\n", "job: e2e work");
    const opts = f.opts();

    // First pass: reject. Registering the review flashes a hint (no auto-pop);
    // Ctrl-O opens the panel onto the review, which shows the real diff; r merges
    // nothing.
    const rejected = reviewLanding(h.tui, opts, "e2e");
    await until(() => h.lastFramePlain().includes("press Ctrl-O"));
    h.send("\x0f");
    await until(() => h.lastFramePlain().includes("review · e2e"));
    assert.match(h.lastFramePlain(), /\+e2e work/, "the panel shows the real diff");
    const devBefore = f.originDev();
    h.send("r");
    assert.equal((await rejected).outcome, "rejected");
    assert.equal(f.originDev(), devBefore);
    assert.equal(f.forge.prs[0]!.state, "OPEN", "the PR is still open after a reject");
    assert.ok(branchExists(f.repo, rec.branch));

    // Second pass: the m keystroke is the merge.
    const approved = reviewLanding(h.tui, opts, "e2e");
    await until(() => h.lastFramePlain().includes("press Ctrl-O"));
    h.send("\x0f");
    await until(() => h.lastFramePlain().includes("review · e2e"));
    h.send("m");
    const res = await approved;
    assert.equal(res.outcome, "merged");
    assert.equal(f.originDev(), res.landed?.mergeSha, "origin/dev sits on the gate's merge");
    assert.match(run(f.repo, ["log", "--format=%s", f.originDev()]), /job: e2e work/);
    assert.equal(f.forge.prs[0]!.state, "MERGED", "through the PR");
    assert.ok(!fs.existsSync(rec.worktreePath), "teardown followed the merge");
    assert.ok(branchExists(f.repo, rec.branch), "and kept the branch ref");
    assert.match(h.lastFramePlain(), /merged PR #1/, "the confirmation flashed");
  } finally {
    h.stop();
    await f.cleanup();
  }
});
