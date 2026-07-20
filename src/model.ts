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

  private baseParams(): {
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
    if (this.cfg.effort) {
      params.output_config = { effort: this.cfg.effort };
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
  }): Promise<{ messages: MessageParam[]; finalText: string }> {
    const { system, tools, executor, handlers } = args;
    const messages = [...args.messages];
    const maxRounds = args.maxToolRounds ?? 12;
    const base = this.baseParams();
    let finalText = "";

    for (let round = 0; round < maxRounds; round++) {
      const stream = this.client.messages.stream({
        model: this.cfg.modelId,
        max_tokens: this.cfg.maxTokens,
        system,
        messages,
        ...(tools.length ? { tools } : {}),
        ...base,
      });

      let sawToolInThisRound = false;
      for await (const event of stream) {
        // Thinking deltas are deliberately not surfaced: the model still thinks
        // (see baseParams) and thinking blocks are still preserved verbatim in
        // the message history below — we just don't render them to the user.
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          finalText += event.delta.text;
          handlers?.onText?.(event.delta.text);
        }
      }

      const message = await stream.finalMessage();
      // Persist the assistant turn verbatim (preserves tool_use + thinking blocks).
      messages.push({ role: "assistant", content: message.content });

      const toolUses = message.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );

      if (message.stop_reason !== "tool_use" || toolUses.length === 0) {
        // Natural end of turn.
        finalText = collectText(message);
        return { messages, finalText };
      }

      sawToolInThisRound = true;
      const results: ContentBlockParam[] = [];
      for (const tu of toolUses) {
        handlers?.onToolUse?.(tu.name, tu.input);
        const r = await executor(tu);
        results.push({
          type: "tool_result",
          tool_use_id: r.tool_use_id,
          content: r.content,
          ...(r.is_error ? { is_error: true } : {}),
        });
      }
      messages.push({ role: "user", content: results });

      if (!sawToolInThisRound) break;
    }

    // Ran out of tool rounds; return whatever text we have.
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
