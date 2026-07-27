import fsp from "node:fs/promises";
import path from "node:path";
import type { InstancePaths } from "../paths.js";
import { serializeWrite } from "../memory/writequeue.js";

/**
 * The co's at-a-glance task table, made machine-readable.
 *
 * The table itself is not new: the co has always kept a handful of live items —
 * "you are here", aggressively pruned, one word of status each — and rendered
 * them into the chat from its own memory. Nothing on disk held them, so the
 * Ctrl-O panel had nothing to read and the captain could only see the table by
 * asking for it and paying for a turn.
 *
 * So the table is persisted here, as a small ordered list under the instance's
 * `.dispatch/` dir — beside the feature store and the review inbox, the same tier
 * every other piece of per-instance runtime state lives in, and never inside the
 * user's repo. The co rewrites it WHOLE through one tool (`task_table`); there is
 * deliberately no per-row add/update/remove and no ids, because the table is a
 * handful of rows the co re-derives anyway, and a whole-table write is the only
 * shape that cannot drift out of step with what the co believes.
 *
 * Like the feature store it is a CACHE of the co's own prose, not a source of
 * truth about anything: a missing, corrupt or unwritable file is an empty table
 * and must never fail a session start. Writes swallow their own errors and ride
 * the shared memory write queue, so a whole-file rewrite can't interleave with
 * the other tool calls of one model round.
 */

/** One row of the table: what it is, what kind of work it is, where it stands.
 *  `status` is one word by convention (the prompt says so); nothing here enforces
 *  a vocabulary, because the co picks words that fit the project. */
export interface TaskRow {
  task: string;
  type: string;
  status: string;
}

/**
 * How many rows the table keeps. The table is an at-a-glance summary, not a
 * tracker — the prompt asks for a handful of items and aggressive pruning — so
 * this is a backstop against a model that forgets that, not a budget to fill.
 * A write over the cap is truncated and SAYS SO in the tool result, so the co
 * finds out rather than silently believing it stored 40 rows.
 */
export const TASK_TABLE_CAP = 12;

/** A trimmed, single-line, non-empty string, or undefined. Newlines are folded
 *  out: a row is one line in a table, and a pasted paragraph would tear the
 *  panel's column layout apart. */
function cell(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat === "" ? undefined : flat;
}

/** Coerce one row. A row with no task text is dropped entirely — it would render
 *  as a blank line and mean nothing. Type and status fall back to "—" so a
 *  half-filled row still lines up in its columns. */
function coerceRow(raw: unknown): TaskRow | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const task = cell(o.task);
  if (!task) return undefined;
  return { task, type: cell(o.type) ?? "—", status: cell(o.status) ?? "—" };
}

/** Drop anything that isn't a usable row, and cap the list. A hand-edited or
 *  half-written file can never poison the panel or the next write. */
export function coerceTasks(raw: unknown): TaskRow[] {
  if (!Array.isArray(raw)) return [];
  const out: TaskRow[] = [];
  for (const item of raw) {
    const row = coerceRow(item);
    if (row) out.push(row);
  }
  return out.slice(0, TASK_TABLE_CAP);
}

export class TaskStore {
  private rows: TaskRow[];

  private constructor(
    private readonly filePath: string,
    rows: TaskRow[],
  ) {
    this.rows = rows;
  }

  /**
   * Read the table from disk. A missing file is an empty table (the common first
   * run); a corrupt or unreadable one is ALSO an empty table rather than a failed
   * session start — the same rule the feature store and the review inbox follow.
   */
  static async load(paths: InstancePaths): Promise<TaskStore> {
    const file = paths.taskTable;
    try {
      const raw = await fsp.readFile(file, "utf8");
      return new TaskStore(file, coerceTasks(JSON.parse(raw)));
    } catch {
      return new TaskStore(file, []);
    }
  }

  /** In-memory table with no file behind it, for tests and degraded paths. */
  static ephemeral(rows: unknown = []): TaskStore {
    return new TaskStore("", coerceTasks(rows));
  }

  /** The table, in the co's own order. A copy: the panel must not mutate it. */
  list(): TaskRow[] {
    return this.rows.map((r) => ({ ...r }));
  }

  get size(): number {
    return this.rows.length;
  }

  /**
   * Replace the WHOLE table. The only write path there is: the co re-renders the
   * table from scratch each time it changes, so a partial update would only ever
   * be a way for the stored table and the co's belief about it to diverge. An
   * empty list clears it.
   *
   * Returns what was actually stored and how many rows were dropped (junk rows,
   * or rows past the cap), so the caller can tell the co rather than let it
   * assume. The in-memory list updates synchronously so the very next paint sees
   * it; the returned promise resolves once the file has been rewritten.
   */
  async replace(rows: unknown): Promise<{ stored: TaskRow[]; dropped: number }> {
    const all = Array.isArray(rows) ? rows : [];
    const stored = coerceTasks(all);
    this.rows = stored;
    await this.persist();
    return { stored: this.list(), dropped: Math.max(0, all.length - stored.length) };
  }

  /**
   * Rewrite the whole file. NEVER REJECTS: the table is a convenience the panel
   * paints, and a write that can't land costs the captain a stale panel, never a
   * turn. The in-memory list is already updated either way.
   */
  private async persist(): Promise<void> {
    if (this.filePath === "") return;
    const snapshot = this.list();
    const file = this.filePath;
    try {
      await serializeWrite(async () => {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
      });
    } catch {
      // A table that didn't make it to disk is not worth failing a turn over.
    }
  }
}
