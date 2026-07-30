import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { instancePaths, type InstancePaths } from "../paths.js";
import { createInstance } from "../memory/memory.js";
import { buildSystemPrompt } from "./prompt.js";
import type { ResearchConfig } from "../config.js";
import {
  PROTOCOL_SECTIONS,
  protocolBody,
  protocolIndex,
  protocolSectionsFor,
} from "./protocols.js";
import { toolDefinitions } from "./tools.js";
import { SURFACED_DOC_MAX_CHARS } from "../memory/docs.js";

/**
 * TWO TIERS, and the difference matters to every test below.
 *
 * The PERMANENT tier is the system prompt: re-sent on every round of every turn,
 * so only what the co needs every turn belongs in it. The ON-DEMAND tier is
 * protocols.ts, pulled in with `read_protocol` when the co is about to act.
 *
 * So a behavioural guarantee is "this prose is REACHABLE" (assert against
 * `reachable()`), not "this prose is in the prompt" — moving a section between
 * tiers is a cost decision and must not read as a behaviour regression. What
 * tier each piece lives in is pinned separately and deliberately, at the bottom
 * of this file, together with the prefix budget.
 *
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

/** Just the `## Task table` section of an assembled prompt, up to the next
 *  heading — so a size or wording assertion about that section cannot be
 *  satisfied (or broken) by prose somewhere else in the system prompt. */
function taskTableSection(prompt: string): string {
  const at = prompt.indexOf("## Task table");
  assert.ok(at > 0, "the prompt has a task-table section");
  const rest = prompt.slice(at);
  const end = rest.indexOf("\n## ", 1);
  return end < 0 ? rest : rest.slice(0, end);
}

const RESEARCH = {} as ResearchConfig;

const DISPATCH = {
  repoPath: "/repo",
  transport: "a visible pane",
  agents: ["cc"],
  defaultAgent: "cc",
};

/**
 * Everything the co can put in front of itself on a linked instance: the
 * permanent prompt plus every on-demand protocol section. This is the surface a
 * behavioural assertion should be made against.
 */
async function reachable(paths: InstancePaths): Promise<string> {
  const prompt = await buildSystemPrompt(paths, RESEARCH, { dispatch: DISPATCH });
  return [prompt, ...PROTOCOL_SECTIONS.map((s) => protocolBody(s))].join("\n\n");
}

test("the orders protocol tells the crew to commit with no attribution trailer", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const prompt = await reachable(paths);
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
    const prompt = await reachable(paths);
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
    const prompt = await reachable(paths);
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
    const prompt = await reachable(paths);
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
    const prompt = await reachable(paths);
    assert.match(prompt, /\*\*Close the report\*\*/);
    assert.match(prompt, /diffstat: files changed, insertions, deletions/);
    assert.match(prompt, /verification it actually ran, with the real output/);
    assert.match(
      prompt,
      /approaches it tried and abandoned, with the reason each was dropped/,
      "the How section's material has to come from somewhere",
    );
    // And the crew is told how LONG to make it. Nothing truncates that report by
    // design, so its length is decided entirely by what the order asked for — a
    // crew told to "report what you did" writes an essay the co then carries in
    // context for the rest of the session.
    assert.match(prompt, /Hard limit: 50 lines for the whole report/);
    assert.match(prompt, /end the report by stating its own\s+line count/);
  } finally {
    await cleanup();
  }
});

test("the panel's `e` editor is in the protocol, with the captain's version winning", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const prompt = await reachable(paths);
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

test("the five row commands are named, and addressed by exact text", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const prompt = await buildSystemPrompt(paths, RESEARCH);
    for (const command of ["list", "add", "status", "rename", "retire"]) {
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

/**
 * `rename` is the one command that can fail on the shape of its SECOND argument,
 * and a model that does not know that writes a call it has to be told about. All
 * four refusals are in the protocol, and so is the case that looks like a
 * refusal and is not.
 */
test("rename is documented with what it keeps and every way it fails", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const prompt = await buildSystemPrompt(paths, RESEARCH);
    assert.match(
      prompt,
      /rewrite one row's TEXT/,
      "what it does, in the words that separate it from add-and-retire",
    );
    assert.match(prompt, /keeping its status and its place/, "and the two things that survive it");
    assert.match(
      prompt,
      /the old text\s+matches no row, the old text matches more than one, \\?`new_task\\?` is empty or only\s+whitespace, or \\?`new_task\\?` would read the same as a DIFFERENT row/,
      "all four refusals, named",
    );
    assert.match(
      prompt,
      /Renaming a\s+row to the text it already has is a successful no-op/,
      "and the case that must NOT be read as the collision refusal",
    );
    assert.match(prompt, /changes nothing when it does/, "a refused rename is not a partial write");
  } finally {
    await cleanup();
  }
});

/**
 * The display order, stated where the co reads the table rather than left to be
 * inferred from the rows it happens to be handed. Two halves matter: `building`
 * comes first, and it is a VIEW — a co that read stored order out of the block
 * would start reasoning about which row was added when.
 */
test("the prompt says the table is painted building-first, and that it is a view", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const prompt = await buildSystemPrompt(paths, RESEARCH);
    assert.match(prompt, /\*\*The table is displayed \\?`building\\?` first\*\*/);
    assert.match(
      prompt,
      /each group keeping\s+the order it was stored in/,
      "stored order survives inside each group",
    );
    assert.match(
      prompt,
      /the stored table keeps insertion order/,
      "so a position in the painted table is not a position in the store",
    );
    assert.match(
      prompt,
      /toggling a row's status moves it in the display without rewriting anything/,
      "the consequence the co would otherwise have to be told twice",
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

test("the live-state table is painted building-first, through the shared helper", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    // Stored order, deliberately not the display order: the row being worked was
    // added last, which is exactly the case the change exists for.
    const rows = [
      { task: "waiting a", status: "queued" as const },
      { task: "waiting b", status: "queued" as const },
      { task: "being worked", status: "building" as const },
    ];
    const prompt = await buildSystemPrompt(paths, RESEARCH, { tasks: rows });
    const block = prompt.slice(prompt.indexOf("### task table"));
    const order = ["being worked", "waiting a", "waiting b"].map((t) => block.indexOf(t));
    assert.ok(order.every((n) => n > 0), "every row is in the block");
    assert.deepEqual([...order].sort((a, b) => a - b), order, "building first, stored order under it");

    // The helper's determinism is what keeps this block inside the cache prefix:
    // the same rows must render the same bytes on every assembly.
    assert.equal(await buildSystemPrompt(paths, RESEARCH, { tasks: rows }), prompt);
  } finally {
    await cleanup();
  }
});

/**
 * The system prompt is under a size review and this section overlaps heavily with
 * the `task_table` tool description, which the model reads anyway. So the section
 * has a budget: it may shrink, and it may not grow back. 3,300 bytes is the size
 * it came down to when the row cap left it (3,533 before), rounded up a hair so a
 * one-word clarification is not a test failure.
 */
test("the task-table section stays inside its size budget", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const section = taskTableSection(await buildSystemPrompt(paths, RESEARCH));
    const bytes = Buffer.byteLength(section, "utf8");
    assert.ok(bytes <= 3300, `the task-table section is ${bytes} bytes, over its 3300-byte budget`);
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
    // The restraint is now guidance and ONLY guidance: nothing refuses an add on
    // a row count, so a protocol that still promised a ceiling would have the co
    // decline work the store allows and hand the captain a wall that isn't there.
    const section = taskTableSection(prompt);
    assert.doesNotMatch(section, /Maximum \d+ rows|\d+ rows maximum|at most \d+ rows/, "no ceiling is promised");
    assert.match(section, /Nothing caps the table, so that restraint is yours to keep/);
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

test("the two lanes are in the protocol: which verb grants which, and who is enforced", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const prompt = await reachable(paths);
    // The old cap is gone from the prose as well as the code. A prompt that
    // still said a second dispatch is refused would have the co decline work the
    // harness now allows, and no test would catch it.
    assert.ok(
      !prompt.includes("a second dispatch while one is live is refused"),
      "the one-agent cap is gone from the protocol",
    );
    assert.match(prompt, /Two lanes in one worktree/);
    // The hazard, named — this is what makes the default the read-only one.
    assert.match(
      prompt,
      /one \\?`\.git\/index\\?`, one \\?`dist\/\\?` and one \\?`node_modules\\?`/,
      "why two writers are a hazard at all",
    );
    assert.match(
      prompt,
      /sweeps it into a commit that looks legitimate and\s+is not/,
      "and that the failure is invisible rather than loud",
    );
    // The two verbs, each bound to its lane. These are the words the captain
    // types, so they are pinned literally.
    assert.match(prompt, /\*\*\\?`confirm\\?` grants the READ-ONLY lane\.\*\*/);
    assert.match(prompt, /\*\*\\?`confirm write\\?` grants a SECOND WRITING lane\.\*\*/);
    assert.match(prompt, /Anything else still cancels/, "the interlock is otherwise unchanged");
    // The mandate forbids every write, not merely commits.
    assert.match(
      prompt,
      /no \\?`git add\\?` \/\s+\\?`commit\\?` \/ \\?`stash\\?`, no install, no build, no test run that emits artifacts/,
      "the read-only mandate is total, not commit-shaped",
    );
    // And the honesty rule about enforcement, which is the thing a prompt could
    // most easily over-claim.
    assert.match(
      prompt,
      /for an agent with no such flags the lane is advisory, and you should say so\s+plainly/,
      "an advisory lane is never described as sandboxed",
    );
    assert.match(prompt, /The captain chooses the lane, not you/);
  } finally {
    await cleanup();
  }
});

test("an audit run gets no verdict, and only a writer blocks the levers", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const prompt = await reachable(paths);
    // The routing rule. The co reviews EVERY completion by standing instruction,
    // so the exception has to be explicit or an audit picks up an accept/rework
    // verdict for work that was never done.
    assert.match(prompt, /\*\*A read-only run's result is NOT a review\.\*\*/);
    assert.match(prompt, /Do NOT give it a verdict, and do not treat it\s+as work delivered/);
    assert.match(prompt, /Answer\s+the captain with what it found/);
    // The review protocol's own completion bullet has to agree with it.
    assert.match(
      prompt,
      /that comes back as\s+context to answer with, and you give it no verdict/,
      "stated where the co reads about completions, not only in the lanes section",
    );
    // The role-aware guard, and the consequence the co would otherwise misread.
    assert.match(prompt, /\*\*Only a WRITER blocks the levers\.\*\*/);
    assert.match(
      prompt,
      /A feature with only readers in it enqueues, lands and abandons\s+normally/,
      "a reader holds no index, so it has no claim on a landing",
    );
    assert.match(
      prompt,
      /a landing\s+you expected to be held may simply proceed; that is correct/,
      "said plainly, so the co does not report a working landing as a bug",
    );
  } finally {
    await cleanup();
  }
});

test("an ungated head comes with the offer to add a CI workflow, and never a held merge", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const prompt = await reachable(paths);
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

// --- the two tiers, and the budget --------------------------------------------
//
// Everything above asserts behaviour is reachable. These assert WHERE it lives
// and what it costs, which is a different guarantee and the one that rots.
//
// The prefix is re-sent on every round of every turn, so a section added to it
// is paid for tens of times a session forever. It had grown to ~99,000 characters
// before this split, 20% of that added by two feature PRs in a single week, and
// nothing anywhere failed when it did. That is what these tests are for.

/** The whole cache prefix: system prompt plus the tool schemas on the wire. */
async function prefixChars(paths: InstancePaths): Promise<number> {
  const prompt = await buildSystemPrompt(paths, RESEARCH, { dispatch: DISPATCH });
  return prompt.length + JSON.stringify(toolDefinitions({ dispatch: true })).length;
}

test("the cache prefix stays inside its budget", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    // A fresh instance carries almost no live state, so this measures the
    // CODE-OWNED prefix: protocol prose plus tool schemas. Live instances add
    // their own memory on top, which is the captain's content and budgeted
    // separately (SURFACED_DOC_MAX_CHARS).
    //
    // If this fails, the question is not "raise the budget". It is which tier the
    // new prose belongs in: something needed every turn goes in the prompt and
    // something needed occasionally goes in protocols.ts behind read_protocol.
    // A RATCHET, not a target. It sits just above the current figure so any
    // meaningful addition trips it, and it comes DOWN as more prose moves to the
    // on-demand tier — it must never go up. Still to move, in rough order of
    // size: the orders protocol, the task-table command reference, and the
    // review protocol's detail (the level gate itself stays permanent). Those
    // three are worth roughly another 5,000 characters. (The orders protocol has
    // already moved; what remains is the task-table command reference and the
    // review protocol's detail, plus a pass over the tool descriptions.)
    const BUDGET = 51_500;
    const actual = await prefixChars(paths);
    assert.ok(
      actual <= BUDGET,
      `code-owned prefix is ${actual} chars, over the ${BUDGET} budget by ${actual - BUDGET}.` +
        ` Move occasional prose into protocols.ts rather than raising this.`,
    );
  } finally {
    await cleanup();
  }
});

test("the occasional protocol detail is NOT in the permanent prompt", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const prompt = await buildSystemPrompt(paths, RESEARCH, { dispatch: DISPATCH });
    // The five-section PR template, the queue mechanics and the lane rules are
    // needed on the turns that dispatch or land, which most sessions never have.
    // Each of these strings living in the prompt again means a silent regression
    // to paying for them on every round of every turn.
    assert.ok(!prompt.includes("## Other Notes"), "the PR template moved on demand");
    assert.ok(!prompt.includes("Two lanes in one worktree"), "the lane rules moved on demand");
    assert.ok(
      !prompt.includes("feature_abandon(name)"),
      "the feature lever reference moved on demand",
    );
    // And the co is told, imperatively, to go and get them.
    assert.match(prompt, /read_protocol/);
    for (const section of PROTOCOL_SECTIONS) {
      assert.ok(prompt.includes(`\`${section}\``), `the index must name ${section}`);
    }
  } finally {
    await cleanup();
  }
});

test("the guardrails stay permanent, because they bind every turn", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const prompt = await buildSystemPrompt(paths, RESEARCH, { dispatch: DISPATCH });
    // These are not reference material the co looks up when it needs them: they
    // constrain what it does on turns where it has no idea a rule applies. A
    // guardrail behind a tool call is a guardrail that does not fire.
    assert.match(prompt, /never announce, narrate, or ask\s+permission to write to memory/i);
    assert.match(prompt, /never write over a\s+row you did not name/i);
    assert.match(prompt, /You never inspect, edit, or run the user's source code/);
    assert.match(prompt, /gated by the captain's typed\s+confirm/);
    // Silence-by-default on a completed run binds on every completion, with no
    // lookup in between: a review the co speaks before checking a protocol is a
    // review the captain has already had to read.
    assert.match(prompt, /Silence is the default and it is total/);
    assert.match(prompt, /say nothing at all, and let the run pass/);
  } finally {
    await cleanup();
  }
});

test("every protocol section is reachable and self-titled", () => {
  for (const section of PROTOCOL_SECTIONS) {
    const body = protocolBody(section);
    assert.ok(body.length > 500, `${section} looks truncated at ${body.length} chars`);
    assert.match(body, /^### /, `${section} must carry its own heading once pulled in`);
    // The extraction from the prompt escaped backticks for a template literal;
    // a stray escape would reach the model as a literal backslash.
    assert.ok(!body.includes("\\`"), `${section} has escaped backticks in its value`);
  }
});

test("the index tells the co when to read, not just what exists", () => {
  const index = protocolIndex({ dispatch: true });
  // A passive table of contents does not reliably trigger a read, and a section
  // that is never read is prose the co improvises around.
  assert.match(index, /BEFORE you act/);
  assert.match(index, /read it before/i);
  // Every section, linked or not, states its trigger.
  for (const line of index.split("\n").filter((l) => l.startsWith("- ")))
    assert.match(line, /read it before/i, line);
  assert.equal(PROTOCOL_SECTIONS.every((s) => index.includes(s)), true);

  // An unlinked instance lists only what it can actually reach — offering a
  // section whose tool argument would be rejected is worse than not offering it.
  // `orders` is there either way: an unlinked co still writes orders.
  const unlinked = protocolIndex({});
  assert.match(unlinked, /`orders`/);
  assert.ok(!unlinked.includes("`pr-message`"));
  assert.deepEqual(protocolSectionsFor({}), ["orders"]);
  assert.deepEqual(protocolSectionsFor({ dispatch: true }), [...PROTOCOL_SECTIONS]);
});

test("a surfaced doc is truncated into the prefix, with a pointer to the rest", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const { createDoc } = await import("../memory/docs.js");
    // architecture.md gets a privileged cold-start read, so an unbounded one is
    // charged on every round of every turn. Measured instances had reached
    // 19,276 characters with no discipline anywhere in that path.
    const huge = Array.from({ length: 400 }, (_, i) => `paragraph ${i} of the design`).join(
      "\n\n",
    );
    await createDoc(paths, "architecture.md", huge);
    const prompt = await buildSystemPrompt(paths, RESEARCH, { dispatch: DISPATCH });
    assert.ok(!prompt.includes("paragraph 399"), "the tail must not reach the prefix");
    assert.match(prompt, /Truncated at/, "and the co must be told there is more");
    assert.match(prompt, /doc read architecture\.md/, "with how to get the rest on demand");
    // Budgeted, not refused: the doc is the captain's and a session must start.
    assert.match(prompt, /paragraph 0 of the design/);
    assert.ok(SURFACED_DOC_MAX_CHARS > 0);
  } finally {
    await cleanup();
  }
});
