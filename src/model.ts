import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import type { Effort, ModelConfig } from "./config.js";
import { emptyUsage, type TokenUsage } from "./cost.js";

/**
 * Thin wrapper over the Anthropic Bedrock client. Responsibilities:
 *  - construct the client with bearer-token or SigV4 auth (never hardcoded);
 *  - run a streaming turn, emitting text deltas as they arrive;
 *  - drive a tool-use loop, delegating tool execution to a caller-supplied fn.
 *
 * The model backend is Bedrock Claude only, per the V1 product spec.
 */

export type MessageParam = Anthropic.MessageParam;
export type Tool = Anthropic.Tool;
export type ToolUseBlock = Anthropic.ToolUseBlock;
export type ContentBlockParam = Anthropic.ContentBlockParam;
export type Message = Anthropic.Message;

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ToolExecutor = (block: ToolUseBlock) => Promise<ToolResult>;

/** Everything one assistant turn needs. */
export interface TurnArgs {
  system: string;
  messages: MessageParam[];
  tools: Tool[];
  executor: ToolExecutor;
  handlers?: StreamHandlers;
  maxToolRounds?: number;
  /** Run this turn at a different effort than the session default. */
  effort?: Effort;
}

export interface StreamHandlers {
  /** Called for each chunk of visible answer text. */
  onText?: (delta: string) => void;
  /** Called when the model starts a tool call (after args are known). */
  onToolUse?: (name: string, input: unknown) => void;
  /**
   * Per-round timing/usage line, emitted only when CO_DEBUG_TIMING is set.
   * Routed through a callback rather than written straight to stdout/stderr
   * because the TUI owns the terminal in alt-screen mode — a stray write would
   * corrupt the frame.
   */
  onTiming?: (line: string) => void;
}

/**
 * Cache breakpoints. Bedrock allows at most 4 per request, and (unlike the
 * first-party API) has no automatic caching, so every breakpoint is placed by
 * hand. Budget:
 *   1. the last tool definition — tools are static for the life of the binary,
 *      so this prefix survives across sessions, not just across turns;
 *   2. the end of the system prompt — stable for a whole session, since
 *      buildSystemPrompt runs once at startup and mid-session memory writes
 *      never rebuild it;
 *   3-4. two rolling anchors in the message history (see pickMessageBreakpoints).
 *
 * Verified working on the legacy bedrock-runtime path with a Bedrock bearer
 * token on 2026-07-20: a 3.7k-token prefix dropped input_tokens from 3832 to 79
 * with cache_read_input_tokens=3753 on the second and third calls. Anthropic's
 * docs steer Opus 4.7+ callers to the Mantle endpoint "for full feature parity"
 * and do not promise this path caches — so the CO_DEBUG_TIMING counters below
 * are the standing check, not a nicety. If cache_read_input_tokens goes to zero
 * and stays there, something upstream of the breakpoints started changing.
 *
 * TTL is one hour, not the five-minute default, and that is the single biggest
 * cost lever in the whole program. A co-manager is a thinking partner: the
 * captain reads an answer, thinks for ten minutes, then replies. Under the
 * default TTL every one of those pauses expires the entry and the next turn
 * re-writes the whole ~22k-token prefix at 1.25x instead of reading it at 0.1x
 * — a 12.5x swing on the dominant input term, paid several times a session.
 * The hour costs a 2x write premium instead of 1.25x, which pays for itself
 * from the second read onward; only a strictly one-turn session is worse off.
 *
 * `ttl` is a first-party API field that this legacy Bedrock path does not
 * document, so it was measured rather than assumed (2026-07-27): a unique
 * prefix written under ttl "1h" returned cache_creation=2216/read=0, and the
 * same prefix seven minutes later — well past the five-minute default expiry —
 * returned cache_creation=0/read=2216. Survival past an hour was not measured;
 * what mattered was proving the entry is not on the default clock. If a future
 * SDK or endpoint change rejects the field, drop back to a bare `ephemeral`.
 */
export const CACHE_TTL = "1h" as const;

const CACHE_CONTROL = { type: "ephemeral" as const, ttl: CACHE_TTL };

/**
 * How many content blocks back the lagging message breakpoint sits. Each
 * breakpoint can only look back ~20 blocks to find an entry an earlier request
 * already wrote; a research turn stacking several tool_use/tool_result pairs
 * can blow past that in one round, at which point the newest breakpoint finds
 * nothing to read and every turn silently pays full price. The lagging anchor
 * keeps a written entry inside the window.
 */
const LOOKBACK_BLOCK_BUDGET = 15;

function blockCount(m: MessageParam): number {
  return typeof m.content === "string" ? 1 : m.content.length;
}

/**
 * Indices of the messages whose final content block should carry a breakpoint:
 * the newest message, plus one far enough back to stay inside the lookback
 * window. Returns at most two.
 */
function pickMessageBreakpoints(messages: MessageParam[]): Set<number> {
  const marks = new Set<number>();
  if (messages.length === 0) return marks;

  const newest = messages.length - 1;
  marks.add(newest);

  let blocks = 0;
  for (let i = newest; i >= 0; i--) {
    blocks += blockCount(messages[i]!);
    if (blocks >= LOOKBACK_BLOCK_BUDGET && i > 0) {
      marks.add(i - 1);
      break;
    }
  }
  return marks;
}

/** A copy of `m` whose last content block carries a cache breakpoint. */
function markMessage(m: MessageParam): MessageParam {
  // A string body has to become a block before it can carry cache_control.
  // Semantically identical to the API.
  if (typeof m.content === "string") {
    return { ...m, content: [{ type: "text", text: m.content, cache_control: CACHE_CONTROL }] };
  }
  if (m.content.length === 0) return m;
  const content = m.content.map((b, i) =>
    i === m.content.length - 1 ? ({ ...b, cache_control: CACHE_CONTROL } as ContentBlockParam) : b,
  );
  return { ...m, content };
}

/**
 * Apply the rolling message breakpoints, without touching the caller's array.
 * The session's own history stays free of cache_control so markers can't
 * accumulate past the 4-per-request ceiling as the conversation grows.
 */
function withMessageBreakpoints(messages: MessageParam[]): MessageParam[] {
  const marks = pickMessageBreakpoints(messages);
  if (marks.size === 0) return messages;
  return messages.map((m, i) => (marks.has(i) ? markMessage(m) : m));
}

/** Tool definitions with a breakpoint on the last one, closing the tools prefix. */
function withToolBreakpoint(tools: Tool[]): Tool[] {
  if (tools.length === 0) return tools;
  return tools.map((t, i) =>
    i === tools.length - 1 ? ({ ...t, cache_control: CACHE_CONTROL } as Tool) : t,
  );
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/**
 * Output cap on a cache-refresh probe. The reply is discarded, so this only has
 * to be large enough that the request is legal and does not error — every token
 * of it is waste, and adaptive thinking is on, so the model will almost always
 * hit this cap rather than finish. That is fine and expected: at the Opus 5
 * output rate this ceiling costs a tenth of a cent, against the dollars a
 * rebuilt prefix costs.
 */
const CACHE_PROBE_MAX_TOKENS = 64;

/**
 * The history truncated to end on the last user-role message, or null if there
 * isn't one.
 *
 * This is what makes a refresh free of side effects. The obvious probe — append
 * a throwaway message and send that — writes a NEW cache entry for the appended
 * bytes, and Opus 5 rejects a trailing assistant message outright, so the
 * history cannot simply be replayed as it stands either. Cutting back to the
 * last user turn sidesteps both: the prefix is byte-identical to one a real
 * round already wrote, so the probe is a pure read that resets the clock on an
 * entry the NEXT turn will actually want.
 *
 * Cutting from the end can only ever orphan a `tool_use` by removing the
 * `tool_result` that answered it, never the reverse, and a completed turn always
 * ends assistant-side — so the pairs left behind are intact.
 */
function throughLastUserTurn(messages: MessageParam[]): MessageParam[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return messages.slice(0, i + 1);
  }
  return null;
}

export class ModelProvider {
  private client: AnthropicBedrock;
  private cfg: ModelConfig;
  /**
   * Tokens billed since the last drain, summed across every round of every turn.
   *
   * Accumulated unconditionally — unlike the CO_DEBUG_TIMING counters, which
   * report the same numbers as a diagnostic and are off by default. Spend
   * happens whether or not anyone asked to watch it, so the meter always runs;
   * `/cost` is the only thing that ever shows it (see cost.ts).
   */
  private pending: TokenUsage = emptyUsage();
  /** Wall-clock spent inside runTurn since the last drain — the time the
   *  captain actually waited, which is the other half of "what did this cost".
   *  Measured for every turn, not just under CO_DEBUG_TIMING. */
  private pendingMs = 0;
  /**
   * Model calls made since the last drain. A "turn" is one thing the captain
   * asked for; a ROUND is one HTTP request to the model, and a turn that uses
   * tools makes several. This is the multiplier on the whole prompt side of the
   * bill: the entire prefix and the entire history are re-sent on every round,
   * so cost-per-turn is rounds x (prefix + history), and a per-turn average
   * cannot be read without knowing rounds. Counted unconditionally for the same
   * reason the tokens are — the requests happened whether or not anyone watched.
   */
  private pendingRounds = 0;
  /**
   * Cache-write tokens billed on the FIRST round of each turn since the drain.
   *
   * This is the expiry meter, and it is the one number that decides whether a
   * cache keep-alive is worth building. By the first round of turn N the prefix
   * has already been written by turn N-1, so a warm cache should write almost
   * nothing here — just the new user message. A large figure means the entry
   * lapsed during the captain's thinking pause and the whole prefix was rebuilt
   * at the 2x write rate, which is 20x what reading it would have cost.
   *
   * Deliberately first-round-only. Later rounds in a turn legitimately write the
   * tool_use/tool_result blocks they just created, and folding those in would
   * bury the signal under normal growth.
   */
  private pendingRebuild = 0;

  constructor(cfg: ModelConfig) {
    this.cfg = cfg;
    // apiKey defaults to AWS_BEARER_TOKEN_BEDROCK inside the SDK; we pass the
    // resolved BEDROCK_API_KEY/AWS_BEARER_TOKEN_BEDROCK explicitly if present.
    // When absent, the SDK falls back to the AWS credential provider chain
    // (env vars, shared config, SSO) and SigV4-signs requests.
    //
    // Endpoint choice is deliberate, not a leftover. AnthropicBedrock is the
    // classic bedrock-runtime path; the SDK also ships AnthropicBedrockMantle
    // (bedrock-mantle.<region>.api.aws, native Messages API), which general
    // guidance calls the "new default" for recent models. It is NOT usable
    // here: with our company Bedrock API key, Opus 4.8 answers on this path at
    // the cross-region inference-profile id `us.anthropic.claude-opus-4-8`,
    // while the Mantle endpoint 404s ("model does not exist") for the same key
    // and every id format — our account isn't entitled to Mantle. This mirrors
    // Claude Code's own working setup (CLAUDE_CODE_USE_BEDROCK=1, Mantle off).
    // Verified end-to-end against the live key on 2026-07-16, and re-confirmed
    // 2026-07-27 (runtime ✓ / Mantle 404 for the same id). Don't switch to
    // Mantle without re-confirming entitlement, or the model will break.
    //
    // Re-confirmed 2026-07-20, this time including the id form Anthropic's docs
    // actually publish for Mantle (bare `anthropic.claude-opus-4-8`, no geo
    // prefix). All three forms — bare, `us.`-prefixed, and `claude-opus-4-8` —
    // 404 on Mantle. On runtime only the `us.`-prefixed form works: the bare id
    // is rejected with "on-demand throughput isn't supported, retry with an
    // inference profile", which is why the prefix is load-bearing rather than
    // decorative. Note `us.anthropic.claude-opus-4-8` is undocumented (the geo
    // prefix table stops at Opus 4.6) and Anthropic steers 4.7+ callers to
    // Mantle "for full feature parity" without enumerating what legacy lacks —
    // so treat feature support here as empirical, not promised. Prompt caching
    // was measured working on this path the same day (see CACHE_CONTROL below).
    //
    // The same holds for the Sonnet line, checked on 2026-07-27 while costing
    // out a cheaper default: `us.anthropic.claude-sonnet-4-6` and
    // `us.anthropic.claude-sonnet-5` both answer on runtime and both reject the
    // un-prefixed `anthropic.claude-sonnet-*` form for on-demand throughput.
    // Adaptive thinking, tools, and prompt caching were all exercised together
    // on Sonnet 4.6 here (cache_read 3477 on the second identical call), so the
    // whole turn shape this file builds is known-good on the cheaper models if
    // that trade is ever worth making — the one thing that is NOT is
    // effort=xhigh, which 400s below Opus 4.7 (see effortLevelsFor).
    this.client = new AnthropicBedrock({
      awsRegion: cfg.region,
      ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
    });
  }

  /** Effort currently sent with every turn. */
  get effort(): Effort | undefined {
    return this.cfg.effort;
  }

  /** The Bedrock model id every turn is sent to. Read by /effort and /status. */
  get modelId(): string {
    return this.cfg.modelId;
  }

  /**
   * Take everything billed since the last call, plus the wall-clock it took,
   * and reset the counters.
   *
   * Drain-and-reset rather than a running getter so the caller can fold each
   * turn into the durable ledger exactly once, with no risk of double-counting.
   * The session drains in a `finally`, so a turn that throws part-way still
   * banks the rounds that already completed and were already billed. (Tokens
   * spent on a round that threw mid-stream are lost to the meter — the SDK
   * gives us no usage for a message that never finalized. The elapsed time is
   * still counted: the captain waited for it either way.)
   */
  drainUsage(): { usage: TokenUsage; ms: number; rounds: number; rebuild: number } {
    const drained = {
      usage: this.pending,
      ms: this.pendingMs,
      rounds: this.pendingRounds,
      rebuild: this.pendingRebuild,
    };
    this.pending = emptyUsage();
    this.pendingMs = 0;
    this.pendingRounds = 0;
    this.pendingRebuild = 0;
    return drained;
  }

  /**
   * Change effort for the rest of the session (/effort). baseParams() is rebuilt
   * per turn, so the next turn picks this up; an in-flight turn is unaffected.
   * cfg is the live ModelConfig object, so the session's own view updates too.
   */
  setEffort(effort: Effort): void {
    this.cfg.effort = effort;
  }

  /**
   * Per-request thinking/effort. `effortOverride` lets a caller run one turn
   * cheaper than the session default (the cold-start greeting does this) without
   * disturbing cfg.
   *
   * Caveat worth knowing: changing effort mid-session may drop the message-tier
   * cache. Anthropic documents `speed`, `tool_choice`, and thinking parameters
   * as invalidators but says nothing either way about output_config.effort, so
   * assume it invalidates. That is fine for the greeting (it is the first call,
   * nothing is cached yet) and it is the accepted cost of /effort.
   */
  private baseParams(effortOverride?: Effort): {
    thinking?: Anthropic.ThinkingConfigParam;
    output_config?: { effort: Effort };
  } {
    const params: {
      thinking?: Anthropic.ThinkingConfigParam;
      output_config?: { effort: Effort };
    } = {};
    if (this.cfg.thinking === "adaptive") {
      params.thinking = { type: "adaptive", display: "summarized" };
    }
    const effort = effortOverride ?? this.cfg.effort;
    if (effort) {
      params.output_config = { effort };
    }
    return params;
  }

  /**
   * Run one assistant turn to completion, resolving any tool calls via the
   * provided executor. Streams text deltas through handlers. Returns the full
   * final message and the (possibly extended) message history.
   *
   * A thin timing shim over the real loop: wall-clock is banked in a `finally`
   * so a turn that throws still records the time the captain spent waiting for
   * it. Keeping the shim separate is what lets the loop below keep its early
   * returns instead of being wrapped in a try block.
   */
  async runTurn(args: TurnArgs): Promise<{ messages: MessageParam[]; finalText: string }> {
    const startedAt = Date.now();
    try {
      return await this.runTurnInner(args);
    } finally {
      this.pendingMs += Date.now() - startedAt;
    }
  }

  private async runTurnInner(
    args: TurnArgs,
  ): Promise<{ messages: MessageParam[]; finalText: string }> {
    const { system, tools, executor, handlers } = args;
    const messages = [...args.messages];
    const maxRounds = args.maxToolRounds ?? 12;
    const base = this.baseParams(args.effort);
    const timing = this.cfg.debugTiming ? handlers?.onTiming : undefined;
    // Built once per turn: neither the tool list nor the system prompt changes
    // between rounds, and rebuilding them would churn the cached prefix.
    const cachedTools = withToolBreakpoint(tools);
    const cachedSystem: Anthropic.TextBlockParam[] = [
      { type: "text", text: system, cache_control: CACHE_CONTROL },
    ];
    const turnStart = Date.now();
    let finalText = "";

    for (let round = 0; round < maxRounds; round++) {
      const roundStart = Date.now();
      let firstTokenAt: number | null = null;

      const stream = this.client.messages.stream({
        model: this.cfg.modelId,
        max_tokens: this.cfg.maxTokens,
        system: cachedSystem,
        messages: withMessageBreakpoints(messages),
        ...(cachedTools.length ? { tools: cachedTools } : {}),
        ...base,
      });

      for await (const event of stream) {
        // Thinking deltas are deliberately not surfaced: the model still thinks
        // (see baseParams) and thinking blocks are still preserved verbatim in
        // the message history below — we just don't render them to the user.
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          firstTokenAt ??= Date.now();
          finalText += event.delta.text;
          handlers?.onText?.(event.delta.text);
        }
      }

      const message = await stream.finalMessage();

      // Meter first, and unconditionally: everything below this line is either
      // optional diagnostics or an early return, and the tokens are billed
      // either way. Every field is read defensively — a counter is the least
      // load-bearing thing in this file, and a missing usage block must cost an
      // inaccurate /cost line, never the captain's turn.
      const billed = message.usage;
      this.pendingRounds += 1;
      if (billed) {
        this.pending.input += billed.input_tokens ?? 0;
        this.pending.cacheWrite += billed.cache_creation_input_tokens ?? 0;
        this.pending.cacheRead += billed.cache_read_input_tokens ?? 0;
        this.pending.output += billed.output_tokens ?? 0;
        // Only the opening round of the turn: see pendingRebuild. A big number
        // here is a lapsed cache, not a big prompt.
        if (round === 0) this.pendingRebuild += billed.cache_creation_input_tokens ?? 0;
      }

      if (timing) {
        const u = message.usage;
        const ttft = firstTokenAt ? fmtMs(firstTokenAt - roundStart) : "—";
        // input_tokens counts only what followed the last breakpoint, so a small
        // number here means the cache worked, not that the prompt was small.
        timing(
          `round ${round + 1}: ${fmtMs(Date.now() - roundStart)} (first token ${ttft}) · ` +
            `in ${u.input_tokens} cache+${u.cache_creation_input_tokens ?? 0}/` +
            `read ${u.cache_read_input_tokens ?? 0} · out ${u.output_tokens} · ` +
            `stop ${message.stop_reason}`,
        );
      }

      // Persist the assistant turn verbatim (preserves tool_use + thinking blocks).
      messages.push({ role: "assistant", content: message.content });

      const toolUses = message.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );

      if (message.stop_reason !== "tool_use" || toolUses.length === 0) {
        // Natural end of turn.
        finalText = collectText(message);
        timing?.(`turn: ${fmtMs(Date.now() - turnStart)} over ${round + 1} round(s)`);
        return { messages, finalText };
      }

      // Announce every call before any of them run, so the UI reflects the whole
      // batch rather than revealing it one at a time.
      for (const tu of toolUses) handlers?.onToolUse?.(tu.name, tu.input);

      // Execute concurrently. A round asking for three sources serially costs up
      // to 3x the fetch timeout; in parallel it costs one. Promise.all preserves
      // input order, so results still line up with toolUses, and the API requires
      // all results for a round to come back in a single user message — which is
      // what we push below. Memory writes are serialized inside the executor
      // (see memory.ts), so concurrency here can't interleave them.
      const executed = await Promise.all(toolUses.map((tu) => executor(tu)));
      const results: ContentBlockParam[] = executed.map((r) => ({
        type: "tool_result",
        tool_use_id: r.tool_use_id,
        content: r.content,
        ...(r.is_error ? { is_error: true } : {}),
      }));
      messages.push({ role: "user", content: results });
    }

    // Ran out of tool rounds; return whatever text we have.
    timing?.(`turn: ${fmtMs(Date.now() - turnStart)} — hit the ${maxRounds}-round cap`);
    return { messages, finalText };
  }

  /**
   * Touch the cached prefix so its TTL restarts, instead of letting it lapse and
   * paying to rebuild it.
   *
   * The economics are the whole justification and they are lopsided. A cache hit
   * is billed at 0.1x base input; a 1-hour write is billed at 2x. So re-reading
   * a prefix costs a TWENTIETH of re-writing the same bytes, and Bedrock resets
   * the TTL on every successful hit — AWS's own guidance is explicit that a
   * regularly-hit entry "will continue to be refreshed at no additional charge".
   * A co-manager is a thinking partner, so the captain reads an answer and comes
   * back twenty minutes later; without this, each of those pauses that outlives
   * the TTL bills the entire prefix at the premium rate.
   *
   * Deliberately built to send a prefix byte-identical to a real round: same
   * system text, same tool list, same breakpoints, same thinking and effort
   * params. Any difference and it writes a fresh entry rather than hitting the
   * one we are trying to keep alive, which would make it strictly worse than
   * doing nothing. That is also why nothing here is "optimised" into a smaller
   * request.
   *
   * Returns null when there is nothing to refresh (no user turn yet). Never
   * throws: a probe is an optimisation, and a failed one must cost an unrefreshed
   * cache, never the captain's session.
   */
  async refreshCache(args: {
    system: string;
    messages: MessageParam[];
    tools: Tool[];
  }): Promise<{ usage: TokenUsage; ms: number } | null> {
    const replay = throughLastUserTurn(args.messages);
    if (!replay) return null;

    const startedAt = Date.now();
    const usage = emptyUsage();
    try {
      const message = await this.client.messages.create({
        model: this.cfg.modelId,
        max_tokens: CACHE_PROBE_MAX_TOKENS,
        system: [{ type: "text", text: args.system, cache_control: CACHE_CONTROL }],
        messages: withMessageBreakpoints(replay),
        ...(args.tools.length ? { tools: withToolBreakpoint(args.tools) } : {}),
        ...this.baseParams(),
      });
      const billed = message.usage;
      if (billed) {
        usage.input += billed.input_tokens ?? 0;
        usage.cacheWrite += billed.cache_creation_input_tokens ?? 0;
        usage.cacheRead += billed.cache_read_input_tokens ?? 0;
        usage.output += billed.output_tokens ?? 0;
      }
    } catch {
      // Swallowed on purpose. A refused or timed-out probe leaves the cache
      // exactly as it was; surfacing it would put an error in front of the
      // captain about work they never asked for.
      return null;
    }
    return { usage, ms: Date.now() - startedAt };
  }

  /** A minimal non-streaming ping used by `co doctor` to test connectivity. */
  async ping(): Promise<string> {
    const msg = await this.client.messages.create({
      model: this.cfg.modelId,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
    });
    return collectText(msg);
  }
}

function collectText(message: Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}
