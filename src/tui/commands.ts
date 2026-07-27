/**
 * The one authoritative list of slash-commands.
 *
 * Three consumers used to each hardcode their own copy: the dispatch switch and
 * the /help table (both in session.ts) and — once we added inline hints — the
 * TUI's completion/colouring. Keeping them in sync by hand is a bug waiting to
 * happen (a command that dispatches but never shows in help, or a ghost hint for
 * a command that no longer exists). This module is that single source; the TUI
 * and /help render from it, and the dispatch switch is checked against it.
 */

export interface SlashCommand {
  /** Canonical name without the leading slash, e.g. "research". */
  name: string;
  /** Argument placeholder shown in hints/help, e.g. "<question>". Empty if none. */
  arg?: string;
  /** One-line description for /help. */
  desc: string;
  /** Alternate names that dispatch to the same handler, e.g. "quit" for "exit". */
  aliases?: string[];
  /** Hide from tab-completion/help (aliases are surfaced via their canonical). */
  hidden?: boolean;
}

/** Ordered for display; the first match wins when completing a prefix. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "state", desc: "show current activeContext.md" },
  { name: "research", arg: "<question>", desc: "research a question and save a note" },
  { name: "decide", arg: "<decision>", desc: "record a decision explicitly, then refresh activeContext" },
  { name: "prompt", arg: "<goal>", desc: "draft the orders to the crew (a coding-agent prompt) inline" },
  { name: "orders", arg: "<goal>", desc: "same as /prompt (alias)" },
  { name: "sync", desc: "refresh activeContext.md from recent activity" },
  { name: "archive", arg: "<log>", desc: "move a log's history into archive/" },
  { name: "effort", arg: "[level]", desc: "show or set thinking effort for this session" },
  { name: "cost", desc: "tokens, dollars and time spent — session, today, all time" },
  { name: "help", desc: "this help" },
  { name: "exit", desc: "leave (auto-saves: refreshes activeContext.md)", aliases: ["quit"] },
];

/** All dispatchable names, canonical + aliases. Used to validate a typed token. */
export function allCommandNames(): string[] {
  const out: string[] = [];
  for (const cmd of SLASH_COMMANDS) {
    out.push(cmd.name);
    if (cmd.aliases) out.push(...cmd.aliases);
  }
  return out;
}

/**
 * Given the word the user has typed after "/", find the single command that
 * should be ghost-completed. Returns null when the token is empty, already a
 * complete command name, or ambiguous (matches more than one command).
 *
 * Only canonical names are completed — an alias like "quit" is reachable by
 * typing it out, but we steer users toward the documented "exit".
 */
export function completeCommand(token: string): SlashCommand | null {
  if (token === "") return null;
  const lower = token.toLowerCase();
  const matches = SLASH_COMMANDS.filter(
    (c) => !c.hidden && c.name.startsWith(lower),
  );
  if (matches.length !== 1) return null; // none, or ambiguous
  const only = matches[0]!;
  if (only.name === lower) return null; // already fully typed
  return only;
}

/** Classify a typed "/word" token for colouring the input line. */
export type TokenKind = "valid" | "prefix" | "unknown";

export function classifyToken(token: string): TokenKind {
  if (token === "") return "prefix";
  const lower = token.toLowerCase();
  if (allCommandNames().includes(lower)) return "valid";
  const isPrefix = SLASH_COMMANDS.some((c) => !c.hidden && c.name.startsWith(lower));
  return isPrefix ? "prefix" : "unknown";
}
