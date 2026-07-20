import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEffort, type ModelConfig } from "./config.js";
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
