import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { instancePaths } from "../paths.js";
import { defaultWorktreeBase, provisionWorktree } from "./worktrees.js";
import { makeFakeForge } from "./forgefake.test.js";
import {
  defaultDispatchConfig,
  writeDispatchConfig,
  type DispatchConfig,
} from "./dispatchconfig.js";
import { crewPaneTitle } from "./crewpanes.js";
import { setGhosttyAvailableForTest, setOsaRunnerForTest } from "./transport.js";
import { PaneStore, type PaneRecord } from "./panestore.js";
import type { TtyProcess, TtyProbe } from "./paneoccupancy.js";
import { DispatchRegistry, type Job, type RegistryOptions } from "./registry.js";

/**
 * Tests for the job registry + capture watcher. Dispatch is VISIBLE-ONLY: a crew
 * agent runs in a visible Ghostty pane or the dispatch fails cleanly — there is
 * no background/headless path. So every launch here drives the Ghostty transport
 * through a stubbed osascript (setOsaRunnerForTest) that plays the launched
 * script's first act (creating the capture file, the launch probe) so cap /
 * queue / reuse can be exercised without a GUI. Completion is simulated the way a
 * real crew signals it: the completion sentinel is appended to the capture and
 * the per-job launch script is removed (buildJobScript's self-delete on exit).
 *
 * On the pane path the capture file is a launch-probe + sentinel CHANNEL, not a
 * recording of the agent's stdout (the crew runs attached directly to the pane
 * tty). So these tests assert on the sentinel, on job state, on the Stop-hook
 * sidecar, and on the generated job SCRIPT — not on captured agent output. The
 * end-to-end "the script really runs a fake agent and writes the sentinel" proof
 * lives in transport.test.ts.
 *
 * Every registry is created through withRegistry(), which ALWAYS stop()s it in a
 * finally — the poller is intentionally not unref'd (a real session should stay
 * alive while a job runs), so a test that asserted before stopping would leak a
 * live interval and wedge the whole test process. The helper makes that
 * impossible.
 */

async function tmpInstance(): Promise<{ paths: ReturnType<typeof instancePaths>; cleanup: () => Promise<void> }> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "co-registry-"));
  const paths = instancePaths(home, "inst");
  await fsp.mkdir(paths.captures, { recursive: true });
  return { paths, cleanup: () => fsp.rm(home, { recursive: true, force: true }) };
}

/**
 * Run `fn` with a fresh registry, guaranteeing stop() and cleanup afterward.
 *
 * ALWAYS injects a stub `installHook` unless a test supplies its own: the real
 * installer writes the crew Stop hook into the agent's config dir, and these
 * tests use fake agents with no CLAUDE_CONFIG_DIR prefix, which resolve to the
 * developer's actual ~/.claude. Without the stub, running the suite would
 * silently mutate real config. Tests that care about hook install pass an
 * explicit installHook to observe it.
 */
async function withRegistry(
  opts: Omit<RegistryOptions, "paths"> & { paths: ReturnType<typeof instancePaths> },
  fn: (reg: DispatchRegistry) => Promise<void>,
): Promise<void> {
  const reg = new DispatchRegistry({
    installHook: async (agentCommand) => ({ configDir: `/fake/config/${agentCommand}`, changed: true }),
    ...opts,
  });
  try {
    await fn(reg);
  } finally {
    reg.stop();
  }
}

/** Wait for the completion callback to fire for `jobId`. */
function onCompleteOnce(): { promise: Promise<Job>; handler: (j: Job) => void } {
  let resolve!: (j: Job) => void;
  const promise = new Promise<Job>((r) => (resolve = r));
  return { promise, handler: (j) => resolve(j) };
}

/** Like onCompleteOnce but for several sequential completions: take() awaits
 *  the next completed job, buffering any that land before it is called. */
function onCompleteQueue(): { handler: (j: Job) => void; take: () => Promise<Job> } {
  const buffered: Job[] = [];
  const waiters: ((j: Job) => void)[] = [];
  return {
    handler: (j) => {
      const w = waiters.shift();
      if (w) w(j);
      else buffered.push(j);
    },
    take: () => {
      const b = buffered.shift();
      return b ? Promise.resolve(b) : new Promise((r) => waiters.push(r));
    },
  };
}

/**
 * Play the launched job's first act for a stubbed pane launch. The transport
 * probes for the capture file the job script creates the moment it starts (that
 * is how a busy pane is detected), so a stub that only returned a pane id would
 * look like a launch that went nowhere and fail with a PaneUnavailableError. The
 * script path rides inside the AppleScript as `/bin/sh '<capture>.sh'`.
 */
async function touchCaptureFromScript(script: string): Promise<void> {
  const m = script.match(/\/bin\/sh '([^']+)\.sh'/);
  if (m) await fsp.writeFile(m[1]!, "", "utf8");
}

/**
 * Install a stubbed Ghostty transport for a test: available, and an osascript
 * runner that plays the launch probe and hands back a pane id (a fresh `pane-N`
 * for a split, the anchor id for a takeover). Returns a teardown to call in the
 * finally.
 */
function stubGhostty(): () => void {
  let split = 0;
  setGhosttyAvailableForTest(true);
  setOsaRunnerForTest(async (s) => {
    // The registry's liveness sweep probes each tracked pane with `exists`
    // before planning. Keep every tracked pane alive by default so placement
    // behaves exactly as before; tests that simulate a closed pane install their
    // own runner (see stubGhosttyWithDeaths).
    if (s.includes("exists (first terminal")) return "true";
    await touchCaptureFromScript(s);
    return s.includes("split ") ? `pane-${++split}` : "anchor-1";
  });
  return () => {
    setGhosttyAvailableForTest(null);
    setOsaRunnerForTest(null);
  };
}

/**
 * A fake pane world, for the reuse path: Ghostty AND the process tables of the
 * panes' ttys, so a test can say "the agent in that pane exited" or "the captain
 * started something in it" and watch where the next dispatch lands.
 *
 * It plays the launch script's two first acts in order — writing the pane
 * identity sidecar (`<capture>.tty`, the tty and the pid that outlives the job)
 * and then creating the capture file, which is the transport's launch probe.
 * That is the only way co ever learns a pane's tty, so a stub that skipped it
 * would make every pane unprovable and every dispatch a split.
 *
 * A pane is BUSY from the moment a job launches into it (an agent is running
 * there) until the test calls agentExits(), exactly like the real thing.
 */
function stubPaneWorld(): {
  ttyProbe: TtyProbe;
  /** Pre-register a pane that already exists and is idle — a pane an earlier co
   *  session created, which this one only knows through the pane store. */
  seed: (paneId: string) => { tty: string; pid: number };
  agentExits: (paneId: string) => void;
  captainRuns: (paneId: string) => void;
  close: (paneId: string) => void;
  launches: () => string[];
  teardown: () => void;
} {
  const panes = new Map<string, { tty: string; pid: number }>();
  const busy = new Set<string>();
  const dead = new Set<string>();
  const launches: string[] = [];
  let splits = 0;
  let nextPid = 90000;
  const ensure = (id: string): { tty: string; pid: number } => {
    let rec = panes.get(id);
    if (!rec) {
      rec = { tty: `ttyfake.${id}`, pid: (nextPid += 2) };
      panes.set(id, rec);
    }
    return rec;
  };

  setGhosttyAvailableForTest(true);
  setOsaRunnerForTest(async (s) => {
    const em = s.match(/exists \(first terminal whose id = "([^"]+)"/);
    if (em) return dead.has(em[1]!) ? "false" : "true";
    const tm = s.match(/first terminal whose id = "([^"]+)"/);
    if (tm && dead.has(tm[1]!)) {
      throw new Error(
        `Ghostty got an error: Can't get terminal 1 whose id = "${tm[1]}". Invalid index. (-1719)`,
      );
    }
    if (s.includes("close ")) return "";
    launches.push(s);
    const paneId = s.includes("split ") ? `pane-${++splits}` : tm![1]!;
    const rec = ensure(paneId);
    busy.add(paneId); // an agent is now running in it
    const m = s.match(/\/bin\/sh '([^']+)\.sh'/);
    if (m) {
      await fsp.writeFile(`${m[1]}.tty`, `tty=${rec.tty}\npid=${rec.pid}\n`, "utf8");
      await fsp.writeFile(m[1]!, "", "utf8");
    }
    return paneId;
  });

  const ttyProbe: TtyProbe = async (tty) => {
    const found = [...panes.entries()].find(([, v]) => v.tty === tty);
    if (!found) return null;
    const [id, rec] = found;
    if (dead.has(id)) return null; // the device went with the pane
    const rows: TtyProcess[] = [
      { pid: rec.pid - 1, ppid: 1, stat: "Ss", name: "login" },
      { pid: rec.pid, ppid: rec.pid - 1, stat: "S", name: "zsh" },
    ];
    if (busy.has(id)) rows.push({ pid: rec.pid + 1, ppid: rec.pid, stat: "S+", name: "node" });
    return rows;
  };

  return {
    ttyProbe,
    seed: (paneId) => ensure(paneId),
    agentExits: (paneId) => busy.delete(paneId),
    captainRuns: (paneId) => busy.add(paneId),
    close: (paneId) => dead.add(paneId),
    launches: () => launches,
    teardown: () => {
      setGhosttyAvailableForTest(null);
      setOsaRunnerForTest(null);
    },
  };
}

/**
 * A Ghostty stub whose `dead` set marks panes the captain has closed since they
 * were created. The liveness probe reports them gone, and any split/takeover/
 * reuse that targets one fails with Ghostty's real -1719 — exactly what a stale
 * terminal id does live. `launches()` returns the placement AppleScripts (split/
 * takeover/reuse), excluding the `exists` liveness probes, so a test can assert
 * which pane a split actually grew from.
 */
function stubGhosttyWithDeaths(): {
  dead: Set<string>;
  launches: () => string[];
  teardown: () => void;
} {
  const dead = new Set<string>();
  const launches: string[] = [];
  let split = 0;
  setGhosttyAvailableForTest(true);
  setOsaRunnerForTest(async (s) => {
    const em = s.match(/exists \(first terminal whose id = "([^"]+)"/);
    if (em) return dead.has(em[1]!) ? "false" : "true";
    // A placement targets a terminal by id; a closed one -1719s, just like live.
    const tm = s.match(/first terminal whose id = "([^"]+)"/);
    if (tm && dead.has(tm[1]!)) {
      throw new Error(
        `Ghostty got an error: Can't get terminal 1 whose id = "${tm[1]}". Invalid index. (-1719)`,
      );
    }
    launches.push(s);
    await touchCaptureFromScript(s);
    if (s.includes("split ")) return `pane-${++split}`;
    return tm ? tm[1]! : "anchor-1";
  });
  return {
    dead,
    launches: () => launches,
    teardown: () => {
      setGhosttyAvailableForTest(null);
      setOsaRunnerForTest(null);
    },
  };
}

/**
 * Simulate a pane job's crew PROCESS finishing exactly as buildJobScript does:
 * append the completion sentinel to the capture AND remove the launch script (the
 * self-delete that signals the process is gone and the pane is reusable). Then
 * run one manual poll so the registry finalizes it. `exitCode` defaults to a
 * clean 0.
 */
async function completeJob(reg: DispatchRegistry, job: Job, exitCode = 0): Promise<void> {
  await fsp.writeFile(job.captureFile, `done\n__CO_DISPATCH_DONE__ ${exitCode}\n`, "utf8");
  await fsp.rm(`${job.captureFile}.sh`, { force: true });
  await (reg as unknown as { tick: () => Promise<void> }).tick();
}

/** The per-dispatch nonce is the last dash-segment of the capture basename
 *  (<captures>/job-NNN-<runTag>-<nonce>.log). Extracted to prove two dispatches
 *  never share a capture key. */
function captureNonce(captureFile: string): string {
  return path.basename(captureFile).replace(/\.log$/, "").split("-").pop()!;
}

test("a pane dispatch runs on the visible Ghostty path and fires a done review on completion", async () => {
  const { paths, cleanup } = await tmpInstance();
  const teardown = stubGhostty();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
    config.agents = [{ name: "fake", command: `sh -c 'echo HELLO'` }];
    config.defaultAgent = "fake";
    const done = onCompleteOnce();
    await withRegistry(
      { paths, config, onComplete: done.handler, skipAnchorCheck: true, pollIntervalMs: 10_000 },
      async (reg) => {
        const job = await reg.dispatch("do it");
        assert.equal(job.transport, "ghostty");
        assert.equal(job.status, "running");
        assert.equal(job.paneId, "anchor-1");

        await completeJob(reg, job, 0);
        const finished = await done.promise;
        assert.equal(finished.status, "done");
        assert.equal(finished.exitCode, 0);
      },
    );
  } finally {
    teardown();
    await cleanup();
  }
});

test("the crew Stop hook is installed once per distinct agent, best-effort", async () => {
  const { paths, cleanup } = await tmpInstance();
  const teardown = stubGhostty();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
    config.agents = [
      { name: "cc", command: `sh -c 'echo A'` },
      { name: "ccw", command: `sh -c 'echo B'` },
    ];
    config.defaultAgent = "cc";
    config.pane = { directionSequence: ["right", "down"], cap: 4 };
    const installed: string[] = [];
    await withRegistry(
      {
        paths,
        config,
        onComplete: () => {},
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
        installHook: async (agentCommand) => {
          installed.push(agentCommand);
          return { configDir: "/fake", changed: true };
        },
      },
      async (reg) => {
        await reg.dispatch("one"); // default cc
        await reg.dispatch("two"); // default cc again → no re-install
        await reg.dispatch("three", "ccw"); // ccw → a second distinct install
        assert.deepEqual(
          installed,
          [`sh -c 'echo A'`, `sh -c 'echo B'`],
          "installed once per distinct resolved command, not once per dispatch",
        );
      },
    );
  } finally {
    teardown();
    await cleanup();
  }
});

test("a hook install failure is surfaced via onHookIssue but never fails the dispatch", async () => {
  const { paths, cleanup } = await tmpInstance();
  const teardown = stubGhostty();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
    config.agents = [{ name: "fake", command: `sh -c 'echo HELLO'` }];
    config.defaultAgent = "fake";
    const issues: string[] = [];
    const done = onCompleteOnce();
    await withRegistry(
      {
        paths,
        config,
        onComplete: done.handler,
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
        onHookIssue: (m) => issues.push(m),
        installHook: async () => ({ configDir: "/fake", changed: false, error: "settings.json is not valid JSON" }),
      },
      async (reg) => {
        const job = await reg.dispatch("do it");
        assert.notEqual(job.status, "failed", "a hook install problem does not fail the dispatch");
        await completeJob(reg, job, 0);
        const finished = await done.promise;
        assert.equal(finished.status, "done", "the run still completes");
        assert.equal(issues.length, 1, "the install issue is reported once");
        assert.match(issues[0]!, /not valid JSON/);
      },
    );
  } finally {
    teardown();
    await cleanup();
  }
});

test("the Stop hook's sidecar is read into the job's transcript path and last message", async () => {
  const { paths, cleanup } = await tmpInstance();
  const teardown = stubGhostty();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
    config.agents = [{ name: "fake", command: `sh -c 'echo done'` }];
    config.defaultAgent = "fake";
    const done = onCompleteOnce();
    await withRegistry(
      { paths, config, onComplete: done.handler, skipAnchorCheck: true, pollIntervalMs: 10_000 },
      async (reg) => {
        const job = await reg.dispatch("do it");
        // Drop the hook's sidecar next to the capture, mirroring crewstophook.ts.
        const stem = path.basename(job.captureFile).replace(/\.log$/, "");
        const sidecar = path.join(paths.captures, `${stem}.stop.json`);
        await fsp.writeFile(
          sidecar,
          JSON.stringify({
            session_id: "sess-1",
            transcript_path: "/home/x/.claude/projects/-repo/sess-1.jsonl",
            last_assistant_message: "Feature done; tests pass.",
            ts: 1,
          }),
        );

        await completeJob(reg, job, 0);
        const finished = await done.promise;
        assert.equal(finished.status, "done");
        assert.equal(finished.transcriptPath, "/home/x/.claude/projects/-repo/sess-1.jsonl");
        assert.equal(finished.lastAssistantMessage, "Feature done; tests pass.");
      },
    );
  } finally {
    teardown();
    await cleanup();
  }
});

test("a nonzero agent exit is reported as a failed job", async () => {
  const { paths, cleanup } = await tmpInstance();
  const teardown = stubGhostty();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
    config.agents = [{ name: "fake", command: `sh -c 'echo nope; exit 7'` }];
    config.defaultAgent = "fake";
    const done = onCompleteOnce();
    await withRegistry(
      { paths, config, onComplete: done.handler, skipAnchorCheck: true, pollIntervalMs: 10_000 },
      async (reg) => {
        const job = await reg.dispatch("x");
        await completeJob(reg, job, 7);
        const finished = await done.promise;
        assert.equal(finished.status, "failed");
        assert.equal(finished.exitCode, 7);
      },
    );
  } finally {
    teardown();
    await cleanup();
  }
});

test("a confirm-time agent override selects that agent's command for the run", async () => {
  const { paths, cleanup } = await tmpInstance();
  const teardown = stubGhostty();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
    // Two agents with distinct commands; default is cc, we override to ccw. On the
    // pane path the chosen command is baked into the generated job script, so we
    // read that to prove the override selected the right command.
    config.agents = [
      { name: "cc", command: `sh -c 'echo RAN-CC'` },
      { name: "ccw", command: `sh -c 'echo RAN-CCW'` },
    ];
    config.defaultAgent = "cc";
    await withRegistry(
      { paths, config, onComplete: () => {}, skipAnchorCheck: true, pollIntervalMs: 10_000 },
      async (reg) => {
        const job = await reg.dispatch("do it", "ccw");
        assert.equal(job.agentName, "ccw", "the override is recorded on the job");
        const script = await fsp.readFile(`${job.captureFile}.sh`, "utf8");
        assert.ok(script.includes("RAN-CCW"), "the overridden agent's command is in the job script");
        assert.ok(!script.includes("RAN-CC'"), "the default agent's command is not");
      },
    );
  } finally {
    teardown();
    await cleanup();
  }
});

test("a hung agent is failed when it exceeds the wall-clock timeout", async () => {
  const { paths, cleanup } = await tmpInstance();
  const teardown = stubGhostty();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
    config.agents = [{ name: "fake", command: `sh -c 'sleep 30'` }];
    config.defaultAgent = "fake";
    config.caps = { timeoutSec: 1 };
    const done = onCompleteOnce();
    await withRegistry(
      { paths, config, onComplete: done.handler, skipAnchorCheck: true, pollIntervalMs: 50 },
      async (reg) => {
        // Launch, then never write a sentinel: the poller times it out after 1s.
        await reg.dispatch("hang");
        const finished = await done.promise;
        assert.equal(finished.status, "failed");
        assert.match(finished.error ?? "", /timed out/);
      },
    );
  } finally {
    teardown();
    await cleanup();
  }
});

test("Ghostty path takes over the anchor then splits the newest pane", async () => {
  const { paths, cleanup } = await tmpInstance();
  const teardown = stubGhostty();
  try {
    const config: DispatchConfig = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };

    await withRegistry(
      {
        paths,
        config,
        onComplete: () => {},
        skipAnchorCheck: true,
        pollIntervalMs: 10_000, // don't let the fake "agent" ever complete here
      },
      async (reg) => {
        const j1 = await reg.dispatch("one");
        assert.equal(j1.transport, "ghostty");
        assert.equal(j1.paneId, "anchor-1");

        const j2 = await reg.dispatch("two");
        assert.equal(j2.paneId, "pane-1", "second job splits into a fresh pane");
      },
    );
  } finally {
    teardown();
    await cleanup();
  }
});

// --- pane reuse: dispatch into an idle pane before splitting a new one -------
//
// The whole point of the reuse slice. Occupancy is the union of co's own lease
// and what is actually running in the pane, and a pane is reused only when BOTH
// say free. These drive the registry end to end against a fake pane world
// (stubPaneWorld) that owns both signals.

/** The reuse tests' shared setup: a linked config with a designated anchor. */
function reuseConfig(root: string): DispatchConfig {
  const config = defaultDispatchConfig();
  config.repoPath = root;
  config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
  return config;
}

/** The crew PROCESS exiting: the sentinel lands, the launch script self-deletes,
 *  and the agent leaves the pane. One poll finalizes and releases. */
async function crewExits(reg: DispatchRegistry, job: Job, world: { agentExits: (id: string) => void }): Promise<void> {
  await fsp.writeFile(job.captureFile, `done\n__CO_DISPATCH_DONE__ 0\n`, "utf8");
  await fsp.rm(`${job.captureFile}.sh`, { force: true });
  if (job.paneId) world.agentExits(job.paneId);
  await (reg as unknown as { tick: () => Promise<void> }).tick();
}

test("an idle pane is reused rather than split: dispatch, /exit the agent, dispatch again", async () => {
  // Acceptance criterion 1, and the bug the slice exists for: panes used to
  // accumulate one per dispatch even when the last one was back at a prompt.
  const { paths, cleanup } = await tmpInstance();
  const world = stubPaneWorld();
  try {
    await withRegistry(
      {
        paths,
        config: reuseConfig(paths.root),
        onComplete: () => {},
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
        ttyProbe: world.ttyProbe,
      },
      async (reg) => {
        const j1 = await reg.dispatch("one");
        assert.equal(j1.paneId, "anchor-1", "the first dispatch takes over the designated anchor");

        await crewExits(reg, j1, world);
        assert.equal(j1.status, "done");

        const j2 = await reg.dispatch("two");
        assert.equal(j2.paneId, "anchor-1", "the second dispatch runs in the SAME pane");
        assert.equal(
          world.launches().filter((s) => s.includes("split ")).length,
          0,
          "nothing was split",
        );
      },
    );
  } finally {
    world.teardown();
    await cleanup();
  }
});

test("a pane whose agent is still live is never reused — co's lease holds it even if the tty looks idle", async () => {
  // Acceptance criterion 2. The Stop hook fires the review on the crew's FIRST
  // finish while the captain keeps talking to that same agent, so co's own
  // "finished" is not evidence the pane is free. Both halves are proven here:
  // the lease alone holds the pane, and releasing it is not enough either — the
  // pane itself must also read idle.
  const { paths, cleanup } = await tmpInstance();
  const world = stubPaneWorld();
  try {
    const completed: string[] = [];
    await withRegistry(
      {
        paths,
        config: reuseConfig(paths.root),
        onComplete: (j) => completed.push(j.id),
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
        ttyProbe: world.ttyProbe,
      },
      async (reg) => {
        const j1 = await reg.dispatch("one"); // anchor-1
        // The Stop hook: sentinel written, launch script still there (the agent
        // is live in the pane), and the captain is still typing at it.
        assert.ok(fs.existsSync(`${j1.captureFile}.sh`), "the launch script exists while the agent is live");
        await fsp.writeFile(j1.captureFile, "done\n__CO_DISPATCH_DONE__ 0\n", "utf8");
        await (reg as unknown as { tick: () => Promise<void> }).tick();
        assert.equal(j1.status, "done", "the review fires on first finish");
        assert.ok(completed.includes("job-001"));

        const j2 = await reg.dispatch("two");
        assert.equal(j2.paneId, "pane-1", "a NEW pane is split; the live session is untouched");

        // Now pretend the pane's tty went quiet but the launch script is still
        // there (co has not released the pane). The lease alone must hold it.
        world.agentExits("anchor-1");
        const j3 = await reg.dispatch("three");
        assert.notEqual(j3.paneId, "anchor-1", "co's own unreleased lease still blocks reuse");

        // Release it properly: the crew process exits, the script self-deletes.
        await crewExits(reg, j1, world);
        const j4 = await reg.dispatch("four");
        assert.equal(j4.paneId, "anchor-1", "once both signals say free, it is reused");
      },
    );
  } finally {
    world.teardown();
    await cleanup();
  }
});

test("a pane running something the captain started is not reused, and is left alone", async () => {
  // Acceptance criterion 3. co released the pane, but the captain is running an
  // unrelated command in it: the process signal alone must keep it out.
  const { paths, cleanup } = await tmpInstance();
  const world = stubPaneWorld();
  try {
    await withRegistry(
      {
        paths,
        config: reuseConfig(paths.root),
        onComplete: () => {},
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
        ttyProbe: world.ttyProbe,
      },
      async (reg) => {
        const j1 = await reg.dispatch("one"); // anchor-1
        await crewExits(reg, j1, world); // co is done with the pane...
        world.captainRuns("anchor-1"); // ...and the captain starts a build in it

        const j2 = await reg.dispatch("two");
        assert.equal(j2.paneId, "pane-1", "a new pane is split instead");
        const pastes = world.launches().filter((s) => s.includes("input text"));
        assert.equal(pastes.length, 1, "only the original takeover ever typed into a pane");
      },
    );
  } finally {
    world.teardown();
    await cleanup();
  }
});

test("with two idle panes, two consecutive dispatches occupy both rather than splitting", async () => {
  // Acceptance criterion 4.
  const { paths, cleanup } = await tmpInstance();
  const world = stubPaneWorld();
  try {
    await withRegistry(
      {
        paths,
        config: reuseConfig(paths.root),
        onComplete: () => {},
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
        ttyProbe: world.ttyProbe,
      },
      async (reg) => {
        const j1 = await reg.dispatch("one"); // anchor-1
        const j2 = await reg.dispatch("two"); // split → pane-1
        await crewExits(reg, j1, world);
        await crewExits(reg, j2, world);

        const j3 = await reg.dispatch("three");
        const j4 = await reg.dispatch("four");
        assert.equal(j3.paneId, "anchor-1", "the oldest free pane goes first");
        assert.equal(j4.paneId, "pane-1", "the second dispatch takes the other free pane");
        assert.equal(
          world.launches().filter((s) => s.includes("split ")).length,
          1,
          "only the original split ever happened",
        );
      },
    );
  } finally {
    world.teardown();
    await cleanup();
  }
});

test("there is no pane cap: with every pane busy, dispatches keep splitting", async () => {
  // Acceptance criterion 5. Every pane is occupied (an agent is live in each), so
  // each dispatch creates another one — at 2 panes and at 8.
  const { paths, cleanup } = await tmpInstance();
  const world = stubPaneWorld();
  try {
    await withRegistry(
      {
        paths,
        config: reuseConfig(paths.root),
        onComplete: () => {},
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
        ttyProbe: world.ttyProbe,
      },
      async (reg) => {
        const panes: string[] = [];
        for (let i = 0; i < 8; i++) {
          const job = await reg.dispatch(`job ${i}`);
          assert.equal(job.status, "running", `dispatch ${i} must not be refused or held`);
          panes.push(job.paneId!);
        }
        assert.equal(new Set(panes).size, 8, "eight dispatches, eight distinct panes");
      },
    );
  } finally {
    world.teardown();
    await cleanup();
  }
});

test("a pane the captain closed is pruned from the pane store and never dispatched into", async () => {
  // Acceptance criterion 6, on the store side (the layout side is covered by the
  // pruning tests further down).
  const { paths, cleanup } = await tmpInstance();
  const world = stubPaneWorld();
  const store = PaneStore.ephemeral();
  try {
    await withRegistry(
      {
        paths,
        config: reuseConfig(paths.root),
        onComplete: () => {},
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
        ttyProbe: world.ttyProbe,
        paneStore: store,
      },
      async (reg) => {
        const j1 = await reg.dispatch("one"); // anchor-1
        const j2 = await reg.dispatch("two"); // split → pane-1
        await crewExits(reg, j1, world);
        await crewExits(reg, j2, world);
        assert.deepEqual(
          store.list().map((r: PaneRecord) => r.id).sort(),
          ["anchor-1", "pane-1"],
          "both panes are on record",
        );

        world.close("pane-1"); // the captain closes it
        const j3 = await reg.dispatch("three");
        assert.equal(j3.paneId, "anchor-1", "the closed pane is not dispatched into");
        assert.deepEqual(
          store.list().map((r: PaneRecord) => r.id),
          ["anchor-1"],
          "and its record is gone rather than lingering into the next session",
        );
      },
    );
  } finally {
    world.teardown();
    await cleanup();
  }
});

test("a stale lease from a killed co session does not block reuse; a live one does", async () => {
  // Acceptance criterion 7. A lease is only believed while the process holding it
  // is alive — otherwise a co that was Ctrl-C'd would poison its panes forever.
  const { paths, cleanup } = await tmpInstance();

  /** A previous session's record for the anchor: identity learned, lease still
   *  held by pid 4242. Whether that pid is alive is the whole question. */
  const seeded = (id: { tty: string; pid: number }): PaneStore =>
    PaneStore.ephemeral([
      {
        id: "anchor-1",
        role: "anchor",
        tty: id.tty,
        shellPid: id.pid,
        usedAt: 1,
        lease: { session: "dead-session", pid: 4242, job: "job-009" },
      },
    ]);

  const world = stubPaneWorld();
  try {
    // The anchor already exists and is idle; this session has never launched
    // into it, so everything it knows comes from the store.
    const anchor = world.seed("anchor-1");
    await withRegistry(
      {
        paths,
        config: reuseConfig(paths.root),
        onComplete: () => {},
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
        ttyProbe: world.ttyProbe,
        paneStore: seeded(anchor),
        pidAlive: () => false, // the owning session is gone
      },
      async (reg) => {
        const j1 = await reg.dispatch("one");
        assert.equal(j1.paneId, "anchor-1", "the stale lease is swept and the idle pane reused");
      },
    );
  } finally {
    world.teardown();
  }

  // Same record, but the owner is still alive: another co session is using it.
  const world2 = stubPaneWorld();
  try {
    const anchor = world2.seed("anchor-1");
    await withRegistry(
      {
        paths,
        config: reuseConfig(paths.root),
        onComplete: () => {},
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
        ttyProbe: world2.ttyProbe,
        paneStore: seeded(anchor),
        pidAlive: () => true,
      },
      async (reg) => {
        const j1 = await reg.dispatch("one");
        assert.equal(j1.paneId, "pane-1", "a live foreign lease means split, not steal");
      },
    );
  } finally {
    world2.teardown();
    await cleanup();
  }
});

test("a pane co has no identity for is never taken over twice — only the first, virgin anchor", async () => {
  // The one unproven placement in the design, bounded: co may take over a freshly
  // designated anchor once (it has no tty for it and `co pane` promises the first
  // dispatch lands there). After that the anchor is judged like anything else,
  // and a launch that reports no tty leaves it unprovable — so the next dispatch
  // splits rather than typing into it again.
  const { paths, cleanup } = await tmpInstance();
  const teardown = stubGhostty(); // this stub writes NO identity sidecar
  try {
    await withRegistry(
      {
        paths,
        config: reuseConfig(paths.root),
        onComplete: () => {},
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
        // Nothing can be read about any pane: every judgement is "unproven".
        ttyProbe: async () => null,
      },
      async (reg) => {
        const j1 = await reg.dispatch("one");
        assert.equal(j1.paneId, "anchor-1", "the virgin anchor is taken over once");
        await fsp.writeFile(j1.captureFile, "done\n__CO_DISPATCH_DONE__ 0\n", "utf8");
        await fsp.rm(`${j1.captureFile}.sh`, { force: true });
        await (reg as unknown as { tick: () => Promise<void> }).tick();

        const j2 = await reg.dispatch("two");
        assert.equal(j2.paneId, "pane-1", "with nothing provable, the next dispatch splits");
      },
    );
  } finally {
    teardown();
    await cleanup();
  }
});

test("without a designated anchor a dispatch fails cleanly and launches nothing", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = null; // never ran `co pane`
    config.agents = [{ name: "fake", command: `sh -c 'echo HELLO'` }];
    config.defaultAgent = "fake";
    setGhosttyAvailableForTest(true);
    // If the transport were ever reached it would blow up the test; a clean
    // no-pane failure must never touch osascript.
    setOsaRunnerForTest(async () => {
      throw new Error("osascript must not be called when no pane is available");
    });
    const done = onCompleteOnce();
    await withRegistry(
      { paths, config, onComplete: done.handler, pollIntervalMs: 10_000 },
      async (reg) => {
        assert.equal(reg.paneReady, false, "no anchor means no pane is ready");
        const job = await reg.dispatch("do it");
        assert.equal(job.status, "failed", "the dispatch fails; there is no background path");
        assert.match(job.error ?? "", /couldn't open a crew pane/);
        assert.match(job.error ?? "", /co pane/, "the message names the fix");
        assert.equal(job.paneId, undefined, "nothing was placed");
        const notified = await done.promise;
        assert.equal(notified.id, job.id, "the failure notifies like any launch failure");

        // Launched NOTHING: no job script and no capture file were written.
        const entries = await fsp.readdir(paths.captures);
        assert.deepEqual(entries, [], `no partial job left behind, saw: ${entries.join(", ")}`);
      },
    );
  } finally {
    setGhosttyAvailableForTest(null);
    setOsaRunnerForTest(null);
    await cleanup();
  }
});

test("when Ghostty is unreachable a dispatch fails cleanly with an actionable message", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") }; // anchor set, but no Ghostty
    config.agents = [{ name: "fake", command: `sh -c 'echo HELLO'` }];
    config.defaultAgent = "fake";
    const done = onCompleteOnce();
    await withRegistry(
      { paths, config, onComplete: done.handler, ghosttyAvailable: false, pollIntervalMs: 10_000 },
      async (reg) => {
        assert.equal(reg.paneReady, false, "no Ghostty means no pane is ready");
        const job = await reg.dispatch("do it");
        assert.equal(job.status, "failed");
        assert.match(job.error ?? "", /couldn't open a crew pane/);
        assert.match(job.error ?? "", /Ghostty isn't reachable/, "the message names why");
        const notified = await done.promise;
        assert.equal(notified.id, job.id);
        const entries = await fsp.readdir(paths.captures);
        assert.deepEqual(entries, [], "nothing launched");
      },
    );
  } finally {
    await cleanup();
  }
});

test("a stale/unresolvable pane id fails the dispatch cleanly, launches nothing, and drops the anchor", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config: DispatchConfig = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "ghostty-uuid", title: crewPaneTitle("inst") };
    config.agents = [{ name: "fake", command: `sh -c 'echo CREW-RAN'` }];
    config.defaultAgent = "fake";
    await writeDispatchConfig(paths, config);

    setGhosttyAvailableForTest(true);
    // Reproduce the live -1719: Ghostty can't resolve the stored terminal id.
    setOsaRunnerForTest(async () => {
      throw new Error('Ghostty got an error: Can\'t get terminal 1 whose id = "ghostty-uuid". (-1719)');
    });

    let anchorLost = 0;
    const done = onCompleteOnce();
    await withRegistry(
      {
        paths,
        config,
        onComplete: done.handler,
        skipAnchorCheck: true, // exercise the LAUNCH-time failure, not the exists probe
        pollIntervalMs: 10_000,
        onAnchorLost: () => anchorLost++,
      },
      async (reg) => {
        const job = await reg.dispatch("do it");
        assert.equal(job.status, "failed", "a stale pane fails the dispatch; there is no background path");
        assert.match(job.error ?? "", /couldn't open a crew pane/);
        assert.equal(anchorLost, 1, "the dead anchor was reported lost");

        const notified = await done.promise;
        assert.equal(notified.id, job.id, "it notifies like any launch failure");

        // The transport removes the job script it wrote when the launch fails, so
        // no partial job is left behind.
        assert.ok(!fs.existsSync(`${job.captureFile}.sh`), "the job script was cleaned up");
        assert.ok(!fs.existsSync(job.captureFile), "no capture file was left behind");

        // paneReady is now false: the anchor was dropped for the session.
        assert.equal(reg.paneReady, false, "the dropped anchor leaves no pane ready");
      },
    );
  } finally {
    setGhosttyAvailableForTest(null);
    setOsaRunnerForTest(null);
    await cleanup();
  }
});

test("each dispatch mints a unique capture key, even for the same order re-run back-to-back", async () => {
  const { paths, cleanup } = await tmpInstance();
  const teardown = stubGhostty();
  try {
    const config: DispatchConfig = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
    config.agents = [{ name: "fake", command: `sh -c 'echo HELLO'` }];
    config.defaultAgent = "fake";
    await withRegistry(
      { paths, config, onComplete: () => {}, skipAnchorCheck: true, pollIntervalMs: 10_000 },
      async (reg) => {
        // The exact same order text, dispatched twice in a row.
        const j1 = await reg.dispatch("do the thing");
        const j2 = await reg.dispatch("do the thing");
        assert.notEqual(j1.id, j2.id, "distinct job ids");
        assert.notEqual(j1.captureFile, j2.captureFile, "distinct capture files");
        assert.notEqual(
          captureNonce(j1.captureFile),
          captureNonce(j2.captureFile),
          "the per-dispatch nonce differs, so no two dispatches share a capture/identity key",
        );
        // The nonce is real randomness (8 hex chars), not the job id or run tag.
        assert.match(captureNonce(j1.captureFile), /^[0-9a-f]{8}$/);
      },
    );
  } finally {
    teardown();
    await cleanup();
  }
});

test("dispatch reads the pane id fresh from config, so `co pane` takes effect with no restart", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config: DispatchConfig = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-old", title: crewPaneTitle("inst") };
    await writeDispatchConfig(paths, config);

    setGhosttyAvailableForTest(true);
    // Echo the targeted id back so we can see which anchor each dispatch used.
    setOsaRunnerForTest(async (s) => {
      await touchCaptureFromScript(s);
      const m = s.match(/first terminal whose id = "([^"]+)"/);
      return m ? m[1]! : "unknown";
    });

    await withRegistry(
      {
        paths,
        config,
        onComplete: () => {},
        skipAnchorCheck: true,
        pollIntervalMs: 10_000, // don't let the fake job complete
      },
      async (reg) => {
        const j1 = await reg.dispatch("one");
        assert.equal(j1.paneId, "anchor-old", "first dispatch targets the originally-linked anchor");

        // Simulate `co pane` in another process re-designating the anchor while
        // this session keeps running: it just rewrites the config on disk.
        const updated = { ...config, anchor: { id: "anchor-new", title: crewPaneTitle("inst") } };
        await writeDispatchConfig(paths, updated);

        // The very next dispatch must pick up the new id WITHOUT a restart.
        const j2 = await reg.dispatch("two");
        assert.equal(j2.paneId, "anchor-new", "the next dispatch uses the freshly-set pane id");
      },
    );
  } finally {
    setGhosttyAvailableForTest(null);
    setOsaRunnerForTest(null);
    await cleanup();
  }
});

test("currentConfig re-reads disk so a mid-session re-link takes effect", async () => {
  // The arming banner reads currentConfig(); before this it read a config
  // snapshotted at session start, so a `co link` that fixed a broken crew
  // command still showed the old one. This proves the disk re-read happens
  // regardless of whether a pane is available.
  const { paths, cleanup } = await tmpInstance();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.agents = [{ name: "cc", command: "ccw {prompt}" }]; // the old, broken word
    config.defaultAgent = "cc";
    await writeDispatchConfig(paths, config);

    await withRegistry(
      { paths, config, onComplete: () => {}, ghosttyAvailable: false, pollIntervalMs: 10_000 },
      async (reg) => {
        // A `co link` in another process rewrites the config with the resolved command.
        const fixed = {
          ...config,
          agents: [{ name: "cc", command: 'CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude {prompt}' }],
        };
        await writeDispatchConfig(paths, fixed);

        const current = await reg.currentConfig();
        assert.equal(
          current.agents[0]!.command,
          'CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude {prompt}',
          "currentConfig reflects the re-link without a session restart",
        );
      },
    );
  } finally {
    await cleanup();
  }
});

test("feature records are additive bookkeeping that never touches the job flow", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    await withRegistry(
      { paths, config, onComplete: () => {}, ghosttyAvailable: false, pollIntervalMs: 10_000 },
      async (reg) => {
        assert.deepEqual(reg.listFeatures(), []);
        const record = {
          feature: "auth",
          slug: "auth",
          branch: "co/feat-auth",
          worktreePath: "/wt/auth",
          provisionStatus: "ready" as const,
        };
        reg.upsertFeature(record);
        assert.equal(reg.getFeature("auth")?.branch, "co/feat-auth");
        reg.upsertFeature({ ...record, provisionStatus: "removed" });
        assert.equal(reg.listFeatures().length, 1, "upsert replaces, never duplicates");
        assert.equal(reg.getFeature("auth")?.provisionStatus, "removed");
        assert.equal(reg.removeFeature("auth"), true);
        assert.equal(reg.removeFeature("auth"), false, "a second remove reports nothing was there");
        // None of it created or altered a job.
        assert.deepEqual(reg.list(), []);
      },
    );
  } finally {
    await cleanup();
  }
});

test("a feature-scoped dispatch provisions once, runs in the worktree, and links jobs to the feature", async () => {
  const { paths, cleanup } = await tmpInstance();
  const teardown = stubGhostty();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
    config.pane = { directionSequence: ["right", "down"], cap: 4 };
    config.agents = [{ name: "fake", command: `sh -c 'pwd'` }];
    config.defaultAgent = "fake";
    const worktree = path.join(paths.root, "wt", "auth");
    await fsp.mkdir(worktree, { recursive: true });
    let provisions = 0;
    const queue = onCompleteQueue();
    await withRegistry(
      {
        paths,
        config,
        onComplete: queue.handler,
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
        provisionWorktree: async (opts, feature) => {
          provisions++;
          assert.equal(opts.repoPath, config.repoPath, "provision targets the linked repo");
          return {
            feature,
            slug: feature,
            branch: `co/feat-${feature}`,
            worktreePath: worktree,
            provisionStatus: "ready",
          };
        },
      },
      async (reg) => {
        const j1 = await reg.dispatch("one", undefined, { feature: "auth" });
        assert.equal(j1.feature, "auth", "the job records its feature");
        assert.equal(j1.cwd, worktree, "the job records the worktree cwd");
        // On the pane path the worktree cwd is baked into the job script.
        const script1 = await fsp.readFile(`${j1.captureFile}.sh`, "utf8");
        assert.ok(script1.includes(`cd '${worktree}' ||`), "the job script cd's into the feature worktree");
        await completeJob(reg, j1, 0);
        const f1 = await queue.take();
        assert.equal(f1.status, "done");

        // The second dispatch to the same feature reuses the provisioned
        // worktree: no re-provision, same cwd. (The first job has completed and
        // released its pane, so the feature is free for the second dispatch.)
        const j2 = await reg.dispatch("two", undefined, { feature: "auth" });
        assert.equal(j2.cwd, worktree, "the second dispatch lands in the same worktree");
        await completeJob(reg, j2, 0);
        const f2 = await queue.take();
        assert.equal(f2.status, "done");
        assert.equal(provisions, 1, "provision ran once; the second dispatch reused the record");
        assert.deepEqual(
          reg.jobsForFeature("auth").map((j) => j.id),
          [j1.id, j2.id],
          "both jobs are linked to the feature",
        );
        assert.equal(reg.getFeature("auth")?.provisionStatus, "ready");
      },
    );
  } finally {
    teardown();
    await cleanup();
  }
});

test("a feature dispatch on the pane path cd's the job script into the worktree; the plain path is untouched", async () => {
  const { paths, cleanup } = await tmpInstance();
  const teardown = stubGhostty();
  try {
    const config: DispatchConfig = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
    const worktree = path.join(paths.root, "wt", "auth");
    await fsp.mkdir(worktree, { recursive: true });

    await withRegistry(
      {
        paths,
        config,
        onComplete: () => {},
        skipAnchorCheck: true,
        pollIntervalMs: 10_000, // never let the fake jobs complete
        provisionWorktree: async (_opts, feature) => ({
          feature,
          slug: feature,
          branch: `co/feat-${feature}`,
          worktreePath: worktree,
          provisionStatus: "ready",
        }),
      },
      async (reg) => {
        const j1 = await reg.dispatch("one", undefined, { feature: "auth" });
        assert.equal(j1.transport, "ghostty");
        assert.equal(j1.paneId, "anchor-1");
        const script = await fsp.readFile(`${j1.captureFile}.sh`, "utf8");
        assert.ok(script.includes(`cd '${worktree}' ||`), "the job script cd's into the feature worktree");
        assert.ok(!script.includes(`cd '${paths.root}' ||`), "not into the primary repo");

        // One live agent per worktree: a second dispatch to the feature while
        // its job runs fails cleanly instead of launching alongside.
        const j2 = await reg.dispatch("two", undefined, { feature: "auth" });
        assert.equal(j2.status, "failed");
        assert.match(j2.error ?? "", /already has an active job/);

        // A plain dispatch in the same session is untouched: repo cwd, no feature.
        const j3 = await reg.dispatch("three");
        assert.equal(j3.status, "running");
        assert.equal(j3.feature, undefined);
        const plainScript = await fsp.readFile(`${j3.captureFile}.sh`, "utf8");
        assert.ok(plainScript.includes(`cd '${paths.root}' ||`), "the plain job still cd's into the repo");
      },
    );
  } finally {
    teardown();
    await cleanup();
  }
});

test("a provisioning failure fails the job cleanly and records the failed feature status", async () => {
  const { paths, cleanup } = await tmpInstance();
  const teardown = stubGhostty();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
    const done = onCompleteOnce();
    await withRegistry(
      {
        paths,
        config,
        onComplete: done.handler,
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
        provisionWorktree: async () => {
          throw new Error("branch 'co/feat-auth' already exists without a worktree; run reconcile or teardown first");
        },
      },
      async (reg) => {
        const job = await reg.dispatch("one", undefined, { feature: "auth" });
        assert.equal(job.status, "failed", "the dispatch call returns a failed job, never throws");
        assert.match(job.error ?? "", /already exists without a worktree/);
        assert.equal(job.cwd, undefined, "no cwd was bound");
        const notified = await done.promise;
        assert.equal(notified.id, job.id, "the failure notifies like any launch failure");
        assert.equal(reg.getFeature("auth")?.provisionStatus, "failed");
      },
    );
  } finally {
    teardown();
    await cleanup();
  }
});

test("a plain dispatch never touches the provisioning path", async () => {
  const { paths, cleanup } = await tmpInstance();
  const teardown = stubGhostty();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
    config.agents = [{ name: "fake", command: `sh -c 'echo PLAIN'` }];
    config.defaultAgent = "fake";
    let provisions = 0;
    const done = onCompleteOnce();
    await withRegistry(
      {
        paths,
        config,
        onComplete: done.handler,
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
        provisionWorktree: async (_opts, feature) => {
          provisions++;
          return { feature, slug: feature, branch: "x", worktreePath: "/x", provisionStatus: "ready" };
        },
      },
      async (reg) => {
        const job = await reg.dispatch("just do it");
        assert.equal(job.feature, undefined);
        assert.equal(job.cwd, undefined);
        await completeJob(reg, job, 0);
        const finished = await done.promise;
        assert.equal(finished.status, "done");
        assert.equal(provisions, 0, "no provisioning happens for a plain dispatch");
      },
    );
  } finally {
    teardown();
    await cleanup();
  }
});

/** Run git in a fixture repo for the end-to-end feature dispatch below. */
function runGit(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${res.status}): ${res.stderr}`);
  }
  return res.stdout.trim();
}

// --- link durability: closing worker panes never breaks the link -----------
//
// The confirmed bug: deleting any tracked worker pane left a stale id in the
// in-memory layout, the next dispatch targeted the dead id, Ghostty -1719'd, and
// the registry nulled the WHOLE layout — the transport link died until `co pane`
// was re-run. These prove the fix end-to-end through the registry (with a stubbed
// osascript that reports closed panes gone and -1719s a placement onto one, just
// like live Ghostty): one dead worker prunes exactly one id and the link lives on.

test("closing a finished worker pane prunes only that id; the link survives and the next dispatch spawns a worker", async () => {
  const { paths, cleanup } = await tmpInstance();
  const { dead, launches, teardown } = stubGhosttyWithDeaths();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
    config.pane = { directionSequence: ["right", "down"], cap: 4 };
    config.agents = [{ name: "fake", command: `sh -c 'echo HI'` }];
    config.defaultAgent = "fake";

    let anchorLost = 0;
    await withRegistry(
      {
        paths,
        config,
        onComplete: () => {},
        skipAnchorCheck: true,
        pollIntervalMs: 10_000, // keep the fake jobs "running" for the whole test
        onAnchorLost: () => anchorLost++,
      },
      async (reg) => {
        const j1 = await reg.dispatch("one"); // takeover anchor-1
        const j2 = await reg.dispatch("two"); // split anchor-1 → pane-1
        const j3 = await reg.dispatch("three"); // split pane-1 → pane-2
        assert.equal(j1.paneId, "anchor-1");
        assert.equal(j2.paneId, "pane-1");
        assert.equal(j3.paneId, "pane-2");

        // The captain closes the newest worker pane (pane-2).
        dead.add("pane-2");

        // The next dispatch prunes ONLY pane-2, splits the newest LIVING pane
        // (pane-1), and spawns a fresh worker. The link is untouched.
        const j4 = await reg.dispatch("four");
        assert.equal(j4.status, "running", "the dispatch launches normally, not a failure");
        assert.equal(j4.paneId, "pane-3", "a fresh worker was spawned");
        assert.equal(reg.paneReady, true, "the link survived a single closed pane");
        assert.equal(anchorLost, 0, "the anchor was never reported lost for a mere worker close");

        // The split for j4 grew from the newest LIVING pane, never the dead one.
        // (The order text never rides the AppleScript, so assert on the target id.)
        const lastSplit = launches().filter((s) => s.includes("split target direction")).pop()!;
        assert.ok(
          lastSplit.includes('first terminal whose id = "pane-1"'),
          `j4 must split the newest living pane (pane-1), got:\n${lastSplit}`,
        );
        assert.ok(!lastSplit.includes('"pane-2"'), "it must not target the closed pane");
      },
    );
  } finally {
    teardown();
    await cleanup();
  }
});

test("the layout is never nulled by a single dead worker pane, dispatch after dispatch", async () => {
  // "Go forever": spawn a worker, close it, dispatch again — repeatedly. Each
  // close prunes exactly one id and the link stays alive the whole time. Before
  // the fix, the first close-then-dispatch nulled the layout and every later
  // dispatch failed with "couldn't open a crew pane".
  const { paths, cleanup } = await tmpInstance();
  const { dead, teardown } = stubGhosttyWithDeaths();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
    config.pane = { directionSequence: ["right", "down"], cap: 4 };
    config.agents = [{ name: "fake", command: `sh -c 'echo HI'` }];
    config.defaultAgent = "fake";

    let anchorLost = 0;
    await withRegistry(
      {
        paths,
        config,
        onComplete: () => {},
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
        onAnchorLost: () => anchorLost++,
      },
      async (reg) => {
        const j1 = await reg.dispatch("first"); // takeover anchor-1 (kept open)
        assert.equal(j1.paneId, "anchor-1");

        // Ten rounds of: spawn a worker, then close it. The anchor pane stays
        // open throughout, so each round finds no living child and grows a fresh
        // worker by splitting the anchor. Every dispatch launches; nothing is
        // ever nulled.
        const spawned: string[] = [];
        for (let i = 0; i < 10; i++) {
          const job = await reg.dispatch(`round ${i}`);
          assert.equal(job.status, "running", `round ${i}: dispatch must launch, not fail`);
          assert.ok(job.paneId, `round ${i}: a pane was placed`);
          assert.notEqual(job.paneId, "anchor-1", `round ${i}: a worker, not the anchor, ran the job`);
          assert.equal(reg.paneReady, true, `round ${i}: the link is still alive`);
          spawned.push(job.paneId!);
          // The captain closes the finished worker before the next round.
          dead.add(job.paneId!);
        }
        assert.equal(new Set(spawned).size, spawned.length, "each round spawned a distinct fresh pane");
        assert.equal(anchorLost, 0, "the anchor was never lost across the whole run");
      },
    );
  } finally {
    teardown();
    await cleanup();
  }
});

test("a pane that dies between the liveness sweep and the split is pruned reactively and the dispatch still lands", async () => {
  // The TOCTOU backstop: reconcilePaneLiveness reports a pane alive, but it is
  // closed before the split reaches it, so the split -1719s. launchResilient must
  // prune that one id and re-plan against the survivors — not null the layout.
  const { paths, cleanup } = await tmpInstance();
  const launches: string[] = [];
  const toctouDead = new Set<string>();
  let split = 0;
  setGhosttyAvailableForTest(true);
  setOsaRunnerForTest(async (s) => {
    // Every pane probes ALIVE — the death is invisible to the sweep.
    if (s.includes("exists (first terminal")) return "true";
    const tm = s.match(/first terminal whose id = "([^"]+)"/);
    if (tm && toctouDead.has(tm[1]!)) {
      throw new Error(`Ghostty got an error: Can't get terminal 1 whose id = "${tm[1]}". (-1719)`);
    }
    launches.push(s);
    await touchCaptureFromScript(s);
    if (s.includes("split ")) return `pane-${++split}`;
    return tm ? tm[1]! : "anchor-1";
  });
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
    config.pane = { directionSequence: ["right", "down"], cap: 4 };
    config.agents = [{ name: "fake", command: `sh -c 'echo HI'` }];
    config.defaultAgent = "fake";

    let anchorLost = 0;
    await withRegistry(
      {
        paths,
        config,
        onComplete: () => {},
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
        onAnchorLost: () => anchorLost++,
      },
      async (reg) => {
        await reg.dispatch("one"); // takeover anchor-1
        await reg.dispatch("two"); // split anchor-1 → pane-1
        const j3 = await reg.dispatch("three"); // split pane-1 → pane-2
        assert.equal(j3.paneId, "pane-2");

        // pane-2 still probes alive, but the split onto it will -1719 (closed in
        // the instant between the sweep and the AppleScript split).
        toctouDead.add("pane-2");

        const j4 = await reg.dispatch("four");
        assert.equal(j4.status, "running", "the retry landed the dispatch");
        assert.equal(j4.paneId, "pane-3", "it grew from the newest surviving pane (pane-1)");
        assert.equal(reg.paneReady, true, "the layout survived a reactively-pruned pane");
        assert.equal(anchorLost, 0, "no anchor loss for a dead worker");
        const lastSplit = launches.filter((s) => s.includes("split target direction")).pop()!;
        assert.ok(lastSplit.includes('first terminal whose id = "pane-1"'), "the successful split targeted pane-1");
      },
    );
  } finally {
    setGhosttyAvailableForTest(null);
    setOsaRunnerForTest(null);
    await cleanup();
  }
});

test("when no living children remain, the next worker splits from the anchor", async () => {
  const { paths, cleanup } = await tmpInstance();
  const { dead, launches, teardown } = stubGhosttyWithDeaths();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
    config.pane = { directionSequence: ["right", "down"], cap: 4 };
    config.agents = [{ name: "fake", command: `sh -c 'echo HI'` }];
    config.defaultAgent = "fake";

    await withRegistry(
      { paths, config, onComplete: () => {}, skipAnchorCheck: true, pollIntervalMs: 10_000 },
      async (reg) => {
        const j1 = await reg.dispatch("one"); // takeover anchor-1
        const j2 = await reg.dispatch("two"); // split anchor-1 → pane-1
        assert.equal(j2.paneId, "pane-1");

        // Close the only worker child; the anchor pane is still open.
        dead.add("pane-1");

        const j3 = await reg.dispatch("three");
        assert.equal(j3.status, "running");
        assert.equal(j3.paneId, "pane-2", "a fresh worker grew from the anchor");
        const lastSplit = launches().filter((s) => s.includes("split target direction")).pop()!;
        assert.ok(
          lastSplit.includes('first terminal whose id = "anchor-1"'),
          `with no living children the split must target the anchor, got:\n${lastSplit}`,
        );
      },
    );
  } finally {
    teardown();
    await cleanup();
  }
});

test("when the anchor pane itself is gone and no worker survives, the dispatch fails with a re-run message (never a cryptic error)", async () => {
  const { paths, cleanup } = await tmpInstance();
  const { dead, teardown } = stubGhosttyWithDeaths();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
    config.pane = { directionSequence: ["right", "down"], cap: 4 };
    config.agents = [{ name: "fake", command: `sh -c 'echo HI'` }];
    config.defaultAgent = "fake";

    let anchorLost = 0;
    await withRegistry(
      {
        paths,
        config,
        onComplete: () => {},
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
        onAnchorLost: () => anchorLost++,
      },
      async (reg) => {
        const j1 = await reg.dispatch("one"); // takeover anchor-1
        assert.equal(j1.paneId, "anchor-1");

        // The captain closes the anchor pane itself; there are no worker children
        // to fall back to.
        dead.add("anchor-1");

        const j2 = await reg.dispatch("two");
        assert.equal(j2.status, "failed", "no living surface: the dispatch fails cleanly");
        assert.match(j2.error ?? "", /couldn't open a crew pane/);
        assert.match(j2.error ?? "", /co pane/, "the message names the fix — re-run `co pane`");
        assert.equal(j2.paneId, undefined, "nothing was placed");
        assert.equal(anchorLost, 1, "the dead anchor is reported lost exactly once");
        assert.equal(reg.paneReady, false, "the anchor is dropped for the session");
      },
    );
  } finally {
    teardown();
    await cleanup();
  }
});

// --- link durability: an orphaned launch failure never costs the layout -----
//
// The other way a launch can fail with NOTHING dead: Ghostty makes the split and
// hands back a pane id, but that pane's surface command never runs, so the job
// script never creates its capture and the launch probe times out. The transport
// reaps the stray pane and reports the failure against its id — an id that was
// never committed to the layout. Read as a dead TRACKED pane it would escape to
// the anchor-loss path and null the whole layout, telling the captain to re-run
// `co pane` while the anchor and every worker are perfectly healthy. These prove
// it stays a single-dispatch failure instead.

/** A Ghostty stub whose splits succeed but whose new panes optionally never run
 *  their job (`startFails`), reproducing the orphaned-launch failure. Every pane
 *  probes alive; `close` scripts are recorded so the reap can be asserted. */
function stubGhosttyWithDeadSplits(): {
  setStartFails: (v: boolean) => void;
  closes: () => string[];
  launches: () => string[];
  teardown: () => void;
} {
  const closes: string[] = [];
  const launches: string[] = [];
  let split = 0;
  let startFails = false;
  setGhosttyAvailableForTest(true);
  setOsaRunnerForTest(async (s) => {
    if (s.includes("exists (first terminal")) return "true"; // nothing is closed
    if (s.includes("close ")) {
      closes.push(s);
      return "";
    }
    launches.push(s);
    if (s.includes("split ")) {
      // The split itself SUCCEEDS — Ghostty creates the pane and returns its id.
      // Only its surface command fails to run, so the capture never appears.
      if (!startFails) await touchCaptureFromScript(s);
      return `pane-${++split}`;
    }
    await touchCaptureFromScript(s);
    const tm = s.match(/first terminal whose id = "([^"]+)"/);
    return tm ? tm[1]! : "anchor-1";
  });
  return {
    setStartFails: (v) => (startFails = v),
    closes: () => closes,
    launches: () => launches,
    teardown: () => {
      setGhosttyAvailableForTest(null);
      setOsaRunnerForTest(null);
    },
  };
}

/** Shared config for the orphan-path tests. */
function orphanTestConfig(rootPath: string) {
  const config = defaultDispatchConfig();
  config.repoPath = rootPath;
  config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
  config.pane = { directionSequence: ["right", "down"], cap: 4 };
  config.agents = [{ name: "fake", command: `sh -c 'echo HI'` }];
  config.defaultAgent = "fake";
  return config;
}

test("a split whose new pane never runs the job fails one dispatch and leaves the layout intact", async () => {
  const { paths, cleanup } = await tmpInstance();
  const { setStartFails, closes, launches, teardown } = stubGhosttyWithDeadSplits();
  try {
    let anchorLost = 0;
    await withRegistry(
      {
        paths,
        config: orphanTestConfig(paths.root),
        onComplete: () => {},
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
        paneStartTimeoutMs: 150, // don't spend the transport's real 4s budget
        onAnchorLost: () => anchorLost++,
      },
      async (reg) => {
        const j1 = await reg.dispatch("one"); // takeover anchor-1
        const j2 = await reg.dispatch("two"); // split anchor-1 → pane-1
        assert.equal(j1.paneId, "anchor-1");
        assert.equal(j2.paneId, "pane-1");

        // The next split is created but its job never starts in it.
        setStartFails(true);
        const j3 = await reg.dispatch("three");

        assert.equal(j3.status, "failed", "the dispatch itself fails");
        assert.equal(j3.paneId, undefined, "nothing was placed");
        // The whole point of the fix: a healthy link is not reported as broken.
        assert.equal(reg.paneReady, true, "the layout survives an orphaned launch failure");
        assert.equal(anchorLost, 0, "the anchor was never reported lost");
        assert.doesNotMatch(j3.error ?? "", /co pane/, "no spurious re-run `co pane`");
        assert.match(j3.error ?? "", /crew link is fine/, "it says the link is fine");
        assert.equal(closes().length, 1, "the orphan pane it created was reaped");
        assert.ok(
          closes()[0]!.includes('id = "pane-2"'),
          `the reaped pane is the one the failed split made, got:\n${closes()[0]}`,
        );

        // And the link really is intact: the next working dispatch still splits
        // the newest LIVING TRACKED pane (pane-1). The orphan was never tracked,
        // so it neither became a split origin nor displaced one.
        setStartFails(false);
        const j4 = await reg.dispatch("four");
        assert.equal(j4.status, "running", "the very next dispatch launches normally");
        assert.equal(j4.paneId, "pane-3", "a fresh worker was spawned");
        const lastSplit = launches().filter((s) => s.includes("split target direction")).pop()!;
        assert.ok(
          lastSplit.includes('first terminal whose id = "pane-1"'),
          `j4 must split the newest living tracked pane (pane-1), got:\n${lastSplit}`,
        );
      },
    );
  } finally {
    teardown();
    await cleanup();
  }
});

test("an orphaned launch failure is bounded: one split attempt, then a clean failure", async () => {
  // No retry storm. Pruning cannot help here (the id was never tracked), so a
  // retry would just create and abandon another pane, forever.
  const { paths, cleanup } = await tmpInstance();
  const { setStartFails, closes, launches, teardown } = stubGhosttyWithDeadSplits();
  try {
    let anchorLost = 0;
    await withRegistry(
      {
        paths,
        config: orphanTestConfig(paths.root),
        onComplete: () => {},
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
        paneStartTimeoutMs: 150,
        onAnchorLost: () => anchorLost++,
      },
      async (reg) => {
        await reg.dispatch("one"); // takeover anchor-1
        setStartFails(true); // every split from here creates a pane that won't run

        const j2 = await reg.dispatch("two");
        assert.equal(j2.status, "failed");
        const splits = launches().filter((s) => s.includes("split target direction"));
        assert.equal(splits.length, 1, "exactly one split was attempted, not a retry loop");
        assert.equal(closes().length, 1, "exactly one stray pane was created and reaped");
        assert.equal(reg.paneReady, true, "and the layout is still intact");
        assert.equal(anchorLost, 0);
      },
    );
  } finally {
    teardown();
    await cleanup();
  }
});

test("a busy pane we were HANDED is not a dead pane: the dispatch splits from it instead", async () => {
  // The boundary, and the one behaviour this slice deliberately changes. A
  // takeover targets a pane co did not create; if the job never starts there the
  // pane is real, still open, and owned by something else. It used to escalate to
  // "the anchor is gone, re-run `co pane`" — which was the wrong diagnosis and
  // dropped a perfectly good link. Now it means exactly what it says: the pane is
  // busy, so split one off it and leave whatever is in there alone.
  const { paths, cleanup } = await tmpInstance();
  const closes: string[] = [];
  setGhosttyAvailableForTest(true);
  setOsaRunnerForTest(async (s) => {
    if (s.includes("exists (first terminal")) return "true";
    if (s.includes("close ")) {
      closes.push(s);
      return "";
    }
    if (s.includes("split ")) {
      // A split off the busy anchor works normally: play the launch probe.
      const m = s.match(/\/bin\/sh '([^']+)\.sh'/);
      if (m) await fsp.writeFile(m[1]!, "", "utf8");
      return "pane-1";
    }
    // The paste "succeeds" but whatever owns the anchor swallowed it: no capture.
    return "anchor-1";
  });
  try {
    let anchorLost = 0;
    await withRegistry(
      {
        paths,
        config: orphanTestConfig(paths.root),
        onComplete: () => {},
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
        paneStartTimeoutMs: 150,
        onAnchorLost: () => anchorLost++,
      },
      async (reg) => {
        const j1 = await reg.dispatch("one"); // takeover anchor-1, which is busy
        assert.equal(j1.status, "running", "the dispatch lands rather than failing");
        assert.equal(j1.paneId, "pane-1", "in a pane split off the busy anchor");
        assert.equal(anchorLost, 0, "the anchor was never lost — it is just occupied");
        assert.equal(reg.paneReady, true, "so the link is intact");
        assert.deepEqual(closes, [], "nothing was created and abandoned");
      },
    );
  } finally {
    setGhosttyAvailableForTest(null);
    setOsaRunnerForTest(null);
    await cleanup();
  }
});

test("feature dispatch end-to-end: real provision, crew cwd = worktree on the feature branch, reuse on the second dispatch", async () => {
  // The whole provision → dispatch-isolated loop against a real git repo: the
  // registry provisions through worktrees.ts for real, and the (stubbed) pane
  // launch bakes the worktree as the crew's cwd into the job script. We verify
  // isolation from git's own view (a real worktree on the feature branch) and
  // from the generated job script's cd, since on the pane path the crew's stdout
  // goes to the pane tty, not the capture. The tmp root is realpath'd so macOS's
  // /var → /private/var spelling can't fool the path assertions.
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "co-registry-feat-")));
  const teardown = stubGhostty();
  try {
    const repo = path.join(root, "repo");
    await fsp.mkdir(repo);
    runGit(repo, ["init", "-q", "-b", "main"]);
    runGit(repo, ["config", "user.email", "test@test"]);
    runGit(repo, ["config", "user.name", "test"]);
    runGit(repo, ["config", "commit.gpgsign", "false"]);
    await fsp.writeFile(path.join(repo, "file.txt"), "hello\n", "utf8");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-q", "-m", "init"]);
    // Feature worktrees are cut from origin/dev, so the repo needs one. The fake
    // forge serves it (and the fetch) with no network and no gh binary.
    const forge = makeFakeForge(repo, { dev: runGit(repo, ["rev-parse", "main"]) });

    const paths = instancePaths(path.join(root, "home"), "inst");
    await fsp.mkdir(paths.captures, { recursive: true });
    const config = defaultDispatchConfig();
    config.repoPath = repo;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
    config.pane = { directionSequence: ["right", "down"], cap: 4 };
    config.agents = [{ name: "fake", command: `sh -c 'true'` }];
    config.defaultAgent = "fake";

    const queue = onCompleteQueue();
    await withRegistry(
      {
        paths,
        config,
        onComplete: queue.handler,
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
        // The REAL provisioning code path, with only the remote faked.
        provisionWorktree: (opts, feature) => provisionWorktree({ ...opts, run: forge.run }, feature),
      },
      async (reg) => {
        const worktree = path.join(defaultWorktreeBase(repo), "auth");
        const j1 = await reg.dispatch("one", undefined, { feature: "auth" });
        assert.equal(j1.cwd, worktree, "the crew cwd is the provisioned worktree in the sibling base dir");
        // The real worktree exists, checked out on the feature branch (never main).
        const branchAtWorktree = runGit(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
        assert.equal(branchAtWorktree, "feat/auth", "the worktree is on the feature branch");
        // The generated job script cd's the crew into that worktree.
        const script1 = await fsp.readFile(`${j1.captureFile}.sh`, "utf8");
        assert.ok(script1.includes(`cd '${worktree}' ||`), "the crew is launched inside the worktree");
        assert.equal(reg.getFeature("auth")?.provisionStatus, "ready");
        await completeJob(reg, j1, 0);
        const f1 = await queue.take();
        assert.equal(f1.status, "done");

        // Second dispatch to the same feature: same worktree, nothing recreated.
        const worktreesBefore = runGit(repo, ["worktree", "list", "--porcelain"]);
        const j2 = await reg.dispatch("two", undefined, { feature: "auth" });
        assert.equal(j2.cwd, worktree, "the second dispatch reuses the same worktree");
        await completeJob(reg, j2, 0);
        const f2 = await queue.take();
        assert.equal(f2.status, "done");
        assert.equal(
          runGit(repo, ["worktree", "list", "--porcelain"]),
          worktreesBefore,
          "no second worktree was created",
        );
        assert.deepEqual(reg.jobsForFeature("auth").map((j) => j.id), [j1.id, j2.id]);

        // The primary tree never moved off main.
        assert.equal(runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
      },
    );
  } finally {
    teardown();
    await fsp.rm(root, { recursive: true, force: true });
  }
});
