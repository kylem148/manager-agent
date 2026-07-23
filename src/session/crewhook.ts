import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeConfigDir } from "./crewtranscript.js";

/**
 * Install the crew-completion Stop hook into a crew agent's Claude Code config,
 * idempotently, so a dispatched run reports its result the moment Claude first
 * finishes responding (see crewstophook.ts). This is the one setup step that
 * teaches the crew's Claude Code to notify us.
 *
 * WHERE IT INSTALLS: the hook lives in the agent's own config dir — the same
 * CLAUDE_CONFIG_DIR parsed from the resolved agent command (crewtranscript.ts:
 * ~/.claude for personal `cc`, ~/.claude-work for `ccw`). Its settings.json is
 * the user's real config (it holds their Bedrock token, theme, permissions), so
 * the merge is surgical: it only ever adds/updates ONE Stop hook entry keyed by
 * the crewstophook marker, and preserves every other key and every other hook.
 *
 * IDEMPOTENT + SELF-HEALING: re-running finds the existing crew hook by the
 * marker and rewrites its command only if the resolved path changed (e.g. the co
 * runtime moved), never duplicating. A settings.json we can't parse is left
 * untouched and reported — we refuse to clobber real config on a parse error.
 */

/** Substring that identifies OUR Stop hook among any others the user has. The
 *  hook command always invokes the built crewstophook script by absolute path,
 *  so this basename appears in it and nothing else. */
const HOOK_MARKER = "crewstophook";

/** A Claude Code command-hook entry. */
interface CommandHook {
  type: "command";
  command: string;
  [k: string]: unknown;
}

/** A Stop matcher group: a list of hooks (Stop takes no matcher, so the group
 *  has just its hooks). Unknown fields are preserved. */
interface HookGroup {
  hooks?: CommandHook[];
  [k: string]: unknown;
}

interface Settings {
  hooks?: { Stop?: HookGroup[]; [event: string]: HookGroup[] | undefined };
  [k: string]: unknown;
}

/**
 * The shell command Claude Code runs for the Stop hook: the co runtime's own
 * Node executing the built hook script by absolute path. Both are single-quoted
 * so a space in either path can't split the command. Exported for the installer
 * and its test.
 */
export function stopHookCommand(nodePath: string, scriptPath: string): string {
  return `${sq(nodePath)} ${sq(scriptPath)}`;
}

/** POSIX single-quote (same rule as dispatchconfig.shellQuote; duplicated here
 *  to keep this module free of the transport graph). */
function sq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Merge our Stop hook into a parsed settings object. Pure and clone-based so it
 * can be unit-tested and never mutates the caller's object. Returns the new
 * settings plus whether anything changed (false when the exact hook is already
 * present, so the caller can skip the write).
 *
 * Rules:
 *  - No crew hook present  → append a new Stop group with our command.
 *  - Crew hook present, same command → no-op (changed = false).
 *  - Crew hook present, different command → rewrite it in place (the runtime
 *    moved); never add a duplicate.
 * Every non-Stop key, every non-crew Stop hook, and unknown fields survive.
 */
export function mergeStopHook(settings: Settings, command: string): { settings: Settings; changed: boolean } {
  const next: Settings = structuredClone(settings ?? {});
  if (!next.hooks || typeof next.hooks !== "object") next.hooks = {};
  const stop: HookGroup[] = Array.isArray(next.hooks.Stop) ? next.hooks.Stop : [];
  next.hooks.Stop = stop;

  // Look for an existing crew hook anywhere in the Stop groups.
  for (const group of stop) {
    if (!group || !Array.isArray(group.hooks)) continue;
    for (const h of group.hooks) {
      if (h && h.type === "command" && typeof h.command === "string" && h.command.includes(HOOK_MARKER)) {
        if (h.command === command) return { settings: next, changed: false };
        h.command = command; // path changed: heal it in place
        return { settings: next, changed: true };
      }
    }
  }

  // None present: add a fresh group (Stop takes no matcher, so just the hooks).
  stop.push({ hooks: [{ type: "command", command }] });
  return { settings: next, changed: true };
}

/** Resolve the absolute path of the BUILT Stop-hook script, anchored through the
 *  package root: <root>/dist/session/crewstophook.js. From the installed build
 *  (dist/session/) that is this module's own sibling; from a `tsx` dev run
 *  (src/session/) it still lands on the dist build — resolving a sibling there
 *  would register src/session/crewstophook.js, a file that never exists, and
 *  write that dead command into the user's real settings.json. The hook command
 *  must be a plain `node <file.js>`, so only dist can serve it. Overridable for
 *  tests via installCrewStopHook's scriptPath. */
export function stopHookScriptPath(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "dist",
    "session",
    "crewstophook.js",
  );
}

export interface InstallResult {
  /** The config dir the hook was installed into. */
  configDir: string;
  /** True if settings.json was written (added or healed); false if already
   *  current or if we declined to touch it. */
  changed: boolean;
  /** Set when we could NOT safely install (e.g. unparseable settings.json). The
   *  caller logs it; a dispatch still proceeds — the transport's own exit-time
   *  sentinel remains the completion backstop, so a missing hook only means the
   *  review waits until the pane is closed, exactly the old behaviour. */
  error?: string;
}

/**
 * Install (or heal) the Stop hook in the config dir the given agent command
 * uses. Reads that dir's settings.json, merges our hook, and writes it back only
 * when something changed. Creates the config dir and a fresh settings.json when
 * neither exists. Never throws: any failure is returned as `error` so a dispatch
 * is never blocked by hook setup.
 *
 * `scriptPath`/`nodePath` are injectable for tests; they default to the built
 * script beside this module and the running Node.
 */
export async function installCrewStopHook(args: {
  agentCommand: string;
  scriptPath?: string;
  nodePath?: string;
  home?: string;
}): Promise<InstallResult> {
  // Only a Claude Code launch can fire a Claude Code Stop hook. For any other
  // crew (opencode etc.) there is no config dir to teach — claudeConfigDir
  // would default to ~/.claude and we'd be editing the config of a tool this
  // dispatch never runs. Skip quietly, without an error: those agents simply
  // keep the exit-time sentinel as their completion signal.
  if (!/\bclaude\b/.test(args.agentCommand)) {
    return { configDir: "", changed: false };
  }
  const configDir = claudeConfigDir(args.agentCommand, args.home);
  const settingsFile = path.join(configDir, "settings.json");
  const command = stopHookCommand(args.nodePath ?? process.execPath, args.scriptPath ?? stopHookScriptPath());

  let raw: string | null = null;
  try {
    raw = await fsp.readFile(settingsFile, "utf8");
  } catch {
    raw = null; // no settings.json yet: we'll create one
  }

  let current: Settings = {};
  if (raw !== null && raw.trim()) {
    try {
      current = JSON.parse(raw) as Settings;
    } catch {
      // Real user config we can't parse. Refuse to overwrite it — losing a
      // Bedrock token to a rewrite is far worse than a slower review.
      return {
        configDir,
        changed: false,
        error: `${settingsFile} is not valid JSON; left it untouched. The crew hook was not installed — dispatch still works, results just land when the pane closes.`,
      };
    }
  }

  const { settings, changed } = mergeStopHook(current, command);
  if (!changed) return { configDir, changed: false };

  try {
    await fsp.mkdir(configDir, { recursive: true });
    await fsp.writeFile(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf8");
  } catch (e) {
    return { configDir, changed: false, error: `could not write ${settingsFile}: ${(e as Error).message}` };
  }
  return { configDir, changed: true };
}
