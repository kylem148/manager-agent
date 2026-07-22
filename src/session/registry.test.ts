import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { instancePaths } from "../paths.js";
import {
  defaultDispatchConfig,
  writeDispatchConfig,
  type DispatchConfig,
} from "./dispatchconfig.js";
import { crewPaneTitle } from "./crewpanes.js";
import { setGhosttyAvailableForTest, setOsaRunnerForTest } from "./transport.js";
import { DispatchRegistry, type Job, type RegistryOptions } from "./registry.js";

/**
 * Tests for the job registry + capture watcher. The fallback path runs a real
 * fake echo agent so completion detection via the sentinel is exercised for
 * real; the Ghostty path uses a stubbed osascript so cap/queue/reuse can be
 * driven without a GUI. A fast poll interval keeps the suite quick.
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

/** Run `fn` with a fresh registry, guaranteeing stop() and cleanup afterward. */
async function withRegistry(
  opts: Omit<RegistryOptions, "paths"> & { paths: ReturnType<typeof instancePaths> },
  fn: (reg: DispatchRegistry) => Promise<void>,
): Promise<void> {
  const reg = new DispatchRegistry(opts);
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

test("fallback dispatch runs a fake agent and fires a done review with the capture", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.agents = [{ name: "fake", command: `sh -c 'echo HELLO-FROM-AGENT'` }];
    config.defaultAgent = "fake";
    const done = onCompleteOnce();
    await withRegistry(
      { paths, config, onComplete: done.handler, transportOverride: "fallback", pollIntervalMs: 25 },
      async (reg) => {
        const job = await reg.dispatch("do it");
        assert.equal(job.transport, "fallback");
        assert.equal(job.status, "running");

        const finished = await done.promise;
        assert.equal(finished.status, "done");
        assert.equal(finished.exitCode, 0);
        const captured = await fsp.readFile(finished.captureFile, "utf8");
        assert.ok(captured.includes("HELLO-FROM-AGENT"));
      },
    );
  } finally {
    await cleanup();
  }
});

test("a nonzero agent exit is reported as a failed job", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.agents = [{ name: "fake", command: `sh -c 'echo nope; exit 7'` }];
    config.defaultAgent = "fake";
    const done = onCompleteOnce();
    await withRegistry(
      { paths, config, onComplete: done.handler, transportOverride: "fallback", pollIntervalMs: 25 },
      async (reg) => {
        await reg.dispatch("x");
        const finished = await done.promise;
        assert.equal(finished.status, "failed");
        assert.equal(finished.exitCode, 7);
      },
    );
  } finally {
    await cleanup();
  }
});

test("a confirm-time agent override selects that agent's command for the run", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    // Two agents that print distinct markers; default is cc, we override to ccw.
    config.agents = [
      { name: "cc", command: `sh -c 'echo RAN-CC'` },
      { name: "ccw", command: `sh -c 'echo RAN-CCW'` },
    ];
    config.defaultAgent = "cc";
    const done = onCompleteOnce();
    await withRegistry(
      { paths, config, onComplete: done.handler, transportOverride: "fallback", pollIntervalMs: 25 },
      async (reg) => {
        const job = await reg.dispatch("do it", "ccw");
        assert.equal(job.agentName, "ccw", "the override is recorded on the job");
        const finished = await done.promise;
        const captured = await fsp.readFile(finished.captureFile, "utf8");
        assert.ok(captured.includes("RAN-CCW"), "the overridden agent ran");
        assert.ok(!captured.includes("RAN-CC\n"), "the default agent did not run");
      },
    );
  } finally {
    await cleanup();
  }
});

test("a hung agent is killed and failed when it exceeds the wall-clock timeout", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.agents = [{ name: "fake", command: `sh -c 'sleep 30'` }];
    config.defaultAgent = "fake";
    config.caps = { timeoutSec: 1 };
    const done = onCompleteOnce();
    await withRegistry(
      { paths, config, onComplete: done.handler, transportOverride: "fallback", pollIntervalMs: 50 },
      async (reg) => {
        await reg.dispatch("hang");
        const finished = await done.promise;
        assert.equal(finished.status, "failed");
        assert.match(finished.error ?? "", /timed out/);
      },
    );
  } finally {
    await cleanup();
  }
});

test("Ghostty path takes over the anchor then splits the newest pane", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config: DispatchConfig = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };

    let split = 0;
    setGhosttyAvailableForTest(true);
    setOsaRunnerForTest(async (s) => (s.includes("split ") ? `pane-${++split}` : "anchor-1"));

    await withRegistry(
      {
        paths,
        config,
        onComplete: () => {},
        transportOverride: "ghostty",
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
    setGhosttyAvailableForTest(null);
    setOsaRunnerForTest(null);
    await cleanup();
  }
});

test("at the pane cap the next job queues, then reuses a freed pane on completion", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config: DispatchConfig = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "anchor-1", title: crewPaneTitle("inst") };
    config.pane = { directionSequence: ["right", "down"], cap: 2 };

    let split = 0;
    setGhosttyAvailableForTest(true);
    setOsaRunnerForTest(async (s) => (s.includes("split ") ? `pane-${++split}` : "anchor-1"));

    await withRegistry(
      {
        paths,
        config,
        onComplete: () => {},
        transportOverride: "ghostty",
        skipAnchorCheck: true,
        pollIntervalMs: 10_000,
      },
      async (reg) => {
        const j1 = await reg.dispatch("one"); // takeover anchor
        const j2 = await reg.dispatch("two"); // split → pane-1 (now at cap 2)
        const j3 = await reg.dispatch("three"); // cap reached, nothing free → queued
        assert.equal(j3.status, "queued");
        assert.equal(reg.activeCount(), 3);

        // Simulate j1's capture completing, then run one manual poll. finalize()
        // awaits the queue drain, so by the time tick() returns the freed anchor
        // has relaunched the queued j3 — no race.
        await fsp.writeFile(j1.captureFile, "done\n__CO_DISPATCH_DONE__ 0\n", "utf8");
        await (reg as unknown as { tick: () => Promise<void> }).tick();

        assert.equal(j1.status, "done");
        assert.equal(j3.status, "running", "queued job launches into the freed pane");
        assert.equal(j3.paneId, "anchor-1", "reuses the oldest finished pane (the anchor)");
        void j2;
      },
    );
  } finally {
    setGhosttyAvailableForTest(null);
    setOsaRunnerForTest(null);
    await cleanup();
  }
});

test("activeTransport degrades to fallback on Ghostty without a designated anchor", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = null; // never ran `co pane`
    setGhosttyAvailableForTest(true);
    await withRegistry(
      { paths, config, onComplete: () => {}, transportOverride: "ghostty", pollIntervalMs: 10_000 },
      async (reg) => {
        assert.equal(reg.activeTransport, "fallback");
      },
    );
  } finally {
    setGhosttyAvailableForTest(null);
    await cleanup();
  }
});

test("a stale/unresolvable pane id runs in the background with a populated capture, not a failure", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config: DispatchConfig = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.anchor = { id: "ghostty-uuid", title: crewPaneTitle("inst") };
    // A fake crew agent that prints and exits nonzero, so we prove the real exit
    // code survives the degrade to background.
    config.agents = [{ name: "fake", command: `sh -c 'echo CREW-RAN; exit 4'` }];
    config.defaultAgent = "fake";
    // The config must be on disk too: dispatch re-reads it before launching.
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
        transportOverride: "ghostty",
        skipAnchorCheck: true, // exercise the LAUNCH-time failure, not the exists probe
        pollIntervalMs: 25,
        onAnchorLost: () => anchorLost++,
      },
      async (reg) => {
        const job = await reg.dispatch("do it");
        // No thrown error, and the job did not fail to launch: it degraded.
        assert.notEqual(job.status, "failed", "a stale pane must not fail the dispatch");
        assert.equal(job.transport, "fallback", "degraded to the background transport");
        assert.equal(anchorLost, 1, "the dead anchor was reported lost");

        const finished = await done.promise;
        assert.equal(finished.status, "failed", "exit 4 is a failed run");
        assert.equal(finished.exitCode, 4, "the crew's real exit code is reported, not tee's 0");
        const captured = await fsp.readFile(finished.captureFile, "utf8");
        assert.ok(captured.length > 0, "the capture is not empty");
        assert.match(captured, /unavailable; ran in the background/, "records why it fell back");
        assert.ok(captured.includes("CREW-RAN"), "the crew still ran and its output was captured");
      },
    );
  } finally {
    setGhosttyAvailableForTest(null);
    setOsaRunnerForTest(null);
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
      const m = s.match(/first terminal whose id = "([^"]+)"/);
      return m ? m[1]! : "unknown";
    });

    await withRegistry(
      {
        paths,
        config,
        onComplete: () => {},
        transportOverride: "ghostty",
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
