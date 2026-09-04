# comanager

A terminal-native architectural **co-manager** for software projects. A persistent,
research-capable thinking partner that reasons through architecture, pushes back on weak
assumptions, tracks decisions, and writes high-quality orders to the crew (separate coding
agents).

Alongside the thinking, it streamlines the work around it: dispatching coding agents into
their own git worktrees, managing the full GitHub pull request workflow end to end (branch,
rebase, open, wait on real CI, merge), tracking everything in flight on a task board, and
keeping your decisions and research in plain markdown. It absorbs the mechanics of getting a
change landed, so your attention stays on the higher-level decisions that actually matter.

<img width="1512" height="871" alt="co-manager-picture" src="https://github.com/user-attachments/assets/076eda33-faa2-4344-b8a5-6f2f6658ee73" />

```
Example Terminal Flow (i.e. Ghostty, etc)
├── pane 1: comanager                 the brain: architecture, research, decisions, orders
├── pane 2: Claude Code in your repo  the hands
├── pane 3: tests / shell
└── pane 4: logs / dev server
```

## Why

Every project accumulates reasoning that lives in your head and nowhere else: why this
schema, why not that library, what you already ruled out. comanager is a partner for that
thinking and the place it's kept. It argues architecture with you, researches from primary
sources when a question deserves an answer instead of an opinion, and still knows what you
decided six weeks later.

The other half is friction. Development is full of boilerplate that has nothing to do with
the problem you're solving. Running work in parallel means hand-managing worktrees until
you've lost track of which checkout is which, and a finished change still has to be
branched, rebased, opened, watched through CI and merged, which routinely takes longer than
writing it did. comanager runs that whole layer for you, out of one panel.

## Install

Node 20+.

```bash
git clone <repo-url> && cd manager-agent
npm install
npm install -g .        # compiles and puts `co` on your PATH
```

Installed once, globally, like `git` or `gh`. Instances are folders of markdown under
`~/co-managers`. You never run npm inside one.

## Quickstart

```bash
co auth bedrock         # paste a Bedrock bearer token, written to ~/co-managers/.env (0600)
co create my-saas       # scaffold an instance
co my-saas              # open the session
co doctor               # when any of the above misbehaves
```

Then talk. Natural language is the whole interface: comanager decides on its own when to
search memory, research something from primary sources, propose a decision, or draft an
order for the crew. Slash commands are optional overrides.

## What it does

### Dispatch to the crew, behind a typed confirm

`co link my-saas` points an instance at a repo and registers the word you run each coding
agent with. It resolves your shell aliases at link time and stores the real command, so
`cc` still works from the non-interactive shell a dispatch spawns.

After that comanager can run an order instead of only writing one. Arming shows you the
exact order and the exact resolved command, then waits. Nothing runs until you type
`confirm`; anything else cancels. `confirm <agent>` picks a different agent for one
dispatch. `confirm write` grants a second writing lane in a worktree that already has an
agent in it, where a plain `confirm` gives you a read-only auditor instead, because one
worktree has one `.git/index`. There is no code path that dispatches without your keystroke.

The agent runs in a visible pane you can watch and answer. comanager reviews the captured
transcript afterward and still never touches a file itself.

### Features land as pull requests, at one keystroke

Each feature gets its own git worktree. Finished work goes into a strictly serial merge
queue that only ever touches the front of the line: it rebases the head onto the current
`origin/dev`, force-pushes with lease, opens the PR, and then reads that PR's real GitHub
checks. Your local `dev` is never written to, and comanager runs no build or test of its
own. The forge decides.

comanager writes the PR message itself (What / Why / How / Testing / Other Notes) at the
moment you say the feature is done, since it's the thing that decided what the feature was
for and reviewed what came back. `m` on the queue tab merges once checks are green. `e`
opens the message in an editor over the panel if you'd rather say it differently.

### One panel for everything in flight

`Ctrl-O`:

```
[1 home] 2 queue  3 docs

  Tasks

  building   Fix crew handoff truncation
  enqueued   Passkey login for the web app
  queued     Ctrl-O home page cleanup

  Worktrees

  ▸ checkout   [ready to merge]  feat/checkout   stripe checkout with saved cards
    user-auth  [queued #2]       feat/user-auth  passkey login for the web app
    search     [crew running]    feat/search     full-text search over the docs
    scratch    [dirty]           feat/scratch    the schema migration runner
```

The task table is yours to write (`a` add, `e` edit, `x` retire, `s` advance a stage) and
comanager reads it. Under it, every worktree that exists, including the ones the queue
never sees. The queue tab holds the head PR, its checks and its message. The docs tab
renders and edits everything in `docs/`. A fourth tab appears when a landing review is
waiting on you. Numbers jump, `Tab` cycles, `Esc` closes.

### Memory that manages itself

Memory is the co-manager's own system, not a feature you drive. It writes what it needs
without asking permission and without narrating, and it comes up only when you ask. Cold
start reads the small orientation files and leaves the append-only logs on disk to be
searched on demand, so starting a session costs the same in month six as in week one.

It's plain markdown. Open it in your editor any time; templates only fill gaps, they never
overwrite what you wrote.

### A cost meter that doesn't flatter you

Nothing is printed while you work. `/cost` for this instance, `co cost` across all of them:

```
cost
  session    5,749 out          $0.4864     3 turn(s)
  today      5,749 out          $0.4864     3 turn(s)
  all time   55,249 out         $3.51       28 turn(s)

  per day    $0.7015 per active day (5) · $0.5011 per calendar day (7)
  last 7d    ▅▃·█▃·▄  $3.51  (07-21 → 07-27)
```

Priced off all four token classes, because this app re-sends a large prefix every round
trip and metering output alone would understate the invoice by most of it. Bedrock's rates,
not Anthropic's first-party list, and a `us.` inference profile is billed the 10% regional
premium it actually carries over `global.` (same model, different data residency, one
environment variable). Days bucket in your timezone, and a day you didn't work is a gap in
the sparkline rather than a short bar.

## Commands

| command | what it does |
| ------- | ------------ |
| `co <name>` | open a session (creates the instance if missing) |
| `co list` | list co-managers |
| `co create <name>` | scaffold an instance from the template |
| `co delete <name>` | delete an instance; type the name to confirm (`-y` to script it) |
| `co link <name>` | register a repo and the crew agents so it can dispatch |
| `co pane <name>` | designate the crew anchor pane (macOS + Ghostty) |
| `co cost` | tokens, dollars and time across every instance |
| `co auth bedrock` | store the Bedrock bearer token in `~/co-managers/.env` |
| `co doctor` | check runtime, paths, auth, research (`--ping`, `--models`) |

## In session

| command | what it does |
| ------- | ------------ |
| `/state` | show current `activeContext.md` |
| `/research <q>` | research a question and save a note |
| `/decide <d>` | record a decision, then refresh activeContext |
| `/prompt <goal>` | draft the orders to the crew inline (`/orders` is the same) |
| `/sync` | refresh `activeContext.md` from recent activity |
| `/archive <log>` | move a log's history into `archive/` |
| `/effort [level]` | show or set thinking effort for this session |
| `/model [id]` | pick this co-manager's model from a list, or set one by id |
| `/cost` | tokens, dollars and time: session, today, all time |
| `/exit` | leave (auto-saves) |

Sessions take the full screen and hand your scrollback back untouched on every exit path.
`Ctrl-O` opens the panel, the wheel or `PgUp`/`PgDn` scrolls the transcript, `↑`/`↓` recalls
your own input, `Esc Esc` cuts the line to your system clipboard, and typing while it's
working queues the message instead of losing it. Thinking is never rendered, even when it's
on: it reasons before it speaks, and you get what it says.

## Configure

Copy `.env.example` to `~/co-managers/.env`. Real environment variables always win.

Auth resolves in order: `AWS_BEARER_TOKEN_BEDROCK` (or its `BEDROCK_API_KEY` alias), then
the standard AWS credential chain over SigV4. comanager needs its own token and does not
read Claude Code's. `co doctor` reports which path resolved and warns when you've fallen
back to SigV4 while a bearer token exists, since the two can have different model access.

```bash
AWS_REGION=us-west-2
BEDROCK_MODEL_ID=us.anthropic.claude-opus-5   # default
CO_MAX_TOKENS=8192
CO_EFFORT=high        # low | medium | high | xhigh | max
CO_THINKING=off       # or `adaptive` for extended thinking
```

One co-manager per project means projects don't all want the same model, so `/model` picks
one from a list and remembers it per instance.

| `BEDROCK_MODEL_ID` | notes |
| ------------------ | ----- |
| `us.anthropic.claude-opus-5` | default |
| `us.anthropic.claude-opus-4-8` | the previous default |
| `us.anthropic.claude-sonnet-5` | cheaper tier, keeps every effort level |

All need the cross-region inference-profile form; a bare `anthropic.claude-...` is rejected
for on-demand throughput. `co doctor --models` probes which ones actually answer on your
auth path.

Research needs no key: [Jina Reader](https://jina.ai/reader/) turns any URL into clean
markdown for free. Add web search with one of `EXA_API_KEY`, `BRAVE_API_KEY`,
`TAVILY_API_KEY` or `SEARXNG_URL`. Without one, `fetch_url` still reads any link you hand it.

`CO_VISUALS=full|minimal|off` sets animation, and the setting is a ceiling rather than a
promise: `NO_COLOR`, a pipe, `TERM=dumb`, a narrow terminal or a reduced-motion signal each
lower it on their own. Piped output drops to a plain line-oriented session so scripts behave.

## Memory layout

```
~/co-managers/instances/my-saas/
├── docs/                   user-facing documents, flat markdown, starts empty
├── .memory/                the co-manager's own substrate
│   ├── projectbrief.md         rewritten in full
│   ├── activeContext.md        read first at every start
│   ├── decisions.md            append-only
│   ├── progress.md             append-only
│   ├── research.md             append-only
│   ├── archive/                cold history, off the read path
│   └── sessions/               verbatim per-session transcripts
└── .dispatch/              runtime state, only after `co link`
```

`activeContext.md` is the one that matters: current focus, live decisions, what's in flight,
open questions, next likely actions. An instance folder has no `package.json`, no
`node_modules`, no build output. It's memory, not an app.

## Development

```bash
npm run dev -- my-saas   # run from source via tsx, no build step
npm run typecheck
npm test
```

CI runs typecheck and tests on Node 22 for every PR into `dev` and `main`. That's
deliberate rather than incidental: this repo lands its own work through comanager's merge
queue, which gates a head on the pull request's real checks, so without a workflow here
every landing would come back ungated.

## License

MIT
