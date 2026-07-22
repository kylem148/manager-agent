import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { instancePaths } from "../paths.js";
import { defaultDispatchConfig } from "./dispatchconfig.js";
import { CrewPaneLayout, crewPaneTitle } from "./crewpanes.js";
import {
  SENTINEL_PREFIX,
  sentinelLine,
  parseSentinel,
  buildShellCommand,
  composeSplitScript,
  osaEscape,
  jobArgv,
  launchFallback,
  launchGhostty,
  anchorExists,
  setOsaRunnerForTest,
} from "./transport.js";

/**
 * Tests for the two transports. The AppleScript and shell composition are pure
 * and tested directly; the fallback is exercised end-to-end with a fake echo
 * agent (a shell command, no tokens spent) so the capture-file + sentinel
 * contract is verified for real. The Ghostty path is tested with a stubbed
 * osascript runner — a live GUI launch can only be verified by hand.
 */

async function tmpInstance(): Promise<{ paths: ReturnType<typeof instancePaths>; cleanup: () => Promise<void> }> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "co-transport-"));
  const paths = instancePaths(home, "inst");
  await fsp.mkdir(paths.captures, { recursive: true });
  return { paths, cleanup: () => fsp.rm(home, { recursive: true, force: true }) };
}

/** Poll a capture file until it contains the sentinel or we time out. */
async function waitForSentinel(file: string, timeoutMs = 5000): Promise<string> {
  const start = Date.now();
  for (;;) {
    let content = "";
    try {
      content = await fsp.readFile(file, "utf8");
    } catch {
      /* not created yet */
    }
    if (parseSentinel(content)) return content;
    if (Date.now() - start > timeoutMs) throw new Error(`sentinel never appeared in ${file}:\n${content}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("sentinel round-trips through the capture text", () => {
  assert.equal(parseSentinel("no marker here"), null);
  assert.deepEqual(parseSentinel(`output\n${sentinelLine(0)}\n`), { exitCode: 0 });
  assert.deepEqual(parseSentinel(`${sentinelLine(2)}`), { exitCode: 2 });
  // A garbled code degrades to -1 rather than NaN.
  assert.deepEqual(parseSentinel(`${SENTINEL_PREFIX} notanumber`), { exitCode: -1 });
});

test("buildShellCommand tees to capture and appends the sentinel", () => {
  const cmd = buildShellCommand(["echo", "hi there"], "/tmp/cap.log");
  assert.ok(cmd.includes("'echo' 'hi there'"), "agent argv is shell-quoted");
  assert.ok(cmd.includes("tee '/tmp/cap.log'"), "output tees to the capture file");
  assert.ok(cmd.includes(SENTINEL_PREFIX), "sentinel is echoed on completion");
});

test("osaEscape escapes backslashes and quotes for an AppleScript literal", () => {
  assert.equal(osaEscape('a"b'), 'a\\"b');
  assert.equal(osaEscape("a\\b"), "a\\\\b");
});

test("composeSplitScript uses the real 1.3 grammar: split direction, input text, send key", () => {
  const script = composeSplitScript({
    decision: { kind: "split", target: "term-A", direction: "down" },
    shellCommand: "echo hi",
  });
  // Verified against Ghostty.sdef: `split <terminal> direction <dir>`, and
  // injection via `input text ... to` + `send key "enter" to`.
  assert.ok(script.includes("split target direction down"));
  assert.ok(script.includes('first terminal whose id = "term-A"'));
  assert.ok(script.includes("input text"));
  assert.ok(script.includes('send key "enter" to newTerm'));
  assert.ok(script.includes("return (id of newTerm as text)"));
  // The dead 'write text' / title-tagging grammar must be gone.
  assert.ok(!script.includes("write text"));
  assert.ok(!script.includes("set title"));
  assert.ok(!script.includes("split target with direction"), "old 'with direction' form is gone");
});

test("composeSplitScript for a takeover targets the anchor by id, no split", () => {
  const script = composeSplitScript({
    decision: { kind: "takeover", paneId: "anchor-1" },
    shellCommand: "echo hi",
  });
  assert.ok(!script.includes("split "), "a takeover must not split");
  assert.ok(script.includes('first terminal whose id = "anchor-1"'));
  assert.ok(script.includes('send key "enter" to target'));
});

test("jobArgv resolves the template with the order and repo", () => {
  const config = defaultDispatchConfig();
  config.repoPath = "/repo";
  config.commandTemplate = "claude --dir {repo} {prompt}";
  assert.deepEqual(jobArgv(config, "build X"), ["claude", "--dir", "/repo", "build X"]);
});

test("fallback launch runs a fake echo agent and produces a captured sentinel", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    // Fake agent: print a marker and the order, then exit 0. No tokens, no network.
    config.commandTemplate = `sh -c 'echo AGENT-RAN; echo "order={prompt}"'`;
    const res = await launchFallback({ paths, config, jobId: "job-001", order: "hello crew" });
    assert.equal(res.transport, "fallback");

    const captured = await waitForSentinel(paths.captureFile("job-001"));
    assert.ok(captured.includes("AGENT-RAN"), "the agent's output is captured");
    assert.ok(captured.includes("order=hello crew"), "the order reached the agent as its prompt");
    assert.deepEqual(parseSentinel(captured), { exitCode: 0 });
  } finally {
    await cleanup();
  }
});

test("fallback captures a nonzero exit code in the sentinel", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.commandTemplate = `sh -c 'echo boom; exit 3'`;
    await launchFallback({ paths, config, jobId: "job-002", order: "x" });
    const captured = await waitForSentinel(paths.captureFile("job-002"));
    assert.deepEqual(parseSentinel(captured), { exitCode: 3 });
  } finally {
    await cleanup();
  }
});

test("launchGhostty consults the planner and commits the returned pane id", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    const layout = new CrewPaneLayout({ id: "anchor-1", title: crewPaneTitle("inst") }, config.pane);

    const scripts: string[] = [];
    // Stub osascript: first (takeover) returns the anchor id; a split returns a
    // fresh id. We assert the planner state advances correctly off these.
    setOsaRunnerForTest(async (script) => {
      scripts.push(script);
      return script.includes("split ") ? "pane-new" : "anchor-1";
    });

    const first = await launchGhostty({ paths, config, layout, jobId: "j1", order: "one" });
    assert.equal(first.paneId, "anchor-1");
    assert.equal(first.placement?.kind, "takeover");
    assert.equal(layout.paneCount, 1);

    const second = await launchGhostty({ paths, config, layout, jobId: "j2", order: "two" });
    assert.equal(second.placement?.kind, "split");
    assert.equal(second.paneId, "pane-new");
    assert.equal(layout.paneCount, 2);
  } finally {
    setOsaRunnerForTest(null);
    await cleanup();
  }
});

test("anchorExists reports true/false from the exists probe and false on error", async () => {
  setOsaRunnerForTest(async (script) => {
    assert.ok(script.includes("exists"), "uses the AppleScript exists command");
    return script.includes("live-id") ? "true" : "false";
  });
  assert.equal(await anchorExists("live-id"), true);
  assert.equal(await anchorExists("dead-id"), false);
  setOsaRunnerForTest(async () => {
    throw new Error("osascript unavailable");
  });
  assert.equal(await anchorExists("any"), false, "an AppleScript failure degrades to false");
  setOsaRunnerForTest(null);
});

test("launchGhostty aborts the plan when osascript fails, leaving the layout clean", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config = defaultDispatchConfig();
    const layout = new CrewPaneLayout({ id: "anchor-1", title: crewPaneTitle("inst") }, config.pane);
    setOsaRunnerForTest(async () => {
      throw new Error("osascript boom");
    });
    await assert.rejects(() => launchGhostty({ paths, config, layout, jobId: "j1", order: "x" }));
    // The failed plan must be aborted so the next dispatch re-offers the anchor.
    assert.equal(layout.paneCount, 0);
    assert.deepEqual(layout.plan(), { kind: "takeover", paneId: "anchor-1" });
  } finally {
    setOsaRunnerForTest(null);
    await cleanup();
  }
});
