import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelConfig } from "./config.js";
import { apiErrorText, ModelProvider, type MessageParam, type Tool } from "./model.js";

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

test("tools carry no breakpoint of their own; the system entry covers them", async () => {
  const provider = new ModelProvider({ ...CFG });
  const sent = stubClient(provider, [endTurn]);

  await provider.runTurn(turn([{ role: "user", content: "hi" }]));

  // One prefix entry, at the end of the system prompt, spans tools + system.
  // A breakpoint reappearing on a tool would silently split the prefix into
  // two entries and pay a second write for nothing.
  const tools = sent[0]!.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 2);
  for (const t of tools) assert.equal(t.cache_control, undefined);
  // The one-hour TTL on the system entry is load-bearing, not incidental:
  // under the five-minute default every pause longer than a thought expires
  // the entry and the next turn re-writes the whole prefix. Asserted so a
  // silent revert to a bare `ephemeral` fails a test rather than quietly
  // tripling the bill.
  assert.deepEqual((sent[0]!.system as any[])[0].cache_control, {
    type: "ephemeral",
    ttl: "1h",
  });
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

/** Every block in the outgoing request that carries a marker, in order. */
function markedBlocks(p: SentParams): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of p.messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content as Array<Record<string, unknown>>) {
      if (b && typeof b === "object" && "cache_control" in b) out.push(b);
    }
  }
  return out;
}

const thinking = (text: string) => ({ type: "thinking" as const, thinking: text, signature: "sig" });

/** One turn over `history`, and the request it put on the wire. */
async function requestFor(history: MessageParam[]): Promise<SentParams> {
  const provider = new ModelProvider({ ...CFG });
  const sent = stubClient(provider, [endTurn]);
  await provider.runTurn(turn(history));
  return sent[0]!;
}

/**
 * A session's history as it really looks with adaptive thinking on: every
 * assistant turn opens with a thinking block, and every fifth one stopped
 * inside its reasoning and is nothing else. Ends user-side, the way a history
 * always does at the moment a turn is sent.
 */
function thinkingHistory(turns: number): MessageParam[] {
  const history: MessageParam[] = [];
  for (let i = 0; i < turns; i++) {
    history.push({ role: "user", content: `q${i}` });
    history.push({
      role: "assistant",
      content:
        i % 5 === 4
          ? [thinking(`stopped mid-thought ${i}`)]
          : [thinking(`reasoning ${i}`), { type: "text", text: `a${i}` }],
    });
  }
  history.push({ role: "user", content: "next" });
  return history;
}

/**
 * The failure that killed a live session mid-turn:
 *
 *   400 messages.16.content.0.thinking.cache_control: Extra inputs are not permitted
 *
 * A rolling anchor was placed on the last content block of a historical
 * assistant message, and that block was a thinking block. Thinking blocks are
 * signed and replayed verbatim and carry no cache_control field at all, so the
 * API refuses the whole request rather than ignoring the key — and since the
 * offending block is in HISTORY, every later turn fails identically. Adaptive
 * thinking is on for the whole session, so every assistant turn in the history
 * opens with one of these; the only question is where the anchor lands.
 */
test("a breakpoint never lands on a thinking block", async () => {
  // Where an anchor lands is a function of how many blocks the tail of the
  // history holds, so any single history only proves the one spot it happened
  // to hit — the first version of this test passed against the unfixed code for
  // exactly that reason. Sweeping the length walks both anchors across every
  // kind of message the history holds, thinking-only turns included.
  for (let turns = 1; turns <= 30; turns++) {
    const sent = await requestFor(thinkingHistory(turns));
    const marked = markedBlocks(sent);
    const where = `history of ${turns} turn(s)`;

    assert.deepEqual(
      marked.filter((b) => b.type === "thinking" || b.type === "redacted_thinking"),
      [],
      `no thinking block may carry cache_control — ${where}`,
    );
    // And caching is not quietly given up to achieve that: the anchors move,
    // they do not disappear, and they stay inside Bedrock's ceiling of four.
    assert.ok(marked.length >= 1 && marked.length <= 2, `${marked.length} anchors — ${where}`);
    assert.ok(countBreakpoints(sent) <= 4, `${countBreakpoints(sent)} breakpoints — ${where}`);
  }

  // Long enough for both rolling anchors, plus the one on the system prefix.
  assert.equal(markedBlocks(await requestFor(thinkingHistory(30))).length, 2);
  assert.equal(countBreakpoints(await requestFor(thinkingHistory(30))), 3);
});

test("inside a message, the anchor moves to the last block that can take one", async () => {
  const provider = new ModelProvider({ ...CFG });
  const sent = stubClient(provider, [endTurn]);

  // Thinking last is the case the old code got wrong; a text block ahead of it
  // is a legal home for the marker and must be the one used.
  await provider.runTurn(
    turn([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "text", text: "answer" }, thinking("afterthought")],
      },
    ]),
  );

  const content = sent[0]!.messages.at(-1)!.content as Array<Record<string, unknown>>;
  assert.equal(content[0]!.cache_control !== undefined, true, "the text block carries it");
  assert.equal(content[1]!.cache_control, undefined, "the thinking block does not");
});

test("an anchor with no legal spot slides to an older message rather than vanishing", async () => {
  const provider = new ModelProvider({ ...CFG });
  const sent = stubClient(provider, [endTurn]);

  // Pathological on purpose: every assistant turn is thinking and nothing else,
  // so neither anchor has a home where it would naturally fall. Caching must
  // degrade to an older message, never to fewer breakpoints.
  const history: MessageParam[] = [];
  for (let i = 0; i < 20; i++) {
    history.push({ role: "user", content: `q${i}` });
    history.push({ role: "assistant", content: [thinking(`reasoning ${i}`)] });
  }

  await provider.runTurn(turn(history));

  const marked = markedBlocks(sent[0]!);
  assert.deepEqual(
    marked.filter((b) => b.type === "thinking"),
    [],
  );
  assert.equal(marked.length, 2, "still two rolling anchors, on the messages that can hold them");
  // Distinct messages: two marks on one message would be one breakpoint, and
  // the lagging anchor exists to sit further back than the newest.
  const markedMessages = sent[0]!.messages.filter(
    (m) =>
      typeof m.content !== "string" &&
      (m.content as Array<Record<string, unknown>>).some((b) => "cache_control" in b),
  );
  assert.equal(markedMessages.length, 2);
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
  // Same system block with its breakpoint, same unmarked tools ahead of it —
  // any drift writes a fresh entry instead of touching the one being kept warm.
  assert.deepEqual(p.system, [
    { type: "text", text: "system prompt", cache_control: { type: "ephemeral", ttl: "1h" } },
  ]);
  for (const t of p.tools as any[]) {
    assert.equal(t.cache_control, undefined, "tools stay unmarked, exactly like a real round");
  }
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

// --- switching models (/model) -------------------------------------------------

test("a switch takes effect on the next turn and keeps the history", async () => {
  const provider = new ModelProvider({ ...CFG });
  const sent = stubClient(provider, [endTurn]);
  const history: MessageParam[] = [
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "second" },
  ];

  provider.setModel("us.anthropic.claude-sonnet-5");
  assert.equal(provider.modelId, "us.anthropic.claude-sonnet-5", "and the session's own view of it");

  const out = await provider.runTurn({
    system: "s",
    messages: history,
    tools: [],
    executor: async () => ({ tool_use_id: "x", content: "" }),
  });
  assert.equal((sent[0] as any).model, "us.anthropic.claude-sonnet-5");
  // A model change is not a new conversation: everything said so far is re-sent.
  assert.deepEqual(out.messages.slice(0, 3), history);
});

test("a switch re-clamps effort against the new model's ladder", () => {
  // xhigh arrived with Opus 4.7 and is a flat 400 on the 4.6 generation, so an
  // unclamped switch would break every subsequent turn rather than degrade.
  const provider = new ModelProvider({ ...CFG, effort: "xhigh" });
  assert.equal(provider.setModel("us.anthropic.claude-sonnet-4-6"), "high", "degrades, never rounds up");
  assert.equal(provider.effort, "high");
  // And back up the ladder it stays where it was put — a model that accepts the
  // level has nothing to say about it.
  assert.equal(provider.setModel("us.anthropic.claude-opus-5"), null);
  assert.equal(provider.effort, "high");
});

test("a probe asks about the candidate model, in the shape a real turn will use", async () => {
  const provider = new ModelProvider({ ...CFG, effort: "xhigh" });
  const sent = stubCreate(provider, { content: [], stop_reason: "max_tokens", usage: {} });

  const verdict = await provider.probeModel("us.anthropic.claude-sonnet-4-6");
  assert.deepEqual(verdict, { ok: true });

  const p = sent[0]! as any;
  assert.equal(p.model, "us.anthropic.claude-sonnet-4-6", "the candidate, not the model in force");
  // Effort clamped for the CANDIDATE: a model that takes the id but rejects the
  // params fails every turn just as thoroughly, and that is the failure this
  // probe exists to catch before the switch rather than after it.
  assert.equal(p.output_config.effort, "high");
  assert.ok(p.thinking, "thinking rides along too");
  assert.equal(provider.modelId, CFG.modelId, "a probe commits to nothing");
});

test("a refused id comes back with the API's own words, and changes nothing", async () => {
  const provider = new ModelProvider({ ...CFG });
  stubCreate(provider, () => {
    throw new Error('404 {"message":"The provided model identifier is invalid."}');
  });

  const verdict = await provider.probeModel("us.anthropic.claude-nope");
  assert.deepEqual(verdict, {
    ok: false,
    error: '404 {"message":"The provided model identifier is invalid."}',
  });
  // Not a throw: the caller has to be able to report this and carry on.
  assert.equal(provider.modelId, CFG.modelId);
  assert.equal(provider.drainUsage().rounds, 0, "and a probe is not a turn");
});

test("a non-Error failure still yields something readable", () => {
  assert.equal(apiErrorText(new Error("  boom  ")), "boom");
  assert.equal(apiErrorText("socket hang up"), "socket hang up");
  assert.equal(apiErrorText(new Error("")), "Error");
});
