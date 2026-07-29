import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Locate and render a crew agent's OWN session transcript for review.
 *
 * WHY: a pane-dispatched agent runs fully interactively on the pane tty with
 * nothing interposed (see transport.ts), so there is no recording of the run —
 * and live testing showed a pty recording of a TUI session is escape-mangled
 * past usefulness anyway. Claude Code keeps its own complete session transcript
 * as JSONL under its config dir; that is a far better review record than any
 * terminal scrape: full message text, tool calls, results, no escape codes.
 *
 * This is the one deliberately Claude-Code-aware corner of dispatch (decision:
 * the transport itself stays agent-agnostic; the capture+sentinel contract is
 * unchanged). For an agent whose transcript we can't locate, review falls back
 * to the capture file, which for a pane run holds only the sentinel — the
 * review then says so honestly rather than pretending to a record.
 *
 * HOW A JOB'S TRANSCRIPT IS FOUND: Claude Code stores sessions at
 *   <configDir>/projects/<slugified-cwd>/<sessionId>.jsonl
 * where configDir is CLAUDE_CONFIG_DIR (parsed from the agent command's env
 * prefix, e.g. `CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude {prompt}`) or
 * ~/.claude by default. There is no CLI flag to pin a session id at launch (no
 * --session-id in the shipped CLI), so the job's file is identified by
 * CONTENT: the dispatch order is passed as the launch prompt, so the
 * transcript whose first user message matches the order is this job's — exact
 * even with several concurrent jobs in the same repo, since each job's order
 * differs. Candidates are pre-filtered to files modified after the job
 * started.
 */

/** Parse the CLAUDE_CONFIG_DIR=... env prefix out of a resolved agent command.
 *  Returns the default ~/.claude when the command has no prefix (the personal
 *  setup). Handles double-quoted, single-quoted, and bare values, and expands
 *  a leading ~ or $HOME — the two forms an rc-file alias realistically uses. */
export function claudeConfigDir(agentCommand: string, home: string = os.homedir()): string {
  const m = /(?:^|\s)CLAUDE_CONFIG_DIR=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(agentCommand);
  const raw = m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
  if (!raw) return path.join(home, ".claude");
  let v = raw;
  v = v.replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  if (v === "~" || v.startsWith("~/")) v = path.join(home, v.slice(1));
  return v;
}

/** Claude Code's project-directory slug for a working directory: every
 *  non-alphanumeric character becomes '-' (verified against a real
 *  ~/.claude/projects: /Users/x/Code/a-b → -Users-x-Code-a-b). */
export function claudeProjectSlug(repoPath: string): string {
  return repoPath.replace(/[^A-Za-z0-9]/g, "-");
}

/** Collapse whitespace so an order and its echo in a transcript compare
 *  reliably across newline/indentation differences. */
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Extract the plain text of the first real user message in a transcript. A
 *  Claude Code JSONL line is {type:"user", message:{content: string | blocks}};
 *  tool results also arrive as type:"user" but with block arrays, which the
 *  first PROMPT of a session never is — the launch prompt is a plain string. */
function firstUserPrompt(jsonlHead: string): string | null {
  for (const line of jsonlHead.split("\n")) {
    if (!line.includes('"user"')) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const o = obj as { type?: string; message?: { content?: unknown } };
    if (o.type !== "user") continue;
    const content = o.message?.content;
    if (typeof content === "string") return content;
  }
  return null;
}

/**
 * Find the transcript file for a dispatched job, or null when none can be
 * identified (non-Claude agent, transcript dir missing, or no content match).
 * Matching is by the job's order text against each candidate's first user
 * message; candidates are .jsonl files modified after the job started (with a
 * small grace margin for clock skew between stat and the job clock).
 */
export async function findCrewTranscript(args: {
  agentCommand: string;
  repoPath: string;
  order: string;
  startedAtMs: number;
}): Promise<string | null> {
  const { agentCommand, repoPath, order, startedAtMs } = args;
  if (!repoPath) return null;
  const dir = path.join(claudeConfigDir(agentCommand), "projects", claudeProjectSlug(repoPath));
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const wanted = normalize(order).slice(0, 200);
  if (!wanted) return null;

  const candidates: { file: string; mtimeMs: number }[] = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    try {
      const st = await fsp.stat(file);
      if (st.mtimeMs >= startedAtMs - 15_000) candidates.push({ file, mtimeMs: st.mtimeMs });
    } catch {
      /* raced a deletion; skip */
    }
  }
  // Newest first: the common case is exactly one candidate; with several, a
  // later scan hit is still guarded by the content match below.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const cand of candidates) {
    let head: string;
    try {
      head = await readHead(cand.file, 256 * 1024);
    } catch {
      continue;
    }
    const prompt = firstUserPrompt(head);
    if (!prompt) continue;
    // Compare on the shorter prefix so a long order matches its (clipped)
    // echo and a short order doesn't demand characters that don't exist.
    const got = normalize(prompt);
    if (got.startsWith(wanted) || wanted.startsWith(got)) return cand.file;
  }
  return null;
}

/** Read at most the first `maxBytes` of a file. */
async function readHead(file: string, maxBytes: number): Promise<string> {
  const fh = await fsp.open(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/** One content block inside a Claude Code transcript message. */
interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

/**
 * Render a Claude Code JSONL transcript into compact, readable review text:
 * every word the crew SAID in full, tool calls as one-liners, tool results
 * trimmed hard — the review needs what the crew said and did, not every byte a
 * build printed. Unparseable lines are skipped (a tail-truncated read may cut
 * the first line).
 *
 * THE CREW'S COMPLETION REPORT IS NEVER CUT. It is the whole point of the
 * review, it is the last thing the crew says, and it is the one thing an order
 * explicitly asks the crew to close with a diffstat, its verification output and
 * the approaches it dropped. So the render splits in two: the run's CONTEXT
 * (everything up to the crew's last spoken message) is bounded by `maxChars`,
 * keeping its tail; the REPORT is appended whole, however long it is, and the
 * budget does not apply to it.
 *
 * An earlier revision clipped EVERY message at 2000 characters and kept the
 * head, so a report longer than that reached the reviewing co-manager cut
 * mid-sentence with its diffstat and verification silently missing. Nothing
 * here cuts silently any more: every bound that bites says so inline, naming
 * bytes shown against bytes captured.
 */
export function renderTranscriptForReview(jsonl: string, maxChars: number): string {
  const out: string[] = [];
  // Where the crew's final spoken message starts in `out`. Everything from here
  // down is the report and is exempt from the context budget.
  let reportAt = -1;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const o = obj as { type?: string; message?: { content?: string | Block[] } };
    if (o.type !== "user" && o.type !== "assistant") continue;
    const content = o.message?.content;
    if (typeof content === "string") {
      // The launch prompt: the order itself, verbatim — the review reads the
      // report against what was actually asked for.
      out.push(`[prompt] ${trimEnd(content)}`);
      continue;
    }
    if (!Array.isArray(content)) continue;
    // A message's own text blocks open a new candidate report: the last message
    // that says anything is the one carrying the completion report.
    let saidSomething = false;
    for (const b of content) {
      if (b.type === "text" && b.text) {
        if (!saidSomething && o.type === "assistant") {
          saidSomething = true;
          reportAt = out.length;
        }
        out.push(`[crew] ${trimEnd(b.text)}`);
      } else if (b.type === "tool_use") {
        out.push(`[tool] ${b.name ?? "?"} ${clip(JSON.stringify(b.input ?? ""), 300)}`);
      } else if (b.type === "tool_result") {
        out.push(`[result] ${clip(flattenResult(b.content), 400)}`);
      }
      // thinking blocks are deliberately dropped: never render thinking.
    }
  }
  // No spoken message at all (a run that only called tools): there is no report
  // to protect, so the whole record is context.
  const split = reportAt < 0 ? out.length : reportAt;
  const context = out.slice(0, split).join("\n");
  const report = out.slice(split).join("\n");
  if (context.length <= maxChars) return [context, report].filter((s) => s).join("\n");
  return [
    `…[co: the earlier part of this record was trimmed — showing the last ${maxChars} of ` +
      `${context.length} bytes of run context. The crew's final report below is complete.]`,
    context.slice(-maxChars),
    report,
  ]
    .filter((s) => s)
    .join("\n");
}

function flattenResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "object" && b && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join(" ");
  }
  return "";
}

function trimEnd(s: string): string {
  return s.replace(/\s+$/g, "");
}

/**
 * Bound a one-liner — a tool call's input, a tool result — and SAY SO when the
 * bound bites, naming bytes shown against bytes captured. A build's stdout is
 * the runaway this exists for, and it is legitimately not worth its bytes in a
 * review; a cut nobody is told about is a different thing entirely, and is the
 * defect this whole path was rebuilt to remove. The crew's own words never come
 * through here — see renderTranscriptForReview.
 */
function clip(s: string, max: number): string {
  const t = trimEnd(s);
  if (t.length <= max) return t;
  return t.slice(0, max) + `…[co: ${max} of ${t.length} bytes shown]`;
}
