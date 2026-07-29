import fsp from "node:fs/promises";
import path from "node:path";
import type { InstancePaths } from "../paths.js";
import { serializeWrite } from "../memory/writequeue.js";

/**
 * The captain's at-a-glance task table: a small shared surface with TWO writers.
 *
 * The table itself is not new: the co has always kept a handful of live items —
 * "you are here", aggressively pruned, one word of status each. What changed is
 * who it belongs to. It is the CAPTAIN'S table now (D-20260729-2): he types rows
 * into it from the Ctrl-O Home tab, and the co reads them at cold start as
 * context it would otherwise never see. The co still writes here too, through
 * the `task_table` tool, but sparingly — a row goes in when the captain asks for
 * one or when the item is plainly a major workstream, and never otherwise.
 *
 * Two writers is exactly why the whole-table write is GONE (D-20260729-3). The
 * store used to be rewritten in full on every call, which was safe while the co
 * was the only author and is a data-loss bug the moment it is not: any call the
 * co made would silently delete the row the captain typed a second earlier. The
 * settled rule from the PR message editor holds here too — the captain's edit
 * wins and the co never writes over it — so every operation below names ONE row
 * and can touch nothing else.
 *
 * Rows are addressed by their exact task TEXT, never by index: with two writers
 * an index goes stale between turns, and a stale index does not fail, it hits
 * the wrong row. Text that matches no row, or more than one, is an error rather
 * than a guess — the same posture the doc tool's `str_replace` takes.
 *
 * Retirement is an ACTION and not a third status: `retire` lifts a row out of
 * the table and appends it to the `done` list, timestamped, so finishing
 * something shrinks the table instead of growing a column of `done` rows nobody
 * scans past.
 *
 * The order kept here is INSERTION order, and nothing below reorders it: `add`
 * appends, `rename` rewrites a row's text in place, `retire` leaves the rest
 * where they were, and a status toggle moves no row at all. The order the table
 * is PAINTED in — `building` rows first — is a separate thing entirely and lives
 * in ../taskorder.ts, so that a status toggle can change what the captain sees
 * without rewriting the file underneath him.
 *
 * Like the feature store it is a CACHE of a conversation, not a source of truth
 * about anything: a missing, corrupt or unwritable file is an empty table and
 * must never fail a session start. Writes swallow their own errors and ride the
 * shared memory write queue, so a whole-file rewrite can't interleave with the
 * other tool calls of one model round.
 */

/**
 * The whole status vocabulary: something is being built, or it is waiting its
 * turn. Two words and no more.
 *
 * A free-form status looked harmless and was not. It let the table drift into a
 * tracker — `ready-to-arm`, `scoping`, `recommended`, `backlog` all appeared in
 * real stores — and a column of eight different words is a column you read
 * instead of scan, which is the opposite of what an at-a-glance block is for.
 * The tool's schema now offers only these two, and anything else that reaches
 * the store (an older file, a model that ignored the enum) coerces to `queued`.
 */
export const TASK_STATUSES = ["building", "queued"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** One row of the table: what it is, and whether it is being built or waiting.
 *  There is deliberately no `type` — what kind of work an item is never changed
 *  what the captain did next, and it cost a column. And no body: a task is one
 *  line of text, which is the whole of what the captain asked for. */
export interface TaskRow {
  task: string;
  status: TaskStatus;
}

/** A retired row. Retiring is how a row LEAVES the table, so the text is kept
 *  with the moment it left — nothing the captain or the co put here is ever
 *  silently destroyed, even though no viewer for this list exists yet. */
export interface RetiredTask {
  task: string;
  /** ISO 8601. */
  retiredAt: string;
}

/**
 * How many rows the table keeps. The table is an at-a-glance summary, not a
 * tracker — the prompt asks only for major items, and says the co's default is
 * not to add a row at all — so this is a backstop against a table nobody can
 * scan, not a budget to fill. An `add` over the cap FAILS and says so; it never
 * silently drops the row or evicts someone else's.
 */
export const TASK_TABLE_CAP = 5;

export type TaskErrorCode =
  | "EMPTY_TASK"
  | "TABLE_FULL"
  | "DUPLICATE_TASK"
  | "BAD_STATUS"
  | "NO_MATCH"
  | "MULTIPLE_MATCHES";

/** A refused operation, with a machine-readable code and a sentence saying what
 *  to do next — because one of the two callers is a model choosing its next tool
 *  call, and the other is a panel with one line to print. */
export class TaskError extends Error {
  constructor(
    readonly code: TaskErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskError";
  }
}

/** A trimmed, single-line, non-empty string, or undefined. Newlines are folded
 *  out: a row is one line in a table, and a pasted paragraph would tear the
 *  panel's column layout apart. */
function cell(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat === "" ? undefined : flat;
}

/**
 * The status of a row, narrowed to the two the table has. `building` is the only
 * word that means anything specific; EVERYTHING else — a missing status, a
 * word from the old free-form vocabulary, junk — is `queued`.
 *
 * That is a coercion and not a validation on purpose: a store written under the
 * old shape is read, not rejected, and the panel is never handed a third word it
 * has no column for. The WRITE path is strict (see setStatus); this is the read.
 */
function status(raw: unknown): TaskStatus {
  return cell(raw)?.toLowerCase() === "building" ? "building" : "queued";
}

export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === "string" && (TASK_STATUSES as readonly string[]).includes(v);
}

/** Coerce one row. A row with no task text is dropped entirely — it would render
 *  as a blank line and mean nothing. A `type` field (the old shape) is ignored
 *  rather than carried, so the next write drops it from the file too. */
function coerceRow(raw: unknown): TaskRow | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const task = cell(o.task);
  if (!task) return undefined;
  return { task, status: status(o.status) };
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

/** Coerce the retired list. Uncapped: it is the only record that a row ever
 *  existed, it is never read into the model's context, and a line of it is a few
 *  dozen bytes — so it grows with the project rather than rolling. */
export function coerceRetired(raw: unknown): RetiredTask[] {
  if (!Array.isArray(raw)) return [];
  const out: RetiredTask[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const task = cell(o.task);
    if (!task) continue;
    out.push({ task, retiredAt: cell(o.retiredAt) ?? "" });
  }
  return out;
}

/**
 * The file's shape. It was a bare array of rows before the `done` list existed,
 * and a real instance still has one on disk, so a bare array is read as the
 * table with nothing retired — the same tolerance the row coercion gives the old
 * `type` field.
 */
interface TaskFile {
  tasks: TaskRow[];
  done: RetiredTask[];
}

function coerceFile(raw: unknown): TaskFile {
  if (Array.isArray(raw)) return { tasks: coerceTasks(raw), done: [] };
  if (typeof raw !== "object" || raw === null) return { tasks: [], done: [] };
  const o = raw as Record<string, unknown>;
  return { tasks: coerceTasks(o.tasks), done: coerceRetired(o.done) };
}

export class TaskStore {
  private rows: TaskRow[];
  private retired: RetiredTask[];

  private constructor(
    private readonly filePath: string,
    file: TaskFile,
  ) {
    this.rows = file.tasks;
    this.retired = file.done;
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
      return new TaskStore(file, coerceFile(JSON.parse(raw)));
    } catch {
      return new TaskStore(file, { tasks: [], done: [] });
    }
  }

  /** In-memory table with no file behind it, for tests and degraded paths. */
  static ephemeral(rows: unknown = [], done: unknown = []): TaskStore {
    return new TaskStore("", { tasks: coerceTasks(rows), done: coerceRetired(done) });
  }

  /** The table, in order. A copy: no caller may mutate it in place. */
  list(): TaskRow[] {
    return this.rows.map((r) => ({ ...r }));
  }

  /** Everything retired out of the table, oldest first. */
  done(): RetiredTask[] {
    return this.retired.map((r) => ({ ...r }));
  }

  get size(): number {
    return this.rows.length;
  }

  /**
   * Append one row, always as `queued`. A new task has not been started — that
   * is the captain's own spec — so `add` takes no status and `status` is the
   * separate step that says work has begun.
   *
   * Refuses rather than absorbs: no text, text already on the table (which would
   * make BOTH rows unaddressable), or a full table. A full table is not silently
   * truncated and nothing is evicted to make room — evicting would be this
   * store deleting a row nobody named, which is the whole thing it exists to
   * prevent.
   */
  async add(task: unknown): Promise<TaskRow> {
    const text = cell(task);
    if (!text) {
      throw new TaskError("EMPTY_TASK", "A task needs some text: one short line saying what it is.");
    }
    if (this.rows.some((r) => r.task === text)) {
      throw new TaskError(
        "DUPLICATE_TASK",
        `The table already holds "${text}". Rows are addressed by their exact text, so it cannot hold two.`,
      );
    }
    if (this.rows.length >= TASK_TABLE_CAP) {
      throw new TaskError(
        "TABLE_FULL",
        `The table already holds its maximum of ${TASK_TABLE_CAP} rows. Retire something first: ${this.quoted()}.`,
      );
    }
    const row: TaskRow = { task: text, status: "queued" };
    this.rows.push(row);
    await this.persist();
    return { ...row };
  }

  /**
   * Move one row between the two statuses. Strict, unlike the read path: a third
   * word is refused rather than coerced, because a write that quietly became
   * `queued` is a write the caller believes landed.
   */
  async setStatus(task: unknown, next: unknown): Promise<TaskRow> {
    if (!isTaskStatus(next)) {
      throw new TaskError(
        "BAD_STATUS",
        `Status must be one of: ${TASK_STATUSES.join(", ")}. There is no third value.`,
      );
    }
    const row = this.rows[this.indexOf(task)]!;
    row.status = next;
    await this.persist();
    return { ...row };
  }

  /**
   * Rewrite one row's TEXT, keeping its status and its place in the table.
   *
   * A row's text used to be immutable, so a typo or a reworded task meant
   * retiring the row and adding it again — which lost both the things the row
   * carried besides its words: it came back `queued` however far along it was,
   * and it came back at the bottom. Neither is what "fix the wording" means, so
   * this is one operation and the row never leaves the table.
   *
   * Refuses on the same grounds every other operation does, plus one of its own:
   * the new text may not collide with a DIFFERENT row, because two rows reading
   * the same would make both unaddressable (the rule `add` already enforces).
   * Renaming a row to the text it already has is deliberately NOT a collision —
   * it is a successful no-op, which is what the panel does when the captain
   * opens the field and changes nothing.
   */
  async rename(task: unknown, next: unknown): Promise<TaskRow> {
    // The row is addressed FIRST: "which row" is a harder question than "is the
    // new text usable", and an ambiguous address must fail as an address rather
    // than as whatever the second check happens to notice.
    const index = this.indexOf(task);
    const text = cell(next);
    if (!text) {
      throw new TaskError(
        "EMPTY_TASK",
        "A renamed row still needs some text: one short line saying what it is.",
      );
    }
    if (this.rows.some((r, i) => i !== index && r.task === text)) {
      throw new TaskError(
        "DUPLICATE_TASK",
        `Another row already reads "${text}". Rows are addressed by their exact text, so the table cannot hold two.`,
      );
    }
    const row = this.rows[index]!;
    row.task = text;
    await this.persist();
    return { ...row };
  }

  /**
   * Retire one row: it leaves the table and is appended to the `done` list with
   * the moment it left. Done is an action, not a status — the table is what we
   * are doing, and a finished item is not that.
   *
   * `at` is injectable so a test can pin the timestamp; the default is now.
   */
  async retire(task: unknown, at: string = new Date().toISOString()): Promise<RetiredTask> {
    const index = this.indexOf(task);
    const [row] = this.rows.splice(index, 1);
    const record: RetiredTask = { task: row!.task, retiredAt: at };
    this.retired.push(record);
    await this.persist();
    return { ...record };
  }

  /**
   * The index of the row whose text is exactly `query`, or a TaskError.
   *
   * Whitespace is folded first, so text copied back out of the table matches
   * however it was re-typed, but nothing else is guessed: no prefix match, no
   * case folding, no "closest row". Two writers means the caller's idea of the
   * table can be a turn out of date, and acting on the nearest-looking row is
   * how the wrong row gets retired.
   */
  private indexOf(query: unknown): number {
    const want = cell(query);
    if (!want) {
      throw new TaskError("EMPTY_TASK", "Name the row by its exact task text.");
    }
    const hits: number[] = [];
    this.rows.forEach((r, i) => {
      if (r.task === want) hits.push(i);
    });
    if (hits.length === 0) {
      throw new TaskError(
        "NO_MATCH",
        `No row reads "${want}". The table holds: ${this.quoted()}. Address a row by its exact text.`,
      );
    }
    if (hits.length > 1) {
      throw new TaskError(
        "MULTIPLE_MATCHES",
        `"${want}" matches ${hits.length} rows, so there is no way to tell which you meant.`,
      );
    }
    return hits[0]!;
  }

  /** The table's texts, for an error that has to say what IS there. */
  private quoted(): string {
    return this.rows.length === 0 ? "(nothing)" : this.rows.map((r) => `"${r.task}"`).join(", ");
  }

  /**
   * Rewrite the whole file. NEVER REJECTS: the table is a convenience the panel
   * paints, and a write that can't land costs the captain a stale panel, never a
   * turn. The in-memory list is already updated either way.
   */
  private async persist(): Promise<void> {
    if (this.filePath === "") return;
    const snapshot: TaskFile = { tasks: this.list(), done: this.done() };
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
