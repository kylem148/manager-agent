import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyCompaction,
  estimateTokens,
  findCompactionCut,
  planCompaction,
} from "./compaction.js";
import type { MessageParam } from "../model.js";

/**
 * Mid-session history compaction.
 *
 * Two classes of thing have to hold, and they fail very differently.
 *
 * The API constraints fail LOUDLY: a history that starts with an assistant turn,
 * or a `tool_result` whose `tool_use` was dropped on the other side of the cut,
 * is a 400 that costs the captain their turn. Those are pinned hard.
 *
 * The economics fail QUIETLY: compacting rewrites the retained tail, and a cached
 * read is a twentieth the price of a write, so a compaction that releases little
 * costs more than it saves and nothing anywhere reports that. Hence the trigger
 * and minimum-release tests.
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
    { role: "assistant", content: [{ type: "tool_use", id, name: "search_log", input: {} }] },
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

test("token estimates cover both string and block content", () => {
  assert.equal(estimateTokens([]), 0);
  const plain = estimateTokens([user("x".repeat(380))]);
  assert.ok(plain > 90 && plain < 110, `expected ~100, got ${plain}`);
  // Block content is measured through its wire form, because that is what is
  // actually sent and billed.
  assert.ok(estimateTokens(toolExchange("t1")) > 0);
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
  // Cutting at index 0 rewrites the entire history to release zero tokens: the
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

// --- when to do it at all -----------------------------------------------------

test("a session under the ceiling is left alone", () => {
  const msgs = history(4, 100);
  assert.equal(
    planCompaction(msgs, { triggerTokens: 60_000, keepTurns: 6, minReleaseTokens: 15_000 }),
    null,
  );
});

test("a compaction that would release too little is refused", () => {
  // Over the trigger, with a safe cut available, but the cut only frees a sliver.
  // Firing here pays to rewrite the whole retained tail for almost nothing.
  const msgs = [user("x".repeat(400_000)), assistant("a"), user("b"), assistant("c"), user("d")];
  const plan = planCompaction(msgs, {
    triggerTokens: 1_000,
    keepTurns: 1,
    minReleaseTokens: 15_000,
  });
  assert.ok(plan, "this one should fire — the head is enormous");
  assert.ok(plan!.before - plan!.after >= 15_000);

  const stingy = planCompaction(history(40, 10), {
    triggerTokens: 10,
    keepTurns: 6,
    minReleaseTokens: 15_000,
  });
  assert.equal(stingy, null, "small histories must not trigger a rewrite");
});

test("a plan reports the sizes it is trading between", () => {
  const msgs = history(30, 2_000);
  const plan = planCompaction(msgs, {
    triggerTokens: 1_000,
    keepTurns: 4,
    minReleaseTokens: 1_000,
  });
  assert.ok(plan);
  assert.ok(plan!.after < plan!.before);
  assert.equal(plan!.after, estimateTokens(msgs.slice(plan!.cut)));
  // Round-trip the plan through the transform it describes: the retained tail
  // must be exactly what was measured, or the reported saving is fiction.
  const out = applyCompaction(msgs, plan!.cut, "s");
  assert.deepEqual(out.slice(1), msgs.slice(plan!.cut));
});

test("compacting twice in a row is a no-op the second time", () => {
  // The guard has to settle. If a compacted history still reads as over the
  // ceiling, every subsequent turn would pay for another rewrite.
  const msgs = history(30, 2_000);
  const first = planCompaction(msgs, {
    triggerTokens: 20_000,
    keepTurns: 4,
    minReleaseTokens: 1_000,
  });
  assert.ok(first);
  const compacted = applyCompaction(msgs, first!.cut, "a short summary");
  const second = planCompaction(compacted, {
    triggerTokens: 20_000,
    keepTurns: 4,
    minReleaseTokens: 1_000,
  });
  assert.equal(second, null);
});
