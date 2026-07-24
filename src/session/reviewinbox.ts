import fsp from "node:fs/promises";
import path from "node:path";
import type { InstancePaths } from "../paths.js";
import { serializeWrite } from "../memory/writequeue.js";
import { c } from "../ui.js";

/**
 * The review inbox: the structured, durable record of every crew-completion
 * review, plus the rule that decides how loudly one lands in the chat.
 *
 * Before this, a review was only the co talking: the completion drain injected a
 * prompt, the co spoke a review into the transcript, and that was the whole
 * artifact. Two things were wrong with that. Nothing survived the session (a
 * verdict from yesterday's run was gone unless the captain had scrolled it), and
 * every review shouted at the same volume — a clean accept on a one-line chore
 * interrupted exactly as loudly as a rework that needs a decision.
 *
 * So a review is now a RECORD the co files with the `file_review` tool, and the
 * record carries a LEVEL that gates the chat:
 *
 *   L1 — rework, or a genuine escalation/fork only the captain can resolve.
 *        Filed silently by this layer; the co then states the core decision
 *        itself in its normal reply. The full body is NOT dumped into chat.
 *   L2 — fix-commit, or an accept with notes worth having. Filed, plus exactly
 *        one dim pointer line so the captain knows it exists.
 *   L3 — a clean accept with nothing to flag. Filed, and chat says nothing.
 *
 * The store is a capped rolling list (newest first, INBOX_CAP entries) persisted
 * as JSON under the instance's .dispatch/ dir — the same tier the dispatch config
 * and per-job captures live in, since a review is the tail end of a dispatch. It
 * is never written into the user's repo. Writes ride the shared memory write
 * queue (memory/writequeue.ts) so a whole-file rewrite here can't interleave with
 * the concurrent tool calls of one model round.
 */

export const REVIEW_VERDICTS = ["accept", "fix-commit", "rework"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const REVIEW_LEVELS = ["L1", "L2", "L3"] as const;
export type ReviewLevel = (typeof REVIEW_LEVELS)[number];

/** One filed review. `body` is the full review text and is never printed to chat. */
export interface ReviewRecord {
  /** The dispatch job reviewed, or "manual" for a run the captain relayed by hand. */
  jobId: string;
  /** The feature the job was scoped to, when it had one. */
  feature?: string;
  /** ISO 8601, supplied by the caller so the store stays deterministic in tests. */
  timestamp: string;
  verdict: ReviewVerdict;
  level: ReviewLevel;
  /** One line, the inbox list row. */
  headline: string;
  /** The full review (what went right / wrong / escalations / verdict). */
  body: string;
}

/** How many reviews the rolling inbox keeps (D-20260724-8). Old ones age out. */
export const INBOX_CAP = 20;

export function isReviewVerdict(v: unknown): v is ReviewVerdict {
  return typeof v === "string" && (REVIEW_VERDICTS as readonly string[]).includes(v);
}

export function isReviewLevel(v: unknown): v is ReviewLevel {
  return typeof v === "string" && (REVIEW_LEVELS as readonly string[]).includes(v);
}

/**
 * The verdict → level mapping the co is asked to follow, as code. The co supplies
 * the level itself when it files (it is the only thing that knows whether an
 * accept carried notes, or whether a fix-commit hides a real fork), so this is
 * the reference and the fallback, not a gate on the tool.
 *
 * `escalation` means something only the captain can resolve — it promotes any
 * verdict to L1. `notes` means an accept that still has something worth reading.
 */
export function levelFor(
  verdict: ReviewVerdict,
  opts: { escalation?: boolean; notes?: boolean } = {},
): ReviewLevel {
  if (opts.escalation) return "L1";
  if (verdict === "rework") return "L1";
  if (verdict === "fix-commit") return "L2";
  return opts.notes ? "L2" : "L3";
}

/**
 * Prepend a record to the rolling list and cap it. Pure, so the ordering and the
 * cap are provable without touching a disk. Newest first: the inbox is read from
 * the top, and the panel lists it in exactly this order.
 */
export function appendReview(
  list: readonly ReviewRecord[],
  record: ReviewRecord,
  cap = INBOX_CAP,
): ReviewRecord[] {
  return [record, ...list].slice(0, Math.max(0, cap));
}

/**
 * The chat gating, as one pure decision: the line a filed review puts in the
 * transcript, or null for silence.
 *
 * L2 is the only level with a line, and it is exactly one, dimmed, and a pointer
 * rather than a summary — it says the review exists and where to read it, never
 * the body. L3 is silent by design. L1 is silent HERE too: its noise is the co's
 * own next sentence (the core decision the captain must make), not a grey line,
 * and the full body stays in the inbox rather than being dumped into the chat.
 */
export function reviewChatLine(record: ReviewRecord): string | null {
  if (record.level !== "L2") return null;
  return c.dim(`review filed (L2): ${record.headline} — Ctrl-O > Inbox`);
}

/**
 * What the co is told to do in chat after a filing, returned as the tool result.
 * The level's whole point is behavioural, so the tool says the behaviour out loud
 * rather than trusting the protocol text alone to be remembered mid-turn.
 */
export function filedNote(level: ReviewLevel): string {
  switch (level) {
    case "L1":
      return (
        "Filed. Nothing was printed to the chat. Now state ONLY the core decision the captain has to" +
        " make, in a line or two. Do not restate the review body — it is in the inbox."
      );
    case "L2":
      return (
        "Filed. One dim pointer line was printed to the chat (headline + Ctrl-O > Inbox). Say nothing" +
        " further about this review."
      );
    case "L3":
      return "Filed silently. Nothing was printed and nothing more should be said about this review.";
  }
}

/** What the model supplies when filing a review. jobId/feature are optional: the
 *  caller fills them from the run currently under review when omitted. */
export interface FileReviewInput {
  level: ReviewLevel;
  verdict: ReviewVerdict;
  headline: string;
  body: string;
  jobId?: string;
  feature?: string;
}

/** What the model is handed back: the filing, and what it may still say. */
export interface FileReviewResult {
  filed: true;
  level: ReviewLevel;
  verdict: ReviewVerdict;
  jobId: string;
  /** How many reviews the inbox now holds (capped). */
  inboxCount: number;
  /** What to do in the chat now that it's filed. */
  next: string;
}

/**
 * The whole filing: build the record, persist it, then emit exactly what the
 * level allows. This is the delivery gate, kept here rather than in the REPL so
 * the behaviour that the whole feature is FOR — a clean run costs the captain
 * nothing, a mixed one costs a line, only a real decision interrupts — is provable
 * without a session, a model, or a terminal.
 *
 * `job` is the run currently under review, used to default the record's jobId and
 * feature so the co doesn't have to thread them through; a filing outside a review
 * turn records "manual". `now` is injected for the same reason the store takes a
 * timestamp: tests should not depend on the clock.
 */
export async function fileReviewInto(opts: {
  inbox: ReviewInbox;
  input: FileReviewInput;
  job?: { id: string; feature?: string } | null;
  now: string;
  /** Where a gated chat line goes. Called at most once, and only for L2. */
  emit: (line: string) => void;
}): Promise<{ record: ReviewRecord; result: FileReviewResult }> {
  const { inbox, input, job, now, emit } = opts;
  const feature = input.feature ?? job?.feature;
  const record: ReviewRecord = {
    jobId: input.jobId ?? job?.id ?? "manual",
    ...(feature ? { feature } : {}),
    timestamp: now,
    verdict: input.verdict,
    level: input.level,
    headline: input.headline,
    body: input.body,
  };
  const records = await inbox.file(record);
  const line = reviewChatLine(record);
  if (line) emit(line);
  return {
    record,
    result: {
      filed: true,
      level: record.level,
      verdict: record.verdict,
      jobId: record.jobId,
      inboxCount: records.length,
      next: filedNote(record.level),
    },
  };
}

/** Drop anything that isn't a well-formed record: a hand-edited or partially
 *  written file must not poison the panel or the next write. */
function coerce(raw: unknown): ReviewRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewRecord[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (!isReviewVerdict(r.verdict) || !isReviewLevel(r.level)) continue;
    if (typeof r.headline !== "string" || r.headline === "") continue;
    out.push({
      jobId: typeof r.jobId === "string" ? r.jobId : "manual",
      ...(typeof r.feature === "string" && r.feature ? { feature: r.feature } : {}),
      timestamp: typeof r.timestamp === "string" ? r.timestamp : "",
      verdict: r.verdict,
      level: r.level,
      headline: r.headline,
      body: typeof r.body === "string" ? r.body : "",
    });
  }
  return out.slice(0, INBOX_CAP);
}

/**
 * The instance's rolling review inbox. Loaded once at session start (so the panel
 * has the previous sessions' reviews the moment it opens) and held in memory
 * thereafter; every filing rewrites the whole capped file, which is 20 short
 * records and cheaper than any merge scheme would be.
 */
export class ReviewInbox {
  private records: ReviewRecord[];

  private constructor(
    private readonly filePath: string,
    records: ReviewRecord[],
  ) {
    this.records = records;
  }

  /**
   * Read the inbox from disk. A missing file is an empty inbox (the common first
   * run); a corrupt or unreadable one is ALSO an empty inbox rather than a failed
   * session start — a broken cache of reviews must never stop the co opening.
   */
  static async load(paths: InstancePaths): Promise<ReviewInbox> {
    const file = paths.reviewInbox;
    try {
      const raw = await fsp.readFile(file, "utf8");
      return new ReviewInbox(file, coerce(JSON.parse(raw)));
    } catch {
      return new ReviewInbox(file, []);
    }
  }

  /** In-memory store with no file behind it, for tests and degraded paths. */
  static ephemeral(records: ReviewRecord[] = []): ReviewInbox {
    return new ReviewInbox("", records);
  }

  /** The stored reviews, newest first. A copy: the panel must not mutate them. */
  list(): ReviewRecord[] {
    return [...this.records];
  }

  get size(): number {
    return this.records.length;
  }

  /**
   * File a review: prepend, cap, persist. Returns the new list (newest first).
   * The in-memory list is updated synchronously so a concurrent read sees the
   * filing immediately; the write itself rides the shared serialized lane.
   */
  async file(record: ReviewRecord): Promise<ReviewRecord[]> {
    this.records = appendReview(this.records, record);
    const snapshot = this.records;
    if (this.filePath !== "") {
      await serializeWrite(async () => {
        await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
        await fsp.writeFile(this.filePath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
      });
    }
    return snapshot;
  }
}
