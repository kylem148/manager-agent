import type { MessageParam, Tool } from "../model.js";
import type { TokenUsage } from "../cost.js";

/**
 * The cache keep-alive.
 *
 * Bedrock resets a cache entry's TTL on every successful hit, and a hit is billed
 * at a tenth of base input while a 1-hour write is billed at double it. So
 * touching a prefix costs a TWENTIETH of rebuilding the same bytes, and an entry
 * that keeps getting touched never has to be rebuilt at all.
 *
 * That spread is what makes this worth a timer. A co-manager is a thinking
 * partner: the captain reads an answer, thinks for twenty minutes, and replies.
 * Every one of those pauses that outlives the TTL bills the whole prefix at the
 * premium rate on the next turn — the most expensive avoidable thing the app
 * does, and invisible, because it shows up as a cache-write number nobody was
 * looking at.
 *
 * Three properties matter more than the saving:
 *
 *  - It never runs over the top of a turn. A probe issued mid-turn would race the
 *    real request for the same cache entry and could write where the turn meant
 *    to read.
 *  - It gives up. After a few unanswered probes the captain has walked away, and
 *    refreshing a cache nobody is going to read is pure waste — worse than
 *    letting it lapse, because it recurs.
 *  - It is silent and it cannot throw. This is an optimisation running behind a
 *    prompt; a failure has to cost an unrefreshed cache and nothing else.
 */

/** What one probe needs: the exact prefix a real turn would send. */
export interface KeepAliveSnapshot {
  system: string;
  messages: MessageParam[];
  tools: Tool[];
}

export interface KeepAliveDeps {
  /**
   * How long to wait after the last model request before probing. Must be
   * comfortably inside the cache TTL — the point is to hit the entry while it is
   * still alive, and a probe that arrives late pays the rebuild it existed to
   * avoid.
   */
  intervalMs: number;
  /**
   * How many probes in a row to send with no real turn in between before giving
   * up. Bounds the cost of a session left open overnight: without it, an
   * abandoned terminal quietly refreshes a prefix until morning.
   */
  maxConsecutive: number;
  /** True while a turn is in flight. Probes stand down rather than queue. */
  isBusy: () => boolean;
  /** The current prefix, or null when there is nothing worth keeping warm. */
  snapshot: () => KeepAliveSnapshot | null;
  /** Sends the probe. Resolves null when it could not run or did not bill. */
  refresh: (s: KeepAliveSnapshot) => Promise<{ usage: TokenUsage; ms: number } | null>;
  /** Meters the probe. Kept separate from the turn meter by the caller. */
  record: (usage: TokenUsage, ms: number) => Promise<void>;
  /** Diagnostic sink, wired only under CO_DEBUG_TIMING. Never user-facing. */
  onNote?: (line: string) => void;
}

export interface KeepAlive {
  /** Called after every real turn: resets the clock and the give-up counter. */
  noteTurn: () => void;
  /** Idempotent. Safe to call from a `finally`. */
  stop: () => void;
}

/**
 * Start probing. Returns a handle; the caller owns stopping it.
 *
 * A single self-rescheduling timer rather than setInterval, so a slow probe can
 * never overlap the next one, and `unref` so a pending probe timer cannot hold
 * the process open at exit.
 */
export function startCacheKeepAlive(deps: KeepAliveDeps): KeepAlive {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let consecutive = 0;

  const arm = () => {
    if (stopped) return;
    if (consecutive >= deps.maxConsecutive) {
      deps.onNote?.(`keep-alive: standing down after ${consecutive} unanswered probe(s)`);
      return;
    }
    timer = setTimeout(fire, deps.intervalMs);
    // Never keep the event loop alive on account of a cache probe.
    timer.unref?.();
  };

  const fire = async () => {
    timer = null;
    if (stopped) return;
    // A turn in flight is already refreshing the cache far better than we can.
    // Re-arm and let it; the turn's own noteTurn will reset the clock.
    if (deps.isBusy()) {
      arm();
      return;
    }
    const snap = deps.snapshot();
    if (!snap) {
      arm();
      return;
    }

    consecutive += 1;
    const result = await deps.refresh(snap).catch(() => null);
    if (stopped) return;
    if (result) {
      await deps.record(result.usage, result.ms).catch(() => {});
      // read >> write is the outcome we want; the reverse means the entry had
      // already lapsed and this probe paid to rebuild it rather than touch it.
      deps.onNote?.(
        `keep-alive: read ${result.usage.cacheRead} / wrote ${result.usage.cacheWrite}` +
          ` in ${Math.round(result.ms)}ms (probe ${consecutive})`,
      );
    }
    arm();
  };

  arm();

  return {
    noteTurn: () => {
      consecutive = 0;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      arm();
    },
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
