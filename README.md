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
- **Two small nautical moments** mark the two points where the session is doing
  something and would otherwise sit still. Firing a confirmed dispatch runs the
  order out to sea above the input bar, over the branch it's headed for
  (`≈≈▸ dispatching → co/feat-auth`); `/exit` sails a ship across the width once
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
co/feat-auth`, `~~ saving... fair winds`. Every glyph is one column of ASCII or
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
        └── .dispatch/          crew-dispatch state (only after `co link`)
            ├── config.json        repo path, named agent commands, caps, pane layout, anchor
            ├── inbox.json         the last 20 crew reviews, newest first (Ctrl-O → Inbox)
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
beside/below, up to a cap (default 4) after which the oldest finished pane is
reused or the job queues. The split direction sequence and the cap are config
values you can retune. Requires Ghostty 1.3+ and a one-time macOS Automation
permission (granted the first time it scripts Ghostty).

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

### Landing work: one keystroke, `[m]`

Finished features land on a local `dev` branch through a strictly serial merge
queue, and the queue does the work itself. Only the front of the line is ever
touched: it rebases onto the current `dev` tip and runs your build+test on that
combined state (feature A green and feature B green does not make A+B green).
When that comes back green, the **Ctrl-O queue tab** shows the head's diff, its
commits and the build+test result, with a live `[m]` beside them.

`[m]` is a state, not a prompt. It appears because the head is green, it stays
there until you press it, and pressing it merges — the merge commit lands on
`dev`, the feature's worktree and branch are torn down, the queue advances, and
the next feature rebases and tests itself against the `dev` you just moved, so
its own `[m]` lights up when it goes green. Nothing is armed, nothing expires,
and the co-manager is not involved in any of it: it never opens the merge, never
waits on your keypress, and its agent loop is free the whole time.

The co-manager is pulled in for exactly one case: a head that comes back
**blocked** — a rebase conflict, or a red build+test. That head shows the block
instead of an `[m]` and holds the queue, and the co is told automatically, so
you don't re-explain it. It can send a fresh crew agent into that feature's own
worktree to rebase and fix it (never `dev`) — confirm-gated like every dispatch,
and bounded to three attempts, after which it stays blocked for you to fix by
hand or abandon.

All of this is local. The merges are ordinary local commits on a local `dev`;
nothing is fetched, pushed, or turned into a PR at any point, and `main` is
never written by anything here.

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
can't see. The co-manager's own `PATH` is baked into the script, because a
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
the pane is back to an idle shell and safe to reuse — until then a new dispatch
that hits the pane cap splits or queues rather than pasting a launch line into a
running agent. Close the crew when you're done with it and the pane rejoins the
reusable set on the next poll (or the next dispatch that needs it).

Even without the hook the run still reports: the script wrapper writes the
sentinel with the crew's real exit code when the agent process exits, and it
survives the ways humans actually close an agent — Ctrl-C is trapped so the crew
handles its own interrupt while the wrapper lives on to report, and a torn-down
pane (HUP) or kill (TERM) still writes the sentinel before dying. So a
non-Claude agent, or a Claude whose hook couldn't be installed, simply reports
when the pane closes, exactly as before.

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
             visuals.ts
  session/   session.ts prompt.ts tools.ts reviewinbox.ts
             crewpanes.ts dispatchconfig.ts transport.ts registry.ts
             worktrees.ts landing.ts landinggate.ts mergequeue.ts features.ts
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

The dispatch layer is four focused modules. `crewpanes.ts` is the pure pane-
placement planner (anchor takeover, alternating splits of the newest pane, cap +
reuse-oldest, all configurable) with no I/O. `dispatchconfig.ts` reads/writes the
per-instance `.dispatch/config.json`, resolves which named crew agent a dispatch
uses (default or `confirm <name>` override), and resolves that agent's command
into a runnable shell command line (git-style: the template runs verbatim, only
the substituted `{prompt}`/`{repo}` values are shell-quoted). `transport.ts` has
the one launcher — a Ghostty/AppleScript visible-pane path that consumes the
planner and delivers each job as a per-job script file, with a capture-file +
completion-sentinel contract. There is no background/headless launcher by
design: a pane that can't be placed raises a `PaneUnavailableError` and the
dispatch fails cleanly. `registry.ts` owns in-flight jobs: it launches into a
pane, polls captures for the sentinel, enforces timeouts, drains the pane queue,
mints a unique capture key per dispatch, and fires a completion callback, all
non-blocking.

`worktrees.ts` is the git-worktree lifecycle harness for the
parallel-dispatch feature: ensure a `dev` integration branch exists (created
off `main`, create-only), provision a per-feature worktree on a fresh
`co/feat-<slug>` branch cut from `dev` (with `node_modules`/`dist` symlinked
from the primary tree so it builds without an install), tear a finished
feature down (branch deletion is guarded by a merge-base check, so unmerged
work is never destroyed), and a reconcile sweep that cleans zombies left by a
crashed run. Feature worktrees live outside the repo, by default in a sibling
directory `<repo>-worktrees`. Deterministic plumbing; the registry consumes
it for feature-scoped dispatch: a dispatch scoped to a feature provisions the
worktree on first use (reused for every later dispatch to that feature),
launches the crew process with the worktree as its working directory on both
transports (an agent binds to a checkout by being launched inside it), and
records the job-to-feature link on the job. One live agent per worktree at a
time; a plain dispatch keeps its repo cwd untouched.

`landing.ts` is the landing engine that moves a finished feature onto `dev`,
split in two so a human gate can sit between testing and merging.
`prepareLanding` rebases the feature branch onto the current dev tip in its
own worktree and runs the project's combined build+test there (injectable;
the default is the repo's own typecheck + test scripts) — on the combined
rebased state, because feature A green and feature B green does not make A+B
green. It reports green (with the diff the gate will show), conflict (the
rebase is aborted, the branch restored byte-for-byte), or failed (the branch
is left rebased so a fix dispatch lands in the exact red state); dev is never
written. `executeLanding` is the separate callable that does the merge: a
`--no-ff` merge commit built with plumbing (commit-tree plus a compare-and-swap
update-ref, so no checkout of dev ever exists and a concurrent move fails
loudly), per-job commits preserved, then teardown through the existing guards.
It refuses a stale green (dev moved since the prepare) and is pinned to the
exact tested sha. Everything is local: the only ref it writes is `dev`, and no
step anywhere fetches, pushes, or opens a PR.

`landinggate.ts` is the human gate for the direct `feature_land` route:
`reviewLanding` prepares a feature and presents the result in the panel as a
summary (commits, changed-file count), the full paged diff, and an action bar.
Pressing `m` there runs `executeLanding` pinned to the exact sha the review
covered, so approval can never merge more than what was shown; `r`/Esc dismisses
with no merge, leaving the branch and worktree intact. A conflict or failed
prepare opens the gate too, showing why the feature is not mergeable with `m`
disabled. `main` stays human-only throughout.

`mergequeue.ts` is the serial merge queue, and the normal route onto `dev`.
Features the captain marks done join an ordered queue; only the HEAD is ever
worked, and it works itself out — `prepareLanding` rebases it onto the current
dev tip and build+tests it on that combined state, leaving it `ready`,
`blocked` (a rebase conflict or a red build+test), or `resolving`. Everything
behind the head sits untouched, so nothing is ever speculatively tested.

**The merge is panel-native, not a co tool call.** A `ready` head simply
*carries* an `[m]` in the Ctrl-O queue tab, alongside its own diff, commit list
and build+test result. Pressing it calls `mergeReadyHead` directly: the merge
lands, the worktree and branch are torn down, the queue advances, and the new
head is processed against the dev tip that merge just moved — so the next `[m]`
is live (or the next block is on screen) by the time the key finishes. The
co-manager is not in that loop at any point: it opens nothing, waits on
nothing, and is not blocked on the keystroke. It is engaged again only when a
head comes back **blocked**, which reaches it automatically so it can offer the
resolver without you re-explaining anything. This replaced an earlier shape
where a co tool call opened a gate and held the model's turn open until you
pressed a key — coupling the agent loop to a human keypress.

`features.ts` is the co-facing lever layer: the small verb set the model
calls to drive the harness end to end. `feature_create` provisions a feature's
worktree off dev and registers it (idempotent, no confirm gate — it writes
nothing to dev or main); a dispatch can target a feature so the crew runs in
its worktree (provisioned on first use), and the arm banner names the target
worktree or says plainly it targets the bare main tree. `feature_enqueue` marks
a feature done and puts it in the merge queue, which is where landing normally
happens; `feature_land` is the direct route for a feature that was never
enqueued, and opens the gate above. `feature_merge_head` is **not** the merge:
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
feature survives a restart, and surfaces anomalies (a branch with no worktree,
a half-landed branch, a stray directory) for the co to relay rather than acting
on them. The co's reach stops at `dev`: it never touches `main` and there is no
promote path.

**`src/tui/`** — the full-screen terminal UI: transcript buffer + scrolling,
the multi-line line editor, markdown → ANSI rendering, ANSI-aware wrapping,
and the Ctrl-O panel. The panel has three home tabs, cycled with Tab — the merge
queue, the doc viewer, and the review inbox — each reading a small injected
source, so the Tui never reaches into git, the filesystem, or the session layer
itself. The queue tab renders the ready head's diff and build+test inline and
owns the `[m]` that merges it, through an injected `merge` callback that is the
only thing the keystroke can reach; a pending `feature_land` review gets a
fourth tab of its own for as long as it is pending, so the two merges never
share a key. A doc and a filed review drill into the same paged body view.
`keys.ts` is the pure decode table that maps both legacy control bytes and
enhanced-protocol CSI-u sequences onto one set of bindings. `tui.ts` is
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
