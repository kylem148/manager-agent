/**
 * A single serialized lane for every mutating memory/doc operation.
 *
 * Tool calls within one model round now execute concurrently (see model.ts), so
 * two writes can be in flight at the same time. Most of that is harmless —
 * appendFile with O_APPEND won't interleave — but two operations genuinely race:
 *
 *  - append_decision reads the log to mint the next D-YYYYMMDD-N id, then
 *    appends. Two concurrent calls both read the same max and mint the SAME id,
 *    silently producing duplicate decision ids that activeContext then points at.
 *  - doc str_replace is read-modify-write over a whole file, so a concurrent
 *    write to the same doc is lost entirely.
 *
 * Rather than reason per-tool about which pairs are safe, every writer goes
 * through here. Writes are tiny and rare relative to a model round trip, so the
 * lost concurrency costs nothing; the correctness is worth more than the
 * microseconds. Reads deliberately do NOT queue — they're the common case and
 * they can't corrupt anything.
 */

let tail: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` after every previously queued write has settled. Returns fn's result.
 * A rejection is delivered to this caller only: the shared tail is reset to a
 * resolved promise so one failed write never wedges the queue for the session.
 */
export function serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}

/**
 * Change notification, for surfaces that want to react to a completed write.
 *
 * The in-session doc viewer (see tui.ts) subscribes here so an agent write to
 * the doc it is showing refreshes the view live, without polling or an fs.watch.
 * The queue is the right emitter because it already sees every mutating memory
 * and doc operation in one serialized lane: a signal fired here is fired exactly
 * once per write, after the bytes have landed.
 *
 * Only the doc tier emits (docs.ts calls notifyWrite after a successful write);
 * the `.memory/` substrate deliberately does not, so nothing about the hidden
 * substrate is ever observable through this channel. The payload is the bare
 * doc filename — everything a viewer needs to decide "is this the doc I'm on?"
 * without handing out a path.
 */
export type WriteEvent = { kind: "doc"; name: string };
type WriteListener = (e: WriteEvent) => void;

const listeners = new Set<WriteListener>();

/** Subscribe to write events. Returns an unsubscribe function. */
export function onWrite(listener: WriteListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Announce a completed write to every subscriber. A listener that throws must
 * not break the writer that emitted, nor starve the other listeners, so each is
 * called in isolation and its failure is swallowed.
 */
export function notifyWrite(e: WriteEvent): void {
  for (const listener of listeners) {
    try {
      listener(e);
    } catch {
      // A cosmetic refresh is never worth failing a write over.
    }
  }
}
