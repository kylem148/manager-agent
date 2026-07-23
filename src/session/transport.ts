import { spawn, spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { resolveCommandLine, resolveAgentCommand, shellQuote, type DispatchConfig } from "./dispatchconfig.js";
import type { InstancePaths } from "../paths.js";
import { CrewPaneLayout, type PlacementDecision } from "./crewpanes.js";
import { SENTINEL_PREFIX, sentinelLine, parseSentinel } from "./sentinel.js";

// Re-exported so every existing importer of the sentinel (registry, tests) keeps
// working unchanged; the marker itself now lives in sentinel.ts so the Stop-hook
// entry can share it without pulling in this transport graph. Contract identical.
export { SENTINEL_PREFIX, sentinelLine, parseSentinel };

/**
 * Two transports for launching a coding agent, chosen automatically:
 *
 *  - GHOSTTY (macOS only): open a visible split pane in the user's current tab
 *    via AppleScript and launch the agent interactively there so the user can
 *    watch and answer it. Pane placement is delegated wholesale to crewpanes.ts
 *    (plan/commit); this module only turns a PlacementDecision into `osascript`
 *    calls.
 *  - FALLBACK (everywhere else): a detached background subprocess with output
 *    redirected to the same capture file. No geometry, no GUI.
 *
 * Both write a per-job capture file and both append a COMPLETION SENTINEL line
 * once the agent exits, because an interactive pane gives us no clean exit code
 * to observe — the watcher (registry.ts) tails the file for that marker.
 *
 * HOW A PANE JOB IS DELIVERED (and why): the full job — cd, crew command with
 * the order text, capture, sentinel — is written to a per-job SCRIPT FILE, and
 * the pane only ever receives a launch of that file. Never the job itself. Two
 * delivery modes:
 *
 *  - A fresh SPLIT is created with a `surface configuration` whose `command`
 *    launches the script directly (verified against Ghostty 1.3's sdef). The
 *    pane is born running the job; nothing is typed anywhere.
 *  - TAKEOVER/REUSE of an existing pane injects ONE short line
 *    (`/bin/sh '<script>'`) via `input text` + enter. `input text` pastes into
 *    whatever owns the pane, so this is only safe because the line is tiny and
 *    because we PROBE afterwards: the script's first act is creating the capture
 *    file, so if it doesn't appear quickly the pane wasn't an idle shell (an
 *    editor, a running agent...) and the launch degrades to the background
 *    transport via PaneUnavailableError instead of corrupting that program.
 *
 * An earlier revision assembled one giant shell string — order text included —
 * and typed it into the pane. A multi-line order pastes as multiple lines, and
 * whatever was focused (in the observed failure, an interactive claude session)
 * ate the head as input while the tail spilled onto the prompt. The script file
 * exists so no order byte ever rides the keystroke path.
 *
 * Inside the script the crew runs attached DIRECTLY to the pane tty — nothing
 * interposed — so the pane behaves exactly like a human-opened agent session.
 * The capture file is therefore NOT a recording: it is the launch probe plus
 * the completion sentinel (and degrade notes). The reviewable record of a pane
 * run comes from the agent's own session transcript (crewtranscript.ts); the
 * background fallback still records real output since print-mode agents write
 * plain text. See buildJobScript for why (a pty recorder broke native
 * behavior and produced unreviewable escape soup). The co process's PATH is
 * baked into the script because a command-launched Ghostty surface gets only
 * the bare GUI PATH (verified: /usr/bin:/bin:...), which would not find a
 * user-installed agent binary.
 */

// SENTINEL_PREFIX / sentinelLine / parseSentinel now live in sentinel.ts and are
// re-exported at the top of this module (see the import). The marker on the pane
// path comes from the crew's real `$?` (see buildJobScript); on the background
// fallback from the `.exit` sidecar (buildShellCommand); and, once the crew is a
// Claude Code run, the Stop hook appends an early exit-0 sentinel on the first
// finish (crewstophook.ts). parseSentinel scans from the end, so the last marker
// present — the real process exit code — wins when more than one is written.

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
 * The crew command arrives already resolved to a shell command line (see
 * resolveCommandLine): the operator-configured template run verbatim, with only
 * the {prompt}/{repo} values shell-quoted. We interpolate it straight into the
 * pipeline so the shell interprets any env-var prefix or arguments it carries.
 *
 * An optional `note` is echoed into the capture ahead of the crew output — used
 * by the background fallback to record WHY it ran in the background (e.g. a stale
 * crew pane) so a degraded run is self-describing rather than looking like a
 * plain background dispatch. The note rides the same `2>&1 | tee` as the crew
 * output, so it lands at the top of the capture without a second write that the
 * tee (overwrite) would clobber. It sits before the crew command, so the sidecar
 * still records the CREW's `$?`, not the note echo's.
 */
export function buildShellCommand(
  crewCommand: string,
  captureFile: string,
  cwd?: string,
  note?: string,
): string {
  const quotedCapture = shellQuote(captureFile);
  const quotedExit = shellQuote(`${captureFile}.exit`);
  // The sentinel is echoed to BOTH the tee'd file and the pane/terminal so the
  // user sees the run finish and the watcher sees the marker. `2>&1` folds stderr
  // into the capture. `echo $? > <exit>` runs in the same subshell as the crew
  // command, right after it, so it records the crew status (not tee's) portably.
  const cdPrefix = cwd && cwd.trim() ? `cd ${shellQuote(cwd)} || exit 1; ` : "";
  const notePrefix = note && note.trim() ? `echo ${shellQuote(note)}; ` : "";
  return (
    `${cdPrefix}{ ${notePrefix}${crewCommand}; echo $? > ${quotedExit}; } 2>&1 | tee ${quotedCapture}; ` +
    `echo "${SENTINEL_PREFIX} $(cat ${quotedExit} 2>/dev/null)" | tee -a ${quotedCapture}; ` +
    `rm -f ${quotedExit}`
  );
}

/**
 * Build the shell command line for a job's agent from the config. Picks the crew
 * agent (the confirm-time override `agentName`, else the config default) and
 * resolves its template's placeholders into a runnable command line, shell-quoting
 * only the {prompt}/{repo} values. Command assembly is live here, not a frozen
 * string: a config persisted before agent selection is migrated on read (see
 * coerce).
 */
export function jobCommandLine(config: DispatchConfig, order: string, agentName?: string): string {
  const command = resolveAgentCommand(config, agentName);
  return resolveCommandLine(command, { prompt: order, repo: config.repoPath });
}

/**
 * The correlation the Stop hook reads from its inherited environment (see
 * crewstophook.ts): the job stem and the absolute captures dir, derived FROM the
 * capture file so they can never drift from what the registry polls. The stem is
 * the capture basename minus its `.log`, so the hook rebuilds the exact same
 * <dir>/<stem>.log to append its sentinel and writes <dir>/<stem>.stop.json
 * beside it. Exported so both transports and the registry agree on the sidecar.
 */
export function dispatchCorrelation(captureFile: string): { job: string; captureDir: string } {
  return {
    job: path.basename(captureFile).replace(/\.log$/, ""),
    captureDir: path.dirname(captureFile),
  };
}

/** The correlation as a child-process environment fragment: the two vars the
 *  Stop hook reads (crewstophook.ts) from CO_DISPATCH_JOB / CO_DISPATCH_CAPTURE_DIR.
 *  Used by the background fallback, which sets the crew process env directly via
 *  spawn; the pane path bakes the same values into its generated script instead. */
export function dispatchCorrelationEnv(captureFile: string): {
  CO_DISPATCH_JOB: string;
  CO_DISPATCH_CAPTURE_DIR: string;
} {
  const { job, captureDir } = dispatchCorrelation(captureFile);
  return { CO_DISPATCH_JOB: job, CO_DISPATCH_CAPTURE_DIR: captureDir };
}

/** The per-job launch script written beside a capture file on the pane path
 *  (see buildJobScript). One resolver shared with the registry: the script's
 *  last act is removing itself, so its continued existence is the live signal
 *  that the crew process is still running in its pane — which is how the
 *  registry knows a hook-completed pane is not yet reusable. */
export function jobScriptFile(captureFile: string): string {
  return `${captureFile}.sh`;
}

/**
 * The per-job launch script for the PANE path. Written to disk next to the
 * capture file; the pane only ever receives `/bin/sh '<this file>'` (plus a
 * `hold` argument on the split path). Everything fragile lives in here, read by
 * sh as a file, so a multi-line order or an apostrophe can never be re-tokenized
 * by a terminal's input handling.
 *
 * The crew command runs attached DIRECTLY to the pane's tty — no recorder, no
 * pipe, nothing interposed — so a dispatched agent is indistinguishable from
 * one a human launched in that pane: same termios, same window-size updates on
 * resize, same in-band key-protocol negotiation with Ghostty. An earlier
 * revision wrapped the crew in /usr/bin/script(1) to record a capture; that
 * intermediary pty broke native behavior (verified: macOS script(1) does not
 * forward SIGWINCH, so the agent renders at a stale size after any pane
 * resize) and its recording of a full-screen TUI was escape-mangled past
 * usefulness for review anyway. The reviewable record now comes from the
 * agent's own session transcript (see crewtranscript.ts); the capture file
 * remains as the launch probe + completion sentinel channel only.
 *
 * Completion must survive how humans actually close an agent:
 *  - Ctrl-C: SIGINT goes to the pane's foreground process GROUP — this sh as
 *    well as the agent. `trap : INT` keeps sh alive (a command trap is NOT
 *    inherited by children, so the agent still receives its own SIGINT and
 *    handles it per its UX); sh then writes the sentinel with the agent's real
 *    exit code. Without this, quitting an agent with Ctrl-C killed the wrapper
 *    before the sentinel was written and the job never reported back.
 *  - Pane closed / kill: HUP and TERM write the sentinel (129/143) before
 *    dying, so even a torn-down pane reports completion.
 *
 * PATH is pinned to the co process's own PATH: a command-launched Ghostty
 * surface inherits only the bare GUI PATH, which won't contain a user-installed
 * agent (e.g. ~/.local/bin/claude). The rest of the surface env is fine as
 * Ghostty ships it (LANG, TERM, TERMINFO, COLORTERM all verified present).
 *
 * With `hold` (a pane born from a surface configuration, which would otherwise
 * close when its command exits) the script finally execs a login shell so the
 * pane stays open and reusable — the same end state as a pane that started as
 * a shell.
 */
export function buildJobScript(args: {
  crewCommand: string;
  captureFile: string;
  scriptPath: string;
  cwd?: string;
  pathEnv?: string;
}): string {
  const { crewCommand, captureFile, scriptPath, cwd, pathEnv } = args;
  const qCapture = shellQuote(captureFile);
  const qSelf = shellQuote(scriptPath);
  // Hand the crew process (and thus its inherited-environment Stop hook) the
  // correlation the hook reads to find this exact capture — see crewstophook.ts.
  const { job, captureDir } = dispatchCorrelation(captureFile);
  const lines = [
    "#!/bin/sh",
    "# Generated by co dispatch for a single crew job; removes itself when done.",
    ...(pathEnv ? [`PATH=${shellQuote(pathEnv)}; export PATH`] : []),
    `CO_DISPATCH_JOB=${shellQuote(job)}; export CO_DISPATCH_JOB`,
    `CO_DISPATCH_CAPTURE_DIR=${shellQuote(captureDir)}; export CO_DISPATCH_CAPTURE_DIR`,
    `finished=0`,
    `finish() {`,
    `  [ "$finished" = 1 ] && return`,
    `  finished=1`,
    `  printf '%s %s\\n' ${shellQuote(SENTINEL_PREFIX)} "$1" >> ${qCapture}`,
    `  rm -f ${qSelf}`,
    `}`,
    // Ctrl-C belongs to the crew; this sh survives it to report completion.
    `trap : INT`,
    `trap 'finish 129; exit 129' HUP`,
    `trap 'finish 143; exit 143' TERM`,
    // Creating the capture is the launch probe the transport polls for.
    `: > ${qCapture}`,
    ...(cwd && cwd.trim()
      ? [
          `cd ${shellQuote(cwd)} || {`,
          `  echo "co dispatch: cannot cd to ${cwd.replace(/"/g, '\\"')}" >> ${qCapture}`,
          `  finish 1`,
          `  exit 1`,
          `}`,
        ]
      : []),
    crewCommand,
    `code=$?`,
    `finish "$code"`,
    `printf 'co dispatch: job finished (exit %s)\\n' "$code"`,
    // The held shell outlives the job: drop the job identity so a claude the
    // human later launches by hand in this pane doesn't inherit it. (Fire-once
    // would suppress a stray capture anyway; this keeps the env honest too.)
    `unset CO_DISPATCH_JOB CO_DISPATCH_CAPTURE_DIR`,
    `if [ "$1" = hold ]; then`,
    `  exec "\${SHELL:-/bin/zsh}" -l`,
    `fi`,
    ``,
  ];
  return lines.join("\n");
}

/**
 * Make a raw capture readable for review. Background captures can carry color
 * codes and progress-line `\r` overwrites from agents that style their print
 * output. This strips OSC/CSI/other escape sequences, resolves `\r` overwrites
 * by keeping the last write of each line, drops remaining control bytes, and
 * collapses blank-line runs — best-effort readability, not terminal-faithful
 * rendering. The sentinel line is plain text and survives untouched.
 */
export function scrubCapture(raw: string): string {
  let s = raw.replace(/\r\n/g, "\n");
  // OSC (title sets etc.): ESC ] ... terminated by BEL or ST.
  s = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "");
  // CSI sequences (colors, cursor movement, private modes).
  s = s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  // Any other two-byte ESC sequence (charset shifts, keypad modes...).
  s = s.replace(/\x1b[@-_=><]/g, "");
  // A carriage return rewinds the cursor: the last segment is what remained
  // visible (spinners, progress lines).
  s = s
    .split("\n")
    .map((line) => line.split("\r").pop() ?? "")
    .join("\n");
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  return s.replace(/\n{3,}/g, "\n\n");
}

// --- AppleScript composition (pure, unit-testable) --------------------------

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
export function osaEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Compose the AppleScript that places a crew job and launches it, returning the
 * hosting terminal's id on the last line so the caller can commit() it. Runs via
 * `osascript -e`. `launchCommand` is the SHORT script-file launch line (see
 * buildJobScript), never the job itself.
 *
 * Grammar verified against Ghostty.sdef (1.3.x) and live Ghostty 1.3.1:
 *  - the scriptable object is a `terminal`, referenced app-wide by its stable id
 *    with `first terminal whose id = "..."`;
 *  - `split <terminal> direction <right|down|left|up> with configuration
 *    {command:"..."}` creates the new terminal ALREADY RUNNING the command on a
 *    real tty (probed live: stdin and stdout are both ttys) — no injection, so
 *    a fresh split can never deliver the job into the wrong program. The pane
 *    would close when the command exits, which is why the split launch passes
 *    `hold` (the script execs a shell at the end, keeping the pane alive and
 *    reusable);
 *  - for an EXISTING pane (takeover/reuse) there is no way to set a command, so
 *    the launch line is pasted with `input text <cmd> to <terminal>` then
 *    `send key "enter"`. `input text` pastes into whatever owns the pane, which
 *    is why the caller probes for the capture file afterwards and degrades to
 *    the background transport if the job never started.
 *
 * Note what the API does NOT allow: a terminal's title is read-only, so panes
 * cannot be tagged for discovery — the stable `id` is the only handle, which is
 * what the planner and the persisted anchor use.
 */
export function composeSplitScript(args: { decision: PlacementDecision; launchCommand: string }): string {
  const { decision, launchCommand } = args;
  const cmd = osaEscape(launchCommand);

  // A takeover or reuse runs in an existing terminal by id; a split makes a new
  // terminal from the target and runs there. `queue` never reaches the transport
  // (the caller holds it), so it is not represented here.
  if (decision.kind === "split") {
    return [
      'tell application "Ghostty"',
      `  set target to (first terminal whose id = "${osaEscape(decision.target)}")`,
      `  set newTerm to (split target direction ${decision.direction} with configuration {command:"${cmd}"})`,
      "  return (id of newTerm as text)",
      "end tell",
    ].join("\n");
  }
  // takeover / reuse: paste the one-line launch into the existing terminal.
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

/** AppleScript to close a terminal by id — used to reap a split we created but
 *  whose job never started (probe timeout), so a failed launch doesn't leak a
 *  stray pane. Best-effort; the caller ignores errors. */
export function composeCloseScript(paneId: string): string {
  return [
    'tell application "Ghostty"',
    `  close (first terminal whose id = "${osaEscape(paneId)}")`,
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
 * A pane launch that couldn't target its Ghostty pane: the anchor id no longer
 * resolves (Ghostty's -1719 "Invalid index"), an `exists` check came back false,
 * or `osascript` failed some other way. Distinct from a generic Error so the
 * registry can tell "the pane is gone, run in the background" apart from a real
 * bug and degrade cleanly instead of failing the whole dispatch. `paneId` is the
 * id we tried to target, for the background note.
 */
export class PaneUnavailableError extends Error {
  readonly paneId: string;
  constructor(paneId: string, cause: string) {
    super(`crew pane ${paneId} unavailable: ${cause}`);
    this.name = "PaneUnavailableError";
    this.paneId = paneId;
  }
}

/** How long a pane launch gets to prove the job started (the script's first act
 *  is creating the capture file) before we call the pane busy and degrade to the
 *  background transport. Generous: a fresh surface or an idle shell starts the
 *  script within a few hundred ms; only the failure case waits this long. */
const PANE_START_TIMEOUT_MS = 4000;
const PANE_START_POLL_MS = 120;

/** Poll for a file to come into existence, up to timeoutMs. */
async function waitForFileCreation(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(file)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, PANE_START_POLL_MS));
  }
}

/**
 * Launch a job on the visible-Ghostty path. Consumes crewpanes.ts seams: plan()
 * to decide placement, then commit(newPaneId) with the id AppleScript returns —
 * or abort() if the launch fails, so a dead dispatch never corrupts the layout.
 * A `queue` decision places nothing and is returned to the caller to hold.
 *
 * Delivery is by per-job script file (see buildJobScript): a split launches it
 * as the new pane's command; takeover/reuse paste the one-line launch. After
 * either, we wait for the capture file the script creates on startup. If it
 * never appears, the pane didn't run the launch line (it wasn't an idle shell —
 * an editor or another agent owns it), so the plan is aborted, a
 * split-we-created is closed, and the job degrades to the background transport.
 *
 * Any AppleScript failure targeting the pane (a closed/stale anchor surfaces as
 * Ghostty error -1719, plus permission or not-running failures) is likewise
 * re-raised as a PaneUnavailableError so the registry falls back to the
 * background transport rather than failing the dispatch. The capture file is
 * created only by the launched script itself — that is what makes it a
 * trustworthy launch probe.
 */
export async function launchGhostty(args: {
  paths: InstancePaths;
  config: DispatchConfig;
  layout: CrewPaneLayout;
  jobId: string;
  order: string;
  /** The confirm-time agent override; omit to use the config default. */
  agentName?: string;
  /** Capture file override (the registry namespaces these per session); defaults
   *  to the instance's captureFile(jobId) for direct callers and tests. */
  captureFile?: string;
  /** Probe budget override for tests. */
  paneStartTimeoutMs?: number;
}): Promise<LaunchResult> {
  const { paths, config, layout, jobId, order, agentName } = args;
  await ensureCaptureDir(paths);
  const captureFile = args.captureFile ?? paths.captureFile(jobId);

  const decision = layout.plan();
  if (decision.kind === "queue") {
    // Nothing to launch; the caller re-plans when a pane frees.
    return { transport: "ghostty", placement: decision };
  }

  const crewCommand = jobCommandLine(config, order, agentName);
  // The job script owns everything fragile: cd, the (possibly multi-line) order,
  // capture, exit sidecar, sentinel. The pane only ever sees the launch line.
  const scriptPath = jobScriptFile(captureFile);
  await fsp.writeFile(
    scriptPath,
    buildJobScript({
      crewCommand,
      captureFile,
      scriptPath,
      cwd: config.repoPath,
      ...(process.env.PATH ? { pathEnv: process.env.PATH } : {}),
    }),
    "utf8",
  );
  const launchCommand =
    decision.kind === "split"
      ? `/bin/sh ${shellQuote(scriptPath)} hold`
      : `/bin/sh ${shellQuote(scriptPath)}`;
  const script = composeSplitScript({ decision, launchCommand });
  // The id we're aiming at, for a PaneUnavailableError note if the launch fails.
  const targetId =
    decision.kind === "split" ? decision.target : decision.paneId;

  let returnedId: string;
  try {
    returnedId = await osaRunner(script);
  } catch (e) {
    layout.abort();
    await fsp.rm(scriptPath, { force: true }).catch(() => {});
    // Every osascript failure on this path is a pane-targeting failure: the
    // anchor was closed (-1719), automation was denied, or Ghostty went away.
    // Surface it as PaneUnavailableError so the registry degrades to background.
    throw new PaneUnavailableError(targetId, (e as Error).message);
  }
  // takeover/reuse return the known pane id; split returns the fresh one.
  const paneId = decision.kind === "split" ? returnedId : decision.paneId;

  // The launch probe: the script creates the capture file immediately. No file,
  // no launch — the pane was busy (or the surface command failed), so undo the
  // placement and let the registry run this job in the background instead.
  const started = await waitForFileCreation(
    captureFile,
    args.paneStartTimeoutMs ?? PANE_START_TIMEOUT_MS,
  );
  if (!started) {
    layout.abort();
    if (decision.kind === "split" && returnedId) {
      // We created this pane and nothing is running in it; reap it.
      try {
        await osaRunner(composeCloseScript(returnedId));
      } catch {
        /* best-effort */
      }
    }
    await fsp.rm(scriptPath, { force: true }).catch(() => {});
    throw new PaneUnavailableError(
      paneId || targetId,
      "the job never started there (pane busy with another program?)",
    );
  }
  layout.commit(paneId);
  return { transport: "ghostty", paneId, placement: decision };
}

/**
 * Launch a job as a detached background subprocess (portable fallback). Output is
 * captured to the same per-job file, and the sentinel is appended on exit. The
 * child is fully detached and unref'd so the co-manager session never blocks on
 * it and it survives being backgrounded. No pane geometry is involved.
 *
 * `note` is written to the top of the capture when present — the registry passes
 * a "target pane <id> unavailable; ran in background" line when it degrades here
 * from a failed pane launch, so a fallback that stood in for a dead pane is never
 * a silently-empty log. This is the SOLE writer of the capture on this path (the
 * pane launch no longer pre-writes it), so the note can't be clobbered by a tee.
 */
export async function launchFallback(args: {
  paths: InstancePaths;
  config: DispatchConfig;
  jobId: string;
  order: string;
  /** The confirm-time agent override; omit to use the config default. */
  agentName?: string;
  /** A human-readable note recorded at the top of the capture (e.g. why we fell
   *  back to background). Omit for a plain background dispatch. */
  note?: string;
  /** Capture file override (the registry namespaces these per session); defaults
   *  to the instance's captureFile(jobId) for direct callers and tests. */
  captureFile?: string;
}): Promise<LaunchResult> {
  const { paths, config, jobId, order, agentName, note } = args;
  await ensureCaptureDir(paths);
  const captureFile = args.captureFile ?? paths.captureFile(jobId);
  const crewCommand = jobCommandLine(config, order, agentName);
  // Set the repo cwd two ways that agree: the spawn cwd below (the real working
  // directory of the detached process) and, when the repo exists, the `cd` baked
  // into the shell command so the assembled command is self-describing and
  // matches the pane path exactly. Only pass the cd when the path exists, so a
  // missing repo degrades to the spawn cwd (undefined → inherit) rather than a
  // hard `cd ... || exit` failure the moment a repo hasn't been created yet.
  const repoExists = Boolean(config.repoPath) && fs.existsSync(config.repoPath);
  const shellCommand = buildShellCommand(
    crewCommand,
    captureFile,
    repoExists ? config.repoPath : undefined,
    note,
  );

  // We run through `sh -c` so the tee + sentinel contract matches the pane path.
  // detached:true puts the child in its own process group; unref() lets the
  // parent event loop exit independently. stdio is ignored because all output is
  // already tee'd to the capture file by the shell command itself. The
  // correlation env lets a Claude Code crew's Stop hook capture on first finish;
  // it rides in the child env just as the pane script bakes it in.
  const child = spawn("sh", ["-c", shellCommand], {
    cwd: repoExists ? config.repoPath : undefined,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...dispatchCorrelationEnv(captureFile) },
  });
  child.unref();
  return { transport: "fallback", pid: child.pid };
}
