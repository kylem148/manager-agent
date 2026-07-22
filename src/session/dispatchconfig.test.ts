import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { instancePaths } from "../paths.js";
import {
  resolveArgv,
  tokenizeTemplate,
  shellQuote,
  displayCommand,
  readDispatchConfig,
  writeDispatchConfig,
  setAnchor,
  defaultDispatchConfig,
  isLinked,
  EXAMPLE_TEMPLATES,
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
  assert.deepEqual(tokenizeTemplate("claude --dir {repo} {prompt}"), [
    "claude",
    "--dir",
    "{repo}",
    "{prompt}",
  ]);
  assert.deepEqual(tokenizeTemplate(`agent --flag "a b c" {prompt}`), [
    "agent",
    "--flag",
    "a b c",
    "{prompt}",
  ]);
});

test("resolveArgv substitutes placeholders as single argv elements", () => {
  const argv = resolveArgv("claude --dir {repo} {prompt}", {
    prompt: "do the thing",
    repo: "/x/y",
  });
  // {prompt} stays ONE element even though its value has spaces — critical, or
  // the agent would see "do", "the", "thing" as separate args.
  assert.deepEqual(argv, ["claude", "--dir", "/x/y", "do the thing"]);
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
  const shown = displayCommand("claude --dir {repo} {prompt}", "/repo");
  assert.equal(shown, "claude --dir /repo <order>");
});

test("example templates cover Claude Code and OpenCode and use both placeholders", () => {
  const labels = EXAMPLE_TEMPLATES.map((t) => t.label);
  assert.ok(labels.includes("Claude Code"));
  assert.ok(labels.includes("OpenCode"));
  for (const t of EXAMPLE_TEMPLATES) {
    assert.ok(t.template.includes("{prompt}"), `${t.label} template lacks {prompt}`);
    assert.ok(t.template.includes("{repo}"), `${t.label} template lacks {repo}`);
  }
});

test("dispatch config round-trips through disk", async () => {
  const { home, name, cleanup } = await makeInstance();
  try {
    const paths = instancePaths(home, name);
    assert.equal(isLinked(paths), false);
    assert.equal(await readDispatchConfig(paths), null);

    const config = defaultDispatchConfig();
    config.repoPath = "/some/repo";
    config.commandTemplate = "opencode run --dir {repo} {prompt}";
    config.caps = { timeoutSec: 900, turnLimit: 40 };
    await writeDispatchConfig(paths, config);

    assert.equal(isLinked(paths), true);
    const read = await readDispatchConfig(paths);
    assert.equal(read?.repoPath, "/some/repo");
    assert.equal(read?.commandTemplate, "opencode run --dir {repo} {prompt}");
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
    assert.equal(read?.commandTemplate, EXAMPLE_TEMPLATES[0]!.template);
    assert.deepEqual(read?.pane.directionSequence, ["right", "down"]);
    assert.equal(read?.pane.cap, 4);
  } finally {
    await cleanup();
  }
});
