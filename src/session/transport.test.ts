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
  buildJobScript,
  scrubCapture,
  composeSplitScript,
  composeCloseScript,
  osaEscape,
  jobCommandLine,
  launchGhostty,
  anchorExists,
  setOsaRunnerForTest,
  PaneUnavailableError,
  dispatchCorrelation,
  readPaneIdentity,
} from "./transport.js";

/**
 * Tests for the ONE transport: a visible Ghostty pane. The AppleScript and
 * job-script composition are pure and tested directly; the per-job script is
 * exercised end-to-end with a fake echo agent (a shell command, no tokens spent)
 * so the capture-file + sentinel contract is verified for real. The Ghostty
 * launch itself is tested with a stubbed osascript runner — a live GUI launch can
 * only be verified by hand. There is no background/headless transport to test:
 * when a pane can't be placed the dispatch fails cleanly (see registry.test.ts).
 */

async function tmpInstance(): Promise<{ paths: ReturnType<typeof instancePaths>; cleanup: () => Promise<void> }> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "co-transport-"));
  const paths = instancePaths(home, "inst");
  await fsp.mkdir(paths.captures, { recursive: true });
  return { paths, cleanup: () => fsp.rm(home, { recursive: true, force: true }) };
}

test("sentinel round-trips through the capture text", () => {
  assert.equal(parseSentinel("no marker here"), null);
  assert.deepEqual(parseSentinel(`output\n${sentinelLine(0)}\n`), { exitCode: 0 });
  assert.deepEqual(parseSentinel(`${sentinelLine(2)}`), { exitCode: 2 });
  // A garbled code degrades to -1 rather than NaN.
  assert.deepEqual(parseSentinel(`${SENTINEL_PREFIX} notanumber`), { exitCode: -1 });
});

test("osaEscape escapes backslashes and quotes for an AppleScript literal", () => {
  assert.equal(osaEscape('a"b'), 'a\\"b');
  assert.equal(osaEscape("a\\b"), "a\\\\b");
});

test("composeSplitScript launches a split via surface configuration, nothing typed", () => {
  const script = composeSplitScript({
    decision: { kind: "split", target: "term-A", direction: "down" },
    launchCommand: "/bin/sh '/tmp/job.sh' hold",
  });
  // Verified against Ghostty.sdef (1.3) and live 1.3.1: `split <terminal>
  // direction <dir> with configuration {command:"..."}` creates the pane
  // already running the command on a real tty. No keystrokes are involved, so
  // a fresh split can never deliver the job into the wrong program.
  assert.ok(script.includes('first terminal whose id = "term-A"'));
  assert.ok(
    script.includes(`split target direction down with configuration {command:"/bin/sh '/tmp/job.sh' hold"}`),
    `split must launch the job as the pane's command, got:\n${script}`,
  );
  assert.ok(script.includes("return (id of newTerm as text)"));
  assert.ok(!script.includes("input text"), "a split must not paste anything");
  assert.ok(!script.includes("send key"), "a split must not send keys");
});

test("composeSplitScript for a takeover pastes ONLY the one-line launch, no split", () => {
  const script = composeSplitScript({
    decision: { kind: "takeover", paneId: "anchor-1" },
    launchCommand: "/bin/sh '/tmp/job.sh'",
  });
  assert.ok(!script.includes("split "), "a takeover must not split");
  assert.ok(script.includes('first terminal whose id = "anchor-1"'));
  assert.ok(
    script.includes(`input text "/bin/sh '/tmp/job.sh'" to target`),
    "the pasted text is the short launch line, never the job itself",
  );
  assert.ok(script.includes('send key "enter" to target'));
});

test("composeCloseScript targets the terminal by id", () => {
  const script = composeCloseScript("pane-9");
  assert.ok(script.includes('close (first terminal whose id = "pane-9")'));
});

test("buildJobScript pins PATH, runs the crew bare on the pane tty, holds only when asked", () => {
  const text = buildJobScript({
    crewCommand: "claude 'line one\nline two'",
    captureFile: "/caps/j1.log",
    scriptPath: "/caps/j1.log.sh",
    cwd: "/repo",
    pathEnv: "/usr/bin:/me/.local/bin",
  });
  assert.ok(
    text.includes("PATH='/usr/bin:/me/.local/bin'; export PATH"),
    "the co process's PATH is baked in (a command-launched surface gets only the bare GUI PATH)",
  );
  assert.ok(text.includes("cd '/repo' ||"), "cd fails loudly");
  assert.ok(text.includes("\nclaude 'line one\nline two'\n"), "the multi-line order lives in the file verbatim");
  assert.ok(
    !text.includes("script -q") && !text.includes("| tee"),
    "NOTHING is interposed between the crew and the pane tty — no recorder, no pipe",
  );
  assert.ok(text.includes("trap : INT"), "Ctrl-C is left to the crew; the wrapper survives to report");
  assert.ok(text.includes("finish 129; exit 129' HUP"), "a closed pane still writes the sentinel");
  assert.ok(text.includes(SENTINEL_PREFIX), "sentinel is appended after the run");
  assert.ok(text.includes(`if [ "$1" = hold ]`), "hold branch exists");
  assert.ok(text.includes('exec "${SHELL:-/bin/zsh}" -l'), "hold keeps the pane open as a shell");
  // The correlation the Stop hook reads from its inherited environment, derived
  // from the capture file so the hook finds this exact capture.
  assert.ok(
    text.includes("CO_DISPATCH_JOB='j1'; export CO_DISPATCH_JOB"),
    "the job stem is exported for the Stop hook",
  );
  assert.ok(
    text.includes("CO_DISPATCH_CAPTURE_DIR='/caps'; export CO_DISPATCH_CAPTURE_DIR"),
    "the captures dir is exported for the Stop hook",
  );
});

test("dispatchCorrelation derives the job stem and dir from the capture file", () => {
  assert.deepEqual(dispatchCorrelation("/caps/job-001-abc.log"), {
    job: "job-001-abc",
    captureDir: "/caps",
  });
  // A space in the path is preserved (the exports single-quote it).
  assert.deepEqual(dispatchCorrelation("/my caps/job-002.log"), {
    job: "job-002",
    captureDir: "/my caps",
  });
});

/** Write a job script for a fake crew command and return its paths. */
async function writeJobScript(
  paths: ReturnType<typeof instancePaths>,
  jobId: string,
  crewTemplate: string,
  order: string,
): Promise<{ captureFile: string; scriptPath: string }> {
  const config = defaultDispatchConfig();
  config.repoPath = paths.root;
  config.agents = [{ name: "fake", command: crewTemplate }];
  config.defaultAgent = "fake";
  const captureFile = paths.captureFile(jobId);
  const scriptPath = `${captureFile}.sh`;
  await fsp.writeFile(
    scriptPath,
    buildJobScript({
      crewCommand: jobCommandLine(config, order),
      captureFile,
      scriptPath,
      cwd: paths.root,
      pathEnv: process.env.PATH ?? "",
    }),
    "utf8",
  );
  return { captureFile, scriptPath };
}

test("job script end-to-end: order intact, sentinel code, self-cleanup", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const order = "line one\nit's got an apostrophe\nline two";
    const { captureFile, scriptPath } = await writeJobScript(
      paths,
      "job-script",
      `sh -c 'echo "order=$1"; exit 4' _ {prompt}`,
      order,
    );
    execFileSync("/bin/sh", [scriptPath], { stdio: "ignore" });
    const captured = await fsp.readFile(captureFile, "utf8");
    assert.deepEqual(parseSentinel(captured), { exitCode: 4 }, "sentinel carries the crew's real exit code");
    const entries = await fsp.readdir(paths.captures);
    assert.ok(!entries.some((e) => e.endsWith(".sh")), "the job script removes itself");
  } finally {
    await cleanup();
  }
});

test("job script reports the pane's identity (tty + the pid that outlives the job)", async () => {
  // Ghostty's API cannot tell co what tty a pane is on, so the launch script is
  // the only thing that can — and pane reuse is impossible without it. Run the
  // real script and read the sidecar back through the real parser.
  const { paths, cleanup } = await tmpInstance();
  try {
    const { captureFile, scriptPath } = await writeJobScript(paths, "job-tty", `sh -c 'true'`, "x");
    // No `hold`: the takeover/reuse shape, where the pane's own shell is our
    // PARENT and is the process that will still be there when the job is done.
    execFileSync("/bin/sh", [scriptPath], { stdio: "ignore" });
    const identity = await readPaneIdentity(captureFile);
    assert.equal(
      identity.shellPid,
      process.pid,
      "without hold the recorded pid is the launching shell — here, this test process",
    );
    // stdio is ignored above, so there is no tty to report; the field is simply
    // absent, which reads downstream as "this pane can't be proven idle".
    const raw = await fsp.readFile(`${captureFile}.tty`, "utf8");
    assert.match(raw, /^tty=/m, "the sidecar always carries a tty line, empty or not");
    assert.match(raw, new RegExp(`^pid=${process.pid}$`, "m"));
  } finally {
    await cleanup();
  }
});

test("readPaneIdentity is tolerant: a missing or junk sidecar is an empty identity", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const capture = paths.captureFile("job-none");
    assert.deepEqual(await readPaneIdentity(capture), {}, "no sidecar at all");
    await fsp.writeFile(`${capture}.tty`, "tty=not a device\npid=0\n", "utf8");
    assert.deepEqual(await readPaneIdentity(capture), {}, "junk fields are dropped, not trusted");
    await fsp.writeFile(`${capture}.tty`, "tty=/dev/ttys004\npid=4242\n", "utf8");
    assert.deepEqual(await readPaneIdentity(capture), { tty: "ttys004", shellPid: 4242 });
  } finally {
    await cleanup();
  }
});

test("job script survives Ctrl-C (SIGINT to the process group) and still writes the sentinel", async () => {
  // Quitting an interactive agent with Ctrl-C sends SIGINT to the pane's whole
  // foreground group — the wrapper sh included. The trap must keep the wrapper
  // alive so the completion sentinel is still written with the crew's real
  // code; without it, Ctrl-C'd jobs never report back (the live defect).
  const { paths, cleanup } = await tmpInstance();
  try {
    const { captureFile, scriptPath } = await writeJobScript(
      paths,
      "job-int",
      // A "crew" that idles like an interactive agent until killed.
      `sh -c 'sleep 30'`,
      "x",
    );
    const { spawn } = await import("node:child_process");
    const child = spawn("/bin/sh", [scriptPath], { stdio: "ignore", detached: true });
    await new Promise((r) => setTimeout(r, 400));
    process.kill(-child.pid!, "SIGINT"); // the whole group, like a terminal does
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    const captured = await fsp.readFile(captureFile, "utf8");
    const sentinel = parseSentinel(captured);
    assert.ok(sentinel, `sentinel must still be written after group SIGINT, capture:\n${captured}`);
    assert.equal(sentinel!.exitCode, 130, "reports the crew's real code (128+SIGINT)");
  } finally {
    await cleanup();
  }
});

test("job script writes the sentinel even when the pane is torn down (SIGHUP)", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const { captureFile, scriptPath } = await writeJobScript(paths, "job-hup", `sh -c 'sleep 30'`, "x");
    const { spawn } = await import("node:child_process");
    const child = spawn("/bin/sh", [scriptPath], { stdio: "ignore", detached: true });
    await new Promise((r) => setTimeout(r, 400));
    process.kill(-child.pid!, "SIGHUP"); // closing a pane HUPs its process group
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    const captured = await fsp.readFile(captureFile, "utf8");
    assert.deepEqual(parseSentinel(captured), { exitCode: 129 }, "a closed pane still reports completion");
  } finally {
    await cleanup();
  }
});

test("scrubCapture strips terminal noise and resolves overwrites for review", () => {
  assert.equal(scrubCapture("a \x1b[31mred\x1b[0m z"), "a red z");
  assert.equal(scrubCapture("progress 1%\rprogress 99%\r\ndone"), "progress 99%\ndone");
  assert.equal(scrubCapture("\x1b]0;window title\x07body"), "body");
  assert.equal(scrubCapture("a\n\n\n\n\nb"), "a\n\nb");
  const sentinel = `${SENTINEL_PREFIX} 3`;
  assert.ok(scrubCapture(`\x1b[2Jnoise\r\n${sentinel}\n`).includes(sentinel), "the sentinel line survives scrubbing");
});

test("jobCommandLine resolves the default agent's command with no --dir", () => {
  const config = defaultDispatchConfig();
  config.repoPath = "/repo";
  config.agents = [
    { name: "cc", command: "claude {prompt}" },
    { name: "ccw", command: `CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude {prompt}` },
  ];
  config.defaultAgent = "cc";
  // Bare (no override) → the default agent, order shell-quoted, NO --dir flag.
  assert.equal(jobCommandLine(config, "build X"), "claude 'build X'");
});

test("jobCommandLine honors a named-agent override and preserves an env prefix", () => {
  const config = defaultDispatchConfig();
  config.repoPath = "/repo";
  config.agents = [
    { name: "cc", command: "claude {prompt}" },
    { name: "ccw", command: `CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude {prompt}` },
  ];
  config.defaultAgent = "cc";
  // `confirm ccw` selects the work wrapper; its env prefix survives for the shell.
  assert.equal(
    jobCommandLine(config, "build X", "ccw"),
    `CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude 'build X'`,
  );
});

test("launchGhostty consults the planner, probes the launch, and commits the pane id", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    const layout = new CrewPaneLayout({ id: "anchor-1", title: crewPaneTitle("inst") }, config.pane);

    const scripts: string[] = [];
    // Stub osascript: it also plays the launched job's first act — creating the
    // capture file — which is what the transport's launch probe waits for.
    const stubLaunch = (jobId: string) => async (script: string): Promise<string> => {
      scripts.push(script);
      await fsp.writeFile(paths.captureFile(jobId), "", "utf8");
      return script.includes("split ") ? "pane-new" : "anchor-1";
    };

    setOsaRunnerForTest(stubLaunch("j1"));
    // anchorUnproven: co has never run a job in this anchor, which is the one
    // case where it may still be taken over without proof (see crewpanes.ts).
    const first = await launchGhostty({
      paths,
      config,
      layout,
      jobId: "j1",
      order: "one",
      placement: { anchorUnproven: true },
    });
    assert.equal(first.paneId, "anchor-1");
    assert.equal(first.placement?.kind, "takeover");
    assert.equal(layout.paneCount, 1);
    // The takeover pasted only the short script launch; the order text (and the
    // job script path's quoting) never rides the keystroke stream.
    assert.ok(scripts[0]!.includes("input text \"/bin/sh '"), "takeover pastes the one-line launch");
    assert.ok(!scripts[0]!.includes("one"), "the order text is not in the AppleScript");

    setOsaRunnerForTest(stubLaunch("j2"));
    const second = await launchGhostty({ paths, config, layout, jobId: "j2", order: "two" });
    assert.equal(second.placement?.kind, "split");
    assert.equal(second.paneId, "pane-new");
    assert.equal(layout.paneCount, 2);
    assert.ok(
      scripts[1]!.includes("with configuration {command:"),
      "a split launches the job script as the new pane's command",
    );
    assert.ok(scripts[1]!.includes(" hold\"}"), "a split-born pane holds (execs a shell) after the job");
  } finally {
    setOsaRunnerForTest(null);
    await cleanup();
  }
});

test("launchGhostty degrades when a busy pane never starts the job (paste went nowhere)", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    const layout = new CrewPaneLayout({ id: "anchor-1", title: crewPaneTitle("inst") }, config.pane);
    // The paste "succeeds" (osascript is happy) but whatever owns the pane —
    // an editor, another agent — swallowed the line: no capture file appears.
    setOsaRunnerForTest(async () => "anchor-1");
    const err = await launchGhostty({
      paths,
      config,
      layout,
      jobId: "busy",
      order: "x",
      placement: { anchorUnproven: true },
      paneStartTimeoutMs: 300,
    }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof PaneUnavailableError, `expected PaneUnavailableError, got ${err}`);
    assert.match(err.message, /never started/);
    // NOT orphaned: this pane was handed to us (the anchor) and is still there —
    // it's busy, not dead-and-reaped. The registry's existing prune/anchor-loss
    // handling must still apply to it.
    assert.equal(err.orphaned, false, "a busy takeover pane is not an orphan");
    assert.equal(layout.paneCount, 0, "the failed plan is aborted");
    const entries = await fsp.readdir(paths.captures);
    assert.deepEqual(entries, [], "no capture and no orphaned job script left behind");
  } finally {
    setOsaRunnerForTest(null);
    await cleanup();
  }
});

test("launchGhostty reaps a split it created when the job never starts in it", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    const layout = new CrewPaneLayout({ id: "anchor-1", title: crewPaneTitle("inst") }, config.pane);
    // Seed one committed pane so the next plan() is a split.
    layout.plan();
    layout.commit("anchor-1");

    const closes: string[] = [];
    setOsaRunnerForTest(async (script) => {
      if (script.includes("close ")) {
        closes.push(script);
        return "";
      }
      return "pane-new"; // the split is created, but its command never runs
    });
    const err = await launchGhostty({
      paths,
      config,
      layout,
      jobId: "deadsplit",
      order: "x",
      paneStartTimeoutMs: 300,
    }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof PaneUnavailableError, `expected PaneUnavailableError, got ${err}`);
    assert.equal(layout.paneCount, 1, "only the pre-existing pane remains");
    assert.equal(closes.length, 1, "the stray split pane is closed");
    assert.ok(closes[0]!.includes('id = "pane-new"'), "closes the pane the split returned");
    // The id it carries names a pane we CREATED and have already reaped, not a
    // tracked pane that died. Flagging it keeps the registry from reading a
    // healthy layout as a broken link (see the orphan path in registry.ts).
    assert.equal(err.orphaned, true, "a reaped split-we-created is reported as orphaned");
    assert.equal(err.paneId, "pane-new", "and names that pane, not the split origin");
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
    await assert.rejects(() =>
      launchGhostty({
        paths,
        config,
        layout,
        jobId: "j1",
        order: "x",
        placement: { anchorUnproven: true },
      }),
    );
    // The failed plan must be aborted so the next dispatch re-offers the anchor.
    assert.equal(layout.paneCount, 0);
    assert.deepEqual(layout.plan({ anchorUnproven: true }), { kind: "takeover", paneId: "anchor-1" });
  } finally {
    setOsaRunnerForTest(null);
    await cleanup();
  }
});

test("launchGhostty raises PaneUnavailableError (with the target id) on a stale pane", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = paths.root;
    const layout = new CrewPaneLayout({ id: "ghostty-uuid", title: crewPaneTitle("inst") }, config.pane);
    // Reproduce the live -1719: Ghostty can't resolve the stored terminal id.
    setOsaRunnerForTest(async () => {
      throw new Error(
        'Ghostty got an error: Can\'t get terminal 1 whose id = "ghostty-uuid". Invalid index. (-1719)',
      );
    });
    const err = await launchGhostty({ paths, config, layout, jobId: "j1", order: "x" }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof PaneUnavailableError, `expected PaneUnavailableError, got ${err}`);
    assert.equal(err.paneId, "ghostty-uuid", "carries the id we tried to target, for the fallback note");
    assert.match(err.message, /-1719/, "wraps the underlying Ghostty error");
    // No empty capture is left behind: the fallback owns the capture on this path.
    await assert.rejects(() => fsp.readFile(paths.captureFile("j1"), "utf8"));
  } finally {
    setOsaRunnerForTest(null);
    await cleanup();
  }
});

test("jobCommandLine resolves {repo} to the cwd override when one is given", () => {
  const config = defaultDispatchConfig();
  config.repoPath = "/repo";
  config.agents = [{ name: "cc", command: "agent --root {repo} {prompt}" }];
  config.defaultAgent = "cc";
  assert.equal(jobCommandLine(config, "x"), "agent --root '/repo' 'x'");
  // A feature-scoped dispatch launches in the worktree; a {repo} reference in
  // the template must agree with that launch directory.
  assert.equal(jobCommandLine(config, "x", undefined, "/wt/auth"), "agent --root '/wt/auth' 'x'");
});

test("launchGhostty bakes a cwd override into the job script instead of the repo", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const config = defaultDispatchConfig();
    config.repoPath = "/linked/repo";
    const layout = new CrewPaneLayout({ id: "anchor-1", title: crewPaneTitle("inst") }, config.pane);
    // Stub osascript, playing the launched job's first act (the capture file)
    // so the transport's launch probe passes.
    setOsaRunnerForTest(async (script) => {
      const m = script.match(/\/bin\/sh '([^']+)\.sh'/);
      if (m) await fsp.writeFile(m[1]!, "", "utf8");
      return "anchor-1";
    });
    const res = await launchGhostty({ paths, config, layout, jobId: "jwt", order: "x", cwd: "/wt/auth" });
    assert.equal(res.paneId, "anchor-1");
    const script = await fsp.readFile(`${paths.captureFile("jwt")}.sh`, "utf8");
    assert.ok(script.includes("cd '/wt/auth' ||"), "the job script cd's into the worktree");
    assert.ok(!script.includes("'/linked/repo'"), "the linked repo path appears nowhere in the job");
  } finally {
    setOsaRunnerForTest(null);
    await cleanup();
  }
});

