import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelConfig } from "./config.js";
import { ModelProvider, type MessageParam, type Tool } from "./model.js";

/**
 * Tests for prompt-cache breakpoint placement and the parallel tool round.
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
  cacheKeepAliveMs: 45 * 60 * 1000,
  cacheKeepAliveMax: 3,
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
    { type: "text", text: "system prompt", cache_control: { type: "ephemeral", ttl: "1h" } },
  ]);
});

test("only the last tool definition closes the tools prefix", async () => {
  const provider = new ModelProvider({ ...CFG });
  const sent = stubClient(provider, [endTurn]);

  await provider.runTurn(turn([{ role: "user", content: "hi" }]));

  const tools = sent[0]!.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 2);
  assert.equal(tools[0]!.cache_control, undefined);
  // The one-hour TTL is load-bearing, not incidental: under the five-minute
  // default every pause longer than a thought expires this entry and the next
  // turn re-writes the whole prefix. Asserted here so a silent revert to a bare
  // `ephemeral` fails a test rather than quietly tripling the bill.
  assert.deepEqual(tools[1]!.cache_control, { type: "ephemeral", ttl: "1h" });
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

test("a tool round runs its calls concurrently and returns results in order", async () => {
  const provider = new ModelProvider({ ...CFG });
  const toolRound = {
    content: [
      { type: "tool_use", id: "t1", name: "a", input: {} },
      { type: "tool_use", id: "t2", name: "b", input: {} },
    ],
    stop_reason: "tool_use",
    usage: {},
  };
  const sent = stubClient(provider, [toolRound, endTurn]);

  let running = 0;
  let peak = 0;
  const executor = async (b: any) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 10));
    running--;
    return { tool_use_id: b.id, content: `r-${b.id}` };
  };

  const result = await provider.runTurn({
    ...turn([{ role: "user", content: "hi" }]),
    executor,
  });

  assert.equal(peak, 2, "both tool calls should have been in flight at once");

  // Results must come back as one user message, in the order the model asked.
  const toolResults = sent[1]!.messages.at(-1)!.content as Array<Record<string, unknown>>;
  assert.deepEqual(
    toolResults.map((r) => r.tool_use_id),
    ["t1", "t2"],
  );
  assert.equal(result.finalText, "ok");
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

// --- the cache keep-alive probe -----------------------------------------------
//
// A probe is only worth sending if it HITS the entry it is trying to keep alive,
// which means its prefix has to be byte-identical to one a real round already
// wrote. Any drift and it writes a fresh entry instead — strictly worse than not
// probing at all, and silent. These tests pin the shape.

/** Stub the non-streaming create() path that refreshCache uses. */
function stubCreate(
  provider: ModelProvider,
  reply: unknown | (() => never) = { content: [], stop_reason: "max_tokens", usage: {} },
): SentParams[] {
  const sent: SentParams[] = [];
  (provider as any).client = {
    messages: {
      create: async (params: any) => {
        sent.push(params);
        if (typeof reply === "function") (reply as () => never)();
        return reply;
      },
    },
  };
  return sent;
}

test("a cache probe replays the prefix a real turn would send", async () => {
  const provider = new ModelProvider({ ...CFG });
  const sent = stubCreate(provider);
  const messages: MessageParam[] = [
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "second" },
  ];
  await provider.refreshCache({ system: "system prompt", messages, tools: TOOLS });

  assert.equal(sent.length, 1);
  const p = sent[0]!;
  // Same system block with its breakpoint, same tools prefix — otherwise the two
  // biggest cached tiers are missed.
  assert.deepEqual(p.system, [
    { type: "text", text: "system prompt", cache_control: { type: "ephemeral", ttl: "1h" } },
  ]);
  assert.ok((p.tools as any[])[1].cache_control, "the tools prefix must still be closed");
  assert.ok(countBreakpoints(p) <= 4, "a probe is still bound by Bedrock's ceiling");
});

test("a probe stops at the last user turn rather than prefilling an assistant one", async () => {
  const provider = new ModelProvider({ ...CFG });
  const sent = stubCreate(provider);
  const messages: MessageParam[] = [
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "second" },
    { role: "assistant", content: "second reply" },
  ];
  await provider.refreshCache({ system: "s", messages, tools: TOOLS });

  const outbound = sent[0]!.messages;
  // Opus 5 rejects a trailing assistant message outright, so the history cannot
  // be replayed as it stands; and appending a throwaway user turn would write a
  // new entry rather than hit the existing one. Cutting back to the last real
  // user turn is the only shape that is a pure read.
  assert.equal(outbound.length, 3);
  assert.equal(outbound[outbound.length - 1]!.role, "user");
});

test("a probe leaves the caller's history untouched", async () => {
  const provider = new ModelProvider({ ...CFG });
  stubCreate(provider);
  const messages: MessageParam[] = [{ role: "user", content: "only" }];
  await provider.refreshCache({ system: "s", messages, tools: TOOLS });
  // Same invariant the turn path holds: markers must never accumulate in the
  // session's own array.
  assert.deepEqual(messages, [{ role: "user", content: "only" }]);
});

test("there is nothing to refresh before the first user turn", async () => {
  const provider = new ModelProvider({ ...CFG });
  const sent = stubCreate(provider);
  assert.equal(await provider.refreshCache({ system: "s", messages: [], tools: TOOLS }), null);
  assert.equal(
    await provider.refreshCache({
      system: "s",
      messages: [{ role: "assistant", content: "hi" }],
      tools: TOOLS,
    }),
    null,
  );
  assert.equal(sent.length, 0, "no request should go out at all");
});

test("a refused probe resolves null instead of throwing at the session", async () => {
  const provider = new ModelProvider({ ...CFG });
  stubCreate(provider, () => {
    throw new Error("throttled");
  });
  const out = await provider.refreshCache({
    system: "s",
    messages: [{ role: "user", content: "x" }],
    tools: TOOLS,
  });
  // The captain never asked for this request; a failure must not reach them.
  assert.equal(out, null);
});

test("a probe reports what it read and wrote so the trade can be audited", async () => {
  const provider = new ModelProvider({ ...CFG });
  stubCreate(provider, {
    content: [],
    stop_reason: "max_tokens",
    usage: { input_tokens: 3, cache_read_input_tokens: 24_000, cache_creation_input_tokens: 0, output_tokens: 64 },
  });
  const out = await provider.refreshCache({
    system: "s",
    messages: [{ role: "user", content: "x" }],
    tools: TOOLS,
  });
  assert.equal(out!.usage.cacheRead, 24_000);
  assert.equal(out!.usage.cacheWrite, 0, "a hit is the whole point; a write means it lapsed");
  assert.equal(out!.usage.output, 64);
});

test("a probe is not folded into the turn meter", async () => {
  const provider = new ModelProvider({ ...CFG });
  stubCreate(provider, {
    content: [],
    stop_reason: "max_tokens",
    usage: { cache_read_input_tokens: 24_000, output_tokens: 64 },
  });
  await provider.refreshCache({
    system: "s",
    messages: [{ role: "user", content: "x" }],
    tools: TOOLS,
  });
  // Counting a probe as a turn would understate cost-per-turn and dilute the
  // rounds average — the two numbers the keep-alive has to be judged by.
  const drained = provider.drainUsage();
  assert.equal(drained.rounds, 0);
  assert.equal(drained.usage.cacheRead, 0);
});
