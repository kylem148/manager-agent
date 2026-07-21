import * as readline from "node:readline";
import path from "node:path";
import { EFFORT_LEVELS, parseEffort, type Config } from "../config.js";
import type { InstancePaths } from "../paths.js";
import { ModelProvider, type MessageParam } from "../model.js";
import { buildSystemPrompt } from "./prompt.js";
import {
  toolDefinitions,
  makeExecutor,
  newSideEffects,
  SURFACED_TOOLS,
  type ToolSideEffects,
} from "./tools.js";
import {
  detectStaleActiveContext,
  readLiveMemory,
  archiveLog,
  autoArchiveLargeLogs,
  migrateInstanceLayout,
  startTranscript,
  appendTranscript,
  type TranscriptHandle,
} from "../memory/memory.js";
import { c, line, write } from "../ui.js";
import { Tui, type SessionIO } from "../tui/tui.js";
import { SLASH_COMMANDS } from "../tui/commands.js";
import { pirateBanner } from "../tui/banner.js";
import { LOG_NAMES, type LogName } from "../paths.js";

/**
 * Interactive terminal session for one co-manager instance.
 *
 * Design choices:
 *  - Natural language is the primary interface. Slash-commands are overrides.
 *  - Memory is silent and self-managed: the model records decisions, progress,
 *    research, and live-state on its own judgment, with no confirmation gate and
 *    no narration. /decide is just a shortcut to record one explicitly.
 *  - Durable transcript: every turn is appended to sessions/ as it happens, so
 *    no exit path (clean, Ctrl-C, kill, crash) can cost the conversation.
 *  - End-of-session auto-save: on exit, if any log is newer than
 *    activeContext.md, we refresh it silently before closing — no prompt.
 *    (/sync does the same on demand mid-session.)
 *  - All rendering goes through a SessionIO (tui.ts). On a real terminal that's
 *    the scrollable full-screen Tui; on piped/non-TTY input it's PlainIO, which
 *    preserves the old line-oriented behavior so scripts keep working.
 */

interface SessionState {
  cfg: Config;
  paths: InstancePaths;
  model: ModelProvider;
  system: string;
  messages: MessageParam[];
  effects: ToolSideEffects;
  io: SessionIO;
  /** The durable, turn-by-turn transcript file for this session. */
  transcript: TranscriptHandle;
  /** Count of real user turns (natural-language + steering commands), so the
   *  exit distill can skip a session where nothing was actually said. */
  userTurns: number;
}

const PROMPT_LABEL = c.cyan("you › ");

/**
 * Ship's chores shown beside the spinner while the co is busy. Memory work is
 * silent by design — the co never narrates what it saved — but silence and a
 * frozen terminal look identical from the captain's chair, so we show that
 * SOMETHING is happening without saying what.
 *
 * These are picked at RANDOM rather than mapped per tool, and that's the point:
 * the captain has no use for "reading activeContext.md" vs "appending to
 * decisions.md" — it's the co's own bookkeeping either way. A random chore says
 * "working" and nothing else, which is exactly the amount the user should know.
 */
const BUSY_CHORES = [
  "swabbing the decks",
  "cleaning the cannons",
  "splicing the mainbrace",
  "battening the hatches",
  "coiling the ropes",
  "trimming the sails",
  "scraping the barnacles",
  "counting the doubloons",
  "squaring the yards",
  "tarring the rigging",
  "checking the powder",
  "polishing the brass",
  "sharpening the cutlasses",
  "sounding the depths",
  "bailing the bilge",
  "stowing the cargo",
  "checking the rum stores",
  "greasing the capstan",
  "patching the mainsail",
  "oiling the compass",
  "caulking the hull",
  "hauling in the lines",
  "minding the helm",
  "untangling the rigging",
  "counting the cannonballs",
  "consulting the charts",
  "inking the log",
  "shaking out a reef",
  "mending the nets",
  "wringing out the hammocks",
  "feeding the parrot",
  "arguing with the parrot",
  "rousing the crew",
  "scanning the horizon",
  "reading the stars",
  "dousing the lanterns",
];

/** The chore showing right now, so we never pick the same one twice running —
 *  a repeat reads as a stuck spinner, which is the bug this whole thing fixes. */
let lastChore = "";

function pirateChore(): string {
  if (BUSY_CHORES.length < 2) return BUSY_CHORES[0] ?? "working";
  let pick = lastChore;
  while (pick === lastChore) {
    pick = BUSY_CHORES[Math.floor(Math.random() * BUSY_CHORES.length)]!;
  }
  lastChore = pick;
  return pick;
}

export async function runSession(cfg: Config, paths: InstancePaths): Promise<void> {
  // Bring a pre-reorg instance onto the two-tier layout (docs/ + .memory/)
  // before anything reads or writes its memory. Idempotent: a no-op for
  // instances already on the new layout.
  const migration = await migrateInstanceLayout(paths);
  if (migration.moved > 0) {
    line(c.dim(`migrated ${paths.name} to the docs/ + .memory/ layout — ${migration.moved} file(s) moved.`));
  }
  if (migration.mergedEntries > 0) {
    line(c.dim(`  folded ${migration.mergedEntries} log entr(ies) into the existing logs.`));
  }
  for (const r of migration.renumbered) {
    line(c.dim(`  re-minted colliding decision id ${r}`));
  }
  // Parked snapshots need a human to pick a winner, so they're called out by
  // path rather than counted.
  for (const f of migration.parked) {
    line(
      c.yellow(
        `  couldn't auto-merge ${path.basename(f)} — both copies exist; the old one is now at ${f}. Compare and keep the better one.`,
      ),
    );
  }
  if (migration.conflicts > 0) {
    line(
      c.yellow(
        `  ${migration.conflicts} file(s) were left in the old layout because a destination already existed. Inspect ${paths.root}.`,
      ),
    );
  }

  const model = new ModelProvider(cfg.model);
  const effects = newSideEffects();

  // Open the durable transcript BEFORE building the system prompt so we can
  // exclude this fresh (empty) session file from the recent-conversation tail:
  // the tail must reflect the PRIOR session, not the one we just started. Every
  // turn is appended to it as it happens (see runUserTurn/drive), so a crash,
  // Ctrl-C, or kill never costs the conversation. This is the record; docs/ and
  // .memory/ hold the curated memory that cold start reads.
  const transcript = await startTranscript(paths, { model: cfg.model.modelId });

  const system = await buildSystemPrompt(paths, cfg.research, {
    excludeTranscript: transcript.file,
  });

  // The scroll/selection hint only applies to the interactive TUI; it would be
  // misleading in piped output where there's no scrolling, so it's TUI-only.
  const tui = Tui.capable();
  const header = bannerText(paths.name, cfg, tui);
  const io: SessionIO = tui
    ? new Tui({ promptLabel: PROMPT_LABEL, header })
    : new PlainIO(PROMPT_LABEL, header);

  const state: SessionState = {
    cfg,
    paths,
    model,
    system,
    messages: [],
    effects,
    io,
    transcript,
    userTurns: 0,
  };

  io.start();

  // On a real terminal, open with a short spoken greeting: the co reads its
  // live state (already in the system prompt) and reports where we left off,
  // in character. Skipped for piped/non-TTY sessions (scripts, tests) so their
  // output stays deterministic and we don't burn a model call before the first
  // scripted command.
  if (tui) {
    await runOpeningGreeting(state);
  }

  try {
    while (true) {
      const input = await io.question();
      if (input === null) break; // EOF → clean exit, run the guard below
      const raw = input.trim();
      if (raw === "") continue;

      // Record what the captain actually typed, verbatim, before dispatching.
      // Hidden instruction injections (greeting, /decide, /sync) are internal
      // scaffolding and are deliberately not logged as "you" turns.
      await appendTranscript(state.transcript, "you", raw);

      if (raw.startsWith("/")) {
        const handled = await handleCommand(state, raw);
        if (handled === "exit") break;
        continue;
      }

      // A real spoken turn: the exit distill uses this to know the session had
      // conversational substance worth preserving, even if no tool ran.
      state.userTurns++;
      await runUserTurn(state, raw);
    }
  } finally {
    // The end-of-session guard runs inside the live UI so its prompts render
    // in-session; then we tear the UI down and leave a short, persistent
    // footprint on the user's primary screen.
    await endOfSessionGuard(state);
    io.stop();
    printClosingSummary(state);
  }
}

/**
 * After restoring the terminal, print a short recap that survives on screen.
 * This is orientation only — the co-manager's name and where its workspace
 * lives. It deliberately does NOT list what was written this session: memory is
 * self-managed and invisible, surfaced only when the captain asks for it.
 */
function printClosingSummary(state: SessionState): void {
  line(c.magenta(`co-manager: ${state.paths.name}`));
  line(c.dim(`  memory: ${state.paths.root}`));
}

async function runUserTurn(state: SessionState, userText: string): Promise<void> {
  state.messages.push({ role: "user", content: userText });
  await drive(state);
}

/**
 * Spoken cold-start greeting. The co's live state and the verbatim tail of the
 * last conversation are already in the system prompt, so it can orient with no
 * tool calls. We inject a hidden instruction as the first user turn (same
 * mechanism /sync and /decide use) and let the normal streaming render it in
 * character.
 *
 * The greeting draws on BOTH the curated live state and the recent-conversation
 * tail. This matters: if the last session ended without distilling (a crash, or
 * a purely conversational turn), live state may be thin while the tail still
 * holds the real thread. Reporting "blank charts" then would be wrong — the tail
 * is the floor, so the greeting must use it. Only a truly fresh instance (no
 * live state AND no tail) is treated as a blank start.
 */
async function runOpeningGreeting(state: SessionState): Promise<void> {
  state.messages.push({
    role: "user",
    content:
      "SESSION START (spoken by you, the co-manager, unprompted). You have just" +
      " come aboard and read the system prompt above, which holds your live state" +
      " AND a verbatim tail of our last conversation. Greet the captain and report" +
      " where we left off. Open with an acknowledgement in character — e.g." +
      ' "Aye, ready to work, captain." — then, in 2-4 sentences, summarise the' +
      " current focus, anything in flight, and the most useful next step. Draw on" +
      " your live state first; where it is thin or stale, lean on the recent" +
      " conversation tail to say what we were actually just discussing — do not" +
      " claim the charts are blank when that tail shows real work. ONLY if there is" +
      " genuinely nothing to go on — empty live state AND no recent conversation —" +
      " say so plainly and ask what we're charting, rather than inventing history." +
      " Do not call any tools; do not list open questions exhaustively. Keep it tight.",
  });
  await drive(state);
}

/** Run the model to completion for the current message history. */
async function drive(state: SessionState): Promise<void> {
  const { io } = state;
  const executor = makeExecutor({
    paths: state.paths,
    research: state.cfg.research,
    effects: state.effects,
    onNotice: (msg) => {
      // Only external work (web search, fetch) reaches here; memory operations
      // are silent and never call onNotice. Surface the activity and keep it in
      // the raw transcript, interleaved with talk.
      io.appendBlock(c.dim(`  · ${msg}`));
      void appendTranscript(state.transcript, "note", msg);
    },
  });

  // Streaming render state. "mode" tracks whether the open transcript line is
  // currently carrying answer text or nothing yet, so we know when to break to a
  // fresh line and re-emit the label.
  let mode: "none" | "text" = "none";
  let startedText = false;
  // Accumulate the visible answer verbatim (no ANSI) for the durable transcript.
  let answer = "";

  io.appendBlock(""); // blank spacer before the assistant turn

  // The busy indicator runs from the moment we call the model until the first
  // token lands, and again for the duration of every tool call. Without it, a
  // silent memory write plus the follow-up model call is several seconds of a
  // terminal that looks hung.
  io.setBusy(pirateChore());

  let result;
  try {
    result = await state.model.runTurn({
      system: state.system,
      messages: state.messages,
      tools: toolDefinitions(),
      executor,
      handlers: {
        // Only fires under CO_DEBUG_TIMING. Rendered through io so it lands in
        // the TUI frame rather than corrupting the alt screen.
        onTiming: (l) => io.appendBlock(c.dim(`  ⏱ ${l}`)),
        onText: (d) => {
          io.setBusy(null);
          if (mode !== "text") {
            io.flushStream();
            io.appendStream(c.green("co  › "), { markdown: true });
            mode = "text";
          }
          startedText = true;
          answer += d;
          io.appendStream(d, { markdown: true });
        },
        onToolUse: (name) => {
          io.flushStream();
          // Only surface external work in the transcript. Memory reads and
          // writes are the co-manager's private bookkeeping and stay invisible
          // there — but they still drive the ephemeral busy indicator, which
          // shows activity without narrating what was written.
          if (SURFACED_TOOLS.has(name)) {
            io.appendBlock(c.dim(`  · using ${name}…`));
          }
          io.setBusy(pirateChore());
          mode = "none";
        },
      },
    });
  } finally {
    // Never leave the wheel spinning — including when the turn throws.
    io.setBusy(null);
  }

  // If the model produced no streamed text but a final string exists, show it.
  if (!startedText && result.finalText) {
    io.flushStream();
    io.appendStream(c.green("co  › "), { markdown: true });
    io.appendStream(result.finalText, { markdown: true });
    answer = result.finalText;
  }
  io.flushStream();
  state.messages = result.messages;

  // Persist the co's turn as soon as it lands — the "save along the way" path.
  await appendTranscript(state.transcript, "co", answer);
}

type CommandResult = "ok" | "exit";

async function handleCommand(state: SessionState, raw: string): Promise<CommandResult> {
  const { io } = state;
  const [cmd, ...rest] = raw.slice(1).split(" ");
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "help":
      printHelp(io);
      return "ok";

    case "state": {
      const live = await readLiveMemory(state.paths);
      io.appendBlock("");
      io.appendBlock(c.bold(".memory/activeContext.md"));
      io.appendBlock(live["activeContext.md"].trim() || c.dim("(empty)"));
      return "ok";
    }

    case "research": {
      if (!arg) {
        io.appendBlock(c.yellow("usage: /research <question>"));
        return "ok";
      }
      await runUserTurn(
        state,
        `Research this and save a research note (question, sources, findings, tradeoffs, pushback, recommendation, confidence): ${arg}`,
      );
      return "ok";
    }

    case "decide": {
      if (!arg) {
        io.appendBlock(c.yellow("usage: /decide <decision>"));
        return "ok";
      }
      // A shortcut to record a decision explicitly. There is no confirmation
      // step — recording is silent and self-managed.
      state.messages.push({
        role: "user",
        content: `Record this as a decision now with append_decision. Use the rationale already in our conversation; if some context is thin, record it anyway and note the open questions inline in the entry. Then refresh activeContext.md to reference the new decision id. Keep your spoken reply natural and brief, and do not narrate the memory write. Decision: ${arg}`,
      });
      await drive(state);
      return "ok";
    }

    case "prompt":
    case "orders": {
      if (!arg) {
        io.appendBlock(c.yellow(`usage: /${cmd} <goal>`));
        return "ok";
      }
      await runUserTurn(
        state,
        `Write the orders to the crew (an implementation-ready coding-agent prompt) for this goal now. Write them straight into your reply as plain text the captain can copy to the coding agent — do NOT save them to a file or tool. Do NOT block on questions: where repo details are unknown, put them in an explicit "Assumptions" section and instruct the coding agent to inspect the repo and adjust. State the goal, context, relevant decisions, constraints, what not to change, acceptance criteria, and verification. Goal: ${arg}`,
      );
      return "ok";
    }

    case "sync": {
      await syncActiveContext(state, /*force*/ true);
      return "ok";
    }

    case "archive": {
      const target = arg as LogName;
      if (!LOG_NAMES.includes(target)) {
        io.appendBlock(c.yellow(`usage: /archive <${LOG_NAMES.join("|")}>`));
        return "ok";
      }
      const dest = await archiveLog(state.paths, target);
      io.appendBlock(dest ? c.dim(`archived ${target} → ${dest}`) : c.dim(`${target} has nothing to archive`));
      return "ok";
    }

    case "effort": {
      // Session-scoped override of CO_EFFORT. Takes effect on the next turn;
      // nothing is written to disk, so a restart returns to the configured
      // default (set CO_EFFORT to make a change stick).
      const current = state.model.effort ?? "(unset)";
      if (!arg) {
        io.appendBlock(c.dim(`effort: ${current}  (levels: ${EFFORT_LEVELS.join(", ")})`));
        return "ok";
      }
      const next = parseEffort(arg);
      if (!next) {
        io.appendBlock(c.yellow(`usage: /effort [${EFFORT_LEVELS.join("|")}]`));
        return "ok";
      }
      state.model.setEffort(next);
      io.appendBlock(c.dim(`effort: ${current} → ${next} (this session)`));
      return "ok";
    }

    case "exit":
    case "quit":
      return "exit";

    default:
      io.appendBlock(c.yellow(`unknown command /${cmd} (try /help)`));
      return "ok";
  }
}

/**
 * Ask the model to produce a fresh activeContext.md. Used by /sync (user-invoked,
 * so it may show feedback) and by the end-of-session guard (auto, quiet: memory
 * maintenance is never narrated). Returns true if it rewrote the file.
 */
async function syncActiveContext(state: SessionState, force: boolean, quiet = false): Promise<boolean> {
  const { io } = state;
  const stale = await detectStaleActiveContext(state.paths);
  if (!force && !stale.stale) {
    if (!quiet) io.appendBlock(c.dim("activeContext.md is current."));
    return false;
  }

  if (!quiet) io.appendBlock(c.dim("\nsyncing activeContext.md…"));

  const before = state.effects.liveRewritten.has("activeContext.md");
  state.messages.push({
    role: "user",
    content:
      "Session sync: update .memory/activeContext.md so the next cold start orients" +
      " correctly. Use rewrite_active_context. Reflect the current focus, decisions" +
      " in flight, recent confirmed decisions (compressed, with ids), open questions," +
      " known risks, and next likely actions. Crucially, update the \"Recent" +
      " conversation\" section to summarise what we actually discussed this session -" +
      " including any casual direction that has not yet become a formal decision (for" +
      " example a change of what the project is about) - so the next session picks up" +
      " the thread. Keep the whole file compact and cap that section to a few bullets," +
      " letting older detail age out. Reply with a brief, natural one-line" +
      " acknowledgement, and do not narrate the memory write or say things like" +
      " saved, logged, or wrote to memory.",
  });
  await drive(state);

  const after = state.effects.liveRewritten.has("activeContext.md");
  const rewrote = after && !before;

  if (!after && !quiet) {
    io.appendBlock(c.yellow("note: activeContext.md was not rewritten by the model."));
  }
  return rewrote;
}

/**
 * End-of-session distill: whenever the captain actually said something this
 * session, refresh activeContext.md before closing. We AUTO-save — no prompt.
 *
 * This used to gate on "did a log change / is activeContext stale", which meant
 * a purely conversational session (e.g. "let's make this project about cats",
 * no tool call) slipped through and the redefinition was lost on restart. The
 * transcript survived it, but the transcript isn't curated memory. So we now
 * distil unconditionally on any real conversation: the distilled summary is the
 * rich layer, and the verbatim transcript tail is the guaranteed floor beneath
 * it. The only skip is a session where nothing was said (userTurns === 0), so a
 * bare open-and-quit doesn't burn a model call. (/sync does the same on demand.)
 */
async function endOfSessionGuard(state: SessionState): Promise<void> {
  const { io } = state;

  if (state.userTurns === 0) {
    io.appendBlock(c.dim("\nbye."));
    return;
  }

  // Distil the session into live state, quietly. This is the co-manager's own
  // bookkeeping; it is never narrated to the captain.
  await syncActiveContext(state, /*force*/ true, /*quiet*/ true);

  // Keep the chatty logs from growing without bound. This is off the cold-start
  // read path, so it never affects context size — it just keeps on-demand
  // search fast. decisions.md is deliberately never auto-archived (see
  // autoArchiveLargeLogs). Best-effort; failures never block exit. Silent, like
  // the rest of memory maintenance.
  await autoArchiveLargeLogs(state.paths);

  io.appendBlock(c.dim("bye."));
}

function bannerText(name: string, cfg: Config, tui: boolean): string {
  const thinking = cfg.model.thinking === "adaptive";

  // Interactive terminal: try the fancy boxed pirate galleon. It carries the
  // name/model/region itself, so we don't repeat those below it. If the frame
  // won't fit the current width, pirateBanner() returns null and we fall back
  // to the plain informational lines used on piped/non-TTY sessions.
  const fancy = tui
    ? pirateBanner({
        name,
        modelId: cfg.model.modelId,
        region: cfg.model.region,
        thinking,
        cols: Math.max(20, process.stdout.columns || 80),
      })
    : null;

  const lines: string[] = [""];
  if (fancy) {
    lines.push(fancy, "");
  } else {
    lines.push(
      c.bold(c.magenta(`co-manager: ${name}`)),
      c.dim(
        `model ${cfg.model.modelId} · region ${cfg.model.region} · ${
          thinking ? "thinking on" : "thinking off"
        }`,
      ),
    );
  }
  lines.push(
    c.dim("architecture brain. type /help for commands, /exit to leave."),
  );
  if (tui) {
    lines.push(
      c.dim("scroll: wheel or PgUp/PgDn · ↑/↓ recalls your input · hold Option/Shift to select text"),
    );
  }
  return lines.join("\n");
}

function printHelp(io: SessionIO): void {
  io.appendBlock("");
  io.appendBlock(c.bold("commands (natural language works without any of these):"));
  io.appendBlock(c.dim("  tip: type / and press Tab or → to accept the grey suggestion"));
  for (const cmd of SLASH_COMMANDS) {
    if (cmd.hidden) continue;
    const key = "/" + cmd.name + (cmd.arg ? " " + cmd.arg : "");
    io.appendBlock(`  ${c.cyan(key.padEnd(18))} ${c.dim(cmd.desc)}`);
  }
}

/**
 * Line-oriented IO for piped / non-TTY sessions (scripts, tests). No alt
 * buffer, no raw mode — just readline plus the existing write/line helpers, so
 * behavior matches the pre-TUI session when there's no interactive terminal.
 */
class PlainIO implements SessionIO {
  private rl: readline.Interface | null = null;
  private closed = false;
  private midLine = false;
  /** Lines readline has emitted that no question() has claimed yet. */
  private queued: string[] = [];
  /** The single in-flight question() waiting on the next line, if any. */
  private waiter: ((answer: string | null) => void) | null = null;

  constructor(private promptLabel: string, private header?: string) {}

  start(): void {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    // Lines come from the 'line' event, not from rl.question's one-shot
    // callback. Piped stdin arrives as a single chunk, so readline emits every
    // line synchronously; a one-shot callback claims the first and the rest are
    // dropped on the floor with no listener, which meant a scripted session ran
    // only its first command and then saw EOF. Queue them and hand them out on
    // demand instead.
    this.rl.on("line", (l) => this.deliver(l));

    // EOF. Release anything still waiting rather than leaving it unsettled:
    // rl.question on a closed interface neither throws nor calls back, so the
    // old code could hang forever if question() ran before this fired.
    this.rl.on("close", () => {
      this.closed = true;
      this.deliver(null);
    });

    if (this.header) line(this.header);
  }

  /** Hand a line to a waiting question(), or park it for the next one. */
  private deliver(answer: string | null): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null; // cleared before calling: never resolve twice
      waiter(answer);
      return;
    }
    if (answer !== null) this.queued.push(answer);
  }

  stop(): void {
    this.flushStream();
    this.rl?.close();
    this.rl = null;
  }

  appendBlock(text: string): void {
    if (this.midLine) { write("\n"); this.midLine = false; }
    line(text);
  }

  // Piped/non-TTY output stays plain markdown — a script or pipe consuming this
  // wants the raw text, not ANSI styling — so the markdown flag is ignored here.
  appendStream(chunk: string, _opts?: { markdown?: boolean }): void {
    if (chunk === "") return;
    write(chunk);
    this.midLine = !chunk.endsWith("\n");
  }

  flushStream(): void {
    if (this.midLine) { write("\n"); this.midLine = false; }
  }

  // No-op off the TTY: a spinner would be noise in a pipe and would break the
  // deterministic output scripts and tests depend on.
  setBusy(_label: string | null): void {}

  /**
   * The session loop is strictly sequential — one question() outstanding at a
   * time — so a single waiter slot is enough.
   */
  question(): Promise<string | null> {
    if (!this.rl) return Promise.resolve(null);

    const next = this.queued.shift();
    // Nothing buffered and stdin is done: EOF, and no trailing prompt label.
    if (next === undefined && this.closed) return Promise.resolve(null);

    write("\n" + this.promptLabel);
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve) => { this.waiter = resolve; });
  }
}
