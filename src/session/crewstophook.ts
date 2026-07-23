import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sentinelLine } from "./sentinel.js";

/**
 * The Claude Code Stop-hook entry for crew dispatch.
 *
 * WHY: a dispatched crew agent runs in a live, interactive pane (see
 * transport.ts). Its result used to become reviewable only after the human tore
 * the session down with /exit — that is what appended the completion sentinel.
 * Claude Code's Stop hook fires the moment Claude FINISHES RESPONDING, every
 * turn, in both interactive and headless (`claude -p`) sessions, and hands us
 * the session id, transcript path, and the last assistant message on stdin. We
 * use it as the completion trigger instead: the capture arrives on the first
 * finish, the pane stays open and usable, and no /exit is required.
 *
 * OBSERVE-ONLY: this hook never blocks. It exits 0 on every path and never emits
 * decision:"block", so it can never interfere with the live crew session — a
 * misbehaving hook must not be able to wedge the agent the human is talking to.
 *
 * FIRE-ONCE: the hook fires again on every follow-up turn the human types in the
 * same pane. We must capture only the FIRST finish. The fire-once gate is the
 * atomic, exclusive creation of the per-job sidecar (<job>.stop.json): the first
 * fire creates it and appends the sentinel; every later fire finds it already
 * there and exits without writing, so follow-up turns produce no new capture and
 * no re-notification.
 *
 * CORRELATION: the transport sets CO_DISPATCH_JOB (the capture file's stem) and
 * CO_DISPATCH_CAPTURE_DIR (the absolute captures dir) in the crew process's
 * environment, and hooks inherit that environment. From them the capture file is
 * <dir>/<job>.log and the sidecar is <dir>/<job>.stop.json — the same capture
 * file the registry already polls for the sentinel, so nothing downstream
 * changes its contract. A claude NOT launched by a dispatch has neither var set,
 * so the hook no-ops for it.
 */

/** The shape Claude Code passes a Stop hook on stdin (the fields we use; more
 *  exist). last_assistant_message is the text of Claude's final response, so a
 *  hook can surface the result without parsing the transcript. */
export interface StopHookPayload {
  session_id?: string;
  transcript_path?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
}

/** What the hook writes to <job>.stop.json — the completion record the registry
 *  reads to resolve the job and hand the review the transcript directly. */
export interface StopCapture {
  session_id: string | null;
  transcript_path: string | null;
  last_assistant_message: string | null;
  ts: number;
}

export interface StopHookResult {
  /** True only on the first fire for this job (sidecar created + sentinel
   *  appended). False when the job already had a capture (a follow-up turn) or
   *  the environment named no job — either way the hook wrote nothing. */
  fired: boolean;
  /** Why nothing was written, for tests/diagnostics. */
  reason?: "no-job" | "already-captured";
}

/** The sidecar path for a job's capture dir + stem. */
export function stopCaptureFile(captureDir: string, job: string): string {
  return path.join(captureDir, `${job}.stop.json`);
}

/** The capture (.log) file the registry polls for the sentinel. */
export function captureLogFile(captureDir: string, job: string): string {
  return path.join(captureDir, `${job}.log`);
}

/**
 * Core fire-once logic, pure w.r.t. its inputs so it can be unit-tested without
 * spawning claude. First fire: atomically create the sidecar (the gate), then
 * append the sentinel to the capture the registry polls. Second and later fires:
 * the exclusive create fails with EEXIST, so we do nothing and report it.
 *
 * The sidecar is created with the "wx" flag (fail if it exists) BEFORE the
 * sentinel is appended, so two fires racing can never both win: exactly one
 * openSync succeeds. The sentinel carries exit 0 — Stop fires only on a clean
 * turn completion (a user interrupt or API error fires StopFailure instead, not
 * Stop), so a hook-reported finish is by definition a non-error finish.
 */
export function runStopHook(args: {
  payload: StopHookPayload;
  job: string | undefined;
  captureDir: string | undefined;
  now: number;
}): StopHookResult {
  const { payload, job, captureDir, now } = args;
  if (!job || !captureDir) return { fired: false, reason: "no-job" };

  const sidecar = stopCaptureFile(captureDir, job);
  const record: StopCapture = {
    session_id: payload.session_id ?? null,
    transcript_path: payload.transcript_path ?? null,
    last_assistant_message: payload.last_assistant_message ?? null,
    ts: now,
  };

  let fd: number;
  try {
    // Exclusive create is the fire-once gate: only the first fire opens it.
    fd = fs.openSync(sidecar, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      return { fired: false, reason: "already-captured" };
    }
    // Any other error (dir gone, permissions): stay observe-only, write nothing.
    return { fired: false, reason: "no-job" };
  }
  try {
    fs.writeSync(fd, JSON.stringify(record));
  } finally {
    fs.closeSync(fd);
  }

  // Append the sentinel to the SAME capture file the registry polls. Appending
  // (not truncating) preserves whatever the pane job script already wrote (it
  // pre-creates an empty capture as its launch probe) and the registry's
  // parseSentinel finds this marker on its next poll. exit 0: a Stop fire is
  // always a clean finish.
  try {
    fs.appendFileSync(captureLogFile(captureDir, job), sentinelLine(0) + "\n");
  } catch {
    // The capture may not exist yet (a hook that fires before the script created
    // it); the sidecar is written, so the registry can still resolve the job from
    // it. Never throw.
  }
  return { fired: true };
}

/** Read all of stdin as UTF-8. Resolves "" if stdin is empty or unreadable so
 *  the hook degrades to a no-op rather than hanging or throwing. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    const stdin = process.stdin;
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => (data += chunk));
    stdin.on("end", () => resolve(data));
    stdin.on("error", () => resolve(data));
    // If nothing is piped, 'end' still fires on a closed stdin; a short guard
    // keeps a stuck pipe from hanging the crew's turn completion.
    setTimeout(() => resolve(data), 2000).unref?.();
  });
}

/**
 * Entry: read the hook payload from stdin, read the correlation env vars, run
 * the fire-once logic, and ALWAYS exit 0. Nothing here can disrupt the live
 * crew session — that is the whole contract of an observe-only Stop hook.
 */
export async function main(): Promise<void> {
  let payload: StopHookPayload = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) payload = JSON.parse(raw) as StopHookPayload;
  } catch {
    // Malformed payload: still try the env-only path (no transcript info), but
    // never throw. runStopHook tolerates all-null fields.
  }
  try {
    runStopHook({
      payload,
      job: process.env.CO_DISPATCH_JOB,
      captureDir: process.env.CO_DISPATCH_CAPTURE_DIR,
      now: Date.now(),
    });
  } catch {
    // Observe-only: swallow everything.
  }
  process.exit(0);
}

// Run when invoked directly as the hook command (node .../crewstophook.js), but
// not when imported by a test. The entry is always dist/session/crewstophook.js.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  void main();
}
