import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import type { Effort, ModelConfig } from "./config.js";

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
 */
const CACHE_CONTROL = { type: "ephemeral" as const };

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

export class ModelProvider {
  private client: AnthropicBedrock;
  private cfg: ModelConfig;

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
    // Verified end-to-end against the live key on 2026-07-16. Don't switch to
    // Mantle without re-confirming entitlement, or Opus 4.8 will break.
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
    this.client = new AnthropicBedrock({
      awsRegion: cfg.region,
      ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
    });
  }

  /** Effort currently sent with every turn. */
  get effort(): Effort | undefined {
    return this.cfg.effort;
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
   */
  async runTurn(args: {
    system: string;
    messages: MessageParam[];
    tools: Tool[];
    executor: ToolExecutor;
    handlers?: StreamHandlers;
    maxToolRounds?: number;
    /** Run this turn at a different effort than the session default. */
    effort?: Effort;
  }): Promise<{ messages: MessageParam[]; finalText: string }> {
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
