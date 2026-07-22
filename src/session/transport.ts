import { spawn, spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { resolveArgv, shellQuote, type DispatchConfig } from "./dispatchconfig.js";
import type { InstancePaths } from "../paths.js";
import { CrewPaneLayout, crewPaneTitle, type PlacementDecision } from "./crewpanes.js";

/**
 * Two transports for launching a coding agent, chosen automatically:
 *
 *  - GHOSTTY (macOS only): open a visible split pane in the user's current tab
 *    via AppleScript, launch the agent interactively there so the user can watch
 *    and answer it, and tee its output to a capture file. Pane placement is
 *    delegated wholesale to crewpanes.ts (plan/commit); this module only turns a
 *    PlacementDecision into `osascript` calls.
 *  - FALLBACK (everywhere else): a detached background subprocess with output
 *    redirected to the same capture file. No geometry, no GUI.
 *
 * Both write a per-job capture file and both append a COMPLETION SENTINEL line
 * once the agent exits, because an interactive pane gives us no clean exit code
 * to observe — the watcher (registry.ts) tails the file for that marker.
 */

/** The marker appended to a capture file after the agent process exits. The
 *  watcher scans for this to know a job is done; the number is the exit code
 *  when we can observe it (fallback) or -1 when we can't (interactive pane). */
export const SENTINEL_PREFIX = "__CO_DISPATCH_DONE__";

export function sentinelLine(exitCode: number): string {
  return `${SENTINEL_PREFIX} ${exitCode}`;
}

/** Parse a completion sentinel out of captured text. Returns the exit code, or
 *  null if the run hasn't signalled completion yet. */
export function parseSentinel(captured: string): { exitCode: number } | null {
  // Scan from the end: the sentinel is the last meaningful line.
  const idx = captured.lastIndexOf(SENTINEL_PREFIX);
  if (idx === -1) return null;
  const rest = captured.slice(idx + SENTINEL_PREFIX.length).trim();
  const code = Number.parseInt(rest.split(/\s/)[0] ?? "", 10);
  return { exitCode: Number.isFinite(code) ? code : -1 };
}

export type TransportKind = "ghostty" | "fallback";

export interface LaunchResult {
  transport: TransportKind;
  /** The Ghostty pane id the run occupies, when applicable. */
  paneId?: string;
  /** The placement decision taken (ghostty only), for reporting/queueing. */
  placement?: PlacementDecision;
  /** Detached child pid (fallback only), so a timeout can kill the group. */
  pid?: number;
}

/**
 * Whether the visible-pane path is usable: macOS, plus Ghostty reachable through
 * AppleScript. We probe once and cache — the answer can't change within a
 * session, and an `osascript` probe per dispatch would be wasteful.
 *
 * The probe is deliberately cheap and side-effect free: ask System Events
 * whether a process named "Ghostty" exists. If `osascript` is missing, the
 * automation permission is denied, or Ghostty isn't running, this returns false
 * and we fall back — never throwing into the caller.
 */
let ghosttyAvailableCache: boolean | null = null;

export function isGhosttyAvailable(): boolean {
  if (ghosttyAvailableCache !== null) return ghosttyAvailableCache;
  ghosttyAvailableCache = probeGhostty();
  return ghosttyAvailableCache;
}

/** Test seam: force the transport decision without a real probe. */
export function setGhosttyAvailableForTest(v: boolean | null): void {
  ghosttyAvailableCache = v;
}

function probeGhostty(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    const res = spawnSync(
      "osascript",
      ["-e", 'tell application "System Events" to (name of processes) contains "Ghostty"'],
      { encoding: "utf8", timeout: 4000 },
    );
    if (res.error || res.status !== 0) return false;
    return res.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** Pick the transport for this environment. Ghostty when available, else fallback. */
export function chooseTransport(): TransportKind {
  return isGhosttyAvailable() ? "ghostty" : "fallback";
}

/**
 * The interactive command run inside a pane or as a detached process. It launches
 * the agent, tees output to the capture file, then appends the sentinel with the
 * captured exit code. Written as a single `sh -c` string so both transports share
 * the same completion contract.
 *
 * The agent argv is shell-quoted token by token; the {prompt} token already holds
 * the full order text as one argv element (see resolveArgv), so quoting it once
 * here is correct regardless of newlines or metacharacters in the order.
 */
export function buildShellCommand(argv: string[], captureFile: string): string {
  const quotedCmd = argv.map(shellQuote).join(" ");
  const quotedCapture = shellQuote(captureFile);
  // `command; code=$?` captures the agent's real exit status even in a pane; the
  // sentinel is echoed to BOTH the tee'd file and the pane so the user sees the
  // run finish and the watcher sees the marker. `2>&1` folds stderr into capture.
  return (
    `{ ${quotedCmd}; } 2>&1 | tee ${quotedCapture}; ` +
    `code=\${PIPESTATUS[0]:-$?}; ` +
    `echo "${SENTINEL_PREFIX} $code" | tee -a ${quotedCapture}`
  );
}

/** Build the argv for a job's agent command from the template + config. */
export function jobArgv(config: DispatchConfig, order: string): string[] {
  return resolveArgv(config.commandTemplate, { prompt: order, repo: config.repoPath });
}

// --- AppleScript composition (pure, unit-testable) --------------------------

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
export function osaEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Compose the AppleScript that splits a crew pane (or targets the anchor for a
 * takeover/reuse) and injects the shell command. Returns the script text; the
 * caller runs it via `osascript -e`. For a `split`, the script returns the new
 * pane's id on its last line so the caller can commit() it to the planner.
 *
 * Ghostty's scripting model (1.3.0+): `split <pane> with direction <dir>` returns
 * the new pane; `tell <pane> to write text <cmd>` types a command; a return key
 * runs it. We tag every crew pane's title so the anchor and existing panes are
 * findable across dispatches and restarts.
 */
export function composeSplitScript(args: {
  decision: PlacementDecision;
  title: string;
  shellCommand: string;
}): string {
  const { decision, title, shellCommand } = args;
  const cmd = osaEscape(shellCommand);
  const t = osaEscape(title);

  // A takeover or reuse targets an existing pane by id; a split creates a new one
  // from the target pane. `queue` never reaches the transport (the caller holds
  // it), so it is not represented here.
  if (decision.kind === "split") {
    return [
      'tell application "Ghostty"',
      `  set target to (first pane whose id is "${osaEscape(decision.target)}")`,
      `  set newPane to (split target with direction ${decision.direction})`,
      `  set title of newPane to "${t}"`,
      `  tell newPane to write text "${cmd}"`,
      "  return id of newPane as string",
      "end tell",
    ].join("\n");
  }
  // takeover / reuse: run in the existing pane by id.
  const paneId = decision.kind === "takeover" || decision.kind === "reuse" ? decision.paneId : "";
  return [
    'tell application "Ghostty"',
    `  set target to (first pane whose id is "${osaEscape(paneId)}")`,
    `  set title of target to "${t}"`,
    `  tell target to write text "${cmd}"`,
    `  return "${osaEscape(paneId)}"`,
    "end tell",
  ].join("\n");
}

/** Run an AppleScript via osascript, returning trimmed stdout. Throws on failure
 *  so the caller can fall back or abort the placement cleanly. */
async function runOsascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`osascript exited ${code}: ${err.trim()}`));
    });
  });
}

/** Seam so tests can drive the Ghostty transport without a GUI. */
export type OsaRunner = (script: string) => Promise<string>;
let osaRunner: OsaRunner = runOsascript;
export function setOsaRunnerForTest(fn: OsaRunner | null): void {
  osaRunner = fn ?? runOsascript;
}

async function ensureCaptureDir(paths: InstancePaths): Promise<void> {
  await fsp.mkdir(paths.captures, { recursive: true });
}

/**
 * Launch a job on the visible-Ghostty path. Consumes crewpanes.ts seams: plan()
 * to decide placement, then commit(newPaneId) with the id AppleScript returns —
 * or abort() if the launch fails, so a dead dispatch never corrupts the layout.
 * A `queue` decision places nothing and is returned to the caller to hold.
 */
export async function launchGhostty(args: {
  paths: InstancePaths;
  config: DispatchConfig;
  layout: CrewPaneLayout;
  jobId: string;
  order: string;
}): Promise<LaunchResult> {
  const { paths, config, layout, jobId, order } = args;
  await ensureCaptureDir(paths);
  const captureFile = paths.captureFile(jobId);
  await fsp.writeFile(captureFile, "", "utf8"); // fresh capture

  const decision = layout.plan();
  if (decision.kind === "queue") {
    // Nothing to launch; the caller re-plans when a pane frees.
    return { transport: "ghostty", placement: decision };
  }

  const argv = jobArgv(config, order);
  const shellCommand = buildShellCommand(argv, captureFile);
  const script = composeSplitScript({
    decision,
    title: crewPaneTitle(paths.name),
    shellCommand,
  });

  try {
    const returnedId = await osaRunner(script);
    // takeover/reuse return the known pane id; split returns the fresh one.
    const paneId = decision.kind === "split" ? returnedId : decision.paneId;
    layout.commit(paneId);
    return { transport: "ghostty", paneId, placement: decision };
  } catch (e) {
    layout.abort();
    throw e;
  }
}

/**
 * Launch a job as a detached background subprocess (portable fallback). Output is
 * captured to the same per-job file, and the sentinel is appended on exit. The
 * child is fully detached and unref'd so the co-manager session never blocks on
 * it and it survives being backgrounded. No pane geometry is involved.
 */
export async function launchFallback(args: {
  paths: InstancePaths;
  config: DispatchConfig;
  jobId: string;
  order: string;
}): Promise<LaunchResult> {
  const { paths, config, jobId, order } = args;
  await ensureCaptureDir(paths);
  const captureFile = paths.captureFile(jobId);
  const argv = jobArgv(config, order);
  const shellCommand = buildShellCommand(argv, captureFile);

  // We run through `sh -c` so the tee + sentinel contract matches the pane path.
  // detached:true puts the child in its own process group; unref() lets the
  // parent event loop exit independently. stdio is ignored because all output is
  // already tee'd to the capture file by the shell command itself.
  const child = spawn("sh", ["-c", shellCommand], {
    cwd: fs.existsSync(config.repoPath) ? config.repoPath : undefined,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { transport: "fallback", pid: child.pid };
}
