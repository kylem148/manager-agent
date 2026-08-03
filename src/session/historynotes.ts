import type { MessageParam } from "../model.js";
import type { MergeHeadResult } from "./mergequeue.js";

/**
 * Events the model must KNOW about but must not be woken for.
 *
 * There is exactly one path into the model's history — a user-role `SYSTEM:`
 * message appended to state.messages — and this does not add a second one. It
 * adds the other half of the queue that already feeds that path. `queueNotices`
 * carries the things the co must ANSWER, so each one is drained by driving a
 * turn; these are things it must merely have SEEN, so they are flushed into the
 * history immediately ahead of whatever the next turn turns out to be, and
 * nothing is woken to read them.
 *
 * Which matters because several things the co depends on happen entirely outside
 * its loop, and it was left guessing at every one of them:
 *
 *  - an ARMED dispatch is resolved by the captain's next keystroke, in the input
 *    loop, with no tool result to report it. The co armed an order and then never
 *    learned whether a typed `confirm` fired it or the next message cancelled it.
 *  - the captain's [m] merges the queue head from the panel with the co nowhere
 *    in the loop (that is the whole design), so a feature could land on dev while
 *    the co went on reporting it as in flight.
 *  - the captain edits a doc in the panel himself. The co is handed
 *    architecture.md and plan.md at startup and holds them for the rest of the
 *    session, so a file rewritten underneath it is a copy it would go on quoting.
 *
 * Ordering is the reason these are buffered rather than pushed where they happen.
 * A cancellation has to sit BEFORE the captain's line in the history — the co
 * must read "you were cancelled" and then what they typed instead, on the one
 * turn it has to react to both. And [m] — or a Ctrl-S in the doc editor — can
 * land at any moment, including mid-turn, where appending straight to
 * state.messages would put a user message between an assistant's tool_use and its
 * tool_result and cost the captain the turn. Buffering solves both: the flush
 * happens at a turn boundary, ahead of the message that turn is about.
 *
 * Every note is one line, and every line names its subject and its outcome —
 * either half alone is useless. Nothing is recorded when nothing happened.
 */

/** The slice of the session these functions write to. */
export interface HistoryNoteSink {
  historyNotes: string[];
}

/**
 * A one-line handle for an order: its first non-empty line, clipped. Shared with
 * the arm banner deliberately, so what the captain reads on the banner and what
 * the co reads in its history are the same words for the same order.
 */
export function firstLineOf(order: string): string {
  const l = order.split("\n").find((x) => x.trim() !== "")?.trim() ?? "";
  return l.length > 80 ? l.slice(0, 77) + "…" : l;
}

/**
 * The captain typed `confirm` and the order launched. Names the order and the
 * agent that is running it, which together are the whole question the co was
 * guessing at.
 */
export function noteDispatchFired(
  sink: HistoryNoteSink,
  d: { order: string; jobId: string; agent?: string; feature?: string },
): void {
  sink.historyNotes.push(
    `SYSTEM: The captain typed \`confirm\`: your armed order "${firstLineOf(d.order)}" was DISPATCHED` +
      ` as job ${d.jobId} to crew agent ${d.agent ?? "the default"}` +
      (d.feature ? ` in feature '${d.feature}'` : " in the bare main tree") +
      `, and is running now.`,
  );
}

/**
 * The captain typed something that was not a confirm, so the armed order died.
 * Flushed ahead of that same line, so the co reads the cancellation and the
 * message that caused it in that order, on one turn.
 */
export function noteDispatchCancelled(sink: HistoryNoteSink, order: string): void {
  sink.historyNotes.push(
    `SYSTEM: The captain did NOT confirm: your armed order "${firstLineOf(order)}" was CANCELLED` +
      ` and nothing was dispatched. What they typed instead follows.`,
  );
}

/**
 * The captain confirmed but the dispatch never launched (no pane, a placement
 * failure). Recorded for the same reason as the other two: without it the co
 * cannot tell a confirm that failed to launch from a confirm that never came,
 * and the absence of a "fired" note would read as the order still being armed.
 */
export function noteDispatchLaunchFailed(
  sink: HistoryNoteSink,
  d: { order: string; error: string },
): void {
  sink.historyNotes.push(
    `SYSTEM: The captain typed \`confirm\`, but your armed order "${firstLineOf(d.order)}" FAILED TO` +
      ` LAUNCH: ${d.error}. Nothing is running and the order is no longer armed.`,
  );
}

/**
 * The captain's [m] on the merge-queue head. Records what the co could not
 * otherwise learn: which feature, which pull request, and whether it landed.
 *
 * Nothing is recorded for an outcome where the keystroke merged nothing and
 * attempted nothing (an empty queue, a head that was not ready, a busy
 * worktree) — [m] is not even offered in those states, and a note about a
 * non-event is noise.
 */
export function noteMergeOutcome(
  sink: HistoryNoteSink,
  res: Pick<MergeHeadResult, "merged" | "outcome" | "feature" | "summary" | "pr" | "target" | "error">,
): void {
  const feature = res.feature ? `feature '${res.feature}'` : "the merge-queue head";
  const pr = res.pr ? ` (PR #${res.pr.number})` : "";
  if (res.merged) {
    sink.historyNotes.push(
      `SYSTEM: The captain pressed [m] in the panel: ${feature}${pr} MERGED into` +
        ` ${res.target ?? "dev"} and has left the merge queue — it is no longer in flight.`,
    );
    return;
  }
  if (res.outcome !== "failed") return;
  sink.historyNotes.push(
    `SYSTEM: The captain pressed [m] in the panel: the merge of ${feature}${pr} FAILED —` +
      ` ${res.error ?? res.summary}. Nothing was merged and it still holds the queue.`,
  );
}

/**
 * The captain saved a doc from the panel's editor (`e` then Ctrl-S).
 *
 * Says that the document MOVED and nothing else — no contents, no turn, no
 * reply. The co has a doc tool and can re-read the file the next time the subject
 * actually comes up, whereas re-injecting the text would put a whole document in
 * the context for a turn that may never mention it. Recorded only for a write
 * that landed: a refusal (the doc changed under the editor, an invalid name)
 * moved nothing, so there is nothing for the co to have seen.
 */
export function noteDocEdited(sink: HistoryNoteSink, name: string): void {
  sink.historyNotes.push(
    `SYSTEM: The captain edited docs/${name} himself just now. Your copy of it is stale —` +
      ` re-read it with the doc tool before relying on it. Say nothing about this.`,
  );
}

/**
 * Move every pending note into the model's history, in the order they happened.
 * Called immediately before the next turn's own message is appended, which is
 * what puts a cancellation ahead of the line that caused it.
 *
 * One user message each. Consecutive user messages are legal — the API folds
 * them into a single turn — which is the same property compaction relies on
 * (see applyCompaction).
 */
export function flushHistoryNotes(sink: HistoryNoteSink, messages: MessageParam[]): void {
  while (sink.historyNotes.length > 0) {
    messages.push({ role: "user", content: sink.historyNotes.shift()! });
  }
}
