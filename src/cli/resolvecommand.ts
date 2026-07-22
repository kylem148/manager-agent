import { spawn } from "node:child_process";

/**
 * Resolve a word the operator types at `co link` (e.g. `cc`) into the real
 * command it stands for.
 *
 * WHY THIS EXISTS: the words people run their coding agent with are almost always
 * shell ALIASES (`cc`, `ccw`), not binaries. An alias lives only in the
 * interactive shell that read the rc file — it does not exist in the
 * non-interactive shell a dispatch spawns, so storing the bare word `cc` and
 * running it later fails ("command not found", or worse: `cc` is the system C
 * compiler, so `cc <order>` silently compiles garbage and exits 0). The zsh
 * manual is explicit that aliases are not for non-interactive use. So instead of
 * storing the word, we ask the operator's own login shell what the word expands
 * to and store THAT — the resolved, PATH-runnable command line.
 *
 * The resolution asks the login shell interactively (`-ic`), because that is the
 * only context where the rc-file aliases/functions are defined. The word is
 * passed as an argv element ($1), never interpolated into the script, so a
 * hostile word cannot inject shell.
 */

export type ResolutionKind = "alias" | "binary" | "shell-word" | "unresolved";

export interface CommandResolution {
  /** The command prefix to store (NO {prompt} placeholder — the caller appends
   *  that). For an alias, the expanded body; for a binary, the word (it is on
   *  PATH); for anything unresolved, the word verbatim so the operator can fix it. */
  command: string;
  kind: ResolutionKind;
  /** Whether `command` is expected to run in the non-interactive shell a dispatch
   *  spawns. True for aliases (now expanded) and binaries; false for a bare
   *  shell-word (a function/builtin/keyword that exists only interactively) and
   *  for an unresolved word. When false, `co link` warns but still stores it. */
  runnable: boolean;
}

/**
 * Undo one layer of shell single-quoting as emitted by `command -v`/`alias`. Both
 * bash and zsh print an alias body in reusable form: either bare (zsh, when the
 * body has no special characters) or single-quoted, with any embedded single
 * quote written as the four-character sequence `'\''`. This walks that grammar
 * back to the literal body. A body with no leading quote is returned as-is.
 */
export function unquoteAliasBody(raw: string): string {
  const s = raw.trim();
  if (!s.startsWith("'")) return s; // bare (zsh simple alias): nothing to undo
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "'") {
      // A single-quoted segment: copy verbatim until the closing quote.
      i++;
      while (i < s.length && s[i] !== "'") {
        out += s[i];
        i++;
      }
      i++; // skip the closing quote
    } else if (s[i] === "\\" && s[i + 1] === "'") {
      out += "'"; // an escaped quote between segments ('\'' → ')
      i += 2;
    } else {
      out += s[i];
      i++;
    }
  }
  return out;
}

/**
 * Classify the output of `command -v -- <word>` (with its exit code) into a
 * resolution. Pure and shell-agnostic so it is exercised directly against the
 * real output shapes of bash and zsh:
 *   alias:   `alias cc=claude`  (zsh bare)  |  `alias cc='claude'`  (bash/zsh quoted)
 *   binary:  `/usr/bin/git`     (an absolute path)
 *   fn/bltn: `myfunc`           (a bare word equal to the input)
 *   missing: ``                 (empty, exit 1)
 */
export function parseCommandV(word: string, output: string, exitCode: number): CommandResolution {
  const trimmed = output.trim();
  if (exitCode !== 0 || trimmed === "") {
    return { command: word, kind: "unresolved", runnable: false };
  }
  // `alias NAME=BODY` — the common and important case. Expand to the body.
  const alias = /^alias\s+[^=]+=(.*)$/s.exec(trimmed);
  if (alias) {
    const body = unquoteAliasBody(alias[1]!);
    if (body) return { command: body, kind: "alias", runnable: true };
    return { command: word, kind: "unresolved", runnable: false };
  }
  // An absolute or relative path → a real binary. The word is on PATH, and a
  // dispatch inherits PATH, so storing the word (not the path) keeps the config
  // readable while still running.
  if (trimmed.startsWith("/") || trimmed.startsWith("./")) {
    return { command: word, kind: "binary", runnable: true };
  }
  // A bare word that is not a path and not an alias line: a shell function,
  // builtin, or reserved word. These live only in the interactive shell (or are
  // not standalone commands), so they are not reliably runnable when dispatched.
  return { command: word, kind: "shell-word", runnable: false };
}

/** Spawn `argv[0]` with the rest as arguments, capturing stdout and the exit
 *  code. stderr is discarded (an interactive shell may print job-control notes).
 *  A timeout guards against a broken rc file hanging the resolve. */
function runCapture(cmd: string, argv: string[], timeoutMs: number): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    let settled = false;
    const done = (stdout: string, code: number): void => {
      if (settled) return;
      settled = true;
      resolve({ stdout, code });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(out, 1);
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += String(d)));
    child.on("error", () => {
      clearTimeout(timer);
      done("", 1);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(out, code ?? 1);
    });
  });
}

/**
 * Resolve a typed word to a runnable command via the operator's login shell.
 * Runs `<shell> -ic 'command -v -- "$1"' _ <word>`: interactive so rc-file
 * aliases exist, and the word passed as $1 so it cannot inject shell. Falls back
 * to /bin/sh if $SHELL is unset. On any failure the word is returned unresolved,
 * so `co link` can warn and still store it.
 */
export async function resolveCommandWord(
  word: string,
  opts: { shell?: string; timeoutMs?: number } = {},
): Promise<CommandResolution> {
  const shell = opts.shell ?? process.env.SHELL ?? "/bin/sh";
  const timeoutMs = opts.timeoutMs ?? 4000;
  const { stdout, code } = await runCapture(shell, ["-ic", 'command -v -- "$1"', "_", word], timeoutMs);
  return parseCommandV(word, stdout, code);
}
