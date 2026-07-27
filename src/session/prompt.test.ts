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
