import fsp from "node:fs/promises";
import { readFileTail, type Job } from "./registry.js";
import { findCrewTranscript, renderTranscriptForReview } from "./crewtranscript.js";
import { scrubCapture } from "./transport.js";
import { resolveAgentCommand, type DispatchConfig } from "./dispatchconfig.js";

/**
 * The completion handoff: turn a finished crew job into the record of its run
 * that the reviewing co-manager reads.
 *
 * This is the last leg of a dispatch — the crew has spoken, the pane is still
 * open, and everything the captain will ever learn about that run has to come
 * through here. So the governing rule of this module is that IT NEVER CUTS
 * WITHOUT SAYING SO. Whatever bound a source carries (a tail read of a huge
 * transcript, the context budget around the report, a clipped build log) is
 * stated inline in the text handed over, naming bytes shown against bytes
 * captured, so a reviewer reading a short record knows whether it is short
 * because the run was short or because co trimmed it.
 *
 * That rule is written in blood. The renderer used to clip every message at
 * 2000 characters, head-first and silently: eleven consecutive dispatches
 * delivered reports cut mid-sentence, and the co-manager reviewed them as if
 * they were whole — a resolved key mapping, a verification result, and whole
 * subsystem write-ups were simply gone, and two later dispatches existed only to
 * recover facts a report had already carried.
 *
 * Four sources, in order of trust:
 *  1. the transcript path the crew's own Stop hook reported for THIS session;
 *  2. the transcript located by matching the job's order text;
 *  3. the last assistant message the Stop hook captured;
 *  4. the raw capture file (a launch probe plus the sentinel on the pane path).
 */

/** How much of a session transcript is read from disk. A transcript is JSONL and
 *  grows with tool output; the report is the last thing in it, so a tail read
 *  never risks the report. When this bites, the record says so. */
const TRANSCRIPT_READ_BYTES = 4 * 1024 * 1024;

/** The budget for the run's CONTEXT — everything up to the crew's final spoken
 *  message. The report itself rides on top of this whole and unbounded; see
 *  renderTranscriptForReview. */
const REVIEW_CONTEXT_MAX = 16000;

/** How much of a raw capture is read, and how much of it is kept. A pane
 *  capture holds only the launch probe and the sentinel; this budget is for the
 *  degraded cases (a `cd` that failed, a non-Claude agent's own output). */
const CAPTURE_READ_BYTES = 256 * 1024;
const CAPTURE_MAX = 16000;

export interface ReviewRecord {
  /** The run's record, as the review turn will carry it. Empty only when
   *  nothing at all was recoverable (the caller supplies the degrade note). */
  record: string;
  /** Where it came from, named in the review turn so the co-manager can weigh
   *  it (a transcript is the run; a capture may be only a completion marker). */
  source: string;
}

/**
 * Resolve the record of a finished job for review. Never throws: every source is
 * best-effort and falls through to the next, and the last of them is an honest
 * "nothing was recoverable" note rather than an error.
 */
export async function resolveReviewRecord(
  job: Job,
  config: DispatchConfig | null,
): Promise<ReviewRecord> {
  // 1. The Stop hook's exact transcript path for this job's session, if any.
  if (job.transcriptPath) {
    const record = await readTranscript(job.transcriptPath);
    if (record) return { record, source: "the crew agent's own session transcript" };
  }
  // 2. Locate the transcript by matching the order text (no hook, or its path
  //    was unreadable).
  if (config) {
    try {
      const transcript = await findCrewTranscript({
        agentCommand: resolveAgentCommand(config, job.agentName),
        repoPath: config.repoPath,
        order: job.order,
        startedAtMs: job.startedAt ?? 0,
      });
      if (transcript) {
        const record = await readTranscript(transcript);
        if (record) return { record, source: "the crew agent's own session transcript" };
      }
    } catch {
      /* fall through to the hook message / capture */
    }
  }
  // 3. The hook's captured last assistant message — a real result even when no
  //    transcript could be read. It IS the completion report, so it is handed
  //    over whole; nothing here bounds it.
  if (job.lastAssistantMessage) {
    return { record: job.lastAssistantMessage, source: "the crew agent's final message" };
  }
  // 4. The raw capture (a failed `cd`, a non-Claude agent's output, or on the
  //    pane path just the completion marker).
  try {
    return { record: await readCapture(job.captureFile), source: "the raw run capture" };
  } catch {
    return {
      record: "(no transcript was found and the capture file could not be read)",
      source: "nothing — no record was recoverable",
    };
  }
}

/**
 * Read and render a crew session transcript. Returns "" when it can't be read,
 * so the caller falls through to the next source.
 *
 * Only the tail is read, because a transcript carrying a long build's output can
 * run to many megabytes and the report is the LAST thing written to it. That is
 * still a bound, so when it bites the record says which bytes it is missing.
 */
async function readTranscript(file: string): Promise<string> {
  let size: number | null = null;
  try {
    size = (await fsp.stat(file)).size;
  } catch {
    /* the read below reports the real failure */
  }
  let raw: string;
  try {
    raw = await readFileTail(file, TRANSCRIPT_READ_BYTES);
  } catch {
    return "";
  }
  const rendered = renderTranscriptForReview(raw, REVIEW_CONTEXT_MAX);
  if (!rendered) return "";
  if (size !== null && size > TRANSCRIPT_READ_BYTES) {
    return (
      `…[co: the crew's session transcript is ${size} bytes; only its last ` +
      `${TRANSCRIPT_READ_BYTES} were read. The crew's final report is at the end of it ` +
      `and is complete.]\n${rendered}`
    );
  }
  return rendered;
}

/**
 * Read a capture file for review: the file's tail, scrubbed of terminal escape
 * noise, keeping the last CAPTURE_MAX characters — where a run's conclusion and
 * the sentinel live. Both bounds are named in the returned text when they bite.
 * Throws like readFile when the capture doesn't exist, which the caller treats
 * as "no record".
 */
export async function readCapture(file: string): Promise<string> {
  const size = (await fsp.stat(file)).size;
  const clean = scrubCapture(await readFileTail(file, CAPTURE_READ_BYTES));
  const notes: string[] = [];
  if (size > CAPTURE_READ_BYTES) {
    notes.push(`…[co: the run capture is ${size} bytes; only its last ${CAPTURE_READ_BYTES} were read.]`);
  }
  if (clean.length > CAPTURE_MAX) {
    notes.push(
      `…[co: showing the last ${CAPTURE_MAX} of ${clean.length} bytes of that capture, ` +
        `where the run's conclusion is.]`,
    );
    return [...notes, clean.slice(-CAPTURE_MAX)].join("\n");
  }
  return notes.length ? [...notes, clean].join("\n") : clean;
}
