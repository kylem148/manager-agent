import type { MessageParam, ContentBlockParam } from "../model.js";

/**
 * Layer 2: the history ceiling.
 *
 * The conversation is re-sent on every round of every turn, so cost per turn
 * climbs for the life of a session. This puts a HARD ceiling on it, denominated
 * in bytes (the same unit every other layer budgets in - see prompt.ts): when
 * history crosses the cap, everything but a recent tail of intact exchanges is
 * replaced by a model-written summary.
 *
 * The ceiling is generous on purpose. Trimming trades cheap reads for
 * expensive writes: a cached read bills at 0.1x base input and a 1-hour write
 * at 2x, and every compaction rewrites the retained context, so compacting
 * often reliably spends MORE than doing nothing. A normal working session
 * should never reach the cap; what the cap buys is that the runaway session
 * trims in a controlled way instead of growing until the API refuses it.
 *
 * Hysteresis is structural rather than tuned: the retained tail is a handful
 * of turns, a small fraction of the cap, so one compaction buys a long run of
 * cache-clean growth before the ceiling can engage again.
 *
 * Nothing here loses information the co can't get back: the transcript is
 * written every turn, and the memory logs are append-only and searchable.
 * Compaction moves detail out of the live window, not off the disk.
 */

/** Bytes of a message array as the wire would carry it, near enough. */
export function historyBytes(messages: MessageParam[]): number {
  let bytes = 0;
  for (const m of messages) {
    bytes +=
      typeof m.content === "string"
        ? Buffer.byteLength(m.content, "utf8")
        : Buffer.byteLength(JSON.stringify(m.content), "utf8");
  }
  return bytes;
}

/**
 * True when this message can start the retained tail.
 *
 * Two hard API constraints, and getting either wrong is a 400 rather than a
 * degradation. The first message must be user-role. And a `tool_result` must
 * still be preceded by the `tool_use` that asked for it - so a user message
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
 * The summary goes in as a user message. Two consecutive user messages are
 * legal - the API folds them into one turn - so this needs no filler assistant
 * turn, and adding one would put words in the co's mouth it never said.
 *
 * `orientation` restores an invariant the old architecture had by accident:
 * live state used to sit in the system prompt and could never leave the
 * window, so a whole-file rewrite always had the old content in view. Now
 * orientation enters as history (the startup injection), and this cut is the
 * one place it can vanish - after which a later rewrite of activeContext.md
 * would be written from a window missing standing facts, shedding them
 * permanently with nothing failing. So the compaction message re-carries the
 * current files verbatim, hardcoded, the same mechanism-over-judgment move as
 * the protocol gate. A few KB, once, in a session that just freed far more.
 */
export function applyCompaction(
  messages: MessageParam[],
  cut: number,
  summary: string,
  orientation?: string,
): MessageParam[] {
  return [
    {
      role: "user",
      content:
        "[Earlier conversation, compacted to keep this session under its" +
        " context ceiling. This is your own summary of what came before; the" +
        " full exchange is in the session transcript and the memory logs if" +
        " you need detail from it.]\n\n" +
        summary +
        (orientation
          ? "\n\n[Your live orientation, re-read from disk at this compaction" +
            " so it stays in front of you whatever the summary kept:]\n\n" +
            orientation
          : ""),
    },
    ...messages.slice(cut),
  ];
}

/** Everything the compactor needs to decide, with no session or model in sight. */
export interface CompactionPlan {
  /** Index the retained tail starts at. */
  cut: number;
  /** History bytes before compacting. */
  before: number;
  /** Bytes the retained tail alone accounts for. */
  after: number;
}

/**
 * Decide whether to compact, and where. The ceiling is HARD: over the cap,
 * this returns a plan whenever any safe cut exists at all.
 *
 * It first tries to keep `keepTurns` intact exchanges. If the tail those
 * turns make is itself still over the cap (a run of enormous tool results),
 * it keeps fewer, down to the final exchange alone - the most that can be
 * dropped safely. Null only below the cap, or when no legal cut exists (the
 * history is effectively one giant exchange, which nothing can split without
 * a malformed request).
 */
export function planCompaction(
  messages: MessageParam[],
  opts: { maxBytes: number; keepTurns: number },
): CompactionPlan | null {
  const before = historyBytes(messages);
  if (before <= opts.maxBytes) return null;
  let best: CompactionPlan | null = null;
  for (let keep = Math.max(0, opts.keepTurns); keep >= 0; keep--) {
    const cut = findCompactionCut(messages, keep);
    if (cut === null) continue;
    const after = historyBytes(messages.slice(cut));
    best = { cut, before, after };
    if (after <= opts.maxBytes) break;
  }
  return best;
}
