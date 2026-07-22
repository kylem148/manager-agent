import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline";
import type { Config } from "../config.js";
import { instancePaths, isValidInstanceName } from "../paths.js";
import { instanceExists } from "../memory/memory.js";
import {
  EXAMPLE_TEMPLATES,
  defaultDispatchConfig,
  readDispatchConfig,
  writeDispatchConfig,
  setAnchor,
  displayCommand,
  type DispatchConfig,
} from "../session/dispatchconfig.js";
import { crewPaneTitle } from "../session/crewpanes.js";
import { c, line, write } from "../ui.js";

/**
 * `co link <name>` — register how this co-manager dispatches orders to the crew.
 *
 * Records, per instance (under .dispatch/config.json, NOT .env — none of this is
 * secret): the target repo path, the agent command template with {prompt}/{repo}
 * placeholders, optional safety caps, and the pane layout. Re-runnable: it seeds
 * from any existing config so a second run just updates what changed.
 *
 * `co pane <name>` — the one-time anchor designation: tag the crew pane the
 * dispatcher splits from. See runPaneAnchor below.
 */
export async function runLink(cfg: Config, name: string | undefined): Promise<number> {
  if (!name) {
    line(c.red("usage: co link <name>"));
    return 1;
  }
  if (!isValidInstanceName(name)) {
    line(c.red(`invalid name "${name}".`));
    return 1;
  }
  if (!instanceExists(cfg.home, name)) {
    line(c.yellow(`"${name}" doesn't exist. create it first:  co create ${name}`));
    return 1;
  }
  if (!process.stdin.isTTY) {
    line(c.red("co link needs an interactive terminal (it prompts for the repo path and agent command)."));
    return 1;
  }

  const paths = instancePaths(cfg.home, name);
  const existing = (await readDispatchConfig(paths)) ?? defaultDispatchConfig();

  line();
  line(c.bold(`co link ${name}`));
  line(c.dim(`  Registers how orders dispatch to the crew for this instance.`));
  line(c.dim(`  Stored in ${paths.dispatchConfig} (plain JSON, not secret).`));
  line();

  // 1. Repo path. Default to the prior value, or (on a first link) the current
  //    working directory: `co link` is almost always run from inside the repo
  //    you want to dispatch into, so pre-filling cwd makes the common case a
  //    single Enter.
  const repoDefault = existing.repoPath || process.cwd();
  const repoPath = await promptWithDefault(
    "Target repo path (the coding agent runs here): ",
    repoDefault,
  );
  const resolvedRepo = repoPath ? path.resolve(untilde(repoPath)) : "";
  if (!resolvedRepo) {
    line(c.yellow("no repo path entered — nothing changed."));
    return 1;
  }
  if (!fs.existsSync(resolvedRepo)) {
    line(c.yellow(`note: ${resolvedRepo} does not exist yet. Saved anyway; create it before dispatching.`));
  }

  // 2. Agent command template.
  line();
  line(c.dim("Agent command template. Use {prompt} for the order and {repo} for the path."));
  EXAMPLE_TEMPLATES.forEach((t, i) => line(c.dim(`  ${i + 1}. ${t.label}: ${t.template}`)));
  line(c.dim("  Enter a number to pick an example, or type your own template."));
  const templateRaw = await promptWithDefault("Command template: ", existing.commandTemplate);
  const commandTemplate = resolveTemplateChoice(templateRaw, existing.commandTemplate);

  // 3. Safety caps (all optional).
  line();
  line(c.dim("Safety caps (press Enter to skip any)."));
  const caps = { ...existing.caps };
  const timeout = await promptWithDefault(
    "  Wall-clock timeout in seconds: ",
    caps.timeoutSec ? String(caps.timeoutSec) : "",
  );
  if (timeout.trim()) {
    const n = Number.parseInt(timeout, 10);
    if (Number.isFinite(n) && n > 0) caps.timeoutSec = n;
  }
  const turns = await promptWithDefault(
    "  Max agent turns: ",
    caps.turnLimit ? String(caps.turnLimit) : "",
  );
  if (turns.trim()) {
    const n = Number.parseInt(turns, 10);
    if (Number.isFinite(n) && n > 0) caps.turnLimit = n;
  }

  const config: DispatchConfig = {
    repoPath: resolvedRepo,
    commandTemplate,
    caps,
    pane: existing.pane, // retune via config.json; not prompted (has sane defaults)
    anchor: existing.anchor,
  };
  await writeDispatchConfig(paths, config);

  line();
  line(c.green(`linked "${name}".`));
  line(c.dim(`  repo:    ${config.repoPath}`));
  line(c.dim(`  command: ${displayCommand(config.commandTemplate, config.repoPath)}`));
  if (config.caps.timeoutSec) line(c.dim(`  timeout: ${config.caps.timeoutSec}s`));
  line(c.dim(`  panes:   ${config.pane.directionSequence.join("/")} split, cap ${config.pane.cap}`));
  line();
  if (!config.anchor) {
    line(c.dim("Next, on macOS + Ghostty, designate the crew pane so dispatches land in the"));
    line(c.dim(`right spot:  co pane ${name}`));
    line(c.dim("(Off Ghostty this is unnecessary — dispatch runs in the background.)"));
  }
  return 0;
}

/** Seconds you get to switch to the crew pane after starting `co pane`. */
const PANE_COUNTDOWN_SEC = 5;

/**
 * `co pane <name>` — designate the crew anchor pane (one-time, macOS + Ghostty).
 *
 * Flow: run it, then within a few seconds click/focus the Ghostty pane you want
 * crew jobs to grow from. When the countdown ends it grabs whatever terminal is
 * focused and stores it as the anchor. A countdown (rather than "press Enter
 * once focused") is required because focusing another pane steals your
 * keystrokes — you could never press Enter back here.
 *
 * Ghostty's API can't tag a pane (a terminal's title is read-only), so we
 * persist the terminal's stable id; dispatch verifies it still exists and asks
 * you to re-run this if the pane was closed.
 */
export async function runPaneAnchor(cfg: Config, name: string | undefined): Promise<number> {
  if (!name) {
    line(c.red("usage: co pane <name>"));
    return 1;
  }
  if (!isValidInstanceName(name) || !instanceExists(cfg.home, name)) {
    line(c.red(`"${name}" doesn't exist. create and link it first.`));
    return 1;
  }
  if (process.platform !== "darwin") {
    line(c.yellow("crew panes are a macOS + Ghostty feature. Off macOS, dispatch runs in the background"));
    line(c.yellow("with no pane geometry, so there is nothing to designate."));
    return 1;
  }
  const paths = instancePaths(cfg.home, name);
  if (!(await readDispatchConfig(paths))) {
    line(c.yellow(`"${name}" is not linked yet. run:  co link ${name}`));
    return 1;
  }

  line();
  line(c.bold(`co pane ${name}`));
  line(c.dim(`  Click the Ghostty pane you want crew jobs to grow from now — you have`));
  line(c.dim(`  ${PANE_COUNTDOWN_SEC} seconds. Whatever pane is focused when the countdown ends is tagged.`));
  line(c.dim("  (Staying in this pane is fine too; it just designates this one.)"));
  line();
  for (let s = PANE_COUNTDOWN_SEC; s > 0; s--) {
    write(`\r  grabbing the focused pane in ${s}… `);
    await sleep(1000);
  }
  write("\r  grabbing the focused pane now…   \n");

  let paneId: string;
  try {
    paneId = await readFocusedTerminalId();
  } catch (e) {
    line(c.red(`could not reach Ghostty via AppleScript: ${(e as Error).message}`));
    line(c.dim("Make sure Ghostty 1.3.0+ is running and grant the automation permission when prompted."));
    return 1;
  }
  if (!paneId) {
    line(c.red("Ghostty did not report a focused terminal. Is a Ghostty window focused?"));
    return 1;
  }

  // A descriptive label stored beside the id; NOT applied to the pane (the API
  // won't let us) — the id is the real handle.
  const title = crewPaneTitle(name);
  await setAnchor(paths, { id: paneId, title });
  line();
  line(c.green(`crew anchor set: pane ${paneId}.`));
  line(c.dim("The first dispatch takes over this pane; later jobs subdivide it as they run."));
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- helpers -----------------------------------------------------------------

/** Expand a leading ~ to the home directory. */
function untilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", p.slice(1));
  }
  return p;
}

/** Map a numeric choice to an example template; otherwise take the typed text,
 *  falling back to the prior value when the user just pressed Enter. */
function resolveTemplateChoice(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const n = Number.parseInt(trimmed, 10);
  if (String(n) === trimmed && n >= 1 && n <= EXAMPLE_TEMPLATES.length) {
    return EXAMPLE_TEMPLATES[n - 1]!.template;
  }
  return trimmed;
}

/**
 * Read the stable id of Ghostty's currently-focused terminal — the pane this
 * command is running in. Grammar verified against Ghostty.sdef (1.3.x): a tab's
 * `focused terminal` is the active surface, and each terminal has a read-only
 * stable `id`. We do NOT set a title (the API forbids it); the id is the handle.
 */
async function readFocusedTerminalId(): Promise<string> {
  const script = [
    'tell application "Ghostty"',
    "  set t to focused terminal of selected tab of front window",
    "  return (id of t as text)",
    "end tell",
  ].join("\n");
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `osascript exited ${code}`));
    });
  });
}

/** One-shot prompt showing the current value as the default (Enter keeps it). */
function promptWithDefault(prompt: string, current: string): Promise<string> {
  const label = current ? `${prompt}[${current}] ` : prompt;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string): void => {
      if (done) return;
      done = true;
      resolve(v);
    };
    rl.on("close", () => finish(""));
    rl.question(label, (answer) => {
      const a = answer.trim();
      finish(a === "" ? current : a);
      rl.close();
    });
  });
}
