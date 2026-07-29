import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { instancePaths, type InstancePaths } from "../paths.js";
import { createInstance } from "../memory/memory.js";
import { buildSystemPrompt } from "./prompt.js";
import { TASK_TABLE_CAP } from "./taskstore.js";
import type { ResearchConfig } from "../config.js";

/**
 * The parts of the system prompt that are load-bearing for what co's work LOOKS
 * LIKE in the repo afterwards: the commit message the crew is told to write, and
 * the branch a feature is cut on. Both are prose the model acts on rather than
 * code that enforces itself, which is exactly why they are pinned here — a
 * silent edit to either changes the git history of every project co touches.
 *
 * The ungated nudge is pinned for the same reason. co gates on the PR's real
 * checks now, so a repo with no CI workflow lands everything ungated; the only
 * thing that tells the captain WHY, and offers the fix, is this prose.
 *
 * So is the pull request template, and the report contract that feeds it. The PR
 * body is the permanent record of a feature and co writes it without ever seeing
 * the diff, so the shape it writes to and the material the crew is told to hand
 * back are one mechanism, pinned together.
 *
 * And so is the task table's tool contract: the panel paints the STORE, so a
 * prompt that stopped telling the co to write through `task_table` would leave
 * the Home tab quietly showing yesterday's table with nothing broken to notice.
 */

async function makeInstance(): Promise<{ paths: InstancePaths; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "co-prompt-"));
  await createInstance(home, "inst");
  return {
    paths: instancePaths(home, "inst"),
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

const RESEARCH = {} as ResearchConfig;

const DISPATCH = {
  repoPath: "/repo",
  transport: "a visible pane",
  agents: ["cc"],
  defaultAgent: "cc",
};

test("the orders protocol tells the crew to commit with no attribution trailer", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const prompt = await buildSystemPrompt(paths, RESEARCH);
    assert.match(prompt, /Conventional Commits form/);
    assert.match(prompt, /use EXACTLY the message you give/);
    assert.match(prompt, /no\s+`Co-Authored-By` line/);
    assert.match(prompt, /no "Generated with" line/);
    assert.match(prompt, /attribution\s+trailer of any kind/);
  } finally {
    await cleanup();
  }
});

test("the features protocol names branches <type>/<slug> and ownership by worktree", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const prompt = await buildSystemPrompt(paths, RESEARCH, { dispatch: DISPATCH });
    assert.match(prompt, /<type>\/<slug>/, "the branch shape co should expect");
    assert.match(prompt, /feature_create\(name, type, intent\)/);
    assert.match(prompt, /fix\/stale-token-bug/, "with a worked example of choosing the type");
    assert.match(
      prompt,
      /identified by the WORKTREE co provisioned for it, never by its\s+branch name/,
      "and the ownership rule, so co never claims a human's branch",
    );
    assert.ok(!prompt.includes("co/feat-"), "the old branch prefix is gone from the protocol");

    // Unlinked instances get no dispatch section at all, so none of this leaks
    // into a prompt where the feature levers do not exist.
    const unlinked = await buildSystemPrompt(paths, RESEARCH);
    assert.ok(!unlinked.includes("<type>/<slug>"));
  } finally {
    await cleanup();
  }
});

test("enqueue is where co writes the PR message, in the house style", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const prompt = await buildSystemPrompt(paths, RESEARCH, { dispatch: DISPATCH });
    assert.match(prompt, /feature_enqueue\(name, prTitle, prBody\)/, "the lever carries the message");
    assert.match(prompt, /You write the pull request's message/);
    assert.match(prompt, /Writing the pull request message/, "and the template it is written to");
    assert.match(
      prompt,
      /No bot voice, no attribution, nothing about how the work was\s+produced/,
      "the house PR style: no co provenance anywhere in it (D-20260724-17)",
    );
    assert.match(
      prompt,
      /The rule is about the ACTOR, not the\s+vocabulary: never name who performed the work/,
      "said again for the body, and as the distinction that keeps it from over-firing",
    );
    assert.match(
      prompt,
      /crew reports the suite is\s+green/,
      "with the actor phrasing it forbids",
    );
    assert.match(
      prompt,
      /co-manager composes the PR body but never sees the diff/,
      "and the product noun as SUBJECT it allows",
    );
    assert.match(prompt, /"`tsc --noEmit` clean"/, "with behaviour standing in for the actor");
    assert.match(
      prompt,
      /a re-enqueue with\s+no message keeps the one you wrote/,
      "so a retry never silently reverts to the mechanical fallback",
    );
  } finally {
    await cleanup();
  }
});

test("the PR body is the five-section template, verification separated from claim", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const prompt = await buildSystemPrompt(paths, RESEARCH, { dispatch: DISPATCH });
    // The section list is the whole point of the template, and its ORDER is part
    // of it, so it is pinned as a sequence rather than five loose matches.
    assert.match(
      prompt,
      /`## What`[\s\S]*`## Why`[\s\S]*`## How`[\s\S]*`## Testing`[\s\S]*`## Other Notes`/,
      "five sections, in order",
    );
    assert.match(prompt, /One line, imperative, specific/, "the title rule");
    assert.match(prompt, /Drop a section you would leave empty/, "no scaffolding on a trivial change");
    // The form constraint is the whole reason the body stays readable, so the
    // caps are pinned as numbers and not just as "keep it short".
    assert.match(
      prompt,
      /Bullets only, no paragraphs anywhere in the body/,
      "sections are lists, never prose",
    );
    assert.match(
      prompt,
      /Three bullets to a section\s+is typical, five is the absolute maximum/,
      "with hard caps, so a section cannot grow back into a paragraph",
    );
    assert.match(
      prompt,
      /one short\s+sentence on one line/,
      "and a bullet cannot become a paragraph on its own",
    );
    assert.match(
      prompt,
      /deliberate trade\s+for a body a reviewer will actually read, not an oversight/,
      "the lost detail is a known cost, not a gap for someone to restore prose over",
    );
    assert.match(prompt, /roads not taken/, "How is where the abandoned approaches go");
    assert.match(
      prompt,
      /what was ACTUALLY DONE to verify the change/,
      "Testing is a record of verification, not a to-do list",
    );
    assert.match(
      prompt,
      /never turn "tests\s+pass" into\s+"verified"/,
      "co never saw the diff, so the crew's report stays a report",
    );
    assert.match(
      prompt,
      /verification record unavailable/,
      "and with no record it says so rather than inventing checks",
    );
    assert.match(
      prompt,
      /Never duplicate the harness's appended evidence block/,
      "the commit list and the checks result are the harness's, not the body's",
    );
    assert.ok(!prompt.includes("no headings ceremony"), "the old short-prose instruction is gone");

    const unlinked = await buildSystemPrompt(paths, RESEARCH);
    assert.ok(!unlinked.includes("## Other Notes"), "the template rides with the dispatch section");
  } finally {
    await cleanup();
  }
});

test("every order makes the crew close its report with the material the PR needs", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    // Unlinked too: the checklist is the orders protocol, which every session has.
    const prompt = await buildSystemPrompt(paths, RESEARCH);
    assert.match(prompt, /\*\*Close the report\*\*/);
    assert.match(prompt, /diffstat \(files changed, insertions, deletions\)/);
    assert.match(prompt, /verification it\s+actually ran, with the real output/);
    assert.match(
      prompt,
      /approaches it tried and abandoned,\s+with the reason each was dropped/,
      "the How section's material has to come from somewhere",
    );
  } finally {
    await cleanup();
  }
});

test("the panel's `e` editor is in the protocol, with the captain's version winning", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const prompt = await buildSystemPrompt(paths, RESEARCH, { dispatch: DISPATCH });
    // The co is the only thing that can tell the captain the key exists, so the
    // key itself is pinned, not just the idea of editing.
    assert.match(prompt, /`e` in the queue tab edits your PR message/);
    assert.match(prompt, /Ctrl-S to write it back/, "and how the edit is committed");
    assert.match(
      prompt,
      /never re-send yours over it with another\s+`feature_enqueue`/,
      "an edit of theirs is not something co undoes with its own draft",
    );
  } finally {
    await cleanup();
  }
});

test("the task table is a shared surface the captain owns, not the co's own block", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    // Unlinked too: the table needs no repo, so every session has it.
    const prompt = await buildSystemPrompt(paths, RESEARCH);
    assert.match(prompt, /\*\*The table is the CAPTAIN'S, and you are the second writer on it\.\*\*/);
    assert.match(prompt, /`task_table`/, "the tool that stores it is named");
    assert.match(prompt, /Ctrl-O, Home\s+tab/, "and where the captain reads and edits it");
    // The two rules that make two writers safe. Both are prose the model acts
    // on, so both are pinned: losing either turns a shared table into a table
    // the co quietly overwrites (D-20260729-3).
    assert.match(prompt, /\*\*never write over a\s+row you did not name\*\*/);
    assert.match(prompt, /\*\*never assume a row you did not add is stale\.\*\*/);
    assert.match(
      prompt,
      /There is no whole-table\s+write and no clear/,
      "the capability that made the co a hazard here is gone, and it says so",
    );
    assert.match(
      prompt,
      /update the store in the same turn|update it in the same turn/,
      "the behaviour change: keeping the store current is the point",
    );
    // The at-a-glance rules the table has always had are still the rules.
    assert.match(prompt, /at-a-glance, not a tracker/);
  } finally {
    await cleanup();
  }
});

test("the four row commands are named, and addressed by exact text", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const prompt = await buildSystemPrompt(paths, RESEARCH);
    for (const command of ["list", "add", "status", "retire"]) {
      assert.match(prompt, new RegExp(`- \\\`${command}\\\` —`), `${command} is described`);
    }
    assert.match(
      prompt,
      /by its EXACT task text — never by position/,
      "an index goes stale between turns when the captain is also writing",
    );
    assert.match(
      prompt,
      /matches no row, or more than one,\s+fails rather than guessing/,
      "the same failure posture the doc tool's str_replace takes",
    );
    assert.match(
      prompt,
      /\*\*This is what "done" means here:\*\*/,
      "done retires a row out of the table; it is not a third status",
    );
  } finally {
    await cleanup();
  }
});

test("the table is in the live-state block, read once and stable for the session", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const rows = [
      { task: "Fix crew handoff truncation", status: "building" as const },
      { task: "Ctrl-O home page cleanup", status: "queued" as const },
    ];
    const prompt = await buildSystemPrompt(paths, RESEARCH, { tasks: rows });
    // It sits inside Live state, beside the brief and the active context — the
    // point of the whole change is that a row the captain jotted reaches the co.
    const liveAt = prompt.indexOf("## Live state (current reality)");
    const tableAt = prompt.indexOf("### task table");
    assert.ok(liveAt > 0 && tableAt > liveAt, "the table block is inside live state");
    assert.match(prompt, /building\s+Fix crew handoff truncation/);
    assert.match(prompt, /queued\s+Ctrl-O home page cleanup/);

    // The block is a pure function of the rows passed in. That is what keeps the
    // cache prefix byte-stable: nothing here re-reads the store, and nothing
    // here is a clock.
    assert.equal(await buildSystemPrompt(paths, RESEARCH, { tasks: rows }), prompt);
    const moved = await buildSystemPrompt(paths, RESEARCH, {
      tasks: [{ task: "Fix crew handoff truncation", status: "queued" }],
    });
    assert.notEqual(moved, prompt, "and a different table really does render differently");

    const empty = await buildSystemPrompt(paths, RESEARCH);
    assert.match(empty, /### task table[\s\S]*\(empty\)/, "an empty table says so rather than vanishing");
  } finally {
    await cleanup();
  }
});

test("the table's contract is two columns, two status words, and a bias against rows", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const prompt = await buildSystemPrompt(paths, RESEARCH);
    // The behaviour change: adding a row is the exception, not the reflex. A
    // table that grows a row per step is the tracker this is not meant to be.
    assert.match(prompt, /\*\*The default is NOT to add a row\.\*\*/);
    assert.match(
      prompt,
      /only when the captain asks for one, or when the item is\s+plainly a major future workstream/,
      "the two things that earn a row",
    );
    assert.match(
      prompt,
      /Intermediate and mechanical steps never belong/,
      "and the thing that never does",
    );
    // Pinned against the cap itself, so lowering it again cannot leave the
    // prompt promising the old number.
    assert.match(prompt, new RegExp(`Maximum ${TASK_TABLE_CAP} rows`), "the cap it is held to");
    assert.match(prompt, /Two columns, Status \| Task/, "Type is gone and status leads");
    assert.match(
      prompt,
      /\\?`building\\?` for the thing being worked right now, \\?`queued\\?` for anything waiting/,
      "the whole vocabulary, spelled out",
    );
    assert.match(prompt, /There is no third value/);
    // The captain's own two specifications, in his words: a task is one line
    // with no body, and it starts queued.
    assert.match(prompt, /one plain line of text with no\s+body/);
    assert.match(
      prompt,
      /A new task always arrives \\?`queued\\?`; it becomes \\?`building\\?` when work on it\s+actually starts/,
    );
  } finally {
    await cleanup();
  }
});

test("an ungated head comes with the offer to add a CI workflow, and never a held merge", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const prompt = await buildSystemPrompt(paths, RESEARCH, { dispatch: DISPATCH });
    assert.match(prompt, /An ungated head earns one nudge/);
    assert.match(
      prompt,
      /the repo\s+has no CI workflow producing checks on its pull requests/,
      "the cause is named, not just the symptom",
    );
    assert.match(prompt, /runs on \\?`pull_request`/, "and the fix it offers is a concrete one");
    assert.match(prompt, /Offer it once/, "a nudge, not a nag");
    assert.match(
      prompt,
      /never\s+withhold or delay a merge over it/,
      "ungated stays a valid, mergeable state",
    );
  } finally {
    await cleanup();
  }
});
