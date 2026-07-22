import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { instancePaths } from "../paths.js";
import {
  resolveArgv,
  resolveAgent,
  resolveAgentCommand,
  tokenizeTemplate,
  shellQuote,
  stripDirFlag,
  displayCommand,
  readDispatchConfig,
  writeDispatchConfig,
  setAnchor,
  defaultDispatchConfig,
  isLinked,
  EXAMPLE_AGENTS,
} from "./dispatchconfig.js";

/**
 * Tests for dispatch config persistence and command-template resolution. The
 * template layer is the one place a mistake becomes a shell-injection or a
 * dropped argument, so quoting and placeholder substitution are exercised
 * directly, including an order that contains newlines and shell metacharacters.
 */

async function makeInstance(): Promise<{ home: string; name: string; cleanup: () => Promise<void> }> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "co-dispatch-"));
  const name = "test-instance";
  return { home, name, cleanup: () => fsp.rm(home, { recursive: true, force: true }) };
}

test("tokenizeTemplate splits on whitespace and honors quotes in the template", () => {
  assert.deepEqual(tokenizeTemplate("cc {prompt}"), ["cc", "{prompt}"]);
  assert.deepEqual(tokenizeTemplate(`agent --flag "a b c" {prompt}`), [
    "agent",
    "--flag",
    "a b c",
    "{prompt}",
  ]);
});

test("resolveArgv substitutes placeholders as single argv elements", () => {
  const argv = resolveArgv("cc {prompt}", {
    prompt: "do the thing",
    repo: "/x/y",
  });
  // {prompt} stays ONE element even though its value has spaces — critical, or
  // the agent would see "do", "the", "thing" as separate args. No --dir: the
  // repo is supplied as the process cwd, not a flag.
  assert.deepEqual(argv, ["cc", "do the thing"]);
});

test("resolveArgv keeps a multi-line order intact in one element", () => {
  const order = "line one\nline two\n$(evil) `also`";
  const argv = resolveArgv("agent {prompt}", { prompt: order, repo: "/r" });
  assert.equal(argv.length, 2);
  assert.equal(argv[1], order); // verbatim, not word-split, not expanded
});

test("shellQuote wraps and escapes single quotes so metacharacters are inert", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  // A shell metacharacter string is fully contained by the quotes.
  assert.equal(shellQuote("$(rm -rf /)"), "'$(rm -rf /)'");
  // Newlines survive inside single quotes.
  assert.equal(shellQuote("a\nb"), "'a\nb'");
});

test("displayCommand renders {prompt} as a compact marker, not the whole order", () => {
  const shown = displayCommand("cc {prompt}", "/repo");
  assert.equal(shown, "cc <order>");
});

test("example agents cover cc/ccw, use {prompt}, and carry no --dir flag", () => {
  const names = EXAMPLE_AGENTS.map((a) => a.name);
  assert.ok(names.includes("cc"), "ships the personal Claude Code wrapper");
  assert.ok(names.includes("ccw"), "ships the work Claude Code wrapper");
  for (const a of EXAMPLE_AGENTS) {
    assert.ok(a.command.includes("{prompt}"), `${a.name} command lacks {prompt}`);
    assert.ok(!/--dir\b/.test(a.command), `${a.name} command must not pass --dir`);
    assert.ok(!/--add-dir\b/.test(a.command), `${a.name} command must not pass --add-dir`);
  }
});

test("stripDirFlag removes a legacy --dir {repo} but keeps {prompt}", () => {
  assert.equal(stripDirFlag("claude --dir {repo} {prompt}"), "claude {prompt}");
  assert.equal(stripDirFlag("opencode run --dir {repo} {prompt}"), "opencode run {prompt}");
  assert.equal(stripDirFlag("claude --add-dir {repo} {prompt}"), "claude {prompt}");
  // No dir flag: unchanged.
  assert.equal(stripDirFlag("cc {prompt}"), "cc {prompt}");
});

test("resolveAgent picks the named override, else the default, else the first", () => {
  const config = defaultDispatchConfig();
  config.agents = [
    { name: "cc", command: "cc {prompt}" },
    { name: "ccw", command: "ccw {prompt}" },
  ];
  config.defaultAgent = "cc";
  // Named override.
  assert.equal(resolveAgent(config, "ccw")?.name, "ccw");
  assert.equal(resolveAgentCommand(config, "ccw"), "ccw {prompt}");
  // Bare confirm → default.
  assert.equal(resolveAgent(config)?.name, "cc");
  assert.equal(resolveAgentCommand(config), "cc {prompt}");
  // Unknown name → null (the confirm interlock surfaces valid names).
  assert.equal(resolveAgent(config, "nope"), null);
  // A default that no longer resolves falls back to the first agent.
  config.defaultAgent = "gone";
  assert.equal(resolveAgent(config)?.name, "cc");
});

test("dispatch config round-trips through disk", async () => {
  const { home, name, cleanup } = await makeInstance();
  try {
    const paths = instancePaths(home, name);
    assert.equal(isLinked(paths), false);
    assert.equal(await readDispatchConfig(paths), null);

    const config = defaultDispatchConfig();
    config.repoPath = "/some/repo";
    config.agents = [
      { name: "cc", command: "cc {prompt}" },
      { name: "ccw", command: "ccw {prompt}" },
    ];
    config.defaultAgent = "ccw";
    config.caps = { timeoutSec: 900, turnLimit: 40 };
    await writeDispatchConfig(paths, config);

    assert.equal(isLinked(paths), true);
    const read = await readDispatchConfig(paths);
    assert.equal(read?.repoPath, "/some/repo");
    assert.deepEqual(read?.agents, [
      { name: "cc", command: "cc {prompt}" },
      { name: "ccw", command: "ccw {prompt}" },
    ]);
    assert.equal(read?.defaultAgent, "ccw");
    assert.equal(read?.caps.timeoutSec, 900);
    assert.equal(read?.caps.turnLimit, 40);
    assert.deepEqual(read?.pane.directionSequence, ["right", "down"]);
    assert.equal(read?.pane.cap, 4);
    assert.equal(read?.anchor, null);
  } finally {
    await cleanup();
  }
});

test("setAnchor persists just the anchor, preserving the rest", async () => {
  const { home, name, cleanup } = await makeInstance();
  try {
    const paths = instancePaths(home, name);
    const config = defaultDispatchConfig();
    config.repoPath = "/r";
    await writeDispatchConfig(paths, config);

    await setAnchor(paths, { id: "pane-42", title: "co-crew:test-instance" });
    const read = await readDispatchConfig(paths);
    assert.deepEqual(read?.anchor, { id: "pane-42", title: "co-crew:test-instance" });
    assert.equal(read?.repoPath, "/r", "anchor write must not clobber repoPath");
  } finally {
    await cleanup();
  }
});

test("a corrupt config reads as unlinked rather than throwing", async () => {
  const { home, name, cleanup } = await makeInstance();
  try {
    const paths = instancePaths(home, name);
    await fsp.mkdir(paths.dispatch, { recursive: true });
    await fsp.writeFile(paths.dispatchConfig, "{ not json", "utf8");
    assert.equal(await readDispatchConfig(paths), null);
  } finally {
    await cleanup();
  }
});

test("coerce fills defaults for a partial/hand-edited config", async () => {
  const { home, name, cleanup } = await makeInstance();
  try {
    const paths = instancePaths(home, name);
    await fsp.mkdir(paths.dispatch, { recursive: true });
    // Only a repo path; everything else should default.
    await fsp.writeFile(paths.dispatchConfig, JSON.stringify({ repoPath: "/r" }), "utf8");
    const read = await readDispatchConfig(paths);
    assert.equal(read?.repoPath, "/r");
    assert.deepEqual(read?.agents, EXAMPLE_AGENTS);
    assert.equal(read?.defaultAgent, EXAMPLE_AGENTS[0]!.name);
    assert.deepEqual(read?.pane.directionSequence, ["right", "down"]);
    assert.equal(read?.pane.cap, 4);
  } finally {
    await cleanup();
  }
});

test("a legacy commandTemplate config migrates to a single agent with --dir stripped", async () => {
  const { home, name, cleanup } = await makeInstance();
  try {
    const paths = instancePaths(home, name);
    await fsp.mkdir(paths.dispatch, { recursive: true });
    // The old shape a live dispatch failed on: `claude --dir <repo> <order>`.
    await fsp.writeFile(
      paths.dispatchConfig,
      JSON.stringify({ repoPath: "/r", commandTemplate: "claude --dir {repo} {prompt}" }),
      "utf8",
    );
    const read = await readDispatchConfig(paths);
    assert.deepEqual(read?.agents, [{ name: "default", command: "claude {prompt}" }]);
    assert.equal(read?.defaultAgent, "default");
    // The migrated command carries no --dir.
    assert.ok(!/--dir\b/.test(read!.agents[0]!.command));
  } finally {
    await cleanup();
  }
});

test("coerce honors a stored defaultAgent only when it names a real agent", async () => {
  const { home, name, cleanup } = await makeInstance();
  try {
    const paths = instancePaths(home, name);
    await fsp.mkdir(paths.dispatch, { recursive: true });
    await fsp.writeFile(
      paths.dispatchConfig,
      JSON.stringify({
        repoPath: "/r",
        agents: [
          { name: "cc", command: "cc {prompt}" },
          { name: "ccw", command: "ccw {prompt}" },
        ],
        defaultAgent: "bogus",
      }),
      "utf8",
    );
    const read = await readDispatchConfig(paths);
    // Bogus default falls back to the first agent, not a crash.
    assert.equal(read?.defaultAgent, "cc");
  } finally {
    await cleanup();
  }
});
