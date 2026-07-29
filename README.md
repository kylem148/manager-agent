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

Finished feature work integrates into `dev` as a GitHub pull request rather than
a local merge (see "Landing work" below).

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

Pull requests into `dev` and `main` run the same two things in GitHub Actions
(`.github/workflows/ci.yml`) on Node 22: `npm run typecheck` and `npm test`. That
is deliberate rather than incidental. This repo lands its own work through co's
merge queue, which gates a head on the pull request's real checks, so without a
workflow here every landing would come back ungated (see "Landing work" below).

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
`eu.anthropic.claude-...`). The default is Opus 4.8
(`us.anthropic.claude-opus-4-8`). Three ids are known to work on this account:

| `BEDROCK_MODEL_ID`               | notes                                        |
| -------------------------------- | -------------------------------------------- |
| `us.anthropic.claude-opus-4-8`   | default; most capable, most expensive        |
| `us.anthropic.claude-sonnet-5`   | cheaper tier, keeps every effort level       |
| `us.anthropic.claude-sonnet-4-6` | cheaper tier; does **not** accept `xhigh`    |

All three require the inference-profile form: the bare `anthropic.claude-...`
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
co cost                  # tokens, dollars and time across every co-manager
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
| `/cost`            | tokens, dollars and time spent — session, today, all time  |
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
- **Copying out of the Ctrl-O panel** works two ways, because there are two
  questions. **Drag** to select part of what you're looking at: the cells
  highlight and the text is on your clipboard the moment you let go — on any
  tab, so a PR link on the queue, a paragraph of a doc and a chunk of a filed
  review all come out the same way. **`y`** on an open doc takes the whole
  thing, as **raw markdown** rather than the painted rows, which is what you
  actually want back from a cheat-sheet the co-manager wrote: the source, not a
  width-wrapped screenshot of it. Both go through OSC 52, so both work over SSH.
  That sequence is write-only and nothing acknowledges it, so if a paste comes up
  empty, allow clipboard access in your terminal (Terminal.app doesn't support
  OSC 52 at all; iTerm2 and Ghostty have a setting for it). The footer says so
  each time it copies.
- **Pasting a large block** collapses it to a chip like `[Pasted text #1 +43
  lines]` instead of flooding the input, and the full text is sent when you
  submit (backspace deletes the whole chip). One-liners paste inline. This uses
  bracketed paste; set `CO_PASTE=off` to disable it if your terminal misbehaves.
  Inside the Ctrl-O panel a paste goes to the PR message editor when that is
  open, verbatim and whole; on a plain tab it is swallowed, because no view out
  there is a text buffer and a pasted paragraph containing an `m` must not merge
  the head PR.
- **Two small nautical moments** mark the two points where the session is doing
  something and would otherwise sit still. Firing a confirmed dispatch runs the
  order out to sea above the input bar, over the branch it's headed for
  (`≈≈▸ dispatching → feat/user-auth`); `/exit` sails a ship across the width once
  while memory saves. Both are described below.

### Terminal visuals (`CO_VISUALS`)

The animations play **only during an idle wait** — the crew launch, and the
save-on-exit distill — and never while the model is streaming. They are
decoration over information that is printed either way: the destination line and
the saving line go into the transcript at every level, so nothing is ever
communicated by motion alone.

```bash
CO_VISUALS=full      # default: animated
CO_VISUALS=minimal   # the same lines and glyphs, but nothing moves
CO_VISUALS=off       # a plain ASCII line
```

The setting is a ceiling, not a promise: the environment can only lower it.
`NO_COLOR`, piped/non-TTY output, the plain-session fallback, `TERM=dumb`, a
terminal narrower than 40 columns, or a reduced-motion signal
(`CO_REDUCED_MOTION`, `REDUCED_MOTION`, `PREFERS_REDUCED_MOTION`, `NO_MOTION`)
each degrade it to the same single static ASCII line — `~~> dispatching ->
feat/user-auth`, `~~ saving... fair winds`. Every glyph is one column of ASCII or
box drawing with a plain-ASCII twin, there are no emoji, and the one colour
accent always sits on a glyph or on text, never alone. A dispatch that targets
the bare main tree says so in words rather than naming a branch.

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
        └── .dispatch/          runtime state (the crew half only after `co link`)
            ├── config.json        repo path, named agent commands, caps, pane layout, anchor
            ├── panes.json         the crew panes co owns: tty + shell pid + its lease on each
            ├── inbox.json         the last 20 crew reviews, newest first (Ctrl-O → Inbox)
            ├── features.json      per-feature intent + PR message, keyed by slug
            ├── tasks.json         the at-a-glance task table (Ctrl-O → Home)
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

## Crew dispatch

By default the co-manager hands you an order as text and you carry it to a coding
agent yourself. If you'd rather have it run the order for you, link the instance
to a repo:

```bash
co link my-saas          # register the target repo + the named crew agents
```

`co link` walks a short flow: confirm the repo path, then type the **word you run
each coding agent with** — `cc` for personal, `ccw` for work (leave work blank to
skip) — pick which one a bare `confirm` uses by default, and set optional safety
caps (wall-clock timeout, turn limit).

The word you type is almost always a shell **alias**, which doesn't exist in the
non-interactive shell a dispatch spawns — so `co link` resolves each word through
your login shell right then and stores the **real command** it expands to (e.g.
`cc` → `claude`, `ccw` → `CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude`). It shows
you what each word resolved to. If a word doesn't resolve to something on your
PATH, it warns and stores the word as-is so you can install it or re-link. Because
resolution happens at link time, **re-run `co link` if you change the alias.**

All of it is recorded per instance in `.dispatch/config.json` under the instance
folder (not `.env` — none of it is secret): the repo path; the resolved crew
agents (each a launch command with a `{prompt}` placeholder); the default agent;
the safety caps; and the crew-pane layout. The stored command is treated as a
shell string (the same model git uses for `core.editor`), so an env-var prefix
like `CLAUDE_CONFIG_DIR=...` or `$VAR` references work; only the substituted order
text and repo path are shell-quoted. The crew process runs with the repo as its
working directory, so a command needs **no** `--dir` flag to target the repo
(Claude Code has none).

Once linked, the co-manager can **arm** a dispatch instead of only writing text.
Arming shows you the exact order and the resolved command and waits. Nothing runs
until you type `confirm`; anything that isn't a `confirm` cancels the armed order
and is handled as ordinary input. A bare `confirm` runs the default agent;
`confirm <name>` (e.g. `confirm ccw`) picks a specific agent for that one dispatch
and does not change the default. Type an agent name that isn't registered and the
order stays armed — it lists the valid names and waits for you to retype, so a
typo never fires the wrong agent or forces a re-draft. This typed confirm is a
hard interlock, not a nicety — there is no code path that dispatches without it.

**On macOS with Ghostty**, a confirmed dispatch opens a visible split pane in your
current tab and runs the agent there interactively, so you can watch it and answer
its questions live. Placement follows a fixed scheme: designate the crew pane once
with `co pane my-saas` — it gives you a few seconds to click the pane you want crew
jobs to grow from, then records that terminal's stable id (Ghostty's API can't tag
a pane, so the id is the handle; a dispatch verifies it still exists and asks you
to re-run `co pane` if you've since closed it). The first job takes over that
anchor pane, and each later job splits the newest crew pane, alternating
beside/below. The split direction sequence is a config value you can retune.
Requires Ghostty 1.3+ and a one-time macOS Automation permission (granted the
first time it scripts Ghostty).

**An idle pane is reused before a new one is cut.** `/exit` the agent and the
pane goes back to a shell prompt; the next dispatch runs there instead of
splitting again, so panes stop piling up one per job. A pane is only reused when
*both* signals say it is free: co holds no dispatch on it, **and** nothing is
running in it right now — checked fresh, against the real pane, at the moment of
dispatch. Anything else in that pane, whether an agent you're still talking to, a
build you started, or an editor, means it is occupied and a new pane is split
instead. There is **no cap**: splitting is what "everything is busy" falls back
to, so an extra pane is always available, and getting it wrong in that direction
costs you one pane while the other direction would cost you your work.

How it knows: Ghostty's scripting API can tell co whether a terminal still exists
and nothing else — no tty, no process, no "is it at a prompt". So each job's
launch script reports the pane's tty and the pid of the shell that outlives the
job, co remembers that per pane (under `.dispatch/panes.json`), and a dispatch
reads that tty's process table (`ps`) to decide. A pane whose processes are all
shells is idle; anything else is not. co only ever considers panes it created or
the anchor you handed it, never a terminal of yours, and every uncertainty — an
unreadable pane, one it has no record for, a probe that fails — reads as
occupied.

**Close crew panes freely.** A finished worker pane you close is dropped from
the layout, and from co's pane records, before the next placement is decided, so
the following job grows from the newest pane that still exists, and from the
anchor once you've closed every worker. Closing panes never breaks the link: you
can spawn and delete crew panes all session without re-running anything. Only
closing the *anchor* pane itself leaves nothing to grow from, and that fails the
dispatch cleanly with a re-run `co pane` message rather than a broken link. A
busy anchor is a different thing entirely and no longer reads as a lost one: co
splits off it and leaves what's in it alone.

**Dispatch is visible-only.** A crew agent runs in a visible Ghostty pane or it
does not run at all — there is deliberately no background/headless path. If a
pane can't be placed (Ghostty isn't reachable, or no crew pane has been
designated with `co pane`, or the designated pane was closed), the dispatch
fails cleanly with an actionable message and launches nothing; it never runs an
agent somewhere you can't see. This is a safety property, not a limitation: an
invisible agent is one you can re-dispatch by accident, and two agents racing on
the same checkout corrupt the tree. The arming banner tells you up front whether
a pane is ready, so you know before you confirm. Requires macOS + Ghostty 1.3+.

When a job finishes the co-manager gathers that run's record and reports a
review on its own — you never paste anything back, and every job reports
independently (a later job finishing while an earlier one still runs delivers
its own review). The session stays fully interactive the whole time, including
with several jobs running at once; a failed or timed-out job never takes the
session down.

### Reviews are filed, not shouted

A review is a **record**, not a wall of chat. The co-manager writes each one into
a rolling inbox (the last 20, newest first, kept under the instance's
`.dispatch/inbox.json` and so surviving a restart), and reads it back in the
Ctrl-O panel's **Inbox** tab: one row per review with its level, verdict, and
headline, and one keypress to read the whole thing.

What reaches the conversation depends on the review's **level**, which the
co-manager assigns from its own verdict:

| level | when                                            | what you see in the chat                        |
| ----- | ----------------------------------------------- | ----------------------------------------------- |
| L1    | `rework`, or a real escalation only you can call | just the core decision it needs from you         |
| L2    | `fix-commit`, or an `accept` with notes          | one grey line: headline + where to read the rest |
| L3    | a clean `accept`                                 | nothing at all                                   |

The full review body is never printed to the chat at any level — it lives in the
inbox. So a clean chore costs you no attention, a mixed result costs you one
line, and only a run that genuinely needs a decision interrupts you, with the
decision and nothing else.

### The Ctrl-O panel: tabs and keys

`Ctrl-O` opens a full-screen panel over the session and closes it again. Every
tab it has is listed in a bar across the top, on every tab, with the one you're
on marked:

```
[1 home] 2 queue  3 docs  4 inbox
```

Move between them three ways: `Tab` (or `i`) cycles, and the **number beside a
tab jumps straight to it** from anywhere in the panel, including out of an open
doc. A fifth tab appears while a `feature_land` review is pending, and takes the
next number. Because the digits belong to the bar, the doc and inbox lists label
their rows `a)`, `b)`, `c)` rather than `1)`, `2)`, `3)`.

| tab   | what it is                                                        | its keys                              |
| ----- | ----------------------------------------------------------------- | ------------------------------------- |
| home  | the task table, then every tracked worktree. Read-only            | paging only                           |
| queue | the merge queue and the head's pull request                       | `m` merge, `e` edit the PR message    |
| docs  | everything in `docs/`, opened through the transcript's renderer   | `a`-`z` open, `y` copies an open doc  |
| inbox | the last 20 filed crew reviews                                    | `a`-`z` open                          |

Everywhere: `space`/`b` page, `j`/`k` line, `d`/`u` half, `g`/`G` ends,
`Backspace` steps back out of a doc or a review, `Esc` (or `Ctrl-O`, or `q`)
closes. A left-drag selects and copies on release, on every tab.

### Home: what we're doing, and what's in flight

`Ctrl-O` opens on **Home**, which answers the two questions you open the panel
with. On top, the co-manager's at-a-glance task table. Underneath, every feature
worktree that exists — including the ones still being worked, which the queue
never sees — one line each:

```
  tasks
  Task                        Type       Status
  ctrl-o overhaul             feature    building
  bedrock retry backoff       fix        blocked
  pricing table refresh       research   next

  worktrees
  ▸ checkout   [ready to merge]  feat/checkout   stripe checkout with saved cards
    user-auth  [queued #2]       feat/user-auth  passkey login for the web app
    search     [crew running]    feat/search     full-text search over the docs
    scratch    [dirty]           feat/scratch    the schema migration runner
```

The table is the same handful of live items the co-manager has always kept —
"you are here", pruned hard, one word of status each — except that it is now
**stored** rather than only spoken. The co writes the whole table through one
tool whenever it changes, so the panel paints the current one instead of you
having to ask for it and pay for a turn. A missing or unreadable table file is an
empty table, never a failed start.

The description beside a worktree is the **intent** the co-manager wrote when it
created the feature — a plain authored line, not something regenerated per
refresh, and no model is called to produce it. It is stored per feature under
`.dispatch/features.json`, so it is still there after a restart, including for
worktrees the startup sweep rebuilt from disk. A feature created without one says
so rather than showing a blank. Nothing on this tab is ever cut off at the right
edge: a description too long to sit beside the columns wraps underneath them,
indented, and a resize re-wraps it.

The state word is derived from what the session already knows: a crew agent live
in the worktree, a merge-queue position, a green head, a block, a resolver run.
An agent working an enqueued feature shows a `[crew]` marker beside its queue
state, so a running agent is never hidden by it, and a `▸` marks the two rows
that want your eye — the one that can merge right now, and the one holding the
queue up. A feature nothing else is happening to reads `[clean]` or `[dirty]`,
from a real `git status` taken when you open the tab (and `[idle]` in the moment
before that lands — never `[clean]`, which would be a claim nobody had checked).

Nothing on this tab acts — no selector, no `[m]` — which is what lets it be the
tab the panel opens on. Landing is the queue tab's keystroke, and creating,
enqueuing and abandoning are the co-manager's levers; this is the overview you
context-switch from.

### Landing work: one keystroke, `[m]`

Finished features land in `dev` as **GitHub pull requests**, through a strictly
serial merge queue that does the work itself. Only the front of the line is ever
touched. The queue fetches, rebases the head onto the current `origin/dev` tip,
pushes the rebased branch (force-with-lease — a rebase rewrites shas), opens a PR
into `dev` (or reuses the open one), and then **reads that PR's real GitHub
checks**. The **Ctrl-O queue tab** shows the PR in two blocks — the evidence (its
number and link, and what its CI said) and, under a rule of its own, the PR's own
**message**: the title, the description, and the commits it carries — with a live
`[m]` beside it once the checks are green. The message is the one on GitHub, read
back off the pull request and rendered the way the transcript renders markdown,
so what you decide the merge on is what the merge will say. co's fenced evidence
block is split off before painting: those markers are HTML comments GitHub hides,
and what they wrap is the checks and commits already shown beside them.

**The co-manager writes that message.** When you say a feature is done, it marks
it done and composes the pull request in the same breath — a title and a
description saying what the PR accomplishes and why, the way you'd write your
own. It reads like a person's because a person's reasoning is behind it: the
co-manager is the one that decided what the feature was for and reviewed what the
crew built. It costs nothing extra, either: the message rides along on the
mark-done call, so no model runs inside the queue. The message is stored with the
feature, so a retry after a conflict, a resolver run, or a restart opens the PR
with the same words rather than falling back. A feature enqueued without one gets
the old mechanical line (a single commit's own subject, or `<type>: <feature>` for
a branch of several, plus a one-sentence body), which is still the right answer
for a one-commit chore. The fallback is per half, not all or nothing: a title with
no description falls back for the description alone. A re-enqueue carrying neither
keeps what is already stored rather than wiping it, which is what makes retrying a
blocked head a retry and not a reset. And what the co-manager writes is prose, only
prose: the commit list and the checks result stay co's own, regenerated on every
processing inside the fenced block further down the description, so an authored
description that arrives carrying a fence of its own has it stripped before it is
stored. Either way co only ever writes the message when it CREATES the pull
request — once it exists, the title and the description are yours, and
re-processing rewrites nothing but the fenced evidence.

**The message has a shape.** The description is five sections: `## What` changed,
`## Why` it was necessary, `## How` it was approached (the roads not taken
included), `## Testing` for the verification that was actually run, and
`## Other Notes` for what is deliberately left out and what comes next. A section
with nothing real to say is dropped rather than left as empty scaffolding, so a
one-line fix stays a title and two sections. Every section is a short bullet
list and never a paragraph: three bullets is typical, five is the ceiling, and
each one is a single short sentence on its own line. That has a price, mostly in
`How`, where the tradeoffs behind an approach that was tried and dropped will
not fit in a one-line bullet; they stay in the decision log where they were
argued out, and the PR stays something a reviewer reads to the end. co never
sees the diff, so the
material for What and Testing comes out of the crew's completion report, which
every order now tells the crew to close with three things: the diffstat, the
verification it ran with its real output, and the approaches it tried and
abandoned with the reason each was dropped. Testing is a record of what was done,
never a to-do list for the reader, and it covers the crew's local verification
only: the PR's CI result is already in the fenced block below it.

**And you can rewrite it without leaving the terminal: `e`.** On the queue tab,
beside the `[m]`, `e` opens the head PR's message in an editor over the panel:
line 1 the title, a blank line, then the description, the way you write a commit
message. It takes the majority of the screen (90% of the width and of the panel
body, floored at 32 columns and 7 rows so it still works on a small terminal, and
capped at 120 columns and 44 rows so a wide one doesn't produce a line length
nobody can read a sentence across), because the job it exists for is replacing a
whole description and a keyhole is no good for that.

It is the input bar's editor, so there is nothing new to learn: the arrows move,
Home/End and Ctrl-A/E/U/K work on the line you're on, Backspace and Delete do
what they always do, long lines wrap for display only, and the view follows the
cursor down a long description. The one difference is Enter, which inserts a
newline here rather than sending: a description is prose, so **Ctrl-S** is what
saves it. Esc cancels, and on a buffer you've changed the first Esc warns before
the second discards.

On top of that it has the things a whole-body rewrite needs and the prompt line
does not: **paste**, **drag-select**, and three keys that act on the buffer
rather than the line. A multi-line paste lands as literal text, because the
terminal's bracketed paste is read as one payload however many chunks it arrives
in, so a forty-line body can never be read as forty Enter presses. A left-drag
selects text (caret to caret, the way any editor does it) and the moment you let
go it is on your system clipboard through OSC 52, the same escape the panel's own
drag-select and `y` use. Typing or pasting over a selection replaces it, so
"select all, paste" swaps a description out in one gesture.

**The popup's full key table.** Everything the editor binds, and what each key
acts on. Nothing else does anything; keys with no meaning here (Tab, Ctrl-C,
Ctrl-D) are deliberately swallowed rather than falling through to the panel's
meanings for them, and while a save is in flight every key and every mouse event
is ignored until it settles.

| key | what it does | scope |
| --- | ------------ | ----- |
| any printable character | insert at the caret, replacing the selection | character |
| **Enter** (and Shift/Ctrl/Alt+Enter, Ctrl-J) | insert a newline; it never sends | character |
| **Backspace** | delete the selection, else the character before the caret | character |
| **Delete** | delete the selection, else the character after the caret | character |
| **←** / **→** | move one character; drops the selection | character |
| **↑** / **↓** | move one *visual* row (a wrapped line moves row by row) | row |
| **PgUp** / **PgDn** | move a windowful of rows | row |
| mouse **wheel** | scroll three rows, caret and all | row |
| **Home** / **Ctrl-A** | start of the line the caret is on | line |
| **End** / **Ctrl-E** | end of that line | line |
| **Ctrl-U** | kill back to the start of that line | line |
| **Ctrl-K** | kill to the end of that line | line |
| **Ctrl-G** | select the whole buffer | buffer |
| **Ctrl-X** | clear the whole buffer. A *cut*: what it removes goes to the clipboard first | buffer |
| **Ctrl-Y** | copy the selection to the clipboard, or the whole buffer when nothing is selected | selection / buffer |
| **left-drag** | select text; on release it is copied to the clipboard | selection |
| **click** | move the caret there; a click outside the box drops the selection | character |
| **Ctrl-S** | save the title and description to GitHub | buffer |
| **Esc** (and **Ctrl-O**) | cancel; on a changed buffer the first press warns, the second discards | buffer |

Ctrl-A is Home and not select-all, in both editors. It is the oldest binding the
prompt line has, and moving it would strand every use of it. That is why the
wholesale verbs got keys of their own instead of re-pointing the line keys, and
why Ctrl-U still kills one line even with everything selected.

The mouse belongs to whichever surface is in front: while the popup is open a
drag selects *text inside it*, and the panel's own drag-select of painted cells
resumes the moment it closes. The two selections are different things and are
stored differently: the panel's is screen cells, so a resize has to drop it; the
editor's is buffer offsets, so it survives a resize and still names the same
words at the new width.

Saving writes the title and the description to GitHub with `gh pr edit`, and
stores them with the feature at the same time — so a later re-processing can't
resurrect the message you just replaced. Then it re-reads the pull request and
repaints from that, not from what you typed: what the panel shows afterwards is
what GitHub actually holds. co's fenced evidence block is never in the editor and
never at risk — it is split off before the buffer is filled and spliced back on
underneath, exactly once. If `gh` fails, the failure is printed in the popup with
your text still in it, so an edit is never quietly lost.

A save that lands closes the popup and confirms itself in one green line at the
top of the queue tab, and the next key you press takes that line away — it is a
receipt like the panel's copy one, and the tab underneath it is already showing
the new message. A line that reports something *not* happening is not a receipt
and does not go anywhere: an edit you discarded, or the reason `e` had nothing to
open, stands until it is replaced. A failed save is neither, and stays in the
popup over the text it could not write.

`e` is only there when the head actually has a pull request (it says so when it
doesn't), and it merges nothing: `[m]` remains a separate, deliberate keystroke
and the head's checks, its state and the queue's order are untouched by an edit.

**co runs no build and no test.** It used to, on the combined rebased tree, from
a command it had to guess — and a guess is wrong the moment the repo isn't npm.
GitHub is already testing exactly the state that matters (a `pull_request`
workflow runs against a merge of the PR head and its base, which is the tree the
rebase produced) and already blocks the merge on the result, so co reads that
verdict instead of reproducing it. What co still owns is the *textual* half of
the gate — the rebase onto the current `origin/dev`, because that is git's
question, not CI's, and feature A green plus feature B green does not make A+B
green.

Four things the checks read can say, and what each does to the head:

| checks | head | what you see |
| ------ | ---- | ------------ |
| all green (required checks if branch protection defines any, else every check) | `ready` | a live `[m]` |
| any red | `blocked` | the failing checks by name, with links to their runs |
| still running | `awaiting-checks` | what it is waiting on; no `[m]` yet |
| **none at all** | `ready`, flagged **ungated** | "no CI checks on its PR — merging is your judgment, not a green" |

That last row is deliberate. A repo with no CI is not an error and not a red: co
has nothing to verify against, says exactly that in the panel and on the PR, and
leaves the merge to you. A *broken* read is different — gh missing, gh
unauthenticated, GitHub returning an error — and that blocks the head with gh's
own message rather than quietly passing as ungated.

Ungated does have a cause, though, so the co-manager names it instead of just
reporting the state: the repo has no workflow producing checks on its pull
requests, and it offers once to have the crew add a small standard one. Decline
and it drops the subject for the rest of the session. It never holds a merge over
it; the `[m]` is live either way.

The wait on pending checks is bounded (five minutes by default, re-read every
ten seconds). When it runs out the head sits in `awaiting-checks` rather than
hanging or claiming a verdict; re-enqueuing it reads the checks again.

`[m]` is a state, not a prompt. It appears because the head's checks are green
(or it is ungated), it stays there until you press it, and pressing it runs
`gh pr merge --merge`: the PR lands on `dev` as a **merge commit**, co fetches so
it sees the moved `origin/dev`, the feature's local worktree is torn down, the
queue advances, and the next feature rebases onto the `dev` you just moved and
has its own PR checked against it, so its `[m]` lights up when it goes green.
Nothing is armed, nothing expires, and the co-manager is not involved in any of
it: it never opens the merge, never waits on your keypress, and its agent loop is
free the whole time. The PR is a normal PR while it waits — retitle it, rewrite
the description (on GitHub, or with `e` without leaving the panel), comment on
it, review the diff on GitHub. Re-processing only
rewrites the fenced evidence block co owns; your edits stay.

The co-manager is pulled in for exactly one case: a head that comes back
**blocked** — a rebase conflict, a red CI check, or a missing prerequisite
(no `gh`, gh not authenticated, no `origin/dev`). That head shows the block
instead of an `[m]` and holds the queue, and the co is told automatically, so
you don't re-explain it. For a conflict or a red check it can send a fresh crew
agent into that feature's own worktree to rebase and fix it (never `dev`) —
confirm-gated like every dispatch, and bounded to three attempts, after which it
stays blocked for you to fix by hand or abandon. The order that agent gets names
the failing checks and links their runs; it does not name a build command,
because co does not know one.

One consequence of the gate being GitHub's: a red state now reaches the forge.
It has to — the checks that judge it are the forge's, and they cannot run on a PR
that does not exist. So a blocked-by-checks head has already pushed and opened
its PR, which is also where you read what went wrong. Nothing red ever *merges*;
that is still guaranteed, by the queue's ready gate and by the pins below.

**Why a PR and not a local merge.** `dev` is normally checked out in your own
tree, and git refuses to write a ref that is checked out; a local merge also
means co holding the only copy of the integration branch. Merging on the forge
removes the write entirely — co never touches your `dev` checkout, never writes
the local `dev` ref, and learns that `dev` moved the same way you would, by
fetching. Three rules are wired in rather than left to configuration: the merge
is always `--merge` (a merge commit, so the feature branch stays visible in the
graph and the crew's per-job commits survive), the branch ref is always **kept**
(only the local worktree is torn down — `--delete-branch` is never passed), and
the checked tip is the merged tip (the PR's head on GitHub is compared against
the sha the checks ran on, and a mismatch refuses the merge).

Prerequisites: the `gh` CLI installed and authenticated, an `origin` remote, and
a `dev` branch on it. co never creates `dev` — if it is missing it says so and
stops. `main` is still never written by anything here: promoting `dev` → `main`
is your own PR, by hand.

The job — the `cd` into the repo, the agent command, the (possibly multi-line)
order text, completion bookkeeping — is written to a **per-job script file**
under `.dispatch/captures/` (named with the job id plus a per-session tag plus a
per-dispatch random nonce, so jobs from different sessions never collide and even
the same order re-run back-to-back never shares a capture file or completion
marker), and the pane only ever receives a launch of that file. A fresh split is
created already running it (Ghostty's surface `command`), so nothing is typed
into a new pane at all; the script ends by exec'ing a login shell, so that
freshly-split pane stays open and reusable instead of closing when the job
exits. Taking over or reusing an existing pane pastes a single short
`/bin/sh '<script>'` line instead. The order itself never travels through the
keystroke stream, so newlines and quotes in an order can't be re-interpreted by
whatever the pane is doing. If the pane doesn't start the job within about four
seconds (something else — an editor, another agent — owns it), the dispatch
fails cleanly and launches nothing rather than running the agent somewhere you
can't see. The script's very first act, before the capture file even exists, is
writing down where it is: the pane's tty and the pid of the shell that will still
be there when the job is done. That sidecar is the only way co ever learns what a
pane is — Ghostty won't say — and it is what makes reusing that pane later a
measurement rather than a guess. The co-manager's own `PATH` is baked into the script, because a
command-launched Ghostty surface otherwise inherits only the bare GUI `PATH` and
wouldn't find a user-installed agent binary.

Inside the script the agent runs attached **directly to the pane's terminal** —
no recorder, no pipe, nothing interposed — so a dispatched pane behaves exactly
like one you opened yourself: correct rendering, native keybindings
(Shift+Enter newline included), live resize. Because nothing records that
terminal, the reviewable record of a pane run is the agent's **own session
transcript**: for Claude Code, the session JSONL under its config dir
(`CLAUDE_CONFIG_DIR` parsed from the agent command; `~/.claude` by default).
The co locates it two ways, in order of trust: the completion hook (below)
hands back the exact transcript path for that session, so there's no guessing;
absent a hook path, the transcript is identified by content — the dispatch
order is the session's first prompt — so concurrent jobs in the same repo each
resolve their own record. Either way the co reviews message text and tool calls
instead of terminal escape soup. If no transcript can be read (a non-Claude
agent, say), the review falls back to the hook's captured last message, then to
the capture file, and says plainly when a run left no recording.

**The crew's completion report is never cut.** Whatever its length, the crew's
last message reaches the review whole — it is the one thing an order asks the
crew to close with a diffstat, its verification output, and the approaches it
dropped, and half of that is worse than none. What the co bounds is the run
*around* it: the earlier context, and a build log that would otherwise arrive by
the megabyte. Every one of those bounds names itself in the record it hands over
(`…[co: 400 of 9812 bytes shown]`), so a short record is never mistaken for a
short run.

A bad repo path fails the `cd` loudly and gets captured instead of silently
running the agent somewhere else. An interactive pane hands back no clean exit
code, so completion is detected by
a sentinel rather than by waiting on a process: a `__CO_DISPATCH_DONE__ <code>`
line is appended to the capture file, and the watcher tails each capture for
that marker (a nonzero code marks the job failed, zero marks it done). If the
code can't be read it records `-1`.

For a Claude Code crew the marker arrives the moment the agent **first finishes
responding**, via a `Stop` hook — so the review lands with the pane still open
and usable, and you never type `/exit` to trigger it. On the first dispatch to
each agent the co installs the hook idempotently into that agent's own
`settings.json` (merging one entry, never clobbering your other settings or
hooks), and it hands the crew process two environment variables identifying the
job's capture. When the agent finishes, the hook writes a sidecar
(`<job>.stop.json`, carrying the session id, transcript path, and last message)
and appends the sentinel. It is **fire-once**: the sidecar is created with an
exclusive open, so the first finish wins and every later turn you type in that
same pane is a no-op — no second capture, no re-notification. The hook is
observe-only (it always exits 0 and never blocks), so a dispatched session stays
fully interactive after its result has been captured.

Because the hook fires while the agent is still live in its pane, completion and
pane reuse are kept separate: the review lands immediately, but that pane is not
offered to a later dispatch until the crew process actually exits. The per-job
launch script deletes itself as its last act, so its absence is the signal that
co's own hold on the pane is over — until then a new dispatch splits rather than
pasting a launch line into a running agent. That is only co's half of the
question, though: even once co lets go, the pane still has to *look* idle when
the next dispatch reads it, so an agent you keep talking to, or anything else you
start in there, keeps it yours. Close the crew when you're done with it and the
pane rejoins the reusable set on the next poll (or the next dispatch that needs
it).

Even without the hook the run still reports: the script wrapper writes the
sentinel with the crew's real exit code when the agent process exits, and it
survives the ways humans actually close an agent — Ctrl-C is trapped so the crew
handles its own interrupt while the wrapper lives on to report, and a torn-down
pane (HUP) or kill (TERM) still writes the sentinel before dying. So a
non-Claude agent, or a Claude whose hook couldn't be installed, simply reports
when the pane closes, exactly as before.

### Commit messages carry no attribution

Every order the co writes ends with the exact commit message it wants and an
explicit instruction to use that message and nothing else — no `Co-Authored-By`,
no "Generated with", no agent or tool signature. The same instruction is baked
into the resolver order the merge queue sends into a blocked head. That is the
whole of what comanager controls: the order text is the lever, because the
commit itself is made by the coding agent, in its own process.

Pull request messages follow the same rule, and there comanager owns the text
outright: the title and description the co-manager writes for a PR say what the
work does and why, and nothing about how it was produced — no signature, no
"opened by", no mention of co or the crew anywhere in them.

If your agent still signs its commits, that is its own default, not comanager's.
For Claude Code the switch is `"includeCoAuthoredBy": false` in the settings.json
of the config dir that agent runs with (`~/.claude`, or e.g. `~/.claude-work` for
a `CLAUDE_CONFIG_DIR=`-prefixed command) — the same file the crew Stop hook is
merged into. comanager deliberately does **not** set it for you: it is a global
preference for every commit you make with that agent, in every repo, and flipping
it as a side effect of linking a repo would be a surprise.

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

## What a turn costs

Every turn is metered. Nothing is printed while you work — no running total, no
warning, no nag — and the whole thing surfaces in one place, `/cost`:

```
cost
  session    5,749 out          $0.4864     3 turn(s)
  today      5,749 out          $0.4864     3 turn(s)
  all time   55,249 out         $3.51       28 turn(s)

  per day    $0.7015 per active day (5) · $0.5011 per calendar day (7)
  last 7d    ▅▃·█▃·▄  $3.51  (07-21 → 07-27)
  model time <1s this session · 3m 58s all time

  session tokens: in 626 · cache write 23,592 · cache read 45,092 · out 5,749
  us.anthropic.claude-opus-4-8 — bedrock $6.00/$30.00 per Mtok · cache write $12.00 (1h) · cache read $0.60
  since 2026-07-21 · last turn 2026-07-27 14:22
```

Output tokens lead because that's the number you can hold onto. The dollar
figure is computed from all four classes Bedrock bills separately, and it has
to be: this app re-sends a ~22k-token prefix every round trip, so the prompt
side dominates. In the session above, output was 35% of the bill; on a cold
first turn, where the whole prefix is written to cache at the 2x rate, it was
5%. A meter that priced output alone would be wrong by most of the invoice.

**Two daily averages, because one of them is always the misleading one.** Per
*active* day answers "what does a working day cost me"; per *calendar* day
answers "what is this costing me to run". An instance used hard on five days
out of thirty has a very different number for each, and showing only one
invites the wrong conclusion. The `last 7d` sparkline is there so a spike or a
trend is visible without reading a table — and a day with no turns is a gap
(`·`), never a short bar, because "I didn't work" and "I worked cheaply" are
different facts and flattening them is how an average starts lying.

Days are bucketed in **your** timezone, not UTC. A session at 6pm Pacific is
already tomorrow in UTC, and a meter that filed an evening's work under the next
day would tell someone who'd been working since breakfast that today cost them
nothing.

`model time` is wall-clock spent inside `runTurn` — the time you actually spent
waiting. It's banked in a `finally`, so a turn that errors out still counts the
time even though it billed no tokens.

The rates in `src/cost.ts` are **Bedrock's, not Anthropic's first-party list**.
The same Opus 4.8 that costs $5/$25 per million on the Anthropic API costs
$6/$30 here, so pricing against the first-party table would understate every
invoice by 20%. A model with no rate on file still gets its tokens counted;
`/cost` says the cost is unknown rather than inventing a number, and adding a
model is one line.

### One key, many co-managers

`/cost` is scoped to the co-manager you're in, because that's where its ledger
lives. That answers "what has this one cost me" and cannot answer "what am I
being billed" — the Bedrock key is shared, so every instance lands on one
invoice. `co cost` is that view, and it needs no session:

```
cost across 3 co-managers

  co-manager  out           cost        turns   last
  gav-lib     14,030        $0.9931     5       2026-07-27 14:49
  dotcor      0             $0.0000     0       —
  testing     0             $0.0000     0       —
              ────────────────────────────────
  total       14,030        $0.9931     5

  per day    $0.9931 per active day (1) · $0.9931 per calendar day (1)
  last 7d    ······█  $0.9931  (07-21 → 07-27)
  model time 2m 53s all time
```

Rows are ordered by spend, so a surprising total is attributable at a glance.
Idle instances are listed rather than hidden — "this one has cost nothing" is
information, and omitting it makes the fleet look smaller than it is.

The totals live in `.cost.json` at the instance root, written after every turn
rather than at exit, so a crash never loses the record of money already spent.
It holds two things: an all-time aggregate per model that is never trimmed, and
a rolling per-day series capped at 400 days. Ageing a day out of the series
never touches the aggregate, so the all-time figure stays exact even once the
daily detail behind it is gone. A ledger written before the series existed loads
with its totals intact and an empty series — per-day figures start from the
upgrade rather than being back-filled with numbers we can't know.

Only turns this app makes are counted — crew panes run Claude Code and bill
against your Claude Code account, not the Bedrock key, so they can't appear
here.

## Architecture notes

`src/` is one level deep: shared primitives and the bin entry sit at the root,
and everything else groups by feature. No barrel files — imports name the file
they want, so a cold start only loads what it uses.

```
src/
  index.ts config.ts paths.ts ui.ts model.ts research.ts cost.ts
  cli/       auth.ts doctor.ts modelsdoctor.ts link.ts cost.ts
  tui/       tui.ts editor.ts markdown.ts wrap.ts keys.ts banner.ts
             commands.ts visuals.ts
  session/   session.ts prompt.ts tools.ts reviewinbox.ts
             crewpanes.ts paneoccupancy.ts panestore.ts
             dispatchconfig.ts transport.ts registry.ts
             worktrees.ts forge.ts checks.ts landing.ts landinggate.ts
             mergequeue.ts features.ts featurestore.ts taskstore.ts
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
- **`src/cost.ts`** — the spend meter: Bedrock rate table, four-class pricing,
  the durable per-instance ledger, and the `/cost` report. Silent by design;
  `model.ts` feeds it and nothing else reads it.

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
executor that binds tools to memory + research; it holds the decision gate, the
arm-only `dispatch_order` tool, and the `file_review` tool.

`reviewinbox.ts` is the review record and its volume knob. A crew review used to
be nothing but the co talking, so it neither survived the session nor varied in
loudness with how much it mattered. Now `file_review` writes a structured record
(job, feature, verdict, level, headline, body) into a capped rolling list — the
last 20, newest first, persisted as JSON under the instance's `.dispatch/` and
loaded at session start, so the inbox is populated before the panel is ever
opened. Writes ride the shared memory write queue, so a whole-file rewrite can't
interleave with the other tool calls of one model round. The same module owns the
chat gate as one pure function: L2 returns exactly one dim pointer line, L1 and
L3 return none (L1's signal is the co's own next sentence — the decision the
captain has to make), and the body reaches the chat at no level.

The dispatch layer is six focused modules. `crewpanes.ts` is the pure pane-
placement planner (reuse a proven-idle pane first, else alternating splits of the
newest *living* pane, direction sequence configurable) with no I/O; it exposes
its tracked pane ids and a `prune` so a closed pane is dropped, and an emptied
worker box falls back to splitting the anchor. Whether a pane IS idle never
reaches it as an opinion — it arrives as a list of ids proven free at that
instant, so placement can't drift out of date with the screen.

`paneoccupancy.ts` is where that proof is made, and it exists because Ghostty's
scripting dictionary exposes a terminal's `id`, `name` and `working directory`
and nothing else: no tty, no pid, no "is it at a prompt". So the per-job launch
script reports the pane's tty and the pid of the shell that outlives the job, and
this module reads that tty's process table (`ps -t`) and calls the pane idle only
when every process on it is a shell (or the `login` a Ghostty pane bootstraps
through). The recorded shell pid must still be alive on that tty, which is what
binds a recycled device name back to the pane co thinks it is. The verdict is a
pure function over (does it exist, is it leased, what is its identity, what is
running) so the whole decision is unit-tested with the process lookup stubbed;
the asymmetry is wired in rather than left to callers — an unreadable table, a
pane with no record, a dead shell and a failed probe all come back "not free",
because a false occupied costs one split and a false free costs the captain's
work. `panestore.ts` is the durable half: which panes co owns, each one's tty and
shell pid, and co's own lease on it, under `.dispatch/panes.json`. A lease is
believed only while the process holding it is alive, so a co that was killed
leaves stale claims that are swept at load and before every dispatch rather than
panes that are blocked forever.

`dispatchconfig.ts` reads/writes the
per-instance `.dispatch/config.json`, resolves which named crew agent a dispatch
uses (default or `confirm <name>` override), and resolves that agent's command
into a runnable shell command line (git-style: the template runs verbatim, only
the substituted `{prompt}`/`{repo}` values are shell-quoted). `transport.ts` has
the one launcher — a Ghostty/AppleScript visible-pane path that consumes the
planner and delivers each job as a per-job script file, with a capture-file +
completion-sentinel contract. There is no background/headless launcher by
design: a pane that can't be placed raises a `PaneUnavailableError` and the
dispatch fails cleanly. `registry.ts` owns in-flight jobs: it launches into a
pane, polls captures for the sentinel, enforces timeouts, mints a unique capture
key per dispatch, and fires a completion callback, all non-blocking. It is also
what surveys the panes before each dispatch — asking Ghostty which of them still
exist and `ps` what is running in the survivors — and so is where the two halves
of pane hygiene meet: a pane the captain closed is pruned from the layout and the
store, and a pane that answers "here, and idle" to both questions is handed to
the planner as reusable. Reactively, a pane that dies between that survey and the
launch is pruned and the placement re-planned against the survivors, and one that
turns out to be busy after all (the transport's launch probe catches it) is
dropped from the offer and the dispatch splits instead. One dead worker costs one
pruned id, never the whole layout.

`worktrees.ts` is the git-worktree lifecycle harness for the
parallel-dispatch feature: verify the `origin/dev` integration branch is
reachable (verify only — co never creates `dev`, locally or on the remote),
provision a per-feature worktree on a fresh `<type>/<slug>` branch cut from
`origin/dev` (running the repo's own frozen install so the worktree owns its
dependencies outright — an earlier build symlinked `node_modules`/`dist` back to
the primary tree instead, and a crew agent's routine `npm ci` followed the link
and emptied the captain's), tear a finished feature down (after a PR merge the
worktree goes and the branch ref is kept; on an explicit abandon, branch
deletion is guarded by a merge-base check against `origin/dev`, so unmerged
work is never destroyed), and a reconcile sweep that cleans zombie checkouts
left by a crashed run. The local `dev` ref is never read or written by any of
it — the integration ref everything compares against is the remote-tracking
`origin/dev`, advanced only by `git fetch`. Feature worktrees live outside the repo, by default in a sibling
directory `<repo>-worktrees`.

**Branch names are ordinary, and ownership does not depend on them.** A feature
branch is `<type>/<slug>` with a Conventional Commits type the co picks for the
work (`feat/user-auth`, `fix/stale-token`, `docs/orders-protocol`; `feat` is the
default), so the branch list reads like any developer's. That means the name
proves nothing about who cut it, and co never treats it as if it did: a feature
is **the registered worktree co created under the managed base dir**, one
directory per slug, and its branch is whatever that worktree has checked out.
Every write — teardown, abandon, the boot rebuild — resolves the branch from
there, so a `feat/login` of your own, in your own tree, is invisible to all of
it. Branches co cuts are also stamped in the repo's local git config
(`branch.<name>.comanager-feature`), which outlives the checkout and lets the
read-only reconcile still report a branch whose worktree went missing; that
marker reports, it never authorises a delete. Features from before this scheme
(`co/feat-<slug>`) are recognised by exactly the same worktree rule and are
never renamed.

Deterministic plumbing; the registry consumes
it for feature-scoped dispatch: a dispatch scoped to a feature provisions the
worktree on first use (reused for every later dispatch to that feature),
launches the crew process with the worktree as its working directory on both
transports (an agent binds to a checkout by being launched inside it), and
records the job-to-feature link on the job. One live agent per worktree at a
time; a plain dispatch keeps its repo cwd untouched.

`forge.ts` is everything that talks to the remote: `git fetch`, `git push`,
and the `gh` CLI. Its whole design is one injectable command runner, so the
entire remote surface is unit-tested with no network, no gh binary and no
GitHub account — production passes nothing and gets a plain `spawn`. It also
encodes the rules rather than leaving them to callers: the merge is always
`gh pr merge --merge`, `--delete-branch` is never passed, a force push always
carries a lease on the sha actually observed, and a PR update rewrites only
the fenced evidence block co owns so a captain's edits to the title or the
description survive. The fence reads both ways: `spliceEvidence` writes co's
block into a body, `splitEvidence` takes it back out, which is how the panel gets
a description it can paint without the markers or a second copy of the checks.
`updatePrMessage` is the mirror of the evidence update — it rewrites the title
and the prose and carries the existing block across byte-for-byte, so the two
halves of a PR body can each be rewritten without the other ever being clobbered,
and no path can leave a body with two fences or none.
It is also where the merge gate is *read*: `readPrChecks`
asks `gh pr checks --required` first (branch protection decides, exactly as it
does for a human) and falls back to every check the PR reports. Two details of
gh's real contract are encoded here because both are easy to get backwards, and
both were verified against the binary: with `--json`, gh exits **0 even for
failing checks** (the verdict is in the per-check `bucket`, never the exit
code), and it exits **1 with "no checks reported"** when there is nothing to
report — which is the *ungated* case, not a failure. Any other nonzero exit is a
real fault and throws.

`checks.ts` is the policy over that read: bucket counting into one verdict
(`passed` / `failed` / `pending` / `none`, where a red beats a pending and a
skipped check does not block, as on the forge), and the bounded poll that waits
out checks still running. Two deadlines, because "still running" and "not there
at all" are different questions: pending checks are waited on up to the timeout,
while "no checks reported" is only waited on for a short grace window, and only
right after a push — the one moment GitHub might not have registered a workflow
run yet. Everything is injectable (timeout, interval, grace, and the sleep
itself), so the whole poll is unit-tested without wall-clock.

`landing.ts` is the landing engine that lands a finished feature in `dev`,
split in two so a human gate can sit between checking and merging.
`prepareLanding` fetches, rebases the feature branch onto the fresh
`origin/dev` tip in its own worktree, pushes it, opens or reuses its PR, and
reads that PR's checks. The rebase comes first because feature A green and
feature B green does not make A+B green, and GitHub's `pull_request` workflows
test a merge of the PR head with its base — so the checks that gate the merge
see the tree `dev` will hold. Four outcomes: `green` (checks passed, or the PR
has none at all — a ready head flagged **ungated**), `conflict` (the rebase is
aborted and the branch restored byte-for-byte; nothing is pushed and no PR is
touched), `failed` (a check went red), and `pending` (the bounded wait ran out
with CI still running). Unlike the old local build+test, `failed` and `pending`
have *already* published — the checks that judge them are the forge's and cannot
run on a PR that does not exist — and the branch is deliberately left rebased so
a fix dispatch lands in the exact state CI failed on. The evidence block is
written twice for the same reason: once when the PR is created, saying the
checks are the gate, and once more with what they said. The PR's message is
composed in one place here (`composePrMessage`): the co's authored title and body
when the feature carries them, and the mechanical rules — the commit subject, or
`<type>: <feature>`, plus a one-line summary — for whichever half it does not,
per field. An authored title is folded to one line before it reaches gh, and an
authored body is re-split against the evidence fence on the way through, so
nothing the co wrote can freeze a stale copy of the checks into the description.
The authored message is only ever used to CREATE the pull request; an open one
keeps the title and prose it has, and re-processing touches nothing but the
fenced block. `executeLanding` is the
separate callable that does the merge: `gh pr merge --merge`, a fetch, then
teardown of the local worktree with the branch ref kept. It is pinned three
ways — the checked tip, the `origin/dev` it was checked against, and the
reviewed PR — so a stale green, a branch that grew commits, or a PR head someone
else moved all fail loudly instead of merging something nobody checked. The
local `dev` ref is never written.

`landinggate.ts` is the human gate for the direct `feature_land` route:
`reviewLanding` prepares a feature and presents the result in the panel as a
summary (commits, changed-file count, the PR it opened), the full paged diff,
and an action bar. Pressing `m` there merges that PR, pinned to the exact sha
the review covered, so approval can never merge more than what was shown;
`r`/Esc dismisses with no merge, leaving the PR open and the branch and
worktree intact. A conflict, a red check or a still-pending check opens the gate
too, showing why the feature is not mergeable with `m` disabled. `main` stays
human-only throughout.

`mergequeue.ts` is the serial merge queue, and the normal route into `dev`.
Features the captain marks done join an ordered queue; only the HEAD is ever
worked, and it works itself out — `prepareLanding` rebases it onto the fresh
`origin/dev` tip, pushes it, PRs it and reads that PR's checks, leaving it
`ready` (green, or ungated when the PR reports no checks), `awaiting-checks`
(CI still running — a wait, not a failure), `blocked` (a rebase conflict, a red
check, or a missing prerequisite), or `resolving`. Everything behind the head
sits untouched, so nothing is ever speculatively pushed. The head's PR message is
read out of the feature store on every processing rather than captured at enqueue
time, so a retry, a resolver run and the queue advancing after a merge all compose
the pull request the co actually wrote.

**The merge is panel-native, not a co tool call.** A `ready` head simply
*carries* an `[m]` in the Ctrl-O queue tab, alongside its pull request, commit
list and checks result. Pressing it calls `mergeReadyHead` directly: the PR
merges, the worktree is torn down (the branch ref kept), the queue advances, and
the new head is processed against the `origin/dev` that merge just moved — so
the next `[m]` is live (or the next block is on screen) by the time the key
finishes. The
co-manager is not in that loop at any point: it opens nothing, waits on
nothing, and is not blocked on the keystroke. It is engaged again only when a
head comes back **blocked**, which reaches it automatically so it can offer the
resolver without you re-explaining anything. This replaced an earlier shape
where a co tool call opened a gate and held the model's turn open until you
pressed a key — coupling the agent loop to a human keypress.

`features.ts` is the co-facing lever layer: the small verb set the model
calls to drive the harness end to end. `feature_create` provisions a feature's
worktree off `origin/dev` and registers it (idempotent, no confirm gate — it
writes nothing to dev or main); a dispatch can target a feature so the crew runs in
its worktree (provisioned on first use), and the arm banner names the target
worktree or says plainly it targets the bare main tree. `feature_enqueue` marks
a feature done and puts it in the merge queue, which is where landing normally
happens — and carries the PR title and body the co wrote for it, as its own
`prTitle` and `prBody` arguments, stored per slug and consumed by every later
processing of that head, so the authored message is attached once, at the one
moment a feature is declared done, and no model runs inside the queue; each half
is optional and falls back to the mechanical composition on its own, and the call
reports back which half is authored and which is mechanical, so a bare re-enqueue
visibly reuses the message already written. `feature_land` is the direct route
for a feature that was never enqueued, and opens the gate above.
`feature_merge_head` is **not** the merge:
in an interactive session it merges nothing and just reports that the `[m]` is
live, and it only performs a merge itself in a session with no panel at all
(piped/non-TTY), where there is no key to press. `feature_resolve_head` arms a
fresh crew agent, in the blocked feature's own worktree and never on dev, to
rebase and fix it — confirm-gated like every dispatch and bounded to three
attempts, after which the head stays blocked for you.
`feature_list`/`feature_status` read the registry; `feature_abandon` tears a
clean worktree down but refuses one with uncommitted changes and never
force-deletes an unmerged branch. At session start a non-destructive reconcile
(`reconcileFeatures`) rebuilds feature records from the on-disk worktrees so a
feature survives a restart, and surfaces anomalies (a branch holding unmerged
work whose worktree is gone, a stray directory) for the co to relay rather than
acting on them — a branch already contained in `origin/dev` with no worktree is
not an anomaly at all, it is what every landed feature leaves behind now that
refs are kept. The co's reach stops at the PR into `dev`: it never touches
`main` and there is no promote path.

`overview()` is the same module's read side for the Home tab's worktree list:
every tracked feature as one row — handle, branch, stored intent, and a
single-word state derived in memory from the record's provision status, the merge
queue and the registry's jobs (provisioning first, then the queue, then a live
crew agent), ordered closest-to-landing first. No git call and no model call, so
the panel can re-read it on every paint. The one thing it cannot derive for free
is whether a worktree is dirty, which costs a `git status` each: that lives in a
cache `refreshDirty()` fills, and the panel asks for a refresh when you open Home
and never on a paint. An unread worktree reports no dirty state at all rather
than reporting clean.

`featurestore.ts` is the durable half of a feature record. Git rebuilds
everything else about a feature from its worktree, but not the prose the co
wrote about it — the intent saying what it is FOR, and the PR title and body it
composed when it marked the feature done — so both are persisted per slug in
`.dispatch/features.json` — beside the dispatch config and the review inbox,
never inside the repo or the worktree — and read back at session start, which is
what lets a recovered worktree still show its description and a re-processed head
still open its pull request with the message the co wrote. Every field is an
independent override: setting one leaves the others alone, and omitting one never
wipes it, which is what makes a bare re-enqueue a retry rather than a reset. An
older store written before the PR message existed reads back unchanged. It is a
cache of authored prose and behaves like one: a missing or corrupt file is an
empty store, a body is stripped of anything resembling co's evidence fence before
it is written, and a write that can't land costs a description, never a create, a
merge or a teardown. The one field that can be *erased* is the PR message, and
only by the captain's own edit in the panel: an omitted field is still never
touched (that is what makes a bare re-enqueue a retry), but a description they
deliberately deleted is deleted, so it cannot come back the next time a pull
request is created for that feature.

`taskstore.ts` is the same idea for the co's at-a-glance task table: a small
ordered list of `{task, type, status}` under `.dispatch/tasks.json`, beside the
feature store. The table always existed, but only as prose the co re-printed into
the chat from its own memory, which left the panel nothing to render. It is
written WHOLE through one model-facing tool (`task_table`) — no per-row add or
update, no ids — because the co re-derives the handful of rows anyway and a
partial write is only a way for the store and the co's belief about it to
diverge. Junk rows are dropped, cells are folded to one line, the list is capped,
and a write that had to truncate says so in the tool result rather than letting
the co assume it stored everything. A missing or corrupt file is an empty table,
never a failed start.

**`src/tui/`** — the full-screen terminal UI: transcript buffer + scrolling,
the multi-line line editor, markdown → ANSI rendering, ANSI-aware wrapping,
and the Ctrl-O panel. The panel has four home tabs — home (the task table over
the worktree overview), the merge queue, the doc viewer, and the review inbox —
listed in a persistent bar across the top and reached by Tab, `i`, or the digit
the bar shows beside each. Each reads a small injected source, so the Tui never
reaches into git, the filesystem, or the session layer itself; `panelFrame()` is
the one switch behind the paint, the bar and the drag-copy alike, so no view can
be painted from one tab and labelled as another. The queue tab renders the ready
head's pull request —
its checks evidence, then its message (title, description, commits) as its own
block — and owns the `[m]` that merges it, through an injected `merge`
callback that is the only thing the keystroke can reach. It composes none of
that: the title and description come off the PR, split from co's evidence fence
by the source (`splitEvidence`), so the panel and the pull request cannot drift
apart. `e` on that tab opens the same message in a popup EDITOR over it, through
a second injected callback (`editPrMessage`) that is likewise the only thing that
keystroke can reach — one buffer in `git commit` shape, prose only, saved with
Ctrl-S and never merging anything. The home tab is
read-only by construction (no selector, no `[m]`, it only pages), which is what
lets the panel open on it: the tab a keystroke lands on by default can never be
the thing that merged something. A pending `feature_land` review
gets a fifth tab of its own for as long as it is pending, so the two merges never
share a key. A doc and a filed review drill into the same paged body view. The
panel body is one selection surface: a left-drag highlights and copies out of any
view over OSC 52 (the same escape the transcript's own drag-selection uses), and
an open doc additionally binds `y` to copy its raw markdown whole.
`keys.ts` is the pure decode table that maps both legacy control bytes and
enhanced-protocol CSI-u sequences onto one set of bindings. `editor.ts` is the
buffer model under both text editors on the screen — the input bar and the PR
message popup: the word wrap, the cursor↔(row, col) mapping that keeps a caret
where it visually appears on a wrapped line, the viewport-follows-cursor rule,
the editing verbs, and the `git commit`-shaped title/body split. Two editors on
one screen must not disagree about where a line breaks or what Ctrl-U does, so
the rules live in one pure, unit-tested module and both surfaces are thin
key-routing layers over it.

The split inside that module is deliberate too. The *pure functions* (the wrap,
the caret mapping, the scroll rule, the title/body split) are what both editors
share. The `TextEditor` class on top of them is the popup's alone: the prompt bar
keeps its own buffer and cursor in `tui.ts`, which is what let the popup grow a
selection model, a select-all and a clear-all with no path by which any of it can
reach the prompt line. That selection is stored as buffer OFFSETS rather than
screen cells, unlike the panel's drag-select, so it survives a re-wrap and
therefore a terminal resize: the same characters stay selected at the new width
instead of the selection having to be dropped. `tui.ts` is
deliberately one large file: the render loop, input handling, and scroll state
share mutable state, and splitting them across modules would mean exporting
that state rather than encapsulating it.

`visuals.ts` holds the two nautical animations and, more importantly, the
predicate that decides whether a terminal may have them at all (`CO_VISUALS` as
a ceiling, every environment signal as a one-way ratchet down to a static ASCII
line). The split is deliberate: `visuals.ts` decides WHAT is drawn — frames,
glyph set, the one accent, and the static line that carries the same
information; `tui.ts` decides WHEN, owning a fixed-height region above the input
bar with its own ~11fps timer. That region is re-rendered at the current width
on every frame, so a resize re-lays it instead of tearing, and it refuses to
open at all while a stream is in flight, while the Ctrl-O panel is up, or on a
screen too small to spare the rows — with `appendStream` killing a running
animation from the other direction, so "never during token streaming" holds
whichever happens first.

**`src/cli/`** — `doctor.ts` and `modelsdoctor.ts` diagnostics, `auth.ts` for
writing the Bedrock token, `link.ts` for `co link` (register repo + agent
command) and `co pane` (designate the crew anchor pane), and `cost.ts` for
`co cost` (spend across every instance, no session needed).

### V1 scope and extension points

Deliberately out of scope for V1 (with clean seams left for later): a richer
research protocol enforced in-runtime, automatic time/size-based log archiving,
GitHub/Stack Exchange source providers, and multi-instance cross-linking. The
provider abstractions (`ModelProvider`, `SearchProvider`, `Fetcher`) and the
`ToolSideEffects` tracking are the extension points.

## License

MIT
Conflict-test marker: ALPHA channel.
Conflict-test marker: BETA channel.
