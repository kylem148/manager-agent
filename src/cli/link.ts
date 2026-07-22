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
import { c, line } from "../ui.js";

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

  // 1. Repo path.
  const repoPath = await promptWithDefault(
    "Target repo path (the coding agent runs here): ",
    existing.repoPath,
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

/**
 * `co pane <name>` — designate the crew anchor pane (one-time, macOS + Ghostty).
 *
 * The user focuses the pane they want crew jobs to grow from (top-left in the
 * captain's layout). We read Ghostty's focused pane id via AppleScript, tag it
 * with a discoverable title (co-crew:<instance>), and persist both so the
 * transport finds the anchor on every dispatch and across restarts.
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
  line(c.dim("  Focus the Ghostty pane you want crew jobs to grow from (the top-left crew"));
  line(c.dim("  pane in the standard layout), then come back here."));
  line();
  if (process.stdin.isTTY) {
    await promptWithDefault("Press Enter once that pane is focused… ", "");
  }

  const title = crewPaneTitle(name);
  let paneId: string;
  try {
    paneId = await readFocusedPaneId(title);
  } catch (e) {
    line(c.red(`could not reach Ghostty via AppleScript: ${(e as Error).message}`));
    line(c.dim("Make sure Ghostty 1.3.0+ is running and grant the automation permission when prompted."));
    return 1;
  }
  if (!paneId) {
    line(c.red("Ghostty did not report a focused pane. Is a Ghostty window focused?"));
    return 1;
  }

  await setAnchor(paths, { id: paneId, title });
  line(c.green(`crew anchor set: pane ${paneId} tagged "${title}".`));
  line(c.dim("Dispatches now take over this pane first, then subdivide it as more jobs run."));
  return 0;
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
 * Read the id of Ghostty's currently-focused pane and tag it with `title` in one
 * AppleScript round trip, so the anchor is both identified and made discoverable
 * at once. Returns the pane id string.
 */
async function readFocusedPaneId(title: string): Promise<string> {
  const t = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = [
    'tell application "Ghostty"',
    "  set p to (front window's selected tab's selected pane)",
    `  set title of p to "${t}"`,
    "  return id of p as string",
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
