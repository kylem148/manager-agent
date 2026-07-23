import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mergeStopHook, stopHookCommand, installCrewStopHook } from "./crewhook.js";

/**
 * Tests for installing the crew-completion Stop hook into a crew agent's config
 * dir. The two things that must hold: the merge is idempotent (re-running never
 * duplicates), and it never clobbers the user's other settings (their Bedrock
 * token, theme, and any OTHER hooks all survive).
 */

const NODE = "/usr/local/bin/node";
const SCRIPT = "/opt/co/dist/session/crewstophook.js";
const COMMAND = stopHookCommand(NODE, SCRIPT);

test("stopHookCommand single-quotes both paths so a space can't split the command", () => {
  const cmd = stopHookCommand("/Applications/My App/node", "/opt/co dist/crewstophook.js");
  assert.equal(cmd, "'/Applications/My App/node' '/opt/co dist/crewstophook.js'");
});

test("mergeStopHook adds a Stop group when none exists, preserving other settings", () => {
  const before = { env: { AWS_BEARER_TOKEN_BEDROCK: "secret" }, theme: "dark" };
  const { settings, changed } = mergeStopHook(before, COMMAND);
  assert.equal(changed, true);
  // Other keys survive untouched.
  assert.deepEqual((settings as { env: unknown }).env, { AWS_BEARER_TOKEN_BEDROCK: "secret" });
  assert.equal((settings as { theme: string }).theme, "dark");
  // The Stop hook was added.
  const stop = (settings as { hooks: { Stop: { hooks: { command: string }[] }[] } }).hooks.Stop;
  assert.equal(stop.length, 1);
  assert.equal(stop[0]!.hooks[0]!.command, COMMAND);
});

test("mergeStopHook is idempotent: the exact same hook is a no-op the second time", () => {
  const first = mergeStopHook({}, COMMAND);
  assert.equal(first.changed, true);
  const second = mergeStopHook(first.settings, COMMAND);
  assert.equal(second.changed, false, "no change when the hook is already present");
  // And still exactly one hook, not two.
  const stop = (second.settings as { hooks: { Stop: { hooks: unknown[] }[] } }).hooks.Stop;
  assert.equal(stop.length, 1);
  assert.equal(stop[0]!.hooks.length, 1);
});

test("mergeStopHook heals a moved runtime path in place, never duplicating", () => {
  const old = mergeStopHook({}, stopHookCommand(NODE, "/old/path/crewstophook.js"));
  const healed = mergeStopHook(old.settings, stopHookCommand(NODE, "/new/path/crewstophook.js"));
  assert.equal(healed.changed, true);
  const stop = (healed.settings as { hooks: { Stop: { hooks: { command: string }[] }[] } }).hooks.Stop;
  assert.equal(stop.length, 1, "still one group");
  assert.equal(stop[0]!.hooks.length, 1, "still one hook, healed not duplicated");
  assert.ok(stop[0]!.hooks[0]!.command.includes("/new/path/"));
});

test("mergeStopHook preserves the user's OTHER Stop hooks and does not mutate the input", () => {
  const before = {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "my-own-notifier.sh" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] }],
    },
  };
  const beforeSnapshot = JSON.stringify(before);
  const { settings, changed } = mergeStopHook(before, COMMAND);
  assert.equal(changed, true);
  // Input object was not mutated (clone-based).
  assert.equal(JSON.stringify(before), beforeSnapshot, "input settings untouched");
  const hooks = (settings as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks;
  // The user's own Stop hook survives, ours is added alongside it.
  const stopCommands = hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(stopCommands.includes("my-own-notifier.sh"), "user's own Stop hook preserved");
  assert.ok(stopCommands.includes(COMMAND), "our hook added");
  // A completely unrelated event survives.
  assert.equal(hooks.PreToolUse[0]!.hooks[0]!.command, "audit.sh");
});

test("installCrewStopHook writes settings.json, then a second run is a no-op (idempotent on disk)", async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "co-crewhook-"));
  try {
    // A `cc`-style agent (no env prefix) uses ~/.claude.
    const args = { agentCommand: "claude {prompt}", scriptPath: SCRIPT, nodePath: NODE, home };
    const first = await installCrewStopHook(args);
    assert.equal(first.changed, true);
    assert.equal(first.error, undefined);
    assert.equal(first.configDir, path.join(home, ".claude"));

    const settingsFile = path.join(home, ".claude", "settings.json");
    const afterFirst = await fsp.readFile(settingsFile, "utf8");

    // Run it again: no change, and the file is byte-identical (no duplication).
    const second = await installCrewStopHook(args);
    assert.equal(second.changed, false, "second install is a no-op");
    const afterSecond = await fsp.readFile(settingsFile, "utf8");
    assert.equal(afterSecond, afterFirst, "settings.json unchanged on the second run");

    // Exactly one Stop hook on disk.
    const parsed = JSON.parse(afterSecond) as { hooks: { Stop: { hooks: unknown[] }[] } };
    assert.equal(parsed.hooks.Stop.length, 1);
    assert.equal(parsed.hooks.Stop[0]!.hooks.length, 1);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test("installCrewStopHook merges into an existing settings.json without losing config", async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "co-crewhook-"));
  try {
    const configDir = path.join(home, ".claude-work");
    await fsp.mkdir(configDir, { recursive: true });
    // A real-shaped config: a secret token plus permissions the user cares about.
    const existing = {
      env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_BEARER_TOKEN_BEDROCK: "super-secret" },
      permissions: { allow: ["Bash"] },
      theme: "dark",
    };
    await fsp.writeFile(path.join(configDir, "settings.json"), JSON.stringify(existing, null, 2));

    // A `ccw`-style agent points at ~/.claude-work.
    const res = await installCrewStopHook({
      agentCommand: `CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude {prompt}`,
      scriptPath: SCRIPT,
      nodePath: NODE,
      home,
    });
    assert.equal(res.changed, true);
    assert.equal(res.configDir, configDir);

    const parsed = JSON.parse(await fsp.readFile(path.join(configDir, "settings.json"), "utf8")) as {
      env: Record<string, string>;
      permissions: unknown;
      theme: string;
      hooks: { Stop: unknown[] };
    };
    assert.equal(parsed.env.AWS_BEARER_TOKEN_BEDROCK, "super-secret", "token preserved");
    assert.deepEqual(parsed.permissions, { allow: ["Bash"] }, "permissions preserved");
    assert.equal(parsed.theme, "dark");
    assert.equal(parsed.hooks.Stop.length, 1, "our hook installed alongside");
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test("stopHookScriptPath resolves into dist/ even when running from src (tsx dev)", async () => {
  // This test itself runs under tsx from src/, so it exercises the dev-run case
  // directly: the resolved command must point at the BUILT hook under dist/,
  // never at a src/session/crewstophook.js that does not exist. Without the
  // dist anchoring, a dev-linked session would write that dead command into the
  // user's real settings.json.
  const { stopHookScriptPath } = await import("./crewhook.js");
  const p = stopHookScriptPath();
  assert.ok(
    p.endsWith(path.join("dist", "session", "crewstophook.js")),
    `must resolve the built hook under dist/, got: ${p}`,
  );
  assert.ok(!p.includes(`${path.sep}src${path.sep}`), `must not point into src/, got: ${p}`);
});

test("installCrewStopHook skips non-Claude agents without touching any config", async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "co-crewhook-"));
  try {
    const res = await installCrewStopHook({
      agentCommand: "opencode run {prompt}",
      scriptPath: SCRIPT,
      nodePath: NODE,
      home,
    });
    assert.equal(res.changed, false, "nothing installed for a non-Claude crew");
    assert.equal(res.error, undefined, "a skip is not an error");
    // No ~/.claude (or anything else) was created under the home.
    assert.deepEqual(await fsp.readdir(home), [], "no config dir was created");
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test("installCrewStopHook refuses to overwrite an unparseable settings.json", async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "co-crewhook-"));
  try {
    const configDir = path.join(home, ".claude");
    await fsp.mkdir(configDir, { recursive: true });
    const garbage = "{ this is not valid json ";
    await fsp.writeFile(path.join(configDir, "settings.json"), garbage);

    const res = await installCrewStopHook({
      agentCommand: "claude {prompt}",
      scriptPath: SCRIPT,
      nodePath: NODE,
      home,
    });
    assert.equal(res.changed, false);
    assert.ok(res.error && res.error.includes("not valid JSON"), "reports the parse refusal");
    // The user's file is left exactly as it was — we did not destroy it.
    assert.equal(await fsp.readFile(path.join(configDir, "settings.json"), "utf8"), garbage);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});
