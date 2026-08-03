import { test } from "node:test";
import assert from "node:assert/strict";
import type { MessageParam } from "../model.js";
import {
  firstLineOf,
  flushHistoryNotes,
  noteDispatchCancelled,
  noteDispatchFired,
  noteDispatchLaunchFailed,
  noteMergeOutcome,
} from "./historynotes.js";

/**
 * These assert the thing the feature is actually for: the line lands in the
 * MODEL's history — the MessageParam[] the session hands straight to
 * runTurn({ messages }) — and not merely on screen or in the transcript file.
 * So every test flushes into a real message array and reads that array back.
 *
 * The functions under test are the same ones session.ts calls at the three
 * event sites; the fake here is only the two fields they touch.
 */

/** The session, as these functions see it: a note buffer and the model history. */
function session(): { historyNotes: string[]; messages: MessageParam[] } {
  return {
    historyNotes: [],
    // A session's history always opens with the briefing, so index 0 is never
    // one of ours and "appended at the end" means something.
    messages: [{ role: "user", content: "briefing" }],
  };
}

/** Every message in history whose content is one of our SYSTEM notes. */
function notesIn(messages: MessageParam[]): string[] {
  return messages
    .filter((m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("SYSTEM:"))
    .map((m) => m.content as string);
}

test("confirming an armed dispatch puts one line in model history naming the order and the agent", () => {
  const s = session();
  noteDispatchFired(s, {
    order: "Fix the crew handoff truncation\n\nContext: the capture file is cut at 4KB.",
    jobId: "job-007",
    agent: "ccw",
    feature: "handoff",
  });
  flushHistoryNotes(s, s.messages);

  const notes = notesIn(s.messages);
  assert.equal(notes.length, 1, "exactly one line, not one per anything");
  assert.equal(s.messages.length, 2, "and it is a message in the history, not a decoration on one");
  assert.equal(s.messages[1]!.role, "user", "the one role the API lets us speak in");
  // Useless without both halves: which order, and which agent is running it.
  assert.match(notes[0]!, /Fix the crew handoff truncation/, "names the order");
  assert.match(notes[0]!, /ccw/, "names the agent that ran it");
  assert.match(notes[0]!, /DISPATCHED/, "and says it fired");
  assert.match(notes[0]!, /job-007/);
  assert.match(notes[0]!, /feature 'handoff'/);
  // The buffer is drained, so a second flush (a repaint, another turn) adds nothing.
  flushHistoryNotes(s, s.messages);
  assert.equal(notesIn(s.messages).length, 1, "flushing again repeats nothing");
});

test("a dispatch with no named agent and no feature still names both halves honestly", () => {
  const s = session();
  noteDispatchFired(s, { order: "Audit the landing gate", jobId: "job-9" });
  flushHistoryNotes(s, s.messages);
  const note = notesIn(s.messages)[0]!;
  assert.match(note, /Audit the landing gate/);
  assert.match(note, /the default/, "the default agent is named as the default, not left blank");
  assert.match(note, /bare main tree/, "and an unscoped dispatch says where it ran");
});

test("cancelling an armed dispatch lands in model history BEFORE the line that cancelled it", () => {
  const s = session();
  // The input loop's order of operations, exactly: the cancel is recorded while
  // handling the keystroke, then the typed line is appended through the flush.
  noteDispatchCancelled(s, "Rewrite the merge queue to be parallel\nsecond line");
  flushHistoryNotes(s, s.messages);
  s.messages.push({ role: "user", content: "actually, hold off on that" });

  const contents = s.messages.map((m) => m.content as string);
  const noteAt = contents.findIndex((t) => t.startsWith("SYSTEM:"));
  const inputAt = contents.indexOf("actually, hold off on that");
  assert.notEqual(noteAt, -1, "the cancellation reached model history");
  assert.ok(noteAt < inputAt, "and the co reads it before the message that caused it");
  assert.equal(notesIn(s.messages).length, 1);
  assert.match(contents[noteAt]!, /Rewrite the merge queue to be parallel/, "names the order");
  assert.match(contents[noteAt]!, /CANCELLED/, "and the outcome");
  assert.ok(!contents[noteAt]!.includes("second line"), "one line, not the whole order");
});

test("a confirm whose launch fails says so, so an absent 'fired' note is never ambiguous", () => {
  const s = session();
  noteDispatchLaunchFailed(s, { order: "Ship the thing", error: "no crew pane designated" });
  flushHistoryNotes(s, s.messages);
  const note = notesIn(s.messages)[0]!;
  assert.match(note, /Ship the thing/);
  assert.match(note, /FAILED TO LAUNCH/);
  assert.match(note, /no crew pane designated/);
  assert.match(note, /Nothing is running/);
});

test("merging a queue head puts one line in model history naming the feature, the PR and the outcome", () => {
  const s = session();
  noteMergeOutcome(s, {
    merged: true,
    outcome: "merged",
    feature: "checkout",
    summary: "merged checkout",
    pr: { number: 42, url: "https://github.com/o/r/pull/42" },
    target: "dev",
  });
  flushHistoryNotes(s, s.messages);

  const notes = notesIn(s.messages);
  assert.equal(notes.length, 1, "one line for one keystroke");
  assert.equal(s.messages.length, 2, "in the history the model is sent");
  assert.match(notes[0]!, /feature 'checkout'/, "names the feature");
  assert.match(notes[0]!, /PR #42/, "names the pull request");
  assert.match(notes[0]!, /MERGED into dev/, "and the outcome");
  // The whole reason this exists: the co must stop reporting it as in flight.
  assert.match(notes[0]!, /no longer in flight/);
});

test("a refused merge names the same subject and the opposite outcome", () => {
  const s = session();
  noteMergeOutcome(s, {
    merged: false,
    outcome: "failed",
    feature: "checkout",
    summary: "the head moved",
    pr: { number: 42, url: "https://github.com/o/r/pull/42" },
    error: "the PR head is not the sha the checks ran on",
  });
  flushHistoryNotes(s, s.messages);
  const note = notesIn(s.messages)[0]!;
  assert.match(note, /feature 'checkout'/);
  assert.match(note, /PR #42/);
  assert.match(note, /FAILED/);
  assert.match(note, /the PR head is not the sha the checks ran on/);
  assert.match(note, /Nothing was merged/);
});

test("nothing happening writes nothing to history", () => {
  const s = session();
  // [m] is not offered in any of these states; if one is somehow reached, a
  // line about a non-event is noise the model would have to reason past.
  for (const outcome of ["not-ready", "empty", "busy", "panel"] as const) {
    noteMergeOutcome(s, { merged: false, outcome, feature: "checkout", summary: "no" });
  }
  flushHistoryNotes(s, s.messages);
  assert.deepEqual(notesIn(s.messages), []);
  assert.equal(s.messages.length, 1, "the history is untouched");
});

test("firstLineOf reduces an order to one clipped line", () => {
  assert.equal(firstLineOf("\n\n  do the thing  \nand then more\n"), "do the thing");
  assert.equal(firstLineOf(""), "");
  const long = "x".repeat(200);
  assert.equal(firstLineOf(long).length, 78, "clipped to 77 plus the ellipsis");
  assert.ok(firstLineOf(long).endsWith("…"));
});
