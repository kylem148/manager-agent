import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { instancePaths, type InstancePaths } from "../paths.js";
import { createInstance } from "../memory/memory.js";
import {
  buildStartupInjection,
  buildSystemPrompt,
  systemPromptSections,
  SECTION_BUDGETS,
  SYSTEM_BUDGET_BYTES,
  TOOLS_BUDGET_BYTES,
} from "./prompt.js";
import type { ResearchConfig } from "../config.js";
import {
  PROTOCOL_SECTIONS,
  PROTOCOL_BUDGETS,
  protocolBody,
  protocolSectionsFor,
} from "./protocols.js";
import { toolDefinitions } from "./tools.js";
import { SURFACED_DOC_MAX_CHARS } from "../memory/docs.js";

/**
 * The four-layer prompt stack, and the budgets that hold it together.
 *
 * Layer 1 is the RESIDENT prefix: the static system prompt plus the serialized
 * tool definitions, re-sent on every round of every turn under one cache
 * breakpoint. Its whole size is budgeted at 32,000 bytes and every section
 * carries its own byte ceiling — those are ratchets, not targets, and they are
 * the first thing pinned here because nothing else fails when prose creeps.
 *
 * Layer 3 is the STARTUP INJECTION: per-instance state (brief, orientation,
 * table, docs, tail, environment) injected once as the first message of
 * history. The system prompt must contain NONE of it, or the prefix stops
 * being static and the cache stops surviving restarts.
 *
 * Layer 4 is the ON-DEMAND protocol tier, byte-capped per section.
 *
 * Behavioural guarantees are asserted against `reachable()` — the prompt plus
 * every protocol section — so moving prose between tiers is a cost decision,
 * not a behaviour regression. WHERE prose lives is pinned separately.
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
  agents: ["cc", "oc"],
  defaultAgent: "cc",
};

/** Everything the co can put in front of itself on a linked instance. */
function reachable(): string {
  return [
    buildSystemPrompt({ dispatch: true }),
    ...PROTOCOL_SECTIONS.map((s) => protocolBody(s)),
  ].join("\n\n");
}

// --- layer 1: the resident budget ----------------------------------------------

test("every system prompt section fits its byte budget", () => {
  for (const s of systemPromptSections()) {
    const bytes = Buffer.byteLength(s.body, "utf8");
    const budget = SECTION_BUDGETS[s.name];
    assert.ok(budget !== undefined, `${s.name} has no budget`);
    assert.ok(
      bytes <= budget!,
      `section '${s.name}' is ${bytes} bytes, over its ${budget}-byte budget by ${bytes - budget!}`,
    );
  }
});

test("the whole resident prefix fits the 32K-byte budget, tools included", () => {
  const prompt = Buffer.byteLength(buildSystemPrompt({ dispatch: true }), "utf8");
  const tools = Buffer.byteLength(JSON.stringify(toolDefinitions({ dispatch: true })), "utf8");
  assert.ok(
    tools <= TOOLS_BUDGET_BYTES,
    `serialized tools are ${tools} bytes, over their ${TOOLS_BUDGET_BYTES}-byte share`,
  );
  assert.ok(
    prompt + tools <= SYSTEM_BUDGET_BYTES,
    `resident prefix is ${prompt + tools} bytes, over the ${SYSTEM_BUDGET_BYTES} budget.` +
      ` Move occasional prose into protocols.ts rather than raising this.`,
  );
});

test("every protocol section fits its byte cap", () => {
  for (const s of PROTOCOL_SECTIONS) {
    const bytes = Buffer.byteLength(protocolBody(s), "utf8");
    assert.ok(
      bytes <= PROTOCOL_BUDGETS[s],
      `protocol '${s}' is ${bytes} bytes, over its ${PROTOCOL_BUDGETS[s]}-byte cap`,
    );
  }
});

// --- layer 1 is static ----------------------------------------------------------

test("the system prompt is static: same bytes every call, no state, no clock", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const a = buildSystemPrompt({ dispatch: true });
    assert.equal(a, buildSystemPrompt({ dispatch: true }), "byte-identical across calls");
    // Nothing per-instance may reach the prefix: no paths, no dates, no live
    // state, no task table. Those ride the startup injection.
    assert.ok(!a.includes(paths.root), "no instance path in the prefix");
    assert.ok(!a.includes(new Date().toISOString().slice(0, 10)), "no date in the prefix");
    assert.ok(!a.includes("Task table (the captain's, painted"), "no table snapshot in the prefix");
    assert.ok(!a.includes("Recent conversation"), "no transcript tail in the prefix");
    assert.ok(!a.includes("projectbrief.md\n\n"), "no live-state body in the prefix");
  } finally {
    await cleanup();
  }
});

test("dispatch and worktree sections ride the link; the rest is always there", () => {
  const linked = buildSystemPrompt({ dispatch: true });
  const unlinked = buildSystemPrompt({});
  assert.match(linked, /## Dispatch/);
  assert.match(linked, /## Features and worktrees/);
  assert.ok(!unlinked.includes("## Dispatch"), "no dispatch section unlinked");
  assert.ok(!unlinked.includes("## Features and worktrees"), "no worktree section unlinked");
  for (const heading of ["## How you think", "## Research", "## Memory", "## Orders to the crew", "## Reviewing crew work", "## Task table", "## Voice", "## Before you answer"]) {
    assert.ok(linked.includes(heading), `linked prompt has ${heading}`);
    assert.ok(unlinked.includes(heading), `unlinked prompt has ${heading}`);
  }
});

// --- the guardrails stay permanent ----------------------------------------------

test("the guardrails bind every turn, so they live in the prompt", () => {
  const prompt = buildSystemPrompt({ dispatch: true });
  // These constrain turns where the co has no idea a rule applies; a guardrail
  // behind a tool call is a guardrail that does not fire.
  assert.match(prompt, /You never inspect, edit, or run the user's source code/);
  assert.match(prompt, /Never announce, narrate, or ask\s+permission to write to memory/);
  assert.match(prompt, /Answer first, record second/);
  assert.match(prompt, /Never write over a row you did not name/);
  assert.match(prompt, /never\s+assume a row you did not add is stale/);
  assert.match(prompt, /The default is NOT to add a row/);
  assert.match(prompt, /fires only on\s+their typed \`confirm\`/);
  assert.match(prompt, /Never say or imply an\s+order ran because you armed it/);
  assert.match(prompt, /Silence is the default and it is total/);
  assert.match(prompt, /accept, fix-commit, or rework/);
  assert.match(prompt, /A read-only audit gets no verdict/);
});

test("the navigator persona survives, as seasoning and not costume", () => {
  const prompt = buildSystemPrompt({});
  assert.match(prompt, /seasoned ship's navigator/);
  assert.match(prompt, /the user is the\s+captain/);
  assert.match(prompt, /No pirate caricature/);
  assert.match(prompt, /the seasoning goes/, "substance outranks flavour, stated");
});

// --- the on-demand tier stays on demand -----------------------------------------

test("occasional protocol detail is NOT in the resident prompt", () => {
  const prompt = buildSystemPrompt({ dispatch: true });
  assert.ok(!prompt.includes("## Other Notes"), "the PR template is on demand");
  assert.ok(!prompt.includes("Two lanes in one worktree"), "the lane rules are on demand");
  assert.ok(!prompt.includes("feature_abandon(name)"), "the lever reference is on demand");
  assert.ok(!prompt.includes("Conventional Commits form"), "the commit rules are on demand");
  assert.ok(!prompt.includes("D-YYYYMMDD-N"), "the memory file reference is on demand");
  // And the prompt tells the co, imperatively, to go and get them.
  assert.match(prompt, /Before writing\s+ANY order, call \`read_protocol\`/);
  assert.match(prompt, /Before any feature lever, \`read_protocol\`/);
  assert.match(prompt, /already holds a live agent, \`read_protocol\`/);
});

test("every protocol section is reachable, self-titled, and clean", () => {
  for (const section of PROTOCOL_SECTIONS) {
    const body = protocolBody(section);
    assert.ok(body.length > 500, `${section} looks truncated at ${body.length} chars`);
    assert.match(body, /^### /, `${section} must carry its own heading once pulled in`);
    assert.ok(!body.includes("\\`"), `${section} has escaped backticks in its value`);
  }
  assert.deepEqual(protocolSectionsFor({}), ["orders", "memory", "docs"]);
  assert.deepEqual(protocolSectionsFor({ dispatch: true }), [...PROTOCOL_SECTIONS]);
});

// --- load-bearing prose, wherever it lives --------------------------------------

test("the orders protocol carries the commit rules and the report contract", () => {
  const all = reachable();
  assert.match(all, /Hard limit: 40 lines and 350 words per order/);
  assert.match(all, /Conventional Commits form/);
  assert.match(all, /use EXACTLY the message you give/);
  assert.match(all, /no\s+Co-Authored-By, no "Generated with", no attribution trailer/);
  assert.match(all, /diffstat: files changed, insertions, deletions/);
  assert.match(all, /Hard limit: 50 lines for the whole report/);
  assert.match(all, /stating its own\s+line count/);
});

test("decision ids stay in memory: nothing asks for one in an order or a PR", () => {
  // The id is a lookup key inside co's own memory. Neither the captain nor the
  // crew nor a PR reader can resolve one — the log lives under CO_HOME, outside
  // the repo — so outward text carries the decision's substance instead.
  const prompt = buildSystemPrompt({ dispatch: true });
  assert.match(prompt, /Decision ids stay in memory/);
  const orders = protocolBody("orders");
  const pr = protocolBody("pr-message");
  for (const [name, body] of [
    ["orders", orders],
    ["pr-message", pr],
  ] as const) {
    assert.ok(!/decision ids|ids and gist/i.test(body), `${name} still asks for a decision id`);
  }
  assert.ok(
    !prompt.includes("the decisions and their ids"),
    "the resident orders section no longer hands the crew an id",
  );
  assert.match(orders, /never an id/);
  assert.match(pr, /\`## Why\`: the problem first, then the decision/);
  // Minting is untouched: they are still recorded, still by id.
  assert.match(protocolBody("memory"), /Decisions carry a stable id, D-YYYYMMDD-N/);
});

test("the division of knowledge is stated: goal co's, constraints captain's, repo crew's", () => {
  const prompt = buildSystemPrompt({});
  assert.match(prompt, /The goal and the why are yours/);
  assert.match(prompt, /The\s+constraints are the captain's/);
  assert.match(prompt, /The repo's facts are the crew's/);
  assert.match(prompt, /never restate what a grep would find/);
});

test("the features protocol keeps branch shape, ownership, and the ungated nudge", () => {
  const all = reachable();
  assert.match(all, /<type>\/<slug>/);
  assert.match(all, /fix\/stale-token-bug/, "a worked example of choosing the type");
  assert.match(all, /identified by the worktree co provisioned, never by branch\s+name/);
  assert.match(all, /ready but UNGATED/);
  assert.match(all, /offer ONCE/);
  assert.match(all, /never withhold or delay a merge over it/);
  assert.match(all, /\`awaiting-checks\` is a wait, not a failure/);
});

test("the pr-message protocol keeps the five sections in order, and the honesty rules", () => {
  const body = protocolBody("pr-message");
  assert.match(
    body,
    /\`## What\`[\s\S]*\`## Why\`[\s\S]*\`## How\`[\s\S]*\`## Testing\`[\s\S]*\`## Other Notes\`/,
    "five sections, in order",
  );
  assert.match(body, /never turn "tests pass"\s+into "verified"/);
  assert.match(body, /verification\s+record\s+unavailable/);
  assert.match(body, /never name who did the\s+work/);
  assert.match(body, /bullets only, no paragraphs/i);
  assert.match(body, /Drop a section you would leave empty/);
});

test("the lanes protocol keeps the two verbs, the hazard, and the honesty rule", () => {
  const body = protocolBody("lanes");
  assert.match(body, /\`confirm\` grants the READ-ONLY lane/);
  assert.match(body, /\`confirm write\` grants a second WRITING lane/);
  assert.match(body, /one \`\.git\/index\`, one \`dist\/\`, one \`node_modules\`/);
  assert.match(body, /advisory: say so plainly, never call it sandboxed/);
  assert.match(body, /The captain chooses the lane, never you/);
  assert.match(body, /Only a WRITER blocks enqueue and abandon/);
});

test("parallel-by-default is resident: it shapes turns that never read a protocol", () => {
  const prompt = buildSystemPrompt({ dispatch: true });
  assert.match(prompt, /Parallel is the NORMAL state/);
  assert.match(prompt, /you need a reason to HOLD one\s+back, never a reason to start one/);
  assert.match(prompt, /The merge itself is the captain's \`\[m\]\`/);
});

// --- layer 3: the startup injection ---------------------------------------------

test("the injection carries the live state, environment, table, and tail", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const rows = [
      { task: "Ctrl-O home cleanup", status: "queued" as const },
      { task: "Fix crew handoff", status: "building" as const },
    ];
    const briefing = await buildStartupInjection(paths, RESEARCH, {
      tasks: rows,
      dispatch: DISPATCH,
    });
    // Framed as harness scaffolding, not the captain's words.
    assert.match(briefing, /SESSION BRIEFING/);
    assert.match(briefing, /the captain\s+did not type this/);
    // Environment: everything the old prompt interpolated now lives here.
    assert.match(briefing, /Instance: inst/);
    assert.match(briefing, /Linked repo: \/repo/);
    assert.match(briefing, /default cc/);
    assert.match(briefing, /\`confirm <name>\`/, "the agent-pick verb reaches the co");
    assert.match(briefing, new RegExp(`Today: ${new Date().toISOString().slice(0, 10)}`));
    // Live state, by its on-disk names.
    assert.match(briefing, /projectbrief\.md/);
    assert.match(briefing, /activeContext\.md/);
    // The table snapshot, painted building-first through the shared helper.
    const buildingAt = briefing.indexOf("Fix crew handoff");
    const queuedAt = briefing.indexOf("Ctrl-O home cleanup");
    assert.ok(buildingAt > 0 && queuedAt > buildingAt, "building rows paint first");
    assert.match(briefing, /call \`task_table list\` for the current one/);
    // The tail block, honest about being empty on a fresh instance.
    assert.match(briefing, /Recent conversation/);
    assert.match(briefing, /No prior session\. This is a fresh start\./);
  } finally {
    await cleanup();
  }
});

test("an unlinked injection says so instead of describing a crew it lacks", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const briefing = await buildStartupInjection(paths, RESEARCH, {});
    assert.match(briefing, /Not linked to a repo/);
    assert.ok(!briefing.includes("Linked repo:"));
  } finally {
    await cleanup();
  }
});

test("the injection is deterministic for the same inputs", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const rows = [{ task: "steady", status: "queued" as const }];
    const a = await buildStartupInjection(paths, RESEARCH, { tasks: rows, dispatch: DISPATCH });
    const b = await buildStartupInjection(paths, RESEARCH, { tasks: rows, dispatch: DISPATCH });
    assert.equal(a, b);
  } finally {
    await cleanup();
  }
});

test("a surfaced doc is truncated into the injection, with a pointer to the rest", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const { createDoc } = await import("../memory/docs.js");
    const huge = Array.from({ length: 400 }, (_, i) => `paragraph ${i} of the design`).join(
      "\n\n",
    );
    await createDoc(paths, "architecture.md", huge);
    const briefing = await buildStartupInjection(paths, RESEARCH, { dispatch: DISPATCH });
    assert.ok(!briefing.includes("paragraph 399"), "the tail must not reach the briefing");
    assert.match(briefing, /Truncated at/, "and the co must be told there is more");
    assert.match(briefing, /doc read architecture\.md/, "with how to get the rest on demand");
    // Budgeted, not refused: the doc is the captain's and a session must start.
    assert.match(briefing, /paragraph 0 of the design/);
    assert.ok(SURFACED_DOC_MAX_CHARS > 0);
  } finally {
    await cleanup();
  }
});
