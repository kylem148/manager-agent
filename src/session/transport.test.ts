import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  // No cwd given: no cd prefix.
  assert.ok(!cmd.includes("cd "), "no cd when no cwd is supplied");
});

test("buildShellCommand cd's into the repo cwd when given one", () => {
  const cmd = buildShellCommand(["cc", "order"], "/tmp/cap.log", "/my/repo");
  assert.ok(
    cmd.startsWith("cd '/my/repo' || exit 1; "),
    `command must cd into the repo first, got: ${cmd}`,
  );
  // A bad path fails loudly (nonzero) rather than running in the wrong dir.
  assert.ok(cmd.includes("|| exit 1"), "a failed cd aborts the run");
  assert.ok(cmd.includes(SENTINEL_PREFIX), "sentinel still emitted");
  // Still no --dir anywhere.
  assert.ok(!cmd.includes("--dir"), "cwd replaces --dir entirely");
});

/**
 * The assembled command runs under two shells the transport does NOT choose:
 * the fallback's `sh` (dash on many Linux hosts) and, on the pane path, the
 * user's interactive login shell (zsh here). The old `${PIPESTATUS[0]:-$?}`
 * read the crew status only under bash: zsh left PIPESTATUS unset so it fell
 * back to tee's 0 (masking failures), and dash rejected it outright as a "Bad
 * substitution". This drives the SAME assembled string through every shell on
 * the box and asserts the sentinel reports the crew process's real code. */
function shellPath(name: string): string | null {
  try {
    return execFileSync("command", ["-v", name], { shell: "/bin/sh", encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

for (const shell of ["sh", "bash", "zsh", "dash"]) {
  const shPath = shellPath(shell);
  const label = `buildShellCommand sentinel reports the crew exit code under ${shell}`;
  test(label, { skip: shPath ? false : `${shell} not installed` }, async () => {
    const { paths, cleanup } = await tmpInstance();
    try {
      // Crew command prints to stdout AND stderr, then exits nonzero. Under the
      // buggy expansion, zsh/dash would report tee's 0 (or error) instead of 7.
      const capFail = paths.captureFile("shell-fail");
      const failCmd = buildShellCommand(
        ["sh", "-c", "echo to-stdout; echo to-stderr 1>&2; exit 7"],
        capFail,
      );
      execFileSync(shPath!, ["-c", failCmd], { stdio: "ignore" });
      const failCap = await fsp.readFile(capFail, "utf8");
      assert.ok(failCap.includes("to-stdout"), "stdout is captured");
      assert.ok(failCap.includes("to-stderr"), "stderr is folded into the capture");
      assert.deepEqual(
        parseSentinel(failCap),
        { exitCode: 7 },
        `sentinel must report the crew code (7), not tee's 0, under ${shell}`,
      );

      // A clean exit still reads 0.
      const capOk = paths.captureFile("shell-ok");
      const okCmd = buildShellCommand(["sh", "-c", "echo done; exit 0"], capOk);
      execFileSync(shPath!, ["-c", okCmd], { stdio: "ignore" });
      assert.deepEqual(parseSentinel(await fsp.readFile(capOk, "utf8")), { exitCode: 0 });

      // The sidecar exit file is cleaned up and never leaks into the capture dir.
      const entries = await fsp.readdir(paths.captures);
      assert.ok(
        !entries.some((e) => e.endsWith(".exit")),
        `sidecar .exit file must be removed, saw: ${entries.join(", ")}`,
      );
    } finally {
      await cleanup();
    }
  });
}

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

test("jobArgv resolves the default agent's command with no --dir", () => {
  const config = defaultDispatchConfig();
  config.repoPath = "/repo";
  config.agents = [
    { name: "cc", command: "cc {prompt}" },
    { name: "ccw", command: "ccw {prompt}" },
  ];
  config.defaultAgent = "cc";
  // Bare (no override) → the default agent, and NO --dir flag.
  assert.deepEqual(jobArgv(config, "build X"), ["cc", "build X"]);
});

test("jobArgv honors a named-agent override", () => {
  const config = defaultDispatchConfig();
  config.repoPath = "/repo";
  config.agents = [
    { name: "cc", command: "cc {prompt}" },
    { name: "ccw", command: "ccw {prompt}" },
  ];
  config.defaultAgent = "cc";
  // `confirm ccw` selects the work wrapper for this dispatch.
  assert.deepEqual(jobArgv(config, "build X", "ccw"), ["ccw", "build X"]);
});

test("fallback launch runs a fake echo agent and produces a captured sentinel", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    // Fake agent: print a marker and the order, then exit 0. No tokens, no network.
    config.agents = [{ name: "fake", command: `sh -c 'echo AGENT-RAN; echo "order={prompt}"'` }];
    config.defaultAgent = "fake";
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

test("fallback runs the crew process with cwd = repo path (no --dir)", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config = defaultDispatchConfig();
    // The repo IS the instance root here; the agent prints its own working dir.
    config.repoPath = paths.root;
    config.agents = [{ name: "fake", command: `sh -c 'pwd'` }];
    config.defaultAgent = "fake";
    await launchFallback({ paths, config, jobId: "job-cwd", order: "x" });
    const captured = await waitForSentinel(paths.captureFile("job-cwd"));
    // macOS resolves /var → /private/var etc., so compare the real paths.
    const realRepo = await fsp.realpath(paths.root);
    const printed = captured.split("\n").map((l) => l.trim());
    assert.ok(
      printed.includes(realRepo) || printed.includes(paths.root),
      `crew cwd should be the repo path.\n  want: ${realRepo}\n  got:\n${captured}`,
    );
  } finally {
    await cleanup();
  }
});

test("fallback captures a nonzero exit code in the sentinel", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    config.agents = [{ name: "fake", command: `sh -c 'echo boom; exit 3'` }];
    config.defaultAgent = "fake";
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
