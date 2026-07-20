/** Tiny ANSI helpers. No dependency; respects NO_COLOR and non-TTY output. */

// TERM=dumb terminals have no SGR support, and NO_COLOR is the standard opt-out;
// a pipe gets no styling either, so redirected output stays clean plain text.
const enabled =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";

/**
 * Whether ANSI styling is active. Exposed so the TUI can suppress purely
 * decorative cues (e.g. the light-grey ghost completion) when they'd be
 * indistinguishable from real input under NO_COLOR / non-TTY output.
 */
export const colorEnabled = Boolean(enabled);

function wrap(code: string, s: string): string {
  return enabled ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export const c = {
  bold: (s: string) => wrap("1", s),
  dim: (s: string) => wrap("2", s),
  italic: (s: string) => wrap("3", s),
  underline: (s: string) => wrap("4", s),
  strike: (s: string) => wrap("9", s),
  grey: (s: string) => wrap("90", s), // bright black — for light-grey ghost hints
  cyan: (s: string) => wrap("36", s),
  green: (s: string) => wrap("32", s),
  yellow: (s: string) => wrap("33", s),
  red: (s: string) => wrap("31", s),
  magenta: (s: string) => wrap("35", s),
  blue: (s: string) => wrap("34", s),
};

export function write(s: string): void {
  process.stdout.write(s);
}
export function line(s = ""): void {
  process.stdout.write(s + "\n");
}

// The full-screen alternate-buffer takeover now lives in tui.ts, which owns the
// screen for interactive sessions. Non-interactive commands (list, doctor,
// create, delete) use the simple write/line helpers above on the normal buffer.
