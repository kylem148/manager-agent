import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { instancePaths } from "../paths.js";

/**
 * End-to-end tests for `co link` / `co pane` through the real CLI. `co link`
 * prompts interactively, so we drive it with a piped stdin script (each answer on
 * its own line). No model is called.
 */

const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = path.dirname(SRC);
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const ENTRY = path.join(SRC, "index.ts");

async function runCli(coHome: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [ENTRY, ...args], {
      cwd: ROOT,
      env: { ...process.env, CO_HOME: coHome },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI did not exit within 30s. Output:\n${out}`));
    }, 30_000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", () => { clearTimeout(timer); resolve(out); });
    child.stdin.write(input);
    child.stdin.end();
  });
}

async function withInstance(fn: (coHome: string) => Promise<void>): Promise<void> {
  const coHome = await mkdtemp(path.join(os.tmpdir(), "co-link-test-"));
  try {
    await runCli(coHome, ["create", "t"], "");
    await fn(coHome);
  } finally {
    await rm(coHome, { recursive: true, force: true });
  }
}

test("co link refuses without a TTY (it needs to prompt), leaving nothing behind", async () => {
  await withInstance(async (coHome) => {
    // Piped stdin is not a TTY; link should decline rather than half-write config.
    const out = await runCli(coHome, ["link", "t"], "\n");
    assert.match(out, /interactive terminal/i);
    // No config file was created.
    const cfg = instancePaths(coHome, "t").dispatchConfig;
    await assert.rejects(() => readFile(cfg, "utf8"));
  });
});

test("co link on a missing instance is rejected", async () => {
  await withInstance(async (coHome) => {
    const out = await runCli(coHome, ["link", "does-not-exist"], "\n");
    assert.match(out, /doesn't exist/i);
  });
});

test("co pane off macOS explains the feature is Ghostty-only", async () => {
  if (process.platform === "darwin") return; // this assertion is for non-macOS
  await withInstance(async (coHome) => {
    const out = await runCli(coHome, ["pane", "t"], "\n");
    assert.match(out, /macOS \+ Ghostty/i);
  });
});

test("co help lists the dispatch commands", async () => {
  await withInstance(async (coHome) => {
    const out = await runCli(coHome, ["help"], "");
    assert.match(out, /co link <name>/);
    assert.match(out, /co pane <name>/);
  });
});
