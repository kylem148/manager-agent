import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * End-to-end tests for the piped / non-TTY read loop (PlainIO).
 *
 * These spawn the real CLI and feed it a script on stdin, because the bug they
 * guard against only appears with a real piped stdin: the whole script arrives
 * in one chunk and readline emits every line at once. A unit test with a fake
 * stream would not reproduce it.
 *
 * Only slash-commands that never call the model are used, so these run with no
 * Bedrock credentials.
 */

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SRC);
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const ENTRY = path.join(SRC, "index.ts");

/** Run the CLI with `input` on stdin under a throwaway CO_HOME. */
async function runCli(coHome: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [ENTRY, ...args], {
      cwd: ROOT,
      env: { ...process.env, CO_HOME: coHome },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });

    // A hang is the failure mode we are testing for, so never wait forever.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI did not exit within 60s. Output so far:\n${out}`));
    }, 60_000);

    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", () => { clearTimeout(timer); resolve(out); });

    child.stdin.write(input);
    child.stdin.end();
  });
}

async function withInstance(fn: (coHome: string) => Promise<void>): Promise<void> {
  const coHome = await mkdtemp(path.join(os.tmpdir(), "co-session-test-"));
  try {
    await runCli(coHome, ["create", "t"], "");
    await fn(coHome);
  } finally {
    await rm(coHome, { recursive: true, force: true });
  }
}

test("a piped session runs every command, not just the first", async () => {
  await withInstance(async (coHome) => {
    const out = await runCli(
      coHome,
      ["t"],
      "/effort low\n/effort high\n/effort max\n/exit\n",
    );
    // Each command must have produced its own transition line, in order.
    assert.match(out, /effort: xhigh → low/);
    assert.match(out, /effort: low → high/);
    assert.match(out, /effort: high → max/);
  });
});

test("a piped session ends cleanly at EOF with no trailing /exit", async () => {
  await withInstance(async (coHome) => {
    const out = await runCli(coHome, ["t"], "/effort low\n/effort\n");
    assert.match(out, /effort: xhigh → low/);
    assert.match(out, /effort: low {2}\(levels:/);
    assert.match(out, /bye\./);
  });
});

test("empty stdin exits cleanly instead of hanging", async () => {
  await withInstance(async (coHome) => {
    const out = await runCli(coHome, ["t"], "");
    assert.match(out, /co-manager: t/);
  });
});

test("a final line with no trailing newline is still read", async () => {
  await withInstance(async (coHome) => {
    const out = await runCli(coHome, ["t"], "/effort low\n/effort high");
    assert.match(out, /effort: low → high/);
  });
});
