/**
 * Layer 4: the on-demand protocol reference, read at the moment of acting
 * rather than carried on every turn.
 *
 * The system prompt is the cache prefix, re-sent on every round of every turn,
 * so a section sitting in it is paid for tens of times a session whether or
 * not the session ever does the thing it describes. A section here starts
 * costing only from the turn it is needed, and in most sessions that turn
 * never arrives. Once read it lands in history and is re-sent like anything
 * else; the win is WHEN the meter starts, not whether it runs.
 *
 * Two consequences, both load-bearing:
 *
 *  - Only genuinely occasional material belongs here. Anything the co needs
 *    every turn (identity, thinking discipline, the behavioural rules) stays
 *    in the system prompt, where being paid for every round is correct.
 *  - The co has to KNOW to read a section. Triggers live in the system prompt
 *    sections and the read_protocol tool description, but a trigger is a hope:
 *    where acting uninformed produces something durable - an order that runs,
 *    a PR body that merges - the acting tool REFUSES the call and hands the
 *    section over in the refusal (requireProtocol in tools.ts). There is then
 *    no path to acting without the contract in context; the trigger's
 *    remaining job is to save the co writing the thing twice.
 *
 * Every section carries a byte cap (PROTOCOL_BUDGETS), enforced by test. The
 * worst case in context at once is orders + features, 7,500 bytes.
 */

export const PROTOCOL_SECTIONS = [
  "orders",
  "features",
  "memory",
  "lanes",
  "pr-message",
  "docs",
] as const;
export type ProtocolSection = (typeof PROTOCOL_SECTIONS)[number];

/** Byte ceilings per section, enforced by test. */
export const PROTOCOL_BUDGETS: Record<ProtocolSection, number> = {
  orders: 4_000,
  features: 3_500,
  memory: 2_000,
  lanes: 1_500,
  "pr-message": 1_500,
  docs: 1_500,
};

/**
 * Sections that exist only on a linked instance. `orders` is deliberately NOT
 * among them: an unlinked co still writes orders as plain text the captain
 * carries, and `memory` and `docs` describe substrate every instance has.
 */
const LINKED_ONLY = new Set<ProtocolSection>(["features", "lanes", "pr-message"]);

/** The sections reachable on this instance. */
export function protocolSectionsFor(opts: { dispatch?: boolean } = {}): ProtocolSection[] {
  return PROTOCOL_SECTIONS.filter((s) => opts.dispatch || !LINKED_ONLY.has(s));
}

const PROTOCOLS: Record<ProtocolSection, string> = {
  orders: `### Orders protocol

An order is an implementation-ready prompt for a coding agent, the same
content whether the captain carries it or you dispatch it. Write it short and
trust the crew: the agent is capable and can read the repo; you cannot.
Hard limit: 40 lines and 350 words per order.

- Do NOT restate the repo: no file inventories, no "the codebase currently
  does X" where X is visible from the code. Point at the area; the agent
  looks.
- Do NOT prescribe implementation. Outcome and constraints; the agent decides
  how.
- Do NOT pad: no preamble, no restating the goal twice, no closing summary.
- Inline ONLY what the crew cannot get from the repo: the why, the captain's
  intent, decision ids, constraints from your head.

Cover, briefly:
- Read the docs first: open every order by telling the crew to read the
  relevant project docs before changing anything.
- Goal: one or two sentences on the outcome.
- Context: the why, and only what is not in the repo.
- Relevant decisions: ids and gist.
- Constraints, and what not to change.
- Files or areas likely involved: only if the captain gave you this.
- Acceptance criteria: how "done" is judged.
- Verification: what to run or check, plus an instruction never to hide
  mistakes - report failures, checks that could not run, and uncertainty
  plainly, and never claim a check that was not run.
- Close the report: the contract below.
- Commit: end with a commit instruction conditioned on success: "If it builds
  and tests clean, commit with: <message>". You write <message>, in
  Conventional Commits form: \`type(scope): concise imperative subject\`
  (feat, fix, refactor, docs, test, chore, style, perf, build, ci; subject
  ~50 chars, imperative, lowercase, no trailing period; mark breaking with
  \`!\` or a BREAKING CHANGE footer). One logical change per commit. Tell the
  crew to use EXACTLY the message you give and add nothing to it: no
  Co-Authored-By, no "Generated with", no attribution trailer of any kind -
  the history reads as the captain's own work. Say it in the order, every
  time.

### The report contract

You never see the diff; the crew's closing report is your only evidence, and
the pull request you write rests on it. Ask every order to close with exactly
three things and nothing else:

1. The diffstat: files changed, insertions, deletions.
2. The verification it actually ran, with the real output - not a description
   of the output, and not a claim that it passed.
3. The approaches it tried and abandoned, with the reason each was dropped.

Hard limit: 50 lines for the whole report. Diffstat as-is; verification
trimmed to its summary lines with any failure text verbatim; abandoned
approaches one line each. Tell the crew to end the report by stating its own
line count. Nothing truncates the report; its length is decided entirely by
what you asked for.`,

  features: `### Features (parallel worktrees)

One feature = one worktree on its own \`<type>/<slug>\` branch cut from
\`origin/dev\`. Features integrate into \`dev\` by GitHub pull request: you never
merge locally, \`dev\` is never written on this machine, and the dev -> main
promotion is the captain's. A dispatch naming no feature runs on the bare
main tree.

Default to a feature for any non-trivial change; when unsure, choose the
feature and the PR. A bare main-tree dispatch is for read-only audits or a
single trivial change.

- \`feature_create(name, type, intent)\`: provision the worktree. No confirm
  gate (it writes nothing to dev or main), idempotent. \`type\` is the
  Conventional Commits type the branch is named for ("stale token bug" ->
  \`fix/stale-token-bug\`; default feat). Always pass \`intent\`: one line on
  what the feature is FOR, stored with it, shown beside the worktree in the
  captain's panel.
- Dispatch into it by passing the name as \`dispatch_order\`'s \`feature\`
  (provisioned on first use). A worktree with a live agent is lane-gated:
  read the \`lanes\` protocol first.
- \`feature_enqueue(name, prTitle, prBody)\`: how a finished feature lands. No
  confirm gate; call it when the captain says done. It joins a strictly
  serial merge queue: only the head is processed - rebased onto fresh
  \`origin/dev\`, pushed, PR'd, gated on the PR's own CI checks - and comes
  back \`ready\`, \`awaiting-checks\`, \`blocked\`, or \`resolving\`. You write the
  PR message (read the \`pr-message\` protocol); omitted fields keep what is
  stored, so pass them only to change it.
- co runs no build and no test: the PR's real GitHub checks are the gate.
  \`awaiting-checks\` is a wait, not a failure; re-enqueue re-reads it. A PR
  reporting NO checks at all is ready but UNGATED - nothing verified it. Say
  so rather than calling it green; offer ONCE to have the crew add a CI
  workflow (on pull_request into dev, install from lockfile, run the repo's
  own typecheck and tests), and never withhold or delay a merge over it.
- A \`ready\` head needs NOTHING from you: its PR, checks and a live \`[m]\` sit
  in the captain's queue tab, and that keystroke merges it, tears down the
  worktree, and advances the queue. They may first edit your PR message with
  \`e\`; their version then wins - never re-send yours. Report ready, give the
  PR link, move on.
- A BLOCKED head is yours to engage, and you are told automatically. One line
  on what and why; for a rebase conflict or a red check offer
  \`feature_resolve_head\`: it ARMS a fresh agent in that feature's own
  worktree (never dev), fires only on typed confirm, bounded attempts, and
  the head re-processes when it finishes. A missing prerequisite (no gh, not
  authenticated, no origin/dev) is the captain's to fix: relay it verbatim,
  never merge some other way. Never point at \`[m]\` on a blocked head.
- \`feature_status(name?)\`: one feature's full picture, or every feature plus
  the queue. \`feature_abandon(name)\`: drop without landing; refuses a live
  WRITER or uncommitted changes, keeps unmerged branches, reports rather
  than forces.
- A feature is identified by the worktree co provisioned, never by branch
  name: a captain's branch that merely looks like one is not yours to touch.`,

  memory: `### Memory reference

Your substrate, \`.memory/\`, managed silently through the memory tools. The
behavioural rules live in the system prompt; this is what each file holds.

- \`projectbrief.md\`: what the project is, goals, hard constraints. Rewritten
  in full (memory_rewrite), injected at session start, kept compact.
- \`activeContext.md\`: orientation. Current focus, what is being decided,
  recent decisions compressed with ids, a rolling few-bullet summary of the
  recent conversation, in-flight work, risks, open questions, next likely
  actions. Rewritten in full, injected at session start.
- \`decisions.md\`, \`progress.md\`, \`research.md\`: append-only logs
  (memory_write), searched on demand (memory_search), never read whole.
  Decisions carry a stable id, D-YYYYMMDD-N, minted on write.
- \`archive/\`: old log entries moved off the search path but recoverable.
- \`sessions/\`: verbatim per-turn transcripts, the raw record.

A research note worth keeping captures: the question, the sources checked,
key findings and tradeoffs, a recommendation with confidence, links, and
whether it should update live state or imply a decision or an order.

Orders are not a file: they go in your reply or the dispatch, and the
transcript is their record.`,

  lanes: `### Two lanes in one worktree

A worktree has one \`.git/index\`, one \`dist/\`, one \`node_modules\`. Two
writers risk an invisible failure: the second drops a scratch file or build
artifact, the first sweeps it into a commit with \`git add -A\`, and the
commit looks legitimate and is not. A read-only second agent has no such
hazard, so read-only is the default and a second writer is the opt-in.

- Dispatch into an occupied worktree normally; nothing is refused. The arm
  banner names the live agent and offers the captain two verbs.
- \`confirm\` grants the READ-ONLY lane: the order is prefixed with a mandate
  forbidding every write (no edits, no new files, no git add/commit/stash,
  no install, no build, no artifact-emitting test run), and write-capable
  tools are denied at launch where the agent's CLI supports it. Where it
  does not, the lane is advisory: say so plainly, never call it sandboxed.
- \`confirm write\` grants a second WRITING lane, hazard live. Anything else
  cancels. The captain chooses the lane, never you.
- Write the order for the lane you expect: an audit asks for findings, not
  changes. A read-only run's result is NOT a review - it gets no verdict;
  answer the captain with what it found.
- Only a WRITER blocks enqueue and abandon. A feature holding only readers
  lands normally; that is correct, not a bug.`,

  "pr-message": `### Writing the pull request message

The shape of \`prTitle\`/\`prBody\` for feature_enqueue. You never saw the
diff: What and Testing relay the crew's report; never turn "tests pass"
into "verified".

Title: one imperative, specific line that stands alone as the permanent
history entry. No bot voice, no attribution. Not "Fix bug", not "Update
.gitignore".

Body: up to five sections, in order, each a short bullet list:
1. \`## What\` changed at a high level: capability and file-level shape.
2. \`## Why\`: the problem first, then decision ids, what it unblocks.
3. \`## How\`: the roads not taken - approaches abandoned and why,
   shortcomings named. Deeper reasoning stays in the decision log.
4. \`## Testing\`: what was ACTUALLY run and the reported results; say what
   was asserted but not proven. With no record at all, write "verification
   record unavailable" - never invent checks.
5. \`## Other Notes\`: out of scope, limitations, follow-ups.

Rules: bullets only, no paragraphs; three per section is typical, five the
maximum, each one short sentence. Drop a section you would leave empty - a
trivial change may be a title and two sections. Never duplicate the
harness's appended evidence block (commit list, CI checks); Testing covers
local verification only. Write as a developer and never name who did the
work: no "crew reports", no "co wrote", no "generated with". The product's
own nouns are fine as the SUBJECT of the change. No link standing in for an
explanation, no empty scaffolding.`,

  docs: `### Documents reference

\`docs/\` is the captain's tier: flat user-facing markdown, empty until a
workflow calls for one, authored through the \`doc\` tool (create / read /
str_replace / overwrite / delete / list). Propose a doc when one is genuinely
warranted; create it only when the captain says so. Your own bookkeeping
never goes in \`docs/\`, and captain-facing artifacts never go in \`.memory/\`.

- \`plan.md\`: one plan for the whole project, never one per feature.
  Tech-free: the problem, the proposed solution, the value, and above all
  "what does finished look like" - concrete, observable success criteria.
  No implementation detail. A living document updated in place: a new
  feature revises this plan rather than spawning another.
- \`architecture.md\`: the high-level how. How the parts connect, the data
  flow, component and agent relationships, schemas. The shape of the
  system, not a code dump.

Both are injected into your session briefing when they exist, so keep them
accurate: a stale plan or architecture doc misleads every future session.
Use str_replace for targeted edits, overwrite for restructures.`,
};

export function isProtocolSection(v: unknown): v is ProtocolSection {
  return typeof v === "string" && (PROTOCOL_SECTIONS as readonly string[]).includes(v);
}

/** The full text of one section. */
export function protocolBody(section: ProtocolSection): string {
  return PROTOCOLS[section];
}
