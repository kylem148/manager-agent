import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  claudeConfigDir,
  claudeProjectSlug,
  findCrewTranscript,
  renderTranscriptForReview,
} from "./crewtranscript.js";

/**
 * Tests for locating and rendering a crew agent's own session transcript — the
 * review record for fully native pane runs (nothing records the pane tty).
 * File-layout facts (projects/<slug>/<id>.jsonl, message line shapes) were
 * verified against a real ~/.claude on 2026-07-22.
 */

test("claudeConfigDir parses the env prefix in its real shapes, defaults to ~/.claude", () => {
  const home = "/Users/kyle";
  assert.equal(
    claudeConfigDir(`CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude {prompt}`, home),
    "/Users/kyle/.claude-work",
    "double-quoted $HOME form (what co link resolves ccw to)",
  );
  assert.equal(claudeConfigDir(`CLAUDE_CONFIG_DIR='~/.claude-work' claude {prompt}`, home), "/Users/kyle/.claude-work");
  assert.equal(claudeConfigDir(`CLAUDE_CONFIG_DIR=/abs/dir claude {prompt}`, home), "/abs/dir");
  assert.equal(claudeConfigDir(`claude {prompt}`, home), "/Users/kyle/.claude", "no prefix → personal default");
});

test("claudeProjectSlug matches Claude Code's directory naming", () => {
  assert.equal(
    claudeProjectSlug("/Users/kylemorgan/Code/personal/manager-agent"),
    "-Users-kylemorgan-Code-personal-manager-agent",
  );
  assert.equal(claudeProjectSlug("/a/b.c/d_e"), "-a-b-c-d-e", "dots and underscores also become dashes");
});

/** Build a fake transcript line the way Claude Code writes them. */
function userLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } });
}
function assistantLine(blocks: unknown[]): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: blocks } });
}

test("findCrewTranscript matches a job to its transcript by order text, not by timing alone", async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "co-transcript-"));
  try {
    const repo = "/repo/x";
    const dir = path.join(home, ".claude", "projects", claudeProjectSlug(repo));
    await fsp.mkdir(dir, { recursive: true });

    // Two concurrent jobs in the same repo: same window, different orders.
    const orderA = "Order A: update the README\nwith details.";
    const orderB = "Order B: run the tests and report.";
    await fsp.writeFile(path.join(dir, "aaa.jsonl"), userLine(orderA) + "\n" + assistantLine([{ type: "text", text: "done A" }]) + "\n");
    await fsp.writeFile(path.join(dir, "bbb.jsonl"), userLine(orderB) + "\n");
    // A stale transcript from an old session, same content as A but old mtime.
    const stale = path.join(dir, "old.jsonl");
    await fsp.writeFile(stale, userLine(orderA) + "\n");
    await fsp.utimes(stale, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));

    const homedirArgs = { repoPath: repo, startedAtMs: Date.now() - 60_000 };
    // Point the config-dir parse at our fixture home via the env-prefix form.
    const agentCommand = `CLAUDE_CONFIG_DIR=${path.join(home, ".claude")} claude {prompt}`;

    const foundA = await findCrewTranscript({ agentCommand, order: orderA, ...homedirArgs });
    assert.equal(foundA && path.basename(foundA), "aaa.jsonl", "job A gets A's transcript");
    const foundB = await findCrewTranscript({ agentCommand, order: orderB, ...homedirArgs });
    assert.equal(foundB && path.basename(foundB), "bbb.jsonl", "job B gets B's transcript, concurrently");

    const foundNone = await findCrewTranscript({ agentCommand, order: "an order that never ran", ...homedirArgs });
    assert.equal(foundNone, null, "no false match when nothing corresponds");
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test("findCrewTranscript ignores transcripts older than the job", async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "co-transcript-"));
  try {
    const repo = "/repo/y";
    const dir = path.join(home, ".claude", "projects", claudeProjectSlug(repo));
    await fsp.mkdir(dir, { recursive: true });
    const order = "the same order text as before";
    const old = path.join(dir, "old.jsonl");
    await fsp.writeFile(old, userLine(order) + "\n");
    await fsp.utimes(old, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));

    const found = await findCrewTranscript({
      agentCommand: `CLAUDE_CONFIG_DIR=${path.join(home, ".claude")} claude {prompt}`,
      repoPath: repo,
      order,
      startedAtMs: Date.now() - 60_000,
    });
    assert.equal(found, null, "an hour-old transcript is not this job's record");
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test("renderTranscriptForReview yields readable prose: prompt, crew text, tool one-liners", () => {
  const jsonl = [
    JSON.stringify({ type: "mode", sessionId: "s-1" }),
    userLine("Do the thing.\nCarefully."),
    assistantLine([
      { type: "thinking", thinking: "secret reasoning that must never render" },
      { type: "text", text: "On it." },
      { type: "tool_use", name: "Bash", input: { command: "npm test" } },
    ]),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: "183 passing" }] }] },
    }),
    assistantLine([{ type: "text", text: "All green. Committed as abc123." }]),
    "not json at all — a truncated tail read leaves fragments",
  ].join("\n");

  const out = renderTranscriptForReview(jsonl, 16000);
  assert.ok(out.includes("[prompt] Do the thing."), "the order shows as the prompt");
  assert.ok(out.includes("[crew] On it."), "crew text renders");
  assert.ok(out.includes('[tool] Bash {"command":"npm test"}'), "tool calls are one-liners");
  assert.ok(out.includes("[result] 183 passing"), "tool results are included, trimmed");
  assert.ok(out.includes("[crew] All green. Committed as abc123."));
  assert.ok(!out.includes("secret reasoning"), "thinking is never rendered");
  assert.ok(!out.includes("not json"), "unparseable fragments are skipped, not crashed on");
});

test("renderTranscriptForReview caps output keeping the tail", () => {
  const lines = Array.from({ length: 500 }, (_, i) => assistantLine([{ type: "text", text: `step ${i} ` + "x".repeat(100) }]));
  const out = renderTranscriptForReview(lines.join("\n"), 2000);
  assert.ok(out.length <= 2100, "capped near the limit");
  assert.ok(out.startsWith("…[transcript truncated"), "announces truncation");
  assert.ok(out.includes("step 499"), "keeps the end, where the conclusion lives");
});
