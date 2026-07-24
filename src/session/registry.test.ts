import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { instancePaths } from "../paths.js";
import { defaultWorktreeBase } from "./worktrees.js";
import {
  defaultDispatchConfig,
  writeDispatchConfig,
  type DispatchConfig,
} from "./dispatchconfig.js";
import { crewPaneTitle } from "./crewpanes.js";
import { setGhosttyAvailableForTest, setOsaRunnerForTest } from "./transport.js";
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

test("at the pane cap the next job queues, then reuses a freed pane on completion", async () => {
  const { paths, cleanup } = await tmpInstance();
  const teardown = stubGhostty();
  try {
    const config: DispatchConfig = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
    config.pane = { directionSequence: ["right", "down"], cap: 2 };

    await withRegistry(
      {
        paths,
        config,
        onComplete: () => {},
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
      },
      async (reg) => {
        const j1 = await reg.dispatch("one"); // takeover anchor
        const j2 = await reg.dispatch("two"); // split → pane-1 (now at cap 2)
        const j3 = await reg.dispatch("three"); // cap reached, nothing free → queued
        assert.equal(j3.status, "queued");
        assert.equal(reg.activeCount(), 3);

        // Simulate j1's crew PROCESS exiting: buildJobScript's finish() writes
        // the exit sentinel AND removes its own launch script in one breath, so a
        // real process-exit is "sentinel present, <capture>.sh gone". Reproduce
        // both — the registry now gates pane reuse on the script's absence (a
        // hook-completed pane whose agent is still live keeps its script), so a
        // completion that left the script behind would (correctly) NOT free the
        // pane. Then run one manual poll: finalize() awaits the queue drain, so by
        // the time tick() returns the freed anchor has relaunched the queued j3.
        await fsp.writeFile(j1.captureFile, "done\n__CO_DISPATCH_DONE__ 0\n", "utf8");
        await fsp.rm(`${j1.captureFile}.sh`, { force: true });
        await (reg as unknown as { tick: () => Promise<void> }).tick();

        assert.equal(j1.status, "done");
        assert.equal(j3.status, "running", "queued job launches into the freed pane");
        assert.equal(j3.paneId, "anchor-1", "reuses the oldest finished pane (the anchor)");
        void j2;
      },
    );
  } finally {
    teardown();
    await cleanup();
  }
});

test("a hook-completed pane is NOT reused while its agent is still live, but is once the launch script clears", async () => {
  // The Stop hook fires the review on the crew's FIRST finish, while the agent is
  // still interactive in its pane. Releasing that pane for reuse then would paste
  // a launch line into a running agent. The registry must fire the review but hold
  // the pane until the crew PROCESS exits — signalled by buildJobScript removing
  // its own launch script (<capture>.sh). This proves both halves — and that a
  // LIVE pane is never reused.
  const { paths, cleanup } = await tmpInstance();
  const teardown = stubGhostty();
  try {
    const config: DispatchConfig = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
    config.pane = { directionSequence: ["right", "down"], cap: 2 };

    const completed: string[] = [];
    await withRegistry(
      {
        paths,
        config,
        onComplete: (j) => completed.push(j.id),
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
      },
      async (reg) => {
        const j1 = await reg.dispatch("one"); // takeover anchor
        const j2 = await reg.dispatch("two"); // split → pane-1 (now at cap 2)
        const j3 = await reg.dispatch("three"); // cap reached, nothing free → queued
        assert.equal(j3.status, "queued");

        // j1's Stop hook fires on first finish: the sentinel lands but the launch
        // script stays (the agent is still live in the pane). launchGhostty wrote
        // that .sh to disk, so it genuinely exists.
        assert.ok(fs.existsSync(`${j1.captureFile}.sh`), "the launch script exists while the agent is live");
        await fsp.writeFile(j1.captureFile, "done\n__CO_DISPATCH_DONE__ 0\n", "utf8");
        await (reg as unknown as { tick: () => Promise<void> }).tick();

        assert.equal(j1.status, "done", "the review fires on first finish");
        assert.ok(completed.includes("job-001"), "completion was reported immediately");
        assert.equal(j3.status, "queued", "but the still-live pane is NOT reused yet");
        assert.equal(reg.get("job-003")!.paneId, undefined, "the queued job has no pane");

        // The human closes j1's agent: buildJobScript's finish() removes the
        // script. The next poll reclaims the pane and drains the queued job into it.
        await fsp.rm(`${j1.captureFile}.sh`, { force: true });
        await (reg as unknown as { tick: () => Promise<void> }).tick();

        assert.equal(j3.status, "running", "the freed pane relaunches the queued job");
        assert.equal(j3.paneId, "anchor-1", "into the released anchor pane");
        void j2;
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

test("feature dispatch end-to-end: real provision, crew cwd = worktree on co/feat-*, reuse on the second dispatch", async () => {
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
      { paths, config, onComplete: queue.handler, skipAnchorCheck: true, pollIntervalMs: 10_000 },
      async (reg) => {
        const worktree = path.join(defaultWorktreeBase(repo), "auth");
        const j1 = await reg.dispatch("one", undefined, { feature: "auth" });
        assert.equal(j1.cwd, worktree, "the crew cwd is the provisioned worktree in the sibling base dir");
        // The real worktree exists, checked out on the feature branch (never main).
        const branchAtWorktree = runGit(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
        assert.equal(branchAtWorktree, "co/feat-auth", "the worktree is on the feature branch");
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
