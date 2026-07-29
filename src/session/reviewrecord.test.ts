import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveReviewRecord, readCapture } from "./reviewrecord.js";
import { claudeProjectSlug } from "./crewtranscript.js";
import { defaultDispatchConfig, type DispatchConfig } from "./dispatchconfig.js";
import { sentinelLine } from "./sentinel.js";
import type { Job } from "./registry.js";

/**
 * Tests for the completion handoff — the last leg of a dispatch, where a
 * finished job becomes the record the reviewing co-manager reads.
 *
 * The regression these exist for: the handoff clipped every message at 2000
 * characters, head first and silently, so eleven consecutive crew reports
 * reached the co-manager cut mid-sentence with their diffstat and verification
 * missing. The rule pinned here is that the crew's completion report survives
 * whole through every source, and that any bound still applied to the record
 * says so in the handed-over text, in bytes.
 */

/** A realistic completion report of the shape every order asks the crew for:
 *  root cause up top, subsystem write-ups, diffstat, verification, terminator.
 *  Deliberately several times the old 2000-character clip. */
function syntheticReport(): string {
  const parts = [
    "## Root cause",
    "",
    "The handoff clipped each message to 2000 characters, keeping the head.",
    "",
  ];
  for (let i = 1; i <= 4; i++) {
    parts.push(`### Subsystem ${i}`, "Write-up: " + "a sentence a reviewer needs to read. ".repeat(12), "");
  }
  parts.push(
    "## Diffstat",
    " src/session/crewtranscript.ts | 62 ++++++++++++-----",
    "",
    "## Verification",
    "npm run typecheck: clean. npm test: all passing.",
    "",
    "--- END OF REPORT ---",
  );
  return parts.join("\n");
}

function userLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } });
}
function assistantLine(blocks: unknown[]): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: blocks } });
}

/** A crew session transcript in Claude Code's own JSONL shape, closing with the
 *  completion report as the crew's final message — exactly how a real dispatch
 *  ends when the Stop hook fires on the first finish. */
function transcriptFor(order: string, report: string): string {
  return (
    [
      userLine(order),
      assistantLine([{ type: "text", text: "Reading the transport code now." }]),
      assistantLine([{ type: "tool_use", name: "Bash", input: { command: "npm test" } }]),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: "ok\n".repeat(400) }] }] },
      }),
      assistantLine([{ type: "thinking", thinking: "never rendered" }, { type: "text", text: report }]),
    ].join("\n") + "\n"
  );
}

function job(over: Partial<Job> = {}): Job {
  return {
    id: "job-001",
    order: "Fix the crew report truncation.",
    label: "Fix the crew report truncation.",
    transport: "ghostty",
    status: "done",
    captureFile: "/nonexistent/job-001.log",
    startedAt: Date.now() - 60_000,
    exitCode: 0,
    ...over,
  };
}

async function tmpdir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "co-reviewrecord-"));
}

test("a completion report arrives whole through the Stop hook's transcript path", async () => {
  const dir = await tmpdir();
  try {
    const report = syntheticReport();
    const file = path.join(dir, "session.jsonl");
    await fsp.writeFile(file, transcriptFor("Fix the crew report truncation.", report));

    const { record, source } = await resolveReviewRecord(job({ transcriptPath: file }), null);

    assert.equal(source, "the crew agent's own session transcript");
    assert.ok(record.includes(report), "the report is handed over byte-for-byte");
    assert.ok(
      record.endsWith("--- END OF REPORT ---"),
      `the report's LAST bytes survive; record ended with ${JSON.stringify(record.slice(-60))}`,
    );
    assert.ok(record.includes("## Diffstat") && record.includes("## Verification"), "and everything before them");
    assert.ok(record.includes("Reading the transport code now."), "the run's context comes along");
    assert.ok(!record.includes("never rendered"), "thinking is still never rendered");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("a completion report arrives whole through the transcript located by order text", async () => {
  const dir = await tmpdir();
  try {
    const repo = path.join(dir, "repo");
    const order = "Fix the crew report truncation.";
    const report = syntheticReport();
    const projects = path.join(dir, ".claude", "projects", claudeProjectSlug(repo));
    await fsp.mkdir(projects, { recursive: true });
    await fsp.writeFile(path.join(projects, "abc.jsonl"), transcriptFor(order, report));

    const config: DispatchConfig = {
      ...defaultDispatchConfig(),
      repoPath: repo,
      agents: [{ name: "cc", command: `CLAUDE_CONFIG_DIR=${path.join(dir, ".claude")} claude {prompt}` }],
      defaultAgent: "cc",
    };
    // No transcriptPath: this is the no-hook path, which must deliver the same
    // whole report as the hook path does.
    const { record, source } = await resolveReviewRecord(job({ order }), config);

    assert.equal(source, "the crew agent's own session transcript");
    assert.ok(record.includes(report), "the report is handed over byte-for-byte");
    assert.ok(record.endsWith("--- END OF REPORT ---"), "including its last line");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("the Stop hook's captured final message is handed over whole", async () => {
  const report = syntheticReport();
  const { record, source } = await resolveReviewRecord(job({ lastAssistantMessage: report }), null);
  assert.equal(source, "the crew agent's final message");
  assert.equal(record, report, "nothing bounds the final message: it IS the report");
});

test("a run that left no record says so instead of inventing one", async () => {
  const { record, source } = await resolveReviewRecord(job(), null);
  assert.match(record, /could not be read/);
  assert.equal(source, "nothing — no record was recoverable");
});

test("a pane capture is handed over as-is when it fits", async () => {
  const dir = await tmpdir();
  try {
    const file = path.join(dir, "job.log");
    await fsp.writeFile(file, `co dispatch: cannot cd to /gone\n${sentinelLine(1)}\n`);
    const { record, source } = await resolveReviewRecord(job({ captureFile: file }), null);
    assert.equal(source, "the raw run capture");
    assert.ok(record.includes("cannot cd to /gone"), "the whole capture, no notice bolted on");
    assert.ok(!record.includes("[co:"), "nothing was trimmed, so nothing claims it was");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/**
 * The one bound that remains by design on this path: a capture big enough to
 * blow the context window is trimmed to its tail. It must never do that
 * silently — the notice names bytes shown against bytes captured, and the
 * conclusion (the end of the run, where the sentinel is) is what survives.
 */
test("an oversized capture is trimmed to its tail with the bound stated in bytes", async () => {
  const dir = await tmpdir();
  try {
    const file = path.join(dir, "job.log");
    const noise = "a line of build output that nobody needs to read\n".repeat(1000);
    await fsp.writeFile(file, `${noise}the run's final word\n${sentinelLine(0)}\n`);
    const { record } = await resolveReviewRecord(job({ captureFile: file }), null);

    assert.match(record, /…\[co: showing the last 16000 of \d+ bytes of that capture/, "the bound is stated, in bytes");
    assert.ok(record.includes("the run's final word"), "the tail, where the conclusion is, survives");
    assert.ok(record.trimEnd().endsWith(sentinelLine(0)), "including the completion marker");
    assert.ok(record.length < 17000, "and the bound is actually applied");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("readCapture states the read window too when a capture is larger than it", async () => {
  const dir = await tmpdir();
  try {
    const file = path.join(dir, "huge.log");
    await fsp.writeFile(file, "x".repeat(300 * 1024) + "\nthe end\n");
    const out = await readCapture(file);
    assert.match(out, /…\[co: the run capture is \d+ bytes; only its last 262144 were read\.\]/);
    assert.ok(out.includes("the end"), "the tail is what a tail read keeps");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
