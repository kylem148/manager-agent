import { test } from "node:test";
import assert from "node:assert/strict";
import { clampEffort, effortLevelsFor, parseEffort, type ModelConfig } from "./config.js";
import { ModelProvider } from "./model.js";

/**
 * Tests for the /effort override. The Bedrock client is stubbed so we can assert
 * what output_config each turn actually puts on the wire — the thing that
 * matters is that a mid-session setEffort reaches the NEXT request, not just the
 * in-memory config.
 */

const CFG: ModelConfig = {
  region: "us-west-2",
  authMode: "none",
  modelId: "us.anthropic.claude-opus-4-8",
  maxTokens: 100,
  thinking: "adaptive",
  effort: "xhigh",
  debugTiming: false,
};

/** Replace the provider's client with one that records params and ends the turn. */
function stubClient(provider: ModelProvider): unknown[] {
  const sent: unknown[] = [];
  (provider as any).client = {
    messages: {
      stream: (params: any) => {
        sent.push(params.output_config);
        return {
          [Symbol.asyncIterator]: async function* () {},
          finalMessage: async () => ({
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
          }),
        };
      },
    },
  };
  return sent;
}

const TURN = {
  system: "s",
  messages: [{ role: "user" as const, content: "hi" }],
  tools: [],
  executor: async () => ({ tool_use_id: "", content: "" }),
};

test("parseEffort accepts the five levels, case-insensitively", () => {
  assert.equal(parseEffort("low"), "low");
  assert.equal(parseEffort("MAX"), "max");
  assert.equal(parseEffort(" xhigh "), "xhigh");
});

test("parseEffort rejects anything else", () => {
  assert.equal(parseEffort("bogus"), null);
  assert.equal(parseEffort(""), null);
  assert.equal(parseEffort(undefined), null);
});

test("the 4.6 generation is offered the ladder without xhigh", () => {
  // Bedrock answers effort=xhigh on these with a 400, so the level must never
  // reach the wire — see NO_XHIGH_MODELS in config.ts.
  for (const id of ["us.anthropic.claude-sonnet-4-6", "us.anthropic.claude-opus-4-6"]) {
    assert.deepEqual(effortLevelsFor(id), ["low", "medium", "high", "max"]);
  }
});

test("models that take the full ladder keep xhigh", () => {
  for (const id of [
    "us.anthropic.claude-opus-4-8",
    "us.anthropic.claude-sonnet-5",
    "some.unknown.model", // unknown ids fail loudly at the API, not silently here
  ]) {
    assert.deepEqual(effortLevelsFor(id), ["low", "medium", "high", "xhigh", "max"]);
  }
});

test("clampEffort degrades xhigh to high rather than up to max", () => {
  // Rounding up would raise spend on every turn, which inverts the reason for
  // moving to a cheaper model in the first place.
  assert.equal(clampEffort("xhigh", "us.anthropic.claude-sonnet-4-6"), "high");
});

test("clampEffort leaves supported levels alone", () => {
  const sonnet = "us.anthropic.claude-sonnet-4-6";
  for (const level of ["low", "medium", "high", "max"] as const) {
    assert.equal(clampEffort(level, sonnet), level);
  }
  assert.equal(clampEffort("xhigh", "us.anthropic.claude-opus-4-8"), "xhigh");
});

test("setEffort changes what the next turn sends", async () => {
  const provider = new ModelProvider({ ...CFG });
  const sent = stubClient(provider);

  await provider.runTurn(TURN);
  assert.deepEqual(sent[0], { effort: "xhigh" });

  provider.setEffort("medium");
  assert.equal(provider.effort, "medium");

  await provider.runTurn(TURN);
  assert.deepEqual(sent[1], { effort: "medium" });
});
