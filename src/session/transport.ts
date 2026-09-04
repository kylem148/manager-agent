import { spawn, spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { resolveCommandLine, resolveAgentCommand, shellQuote, type DispatchConfig } from "./dispatchconfig.js";
import { withReadOnlyFlags, type DispatchLane } from "./lanes.js";
import type { InstancePaths } from "../paths.js";
import { CrewPaneLayout, type PlacementDecision, type PlacementInput } from "./crewpanes.js";
import { normalizeTty, type PaneIdentity } from "./paneoccupancy.js";
import { SENTINEL_PREFIX, sentinelLine, parseSentinel } from "./sentinel.js";

// Re-exported so every existing importer of the sentinel (registry, tests) keeps
// working unchanged; the marker itself now lives in sentinel.ts so the Stop-hook
// entry can share it without pulling in this transport graph. Contract identical.
export { SENTINEL_PREFIX, sentinelLine, parseSentinel };

/**
 * The ONE transport for launching a coding agent: a visible Ghostty pane.
 *
 * A crew agent runs in a visible split pane in the user's current tab (opened
 * via AppleScript) or it does not run at all. There is deliberately NO
 * background/headless path: an agent the operator can't see is an agent they
 * can re-dispatch by accident, and two agents racing on the same checkout
 * corrupt the tree. When a visible pane can't be opened the dispatch fails with
 * an actionable error and launches nothing (see PaneUnavailableError and the
 * registry's failure path); it never silently runs somewhere invisible.
 *
 * Pane placement is delegated wholesale to crewpanes.ts (plan/commit); this
 * module only turns a PlacementDecision into `osascript` calls.
 *
 * The pane writes a per-job capture file and appends a COMPLETION SENTINEL line,
 * because an interactive pane gives us no clean exit code to observe — the
 * watcher (registry.ts) tails the file for that marker.
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
 *    editor, a running agent...) and the launch fails with a PaneUnavailableError
 *    instead of corrupting that program. Nothing is retried in the background.
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
 * the completion sentinel. The reviewable record of a pane run comes from the
 * agent's own session transcript (crewtranscript.ts). See buildJobScript for
 * why nothing is interposed (a pty recorder broke native behavior and produced
 * unreviewable escape soup). The co process's PATH is baked into the script
 * because a command-launched Ghostty surface gets only the bare GUI PATH
 * (verified: /usr/bin:/bin:...), which would not find a user-installed agent
 * binary.
 */

// SENTINEL_PREFIX / sentinelLine / parseSentinel now live in sentinel.ts and are
// re-exported at the top of this module (see the import). The marker comes from
// the crew's real `$?` (see buildJobScript) and, once the crew is a Claude Code
// run, the Stop hook appends an early exit-0 sentinel on the first finish
// (crewstophook.ts). parseSentinel scans from the end, so the last marker
// present — the real process exit code — wins when more than one is written.

/** The only transport. A one-member union kept as a named type so Job/LaunchResult
 *  read the same as before; there is no background/headless kind by design. */
export type TransportKind = "ghostty";

export interface LaunchResult {
  transport: TransportKind;
  /** The Ghostty pane id the run occupies, when applicable. */
  paneId?: string;
  /** The placement decision taken, for reporting. */
  placement?: PlacementDecision;
  /** What the launched script reported about its pane: the tty it lives on and
   *  the pid of the process that outlives the job there. The registry remembers
   *  this so a later dispatch can prove the pane idle instead of splitting. */
  identity?: PaneIdentity;
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
 * and the dispatch fails cleanly (there is no background path) — never throwing
 * into the caller.
 */
let ghosttyAvailableCache: boolean | null = null;

export function isGhosttyAvailable(): boolean {
  if (ghosttyAvailableCache !== null) return ghosttyAvailableCache;
  ghosttyAvailableCache = probeGhostty();
  return ghosttyAvailableCache;
}

/** Test seam: force the availability decision without a real probe. */
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
    // denied, not scriptable) means the pane path is unavailable.
    return !res.error && res.status === 0 && res.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Whether a terminal with `id` still exists in Ghostty. The designated anchor is
 * stored by id (the API can't tag panes), and a pane can be closed between
 * sessions, so before treating the anchor as usable we verify it. Uses the
 * dictionary's `exists`, which returns false cleanly for a stale id rather than
 * erroring. Best-effort: any AppleScript failure returns false, and the caller
 * (the registry) then drops the anchor and fails the dispatch cleanly — there is
 * no background path — rather than treating a probe error as a live pane.
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
 * Whether a Ghostty terminal with `id` still exists — the general liveness probe
 * the registry runs over every tracked crew pane before planning a split, so a
 * pane the captain has closed is pruned from the layout before placement ever
 * targets it. Identical probe to anchorExists (the anchor is just one such pane,
 * and both collapse a probe failure to "gone"); named for the general use so the
 * pruning call site reads for what it is.
 */
export const paneExists = anchorExists;

/**
 * Build the shell command line for a job's agent from the config. Picks the crew
 * agent (the confirm-time override `agentName`, else the config default) and
 * resolves its template's placeholders into a runnable command line, shell-quoting
 * only the {prompt}/{repo} values. Command assembly is live here, not a frozen
 * string: a config persisted before agent selection is migrated on read (see
 * coerce).
 *
 * `cwd` overrides what {repo} resolves to (default: the linked repo path). A
 * feature-scoped dispatch launches the crew inside the feature's worktree, and a
 * template that references {repo} must agree with that launch directory: an
 * agent told to run in the worktree but pointed at the primary tree would write
 * to the wrong checkout.
 *
 * `lane` is the READ-ONLY gate (lanes.ts). A reader's template gets the agent's
 * write-capable tools denied at launch where its CLI supports that; where it
 * does not, the template is unchanged and the lane rides on the mandate in the
 * order alone (the arm banner says which of the two the captain is getting).
 */
export function jobCommandLine(
  config: DispatchConfig,
  order: string,
  agentName?: string,
  cwd?: string,
  lane: DispatchLane = "writer",
): string {
  const command = resolveAgentCommand(config, agentName);
  const template = lane === "reader" ? withReadOnlyFlags(command) : command;
  return resolveCommandLine(template, { prompt: order, repo: cwd ?? config.repoPath });
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

/** The per-job launch script written beside a capture file on the pane path
 *  (see buildJobScript). One resolver shared with the registry: the script's
 *  last act is removing itself, so its continued existence is the live signal
 *  that the crew process is still running in its pane — which is how the
 *  registry knows a hook-completed pane is not yet reusable. */
export function jobScriptFile(captureFile: string): string {
  return `${captureFile}.sh`;
}

/**
 * The pane-identity sidecar a job script writes as its very first act: the tty
 * the pane lives on, and the pid of the process that OUTLIVES the job there (the
 * held login shell of a split-born pane, or the shell that ran the launch line
 * on a takeover).
 *
 * This exists because Ghostty's scripting API has no way to ask a terminal what
 * tty it is on — `id`, `name` and `working directory` are the whole surface. The
 * only component that can answer is something running inside the pane, so the
 * launch script answers once and co remembers it (panestore.ts). Without it a
 * pane can never be proven idle, and every dispatch would split a new one.
 */
export function jobTtyFile(captureFile: string): string {
  return `${captureFile}.tty`;
}

/**
 * Read back what the job script reported about its pane. Best-effort in every
 * direction: a missing or malformed sidecar is simply an empty identity, which
 * reads downstream as "this pane can't be proven idle" and costs a split.
 */
export async function readPaneIdentity(captureFile: string): Promise<PaneIdentity> {
  let raw: string;
  try {
    raw = await fsp.readFile(jobTtyFile(captureFile), "utf8");
  } catch {
    return {};
  }
  const tty = normalizeTty(raw.match(/^tty=(.*)$/m)?.[1]);
  const pid = Number(raw.match(/^pid=(\d+)$/m)?.[1] ?? "");
  return {
    ...(tty ? { tty } : {}),
    ...(Number.isInteger(pid) && pid > 0 ? { shellPid: pid } : {}),
  };
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
  const qTty = shellQuote(jobTtyFile(captureFile));
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
    // Report the pane's identity BEFORE the capture file exists, so it is always
    // on disk by the time the transport's launch probe sees the capture and the
    // registry reads it. The pid recorded is the one that OUTLIVES this job in
    // this pane: with `hold` that is this script itself (it execs the login shell
    // at the end, keeping the pid), otherwise it is the pane's own shell, which
    // ran this launch line and will still be there when the job is done. That
    // pair — tty plus a pid alive on it — is how a later dispatch proves this
    // pane is idle instead of guessing (see paneoccupancy.ts).
    `if [ "$1" = hold ]; then co_pane_pid=$$; else co_pane_pid=\${PPID:-0}; fi`,
    `co_tty=$(tty 2>/dev/null) || co_tty=$(ps -o tty= -p $$ 2>/dev/null)`,
    `printf 'tty=%s\\npid=%s\\n' "$co_tty" "$co_pane_pid" > ${qTty} 2>/dev/null`,
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
 *    is why the caller probes for the capture file afterwards and fails the
 *    dispatch (PaneUnavailableError) if the job never started — it never falls
 *    back to running invisibly.
 *
 * Note what the API does NOT allow: a terminal's title is read-only, so panes
 * cannot be tagged for discovery — the stable `id` is the only handle, which is
 * what the planner and the persisted anchor use.
 */
export function composeSplitScript(args: { decision: PlacementDecision; launchCommand: string }): string {
  const { decision, launchCommand } = args;
  const cmd = osaEscape(launchCommand);

  // A takeover or reuse runs in an existing terminal by id; a split makes a new
  // terminal from the target and runs there.
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
 * registry can tell "the pane is gone" apart from a real bug, drop the dead
 * anchor, and fail the dispatch with an actionable message — there is no
 * background path to fall back to. `paneId` is the id we tried to target, for
 * that message.
 */
export class PaneUnavailableError extends Error {
  readonly paneId: string;
  /**
   * True when `paneId` names a pane THIS LAUNCH created and has already reaped,
   * rather than a pane the layout tracks. A successful split whose job never
   * started is the only such case: the id was never committed to the layout, so
   * there is no dead tracked pane to prune and nothing in the layout is wrong —
   * the anchor and every tracked pane are intact. The registry fails that one
   * dispatch and leaves the shared layout (and the link) untouched.
   *
   * False for every failure that targets a pane we did NOT create — a stale or
   * closed anchor, a dead tracked worker, a busy takeover/reuse pane — which keep
   * the existing prune-and-retry / anchor-loss behavior unchanged.
   */
  readonly orphaned: boolean;
  constructor(paneId: string, cause: string, orphaned = false) {
    super(`crew pane ${paneId} unavailable: ${cause}`);
    this.name = "PaneUnavailableError";
    this.paneId = paneId;
    this.orphaned = orphaned;
  }
}

/** How long a pane launch gets to prove the job started (the script's first act
 *  is creating the capture file) before we call the pane busy and fail the
 *  dispatch. Generous: a fresh surface or an idle shell starts the script within
 *  a few hundred ms; only the failure case waits this long. */
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
 * to decide placement (against the caller's fresh occupancy reading), then
 * commit(newPaneId) with the id AppleScript returns — or abort() if the launch
 * fails, so a dead dispatch never corrupts the layout. Every dispatch places
 * somewhere: reuse when a pane co owns is provably idle, a split otherwise.
 *
 * Delivery is by per-job script file (see buildJobScript): a split launches it
 * as the new pane's command; takeover/reuse paste the one-line launch. After
 * either, we wait for the capture file the script creates on startup. If it
 * never appears, the pane didn't run the launch line (it wasn't an idle shell —
 * an editor or another agent owns it), so the plan is aborted, a
 * split-we-created is closed, and a PaneUnavailableError is raised. Nothing runs
 * invisibly: a busy pane means the operator retargets, not a background run.
 *
 * That failure comes in two flavors and the error tells them apart, because the
 * registry must react differently. A takeover/reuse that never starts names a
 * pane we were HANDED, which is still there and still tracked. A split that never
 * starts names a pane we CREATED and have just closed again: `orphaned` is set,
 * because that id was never committed to the layout and nothing tracked is dead.
 * Only the first kind may cost the layout anything.
 *
 * Any AppleScript failure targeting the pane (a closed/stale anchor surfaces as
 * Ghostty error -1719, plus permission or not-running failures) is likewise
 * re-raised as a PaneUnavailableError, which the registry turns into a clean
 * dispatch failure with an actionable message (there is no background path). The
 * capture file is created only by the launched script itself — that is what
 * makes it a trustworthy launch probe.
 */
export async function launchGhostty(args: {
  paths: InstancePaths;
  config: DispatchConfig;
  layout: CrewPaneLayout;
  jobId: string;
  order: string;
  /** The confirm-time agent override; omit to use the config default. */
  agentName?: string;
  /** Working-directory override for the crew process: a feature-scoped dispatch
   *  passes the feature's worktree path so the agent operates in that isolated
   *  checkout. Omitted, the linked repo is the cwd, exactly as before. */
  cwd?: string;
  /** The lane this run holds (lanes.ts). A reader launches with write-capable
   *  tools denied where the agent's CLI takes such flags. Defaults to writer,
   *  which is the unchanged full-access launch. */
  lane?: DispatchLane;
  /** Capture file override (the registry namespaces these per session); defaults
   *  to the instance's captureFile(jobId) for direct callers and tests. */
  captureFile?: string;
  /** The FRESH occupancy reading placement is decided against: which panes are
   *  provably idle right now, and whether the anchor has ever hosted a co job.
   *  Omitted, nothing is reusable and this dispatch creates a pane — the safe
   *  default for a caller that cannot measure. */
  placement?: PlacementInput;
  /** Probe budget override for tests. */
  paneStartTimeoutMs?: number;
}): Promise<LaunchResult> {
  const { paths, config, layout, jobId, order, agentName } = args;
  await ensureCaptureDir(paths);
  const captureFile = args.captureFile ?? paths.captureFile(jobId);

  const decision = layout.plan(args.placement ?? {});

  const crewCommand = jobCommandLine(config, order, agentName, args.cwd, args.lane ?? "writer");
  // The job script owns everything fragile: cd, the (possibly multi-line) order,
  // capture, exit sidecar, sentinel. The pane only ever sees the launch line.
  const scriptPath = jobScriptFile(captureFile);
  await fsp.writeFile(
    scriptPath,
    buildJobScript({
      crewCommand,
      captureFile,
      scriptPath,
      cwd: args.cwd ?? config.repoPath,
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
    // Surface it as PaneUnavailableError so the registry fails the dispatch
    // cleanly (there is no background path).
    throw new PaneUnavailableError(targetId, (e as Error).message);
  }
  // takeover/reuse return the known pane id; split returns the fresh one.
  const paneId = decision.kind === "split" ? returnedId : decision.paneId;

  // The launch probe: the script creates the capture file immediately. No file,
  // no launch — the pane was busy (or the surface command failed), so undo the
  // placement and fail the dispatch (PaneUnavailableError). Nothing runs
  // headless: a busy pane means the operator retargets, not an invisible run.
  const started = await waitForFileCreation(
    captureFile,
    args.paneStartTimeoutMs ?? PANE_START_TIMEOUT_MS,
  );
  if (!started) {
    layout.abort();
    // A split we created: the pane exists but nothing is running in it. Reap it,
    // so a failed launch never leaks a pane, and mark the error ORPHANED — the id
    // it carries is now a closed pane that was never committed to the layout, so
    // the registry must not read it as a dead TRACKED pane and must not touch the
    // layout over it. A takeover/reuse failure is not orphaned: that pane is one
    // we were handed, it is still there, and the old behavior stands.
    const orphaned = decision.kind === "split" && Boolean(returnedId);
    if (orphaned) {
      try {
        await osaRunner(composeCloseScript(returnedId));
      } catch {
        /* best-effort */
      }
    }
    await fsp.rm(scriptPath, { force: true }).catch(() => {});
    throw new PaneUnavailableError(
      paneId || targetId,
      orphaned
        ? "the job never started in the pane the split created; the stray pane was closed again"
        : "the job never started there (pane busy with another program?)",
      orphaned,
    );
  }
  layout.commit(paneId);
  // The script writes its identity sidecar BEFORE the capture file, so by the
  // time the probe above succeeded the reading is already on disk. An absent or
  // unreadable one is not a launch failure — it only means this pane can't be
  // proven idle later, which costs a split.
  const identity = await readPaneIdentity(captureFile);
  return { transport: "ghostty", paneId, placement: decision, identity };
}
