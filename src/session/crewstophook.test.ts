import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  runStopHook,
  stopCaptureFile,
  captureLogFile,
  type StopCapture,
} from "./crewstophook.js";
import { parseSentinel, SENTINEL_PREFIX } from "./sentinel.js";

/**
 * Tests for the crew-completion Stop hook's fire-once logic. The hook fires on
 * EVERY turn the crew agent finishes; it must capture only the FIRST finish so
 * follow-up turns in the same pane produce no new capture and no re-notification.
 */

async function tmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "co-stophook-"));
}

const PAYLOAD = {
  session_id: "sess-abc",
  transcript_path: "/home/x/.claude/projects/-repo/sess-abc.jsonl",
  last_assistant_message: "All done, captain.",
  stop_hook_active: false,
};

test("first fire writes the sidecar capture and appends the completion sentinel", async () => {
  const dir = await tmpDir();
  try {
    const job = "job-001-abc";
    // The transport pre-creates an empty capture; the hook appends to it.
    await fsp.writeFile(captureLogFile(dir, job), "");

    const res = runStopHook({ payload: PAYLOAD, job, captureDir: dir, now: 123 });
    assert.equal(res.fired, true, "the first fire captures");

    // Sidecar holds the full completion record.
    const record = JSON.parse(await fsp.readFile(stopCaptureFile(dir, job), "utf8")) as StopCapture;
    assert.equal(record.session_id, "sess-abc");
    assert.equal(record.transcript_path, PAYLOAD.transcript_path);
    assert.equal(record.last_assistant_message, "All done, captain.");
    assert.equal(record.ts, 123);

    // Sentinel appended to the capture the registry polls, with exit 0.
    const captured = await fsp.readFile(captureLogFile(dir, job), "utf8");
    assert.ok(captured.includes(SENTINEL_PREFIX), "sentinel present in the capture");
    assert.deepEqual(parseSentinel(captured), { exitCode: 0 });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("a second fire with a capture already present is a no-op (fire-once)", async () => {
  const dir = await tmpDir();
  try {
    const job = "job-002-abc";
    await fsp.writeFile(captureLogFile(dir, job), "");

    const first = runStopHook({ payload: PAYLOAD, job, captureDir: dir, now: 100 });
    assert.equal(first.fired, true);

    const firstSidecar = await fsp.readFile(stopCaptureFile(dir, job), "utf8");
    const firstCapture = await fsp.readFile(captureLogFile(dir, job), "utf8");

    // A follow-up turn: different message, later timestamp. Must not re-capture.
    const second = runStopHook({
      payload: { ...PAYLOAD, last_assistant_message: "A follow-up reply." },
      job,
      captureDir: dir,
      now: 200,
    });
    assert.equal(second.fired, false, "the follow-up turn does not fire");
    assert.equal(second.reason, "already-captured");

    // Neither the sidecar nor the capture changed: no re-notification, no second
    // sentinel appended.
    assert.equal(await fsp.readFile(stopCaptureFile(dir, job), "utf8"), firstSidecar, "sidecar unchanged");
    assert.equal(await fsp.readFile(captureLogFile(dir, job), "utf8"), firstCapture, "capture unchanged");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("no job / no capture dir in the environment is a clean no-op", () => {
  assert.deepEqual(
    runStopHook({ payload: PAYLOAD, job: undefined, captureDir: "/tmp", now: 1 }),
    { fired: false, reason: "no-job" },
  );
  assert.deepEqual(
    runStopHook({ payload: PAYLOAD, job: "job-x", captureDir: undefined, now: 1 }),
    { fired: false, reason: "no-job" },
  );
});

test("first fire still captures when the transport hasn't created the capture yet", async () => {
  const dir = await tmpDir();
  try {
    const job = "job-003-abc";
    // No pre-created capture file (some transports create it late). The sidecar
    // is still the fire-once gate, so the registry can resolve the job from it,
    // and the hook creates the capture with the sentinel via append.
    const res = runStopHook({ payload: PAYLOAD, job, captureDir: dir, now: 5 });
    assert.equal(res.fired, true);
    assert.ok(fs.existsSync(stopCaptureFile(dir, job)), "sidecar created");
    const captured = await fsp.readFile(captureLogFile(dir, job), "utf8");
    assert.deepEqual(parseSentinel(captured), { exitCode: 0 });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("null payload fields are recorded as null, not undefined, and still fire once", async () => {
  const dir = await tmpDir();
  try {
    const job = "job-004-abc";
    const res = runStopHook({ payload: {}, job, captureDir: dir, now: 9 });
    assert.equal(res.fired, true);
    const record = JSON.parse(await fsp.readFile(stopCaptureFile(dir, job), "utf8")) as StopCapture;
    assert.equal(record.session_id, null);
    assert.equal(record.transcript_path, null);
    assert.equal(record.last_assistant_message, null);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
