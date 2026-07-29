import type { MessageParam, ContentBlockParam } from "../model.js";

/**
 * Mid-session history compaction.
 *
 * The conversation grows every turn and the whole of it is re-sent on every
 * round of every turn, so cost per turn climbs for the life of a session. This
 * puts a ceiling on that.
 *
 * The ceiling is deliberately GENEROUS, and that is the whole design. Trimming
 * trades cheap reads for expensive writes: a cached read is billed at 0.1x base
 * input and a 1-hour write at 2x, so dropping history has to save twenty read
 * tokens for every write token it costs before it breaks even. Every compaction
 * rewrites the retained context, so compacting often is a reliable way to spend
 * MORE than doing nothing. Measured against this app's own ledger, a session of
 * ~17 turns is better off never compacting at all; the crossover sits around 24.
 *
 * So this is a guard against the runaway session, not a routine tidy-up. It
 * should fire rarely or never on a normal working session, and the defaults are
 * picked to make that true.
 *
 * Nothing here loses information the co can't get back: the transcript is
 * written every turn, and decisions/progress/research are append-only and
 * searchable. Compaction moves detail out of the live window, not off the disk.
 */

/**
 * Bytes per token, for deciding WHEN to compact.
 *
 * An estimate on purpose. The Bedrock runtime path exposes no token counter
 * (the SDK omits countTokens), and the only exact figure arrives in the usage
 * block after a request has already been billed. 3.8 is measured against this
 * app's own prefix — markdown and JSON tokenize denser than the ~4 rule of
 * thumb, and Opus 4.7+ uses a tokenizer producing ~30% more tokens for the same
 * text. Being off by a fifth moves the trigger point, which is a threshold with
 * a wide safe band; it cannot make the result wrong.
 */
const BYTES_PER_TOKEN = 3.8;

/** Rough token count of a message array. See BYTES_PER_TOKEN. */
export function estimateTokens(messages: MessageParam[]): number {
  let bytes = 0;
  for (const m of messages) {
    bytes +=
      typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
  }
  return Math.round(bytes / BYTES_PER_TOKEN);
}

/**
 * True when this message can start the retained tail.
 *
 * Two hard API constraints, and getting either wrong is a 400 rather than a
 * degradation. The first message must be user-role. And a `tool_result` must
 * still be preceded by the `tool_use` that asked for it — so a user message
 * carrying tool results is NOT a legal cut point, because the assistant turn
 * holding its `tool_use` blocks would be left behind on the other side.
 */
function isCutPoint(m: MessageParam): boolean {
  if (m.role !== "user") return false;
  if (typeof m.content === "string") return true;
  return !m.content.some((b: ContentBlockParam) => b.type === "tool_result");
}

/**
 * Index the retained tail should start at, keeping at least `keepTurns` intact
 * exchanges, or null when there is nothing safe to drop.
 *
 * Walks back from the end so the most recent context is always what survives,
 * and returns null rather than a bad cut: leaving history uncompacted costs
 * money, but a malformed history costs the captain their turn.
 */
export function findCompactionCut(
  messages: MessageParam[],
  keepTurns: number,
): number | null {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isCutPoint(messages[i]!)) continue;
    seen += 1;
    if (seen > keepTurns) {
      // Never cut at 0: that would drop nothing while still paying to rewrite
      // the entire history, which is the worst of both.
      return i === 0 ? null : i;
    }
  }
  return null;
}

/**
 * Replace everything before `cut` with a summary, keeping the tail verbatim.
 *
 * The summary goes in as a user message. Two consecutive user messages are legal
 * — the API folds them into one turn — so this needs no filler assistant turn to
 * separate it from the retained tail, and adding one would put words in the co's
 * mouth that it never said.
 */
export function applyCompaction(
  messages: MessageParam[],
  cut: number,
  summary: string,
): MessageParam[] {
  return [
    {
      role: "user",
      content:
        "[Earlier conversation, compacted to keep this session's context" +
        " affordable. This is your own summary of what came before; the full" +
        " exchange is in the session transcript and the memory logs if you need" +
        " detail from it.]\n\n" +
        summary,
    },
    ...messages.slice(cut),
  ];
}

/** Everything the compactor needs to decide, with no session or model in sight. */
export interface CompactionPlan {
  /** Index the retained tail starts at. */
  cut: number;
  /** Estimated tokens before compacting. */
  before: number;
  /** Estimated tokens the retained tail alone accounts for. */
  after: number;
}

/**
 * Decide whether to compact, and where.
 *
 * Returns null unless compacting would actually pay: over the threshold, a safe
 * cut point exists, AND the cut releases enough to be worth the rewrite it
 * costs. That last check is the one that matters — a compaction that drops a few
 * thousand tokens still rewrites the whole retained tail, so firing on a small
 * win is how this feature would end up costing more than it saves.
 */
export function planCompaction(
  messages: MessageParam[],
  opts: { triggerTokens: number; keepTurns: number; minReleaseTokens: number },
): CompactionPlan | null {
  const before = estimateTokens(messages);
  if (before < opts.triggerTokens) return null;
  const cut = findCompactionCut(messages, opts.keepTurns);
  if (cut === null) return null;
  const after = estimateTokens(messages.slice(cut));
  if (before - after < opts.minReleaseTokens) return null;
  return { cut, before, after };
}
