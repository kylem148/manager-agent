import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyInstanceOverrides,
  DEFAULT_PANE_WAIT_SEC,
  paneWaitSec,
  type Config,
  type ModelConfig,
} from "./config.js";

/**
 * Tests for the env-driven config readers that resolve lazily at the point of
 * use (rather than through loadConfig), so the value the caller sees is the one
 * in the environment right now.
 *
 * `co pane`'s countdown is one of those. What is pinned here is the DEFAULT — the
 * wait a captain who has set nothing actually sits through — because that is the
 * whole of the tuning: the countdown itself is a bare sleep loop in runPaneAnchor
 * with no condition attached, and the real designation (does the focused Ghostty
 * pane get picked up) is AppleScript against a live app and is not reachable from
 * a test at all.
 */

function withEnv(value: string | undefined, fn: () => void): void {
  const prior = process.env.CO_PANE_WAIT;
  if (value === undefined) delete process.env.CO_PANE_WAIT;
  else process.env.CO_PANE_WAIT = value;
  try {
    fn();
  } finally {
    if (prior === undefined) delete process.env.CO_PANE_WAIT;
    else process.env.CO_PANE_WAIT = prior;
  }
}

test("co pane waits 2 seconds by default", () => {
  assert.equal(DEFAULT_PANE_WAIT_SEC, 2);
  withEnv(undefined, () => {
    assert.equal(paneWaitSec(), 2);
  });
});

test("CO_PANE_WAIT retunes the countdown without a code change", () => {
  withEnv("6", () => assert.equal(paneWaitSec(), 6));
  withEnv("1", () => assert.equal(paneWaitSec(), 1));
});

test("a junk CO_PANE_WAIT falls back to the default rather than breaking co pane", () => {
  // Neither an instant grab (0 / negative / unparseable) nor a hang: a
  // fat-fingered value degrades to the default, matching the rest of config.ts.
  for (const junk of ["", "0", "-3", "soon"]) {
    withEnv(junk, () => assert.equal(paneWaitSec(), DEFAULT_PANE_WAIT_SEC));
  }
});

// --- per-instance model overrides ---------------------------------------------
//
// What this exists for: running one co-manager on a different model than another,
// so a cheaper tier can be measured against a control instead of guessed at from
// one blended number. The precedence rule is the whole contract — home .env <
// instance .env < real environment — and it is what makes an A/B trustworthy.

async function instanceWith(body: string): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "co-inst-"));
  await writeFile(path.join(root, ".env"), body, "utf8");
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function baseConfig(over: Partial<ModelConfig> = {}): Config {
  return {
    home: "/home/co",
    research: {} as Config["research"],
    model: {
      region: "us-west-2",
      authMode: "none",
      modelId: "us.anthropic.claude-opus-5",
      maxTokens: 32000,
      thinking: "adaptive",
      effort: "high",
      debugTiming: false,
      cacheKeepAliveMs: 0,
      cacheKeepAliveMax: 3,
      compactAtTokens: 60000,
      compactKeepTurns: 6,
      ...over,
    },
  };
}

test("an instance can pin its own model without touching the others", async () => {
  const fx = await instanceWith("BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-5\n");
  try {
    const cfg = applyInstanceOverrides(baseConfig(), fx.root);
    assert.equal(cfg.model.modelId, "us.anthropic.claude-sonnet-5");
    // The original must be untouched: two instances share one loaded config.
    assert.equal(baseConfig().model.modelId, "us.anthropic.claude-opus-5");
  } finally {
    await fx.cleanup();
  }
});

test("only the model keys are overridable, not the whole environment", async () => {
  const fx = await instanceWith("BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-5\nCO_HOME=/somewhere/else\n");
  try {
    const cfg = applyInstanceOverrides(baseConfig(), fx.root);
    assert.equal(cfg.model.modelId, "us.anthropic.claude-sonnet-5");
    // An allowlist, so "which config is in effect" stays answerable.
    assert.equal(cfg.home, "/home/co");
  } finally {
    await fx.cleanup();
  }
});

test("effort is re-clamped against the model the instance actually pinned", async () => {
  // xhigh arrived with Opus 4.7 and 400s on Sonnet 4.6. An instance moved to a
  // model with a shorter ladder must degrade rather than fail every turn.
  const fx = await instanceWith("BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-6\n");
  try {
    const cfg = applyInstanceOverrides(baseConfig({ effort: "xhigh" }), fx.root);
    assert.equal(cfg.model.effort, "high", "xhigh degrades, never rounds up");
  } finally {
    await fx.cleanup();
  }
});

test("a real environment variable still outranks the instance file", async () => {
  const fx = await instanceWith("BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-5\n");
  try {
    // The snapshot is injected because the distinction cannot be observed from
    // process.env at this point: dotenv has already merged the .env files into
    // it, so a real variable and a file line look identical.
    const cfg = applyInstanceOverrides(baseConfig(), fx.root, {
      realEnv: new Set(["BEDROCK_MODEL_ID"]),
    });
    // So a one-off `BEDROCK_MODEL_ID=… co testing` still wins, which is what you
    // reach for when checking something quickly.
    assert.equal(cfg.model.modelId, "us.anthropic.claude-opus-5");
  } finally {
    await fx.cleanup();
  }
});

test("a value from the home .env does NOT block the instance override", async () => {
  // The bug this guards: dotenv writes .env values into process.env, so a naive
  // "is it already set?" check sees the HOME file and treats it as a real
  // environment variable. Every per-instance override then silently does
  // nothing, which is exactly how it failed the first time.
  const fx = await instanceWith("BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-5\n");
  const prev = process.env.BEDROCK_MODEL_ID;
  process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-5"; // as if loaded from ~/co-managers/.env
  try {
    const cfg = applyInstanceOverrides(baseConfig(), fx.root, { realEnv: new Set() });
    assert.equal(cfg.model.modelId, "us.anthropic.claude-sonnet-5");
  } finally {
    if (prev === undefined) delete process.env.BEDROCK_MODEL_ID;
    else process.env.BEDROCK_MODEL_ID = prev;
    await fx.cleanup();
  }
});

test("an instance with no .env is simply not overridden", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "co-inst-"));
  try {
    // A per-instance setting is a convenience; failing to read one must never
    // stop a session opening.
    const cfg = applyInstanceOverrides(baseConfig(), root);
    assert.equal(cfg.model.modelId, "us.anthropic.claude-opus-5");
    assert.equal(applyInstanceOverrides(baseConfig(), "/no/such/dir").model.effort, "high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("blank values are ignored rather than treated as a setting", async () => {
  const fx = await instanceWith("BEDROCK_MODEL_ID=\nCO_MAX_TOKENS=   \nCO_EFFORT=low\n");
  try {
    const cfg = applyInstanceOverrides(baseConfig(), fx.root);
    assert.equal(cfg.model.modelId, "us.anthropic.claude-opus-5");
    assert.equal(cfg.model.maxTokens, 32000);
    assert.equal(cfg.model.effort, "low", "the one real value still applies");
  } finally {
    await fx.cleanup();
  }
});
