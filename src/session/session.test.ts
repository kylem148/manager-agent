import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { completionTurn, parseConfirm } from "./session.js";
import type { Job } from "./registry.js";

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

const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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
    // Each command must have produced its own transition line, in order. The
    // first transition starts from the configured default (see loadConfig).
    assert.match(out, /effort: high → low/);
    assert.match(out, /effort: low → high/);
    assert.match(out, /effort: high → max/);
  });
});

test("a piped session ends cleanly at EOF with no trailing /exit", async () => {
  await withInstance(async (coHome) => {
    const out = await runCli(coHome, ["t"], "/effort low\n/effort\n");
    assert.match(out, /effort: high → low/);
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

test("parseConfirm reads the interlock verb, the lane word, and an optional agent override", () => {
  // Bare confirm → fire with the default agent (no override).
  assert.deepEqual(parseConfirm("confirm"), { isConfirm: true });
  // The verb is case-insensitive and tolerant of surrounding whitespace.
  assert.deepEqual(parseConfirm("  CONFIRM  "), { isConfirm: true });
  // `confirm <name>` selects that agent for this dispatch only.
  assert.deepEqual(parseConfirm("confirm ccw"), { isConfirm: true, agent: "ccw" });
  assert.deepEqual(parseConfirm("confirm cc"), { isConfirm: true, agent: "cc" });
  // Only the first token after the verb is the agent; trailing words are ignored.
  assert.deepEqual(parseConfirm("confirm cc please"), { isConfirm: true, agent: "cc" });

  // `write` is the word that buys a second WRITING lane in an occupied worktree
  // (D-20260729-5). It is part of the confirm verb, not a second question after
  // it, so the typed-confirm interlock is still exactly one keystroke away from
  // either outcome and neither one is a cancel-trap.
  assert.deepEqual(parseConfirm("confirm write"), { isConfirm: true, write: true });
  assert.deepEqual(parseConfirm("  CONFIRM  WRITE  "), { isConfirm: true, write: true });
  // The lane word and an agent override compose, in that order.
  assert.deepEqual(parseConfirm("confirm write ccw"), { isConfirm: true, write: true, agent: "ccw" });
  assert.deepEqual(parseConfirm("confirm write cc please"), {
    isConfirm: true,
    write: true,
    agent: "cc",
  });

  // Anything that isn't the confirm verb cancels — never a partial confirm.
  assert.deepEqual(parseConfirm("cancel"), { isConfirm: false });
  assert.deepEqual(parseConfirm("confirmation"), { isConfirm: false });
  assert.deepEqual(parseConfirm(""), { isConfirm: false });
  // Including the lane word on its own, and the two obvious near-misses. The
  // gate is worth nothing if a stray line can be read as half a confirm.
  assert.deepEqual(parseConfirm("write"), { isConfirm: false });
  assert.deepEqual(parseConfirm("write confirm"), { isConfirm: false });
  assert.deepEqual(parseConfirm("confirm-write"), { isConfirm: false });
});

/** A finished job, as the completion drain sees one. */
function finished(lane: Job["lane"], extra: Partial<Job> = {}): Job {
  return {
    id: "job-007",
    order: "do the thing",
    lane,
    label: "do the thing",
    transport: "ghostty",
    status: "done",
    captureFile: "/tmp/job-007.log",
    startedAt: 0,
    exitCode: 0,
    feature: "auth",
    ...extra,
  };
}

test("a writer's completion is a review to reach; a reader's is context to answer with", () => {
  const record = "diffstat: 3 files changed";
  const writer = completionTurn(finished("writer"), record, "the crew agent's own session transcript");
  // A run that produced work is reviewed, and the review is silent by default.
  assert.match(writer, /review it now for the captain/);
  assert.match(writer, /SAY NOTHING UNLESS IT IS VITAL/);
  assert.match(writer, /Otherwise say nothing at all and let the run pass/);
  assert.match(writer, /accept \/ fix-commit \/ rework/);
  assert.ok(writer.includes(record), "with the run's record attached");

  const reader = completionTurn(finished("reader", { readOnlyEnforced: true }), record, "the crew agent's final message");
  // The whole point: an audit never gets a verdict at all.
  assert.match(reader, /DO NOT REVIEW THIS RUN/);
  assert.ok(!reader.includes("SAY NOTHING UNLESS IT IS VITAL"), "the review instruction is gone, not merely softened");
  assert.match(reader, /do not give it a verdict/i);
  assert.match(reader, /CONTEXT FOR YOU TO ANSWER WITH/);
  assert.ok(reader.includes(record), "and the findings are still handed over whole");
});

test("an advisory-only audit says so in the turn, instead of claiming it was enforced", () => {
  const enforced = completionTurn(finished("reader", { readOnlyEnforced: true }), "found nothing", "src");
  assert.match(enforced, /write-capable tools were also denied at launch/);
  assert.match(enforced, /it produced no diff and changed nothing/);

  const advisory = completionTurn(finished("reader", { readOnlyEnforced: false }), "found nothing", "src");
  assert.match(advisory, /advisory only for this agent/);
  assert.match(
    advisory,
    /if the record shows it wrote anything, say so plainly/,
    "an unenforced lane is a thing the co has to actually check, not assume",
  );
  assert.match(advisory, /It was supposed to produce no diff/, "supposed to, not did");
});
