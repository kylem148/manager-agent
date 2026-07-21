import path from "node:path";

/**
 * Filesystem layout for a co-manager instance. Two tiers, split by audience:
 * user-facing documents flat in docs/, and the co-manager's own hidden
 * self-managed substrate in .memory/.
 *
 *   <home>/
 *     instances/<name>/
 *       docs/                        user-facing documents (flat, starts empty)
 *         architecture.md, plan.md, ...  born with their workflow, via the doc tool
 *       .memory/                     hidden substrate the co-manager manages
 *         projectbrief.md            rewritten-in-full orientation
 *         activeContext.md           rewritten-in-full orientation
 *         decisions.md               append-only log
 *         progress.md                append-only log
 *         research.md                append-only log
 *         archive/                   cold log history, off the read path
 *           decisions/ progress/ research/
 *         sessions/                  per-session transcripts (the raw record)
 *
 * There is no shared/ dir: the protocol reference that used to live there is now
 * assembled into the system prompt from code (see prompt.ts). Orders to the crew
 * (coding-agent prompts) are NOT persisted to a file either. The co-manager
 * writes them straight into its reply, and the session transcript is the record.
 */

export const DOCS_DIR = "docs";
export const MEMORY_DIR = ".memory";

/**
 * Substrate orientation files: rewritten in full, read at every cold start, and
 * owned by the co-manager rather than the user. User-facing documents are NOT in
 * here — they live flat in docs/ and are addressed by name through the doc tool
 * (see memory/docs.ts).
 */
export const LIVE_FILES = ["projectbrief.md", "activeContext.md"] as const;
export type LiveFile = (typeof LIVE_FILES)[number];

export const LOG_FILES = ["decisions.md", "progress.md", "research.md"] as const;
export type LogName = "decisions" | "progress" | "research";

/** Log names without the .md, the single source for iterating over logs. */
export const LOG_NAMES = LOG_FILES.map((f) => f.replace(".md", "")) as LogName[];

export function logFileName(name: LogName): string {
  return `${name}.md`;
}

export interface InstancePaths {
  name: string;
  root: string;
  /** User-facing documents, flat. */
  docs: string;
  /** Hidden self-managed substrate. */
  memory: string;
  /** Cold log history, under .memory/. */
  archive: string;
  /** Per-session transcripts, under .memory/. */
  sessions: string;
  /** Resolve a substrate orientation file under .memory/. */
  liveFile: (f: LiveFile) => string;
  logFile: (name: LogName) => string;
  archiveDir: (name: LogName) => string;
  /** Resolve an arbitrary user document under docs/. */
  docFile: (name: string) => string;
}

export function instancesDir(home: string): string {
  return path.join(home, "instances");
}

export function instancePaths(home: string, name: string): InstancePaths {
  const root = path.join(instancesDir(home), name);
  const docs = path.join(root, DOCS_DIR);
  const memory = path.join(root, MEMORY_DIR);
  const archive = path.join(memory, "archive");
  const sessions = path.join(memory, "sessions");
  return {
    name,
    root,
    docs,
    memory,
    archive,
    sessions,
    liveFile: (f) => path.join(memory, f),
    logFile: (n) => path.join(memory, logFileName(n)),
    archiveDir: (n) => path.join(archive, n),
    docFile: (n) => path.join(docs, n),
  };
}

/** A valid instance name: keep it filesystem- and shell-friendly. */
export function isValidInstanceName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name);
}
