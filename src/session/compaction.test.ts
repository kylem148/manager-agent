import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyCompaction,
  historyBytes,
  findCompactionCut,
  planCompaction,
} from "./compaction.js";
import type { MessageParam } from "../model.js";

/**
 * The hard history ceiling.
 *
 * Two classes of thing have to hold, and they fail very differently.
 *
 * The API constraints fail LOUDLY: a history that starts with an assistant
 * turn, or a `tool_result` whose `tool_use` was dropped on the other side of
 * the cut, is a 400 that costs the captain their turn. Those are pinned hard.
 *
 * The ceiling itself has to be HARD: over the cap, a plan comes back whenever
 * any safe cut exists at all, shrinking the kept tail if the default keep is
 * itself over the cap - the alternative is a session that grows until the API
 * refuses it. And it has to SETTLE: a compacted history must not immediately
 * re-trigger, or every turn pays for another rewrite.
 */

function user(text: string): MessageParam {
  return { role: "user", content: text };
}

function assistant(text: string): MessageParam {
  return { role: "assistant", content: text };
}

/** An assistant turn asking for a tool, and the user turn answering it. */
function toolExchange(id: string): MessageParam[] {
  return [
    { role: "assistant", content: [{ type: "tool_use", id, name: "memory_search", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "found" }] },
  ];
}

/** A history of `n` plain exchanges, each message `pad` characters long. */
function history(n: number, pad = 10): MessageParam[] {
  const out: MessageParam[] = [];
  for (let i = 0; i < n; i++) {
    out.push(user(`q${i}`.padEnd(pad, "x")), assistant(`a${i}`.padEnd(pad, "y")));
  }
  return out;
}

// --- sizing -------------------------------------------------------------------

test("byte sizing covers both string and block content", () => {
  assert.equal(historyBytes([]), 0);
  assert.equal(historyBytes([user("x".repeat(380))]), 380);
  // Block content is measured through its wire form, because that is what is
  // actually sent and billed.
  assert.ok(historyBytes(toolExchange("t1")) > 0);
});

// --- where to cut -------------------------------------------------------------

test("the retained tail always begins on a user turn", () => {
  // The API rejects a history that opens assistant-side, so a cut landing there
  // would be a 400 rather than a bad summary.
  const msgs = history(10);
  const cut = findCompactionCut(msgs, 3);
  assert.ok(cut !== null);
  assert.equal(msgs[cut!]!.role, "user");
});

test("a tool_result is never orphaned from its tool_use", () => {
  // Cutting between the two halves of a tool exchange leaves a tool_result whose
  // tool_use is on the other side. That is a hard 400.
  const msgs = [...history(3), ...toolExchange("t1"), ...history(1)];
  for (let keep = 0; keep < 8; keep++) {
    const cut = findCompactionCut(msgs, keep);
    if (cut === null) continue;
    const first = msgs[cut]!;
    assert.equal(first.role, "user");
    if (typeof first.content !== "string") {
      assert.ok(
        !first.content.some((b) => b.type === "tool_result"),
        `keep=${keep} cut at ${cut} orphaned a tool_result`,
      );
    }
  }
});

test("keeping more turns than exist releases nothing rather than cutting badly", () => {
  assert.equal(findCompactionCut(history(2), 10), null);
  assert.equal(findCompactionCut([], 1), null);
});

test("a cut that would drop nothing is refused", () => {
  // Cutting at index 0 rewrites the entire history to release zero bytes: the
  // worst of both sides of the trade.
  assert.equal(findCompactionCut([user("only"), assistant("reply")], 1), null);
});

// --- applying it --------------------------------------------------------------

test("compaction replaces the head with a summary and keeps the tail verbatim", () => {
  const msgs = history(6);
  const out = applyCompaction(msgs, 6, "we decided X, Y is in flight");

  assert.equal(out[0]!.role, "user", "the history must still open user-side");
  assert.match(String(out[0]!.content), /compacted/);
  assert.match(String(out[0]!.content), /we decided X, Y is in flight/);
  // The tail is passed through untouched — thinking blocks and tool pairs in it
  // must survive byte-identical or the model rejects the replay.
  assert.deepEqual(out.slice(1), msgs.slice(6));
});

test("compaction does not mutate the array it was given", () => {
  const msgs = history(6);
  const before = structuredClone(msgs);
  applyCompaction(msgs, 6, "summary");
  assert.deepEqual(msgs, before);
});

test("the summary tells the co where the dropped detail went", () => {
  // Detail leaves the live window, not the disk. The co has to know it can still
  // search for what it no longer has in front of it.
  const out = applyCompaction(history(6), 6, "s");
  assert.match(String(out[0]!.content), /transcript/);
  assert.match(String(out[0]!.content), /memory logs/);
});

test("orientation rides the compaction message, after the summary", () => {
  // The startup injection is history and history is what gets cut, so this is
  // the one place orientation could leave the window - and a later whole-file
  // rewrite of activeContext.md written without the old content in view sheds
  // standing facts permanently. The re-injection closes that, hardcoded.
  const orientation = "## .memory/activeContext.md\n\nfocus: the overhaul";
  const out = applyCompaction(history(6), 6, "the summary", orientation);
  const head = String(out[0]!.content);
  assert.match(head, /focus: the overhaul/);
  assert.match(head, /re-read from disk/);
  assert.ok(
    head.indexOf("the summary") < head.indexOf("focus: the overhaul"),
    "summary first, orientation after it",
  );
  // The tail is untouched either way, and omitting orientation changes nothing.
  assert.deepEqual(out.slice(1), history(6).slice(6));
  assert.ok(!String(applyCompaction(history(6), 6, "s")[0]!.content).includes("re-read from disk"));
});

// --- when to do it at all -----------------------------------------------------

test("a session under the ceiling is left alone", () => {
  const msgs = history(4, 100);
  assert.equal(planCompaction(msgs, { maxBytes: 200_000, keepTurns: 6 }), null);
});

test("over the ceiling, the cap is hard: any safe cut produces a plan", () => {
  // A small overshoot with a small release still fires — there is no minimum
  // release to hide behind. Hard means hard.
  const msgs = history(10, 2_000);
  const plan = planCompaction(msgs, { maxBytes: 30_000, keepTurns: 6 });
  assert.ok(plan, "over the cap with safe cuts available must produce a plan");
  assert.ok(plan!.after <= 30_000, "the retained tail is back under the cap");
});

test("a giant kept tail shrinks the keep until the tail fits", () => {
  // Six turns of enormous tool results: keeping six would leave the history
  // over the cap and re-trigger forever. The planner keeps fewer instead.
  const msgs = history(12, 20_000);
  const plan = planCompaction(msgs, { maxBytes: 50_000, keepTurns: 6 });
  assert.ok(plan);
  assert.ok(plan!.after <= 50_000, `tail is ${plan!.after}, still over the 50k cap`);
});

test("when even one kept turn is over the cap, the best safe cut still applies", () => {
  // One enormous final exchange: nothing can get under the cap safely, so the
  // plan drops everything else - the most that can go without a malformed
  // request - rather than doing nothing and growing forever.
  const msgs = [...history(3, 10), user("x".repeat(300_000)), assistant("a")];
  const plan = planCompaction(msgs, { maxBytes: 100_000, keepTurns: 6 });
  assert.ok(plan, "a best-effort plan is still returned");
  assert.equal(plan!.cut, 6, "everything before the giant exchange is dropped");
});

test("a history with no legal cut is left alone rather than malformed", () => {
  // A single giant exchange has no second cut point: compacting it would drop
  // nothing or cut mid-exchange. Null is the only correct answer.
  const msgs = [user("x".repeat(300_000)), assistant("reply")];
  assert.equal(planCompaction(msgs, { maxBytes: 100_000, keepTurns: 6 }), null);
});

test("a plan reports the sizes it is trading between", () => {
  const msgs = history(30, 2_000);
  const plan = planCompaction(msgs, { maxBytes: 40_000, keepTurns: 4 });
  assert.ok(plan);
  assert.ok(plan!.after < plan!.before);
  assert.equal(plan!.after, historyBytes(msgs.slice(plan!.cut)));
  // Round-trip the plan through the transform it describes: the retained tail
  // must be exactly what was measured, or the reported saving is fiction.
  const out = applyCompaction(msgs, plan!.cut, "s");
  assert.deepEqual(out.slice(1), msgs.slice(plan!.cut));
});

test("compacting twice in a row is a no-op the second time", () => {
  // The ceiling has to settle. If a compacted history still read as over the
  // cap, every subsequent turn would pay for another rewrite.
  const msgs = history(30, 2_000);
  const first = planCompaction(msgs, { maxBytes: 40_000, keepTurns: 4 });
  assert.ok(first);
  const compacted = applyCompaction(msgs, first!.cut, "a short summary");
  const second = planCompaction(compacted, { maxBytes: 40_000, keepTurns: 4 });
  assert.equal(second, null);
});
