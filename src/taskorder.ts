/**
 * The one definition of what order the task table is READ in.
 *
 * The store keeps the order rows were typed in, and that is the right thing for
 * a store: `add` appends, `retire` lifts one row out and leaves the rest where
 * they were, and a status toggle rewrites nothing. But insertion order is not
 * the order the table is useful in — the row actually being worked could sit
 * anywhere in the list, under two rows waiting their turn — so every surface
 * that SHOWS the table paints `building` first (D-20260729-5).
 *
 * It lives at the top level, beside `ui` and `config`, because three surfaces
 * need it and no two of them share a layer: the panel's Home tab (tui, which
 * deliberately never imports the session layer), the `task_table` tool, and the
 * live-state block in the system prompt. Three copies of a sort rule is three
 * chances for the captain and the co to be reading differently-ordered tables
 * and both believe they are looking at "the table".
 *
 * Pure, total, and takes no clock: the live-state block is assembled once per
 * session and sits inside the prompt-cache prefix, so an order that could vary
 * between two assemblies of the same rows would cost the whole cache.
 */

/** The four statuses, structurally. Declared here rather than imported so this
 *  module depends on nothing — taskstore's TaskRow and tui's TaskPanelRow both
 *  satisfy it, which is what lets one function serve both layers. */
export interface HasTaskStatus {
  status: "building" | "enqueued" | "testing" | "queued";
}

/**
 * The display order of a stored table: every `building` row, then every
 * `enqueued` one, then every `testing` one, then every `queued` one, each group
 * holding the relative order it was stored in.
 *
 * That is the order the work runs in, read downward: what is being built, what
 * has been handed to the merge queue, what has landed and is waiting on the
 * captain to check it, then what has not started. Most-active-first, so the two
 * middle groups sit where they will be seen: `enqueued` is a row the queue is
 * carrying, `testing` is a row waiting on THEM — the one group they can clear
 * themselves — and a queue of untested work buried under the backlog is a queue
 * nobody clears.
 *
 * A STABLE PARTITION, not a comparator. `sort` with a small key is only stable
 * because the spec says so nowadays, and it invites a "clever" tiebreak
 * (alphabetical, by length) that would scramble rows the captain deliberately
 * put in an order. Buckets appended in one pass cannot: a row can only ever move
 * past rows of another status.
 *
 * Rows are returned by reference, not copied. Every caller here is handed a
 * fresh array by its own source (`list()` already copies), and re-copying would
 * only hide which array a caller is holding.
 */
export function taskDisplayOrder<T extends HasTaskStatus>(rows: readonly T[]): T[] {
  const building: T[] = [];
  const enqueued: T[] = [];
  const testing: T[] = [];
  const queued: T[] = [];
  // Anything that is not exactly `building`, `enqueued` or `testing` is queued —
  // the same coercion the store's read path makes, so a hand-edited file can
  // never produce a fifth bucket that silently vanishes from the painted table.
  for (const row of rows) {
    if (row.status === "building") building.push(row);
    else if (row.status === "enqueued") enqueued.push(row);
    else if (row.status === "testing") testing.push(row);
    else queued.push(row);
  }
  return [...building, ...enqueued, ...testing, ...queued];
}
