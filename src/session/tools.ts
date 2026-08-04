import type { Tool, ToolUseBlock, ToolResult } from "../model.js";
import type { InstancePaths, LiveFile, LogName } from "../paths.js";
import type { ResearchConfig } from "../config.js";
import {
  appendLog,
  rewriteLive,
  searchLog,
  readLogRange,
} from "../memory/memory.js";
import {
  DocError,
  createDoc,
  deleteDoc,
  listDocs,
  overwriteDoc,
  readDoc,
  strReplaceDoc,
} from "../memory/docs.js";
import { searchWeb, fetchUrl } from "../research.js";
import type { SearchOptions } from "../research.js";
import type { FeatureManager } from "./features.js";
import { FEATURE_BRANCH_TYPES } from "./worktrees.js";
import { TaskError, TASK_STATUSES, type TaskStore } from "./taskstore.js";
import { taskDisplayOrder } from "../taskorder.js";
import {
  isProtocolSection,
  protocolBody,
  protocolSectionsFor,
  type ProtocolSection,
} from "./protocols.js";

/**
 * The co-manager's capability surface, exposed to the model as tools.
 *
 * The descriptions here are part of the resident 32K-byte budget (see
 * prompt.ts): they ride the same single cache breakpoint as the system prompt
 * and are held to TOOLS_BUDGET_BYTES serialized, enforced by test. Behaviour
 * lives in the system prompt sections; a description carries mechanics only -
 * what the tool does, its arguments, and the failure shapes the model must
 * know to call it correctly. Procedure lives in protocols.ts, on demand.
 *
 * Memory is the co's own, self-managed and invisible: no user confirmation
 * gates a write and no write is narrated. Only external work (web search,
 * fetch) surfaces as activity.
 */

export const MEMORY_KINDS = ["decision", "progress", "research"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

const KIND_TO_LOG: Record<MemoryKind, LogName> = {
  decision: "decisions",
  progress: "progress",
  research: "research",
};

export const MEMORY_SEARCH_COMMANDS = ["search_log", "read_log_range"] as const;
export type MemorySearchCommand = (typeof MEMORY_SEARCH_COMMANDS)[number];

export const MEMORY_REWRITE_FILES = ["projectbrief", "activeContext"] as const;
export type MemoryRewriteFile = (typeof MEMORY_REWRITE_FILES)[number];

const REWRITE_TO_LIVE: Record<MemoryRewriteFile, LiveFile> = {
  projectbrief: "projectbrief.md",
  activeContext: "activeContext.md",
};

export const DOC_COMMANDS = [
  "create",
  "read",
  "str_replace",
  "overwrite",
  "delete",
  "list",
] as const;
export type DocCommand = (typeof DOC_COMMANDS)[number];

export const TASK_COMMANDS = [
  "add",
  "status",
  "rename",
  "retire",
  "list",
] as const;
export type TaskCommand = (typeof TASK_COMMANDS)[number];

/**
 * Tool activity the REPL may surface to the user: external work only. Memory
 * operations never announce themselves. `dispatch_order` surfaces its own
 * pending-confirm banner through the arm callback.
 */
export const SURFACED_TOOLS = new Set<string>(["web_search", "web_fetch"]);

export function toolDefinitions(opts: { dispatch?: boolean } = {}): Tool[] {
  const tools: Tool[] = [
    {
      name: "memory_write",
      description:
        "Append one entry to your own memory: a settled `decision` (stable id minted automatically; do not include one), a `progress` note (the narrative of what changed), or a `research` note (question, sources, findings, recommendation, confidence). Silent - never announce it or ask permission.",
      input_schema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...MEMORY_KINDS] },
          entry: { type: "string" },
        },
        required: ["kind", "entry"],
        additionalProperties: false,
      },
    },
    {
      name: "memory_search",
      description:
        "Read past history from the append-only logs. `search_log` returns lines matching `query` (case-insensitive substring) with line numbers; `read_log_range` returns the inclusive 1-based range `start`..`end`. Search first, then read the surrounding range for context.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", enum: [...MEMORY_SEARCH_COMMANDS] },
          log: { type: "string", enum: ["decisions", "progress", "research"] },
          query: { type: "string", description: "search_log only." },
          start: { type: "integer", description: "read_log_range only." },
          end: { type: "integer", description: "read_log_range only." },
        },
        required: ["command", "log"],
        additionalProperties: false,
      },
    },
    {
      name: "memory_rewrite",
      description:
        "Replace one live-state file in full: `projectbrief` (what the project is; keep it compact) or `activeContext` (orientation: focus, recent decisions with ids, rolling conversation summary, risks, next actions). Whole-file rewrite - spend it only when orientation has genuinely moved.",
      input_schema: {
        type: "object",
        properties: {
          file: { type: "string", enum: [...MEMORY_REWRITE_FILES] },
          content: { type: "string" },
        },
        required: ["file", "content"],
        additionalProperties: false,
      },
    },
    {
      name: "doc",
      description:
        "Author the captain's markdown under docs/ (plan.md, architecture.md, others on request). Commands: `list`; `read` (before editing); `create` (fails if it exists); `str_replace` (old_str must match exactly once - include context to disambiguate; ambiguity is an error, not a guess); `overwrite` (full rewrite); `delete`. Flat .md files in this instance's docs/ only; never touches .memory/. `read_protocol` (`docs`) says what plan.md and architecture.md each hold.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", enum: [...DOC_COMMANDS] },
          name: {
            type: "string",
            description: 'Bare filename, e.g. "plan.md". Omit for list.',
          },
          content: { type: "string", description: "For create and overwrite." },
          old_str: { type: "string", description: "str_replace: exact text to replace." },
          new_str: { type: "string", description: 'str_replace: replacement ("" deletes).' },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    {
      name: "web_search",
      description:
        "Search the web for candidate sources: titles, URLs, snippets. Set `published_within_days` (e.g. 30, 365) on latest/current queries so canonical-but-stale results are clamped out; omit it for historical or prior-art queries. Set `fresh_content` true when the page must be read live rather than from cache.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string" },
          count: { type: "integer", description: "Max results (default 6)." },
          published_within_days: { type: "integer" },
          fresh_content: { type: "boolean" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "web_fetch",
      description:
        "Fetch one URL as clean text/markdown. Use it to read a source web_search found or a link the captain gave you.",
      input_schema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
    {
      name: "task_table",
      description:
        "Read and edit the captain's task table, one row at a time. Commands: `list`; `add` (always `queued`); `status` (`building`; `enqueued` - in the merge queue; `testing` - built but not yet checked; or `queued`); `rename` (`task` -> `new_task`, keeps status and place); `retire` (what done means; the stages precede it, never replace it). Address a row by its EXACT text from `list`, never by position: the captain edits it between turns, and text matching no row or several is an error, not a guess. No whole-table write, clear or reorder.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", enum: [...TASK_COMMANDS] },
          task: {
            type: "string",
            description:
              "add: the new row's text (one short line, no body). Others: the exact text of the row to act on.",
          },
          new_task: {
            type: "string",
            description:
              "rename only: the new text. Not empty, and must not read the same as a different row.",
          },
          status: { type: "string", enum: [...TASK_STATUSES] },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    {
      name: "read_protocol",
      description:
        "Put one protocol section in front of you, BEFORE acting on its subject: `orders` before writing ANY order for the crew; `features` before any feature lever; `lanes` before dispatching into a worktree that already holds a live agent; `pr-message` before composing a prTitle/prBody; `memory` for the memory file layout; `docs` for what plan.md and architecture.md hold. These are exact procedures with real failure modes, not summaries you can reconstruct. dispatch_order and feature_enqueue REFUSE a call made without the relevant section in context and hand it over in the refusal - so read first, and only ever write the thing once.",
      input_schema: {
        type: "object",
        properties: {
          section: { type: "string", enum: protocolSectionsFor(opts) },
        },
        required: ["section"],
        additionalProperties: false,
      },
    },
  ];

  // Dispatch and feature levers exist only when the instance is linked to a
  // repo (co link). dispatch_order ARMS; the captain's typed `confirm` in the
  // session loop is the only thing that ever launches a crew agent.
  if (opts.dispatch) {
    tools.push({
      name: "dispatch_order",
      description:
        "ARM a dispatch of an implementation-ready order to the crew. It runs NOTHING: the captain is shown the order and the resolved command, and the dispatch fires only on their typed `confirm` - anything else cancels it. Pass the complete order text, written to the orders protocol (an order written without it is refused). Scope to a feature's worktree with `feature` (provisioned on first use); omit it for the bare main tree. A worktree already holding a live agent is lane-gated at confirm time: the captain chooses read-only or `confirm write` - see the lanes protocol. Arm at most one order per turn, and never claim the order ran because you armed it.",
      input_schema: {
        type: "object",
        properties: {
          order: { type: "string", description: "The complete order, the crew agent's prompt." },
          feature: {
            type: "string",
            description: "Optional feature name; the crew runs in its worktree.",
          },
        },
        required: ["order"],
        additionalProperties: false,
      },
    });
    tools.push({
      name: "feature_create",
      description:
        "Provision a feature's isolated worktree: a `<type>/<slug>` branch cut from `origin/dev` with its own checkout, so work runs in parallel and never touches the main tree. No confirm gate (it writes nothing to dev or main), idempotent, and it reports cleanly if `origin/dev` is missing. Always pass `intent`: one stored line on what the feature is FOR, shown beside the worktree in the captain's panel.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: 'Human handle, e.g. "user auth"; slugged for the branch.' },
          type: {
            type: "string",
            enum: [...FEATURE_BRANCH_TYPES],
            description: "Conventional Commits type for the branch prefix. Default feat.",
          },
          intent: { type: "string", description: "One line: what this feature is for." },
        },
        required: ["name"],
        additionalProperties: false,
      },
    });
    tools.push({
      name: "feature_status",
      description:
        "With `name`: one feature's full picture - branch, worktree path, dirty state, live agents and their lanes (only a WRITER blocks the levers), jobs, and its merge-queue position and head state (queued / awaiting-checks / ready / blocked / resolving, with the blocked kind and whether a ready head is ungated). Without `name`: every tracked feature plus the merge queue in landing order.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Feature name or slug. Omit to list all." },
        },
        additionalProperties: false,
      },
    });
    tools.push({
      name: "feature_enqueue",
      description:
        "Mark a feature done and join the serial merge queue; no confirm gate. Only the head is processed: rebased onto fresh `origin/dev`, pushed, PR'd into dev, gated on that PR's own CI checks (co runs no build or test). Returns `ready` (or ready-but-UNGATED when the PR reports no checks: say so, nothing verified it), `awaiting-checks` (a wait, not a failure - re-call to re-read), `blocked` (holds the queue), or `resolving`. You write the PR message: `prTitle` and `prBody` to the pr-message protocol (a body written without it is refused). Idempotent; omitted fields keep stored text, passed ones edit the PR. A ready head merges by the captain's [m], never by you: report it, give the PR link, move on.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Feature name or slug." },
          prTitle: {
            type: "string",
            description: "One imperative, specific line standing alone in history.",
          },
          prBody: {
            type: "string",
            description: "The PR description, written to the pr-message protocol's template.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    });
    tools.push({
      name: "feature_resolve_head",
      description:
        "ARM a fresh crew agent to unblock the merge-queue head when it is blocked by a rebase conflict or a red CI check. The agent runs in the feature's own worktree (never dev), fires only on the captain's typed `confirm`, is bounded to a few attempts, and the head re-processes itself when it finishes. Use this on a blocked head instead of resolving anything yourself.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    });
    tools.push({
      name: "feature_abandon",
      description:
        "Tear down a feature's worktree WITHOUT landing it. Deletes the branch only if it is already contained in `origin/dev`; committed-but-unmerged work keeps its branch. Refuses a worktree with a live WRITING agent or uncommitted changes - it reports, never forces, and discarding unsaved work stays the captain's call.",
      input_schema: {
        type: "object",
        properties: { name: { type: "string", description: "Feature name or slug." } },
        required: ["name"],
        additionalProperties: false,
      },
    });
  }

  return tools;
}

/** Records what the tool loop changed, so the REPL can drive the sync guard. */
export interface ToolSideEffects {
  logsTouched: Set<LogName>;
  liveRewritten: Set<LiveFile>;
  decisionsRecorded: string[];
  /**
   * Protocol sections pulled into context this session. Session-scoped on
   * purpose: re-reading before every call would hand back the saving the
   * on-demand tier exists to make. requireProtocol checks it, and marks it,
   * because a refusal carries the body into the conversation either way.
   */
  protocolsRead: Set<ProtocolSection>;
}

export function newSideEffects(): ToolSideEffects {
  return {
    logsTouched: new Set(),
    liveRewritten: new Set(),
    decisionsRecorded: [],
    protocolsRead: new Set(),
  };
}

export interface ExecutorContext {
  paths: InstancePaths;
  research: ResearchConfig;
  effects: ToolSideEffects;
  /** Surface external work (web search, fetch) as activity. Memory operations
   *  never call it - they stay silent. */
  onNotice?: (msg: string) => void;
  /**
   * Arm a dispatch (dispatch_order). Supplied only when linked. Records the
   * order for the confirm interlock and shows the banner; it MUST NOT launch
   * anything. Returns a short confirmation (or refusal) for the tool result.
   */
  onArmDispatch?: (
    order: string,
    feature?: string,
  ) => Promise<
    { armed: true; summary: string } | { armed: false; reason: string }
  >;
  /** The feature levers. Supplied only when linked. */
  features?: FeatureManager;
  /**
   * Arm a resolver dispatch for the blocked merge-queue head. Confirm-gated
   * like onArmDispatch; launches nothing. Supplied only when linked.
   */
  onArmResolve?: () => Promise<
    { armed: true; summary: string } | { armed: false; reason: string }
  >;
  /** The persisted task table, shared with the captain's panel. Always wired
   *  in a real session; absent only in degraded/test executors. */
  tasks?: TaskStore;
}

const FEATURE_UNAVAILABLE =
  "Feature tools are not available: this instance is not linked to a repo. Run `co link` first.";

/**
 * Gate a tool on a protocol section, and SUPPLY the section rather than merely
 * demand it.
 *
 * The obvious gate - "call read_protocol first, then retry" - leaves the co
 * one forgotten call away from improvising, and improvising is the failure
 * that does not announce itself: an order that restates the repo, a PR body in
 * the wrong shape. Both read plausibly, both ship. So the refusal carries the
 * protocol with it: there is no path to acting without the contract in
 * context, because the only way to be refused is to be handed it. Marking the
 * section read here is correct, not a shortcut - the body lands in the
 * conversation through this very result, exactly as if read_protocol had.
 */
function requireProtocol(
  effects: ToolSideEffects,
  section: ProtocolSection,
  id: string,
  lead: string,
): ToolResult | null {
  if (effects.protocolsRead.has(section)) return null;
  effects.protocolsRead.add(section);
  return err(
    id,
    `${lead}\n\nNothing has been staged and nothing has changed. The contract` +
      ` follows in full - read it, then send this call again with the content` +
      ` rewritten to it. Do not simply resend what you had.\n\n` +
      protocolBody(section),
  );
}

function ok(id: string, obj: unknown): ToolResult {
  return {
    tool_use_id: id,
    content: typeof obj === "string" ? obj : JSON.stringify(obj),
  };
}
function err(id: string, msg: string): ToolResult {
  return { tool_use_id: id, content: msg, is_error: true };
}

const LOG_SET = new Set(["decisions", "progress", "research"]);

/** Build the tool executor bound to a specific instance + config. */
export function makeExecutor(ctx: ExecutorContext) {
  const { paths, research, effects } = ctx;

  return async function execute(block: ToolUseBlock): Promise<ToolResult> {
    const id = block.id;
    const input = (block.input ?? {}) as Record<string, unknown>;
    try {
      switch (block.name) {
        case "read_protocol": {
          const section = input.section;
          if (!isProtocolSection(section)) {
            return err(
              id,
              `unknown protocol section. Pick one of: ${protocolSectionsFor({
                dispatch: Boolean(ctx.onArmDispatch),
              }).join(", ")}.`,
            );
          }
          // Once a section is in the live window - read here, or handed over
          // by a gate refusal - a re-read returns a pointer, not a second
          // copy: the first copy is already re-sent on every round, and a
          // duplicate would be paid for the same way. Compaction clears the
          // ledger (see maybeCompact in session.ts), because a section
          // summarized out of the window must be re-readable for real.
          if (effects.protocolsRead.has(section)) {
            return ok(id, {
              section,
              note:
                "Already in your context: this section entered the conversation" +
                " earlier this session, as a read_protocol result or inside a" +
                " refusal that carried it. Use that copy - it has not changed.",
            });
          }
          effects.protocolsRead.add(section);
          return ok(id, { section, text: protocolBody(section) });
        }
        case "memory_write": {
          const kind = String(input.kind ?? "") as MemoryKind;
          if (!(MEMORY_KINDS as readonly string[]).includes(kind)) {
            return err(id, `unknown memory kind. Pick one of: ${MEMORY_KINDS.join(", ")}.`);
          }
          const log = KIND_TO_LOG[kind];
          const r = await appendLog(paths, log, String(input.entry ?? ""));
          effects.logsTouched.add(log);
          if (kind === "decision" && r.id) effects.decisionsRecorded.push(r.id);
          return ok(id, { saved: true, ...(r.id ? { id: r.id } : {}), file: r.file });
        }
        case "memory_search": {
          const command = String(input.command ?? "") as MemorySearchCommand;
          const log = String(input.log ?? "");
          if (!LOG_SET.has(log)) {
            return err(id, `unknown log. Pick one of: decisions, progress, research.`);
          }
          switch (command) {
            case "search_log": {
              const hits = await searchLog(paths, log as LogName, String(input.query ?? ""));
              return ok(id, { hits });
            }
            case "read_log_range": {
              const text = await readLogRange(
                paths,
                log as LogName,
                Number(input.start),
                Number(input.end),
              );
              return ok(id, { text });
            }
            default:
              return err(
                id,
                `unknown memory_search command. Use one of: ${MEMORY_SEARCH_COMMANDS.join(", ")}.`,
              );
          }
        }
        case "memory_rewrite": {
          const file = String(input.file ?? "") as MemoryRewriteFile;
          if (!(MEMORY_REWRITE_FILES as readonly string[]).includes(file)) {
            return err(
              id,
              `unknown live file. Pick one of: ${MEMORY_REWRITE_FILES.join(", ")}.`,
            );
          }
          const live = REWRITE_TO_LIVE[file];
          await rewriteLive(paths, live, String(input.content ?? ""));
          effects.liveRewritten.add(live);
          return ok(id, { rewritten: live });
        }
        case "doc": {
          const command = String(input.command ?? "") as DocCommand;
          const name = input.name === undefined ? "" : String(input.name);
          try {
            switch (command) {
              case "list":
                return ok(id, { docs: await listDocs(paths) });
              case "read":
                return ok(id, { name, content: await readDoc(paths, name) });
              case "create":
                return ok(
                  id,
                  await createDoc(paths, name, String(input.content ?? "")),
                );
              case "overwrite":
                return ok(
                  id,
                  await overwriteDoc(paths, name, String(input.content ?? "")),
                );
              case "str_replace":
                return ok(
                  id,
                  await strReplaceDoc(
                    paths,
                    name,
                    String(input.old_str ?? ""),
                    String(input.new_str ?? ""),
                  ),
                );
              case "delete":
                return ok(id, await deleteDoc(paths, name));
              default:
                return err(
                  id,
                  JSON.stringify({
                    error: "UNKNOWN_COMMAND",
                    message: `Unknown doc command "${command}". Use one of: ${DOC_COMMANDS.join(", ")}.`,
                  }),
                );
            }
          } catch (e) {
            if (e instanceof DocError) {
              return err(
                id,
                JSON.stringify({ error: e.code, message: e.message }),
              );
            }
            throw e;
          }
        }
        case "web_search": {
          const count = Number.isFinite(Number(input.count))
            ? Number(input.count)
            : 6;
          const options: SearchOptions = {};
          if (
            input.published_within_days !== undefined &&
            Number.isFinite(Number(input.published_within_days))
          ) {
            options.publishedWithinDays = Number(input.published_within_days);
          }
          if (input.fresh_content !== undefined)
            options.freshContent = Boolean(input.fresh_content);
          const res = await searchWeb(
            research,
            String(input.query ?? ""),
            count,
            options,
          );
          ctx.onNotice?.(`searched the web (${res.provider})`);
          return ok(id, res);
        }
        case "web_fetch": {
          const res = await fetchUrl(research, String(input.url ?? ""));
          ctx.onNotice?.(`fetched ${res.url}`);
          return ok(id, res);
        }
        case "task_table": {
          if (!ctx.tasks)
            return err(id, "The task table is unavailable in this session.");
          const tasks = ctx.tasks;
          const command = String(input.command ?? "") as TaskCommand;
          // Every table handed back - listing, post-write echo, refusal - uses
          // the SAME display order the panel paints, so the co and the captain
          // never describe the table to each other in two different orders.
          const table = () => taskDisplayOrder(tasks.list());
          try {
            switch (command) {
              case "list":
                return ok(id, { table: table() });
              case "add": {
                const added = await tasks.add(input.task);
                return ok(id, { added, table: table() });
              }
              case "status": {
                const row = await tasks.setStatus(input.task, input.status);
                return ok(id, { updated: row, table: table() });
              }
              case "rename": {
                const renamed = await tasks.rename(input.task, input.new_task);
                return ok(id, { renamed, table: table() });
              }
              case "retire": {
                const retired = await tasks.retire(input.task);
                return ok(id, { retired, table: table() });
              }
              default:
                return err(
                  id,
                  JSON.stringify({
                    error: "UNKNOWN_COMMAND",
                    message: `Unknown task_table command "${command}". Use one of: ${TASK_COMMANDS.join(", ")}.`,
                  }),
                );
            }
          } catch (e) {
            // A refusal is the point of this tool, not an exception: the co is
            // told exactly which row it named and what the table holds, so its
            // next call can be right rather than a guess.
            if (e instanceof TaskError) {
              return err(
                id,
                JSON.stringify({
                  error: e.code,
                  message: e.message,
                  table: table(),
                }),
              );
            }
            throw e;
          }
        }
        case "dispatch_order": {
          const order = String(input.order ?? "").trim();
          if (!order)
            return err(id, "dispatch_order requires a non-empty order.");
          if (!ctx.onArmDispatch) {
            return err(
              id,
              "Dispatch is not available: this instance is not linked to a repo. Run `co link` first, or write the order as plain text for the captain to copy.",
            );
          }
          // Before arming, so a refused call leaves nothing staged. The
          // refusal hands the checklist over - see requireProtocol.
          const gate = requireProtocol(
            effects,
            "orders",
            id,
            "This order was written without the orders protocol in front of you.",
          );
          if (gate) return gate;
          const feature =
            input.feature === undefined
              ? undefined
              : String(input.feature).trim() || undefined;
          const res = await ctx.onArmDispatch(order, feature);
          if (!res.armed) return err(id, res.reason);
          // Armed, not run. The model must stop and let the captain confirm.
          return ok(id, {
            armed: true,
            note:
              "Order armed and shown to the captain, awaiting a typed `confirm`. Do NOT say it has run. " +
              res.summary,
          });
        }
        case "feature_create": {
          if (!ctx.features) return err(id, FEATURE_UNAVAILABLE);
          const name = String(input.name ?? "").trim();
          if (!name)
            return err(id, "feature_create requires a non-empty name.");
          const intent =
            input.intent === undefined ? undefined : String(input.intent);
          const type =
            input.type === undefined ? undefined : String(input.type);
          const res = await ctx.features.create(name, intent, type);
          ctx.onNotice?.(
            res.created
              ? `provisioned worktree for feature ${res.feature.slug}`
              : `feature ${res.feature.slug} already provisioned`,
          );
          return ok(id, res);
        }
        case "feature_status": {
          if (!ctx.features) return err(id, FEATURE_UNAVAILABLE);
          const name = input.name === undefined ? "" : String(input.name).trim();
          if (!name) {
            return ok(id, {
              features: ctx.features.list(),
              queue: ctx.features.queueView(),
            });
          }
          const res = await ctx.features.status(name);
          if (!res) return ok(id, { found: false, feature: name });
          return ok(id, { found: true, ...res });
        }
        case "feature_enqueue": {
          if (!ctx.features) return err(id, FEATURE_UNAVAILABLE);
          const name = String(input.name ?? "").trim();
          if (!name)
            return err(id, "feature_enqueue requires a non-empty name.");
          // Each half of the PR message is an independent override: an omitted
          // field keeps what is stored, so a retry never wipes a message.
          const prTitle =
            input.prTitle === undefined ? undefined : String(input.prTitle);
          const prBody =
            input.prBody === undefined ? undefined : String(input.prBody);
          // The PR body is the durable output of the on-demand split: one
          // composed from memory reads plausibly, merges, and is quietly the
          // wrong shape. The refusal carries the template (requireProtocol).
          if (prBody !== undefined) {
            const gate = requireProtocol(
              effects,
              "pr-message",
              id,
              "This pull request body was written without the template in front of you.",
            );
            if (gate) return gate;
          }
          const res = await ctx.features.enqueue(name, {
            ...(prTitle === undefined ? {} : { prTitle }),
            ...(prBody === undefined ? {} : { prBody }),
          });
          if (res.enqueued)
            ctx.onNotice?.(`enqueued feature ${name} for landing`);
          return ok(id, res);
        }
        case "feature_resolve_head": {
          if (!ctx.features) return err(id, FEATURE_UNAVAILABLE);
          if (!ctx.onArmResolve) {
            return err(
              id,
              "Resolving the head needs the confirm-gated dispatch path, which is unavailable in this session (not linked, or non-interactive).",
            );
          }
          const res = await ctx.onArmResolve();
          if (!res.armed) return err(id, res.reason);
          // Armed, not run. Same interlock as dispatch_order.
          return ok(id, {
            armed: true,
            note:
              "Resolver armed and shown to the captain, awaiting a typed `confirm`. Do NOT say it has run. " +
              res.summary,
          });
        }
        case "feature_abandon": {
          if (!ctx.features) return err(id, FEATURE_UNAVAILABLE);
          const name = String(input.name ?? "").trim();
          if (!name)
            return err(id, "feature_abandon requires a non-empty name.");
          const res = await ctx.features.abandon(name);
          if (res.abandoned) ctx.onNotice?.(`abandoned feature ${name}`);
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
