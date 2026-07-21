import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  instancePaths,
  instancesDir,
  logFileName,
  LIVE_FILES,
  LOG_NAMES,
  isValidInstanceName,
  type InstancePaths,
  type LiveFile,
  type LogName,
} from "../paths.js";
import {
  projectbriefTemplate,
  activeContextTemplate,
  logHeader,
} from "./templates.js";

const LOG_TITLES: Record<LogName, string> = {
  decisions: "Decisions",
  progress: "Progress",
  research: "Research",
};

function nowISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowStamp(): string {
  // e.g. 2026-07-16 14:03 UTC
  return new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

/** Write a file only if it does not already exist. Returns true if written. */
async function writeIfMissing(file: string, content: string): Promise<boolean> {
  try {
    await fsp.access(file);
    return false;
  } catch {
    await ensureDir(path.dirname(file));
    await fsp.writeFile(file, content, "utf8");
    return true;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move src to dest without ever overwriting or losing data:
 *  - src missing          -> nothing to do (already migrated)
 *  - dest already present -> leave src in place and report a conflict
 *  - otherwise            -> rename (atomic within the instance's filesystem)
 */
async function moveNoClobber(src: string, dest: string): Promise<"moved" | "absent" | "conflict"> {
  if (!(await pathExists(src))) return "absent";
  if (await pathExists(dest)) return "conflict";
  await ensureDir(path.dirname(dest));
  await fsp.rename(src, dest);
  return "moved";
}

/**
 * Recursively merge srcDir into destDir: move each file with moveNoClobber and
 * recurse into subdirectories, draining empty source dirs as we go. Files that
 * would clobber an existing destination are left in place and counted. Absent
 * srcDir is a no-op.
 */
async function mergeDir(
  srcDir: string,
  destDir: string,
  acc: { moved: number; conflicts: number },
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(srcDir, { withFileTypes: true });
  } catch {
    return; // srcDir absent
  }
  await ensureDir(destDir);
  for (const e of entries) {
    const s = path.join(srcDir, e.name);
    const d = path.join(destDir, e.name);
    if (e.isDirectory()) {
      await mergeDir(s, d, acc);
    } else {
      const r = await moveNoClobber(s, d);
      if (r === "moved") acc.moved++;
      else if (r === "conflict") acc.conflicts++;
    }
  }
  // Drop the source dir if it drained empty (a conflict may leave it behind).
  try {
    await fsp.rmdir(srcDir);
  } catch {
    // not empty or already gone
  }
}

/**
 * One parsed entry from an append-only log. `raw` is the body verbatim; `time`
 * is the header stamp as epoch ms (NaN when unparseable) so entries from two
 * files can be interleaved chronologically.
 */
interface LogEntry {
  id?: string;
  stamp: string;
  body: string;
  time: number;
}

/** Parse "2026-07-18 05:25 UTC" (see nowStamp) to epoch ms; NaN if malformed. */
function parseStamp(stamp: string): number {
  const m = stamp.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC$/);
  return m ? Date.parse(`${m[1]}T${m[2]}:00Z`) : Number.NaN;
}

/**
 * Split a log into its header block and its entries. Entry headers are
 * "## <stamp>" or, for decisions, "## D-YYYYMMDD-N — <stamp>". Anything before
 * the first entry is the header (a log written by appendLog onto a missing file
 * has none, which is fine — the caller supplies a fresh one).
 */
function splitLog(content: string): { header: string; entries: LogEntry[] } {
  const headerRe = /^## (?:(D-\d{8}-\d+) — )?(.+)$/;
  const lines = content.split("\n");
  const headerLines: string[] = [];
  const entries: LogEntry[] = [];
  let cur: { id?: string; stamp: string; body: string[] } | null = null;

  const flush = (): void => {
    if (!cur) return;
    entries.push({
      ...(cur.id ? { id: cur.id } : {}),
      stamp: cur.stamp,
      body: cur.body.join("\n").trim(),
      time: parseStamp(cur.stamp),
    });
    cur = null;
  };

  for (const line of lines) {
    const m = line.match(headerRe);
    if (m) {
      flush();
      cur = { ...(m[1] ? { id: m[1] } : {}), stamp: m[2] ?? "", body: [] };
    } else if (cur) {
      cur.body.push(line);
    } else {
      headerLines.push(line);
    }
  }
  flush();
  return { header: headerLines.join("\n").trim(), entries };
}

/**
 * Render entries back to the on-disk format. The trailing "\n\n" after the
 * header matches what a naturally-grown log looks like (createInstance writes
 * `logHeader() + "\n"`, then each appendLog block opens with its own "\n"), so a
 * merged file is byte-identical to one that was only ever appended to.
 */
function renderLog(header: string, entries: LogEntry[]): string {
  const blocks = entries.map((e) => {
    const head = e.id ? `## ${e.id} — ${e.stamp}` : `## ${e.stamp}`;
    return `\n${head}\n\n${e.body}\n`;
  });
  return header.trim() + "\n\n" + blocks.join("");
}

export interface LogMergeResult {
  /** Entries folded in from the source file. */
  merged: number;
  /** Source decision ids that collided and were re-minted: "old → new". */
  renumbered: string[];
}

/**
 * Fold `srcFile` into `destFile` and delete the source.
 *
 * Append-only logs are streams of timestamped entries, so two copies can always
 * be combined without judgment — which is why this exists rather than a
 * conflict. The alternative (leave the source where it is) is not the safe
 * option it looks like: nothing reads the old path after migration, so a
 * "preserved" file is a lost decision.
 *
 * Rules:
 *  - Entries are interleaved by timestamp, honoring the logs' own "newest at the
 *    bottom" invariant. Unparseable stamps sort last, keeping their order.
 *  - Destination decision ids are NEVER touched: activeContext.md cites them by
 *    id, and renumbering them would break live references. Only a COLLIDING
 *    source id is re-minted, to the next free number for its day. A re-minted id
 *    can therefore sort earlier than a higher id, which is fine — ids identify,
 *    they don't order.
 */
export async function mergeLogInto(
  srcFile: string,
  destFile: string,
  title: string,
): Promise<LogMergeResult> {
  const read = async (f: string): Promise<string> => {
    try {
      return await fsp.readFile(f, "utf8");
    } catch {
      return "";
    }
  };
  const src = splitLog(await read(srcFile));
  const dest = splitLog(await read(destFile));

  // Highest id already used per day, so re-mints never collide with each other.
  const taken = new Set<string>();
  const maxPerDay = new Map<string, number>();
  for (const e of dest.entries) {
    if (!e.id) continue;
    taken.add(e.id);
    const m = e.id.match(/^D-(\d{8})-(\d+)$/);
    if (!m) continue;
    const day = m[1]!;
    const n = Number.parseInt(m[2]!, 10);
    maxPerDay.set(day, Math.max(maxPerDay.get(day) ?? 0, n));
  }

  const renumbered: string[] = [];
  const incoming = src.entries.map((e) => {
    if (!e.id || !taken.has(e.id)) {
      if (e.id) taken.add(e.id);
      return e;
    }
    const day = e.id.match(/^D-(\d{8})-\d+$/)?.[1] ?? nowISODate().replace(/-/g, "");
    const next = (maxPerDay.get(day) ?? 0) + 1;
    maxPerDay.set(day, next);
    const fresh = `D-${day}-${next}`;
    taken.add(fresh);
    renumbered.push(`${e.id} → ${fresh}`);
    return { ...e, id: fresh };
  });

  // Stable sort by time; NaN stamps sink to the bottom in their original order.
  const all = [...dest.entries, ...incoming];
  const order = new Map(all.map((e, i) => [e, i]));
  all.sort((a, b) => {
    const at = Number.isNaN(a.time) ? Infinity : a.time;
    const bt = Number.isNaN(b.time) ? Infinity : b.time;
    return at === bt ? order.get(a)! - order.get(b)! : at - bt;
  });

  const header = dest.header || src.header || logHeader(title).trim();
  await ensureDir(path.dirname(destFile));
  await fsp.writeFile(destFile, renderLog(header, all), "utf8");
  await fsp.rm(srcFile, { force: true });
  return { merged: incoming.length, renumbered };
}

/**
 * Set a conflicting full-rewrite file aside IN THE NEW LAYOUT rather than
 * leaving it at the old path. Snapshot files (activeContext, projectbrief,
 * architecture) can't be auto-merged — picking a winner needs judgment, and
 * mtime is not that judgment: a stale session can rewrite a file after a better
 * version was written elsewhere, making the accurate copy the older one. So we
 * don't guess. We just make sure the loser lands somewhere the user will
 * actually see it.
 */
async function parkConflict(srcFile: string, destFile: string): Promise<string> {
  const dir = path.dirname(destFile);
  const ext = path.extname(destFile);
  const base = path.basename(destFile, ext);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const parked = path.join(dir, `${base}.conflict-${stamp}${ext}`);
  await ensureDir(dir);
  await fsp.rename(srcFile, parked);
  return parked;
}

export function instanceExists(home: string, name: string): boolean {
  return fs.existsSync(instancePaths(home, name).root);
}

export interface InstanceStats {
  files: number;
  decisions: number;
}

/**
 * Cheap summary of what a delete would destroy, for the confirmation prompt:
 * total files under the instance and the count of recorded decisions, the
 * thing users most regret losing.
 */
export async function instanceStats(home: string, name: string): Promise<InstanceStats> {
  const p = instancePaths(home, name);
  let files = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else files++;
    }
  };
  walk(p.root);

  const count = (file: string, re: RegExp): number => {
    try {
      return (fs.readFileSync(file, "utf8").match(re) ?? []).length;
    } catch {
      return 0;
    }
  };
  const decisions = count(p.logFile("decisions"), /^## D-\d{8}-\d+ /gm);

  return { files, decisions };
}

/**
 * Permanently delete an instance's directory tree. Guards against deleting
 * something that is not actually an instance directory under <home>/instances:
 * the resolved path must sit directly inside instancesDir and must exist.
 * Returns the deleted root path, or null if there was nothing to delete.
 */
export async function deleteInstance(home: string, name: string): Promise<string | null> {
  if (!isValidInstanceName(name)) {
    throw new Error(`Invalid instance name "${name}".`);
  }
  const root = instancePaths(home, name).root;
  const parent = path.resolve(instancesDir(home));
  const resolved = path.resolve(root);
  // Safety: the target must be a direct child of the instances dir. This blocks
  // any name that escaped validation and tried to traverse (e.g. "..").
  if (path.dirname(resolved) !== parent) {
    throw new Error(`Refusing to delete "${resolved}": not an instance directory.`);
  }
  if (!fs.existsSync(resolved)) return null;
  await fsp.rm(resolved, { recursive: true, force: true });
  return resolved;
}

export function listInstances(home: string): string[] {
  const dir = instancesDir(home);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Create a fresh instance from templates. Idempotent (fills gaps only). */
export async function createInstance(home: string, name: string): Promise<InstancePaths> {
  if (!isValidInstanceName(name)) {
    throw new Error(
      `Invalid instance name "${name}". Use letters, digits, dot, dash, underscore (max 64 chars).`,
    );
  }
  const p = instancePaths(home, name);
  for (const dir of [p.docs, p.memory, p.sessions]) {
    await ensureDir(dir);
  }
  for (const log of LOG_NAMES) {
    await ensureDir(p.archiveDir(log));
  }

  const date = nowISODate();
  // Substrate orientation files are seeded so the co has a scaffold to fill.
  await writeIfMissing(p.liveFile("projectbrief.md"), projectbriefTemplate(name, date));
  await writeIfMissing(p.liveFile("activeContext.md"), activeContextTemplate(name, date));
  // User-facing docs (architecture.md, plan.md, ...) are NOT seeded here — they
  // are authored when their workflow begins, so docs/ starts empty.

  for (const log of LOG_NAMES) {
    await writeIfMissing(p.logFile(log), logHeader(LOG_TITLES[log]) + "\n");
  }

  return p;
}

export interface LayoutMigration {
  /** True if the instance had any pre-reorg dirs to act on. */
  migrated: boolean;
  /** Files relocated to their new tier. */
  moved: number;
  /** Log entries folded into an existing log at the destination. */
  mergedEntries: number;
  /** Decision ids re-minted during a log merge, as "old → new". */
  renumbered: string[];
  /** Snapshot files set aside as <name>.conflict-<stamp>.md, by new path. */
  parked: string[];
  /** Files left in place because a destination already existed. */
  conflicts: number;
}

/**
 * Bring a pre-reorg instance onto the two-tier layout in place, moving files to
 * their new homes without touching contents:
 *
 *   live/projectbrief.md, live/activeContext.md -> .memory/
 *   live/architecture.md                        -> docs/   (a user document)
 *   logs/{decisions,progress,research}.md        -> .memory/
 *   archive/                                     -> .memory/archive/
 *   sessions/                                    -> .memory/sessions/
 *
 * Idempotent and conflict-safe: files are only ever renamed into an empty slot,
 * never overwritten, so running this twice — or on an already-migrated instance
 * — is a no-op. Returns what it did so the caller can report it. Best used at
 * instance open, before anything reads or writes memory.
 */
export async function migrateInstanceLayout(p: InstancePaths): Promise<LayoutMigration> {
  const oldLive = path.join(p.root, "live");
  const oldLogs = path.join(p.root, "logs");
  const oldArchive = path.join(p.root, "archive");
  const oldSessions = path.join(p.root, "sessions");

  const hasOld =
    (await pathExists(oldLive)) ||
    (await pathExists(oldLogs)) ||
    (await pathExists(oldArchive)) ||
    (await pathExists(oldSessions));
  if (!hasOld) {
    return { migrated: false, moved: 0, mergedEntries: 0, renumbered: [], parked: [], conflicts: 0 };
  }

  const acc = { moved: 0, conflicts: 0 };
  const tally = (r: "moved" | "absent" | "conflict"): void => {
    if (r === "moved") acc.moved++;
    else if (r === "conflict") acc.conflicts++;
  };
  let mergedEntries = 0;
  const renumbered: string[] = [];
  const parked: string[] = [];

  await ensureDir(p.memory);
  await ensureDir(p.docs);

  // Snapshot files out of the old live/ dir, each to its new tier: the
  // orientation files to .memory/, architecture.md to docs/ (it is a user
  // document now, authored through the doc tool). A conflict can't be
  // auto-merged for a full-rewrite file, so the loser is parked beside the
  // winner instead of being abandoned at the old path.
  const snapshots: { name: string; dest: string }[] = [
    ...LIVE_FILES.map((f) => ({ name: f as string, dest: p.liveFile(f) })),
    { name: "architecture.md", dest: p.docFile("architecture.md") },
  ];
  for (const { name, dest } of snapshots) {
    const src = path.join(oldLive, name);
    const r = await moveNoClobber(src, dest);
    if (r === "conflict") parked.push(await parkConflict(src, dest));
    else tally(r);
  }
  // Append-only logs are all substrate now. Unlike the snapshots above, two
  // copies of a log ALWAYS combine cleanly, so a conflict here is a merge.
  for (const n of LOG_NAMES) {
    const src = path.join(oldLogs, logFileName(n));
    const dest = p.logFile(n);
    const r = await moveNoClobber(src, dest);
    if (r === "conflict") {
      const m = await mergeLogInto(src, dest, LOG_TITLES[n]);
      mergedEntries += m.merged;
      renumbered.push(...m.renumbered);
    } else {
      tally(r);
    }
  }
  // Cold archive and transcripts move under .memory/ wholesale.
  await mergeDir(oldArchive, p.archive, acc);
  await mergeDir(oldSessions, p.sessions, acc);

  // Remove the drained old dirs (a leftover conflict keeps one around, which is
  // the safe outcome — nothing is deleted while data still sits in it).
  for (const d of [oldLive, oldLogs, oldArchive, oldSessions]) {
    try {
      await fsp.rmdir(d);
    } catch {
      // not empty or already gone
    }
  }

  return {
    migrated: true,
    moved: acc.moved,
    mergedEntries,
    renumbered,
    parked,
    conflicts: acc.conflicts,
  };
}

/** Read the substrate orientation files. Missing files come back as empty strings. */
export async function readLiveMemory(
  p: InstancePaths,
): Promise<Record<LiveFile, string>> {
  const out = {} as Record<LiveFile, string>;
  for (const f of LIVE_FILES) {
    try {
      out[f] = await fsp.readFile(p.liveFile(f), "utf8");
    } catch {
      out[f] = "";
    }
  }
  return out;
}

export interface AppendResult {
  file: string;
  id?: string;
}

/**
 * Append a timestamped entry to a log. For decisions we mint a stable ID of
 * the form D-YYYYMMDD-N (N = count of existing decisions that day + 1).
 */
export async function appendLog(
  p: InstancePaths,
  log: LogName,
  entry: string,
): Promise<AppendResult> {
  const file = p.logFile(log);
  await ensureDir(path.dirname(file));

  let id: string | undefined;
  let header: string;
  if (log === "decisions") {
    id = await mintDecisionId(file);
    header = `\n## ${id} — ${nowStamp()}\n\n`;
  } else {
    header = `\n## ${nowStamp()}\n\n`;
  }

  const block = `${header}${entry.trim()}\n`;
  await fsp.appendFile(file, block, "utf8");
  return { file, id };
}

async function mintDecisionId(file: string): Promise<string> {
  const day = nowISODate().replace(/-/g, "");
  let content = "";
  try {
    content = await fsp.readFile(file, "utf8");
  } catch {
    // no file yet
  }
  const re = new RegExp(`D-${day}-(\\d+)`, "g");
  let max = 0;
  for (const m of content.matchAll(re)) {
    const n = Number.parseInt(m[1] ?? "0", 10);
    if (n > max) max = n;
  }
  return `D-${day}-${max + 1}`;
}

/** Rewrite a live-state file in place. */
export async function rewriteLive(p: InstancePaths, file: LiveFile, content: string): Promise<void> {
  const dest = p.liveFile(file);
  await ensureDir(path.dirname(dest));
  const trimmed = content.endsWith("\n") ? content : content + "\n";
  await fsp.writeFile(dest, trimmed, "utf8");
}

/**
 * A handle to the current session's transcript file. Transcripts are the
 * durable, human-readable record of a conversation — written turn by turn so a
 * crash, kill, or power loss never costs you the discussion. They live under
 * sessions/ and are deliberately NOT read back into context at cold start: the
 * flat-cold-start design orients from live state only. This is the record, not
 * the working memory.
 */
export interface TranscriptHandle {
  file: string;
}

/**
 * Open (create if missing) a transcript file for a fresh session. The id is
 * timestamp + pid so concurrent sessions on the same instance never collide.
 * Best-effort: a failure here must not stop a session from starting.
 */
export async function startTranscript(
  p: InstancePaths,
  opts: { model?: string } = {},
): Promise<TranscriptHandle> {
  const id = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${process.pid}`;
  const file = path.join(p.sessions, `${id}.md`);
  const header =
    `# Session — ${p.name}\n\n` +
    `_Started ${nowStamp()}${opts.model ? ` · ${opts.model}` : ""}. ` +
    `Verbatim transcript, appended as we talk. docs/ and .memory/ hold the ` +
    `curated memory; this is the raw record._\n`;
  try {
    await ensureDir(p.sessions);
    await writeIfMissing(file, header);
  } catch {
    // Best-effort: keep the session alive even if the transcript can't be made.
  }
  return { file };
}

/**
 * Append one turn to the session transcript. `role` is who spoke. Best-effort
 * and never throws into the caller — losing a transcript line must never break
 * the live session. Empty text is skipped so pure tool-call turns add no noise.
 */
export async function appendTranscript(
  h: TranscriptHandle,
  role: "you" | "co" | "note",
  text: string,
): Promise<void> {
  const clean = text.trim();
  if (!clean) return;
  const label = role === "you" ? "you" : role === "co" ? "co" : "·";
  const block = `\n## ${label} · ${nowStamp()}\n\n${clean}\n`;
  try {
    await fsp.appendFile(h.file, block, "utf8");
  } catch {
    // best-effort
  }
}

/**
 * Character budget for the verbatim recent-conversation tail injected at cold
 * start. Roughly 2k tokens at a conservative ~4 chars/token. This is the
 * continuity FLOOR: the transcript is written every turn regardless of model
 * behavior, so even if end-of-session distillation fails, the recent thread
 * still survives a restart. Kept small on purpose so cold-start cost stays flat
 * no matter how much history has accumulated.
 */
export const TRANSCRIPT_TAIL_MAX_CHARS = 8000;

export interface TranscriptTurn {
  role: "you" | "co" | "note";
  stamp: string;
  text: string;
}

/**
 * Find the most recent transcript file for an instance, by modified time.
 * `excludeFile` skips the current session's own file so cold start reads the
 * PRIOR session, not the empty one just opened. Returns null if none exists
 * (a fresh instance) or the sessions dir can't be read.
 *
 * Concurrent sessions are rare for a personal tool; "most recent by mtime" is a
 * deliberately simple, good-enough tiebreak rather than tracking session lineage.
 */
export async function latestTranscriptFile(
  p: InstancePaths,
  excludeFile?: string,
): Promise<string | null> {
  let names: string[];
  try {
    names = (await fsp.readdir(p.sessions)).filter((f) => f.endsWith(".md"));
  } catch {
    return null;
  }
  let best: { file: string; mtime: number } | null = null;
  for (const name of names) {
    const full = path.join(p.sessions, name);
    if (excludeFile && path.resolve(full) === path.resolve(excludeFile)) continue;
    let mtime: number;
    try {
      mtime = (await fsp.stat(full)).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtime > best.mtime) best = { file: full, mtime };
  }
  return best?.file ?? null;
}

/** Parse a transcript's markdown back into ordered turns. Header lines look
 *  like "## you · <stamp>" / "## co · <stamp>" / "## · <stamp>" (see
 *  appendTranscript); everything until the next header is that turn's body. */
function parseTranscript(content: string): TranscriptTurn[] {
  const headerRe = /^## (you|co|·) · (.+)$/;
  const turns: TranscriptTurn[] = [];
  let cur: { role: TranscriptTurn["role"]; stamp: string; body: string[] } | null = null;
  const flush = (): void => {
    if (!cur) return;
    const text = cur.body.join("\n").trim();
    if (text) turns.push({ role: cur.role, stamp: cur.stamp, text });
    cur = null;
  };
  for (const raw of content.split("\n")) {
    const m = raw.match(headerRe);
    if (m) {
      flush();
      const label = m[1];
      const role = label === "you" ? "you" : label === "co" ? "co" : "note";
      cur = { role, stamp: m[2] ?? "", body: [] };
    } else if (cur) {
      cur.body.push(raw);
    }
  }
  flush();
  return turns;
}

/**
 * Read the tail of the most recent PRIOR session transcript: the newest turns,
 * oldest-truncated to a character budget, returned in chronological order. This
 * is what makes a restart feel continuous ("knows the last few messages") and
 * is the deterministic backstop to model-driven distillation — see
 * TRANSCRIPT_TAIL_MAX_CHARS. Returns [] for a fresh instance or on any read
 * error; continuity is best-effort and never fatal to session start.
 */
export async function readTranscriptTail(
  p: InstancePaths,
  opts: { excludeFile?: string; maxChars?: number } = {},
): Promise<TranscriptTurn[]> {
  const file = await latestTranscriptFile(p, opts.excludeFile);
  if (!file) return [];
  let content: string;
  try {
    content = await fsp.readFile(file, "utf8");
  } catch {
    return [];
  }
  const maxChars = opts.maxChars ?? TRANSCRIPT_TAIL_MAX_CHARS;
  const turns = parseTranscript(content);

  // Accumulate newest-first until the budget is spent, then restore order. A
  // single oversized turn is capped rather than dropped so we always return at
  // least the most recent exchange.
  const picked: TranscriptTurn[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (picked.length > 0 && used + t.text.length > maxChars) break;
    const text =
      t.text.length > maxChars ? t.text.slice(0, maxChars) + " …[truncated]" : t.text;
    picked.push({ ...t, text });
    used += text.length;
  }
  picked.reverse();
  return picked;
}

export interface SearchHit {
  line: number;
  text: string;
}

/**
 * Case-insensitive substring search of a single log, returning matching lines
 * with 1-based line numbers. This is deliberately simple — logs are markdown,
 * and the model can ask for a wider range around a hit.
 */
export async function searchLog(
  p: InstancePaths,
  log: LogName,
  query: string,
  limit = 40,
): Promise<SearchHit[]> {
  let content: string;
  try {
    content = await fsp.readFile(p.logFile(log), "utf8");
  } catch {
    return [];
  }
  const q = query.toLowerCase();
  const hits: SearchHit[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.toLowerCase().includes(q)) {
      hits.push({ line: i + 1, text: line });
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

/** Read a 1-based inclusive line range from a log. */
export async function readLogRange(
  p: InstancePaths,
  log: LogName,
  start: number,
  end: number,
): Promise<string> {
  let content: string;
  try {
    content = await fsp.readFile(p.logFile(log), "utf8");
  } catch {
    return "";
  }
  const lines = content.split("\n");
  const s = Math.max(1, start);
  const e = Math.min(lines.length, end);
  if (s > e) return "";
  return lines
    .slice(s - 1, e)
    .map((l, idx) => `${s + idx}: ${l}`)
    .join("\n");
}

export interface StaleInfo {
  stale: boolean;
  activeContextMtime: number | null;
  newerLogs: { log: LogName; mtime: number }[];
}

/**
 * End-of-session guard input: is activeContext.md older than any log file?
 * We apply a small skew tolerance so a log touched moments before an
 * activeContext rewrite does not register as stale.
 */
export async function detectStaleActiveContext(
  p: InstancePaths,
  skewMs = 2000,
): Promise<StaleInfo> {
  let acMtime: number | null = null;
  try {
    acMtime = (await fsp.stat(p.liveFile("activeContext.md"))).mtimeMs;
  } catch {
    acMtime = null;
  }

  const newer: { log: LogName; mtime: number }[] = [];
  for (const log of LOG_NAMES) {
    try {
      const m = (await fsp.stat(p.logFile(log))).mtimeMs;
      if (acMtime === null || m > acMtime + skewMs) {
        newer.push({ log, mtime: m });
      }
    } catch {
      // log missing; ignore
    }
  }
  return {
    stale: acMtime === null ? newer.length > 0 : newer.length > 0,
    activeContextMtime: acMtime,
    newerLogs: newer,
  };
}

/**
 * Archive: move closed log content off the default read path. V1 supports the
 * simple, safe operation — snapshot the current log into archive/<log>/ with a
 * timestamp, then reset the live log to its header. This preserves history
 * verbatim while keeping cold-start cost flat. Callers decide when to invoke.
 */
export async function archiveLog(p: InstancePaths, log: LogName): Promise<string | null> {
  const file = p.logFile(log);
  let content: string;
  try {
    content = await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
  // Nothing but a header? Skip.
  const body = content.split("\n").filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("_"));
  if (body.length === 0) return null;

  const dir = p.archiveDir(log);
  await ensureDir(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `${log}-${stamp}.md`);
  await fsp.writeFile(dest, content, "utf8");
  await fsp.writeFile(file, logHeader(LOG_TITLES[log]) + "\n", "utf8");
  return dest;
}

/**
 * Line count at which a chatty log is auto-archived. Logs are off the cold-start
 * read path, so a big log never bloats context — it only makes on-demand
 * search_log noisier. So this is set high: crossing it means the log is
 * genuinely large (hundreds of entries), and archiving wholesale is fine because
 * the snapshot preserves everything verbatim under archive/.
 */
export const AUTO_ARCHIVE_LINE_THRESHOLD = 1500;

/**
 * Logs eligible for automatic archiving. `decisions` is deliberately EXCLUDED:
 * it is the one log referenced by stable id (D-YYYYMMDD-N) from activeContext,
 * it carries the app's confirmation invariant, and it grows slowly — silently
 * moving it off the searchable path would be surprising in a bad way. The chatty
 * logs (progress, research) are what actually grow, so only those auto-archive.
 * Users can still archive decisions explicitly via /archive.
 */
const AUTO_ARCHIVE_LOGS: LogName[] = ["progress", "research"];

export interface AutoArchiveResult {
  log: LogName;
  dest: string;
  lines: number;
}

/**
 * Archive any chatty log that has grown past AUTO_ARCHIVE_LINE_THRESHOLD. Meant
 * to be called once at session exit (cheap: a stat/read per eligible log). Reuses
 * archiveLog for the actual snapshot+reset, so this only adds the trigger. Skips
 * decisions (see AUTO_ARCHIVE_LOGS). Best-effort: a failure archiving one log
 * must not block exit, so errors are swallowed per-log. Returns what it archived.
 */
export async function autoArchiveLargeLogs(
  p: InstancePaths,
  threshold = AUTO_ARCHIVE_LINE_THRESHOLD,
): Promise<AutoArchiveResult[]> {
  const archived: AutoArchiveResult[] = [];
  for (const log of AUTO_ARCHIVE_LOGS) {
    let lines: number;
    try {
      const content = await fsp.readFile(p.logFile(log), "utf8");
      lines = content.split("\n").length;
    } catch {
      continue; // log missing; nothing to archive
    }
    if (lines < threshold) continue;
    try {
      const dest = await archiveLog(p, log);
      if (dest) archived.push({ log, dest, lines });
    } catch {
      // best-effort: never let archiving block a clean exit
    }
  }
  return archived;
}
