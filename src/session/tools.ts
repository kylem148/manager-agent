import type { Tool, ToolUseBlock, ToolResult } from "../model.js";
import { LOG_NAMES, type InstancePaths, type LiveFile, type LogName } from "../paths.js";
import type { ResearchConfig } from "../config.js";
import {
  appendLog,
  rewriteLive,
  searchLog,
  readLogRange,
  readLiveMemory,
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
import {
  isReviewLevel,
  isReviewVerdict,
  REVIEW_LEVELS,
  REVIEW_VERDICTS,
  type FileReviewInput,
  type FileReviewResult,
} from "./reviewinbox.js";
import { TaskError, TASK_STATUSES, TASK_TABLE_CAP, type TaskStore } from "./taskstore.js";
import { taskDisplayOrder } from "../taskorder.js";

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

export const LOG_ENUM: LogName[] = LOG_NAMES;

export const DOC_COMMANDS = [
  "create",
  "read",
  "str_replace",
  "overwrite",
  "delete",
  "list",
] as const;
export type DocCommand = (typeof DOC_COMMANDS)[number];

export const TASK_COMMANDS = ["add", "status", "rename", "retire", "list"] as const;
export type TaskCommand = (typeof TASK_COMMANDS)[number];

/**
 * Tool activity the REPL may surface to the user: external work only. Memory
 * reads and writes are the co-manager's private bookkeeping and never announce
 * themselves, so they are deliberately absent here. `dispatch_order` surfaces its
 * own pending-confirm banner through the arm callback, so it is not listed here.
 */
export const SURFACED_TOOLS = new Set<string>(["search_web", "fetch_url"]);

export function toolDefinitions(opts: { dispatch?: boolean } = {}): Tool[] {
  const tools: Tool[] = [
    {
      name: "read_live_memory",
      description:
        "Re-read the live-state files (projectbrief, activeContext). They are already provided at session start; call this only to refresh after a rewrite. For documents under docs/, use the doc tool instead.",
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
      name: "doc",
      description:
        "Manage the user-facing markdown documents under docs/ (architecture.md, plan.md, and any other doc a workflow calls for). One tool, dispatching on `command`.\n\n" +
        "Commands:\n" +
        "- list — every doc in docs/. Takes no other parameter.\n" +
        "- read — return one doc's full text. Read before editing.\n" +
        "- create — write a new doc. Fails if it already exists.\n" +
        "- str_replace — replace `old_str` with `new_str`. `old_str` must match EXACTLY ONCE, whitespace included; if it is ambiguous or absent you get an error rather than a guess, so include enough surrounding context to make it unique. Prefer this for targeted edits: only the diff is generated.\n" +
        "- overwrite — replace a doc's entire content. Use for full rewrites and restructures, not for small edits.\n" +
        "- delete — remove an existing doc.\n\n" +
        "Scope: flat .md files inside THIS instance's docs/ only. It does NOT touch the .memory/ substrate (projectbrief, activeContext, the logs — those have their own tools), .env, or anything outside docs/. No subdirectories.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", enum: [...DOC_COMMANDS] },
          name: {
            type: "string",
            description:
              "The doc filename, e.g. \"plan.md\". Bare markdown filename, no directories. Omit for list.",
          },
          content: { type: "string", description: "Full document text, for create and overwrite." },
          old_str: {
            type: "string",
            description: "For str_replace: the exact text to replace. Must appear exactly once.",
          },
          new_str: {
            type: "string",
            description: "For str_replace: the replacement text. Omit or pass \"\" to delete the matched text.",
          },
        },
        required: ["command"],
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
    {
      name: "file_review",
      description:
        "File the structured record of a crew-completion review into the review inbox. Call this EVERY time you review a finished run, once per run, as the review itself — the record is the review, not a copy of it.\n\n" +
        "The `level` decides how loudly the review lands in the captain's chat, so choose it deliberately:\n" +
        "- L1 — a `rework` verdict, or a genuine escalation/fork only the captain can resolve. Filing prints NOTHING; after filing, state ONLY the core decision the captain must make, in a line or two. Never dump the body into the chat.\n" +
        "- L2 — a `fix-commit` verdict, or an `accept` that still carries notes worth having. Filing prints exactly one dim pointer line; say nothing further about the review.\n" +
        "- L3 — a clean `accept` with nothing to flag. Filing is completely silent; say nothing about it at all.\n\n" +
        "`headline` is the one-line summary the inbox list shows (aim for well under 80 characters). `body` is the FULL review — what went right, what went wrong, escalations, the verdict — and is never printed to the chat; the captain reads it in the panel (Ctrl-O, Inbox tab), which keeps the last 20 reviews across restarts.",
      input_schema: {
        type: "object",
        properties: {
          level: {
            type: "string",
            enum: [...REVIEW_LEVELS],
            description:
              "How loudly this lands: L1 (rework or a real escalation, you then state the core decision), L2 (fix-commit or accept-with-notes, one dim line), L3 (clean accept, silent).",
          },
          verdict: {
            type: "string",
            enum: [...REVIEW_VERDICTS],
            description: "The review verdict.",
          },
          headline: {
            type: "string",
            description: "One line summarising the outcome, shown in the inbox list.",
          },
          body: {
            type: "string",
            description:
              "The full review text: what went right, what went wrong, escalations, verdict. Stored, never printed to the chat.",
          },
          job_id: {
            type: "string",
            description:
              "Optional. The crew job this reviews (e.g. \"job-002\"). Defaults to the run you were just handed; use \"manual\" for a report the captain relayed by hand.",
          },
          feature: {
            type: "string",
            description: "Optional. The feature the run was scoped to, if any.",
          },
        },
        required: ["level", "verdict", "headline", "body"],
        additionalProperties: false,
      },
    },
    {
      name: "task_table",
      description:
        "Read and edit the captain's at-a-glance task table, one row at a time. One tool, dispatching on `command`. The table is persisted and PAINTED by the panel (Ctrl-O, Home tab), and the captain edits it there himself — it is his surface, and you are the second writer on it.\n\n" +
        "Commands:\n" +
        "- list — the current table. Takes no other parameter. Call it before editing if you are unsure what is there.\n" +
        "- add — append `task` as a new row, always `queued`. A task is one short line of text and has no body.\n" +
        "- status — move the row named by `task` to `building` or `queued`. Work that has actually started is `building`.\n" +
        "- rename — rewrite the TEXT of the row named by `task` to `new_task`, keeping its status and its place. For a typo or a reworded task; it is not retire-and-add, which would lose both. Fails if `new_task` is empty or would read the same as a different row. Renaming a row to the text it already has is a successful no-op.\n" +
        "- retire — take the row named by `task` OUT of the table. This is what `done` means here: retiring appends it to a kept `done` list and shrinks the table. There is no third status.\n\n" +
        "A row is addressed BY ITS EXACT TASK TEXT, never by position — the captain edits the same table between your turns, so a position you read last turn may be a different row now. Text matching no row, or more than one, is an ERROR rather than a guess; `list` first and copy the text.\n\n" +
        "The table comes back in the order it is DISPLAYED in — every `building` row first, then every `queued` one, each keeping the order it was stored in. That is what the captain's panel paints, so you and he are reading the same table. It is a display order only: it never says which row was added first, and nothing you can call reorders the stored table.\n\n" +
        "You cannot replace, clear or reorder the table, and no call can touch a row it did not name. That is deliberate: a whole-table write would silently delete rows the captain had just typed.\n\n" +
        `The DEFAULT IS NOT TO ADD A ROW. A row belongs here only when the captain asks for one, or when the item is plainly a major future workstream. Intermediate and mechanical steps never belong in the table, however real they are. ${TASK_TABLE_CAP} rows maximum (an add beyond that FAILS — nothing is evicted for you), and usually far fewer. Never assume a row you did not add is stale: if you did not put it there, the captain did.`,
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", enum: [...TASK_COMMANDS] },
          task: {
            type: "string",
            description:
              "For add: the new row's text, one short line. For status, rename and retire: the EXACT text of the row to act on, as `list` returns it.",
          },
          new_task: {
            type: "string",
            description:
              "For rename only: the row's new text, one short line. It may not be empty, and it may not read the same as a different row on the table.",
          },
          status: {
            type: "string",
            enum: [...TASK_STATUSES],
            description:
              "For status: `building` if it is being worked right now, `queued` if it is waiting its turn. There is no third value — finishing something is `retire`.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  ];

  // The dispatch + feature tools are only exposed when the instance has been
  // linked to a repo (co link). dispatch_order ARMS a dispatch — it never runs
  // anything; the launch happens only after the captain types `confirm` in the
  // session loop, which is the structural interlock. The feature levers drive
  // the parallel-worktree flow: create a feature's isolated worktree, target a
  // dispatch at it, and land it through the Ctrl-O review gate.
  if (opts.dispatch) {
    tools.push({
      name: "dispatch_order",
      description:
        "Arm a direct dispatch of an implementation-ready order to the crew (the registered coding agent). This does NOT run anything: it stages the order and shows the captain the exact order text plus the resolved command and target, and waits. The dispatch fires only if the captain then types `confirm`; any other input cancels it. Use this instead of writing plain-text orders when the captain wants the order run directly. Draft the full order (same checklist as a written order: read-docs-first, goal, context, decisions, constraints, acceptance, verification, close-the-report, commit) as the `order` argument. Optionally scope it to a feature with `feature`: the crew then runs inside that feature's isolated worktree (provisioned on first use) instead of the bare main tree. Arm at most one order per turn.\n\n" +
        "TARGETING A WORKTREE THAT ALREADY HAS A LIVE AGENT is allowed and is LANE-GATED, not refused. The arm banner then names the live agent and offers the captain two verbs: a bare `confirm` grants a READ-ONLY lane (the order is prefixed with a mandate forbidding every write to the tree — no edits, no new files, no `git add`/`commit`/`stash`, no install, no build, no artifact-emitting test run — and the agent's write-capable tools are denied at launch where its CLI supports that), while `confirm write` grants a second WRITING lane, with both agents writing one git index and one build dir. The captain picks; you do not. So write the order for the lane you expect: an audit order asks for findings, and if the work genuinely needs to write, say so and let them choose. A read-only run's result comes back to you as CONTEXT to answer with — no review is filed for it.",
      input_schema: {
        type: "object",
        properties: {
          order: {
            type: "string",
            description:
              "The complete, implementation-ready order text to hand to the coding agent as its prompt.",
          },
          feature: {
            type: "string",
            description:
              "Optional. Scope this dispatch to a feature: the crew runs in that feature's isolated worktree on its own `<type>/<slug>` branch, provisioned on first use. Use the same feature name you created (or will create) with feature_create. Omit to run on the bare main tree.",
          },
        },
        required: ["order"],
        additionalProperties: false,
      },
    });
    tools.push({
      name: "feature_create",
      description:
        "Provision an isolated worktree for a feature: a fresh `<type>/<slug>` branch (e.g. `feat/user-auth`, `fix/stale-token`) cut from `origin/dev`, with its own checkout, so crew can work it in parallel with other features and never touch the main tree. Runs directly (no confirm gate) — it writes nothing to `dev` or `main`, only creates the feature's own branch and checkout. Requires the repo to have an `origin` remote with a `dev` branch (features integrate by pull request); it reports cleanly if that is missing rather than creating anything. Idempotent: creating an existing feature returns its worktree on the branch it already has. After creating, dispatch orders into it by passing the same name as `dispatch_order`'s `feature`, then land it with feature_land.",
      input_schema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The feature name (a human handle, e.g. \"user auth\"). Slugged for the branch.",
          },
          type: {
            type: "string",
            enum: [...FEATURE_BRANCH_TYPES],
            description:
              "Optional Conventional Commits type for the branch prefix, chosen to fit the work (feat for new capability, fix for a bug, refactor, docs, chore, test, perf, build, ci, style). Defaults to feat.",
          },
          intent: {
            type: "string",
            description:
              "One line saying what the feature is for. Optional, but give it every time: it is stored with the feature (surviving a restart), echoed back by feature_status/feature_list, and shown as the feature's description beside its branch in the captain's Ctrl-O Home tab — where the branch name says what KIND of work it is and this is the only thing that says what the work actually is.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    });
    tools.push({
      name: "feature_land",
      description:
        "Land a finished feature into `dev` through a GitHub pull request: fetch, rebase its branch onto the current `origin/dev` tip, push the branch, open (or reuse) its PR into `dev`, read that PR's own GitHub CI checks, and open the Ctrl-O review gate showing the PR and the result. co runs NO build or test of its own — GitHub's checks on the PR are the gate. The gate IS the confirmation — the merge (`gh pr merge --merge`, a merge commit) happens ONLY if the captain presses [m] over a green result; a rebase conflict, a red check, or checks that have not reported yet are shown but not mergeable. A PR with no checks at all is still mergeable but UNGATED (nothing verified it) — say so rather than calling it green. On a merge the feature's worktree is torn down and its branch ref kept. `dev` is never written locally. Needs an interactive terminal (the gate); reports cleanly if there is none, if a crew agent is still working the feature, or if a prerequisite is missing (no gh, not authenticated, no `origin/dev`).",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The feature to land (name or slug)." },
        },
        required: ["name"],
        additionalProperties: false,
      },
    });
    tools.push({
      name: "feature_enqueue",
      description:
        "Mark a feature done and add it to the serial merge queue, and WRITE ITS PULL REQUEST MESSAGE. This is how a finished feature gets in line to land in `dev`, as a GitHub pull request. There is NO confirm gate on enqueue — call it as soon as the captain says a feature is done. You know what this feature is for and what the crew built, so you are the one who writes its PR: pass `prTitle` and `prBody` describing what the PR accomplishes and why. Omit them only when the mechanical fallback (the commit subject, or `<type>: <feature>`) genuinely says enough. Features land ONE AT A TIME in queue order: only the head is processed (fetched, rebased onto the current `origin/dev` tip, pushed, PR'd into `dev`, and gated on that PR's own GitHub CI checks — co runs no build or test itself), and only the head can merge. When the enqueued feature becomes the head it is processed immediately, so the result tells you whether the head is `ready` (its checks passed — or its PR reports no checks at all, in which case `ungated` is set and NOTHING verified it: report it as a human-judgment merge, not a green), `awaiting-checks` (CI is still running; this is a WAIT, not a failure — nothing is needed from you, and re-calling feature_enqueue re-reads them), `blocked` (a rebase conflict, a red CI check, or a missing prerequisite such as gh not being installed/authenticated — the result's `blockedKind` says which of the first two; it holds the queue until resolved or removed), `resolving` (a fresh crew agent is fixing it in its worktree), or still `queued`. A `ready` head needs NOTHING from you: its pull request, commits, checks result and a live [m] are already showing in the captain's Ctrl-O queue tab, and they merge that PR with the keystroke whenever they choose (they may edit the PR on GitHub first). Say it is ready, hand over the PR link if you have it, and move on — never call a tool to merge it and never wait for the keypress. On a blocked head you can dispatch a fresh resolver agent with feature_resolve_head, re-call feature_enqueue to retry after a manual fix, or feature_abandon it. Idempotent: enqueuing an already-queued feature keeps its position, and a re-enqueue with no prTitle/prBody keeps the message you already wrote — so you only pass them again to CHANGE the message.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The feature to enqueue (name or slug). Must already be created." },
          prTitle: {
            type: "string",
            description:
              "The pull request's title: one concise imperative line saying what this PR does (e.g. \"Add passkey login to the web app\"), specific enough to stand alone as the permanent history entry — never \"Fix bug\", \"Update .gitignore\", or \"Changes per feedback\". Write it as a developer would — no bot voice, no attribution, nothing about how the work was produced. Omitted, the title falls back to the branch's commit subject.",
          },
          prBody: {
            type: "string",
            description:
              "The pull request's description, written to the five-section template the dispatch protocol specifies (`## What`, `## Why`, `## How`, `## Testing`, `## Other Notes`, dropping any section you would leave empty): What and Why carry what the PR accomplishes and why, How carries the approaches tried and abandoned, Testing records ONLY the local verification the crew actually ran and its results, never a to-do list for the reader. Every section is a short bullet list and never a paragraph — three bullets typically, five at most, each one short sentence on one line. Never name who did the work (no attribution, no co-provenance, no first person), and never a commit list or a checks summary (co appends those itself). Omitted, the description falls back to a one-line mechanical summary.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    });
    tools.push({
      name: "feature_merge_head",
      description:
        "DO NOT reach for this to merge a ready head — merging is not yours to do. When the queue head is `ready`, the captain's Ctrl-O queue tab is already showing its pull request and checks result with a live [m], and pressing it merges that PR on GitHub, tears down its worktree, advances the queue and processes the next head, none of which involves you. In an interactive session this tool merges NOTHING: it returns the head's current state immediately and tells you the [m] is live. It exists only as a fallback for a session with no panel at all (piped/non-TTY), where there is no key to press and a ready head is merged directly. Use feature_list/feature_status to report queue state instead. Never say a feature landed because you called this, and never wait on the captain's keystroke — you are not in that loop.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    });
    tools.push({
      name: "feature_resolve_head",
      description:
        "Dispatch a FRESH crew agent to unblock the current merge-queue HEAD when it is `blocked` by a rebase conflict or a red CI check on its pull request. The agent runs in the FEATURE'S OWN isolated worktree, on its own feature branch (never `dev`): it fetches, rebases onto the current `origin/dev` tip, resolves the conflict, fixes whatever the failing checks reported (the order names them and links their runs), and commits — it does NOT push, open a PR, or merge. Like every dispatch this is CONFIRM-GATED: it ARMS the resolver order (shown to the captain with the target worktree) and fires only when the captain types `confirm`; it launches nothing on its own. While the agent works, the head is `resolving`; when it finishes the head is automatically re-processed (rebase + push + a fresh read of the PR's checks) and becomes `ready` if green or `blocked`/`awaiting-checks` if not. Bounded to a few attempts per head; after the limit the head stays blocked for the captain to resolve by hand or abandon. Use this on a blocked head instead of resolving conflicts yourself.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    });
    tools.push({
      name: "feature_list",
      description:
        "List every tracked feature: its branch, worktree path, provision status, which crew agents are live in it and in which lane (`agents` gives each one's job id and role, `writerActive` says whether one of them is a WRITER), its dispatched jobs, and — for enqueued features — its merge-queue position and head state (queued / head-processing / awaiting-checks / ready / blocked / resolving). Also returns the full merge queue in landing order. Use to see what is in flight across the parallel-worktree flow. Only a WRITER blocks enqueuing, landing and abandoning; a worktree with only read-only auditors in it lands normally.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    });
    tools.push({
      name: "feature_status",
      description:
        "Show one feature's full picture: branch, worktree path, provision status, whether its worktree has uncommitted changes, which crew agents are live in it and in which lane (`agents` gives each one's job id and role; `writerActive` says whether one of them is a WRITER, which is the only thing that blocks landing), its jobs, and — if it is enqueued — its merge-queue position and head state (queued / head-processing / awaiting-checks / ready / blocked / resolving), including whether a block is a conflict or a red CI check, and whether a ready head is ungated (its PR reports no checks at all). Returns not-found if nothing is tracked under that name or slug.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The feature to inspect (name or slug)." },
        },
        required: ["name"],
        additionalProperties: false,
      },
    });
    tools.push({
      name: "feature_abandon",
      description:
        "Tear down a feature's worktree WITHOUT landing it: remove the checkout and delete its branch only if it is already contained in `origin/dev`. Refuses (reports, never forces) a worktree that still has a live WRITING crew agent in it, and one with uncommitted changes — discarding unsaved work is the captain's call. A read-only auditor in the worktree does not refuse it. Committed-but-unmerged work is preserved: the branch is kept and the reason reported. Use to drop an abandoned or superseded feature.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The feature to abandon (name or slug)." },
        },
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
  /**
   * Arm a dispatch (dispatch_order tool). The REPL supplies this only when the
   * instance is linked. It records the order (and optional feature target) for
   * the confirm interlock and puts the TUI into the pending-confirm state; it
   * MUST NOT launch anything. Returns a short human-readable confirmation of what
   * was armed (or an error string if arming is impossible), which becomes the
   * tool result the model sees.
   */
  onArmDispatch?: (
    order: string,
    feature?: string,
  ) => Promise<{ armed: true; summary: string } | { armed: false; reason: string }>;
  /**
   * The feature levers (feature_create/land/list/status/abandon). Supplied only
   * when the instance is linked. Absent means the tools report dispatch is
   * unavailable, exactly like onArmDispatch.
   */
  features?: FeatureManager;
  /**
   * Arm a fresh-agent resolver dispatch for the blocked merge-queue head
   * (feature_resolve_head tool). Like onArmDispatch it ARMS a confirm-gated,
   * feature-scoped dispatch and launches nothing; the REPL supplies it only when
   * linked. Returns a short confirmation of what was armed, or a refusal (no
   * resolvable head, retry bound spent). Marking the head "resolving" happens at
   * fire time, not here, so a cancelled arm burns no attempt.
   */
  onArmResolve?: () => Promise<{ armed: true; summary: string } | { armed: false; reason: string }>;
  /**
   * File a structured review into the rolling inbox (file_review tool). The REPL
   * supplies this; it persists the record and owns the level-gated chat output
   * (one dim line for L2, nothing for L1/L3 — see reviewinbox.ts). Returns what
   * the model is told next, which is mostly "and now say nothing more".
   */
  onFileReview?: (input: FileReviewInput) => Promise<FileReviewResult>;
  /**
   * The persisted at-a-glance task table (task_table tool), painted and EDITED
   * by the panel's Home tab. Always wired in a real session — the table needs no
   * repo — so its absence only means a degraded/test executor, where the tool
   * reports the table is unavailable rather than throwing. The same store object
   * backs the captain's keystrokes, which is what makes the two writers one
   * table rather than two copies of one.
   */
  tasks?: TaskStore;
}

const FEATURE_UNAVAILABLE =
  "Feature tools are not available: this instance is not linked to a repo. Run `co link` first.";

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
                return ok(id, await createDoc(paths, name, String(input.content ?? "")));
              case "overwrite":
                return ok(id, await overwriteDoc(paths, name, String(input.content ?? "")));
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
              return err(id, JSON.stringify({ error: e.code, message: e.message }));
            }
            throw e;
          }
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
        case "file_review": {
          if (!ctx.onFileReview) {
            return err(id, "The review inbox is unavailable in this session.");
          }
          const level = input.level;
          if (!isReviewLevel(level)) {
            return err(id, `file_review needs a level of ${REVIEW_LEVELS.join(", ")}.`);
          }
          const verdict = input.verdict;
          if (!isReviewVerdict(verdict)) {
            return err(id, `file_review needs a verdict of ${REVIEW_VERDICTS.join(", ")}.`);
          }
          const headline = String(input.headline ?? "").trim();
          if (!headline) return err(id, "file_review requires a non-empty headline.");
          const body = String(input.body ?? "").trim();
          if (!body) return err(id, "file_review requires a non-empty body (the full review).");
          const jobId = input.job_id === undefined ? undefined : String(input.job_id).trim() || undefined;
          const feature = input.feature === undefined ? undefined : String(input.feature).trim() || undefined;
          const res = await ctx.onFileReview({
            level,
            verdict,
            headline,
            body,
            ...(jobId ? { jobId } : {}),
            ...(feature ? { feature } : {}),
          });
          return ok(id, res);
        }
        case "task_table": {
          if (!ctx.tasks) return err(id, "The task table is unavailable in this session.");
          const tasks = ctx.tasks;
          const command = String(input.command ?? "") as TaskCommand;
          // Every `table` this tool hands back — the listing, the echo after a
          // write, and the one carried by a refusal — goes through the SAME
          // display order the panel paints, so the co and the captain never
          // describe the table to each other in two different orders.
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
            // told exactly which row it named and what the table actually holds,
            // so its next call can be right rather than a guess.
            if (e instanceof TaskError) {
              return err(id, JSON.stringify({ error: e.code, message: e.message, table: table() }));
            }
            throw e;
          }
        }
        case "dispatch_order": {
          const order = String(input.order ?? "").trim();
          if (!order) return err(id, "dispatch_order requires a non-empty order.");
          if (!ctx.onArmDispatch) {
            return err(
              id,
              "Dispatch is not available: this instance is not linked to a repo. Run `co link` first, or write the order as plain text for the captain to copy.",
            );
          }
          const feature = input.feature === undefined ? undefined : String(input.feature).trim() || undefined;
          const res = await ctx.onArmDispatch(order, feature);
          if (!res.armed) return err(id, res.reason);
          // Armed, not run. The model must now stop and let the captain confirm;
          // it must NOT claim the order ran.
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
          if (!name) return err(id, "feature_create requires a non-empty name.");
          const intent = input.intent === undefined ? undefined : String(input.intent);
          const type = input.type === undefined ? undefined : String(input.type);
          const res = await ctx.features.create(name, intent, type);
          ctx.onNotice?.(
            res.created ? `provisioned worktree for feature ${res.feature.slug}` : `feature ${res.feature.slug} already provisioned`,
          );
          return ok(id, res);
        }
        case "feature_land": {
          if (!ctx.features) return err(id, FEATURE_UNAVAILABLE);
          const name = String(input.name ?? "").trim();
          if (!name) return err(id, "feature_land requires a non-empty name.");
          const res = await ctx.features.land(name);
          return ok(id, res);
        }
        case "feature_enqueue": {
          if (!ctx.features) return err(id, FEATURE_UNAVAILABLE);
          const name = String(input.name ?? "").trim();
          if (!name) return err(id, "feature_enqueue requires a non-empty name.");
          // Each half of the PR message is an independent override: an omitted
          // field leaves whatever this feature already has stored, so a retry
          // enqueue never wipes a message the co wrote earlier.
          const prTitle = input.prTitle === undefined ? undefined : String(input.prTitle);
          const prBody = input.prBody === undefined ? undefined : String(input.prBody);
          const res = await ctx.features.enqueue(name, {
            ...(prTitle === undefined ? {} : { prTitle }),
            ...(prBody === undefined ? {} : { prBody }),
          });
          if (res.enqueued) ctx.onNotice?.(`enqueued feature ${name} for landing`);
          return ok(id, res);
        }
        case "feature_merge_head": {
          if (!ctx.features) return err(id, FEATURE_UNAVAILABLE);
          // Non-blocking by construction: in an interactive session this reports
          // state and merges nothing (the panel's [m] owns the merge); with no
          // panel it merges directly and returns. Either way it never waits on a
          // human, so the co's turn is never held open (D-20260724-12).
          const res = await ctx.features.mergeHead();
          if (res.merged) ctx.onNotice?.(`merged ${res.feature} onto ${res.target}`);
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
          // Armed, not run. Same interlock as dispatch_order: the model must stop
          // and let the captain confirm; it must NOT claim the resolver ran.
          return ok(id, {
            armed: true,
            note:
              "Resolver armed and shown to the captain, awaiting a typed `confirm`. Do NOT say it has run. " +
              res.summary,
          });
        }
        case "feature_list": {
          if (!ctx.features) return err(id, FEATURE_UNAVAILABLE);
          return ok(id, { features: ctx.features.list(), queue: ctx.features.queueView() });
        }
        case "feature_status": {
          if (!ctx.features) return err(id, FEATURE_UNAVAILABLE);
          const name = String(input.name ?? "").trim();
          if (!name) return err(id, "feature_status requires a non-empty name.");
          const res = await ctx.features.status(name);
          if (!res) return ok(id, { found: false, feature: name });
          return ok(id, { found: true, ...res });
        }
        case "feature_abandon": {
          if (!ctx.features) return err(id, FEATURE_UNAVAILABLE);
          const name = String(input.name ?? "").trim();
          if (!name) return err(id, "feature_abandon requires a non-empty name.");
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
