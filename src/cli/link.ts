import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline";
import type { Config } from "../config.js";
import { instancePaths, isValidInstanceName } from "../paths.js";
import { instanceExists } from "../memory/memory.js";
import {
  EXAMPLE_AGENTS,
  defaultDispatchConfig,
  readDispatchConfig,
  writeDispatchConfig,
  setAnchor,
  displayCommand,
  resolveAgentCommand,
  type CrewAgent,
  type DispatchConfig,
} from "../session/dispatchconfig.js";
import { crewPaneTitle } from "../session/crewpanes.js";
import { c, line, write } from "../ui.js";

/**
 * `co link <name>` — register how this co-manager dispatches orders to the crew.
 *
 * Records, per instance (under .dispatch/config.json, NOT .env — none of this is
 * secret): the target repo path, the named crew agents (each a launch command
 * with a {prompt} placeholder) and which one is the default, optional safety
 * caps, and the pane layout. Re-runnable: it seeds from any existing config so a
 * second run just updates what changed. The crew process runs with cwd = repo
 * path, so an agent command needs no --dir flag to target the repo.
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

  // 2. Crew agents. Each is a named launch command with a {prompt} placeholder.
  //    The crew process runs with cwd = repo path, so no --dir flag is needed.
  //    The captain types `confirm <name>` at dispatch time to pick one; a bare
  //    `confirm` uses the default set below.
  line();
  line(c.dim("Crew agents. Each name maps to a launch command; {prompt} is the order text."));
  line(c.dim("The agent runs with the repo as its working directory, so no directory flag is needed."));
  line(c.dim(`  examples: ${EXAMPLE_AGENTS.map((a) => `${a.name} → ${a.command}`).join("   ")}`));
  const defaultNames = existing.agents.map((a) => a.name).join(" ");
  const namesRaw = await promptWithDefault(
    "Agent names (space-separated, e.g. cc ccw): ",
    defaultNames,
  );
  const names = parseAgentNames(namesRaw, existing.agents);
  const agents: CrewAgent[] = [];
  for (const nm of names) {
    const prior = existing.agents.find((a) => a.name === nm);
    const cmd = await promptWithDefault(`  command for ${nm}: `, prior?.command ?? `${nm} {prompt}`);
    if (cmd.trim()) agents.push({ name: nm, command: cmd.trim() });
  }
  if (agents.length === 0) {
    line(c.yellow("no crew agents entered — nothing changed."));
    return 1;
  }

  // Which agent a bare `confirm` uses. Default to the prior default when it
  // still exists, else the first agent.
  const defaultFallback = agents.some((a) => a.name === existing.defaultAgent)
    ? existing.defaultAgent
    : agents[0]!.name;
  let defaultAgent = defaultFallback;
  if (agents.length > 1) {
    const pick = await promptWithDefault(
      `Default agent (bare \`confirm\` uses this) [${agents.map((a) => a.name).join(", ")}]: `,
      defaultFallback,
    );
    defaultAgent = agents.some((a) => a.name === pick) ? pick : defaultFallback;
  }

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
    agents,
    defaultAgent,
    caps,
    pane: existing.pane, // retune via config.json; not prompted (has sane defaults)
    anchor: existing.anchor,
  };
  await writeDispatchConfig(paths, config);

  line();
  line(c.green(`linked "${name}".`));
  line(c.dim(`  repo:    ${config.repoPath}`));
  line(c.dim(`  agents:  ${config.agents.map((a) => a.name).join(", ")}  (default: ${config.defaultAgent})`));
  line(c.dim(`  command: ${displayCommand(resolveAgentCommand(config), config.repoPath)}`));
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

/**
 * Parse the space-separated agent-names line into a deduped, ordered list.
 * Pressing Enter (empty input) keeps the prior set of names; a fresh instance
 * with no prior agents falls back to the shipped examples so `co link` always
 * ends with at least one agent to prompt a command for.
 */
function parseAgentNames(raw: string, priorAgents: CrewAgent[]): string[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return priorAgents.length > 0
      ? priorAgents.map((a) => a.name)
      : EXAMPLE_AGENTS.map((a) => a.name);
  }
  const seen = new Set<string>();
  const names: string[] = [];
  for (const tok of trimmed.split(/\s+/)) {
    if (tok && !seen.has(tok)) {
      seen.add(tok);
      names.push(tok);
    }
  }
  return names;
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
