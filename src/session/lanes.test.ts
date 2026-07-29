import { test } from "node:test";
import assert from "node:assert/strict";
import {
  READ_ONLY_BLURB,
  READ_ONLY_DENIED_TOOLS,
  READ_ONLY_FLAG,
  applyLane,
  crewProgram,
  readOnlyEnforcement,
  supportsToolPermissionFlags,
  withReadOnlyFlags,
} from "./lanes.js";

/**
 * The lane primitives (lanes.ts).
 *
 * Two things here are pinned rather than merely exercised, because both are
 * load-bearing prose/argv that nothing downstream can repair:
 *
 *  - the READ-ONLY MANDATE, which for an agent with no tool-permission flags is
 *    the ONLY thing standing between a second agent and the first agent's next
 *    `git add -A`;
 *  - the FLAG SHAPE, which must be the `=` form. The space-separated form of a
 *    variadic option swallows the order text as another deny rule, and the agent
 *    then launches with no prompt at all.
 */

test("the read-only mandate forbids every write, not just commits", () => {
  // The blurb is one paragraph with no line breaks: it is prepended to an order
  // and must not import a hard wrap into someone else's prompt.
  assert.ok(!READ_ONLY_BLURB.includes("\n"), "one paragraph, no embedded newlines");
  assert.match(READ_ONLY_BLURB, /^READ-ONLY RUN\./);
  assert.match(
    READ_ONLY_BLURB,
    /Another agent is working in this same worktree right now and its uncommitted changes are live on disk around you\./,
  );
  // The enumeration is the substance. A mandate that named only commits would
  // leave exactly the hazard this lane exists for: a scratch file swept into
  // someone else's commit.
  for (const forbidden of [
    "no file edits",
    "no new files",
    "no `git add`",
    "no `git commit`",
    "no `git stash`",
    "no branch or index operations",
    "no `npm install`",
    "no build",
    "no test run that emits artifacts (coverage, snapshots, logs)",
  ]) {
    assert.ok(READ_ONLY_BLURB.includes(forbidden), `the mandate names: ${forbidden}`);
  }
  assert.match(
    READ_ONLY_BLURB,
    /swept into the other agent's next commit without either of you seeing it/,
    "and says WHY, so the agent can reason about a case the list missed",
  );
  assert.match(READ_ONLY_BLURB, /that report is your entire output\.$/);
});

test("applyLane prepends the mandate for a reader and leaves a writer's order alone", () => {
  const order = "Audit the dispatch path for races.";
  assert.equal(applyLane(order, "writer"), order, "a writer's order is byte-identical");

  const read = applyLane(order, "reader");
  assert.ok(read.startsWith(READ_ONLY_BLURB), "the mandate leads");
  assert.ok(read.endsWith(order), "the order follows, whole");
  assert.equal(read, `${READ_ONLY_BLURB}\n\n${order}`, "separated by one blank line and nothing else");
});

test("the deny flag is the `=` form, because the space form eats the order", () => {
  // Verified live against the shipped Claude Code CLI: `--disallowedTools` is
  // variadic, so `--disallowedTools Write,Edit mcp list` reports `mcp` and
  // `list` as deny rules. With the order text in that position the agent
  // launches with no prompt — a silently broken audit, every time.
  assert.match(READ_ONLY_FLAG, /^--disallowedTools=/);
  assert.ok(!READ_ONLY_FLAG.includes(" "), "one argv token, so nothing after it is consumed");
  // The tools that can put bytes on disk or move the index.
  for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Task"]) {
    assert.ok(READ_ONLY_DENIED_TOOLS.includes(tool as never), `${tool} is denied`);
  }
});

test("the program behind a crew command is found past any env prefix", () => {
  assert.equal(crewProgram("claude {prompt}"), "claude");
  assert.equal(crewProgram('CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude {prompt}'), "claude");
  assert.equal(crewProgram("env CLAUDE_CONFIG_DIR=/tmp/x claude {prompt}"), "claude");
  assert.equal(crewProgram("/usr/local/bin/claude {prompt}"), "/usr/local/bin/claude");
  assert.equal(crewProgram("opencode run {prompt}"), "opencode");
  assert.equal(crewProgram("   "), "");
});

test("enforcement is claimed only where the CLI really takes the flags", () => {
  assert.equal(supportsToolPermissionFlags("claude {prompt}"), true);
  assert.equal(supportsToolPermissionFlags('CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude {prompt}'), true);
  assert.equal(supportsToolPermissionFlags("/usr/local/bin/claude {prompt}"), true);
  assert.equal(supportsToolPermissionFlags("opencode run {prompt}"), false);
  assert.equal(supportsToolPermissionFlags("aider {prompt}"), false);

  // The banner has to be able to say which of the two the captain is getting,
  // so the enforcement verdict carries its own clause.
  const claude = readOnlyEnforcement("claude {prompt}");
  assert.equal(claude.enforced, true);
  assert.match(claude.detail, /mechanically enforced/);
  assert.ok(claude.detail.includes(READ_ONLY_FLAG), "and names the flag it will actually pass");

  const other = readOnlyEnforcement("opencode run {prompt}");
  assert.equal(other.enforced, false);
  assert.match(other.detail, /ADVISORY ONLY/);
  assert.match(
    other.detail,
    /nothing mechanically blocks a write/,
    "an unrecognised agent is never reported as enforced",
  );
});

test("the flag lands before the prompt placeholder, and never on an agent that can't take it", () => {
  assert.equal(withReadOnlyFlags("claude {prompt}"), `claude ${READ_ONLY_FLAG} {prompt}`);
  assert.equal(
    withReadOnlyFlags('CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude {prompt}'),
    `CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude ${READ_ONLY_FLAG} {prompt}`,
  );
  // A hand-edited template with no placeholder still gets the flag rather than
  // silently running unrestricted.
  assert.equal(withReadOnlyFlags("claude"), `claude ${READ_ONLY_FLAG}`);
  // An agent whose CLI has no such flag is left exactly as configured: a bogus
  // flag would break the launch outright, which is worse than advisory.
  assert.equal(withReadOnlyFlags("opencode run {prompt}"), "opencode run {prompt}");
});
