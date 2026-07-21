import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelConfig } from "./config.js";
import { ModelProvider, type MessageParam, type Tool } from "./model.js";

/**
 * Tests for prompt-cache breakpoint placement.
 *
 * The cache invariants are worth pinning down because breaking them fails
 * silently: too many breakpoints is a hard 400, but a breakpoint in the wrong
 * place — or one that leaks into the caller's history and accumulates — just
 * quietly stops caching, and the only symptom is a slower session. See the
 * CACHE_CONTROL comment in model.ts.
 */

const CFG: ModelConfig = {
  region: "us-west-2",
  authMode: "none",
  modelId: "us.anthropic.claude-opus-4-8",
  maxTokens: 100,
  thinking: "adaptive",
  effort: "high",
  debugTiming: false,
};

interface SentParams {
  system: unknown;
  tools?: unknown[];
  messages: MessageParam[];
}

/**
 * Stub the Bedrock client. `script` supplies one finalMessage per round, so a
 * test can drive a tool round and then an end_turn.
 */
function stubClient(provider: ModelProvider, script: unknown[]): SentParams[] {
  const sent: SentParams[] = [];
  let round = 0;
  (provider as any).client = {
    messages: {
      stream: (params: any) => {
        sent.push(params);
        const message = script[Math.min(round, script.length - 1)];
        round++;
        return {
          [Symbol.asyncIterator]: async function* () {},
          finalMessage: async () => message,
        };
      },
    },
  };
  return sent;
}

const endTurn = { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: {} };

/** Every cache_control marker anywhere in a request. Bedrock's ceiling is 4. */
function countBreakpoints(p: SentParams): number {
  const inBlocks = (v: unknown): number =>
    Array.isArray(v) ? v.filter((b) => b && typeof b === "object" && "cache_control" in b).length : 0;
  return (
    inBlocks(p.system) +
    inBlocks(p.tools) +
    p.messages.reduce((n, m) => n + inBlocks(m.content), 0)
  );
}

const TOOLS: Tool[] = [
  { name: "a", description: "a", input_schema: { type: "object", properties: {} } },
  { name: "b", description: "b", input_schema: { type: "object", properties: {} } },
];

function turn(messages: MessageParam[], tools: Tool[] = TOOLS) {
  return {
    system: "system prompt",
    messages,
    tools,
    executor: async (b: any) => ({ tool_use_id: b.id, content: "done" }),
  };
}

test("the system prompt is sent as a block carrying a cache breakpoint", async () => {
  const provider = new ModelProvider({ ...CFG });
  const sent = stubClient(provider, [endTurn]);

  await provider.runTurn(turn([{ role: "user", content: "hi" }]));

  assert.deepEqual(sent[0]!.system, [
    { type: "text", text: "system prompt", cache_control: { type: "ephemeral" } },
  ]);
});

test("only the last tool definition closes the tools prefix", async () => {
  const provider = new ModelProvider({ ...CFG });
  const sent = stubClient(provider, [endTurn]);

  await provider.runTurn(turn([{ role: "user", content: "hi" }]));

  const tools = sent[0]!.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 2);
  assert.equal(tools[0]!.cache_control, undefined);
  assert.deepEqual(tools[1]!.cache_control, { type: "ephemeral" });
});

test("a request never exceeds Bedrock's four cache breakpoints", async () => {
  const provider = new ModelProvider({ ...CFG });
  const sent = stubClient(provider, [endTurn]);

  // A long history is the case that would blow the budget if breakpoints
  // accumulated per turn rather than being recomputed.
  const history: MessageParam[] = [];
  for (let i = 0; i < 40; i++) {
    history.push({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` });
  }
  await provider.runTurn(turn(history));

  assert.ok(countBreakpoints(sent[0]!) <= 4, `expected <= 4, got ${countBreakpoints(sent[0]!)}`);
});

test("breakpoints never leak into the caller's message history", async () => {
  const provider = new ModelProvider({ ...CFG });
  stubClient(provider, [endTurn]);

  // The session reuses and grows this array across turns. A marker written back
  // into it would survive into the next turn and stack up past the ceiling.
  const messages: MessageParam[] = [{ role: "user", content: "hi" }];
  const before = structuredClone(messages);

  await provider.runTurn(turn(messages));

  assert.deepEqual(messages, before);
});

test("a tool round still respects the breakpoint ceiling", async () => {
  const provider = new ModelProvider({ ...CFG });
  const toolRound = {
    content: Array.from({ length: 8 }, (_, i) => ({
      type: "tool_use",
      id: `t${i}`,
      name: "a",
      input: {},
    })),
    stop_reason: "tool_use",
    usage: {},
  };
  const sent = stubClient(provider, [toolRound, endTurn]);

  await provider.runTurn(turn([{ role: "user", content: "hi" }]));

  assert.ok(countBreakpoints(sent[1]!) <= 4, `expected <= 4, got ${countBreakpoints(sent[1]!)}`);
});
