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
  // Two yellows a column apart have to be told apart at a glance, and the base
  // palette cannot do it: a theme is free to put yellow and bright yellow at the
  // same luminance, and Ghostty's default does (#f0c674 and #e7c547). So these
  // two name their own colours out of the 256-colour cube — supported anywhere
  // xterm-256color is, which is everywhere — and the step between them is a real
  // one on every theme rather than one the theme is allowed to flatten.
  // Both are true yellow (R and G equal, a little blue to take the acid off).
  // Not 214, which is orange, and not 226, which is the harsh pure yellow.
  lamp: (s: string) => wrap("38;5;185", s), // #d7d75f — a lit window
  lampBright: (s: string) => wrap("38;5;227", s), // #ffff5f — the same yellow, brighter
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
