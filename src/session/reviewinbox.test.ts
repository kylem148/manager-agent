import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { instancePaths, type InstancePaths } from "../paths.js";
import type { ResearchConfig } from "../config.js";
import { makeExecutor, newSideEffects, toolDefinitions } from "./tools.js";
import {
  appendReview,
  filedNote,
  fileReviewInto,
  INBOX_CAP,
  levelFor,
  ReviewInbox,
  reviewChatLine,
  type ReviewLevel,
  type ReviewRecord,
  type ReviewVerdict,
} from "./reviewinbox.js";
import { c } from "../ui.js";

/**
 * The review inbox: the rolling store, the verdict→level mapping, the chat
 * gating, and the file_review tool that writes into it.
 *
 * The invariants that matter here: a filed review persists under the instance's
 * own dir and comes back after a restart, the list stays newest-first and capped,
 * and the LEVEL decides the chat volume — L2 emits exactly one dim pointer line,
 * L1 and L3 emit none. The gating is tested as the pure decision it is, so no
 * model call or terminal is involved.
 */

async function makeInstance(): Promise<{ paths: InstancePaths; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "co-inbox-"));
  const paths = instancePaths(home, "inst");
  return { paths, cleanup: () => rm(home, { recursive: true, force: true }) };
}

function record(over: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    jobId: "job-001",
    timestamp: "2026-07-24T10:00:00.000Z",
    verdict: "accept",
    level: "L3",
    headline: "clean run",
    body: "went right: everything.",
    ...over,
  };
}

// --- the rolling list --------------------------------------------------------

test("appendReview keeps the list newest-first and capped at 20", () => {
  let list: ReviewRecord[] = [];
  for (let i = 1; i <= 25; i++) {
    list = appendReview(list, record({ jobId: `job-${String(i).padStart(3, "0")}`, headline: `run ${i}` }));
  }
  assert.equal(list.length, INBOX_CAP, "capped");
  assert.equal(INBOX_CAP, 20, "the cap is 20 (D-20260724-8)");
  assert.equal(list[0]!.headline, "run 25", "newest first");
  assert.equal(list[19]!.headline, "run 6", "the oldest 5 aged out");
  assert.ok(!list.some((r) => r.headline === "run 5"), "run 5 was dropped, not kept");
});

test("a filed review survives a restart: written under the instance dir, read back on load", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const inbox = await ReviewInbox.load(paths);
    assert.deepEqual(inbox.list(), [], "a fresh instance starts empty");

    await inbox.file(record({ jobId: "job-007", level: "L1", verdict: "rework", headline: "auth is wrong" }));
    await inbox.file(record({ jobId: "job-008", level: "L2", verdict: "fix-commit", headline: "tests thin" }));

    // It lands under the instance's own .dispatch/, never in a repo tree.
    assert.equal(paths.reviewInbox, path.join(paths.dispatch, "inbox.json"));
    const raw = JSON.parse(await readFile(paths.reviewInbox, "utf8"));
    assert.equal(raw.length, 2);

    // A whole new session (a fresh load off the same disk) sees both, newest first.
    const reloaded = await ReviewInbox.load(paths);
    assert.deepEqual(
      reloaded.list().map((r) => r.jobId),
      ["job-008", "job-007"],
    );
    assert.equal(reloaded.list()[1]!.body, "went right: everything.", "the full body round-trips");
    assert.equal(reloaded.list()[0]!.verdict, "fix-commit");
  } finally {
    await cleanup();
  }
});

test("the persisted list is capped too, so a restart never reloads more than 20", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const inbox = await ReviewInbox.load(paths);
    for (let i = 1; i <= 23; i++) {
      await inbox.file(record({ jobId: `job-${i}`, headline: `run ${i}` }));
    }
    const reloaded = await ReviewInbox.load(paths);
    assert.equal(reloaded.list().length, 20);
    assert.equal(reloaded.list()[0]!.headline, "run 23");
  } finally {
    await cleanup();
  }
});

test("a corrupt or hand-mangled inbox file loads as empty rather than failing the session", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    await mkdir(paths.dispatch, { recursive: true });
    await writeFile(paths.reviewInbox, "{not json at all", "utf8");
    assert.deepEqual((await ReviewInbox.load(paths)).list(), []);

    // Well-formed JSON, malformed records: the good ones survive, the rest go.
    await writeFile(
      paths.reviewInbox,
      JSON.stringify([record({ headline: "keeper" }), { verdict: "nonsense" }, 42]),
      "utf8",
    );
    const loaded = await ReviewInbox.load(paths);
    assert.equal(loaded.list().length, 1);
    assert.equal(loaded.list()[0]!.headline, "keeper");
  } finally {
    await cleanup();
  }
});

// --- verdict → level ---------------------------------------------------------

test("verdict maps to level: rework/escalation → L1, fix-commit or accept-with-notes → L2, clean accept → L3", () => {
  assert.equal(levelFor("rework"), "L1");
  assert.equal(levelFor("fix-commit"), "L2");
  assert.equal(levelFor("accept"), "L3");

  // Notes promote an accept to L2, but never past it.
  assert.equal(levelFor("accept", { notes: true }), "L2");
  // A genuine escalation/fork promotes anything to L1.
  assert.equal(levelFor("accept", { escalation: true }), "L1");
  assert.equal(levelFor("fix-commit", { escalation: true }), "L1");
  assert.equal(levelFor("rework", { notes: true }), "L1");
});

// --- the chat gating (in isolation) -----------------------------------------

test("L2 emits exactly one dim pointer line; L1 and L3 emit none", () => {
  const emitted: string[] = [];
  const deliver = (r: ReviewRecord): void => {
    const line = reviewChatLine(r);
    if (line) emitted.push(line);
  };

  deliver(record({ level: "L3", verdict: "accept", headline: "clean run" }));
  assert.deepEqual(emitted, [], "L3 says nothing at all");

  deliver(record({ level: "L1", verdict: "rework", headline: "auth is wrong" }));
  assert.deepEqual(emitted, [], "L1 is silent here too — the co speaks the decision itself");

  deliver(record({ level: "L2", verdict: "fix-commit", headline: "tests are thin" }));
  assert.equal(emitted.length, 1, "L2 emits exactly one line");
  assert.equal(emitted[0], c.dim("review filed (L2): tests are thin — Ctrl-O > Inbox"));
  assert.ok(!emitted[0]!.includes("went right"), "the body never reaches the chat");
});

test("the filed note tells the co what it may still say, per level", () => {
  const levels: ReviewLevel[] = ["L1", "L2", "L3"];
  for (const l of levels) assert.ok(filedNote(l).length > 0);
  assert.match(filedNote("L1"), /core decision/i);
  assert.match(filedNote("L2"), /nothing further/i);
  assert.match(filedNote("L3"), /silently/i);
});

// --- the file_review tool ----------------------------------------------------

/**
 * The executor over a real inbox, wired exactly as session.ts wires it: the tool
 * callback is the shared fileReviewInto, standing in for the run currently under
 * review. Only the clock and the chat sink are test-owned.
 */
async function toolHarness(paths: InstancePaths) {
  const inbox = await ReviewInbox.load(paths);
  const chat: string[] = [];
  const execute = makeExecutor({
    paths,
    research: {} as ResearchConfig,
    effects: newSideEffects(),
    onFileReview: async (input) =>
      (
        await fileReviewInto({
          inbox,
          input,
          job: { id: "job-042", feature: "under-review" },
          now: "2026-07-24T11:30:00.000Z",
          emit: (line) => chat.push(line),
        })
      ).result,
  });
  let n = 0;
  return {
    inbox,
    chat,
    call: (input: Record<string, unknown>) =>
      execute({ type: "tool_use", id: `t${++n}`, name: "file_review", input }),
  };
}

test("file_review writes a structured record into the inbox and returns what to say next", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const h = await toolHarness(paths);
    const res = await h.call({
      level: "L2",
      verdict: "fix-commit",
      headline: "landed, but the migration is untested",
      body: "Went right: the endpoint ships.\nWent wrong: no test on the migration.\nVerdict: fix-commit.",
      feature: "auth",
    });
    assert.ok(!res.is_error, String(res.content));
    const out = JSON.parse(String(res.content));
    assert.equal(out.filed, true);
    assert.equal(out.level, "L2");
    assert.equal(out.inboxCount, 1);
    assert.match(out.next, /nothing further/i);

    const stored = h.inbox.list()[0]!;
    assert.equal(stored.verdict, "fix-commit");
    assert.equal(stored.level, "L2");
    assert.equal(stored.feature, "auth");
    assert.equal(stored.jobId, "job-042", "defaults to the run under review");
    assert.match(stored.body, /migration/);

    // And it persisted: a fresh load sees it.
    assert.equal((await ReviewInbox.load(paths)).list().length, 1);

    // The gate ran once, at L2.
    assert.deepEqual(h.chat, [c.dim("review filed (L2): landed, but the migration is untested — Ctrl-O > Inbox")]);
  } finally {
    await cleanup();
  }
});

test("an L3 filing writes the record and prints nothing", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const h = await toolHarness(paths);
    const res = await h.call({
      level: "L3",
      verdict: "accept",
      headline: "chore landed clean",
      body: "Went right: all criteria met. Verdict: accept.",
    });
    assert.ok(!res.is_error);
    assert.equal(h.inbox.list().length, 1, "still filed");
    assert.deepEqual(h.chat, [], "and completely silent");
  } finally {
    await cleanup();
  }
});

test("a filing defaults its job and feature to the run under review, or records manual", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const h = await toolHarness(paths);
    // The co omits both: they come from the run it was just handed.
    await h.call({ level: "L3", verdict: "accept", headline: "no ids given", body: "fine." });
    const filed = h.inbox.list()[0]!;
    assert.equal(filed.jobId, "job-042");
    assert.equal(filed.feature, "under-review");

    // Filed outside a review turn (a report the captain relayed by hand).
    const inbox = ReviewInbox.ephemeral();
    const { record } = await fileReviewInto({
      inbox,
      input: { level: "L2", verdict: "fix-commit", headline: "relayed by hand", body: "b" },
      job: null,
      now: "2026-07-24T12:00:00.000Z",
      emit: () => {},
    });
    assert.equal(record.jobId, "manual");
    assert.equal(record.feature, undefined);
  } finally {
    await cleanup();
  }
});

test("file_review rejects a bad level, verdict, or an empty headline/body", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const h = await toolHarness(paths);
    const base = { level: "L2", verdict: "accept", headline: "x", body: "y" };
    for (const bad of [
      { ...base, level: "L4" },
      { ...base, verdict: "ship-it" },
      { ...base, headline: "   " },
      { ...base, body: "" },
    ]) {
      const res = await h.call(bad);
      assert.ok(res.is_error, `expected a refusal for ${JSON.stringify(bad)}`);
    }
    assert.equal(h.inbox.list().length, 0, "nothing was filed");
  } finally {
    await cleanup();
  }
});

test("file_review is always exposed — a review can be filed for a run the captain relayed by hand", () => {
  const unlinked = toolDefinitions().map((t) => t.name);
  assert.ok(unlinked.includes("file_review"), "present without a repo link");
  const linked = toolDefinitions({ dispatch: true }).map((t) => t.name);
  assert.ok(linked.includes("file_review"));
  // And its schema pins the two vocabularies the panel and the gate rely on.
  const def = toolDefinitions().find((t) => t.name === "file_review")!;
  const props = def.input_schema.properties as Record<string, { enum?: string[] }>;
  assert.deepEqual(props.level?.enum, ["L1", "L2", "L3"]);
  assert.deepEqual(props.verdict?.enum, ["accept", "fix-commit", "rework"] satisfies ReviewVerdict[]);
});
