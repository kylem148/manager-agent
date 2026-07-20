import type { Tool, ToolUseBlock, ToolResult } from "./model.js";
import { LOG_NAMES, type InstancePaths, type LiveFile, type LogName } from "./paths.js";
import type { ResearchConfig } from "./config.js";
import {
  appendLog,
  rewriteLive,
  searchLog,
  readLogRange,
  readLiveMemory,
} from "./memory.js";
import { searchWeb, fetchUrl } from "./research.js";
import type { SearchOptions } from "./research.js";

/**
 * The co-manager's internal capability surface, exposed to the model as tools.
 * These are NOT surfaced mechanically to the user — the model decides when to
 * call them based on the conversation.
 *
 * Memory is the co-manager's own, self-managed and invisible. Decisions,
 * progress, research, and live-state updates are recorded on the model's own
 * judgment, as they are reached in conversation. No user confirmation gates a
 * write, and no write is narrated: the executor never asks the user to approve a
 * decision and never reports what it saved. Memory reads and writes stay silent;
 * only external work (web search, fetch) surfaces as activity.
 */

export const LIVE_FILE_ENUM: LiveFile[] = ["projectbrief.md", "activeContext.md", "architecture.md"];
export const LOG_ENUM: LogName[] = LOG_NAMES;

/**
 * Tool activity the REPL may surface to the user: external work only. Memory
 * reads and writes are the co-manager's private bookkeeping and never announce
 * themselves, so they are deliberately absent here.
 */
export const SURFACED_TOOLS = new Set<string>(["search_web", "fetch_url"]);

export function toolDefinitions(): Tool[] {
  return [
    {
      name: "read_live_memory",
      description:
        "Re-read the three live-state files (projectbrief, activeContext, architecture). They are already provided at session start; call this only to refresh after a rewrite.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "search_log",
      description:
        "Search one append-only log for a substring (case-insensitive). Returns matching lines with line numbers. Use before read_log_range to locate history without loading the whole log.",
      input_schema: {
        type: "object",
        properties: {
          log: { type: "string", enum: LOG_ENUM },
          query: { type: "string", description: "Substring to search for." },
        },
        required: ["log", "query"],
        additionalProperties: false,
      },
    },
    {
      name: "read_log_range",
      description:
        "Read an inclusive 1-based line range from a log. Use after search_log to pull the surrounding context of a hit.",
      input_schema: {
        type: "object",
        properties: {
          log: { type: "string", enum: LOG_ENUM },
          start: { type: "integer" },
          end: { type: "integer" },
        },
        required: ["log", "start", "end"],
        additionalProperties: false,
      },
    },
    {
      name: "append_progress",
      description:
        "Append a progress note to progress.md (the narrative of what changed). May be used freely without asking the user.",
      input_schema: {
        type: "object",
        properties: { entry: { type: "string" } },
        required: ["entry"],
        additionalProperties: false,
      },
    },
    {
      name: "append_research",
      description:
        "Append a research note to research.md. Should include question, sources, findings, tradeoffs, recommendation, and confidence. May be used freely.",
      input_schema: {
        type: "object",
        properties: { entry: { type: "string" } },
        required: ["entry"],
        additionalProperties: false,
      },
    },
    {
      name: "append_decision",
      description:
        "Record a decision to decisions.md as it is reached in conversation, using your own judgment about what is a settled decision worth keeping. A decision id (D-YYYYMMDD-N) is minted automatically. This is silent and needs no user confirmation: do not announce it and do not ask the user to approve the record.",
      input_schema: {
        type: "object",
        properties: {
          entry: {
            type: "string",
            description: "The decision, with context and rationale. Do not include the id; it is minted.",
          },
        },
        required: ["entry"],
        additionalProperties: false,
      },
    },
    {
      name: "rewrite_active_context",
      description:
        "Rewrite activeContext.md in full with fresh, compact orientation content. Use when state has changed enough that the live orientation is stale.",
      input_schema: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
        additionalProperties: false,
      },
    },
    {
      name: "rewrite_architecture",
      description: "Rewrite architecture.md in full with the current architectural picture.",
      input_schema: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
        additionalProperties: false,
      },
    },
    {
      name: "rewrite_projectbrief",
      description: "Rewrite projectbrief.md in full. Keep it compact.",
      input_schema: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
        additionalProperties: false,
      },
    },
    {
      name: "search_web",
      description:
        "Search the web for candidate sources via the configured provider. Returns titles, URLs, and snippets. Prefer primary sources; corroborate before concluding.\n\n" +
        "Recency is your call, per query, based on intent:\n" +
        "- Set published_within_days to a recent window (e.g. 30, 90, 365) for queries about up-to-date, current, latest, or \"is this still the standard\" implementations. Semantic search otherwise surfaces canonical-but-stale results, so clamp the pool when you want what's current.\n" +
        "- OMIT published_within_days for historical, conceptual, or \"what have people done over time\" prior-art queries, where old canonical sources are exactly what you want.\n" +
        "- Set fresh_content: true when it matters that the page content is live rather than cached (e.g. a fast-moving doc or changelog). Leave it off otherwise.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string" },
          count: { type: "integer", description: "Max results (default 6)." },
          published_within_days: {
            type: "integer",
            description:
              "Constrain results to content published within the last N days. Set for latest/current queries; omit for historical or prior-art queries.",
          },
          fresh_content: {
            type: "boolean",
            description:
              "If true, fetch inline page content live rather than from cache. Use for fast-moving pages.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "fetch_url",
      description:
        "Fetch a URL and return its content as clean text/markdown. Use to read a source found via search_web or a link the user gave you.",
      input_schema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  ];
}

/** Records what the tool loop changed, so the REPL can drive the sync guard. */
export interface ToolSideEffects {
  logsTouched: Set<LogName>;
  liveRewritten: Set<LiveFile>;
  decisionsRecorded: string[];
}

export function newSideEffects(): ToolSideEffects {
  return {
    logsTouched: new Set(),
    liveRewritten: new Set(),
    decisionsRecorded: [],
  };
}

export interface ExecutorContext {
  paths: InstancePaths;
  research: ResearchConfig;
  effects: ToolSideEffects;
  /** Optional callback so the REPL can surface external work (web search, fetch)
   *  as activity. Memory operations never call it — they stay silent. */
  onNotice?: (msg: string) => void;
}

function ok(id: string, obj: unknown): ToolResult {
  return { tool_use_id: id, content: typeof obj === "string" ? obj : JSON.stringify(obj) };
}
function err(id: string, msg: string): ToolResult {
  return { tool_use_id: id, content: msg, is_error: true };
}

/** Build the tool executor bound to a specific instance + config. */
export function makeExecutor(ctx: ExecutorContext) {
  const { paths, research, effects } = ctx;

  return async function execute(block: ToolUseBlock): Promise<ToolResult> {
    const id = block.id;
    const input = (block.input ?? {}) as Record<string, unknown>;
    try {
      switch (block.name) {
        case "read_live_memory": {
          const live = await readLiveMemory(paths);
          return ok(id, live);
        }
        case "search_log": {
          const hits = await searchLog(paths, input.log as LogName, String(input.query ?? ""));
          return ok(id, { hits });
        }
        case "read_log_range": {
          const text = await readLogRange(
            paths,
            input.log as LogName,
            Number(input.start),
            Number(input.end),
          );
          return ok(id, { text });
        }
        case "append_progress": {
          const r = await appendLog(paths, "progress", String(input.entry ?? ""));
          effects.logsTouched.add("progress");
          return ok(id, { saved: true, file: r.file });
        }
        case "append_research": {
          const r = await appendLog(paths, "research", String(input.entry ?? ""));
          effects.logsTouched.add("research");
          return ok(id, { saved: true, file: r.file });
        }
        case "append_decision": {
          const r = await appendLog(paths, "decisions", String(input.entry ?? ""));
          effects.logsTouched.add("decisions");
          if (r.id) effects.decisionsRecorded.push(r.id);
          return ok(id, { saved: true, id: r.id, file: r.file });
        }
        case "rewrite_active_context": {
          await rewriteLive(paths, "activeContext.md", String(input.content ?? ""));
          effects.liveRewritten.add("activeContext.md");
          return ok(id, { rewritten: "activeContext.md" });
        }
        case "rewrite_architecture": {
          await rewriteLive(paths, "architecture.md", String(input.content ?? ""));
          effects.liveRewritten.add("architecture.md");
          return ok(id, { rewritten: "architecture.md" });
        }
        case "rewrite_projectbrief": {
          await rewriteLive(paths, "projectbrief.md", String(input.content ?? ""));
          effects.liveRewritten.add("projectbrief.md");
          return ok(id, { rewritten: "projectbrief.md" });
        }
        case "search_web": {
          const count = Number.isFinite(Number(input.count)) ? Number(input.count) : 6;
          const options: SearchOptions = {};
          if (input.published_within_days !== undefined && Number.isFinite(Number(input.published_within_days))) {
            options.publishedWithinDays = Number(input.published_within_days);
          }
          if (input.fresh_content !== undefined) options.freshContent = Boolean(input.fresh_content);
          const res = await searchWeb(research, String(input.query ?? ""), count, options);
          ctx.onNotice?.(`searched the web (${res.provider})`);
          return ok(id, res);
        }
        case "fetch_url": {
          const res = await fetchUrl(research, String(input.url ?? ""));
          ctx.onNotice?.(`fetched ${res.url}`);
          return ok(id, res);
        }
        default:
          return err(id, `Unknown tool: ${block.name}`);
      }
    } catch (e) {
      return err(id, `Tool ${block.name} failed: ${(e as Error).message}`);
    }
  };
}
