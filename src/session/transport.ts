import { spawn, spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { resolveArgv, resolveAgentCommand, shellQuote, type DispatchConfig } from "./dispatchconfig.js";
import type { InstancePaths } from "../paths.js";
import { CrewPaneLayout, type PlacementDecision } from "./crewpanes.js";

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
 *  watcher scans for this to know a job is done; the number is the crew
 *  process's real exit code, captured the same way on both transports (see
 *  buildShellCommand). It is -1 only when the code is missing or unparseable. */
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
 * The probe is deliberately cheap and side-effect free: ask Ghostty for its own
 * `version`. Probing Ghostty directly (rather than asking System Events for the
 * process list) matters for permissions — the visible-pane path already needs
 * automation access to Ghostty, so this reuses that one grant instead of
 * requiring a SECOND grant for System Events. If `osascript` is missing, the
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
    const res = spawnSync("osascript", ["-e", 'tell application "Ghostty" to get version'], {
      encoding: "utf8",
      timeout: 4000,
    });
    // A version string on success; anything else (not installed, permission
    // denied, not scriptable) means fall back.
    return !res.error && res.status === 0 && res.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Pick the transport for this environment. Ghostty when available, else fallback. */
export function chooseTransport(): TransportKind {
  return isGhosttyAvailable() ? "ghostty" : "fallback";
}

/**
 * Whether a terminal with `id` still exists in Ghostty. The designated anchor is
 * stored by id (the API can't tag panes), and a pane can be closed between
 * sessions, so before treating the anchor as usable we verify it. Uses the
 * dictionary's `exists`, which returns false cleanly for a stale id rather than
 * erroring. Best-effort: any AppleScript failure returns false so we degrade to
 * the background transport instead of throwing.
 */
export async function anchorExists(id: string): Promise<boolean> {
  const script = [
    'tell application "Ghostty"',
    `  return (exists (first terminal whose id = "${osaEscape(id)}"))`,
    "end tell",
  ].join("\n");
  try {
    return (await osaRunner(script)).trim() === "true";
  } catch {
    return false;
  }
}

/**
 * The interactive command run inside a pane or as a detached process. It cd's
 * into the repo, launches the agent, tees output to the capture file, then
 * appends the sentinel with the crew process's real exit code. Written as a
 * single string so both transports share the same completion contract.
 *
 * The repo is supplied as the working directory (a leading `cd`), not as a
 * command-line flag: Claude Code has no --dir, and --add-dir only adds extra
 * readable dirs rather than setting the working directory. A `cd ... || exit`
 * makes a bad repo path fail loudly (captured, with a nonzero sentinel) instead
 * of silently running the agent in the wrong directory. An empty repo path skips
 * the cd and runs wherever the transport's own cwd points.
 *
 * Exit-code capture is shell-agnostic. The crew command is piped into `tee`, so
 * its status lives in the pipe's first stage, not in `$?` (which holds tee's 0).
 * We do NOT read it back with `${PIPESTATUS[0]}`: that array is bash-only. This
 * string runs under two shells we do not choose — the fallback's `sh` (dash on
 * many Linux hosts, where `${PIPESTATUS...}` is a hard "Bad substitution") and,
 * on the pane path, the user's interactive login shell (zsh, where PIPESTATUS is
 * unset and the expansion silently falls back to tee's 0, masking failures). So
 * instead the crew command writes its own `$?` to a sidecar file the instant it
 * exits — inside the pipe's first stage, before tee runs — and the sentinel
 * reads that file. `$?` immediately after a command is portable to every POSIX
 * shell, so this reports the crew process's real code whatever shell runs it.
 * The sidecar sits next to the capture file (<capture>.exit) and is removed once
 * read; the watcher only ever reads the capture file itself, never the dir.
 *
 * The agent argv is shell-quoted token by token; the {prompt} token already holds
 * the full order text as one argv element (see resolveArgv), so quoting it once
 * here is correct regardless of newlines or metacharacters in the order.
 */
export function buildShellCommand(argv: string[], captureFile: string, cwd?: string): string {
  const quotedCmd = argv.map(shellQuote).join(" ");
  const quotedCapture = shellQuote(captureFile);
  const quotedExit = shellQuote(`${captureFile}.exit`);
  // The sentinel is echoed to BOTH the tee'd file and the pane/terminal so the
  // user sees the run finish and the watcher sees the marker. `2>&1` folds stderr
  // into the capture. `echo $? > <exit>` runs in the same subshell as the crew
  // command, right after it, so it records the crew status (not tee's) portably.
  const cdPrefix = cwd && cwd.trim() ? `cd ${shellQuote(cwd)} || exit 1; ` : "";
  return (
    `${cdPrefix}{ ${quotedCmd}; echo $? > ${quotedExit}; } 2>&1 | tee ${quotedCapture}; ` +
    `echo "${SENTINEL_PREFIX} $(cat ${quotedExit} 2>/dev/null)" | tee -a ${quotedCapture}; ` +
    `rm -f ${quotedExit}`
  );
}

/**
 * Build the argv for a job's agent command from the config. Picks the crew agent
 * (the confirm-time override `agentName`, else the config default) and resolves
 * its command's placeholders. Command assembly is live here, not a frozen string:
 * a config persisted before agent selection is migrated on read (see coerce).
 */
export function jobArgv(config: DispatchConfig, order: string, agentName?: string): string[] {
  const command = resolveAgentCommand(config, agentName);
  return resolveArgv(command, { prompt: order, repo: config.repoPath });
}

// --- AppleScript composition (pure, unit-testable) --------------------------

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
export function osaEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Compose the AppleScript that places a crew job and launches it, returning the
 * hosting terminal's id on the last line so the caller can commit() it. Runs via
 * `osascript -e`.
 *
 * Grammar verified against Ghostty.sdef (1.3.x) and live Ghostty:
 *  - the scriptable object is a `terminal`, referenced app-wide by its stable id
 *    with `first terminal whose id = "..."`;
 *  - `split <terminal> direction <right|down|left|up>` returns the new terminal;
 *  - a command is run by pasting it with `input text <cmd> to <terminal>` then
 *    `send key "enter" to <terminal>`.
 *
 * Note what the API does NOT allow: a terminal's title is read-only, so panes
 * cannot be tagged for discovery — the stable `id` is the only handle, which is
 * what the planner and the persisted anchor use. Every crew pane is a plain
 * shell (no launch-time `command`), so a finished job returns to its prompt and
 * the pane stays reusable; that is why we inject rather than launch via a surface
 * configuration (which would close the pane on command exit).
 */
export function composeSplitScript(args: { decision: PlacementDecision; shellCommand: string }): string {
  const { decision, shellCommand } = args;
  const cmd = osaEscape(shellCommand);

  // A takeover or reuse runs in an existing terminal by id; a split makes a new
  // terminal from the target and runs there. `queue` never reaches the transport
  // (the caller holds it), so it is not represented here.
  if (decision.kind === "split") {
    return [
      'tell application "Ghostty"',
      `  set target to (first terminal whose id = "${osaEscape(decision.target)}")`,
      `  set newTerm to (split target direction ${decision.direction})`,
      `  input text "${cmd}" to newTerm`,
      '  send key "enter" to newTerm',
      "  return (id of newTerm as text)",
      "end tell",
    ].join("\n");
  }
  // takeover / reuse: run in the existing terminal by id.
  const paneId = decision.kind === "takeover" || decision.kind === "reuse" ? decision.paneId : "";
  return [
    'tell application "Ghostty"',
    `  set target to (first terminal whose id = "${osaEscape(paneId)}")`,
    `  input text "${cmd}" to target`,
    '  send key "enter" to target',
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
  /** The confirm-time agent override; omit to use the config default. */
  agentName?: string;
}): Promise<LaunchResult> {
  const { paths, config, layout, jobId, order, agentName } = args;
  await ensureCaptureDir(paths);
  const captureFile = paths.captureFile(jobId);
  await fsp.writeFile(captureFile, "", "utf8"); // fresh capture

  const decision = layout.plan();
  if (decision.kind === "queue") {
    // Nothing to launch; the caller re-plans when a pane frees.
    return { transport: "ghostty", placement: decision };
  }

  const argv = jobArgv(config, order, agentName);
  // The pane is a plain shell with no spawn cwd of its own, so the repo working
  // directory is set by the `cd` inside the shell command.
  const shellCommand = buildShellCommand(argv, captureFile, config.repoPath);
  const script = composeSplitScript({ decision, shellCommand });

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
  /** The confirm-time agent override; omit to use the config default. */
  agentName?: string;
}): Promise<LaunchResult> {
  const { paths, config, jobId, order, agentName } = args;
  await ensureCaptureDir(paths);
  const captureFile = paths.captureFile(jobId);
  const argv = jobArgv(config, order, agentName);
  // Set the repo cwd two ways that agree: the spawn cwd below (the real working
  // directory of the detached process) and, when the repo exists, the `cd` baked
  // into the shell command so the assembled command is self-describing and
  // matches the pane path exactly. Only pass the cd when the path exists, so a
  // missing repo degrades to the spawn cwd (undefined → inherit) rather than a
  // hard `cd ... || exit` failure the moment a repo hasn't been created yet.
  const repoExists = Boolean(config.repoPath) && fs.existsSync(config.repoPath);
  const shellCommand = buildShellCommand(argv, captureFile, repoExists ? config.repoPath : undefined);

  // We run through `sh -c` so the tee + sentinel contract matches the pane path.
  // detached:true puts the child in its own process group; unref() lets the
  // parent event loop exit independently. stdio is ignored because all output is
  // already tee'd to the capture file by the shell command itself.
  const child = spawn("sh", ["-c", shellCommand], {
    cwd: repoExists ? config.repoPath : undefined,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { transport: "fallback", pid: child.pid };
}
