# comanager

A terminal-native architectural **co-manager** for software projects. It's a
persistent, research-capable thinking partner that reasons through
architecture, pushes back on weak assumptions, tracks decisions, and writes
high-quality orders to the crew (separate coding agents).

It is deliberately **not** a coding agent. It never inspects, edits, or runs
your project's source code itself: a separate coding agent does all the repo
work, and the co-manager is the architect and orchestrator. It operates from its
own markdown memory workspace, not your repo's files.

It delivers an order to the crew (Claude Code, OpenCode, etc.) one of two ways:
as plain text you copy across, or by dispatching it directly to the crew when
you've linked the instance to a repo (`co link`). A direct dispatch is always
gated by a typed `confirm`, runs the agent in a visible pane you can watch and
answer, and the co-manager reviews the captured result for you afterward. Even
when dispatching, it never reads or edits repo files itself.

```
Ghostty (or any terminal multiplexer)
├── pane 1: co-manager  ← the brain: architecture, research, decisions, orders
├── pane 2: Claude Code / OpenCode inside the real repo  ← the hands
├── pane 3: tests / shell
└── pane 4: logs / dev server
```

The co-manager is the brain. Coding agents are the hands. Markdown is the
durable memory. The terminal is the operating room.

## Why this exists

Coding-agent harnesses pull the model into a coding mindset. This tool keeps
architecture, research, and decision work separate from implementation. Its
global behavior is enforced by an absolute identity block at the top of the
system prompt:

> You are a co-manager: a persistent architectural thinking partner for one
> software project. You are not a coding agent. You reason about architecture,
> research tradeoffs from primary sources, preserve decisions, maintain project
> memory, and write the orders to the crew: implementation-ready prompts for
> separate coding agents. You never inspect, edit, or run the user's source code
> yourself; a separate coding agent does all the repo work. You deliver an order
> either as plain text the captain carries across, or by dispatching it directly
> to the crew when the instance is linked to a repo - always gated by the
> captain's typed confirm, run in a visible pane, and reviewed from the captured
> result afterward. Even when dispatching, you never read or edit repo files
> yourself. These constraints are absolute - everything else in the prompt is
> guidance on how to carry them out.

## Two layers: the app and the memory

There are exactly two things, and keeping them separate is the whole idea:

> **A co-manager is a folder-backed stateful architectural brain.**
> **The folder is memory, not the app. The `co` command is the app.**

1. **Runtime (the app)** — the `co` / `comanager` executable. Installed **once**,
   globally, like `git`, `gh`, or `claude`. It calls Bedrock, runs the terminal
   chat, manages memory, does research, writes logs and prompts.
2. **Memory workspace (the data)** — plain markdown folders under `CO_HOME`
   (default `~/co-managers`). These are **data, not apps**. You can edit the
   files directly. You **never** run `npm` inside them.

```
The installed `co` command is the runtime.
~/co-managers is the memory workspace.
Each instance folder is just markdown memory.
You can edit the files directly.
You never install dependencies inside instance folders.
```

## Install (once)

Requires Node.js 20+. Install the runtime globally from the repo:

```bash
git clone <repo-url>
cd manager-agent
npm install         # fetch dependencies (one time, for the runtime)
npm run build       # compile to dist/
npm install -g .    # put `co` and `comanager` on your PATH
```

`npm install -g .` also runs the build automatically (via the `prepare` script),
so it stays correct even if you skip the explicit `npm run build`.

That is the only time you touch npm. From then on you just use `co`.

## Use (forever)

From anywhere on your machine:

```bash
co doctor           # check runtime, workspace paths, auth, research
co create my-saas   # scaffold a new co-manager (markdown only)
co my-saas          # open an interactive session
```

Creating or running a co-manager never requires `npm install` — instances are
just folders of markdown under `~/co-managers`.

## Development only

These are for working on the runtime itself, not for daily use:

```bash
npm run dev -- my-saas      # run from source via tsx, no build step
node dist/index.js my-saas  # run the compiled entry directly
npm run typecheck           # tsc --noEmit
```

`npm link` also works as an alternative to `npm install -g .` if you want the
global command to track your working tree while developing.

## Configure

Copy `.env.example` to `.env` (in the working directory) or to
`~/co-managers/.env`, and fill in the model backend. Real environment variables
always win over `.env` files. Credentials are never hardcoded.

### Model backend (Amazon Bedrock Claude)

comanager authenticates to Bedrock the same way Claude Code does: a **Bedrock
bearer token** first, standard AWS credentials only as a fallback. comanager
needs its **own** token — it does not read Claude Code's. Resolution order:

1. **`AWS_BEARER_TOKEN_BEDROCK`** — the Bedrock bearer token (preferred).
2. **`BEDROCK_API_KEY`** — accepted alias for the same thing.
3. **Standard AWS credentials (SigV4)** — only if no bearer token is set: the
   AWS SDK credential chain (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/
   `AWS_SESSION_TOKEN`, `~/.aws/credentials`, SSO, or an instance role).

Set the token one of two ways:

```bash
co auth bedrock          # prompts for the token (hidden), writes ~/co-managers/.env (0600)
```

or edit `~/co-managers/.env` by hand:

```bash
AWS_REGION=us-west-2
BEDROCK_MODEL_ID=us.anthropic.claude-opus-4-8   # default; Opus 4.8

# Preferred auth path. Paste your Bedrock bearer token here.
AWS_BEARER_TOKEN_BEDROCK=

# Alias also accepted:
# BEDROCK_API_KEY=

CO_MAX_TOKENS=8192
CO_THINKING=off                    # or `adaptive` for extended thinking
# CO_EFFORT=high                   # low | medium | high | xhigh | max (default high)
# CO_DEBUG_TIMING=true             # per-round latency + cache counters
```

Thinking is never displayed, even when it's on. The co reasons before it speaks,
but the transcript only shows what it actually says.

`co doctor` reports the resolved `auth mode` (`Bedrock bearer token` vs
`AWS credentials (SigV4)`). If Claude Code has a bearer token configured but
comanager is falling back to SigV4, `co doctor` and `co doctor --models` warn
you and point you at `co auth bedrock` — the two paths can have different model
access.

`BEDROCK_MODEL_ID` is a Bedrock model id: a foundation-model id
(`anthropic.claude-...`) or, for recent models on on-demand throughput, a
cross-region **inference profile** id (`us.anthropic.claude-...` /
`eu.anthropic.claude-...`). The default is Opus 4.8 (`us.anthropic.claude-opus-4-8`),
which requires the inference-profile form: the bare `anthropic.claude-opus-4-8`
is rejected for on-demand throughput. These ids are served over the standard
Bedrock runtime path (`AnthropicBedrock`), not the newer Mantle endpoint; a
Bedrock API key that lacks Mantle entitlement 404s there, so the app stays on
the runtime path (matching Claude Code's own `CLAUDE_CODE_USE_BEDROCK=1`
setup). Run `co doctor --ping` to confirm it's reachable from your account.

### Research layer (all optional)

Research is a first-class capability with a pluggable design:

```
search provider  → candidate URLs
fetcher          → source text (markdown)
the model        → synthesizes evidence
markdown memory  → preserves research notes
```

- **Fetcher**: [Jina Reader](https://jina.ai/reader/) (`r.jina.ai`) is the
  default — free, no key required, turns any URL into clean markdown. Falls
  back to a plain HTTP GET with light HTML stripping. Set `JINA_API_KEY` only
  if you have one (higher limits).
- **Search** (optional): set one of `EXA_API_KEY`, `BRAVE_API_KEY`,
  `TAVILY_API_KEY`, or `SEARXNG_URL`. With `CO_SEARCH_PROVIDER=auto` (default),
  the first configured provider is used, preferring Exa. With none, `search_web`
  returns a clear "not configured" message and the co-manager can still
  `fetch_url` any link you give it. The co-manager sets recency per query: it
  clamps the result pool to recent content for "latest / current" questions and
  leaves the full timeline open for historical or prior-art questions. On Exa it
  can also request live-crawled page content when freshness matters.

No paid third-party service is required for basic operation.

## Commands

```bash
co list                  # list co-managers
co create my-saas        # create an instance from the template
co my-saas               # open an interactive session (creates it if missing)
co delete my-saas        # permanently delete an instance (type the name to confirm)
co delete my-saas -y     # skip the prompt (--force / -y) for scripting
co link my-saas          # register a repo + agent command so it can dispatch to the crew
co pane my-saas          # designate the crew anchor pane (macOS + Ghostty)
co auth bedrock          # set the Bedrock bearer token in ~/co-managers/.env (0600)
co doctor                # check runtime + workspace paths, auth, research
co doctor --ping         # also make one live model call
co doctor --models       # probe which Claude models actually answer on your auth path
```

`co delete` shows what will be destroyed (file count, recorded decisions) and
requires you to type the instance name to confirm — a bare y/n is too easy to
fat-finger for an irreversible op. It refuses to run on piped input unless you
pass `--force`.

Inside a session, **natural language is the interface** — you don't need
commands. The co-manager decides on its own when to search memory, research,
propose a decision, or write the orders to the crew (a coding-agent prompt).

Slash-commands are optional overrides:

| command            | what it does                                              |
| ------------------ | --------------------------------------------------------- |
| `/state`           | show current `activeContext.md`                           |
| `/research <q>`    | research a question and save a note                       |
| `/decide <d>`      | record a decision explicitly, then refresh activeContext   |
| `/prompt <goal>`   | draft the orders to the crew (a coding-agent prompt) inline |
| `/orders <goal>`   | alias of `/prompt`                                        |
| `/sync`            | refresh `activeContext.md` from recent activity           |
| `/archive <log>`   | move a log's history into `archive/`                      |
| `/effort [level]`  | show or set thinking effort for this session              |
| `/help`            | list commands                                             |
| `/exit`            | leave (auto-saves: refreshes `activeContext.md` if stale)  |

### Memory is silent and self-managed

The co-manager treats its memory the way a person treats their own: it just
remembers, and it never makes you think about the bookkeeping. Decisions,
progress, research, and live-state updates are recorded on its own judgment, as
they come up in conversation — no "should I log that?", no confirmation step, no
"saved to progress" narration. Decisions land in `decisions.md` with a minted id
(`D-YYYYMMDD-N`). `/decide <d>` is just a shortcut to record one explicitly; it
is not a gate.

Memory surfaces only when you ask for it ("what did we decide about X?", "show
me that research note"). Then it summarizes from memory and offers the raw file
if you want the full text. The rest of the time, memory stays out of the way.

### Durable transcripts (save along the way)

Every session writes a verbatim, turn-by-turn transcript into `sessions/` as you
talk. Each of your messages and each reply is appended the moment it lands, so a
crash, `Ctrl-C`, a `kill`, or a pulled power cord never costs the conversation.
Transcripts are the raw record; they are **not** read back into context at cold
start — that stays cheap and oriented from live state only (see the flat
cold-start note below). Read a transcript any time; it's plain markdown.

### End-of-session auto-save

Exit just saves. If decisions, research, or progress changed during a
session and `activeContext.md` is older than those logs (with a small mtime skew
tolerance), on exit the co-manager silently refreshes `activeContext.md` before
closing — no prompt to answer. The transcript is already on disk turn-by-turn,
so the only thing left at exit is re-distilling live state for the next cold
start, and there's no reason to make you approve that. Run `/sync` any time to
do the same on demand mid-session. A forced exit (`Ctrl-C`, signal) skips only
the re-distill, which the next clean exit or `/sync` recovers; no conversation
is lost either way.

### Full-screen sessions

On a real terminal, `co <name>` takes over the whole screen using the
alternate screen buffer — the same mechanism `claude`, `vim`, and `less` use.
Your shell's scrollback is preserved and restored exactly as you left it on
exit, with a short recap of what the session changed printed to the primary
screen. The restore is guaranteed on every exit path (normal exit, Ctrl-C,
signals, and errors).

The session is a scrollable terminal UI, not a plain read-out:

- **Scroll the transcript** with the mouse wheel/trackpad, or `PgUp`/`PgDn`.
  The alternate screen buffer has no native scrollback, so the app keeps the
  whole transcript itself and scrolls it in place — new output auto-follows the
  bottom until you scroll up.
- **`↑` / `↓` recall your own previous input** (like a shell), separate from
  transcript scrolling. Left/right, Home/End, Ctrl-A/E/U/K edit the input line;
  in a multi-line message they act on the line you're on, and `↑`/`↓` move
  between its lines before falling through to history.
- **Multi-line messages**: `Shift+Enter` inserts a newline instead of sending,
  and `Enter` still sends. Shift+Enter needs a terminal that can report it —
  the app asks for the Kitty keyboard protocol on startup (Kitty, Ghostty,
  WezTerm, foot, recent iTerm2), and pops that request on every exit path.
  Where the terminal can't report it (macOS Terminal.app, most others),
  **`Ctrl-J`** inserts a newline and works everywhere; `Alt/Option+Enter` also
  works if your terminal sends Option as Meta. Set `CO_KEYS=off` to skip the
  protocol request entirely — you lose Shift+Enter, `Ctrl-J` still composes.
- **Word wrap** breaks long lines at word boundaries and is ANSI-aware, so
  colored text never gets split mid-escape or mid-word at the column edge.
- **Selecting text** while the app captures the mouse: hold your terminal's
  override key (Option in iTerm2, Fn in Terminal.app, Shift in most others) and
  drag, then copy as usual. To turn off mouse capture entirely (wheel stops
  scrolling, native click-drag selection always works), set `CO_MOUSE=off`.
- **Pasting a large block** collapses it to a chip like `[Pasted text #1 +43
  lines]` instead of flooding the input, and the full text is sent when you
  submit (backspace deletes the whole chip). One-liners paste inline. This uses
  bracketed paste; set `CO_PASTE=off` to disable it if your terminal misbehaves.

The full UI never engages when output is piped or redirected — that falls back
to a plain line-oriented session so scripts and pipelines behave predictably.

## Memory model

Each instance is a folder under `~/co-managers/` (override with `CO_HOME`). It
splits by audience: user-facing documents flat in `docs/`, the co-manager's own
self-managed substrate hidden in `.memory/`. The substrate keeps cold-start cost
flat over time — small rewritten orientation files plus large append-only logs.

```
~/co-managers/
└── instances/
    └── my-saas/
        ├── docs/               user-facing documents (flat, starts empty)
        │   └── architecture.md    ← plan.md and any other doc join it, via the doc tool
        ├── .memory/            hidden substrate the co-manager manages
        │   ├── projectbrief.md    rewritten-in-full orientation
        │   ├── activeContext.md   ← the orientation file, read first each start
        │   ├── decisions.md       append-only log
        │   ├── progress.md        append-only log
        │   ├── research.md        append-only log
        │   ├── archive/           cold log history, off the read path
        │   │   └── decisions/ progress/ research/
        │   └── sessions/          verbatim per-session transcripts (the record)
        └── .dispatch/          crew-dispatch state (only after `co link`)
            ├── config.json        repo path, agent command, caps, pane layout, anchor
            └── captures/          per-job captured output the co reviews from
```

- **Cold start reads only the orientation files** (`projectbrief`,
  `activeContext`) plus `docs/architecture.md` and `docs/plan.md` when they
  exist. Full logs are never loaded into context; the model searches them or
  reads a line range on demand via tools.
- **`activeContext.md` is the most important file** — current focus, what's
  being decided, recent decisions (compressed), pointers into logs, what's in
  flight, known risks, open questions, next likely actions.
- **`docs/` starts empty.** User-facing documents are born when their workflow
  begins, not seeded as blank skeletons at create time. The co-manager creates
  and edits them through one generic `doc` tool (create / read / str_replace /
  overwrite / delete / list), which can only address flat `.md` files inside that
  instance's `docs/` — never the `.memory/` substrate, `.env`, or anything else.
  `architecture.md` and `plan.md` are ordinary documents that happen to get a
  privileged read at cold start.
- **Archiving** (`/archive <log>`) snapshots a log into `.memory/archive/<log>/`
  verbatim and resets the live log to its header, keeping history recoverable but
  off the default read path.
- **Old instances migrate automatically.** An instance created under the earlier
  `live/` + `logs/` layout is moved onto `docs/` + `.memory/` in place the next
  time it's opened — contents untouched, nothing overwritten, safe to repeat.

The files are plain markdown — edit them in your editor any time. Templates only
fill gaps; they never overwrite your content. An instance folder contains no
`package.json`, no `node_modules`, no build output — it is memory, not an app.
The protocol reference the model reads (memory layout, documents, research,
orders, report review) is not a file on disk: it's part of the system prompt, assembled from the
runtime code, so it always matches the installed version.

## How a session flows

```
you talk naturally
      ↓
the co-manager classifies intent internally and picks a pathway:
  discussion · memory lookup · research · decision proposal ·
  orders to the crew (coding-agent prompt) · state summary
      ↓
it calls internal tools as needed (memory, search_web, fetch_url, …)
      ↓
it responds and updates memory appropriately
      ↓
on exit, the stale-activeContext guard keeps live state honest
```

## Dispatching orders to the crew

By default the co-manager hands you an order as text and you carry it to a coding
agent yourself. If you'd rather have it run the order for you, link the instance
to a repo:

```bash
co link my-saas          # register the target repo + the named crew agents
```

`co link` records, per instance (in `.dispatch/config.json` under the instance
folder, not `.env` — none of it is secret): the repo path; one or more **named
crew agents**, each an agent-agnostic launch command with a `{prompt}`
placeholder (it ships `cc`/`ccw` for the two Claude Code wrappers and `opencode`,
and you can name your own); which agent a bare `confirm` uses by default; optional
safety caps (wall-clock timeout, turn limit); and the crew-pane layout. It's
re-runnable — run it again to change any of it. The crew process runs with the
repo as its working directory, so a command needs **no** `--dir` flag to target
the repo (Claude Code has none).

Once linked, the co-manager can **arm** a dispatch instead of only writing text.
Arming shows you the exact order and the resolved command and waits. Nothing runs
until you type `confirm`; any other input cancels it. A bare `confirm` runs the
default agent; `confirm <name>` (e.g. `confirm ccw`) picks a specific agent for
that one dispatch. This typed confirm is a hard interlock, not a nicety — there is
no code path that dispatches without it.

**On macOS with Ghostty**, a confirmed dispatch opens a visible split pane in your
current tab and runs the agent there interactively, so you can watch it and answer
its questions live. Placement follows a fixed scheme: designate the crew pane once
with `co pane my-saas` — it gives you a few seconds to click the pane you want crew
jobs to grow from, then records that terminal's stable id (Ghostty's API can't tag
a pane, so the id is the handle; a dispatch verifies it still exists and asks you
to re-run `co pane` if you've since closed it). The first job takes over that
anchor pane, and each later job splits the newest crew pane, alternating
beside/below, up to a cap (default 4) after which the oldest finished pane is
reused or the job queues. The split direction sequence and the cap are config
values you can retune. Requires Ghostty 1.3+ and a one-time macOS Automation
permission (granted the first time it scripts Ghostty).

**Everywhere else** (no Ghostty, or automation unavailable), the same dispatch
runs as a detached background process instead, with no pane geometry. The
co-manager tells you which transport it used.

Either way the run's output is captured to a file, and when it finishes the
co-manager reads that capture and reports a review on its own — you never paste
anything back. The session stays fully interactive the whole time, including with
several jobs running at once; a failed or timed-out job never takes the session
down. This layer is macOS + Ghostty only for the visible pane; the background
fallback is portable.

## What makes a turn slow

A turn is one or more round trips to Bedrock. Latency is dominated by three
things, in this order:

**Round trips, not thinking.** A turn that calls a tool costs at least two round
trips: one to decide and call, one to answer. Memory writes are silent, so a turn
that looked simple can quietly have been two model calls. The system prompt tells
the co to answer first and record second, so the visible reply lands in the first
round instead of after the bookkeeping, and to leave `activeContext.md` alone
unless orientation genuinely moved — every rewrite of that file is a whole-file
regeneration and its own round trip. The end-of-session distill still runs
unconditionally, so nothing is lost by not refreshing mid-conversation.

**Prompt caching.** The system prompt, tool definitions, live state, and the
conversation so far are re-sent on every round trip. Without caching that whole
prefix is reprocessed cold each time and the cost grows all session. Four cache
breakpoints — one closing the tool definitions, one closing the system prompt,
and two rolling anchors in the message history — mean a warm turn reprocesses
almost nothing. Measured on a real session: a cold first turn took 4.7s, and the
next turn read 8,394 tokens from cache and answered in 1.2s.

Caching is placed by hand because Amazon Bedrock has no automatic caching, and
it is verified at runtime rather than assumed: Anthropic documents the legacy
`bedrock-runtime` path this app is pinned to (see `model.ts`) as not having full
feature parity, and a breakpoint that stops matching fails silently — the only
symptom is a session that gets slower. `CO_DEBUG_TIMING=true` prints the
counters that tell you:

```
⏱ round 1: 1.2s (first token 1.2s) · in 2 cache+199/read 8394 · out 7 · stop end_turn
⏱ turn: 1.2s over 1 round(s)
```

`read` is prompt tokens served from cache. If it stays at 0 across turns of a
single session, caching has broken and every turn is paying full price. `in` is
only the tokens after the last breakpoint, so a small number there is the good
outcome, not a small prompt.

**Effort.** `CO_EFFORT` governs all output tokens, not just thinking, so it also
sets how many tool calls the co makes — and each of those is another round trip.
Default `high`. The cold-start greeting deliberately runs at `low`: it blocks the
first prompt, and it is only summarising state already in its context.

Tool calls within one round run concurrently, so a research turn fetching three
sources pays one fetch timeout rather than three. Memory writes are serialized
behind a single queue (`memory/writequeue.ts`) so that concurrency can't
interleave a read-modify-write.

## Architecture notes

`src/` is one level deep: shared primitives and the bin entry sit at the root,
and everything else groups by feature. No barrel files — imports name the file
they want, so a cold start only loads what it uses.

```
src/
  index.ts config.ts paths.ts ui.ts model.ts research.ts
  cli/       auth.ts doctor.ts modelsdoctor.ts link.ts
  tui/       tui.ts markdown.ts wrap.ts keys.ts banner.ts commands.ts
  session/   session.ts prompt.ts tools.ts
             crewpanes.ts dispatchconfig.ts transport.ts registry.ts
  memory/    memory.ts docs.ts templates.ts writequeue.ts
```

Tests live next to the code they cover (`src/tui/keys.test.ts`, etc.).

**Root — shared and entry:**

- **`src/index.ts`** — CLI dispatch and the `dist/index.js` bin entry.
- **`src/config.ts`** — env/`.env` loading; Bedrock + research config. No
  hardcoded secrets.
- **`src/paths.ts`** — the two-tier folder layout and instance path resolution.
- **`src/ui.ts`** — colour and line-output primitives used by everything.
- **`src/model.ts`** — `AnthropicBedrock` wrapper: streaming turns, the tool-use
  loop, thinking/effort config. Bedrock is the only backend (V1).
- **`src/research.ts`** — `SearchProvider` (Brave/Tavily/SearXNG) and `Fetcher`
  (Jina/HTTP) behind small interfaces; everything optional.

**`src/memory/`** — `memory.ts` holds instance scaffolding, live-state
read/rewrite, append-only logs with decision-id minting, log search / range
read, archive, and mtime staleness detection. `docs.ts` is the user-facing `docs/`
tier: the six doc operations, the name/realpath sandbox that keeps them inside
`docs/`, and the cold-start read of `architecture.md` / `plan.md`. `templates.ts`
is the seed content for a fresh instance. `writequeue.ts` is the single lane every
mutating memory/doc operation runs through, so the concurrent tool calls in one
model round can't interleave a read-modify-write (duplicate decision ids, a lost
doc edit).

**`src/session/`** — `session.ts` is the interactive REPL, slash-commands, the
end-of-session sync guard, and the dispatch flow (arm → typed-confirm interlock →
fire → proactive review). `prompt.ts` assembles the system prompt in altitude
order: identity + constraints, operating notes, navigator voice, the protocol
reference sections (memory / documents / research / orders / dispatch when linked
/ report review), then live state and the recent-conversation tail (logs
excluded). `tools.ts` is the internal tool surface exposed to the model plus the
executor that binds tools to memory + research; it holds the decision gate and
the arm-only `dispatch_order` tool.

The dispatch layer is four focused modules. `crewpanes.ts` is the pure pane-
placement planner (anchor takeover, alternating splits of the newest pane, cap +
reuse-oldest, all configurable) with no I/O. `dispatchconfig.ts` reads/writes the
per-instance `.dispatch/config.json`, resolves which named crew agent a dispatch
uses (default or `confirm <name>` override), and turns its command into argv
(placeholder substitution, argv tokenizing, shell quoting). `transport.ts` has
the two launchers — a Ghostty/AppleScript visible-pane path that consumes the
planner, and a detached-subprocess fallback — both sharing one capture-file +
completion-sentinel contract. `registry.ts` owns in-flight jobs: it launches on
the chosen transport, polls captures for the sentinel, enforces timeouts, drains
the pane queue, and fires a completion callback, all non-blocking.

**`src/tui/`** — the full-screen terminal UI: transcript buffer + scrolling,
the multi-line line editor, markdown → ANSI rendering, and ANSI-aware wrapping.
`keys.ts` is the pure decode table that maps both legacy control bytes and
enhanced-protocol CSI-u sequences onto one set of bindings. `tui.ts` is
deliberately one large file: the render loop, input handling, and scroll state
share mutable state, and splitting them across modules would mean exporting
that state rather than encapsulating it.

**`src/cli/`** — `doctor.ts` and `modelsdoctor.ts` diagnostics, `auth.ts` for
writing the Bedrock token, and `link.ts` for `co link` (register repo + agent
command) and `co pane` (designate the crew anchor pane).

### V1 scope and extension points

Deliberately out of scope for V1 (with clean seams left for later): a richer
research protocol enforced in-runtime, automatic time/size-based log archiving,
GitHub/Stack Exchange source providers, and multi-instance cross-linking. The
provider abstractions (`ModelProvider`, `SearchProvider`, `Fetcher`) and the
`ToolSideEffects` tracking are the extension points.

## License

MIT
