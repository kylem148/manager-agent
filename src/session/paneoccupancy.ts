import { spawn } from "node:child_process";

/**
 * Is a crew pane genuinely unoccupied RIGHT NOW?
 *
 * Dispatch reuses an idle pane rather than splitting a new one every time, and
 * reuse PASTES a launch line into an existing pane (`input text`, see
 * transport.ts). So the question this module answers is a safety question, not
 * an optimisation: a pane that is answered wrongly gets a `/bin/sh '<script>'`
 * typed into whatever the captain is doing in it.
 *
 * THE ERROR ASYMMETRY DRIVES EVERY RULE HERE. A false "occupied" costs one extra
 * split, and splits are uncapped — it is the cheapest possible mistake. A false
 * "free" types into a live editor or launches a second agent into a session the
 * captain is still talking to. So every uncertainty resolves to OCCUPIED: an
 * unreadable process table, a pane we have no identity record for, a `ps` that
 * fails, a recorded shell that has since died — all of them mean "not reusable",
 * and the dispatch splits instead.
 *
 * OCCUPANCY IS THE UNION OF TWO SIGNALS, either of which marks a pane taken:
 *
 *   1. co holds an active dispatch LEASE on the pane (a job of ours is running
 *      there, or another co session claims it). The lease is what covers the
 *      launch window, where the pane's process table shows only the wrapper `sh`
 *      for the few hundred ms before the agent execs — a window in which the
 *      process signal alone would read "idle".
 *   2. Anything is actually RUNNING in the pane. co's notion of "the job is
 *      finished" and the captain's diverge constantly: the Stop hook files a
 *      completion report the moment the crew first answers, and the captain then
 *      keeps talking to that same agent for another hour. Only the pane itself
 *      knows.
 *
 * THE MECHANISM for signal 2 is the pane's own tty. Ghostty's AppleScript
 * dictionary (verified against Ghostty.sdef 1.3.x) exposes a terminal's `id`,
 * `name` and `working directory` and nothing else — no pid, no tty, no "is it at
 * a prompt". So co learns the tty the only way available: the per-job launch
 * script reports it (`tty`, plus the pid of the process that outlives the job),
 * and that identity is remembered per pane (panestore.ts). At dispatch time we
 * read the pane's process table fresh — `ps -t <tty>` — and call the pane free
 * only when every process attached to it is a shell (or the `login` that Ghostty
 * bootstraps a pane with). A live `claude`, an editor, a `sleep`, a build: all
 * non-shell, all occupied.
 *
 * The recorded shell pid is what BINDS the tty to the pane. tty device names are
 * recycled by the OS, so "ttys004 looks idle" is not evidence about the pane we
 * think it belongs to unless the process we recorded is still alive on it. That
 * check is what keeps reuse to panes co actually owns instead of adopting a
 * stranger's idle pane.
 *
 * KNOWN FALSE NEGATIVES (a pane called free that is not idle), all of which the
 * transport's own 4-second launch probe still catches before anything is typed:
 *  - a foreground shell BUILTIN loop (`while :; do :; done`), which spawns no
 *    process for `ps` to see;
 *  - a half-typed command line sitting at the prompt, which the pasted launch
 *    line would append itself to;
 *  - a wrapper that is itself a shell and whose real work is a builtin
 *    (`bash -c 'while :; do :; done'`).
 * KNOWN FALSE POSITIVES (a pane called occupied that is idle), all harmless — a
 * split is created instead:
 *  - a leaked background process still attached to the tty (a stray
 *    `caffeinate`, a disowned job);
 *  - a nested interactive shell the captain started by hand and left;
 *  - any pane co has no identity record for, including a freshly designated
 *    anchor (see crewpanes.ts for the one bootstrap takeover that remains);
 *  - a `ps` or AppleScript probe that fails for any reason.
 */

/** One process attached to a pane's tty, as `ps` reports it. */
export interface TtyProcess {
  pid: number;
  ppid: number;
  /** ps `stat` flags. Kept for diagnostics; `+` marks the foreground group,
   *  which is deliberately NOT part of the verdict — a non-interactive wrapper
   *  (our own job script, and Claude Code launched under one) puts its children
   *  in its own process group, so tpgid says "the shell is in front" while an
   *  agent is plainly running. Process identity is the reliable signal. */
  stat: string;
  /** ps `ucomm`: the accounting name of the executable, a basename. */
  name: string;
}

/**
 * Process names that mean "this pane is sitting at a prompt". Shells, plus the
 * `login` macOS runs a Ghostty surface through (every pane has one; treating it
 * as work would make every pane permanently occupied).
 *
 * Deliberately a small allowlist rather than a denylist of known agents: an
 * unknown process name must read as occupied, because the whole point is that co
 * cannot enumerate what the captain runs.
 */
export const IDLE_PANE_PROCESSES: ReadonlySet<string> = new Set([
  "login",
  "sh",
  "bash",
  "dash",
  "zsh",
  "ksh",
  "ksh93",
  "mksh",
  "fish",
  "csh",
  "tcsh",
]);

export function isIdleProcessName(name: string): boolean {
  // ps reports a login shell's accounting name without the argv[0] dash, but be
  // tolerant of both, and of an absolute path if a probe ever supplies one.
  const base = name.replace(/^-/, "").split("/").pop() ?? "";
  return IDLE_PANE_PROCESSES.has(base);
}

/** What co knows about a pane's identity — learned from the launch script of the
 *  last job that ran there and remembered in panestore.ts. Both fields are
 *  required for a verdict: without them a pane is unproven, never free. */
export interface PaneIdentity {
  /** The pane's tty device, without `/dev/` (e.g. `ttys004`). */
  tty?: string;
  /** The pid of the process that OUTLIVES a job in that pane: the held login
   *  shell a split-born pane execs, or the shell that ran the launch line on a
   *  takeover. Alive-on-that-tty is what binds the tty to this pane. */
  shellPid?: number;
}

export type PaneVerdict =
  /** Reusable: exists, unleased, and nothing but shells on its tty. */
  | { free: true }
  /** Not reusable, with the reason a human would want in a log. */
  | { free: false; reason: "gone" | "leased" | "unproven" | "busy"; detail: string };

/**
 * The occupancy predicate: pure, so the whole decision is unit-testable with the
 * process table and the Ghostty probe stubbed. Every input is a FRESH reading
 * taken at dispatch time by the caller (registry.ts) — nothing here is cached,
 * and a persisted record contributes identity only, never state.
 */
export function judgePane(args: {
  /** Ghostty still resolves this terminal id. */
  exists: boolean;
  /** Who holds a dispatch lease on the pane, if anyone (a description for the
   *  log: "job-003" / "another co session"). Undefined means unleased. */
  leasedBy?: string;
  /** What co remembers about the pane's tty. */
  identity?: PaneIdentity;
  /** The pane tty's process table, or null when it could not be read. Callers
   *  may skip the read entirely (passing null) for a pane already ruled out. */
  procs: TtyProcess[] | null;
}): PaneVerdict {
  if (!args.exists) {
    return { free: false, reason: "gone", detail: "the pane no longer exists" };
  }
  if (args.leasedBy) {
    return { free: false, reason: "leased", detail: `held by ${args.leasedBy}` };
  }
  const tty = args.identity?.tty;
  const shellPid = args.identity?.shellPid;
  if (!tty || !shellPid) {
    return {
      free: false,
      reason: "unproven",
      detail: "co has never run a job in this pane, so its state can't be read",
    };
  }
  if (!args.procs || args.procs.length === 0) {
    return { free: false, reason: "unproven", detail: `nothing readable on ${tty}` };
  }
  // The pane's own shell must still be there. Without it the tty is not this
  // pane's tty any more (device names are recycled), so nothing on it is
  // evidence about this pane.
  const shell = args.procs.find((p) => p.pid === shellPid);
  if (!shell || !isIdleProcessName(shell.name)) {
    return {
      free: false,
      reason: "unproven",
      detail: `the pane's own shell (pid ${shellPid}) is no longer on ${tty}`,
    };
  }
  const busy = args.procs.find((p) => !isIdleProcessName(p.name));
  if (busy) {
    return { free: false, reason: "busy", detail: `${busy.name} (pid ${busy.pid}) is running` };
  }
  return { free: true };
}

// --- the live probe ----------------------------------------------------------

/** Strip `/dev/` and whitespace off whatever the launch script reported, and
 *  reject anything that isn't a plausible device name — the value ends up as an
 *  argv entry to `ps`, and a record can be hand-edited. */
export function normalizeTty(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const name = raw.trim().replace(/^\/dev\//, "");
  return /^[A-Za-z][A-Za-z0-9._-]*$/.test(name) ? name : undefined;
}

/**
 * Parse `ps -t <tty> -o pid=,ppid=,stat=,ucomm=`. ucomm is LAST and takes the
 * whole remainder of the line, because a process name can contain a space and
 * the numeric columns cannot.
 */
export function parsePsLines(out: string): TtyProcess[] {
  const rows: TtyProcess[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), stat: m[3]!, name: m[4]! });
  }
  return rows;
}

/** Reads a tty's process table. Returns null when it can't be read at all — a
 *  dead device, a `ps` that failed — which the predicate treats as unproven. */
export type TtyProbe = (tty: string) => Promise<TtyProcess[] | null>;

const PS_TIMEOUT_MS = 2500;

/**
 * The real probe: one `ps` per pane under consideration. Cheap (single-digit ms)
 * and side-effect free, and it needs no permission grant of any kind — unlike
 * the AppleScript path, it is just this user's own process table.
 *
 * Never throws: every failure mode (no such tty, ps missing, a hung ps) comes
 * back as null, which reads as "not provably idle" and costs a split.
 */
export const psTtyProbe: TtyProbe = (tty) =>
  new Promise((resolve) => {
    const name = normalizeTty(tty);
    if (!name) return resolve(null);
    let out = "";
    let settled = false;
    const done = (v: TtyProcess[] | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("ps", ["-t", name, "-o", "pid=,ppid=,stat=,ucomm="], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return done(null);
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* best-effort */
      }
      done(null);
    }, PS_TIMEOUT_MS);
    child.stdout?.on("data", (d) => (out += String(d)));
    child.on("error", () => {
      clearTimeout(timer);
      done(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // `ps -t` exits nonzero for a device that no longer exists ("No such file
      // or directory"), which is exactly the recycled-tty case: unproven.
      if (code !== 0) return done(null);
      const rows = parsePsLines(out);
      done(rows.length > 0 ? rows : null);
    });
  });

/** Whether a process id is still alive, for judging a persisted lease. Signal 0
 *  only probes: EPERM means the pid exists under another user (alive), ESRCH
 *  means it is gone. A recycled pid reads as alive, which costs a split. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
