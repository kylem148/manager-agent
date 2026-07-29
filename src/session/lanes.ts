/**
 * Agent LANES: what a crew agent is allowed to do to the worktree it runs in.
 *
 * A feature worktree used to allow exactly one crew agent, and a second dispatch
 * into a live one was refused outright (D-20260729-5 removed that cap). The
 * hazard the cap guarded is real but narrower than "one agent": a worktree has
 * ONE `.git/index`, one `index.lock`, one `dist/` and one `node_modules`. The
 * failure mode is invisible rather than loud — a second agent drops a scratch
 * file, a coverage dir or a build artifact in the tree, and then the FIRST agent
 * runs `git add -A && git commit` and sweeps it into a commit that looks
 * legitimate and is not. That is a hazard of two concurrent WRITERS. A strictly
 * read-only second agent does not have it, which is why the read-only lane is
 * the default a bare `confirm` grants and the writing lane is the opt-in
 * (`confirm write`).
 *
 * The motivating use is an auditor reading a feature worktree while the
 * implementer is still working in it, so the audit can see the uncommitted work
 * in progress. A detached-HEAD sibling worktree was considered and rejected for
 * exactly that reason: it cannot see uncommitted work.
 *
 * Two mechanisms enforce the read-only lane, and they are deliberately unequal:
 *
 *  - THE MANDATE (always). The blurb below is prepended to the order, so the
 *    agent is told in its own prompt that it must not write anything at all —
 *    not just that it must not commit.
 *  - THE FLAGS (where the agent's CLI has them). Claude Code takes
 *    `--disallowedTools`, so a read-only run launches with every write-capable
 *    tool denied. An agent with no such flag gets the mandate alone, and the arm
 *    banner says "advisory only" rather than claiming an enforcement that isn't
 *    there.
 */

/** Which lane a dispatch runs in. `writer` is the ordinary full-access run;
 *  `reader` is the gated audit lane that may not touch the tree. */
export type DispatchLane = "writer" | "reader";

/** One crew agent live in a feature's worktree, with the role it holds. Runtime
 *  state only: it is derived from the registry's in-memory jobs and a restart
 *  legitimately clears it (nothing is half-done by a lost lane record — the
 *  agent is in a pane the captain can see). */
export interface ActiveAgent {
  /** The dispatch job id (job-NNN). */
  jobId: string;
  lane: DispatchLane;
  /** The crew agent the job launched with, when it wasn't the config default. */
  agentName?: string;
}

/**
 * The read-only mandate, prepended verbatim to a reader's order.
 *
 * Written as sentences joined by a single space so the paragraph is readable in
 * source without any line break reaching the agent's prompt: the text is fixed
 * and every character of it is load-bearing, because it is the ONLY enforcement
 * an agent with no tool-permission flags gets.
 */
export const READ_ONLY_BLURB = [
  "READ-ONLY RUN.",
  "Another agent is working in this same worktree right now and its uncommitted changes are live on disk around you.",
  "You must not write ANYTHING to this tree: no file edits, no new files, no `git add`, no `git commit`, no `git stash`, no branch or index operations, no `npm install`, no build, and no test run that emits artifacts (coverage, snapshots, logs).",
  "Anything you drop on disk can be swept into the other agent's next commit without either of you seeing it.",
  "Read, search, and reason only.",
  "Report your findings as prose in your final message; that report is your entire output.",
].join(" ");

/**
 * The order text as the agent will actually receive it. A writer's order is
 * untouched; a reader's carries the mandate ahead of it.
 *
 * Applied at dispatch time so the job's stored order IS the launch prompt — the
 * transcript locator matches a run by its first user message (crewtranscript.ts),
 * so an order that differed from what was sent would stop resolving its own
 * record.
 */
export function applyLane(order: string, lane: DispatchLane): string {
  return lane === "reader" ? `${READ_ONLY_BLURB}\n\n${order}` : order;
}

/**
 * The tools a read-only run may not use. Everything here can put bytes on disk
 * or move the index, directly or through a shell:
 *
 *  - Write / Edit / MultiEdit / NotebookEdit — the file writers.
 *  - Bash — the big one. `git add`, `git commit`, `git stash`, `npm install`,
 *    a build, `rm`, a test run that drops coverage: all of it is one Bash call.
 *    Denying it costs an auditor `git log` and `rg`, and that is the right trade
 *    — Read, Grep and Glob still answer every question an audit actually asks.
 *  - Task — a subagent is another agent in the same tree, and a lane that can
 *    spawn one that writes is not a read-only lane.
 *
 * Every name here was checked against the shipped Claude Code CLI, which warns
 * ("matches no known tool") on a name it does not recognise; none of these warn.
 */
export const READ_ONLY_DENIED_TOOLS = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
  "Task",
] as const;

/**
 * The deny flag, in the `=` form and NOT the space-separated one.
 *
 * That is not a style choice. `--disallowedTools <tools...>` is variadic, so
 * `--disallowedTools Write,Edit <order>` swallows the order as another deny rule
 * and the agent then starts with no prompt at all (verified live against the
 * shipped CLI: `claude --disallowedTools Write,Edit mcp list` reports `mcp` and
 * `list` as deny rules that match no known tool). The `=` form binds exactly one
 * value and leaves the prompt argument alone.
 */
export const READ_ONLY_FLAG = `--disallowedTools=${READ_ONLY_DENIED_TOOLS.join(",")}`;

/** Whether a read-only run of this agent is mechanically enforced or only
 *  advisory, and the clause the arm banner states it with. Never guesses in the
 *  optimistic direction: an agent we cannot recognise is reported as advisory. */
export interface ReadOnlyEnforcement {
  enforced: boolean;
  /** One clause for the banner and the dispatch line. */
  detail: string;
}

/**
 * The program a crew command actually runs, past any env-var prefix. The stored
 * command is a shell string (dispatchconfig.ts), so `claude {prompt}` and
 * `CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude {prompt}` both have to answer
 * "claude". A quoted value containing a space defeats the whitespace split and
 * yields a token that matches nothing — which degrades to "advisory", the safe
 * direction.
 */
export function crewProgram(command: string): string {
  for (const token of command.trim().split(/\s+/)) {
    if (!token) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue; // VAR=value prefix
    if (token === "env") continue; // `env VAR=value claude ...`
    return token;
  }
  return "";
}

/**
 * Whether this agent's CLI takes tool-permission flags. This is the one place
 * that is deliberately Claude-Code-aware, the same corner crewtranscript.ts
 * already occupies: the transport stays agent-agnostic, and an agent we don't
 * recognise simply runs the read-only lane on the mandate alone.
 */
export function supportsToolPermissionFlags(command: string): boolean {
  const program = crewProgram(command).replace(/["']/g, "");
  const base = program.split("/").pop() ?? "";
  return base === "claude";
}

/** How a read-only run of `command` would be enforced. */
export function readOnlyEnforcement(command: string): ReadOnlyEnforcement {
  if (supportsToolPermissionFlags(command)) {
    return {
      enforced: true,
      detail: `mechanically enforced — launched with ${READ_ONLY_FLAG}`,
    };
  }
  return {
    enforced: false,
    detail:
      "ADVISORY ONLY — this agent takes no tool-permission flags, so the read-only mandate is in the order and nothing mechanically blocks a write",
  };
}

/**
 * The command template a read-only run launches with: the deny flag inserted
 * immediately before the {prompt} placeholder, so it lands as a flag on the
 * agent rather than after its positional prompt. A template with no {prompt} (a
 * hand-edited config) gets the flag appended. Returns the template unchanged for
 * an agent that takes no such flag — the caller has already decided the lane is
 * advisory there.
 */
export function withReadOnlyFlags(command: string): string {
  if (!supportsToolPermissionFlags(command)) return command;
  if (command.includes("{prompt}")) return command.replace("{prompt}", `${READ_ONLY_FLAG} {prompt}`);
  return `${command} ${READ_ONLY_FLAG}`.trim();
}
