import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { instancePaths, type InstancePaths } from "../paths.js";
import { createInstance } from "../memory/memory.js";
import { buildSystemPrompt } from "./prompt.js";
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
    assert.match(prompt, /concise imperative line/, "the title rule");
    assert.match(prompt, /what the PR accomplishes and why/, "the body rule");
    assert.match(
      prompt,
      /no bot voice,\s+no attribution, nothing about co or the crew/,
      "the house PR style: no co provenance anywhere in it (D-20260724-17)",
    );
    assert.match(
      prompt,
      /a re-enqueue with no message keeps the one you wrote/,
      "so a retry never silently reverts to the mechanical fallback",
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
