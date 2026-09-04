import path from "node:path";

/**
 * Filesystem layout for a co-manager instance. Two tiers, split by audience:
 * user-facing documents flat in docs/, and the co-manager's own hidden
 * self-managed substrate in .memory/.
 *
 *   <home>/
 *     instances/<name>/
 *       .cost.json                   running token/cost meter, shown by /cost
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
 * Third tier, alongside docs/ and .memory/: dispatch state. Holds the
 * per-instance dispatch config (co link) and per-job capture files. It is
 * neither user-facing prose (docs/) nor the co-manager's silent memory
 * substrate (.memory/), so it gets its own hidden dir rather than being forced
 * into either. Not secret (see the order): plain JSON, no 0600.
 */
export const DISPATCH_DIR = ".dispatch";

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
  /** Dispatch state (config + captures), under .dispatch/. */
  dispatch: string;
  /** The per-instance dispatch config file (co link). */
  dispatchConfig: string;
  /** Per-feature prose co authored and git cannot recover: the feature's intent
   *  (its one-line description) and the PR title/body co wrote when it enqueued
   *  the feature. Keyed by slug, read at startup so both survive a restart and a
   *  re-processed head still opens its pull request with the message co wrote.
   *  Lives beside the dispatch config — feature worktrees are dispatch state —
   *  and is never written into the user's repo. */
  featureStore: string;
  /** The crew panes co owns: each pane's Ghostty id plus the tty and shell pid a
   *  job taught it, and co's dispatch lease on it. Ghostty can only be asked
   *  whether a terminal id still exists, so everything reuse needs to prove a
   *  pane is idle is remembered here — beside the dispatch config, because a
   *  crew pane is dispatch state. Never written into the user's repo. */
  paneStore: string;
  /** The co's own at-a-glance task table: the handful of live items it keeps in
   *  live state, persisted so the Ctrl-O Home tab can render them rather than
   *  waiting for the model to re-print the table into the chat. Sits beside the
   *  feature store for the same reason it does — small, per-instance runtime
   *  state the app reads at paint time — and is never written into the repo. */
  taskTable: string;
  /** The running token/cost meter for this instance (see cost.ts). Sits at the
   *  instance root rather than in .memory/ or .dispatch/ because it is neither:
   *  not the co-manager's substrate (the co never reads or writes it, and it is
   *  not in the system prompt) and not dispatch state. It is the app's own
   *  bookkeeping about the app, surfaced only by /cost. */
  costLedger: string;
  /** Directory holding per-job capture files. */
  captures: string;
  /** Resolve a per-job capture file under .dispatch/captures/. */
  captureFile: (jobId: string) => string;
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
  const dispatch = path.join(root, DISPATCH_DIR);
  const captures = path.join(dispatch, "captures");
  return {
    name,
    root,
    docs,
    memory,
    archive,
    sessions,
    dispatch,
    dispatchConfig: path.join(dispatch, "config.json"),
    featureStore: path.join(dispatch, "features.json"),
    paneStore: path.join(dispatch, "panes.json"),
    taskTable: path.join(dispatch, "tasks.json"),
    costLedger: path.join(root, ".cost.json"),
    captures,
    captureFile: (jobId) => path.join(captures, `${jobId}.log`),
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
