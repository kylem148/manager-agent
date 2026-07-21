/**
 * Keyboard decoding for the raw-mode line editor.
 *
 * Two encodings reach us, and this module funnels both into one `Action` the
 * editor can act on:
 *
 *  1. Legacy control bytes — what every terminal has always sent. Enter is CR
 *     (0x0D), Ctrl-A is 0x01, and so on. Lossy by construction: Ctrl-M and
 *     Enter are the same byte, so Shift+Enter is simply *unrepresentable*.
 *  2. The Kitty keyboard protocol's CSI-u form (`CSI <code> ; <mods> u`), and
 *     xterm's modifyOtherKeys form (`CSI 27 ; <mods> ; <code> ~`). Both carry
 *     the modifier bits separately, so Shift+Enter arrives as CSI 13;2u and is
 *     finally distinguishable from a bare Enter.
 *
 * We ask for (1)+(2) by pushing Kitty progressive-enhancement flag 1
 * ("disambiguate escape codes") in tui.ts. Terminals that don't implement it
 * ignore the request and keep sending legacy bytes — which is exactly why the
 * newline binding has a legacy-representable fallback (Ctrl-J / LF, plus
 * Alt+Enter where the terminal emits ESC CR). See classify() below.
 *
 * Everything here is pure so the decode table can be unit-tested without a
 * terminal.
 */

export interface Mods {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

export const NO_MODS: Mods = { shift: false, alt: false, ctrl: false };

/** A decoded key press: a unicode codepoint (or functional key code) + modifiers. */
export interface KeyEvent {
  code: number;
  mods: Mods;
}

/**
 * Decode a CSI-u / modifyOtherKeys modifier parameter. Both protocols encode it
 * as a bitmask + 1 (shift=1, alt=2, ctrl=4, then super/hyper/meta/lock bits we
 * don't care about). An absent or malformed parameter means "no modifiers".
 */
export function modsFromParam(param: string | undefined): Mods {
  const n = Number.parseInt(param ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return NO_MODS;
  const bits = n - 1;
  return {
    shift: (bits & 1) !== 0,
    alt: (bits & 2) !== 0,
    ctrl: (bits & 4) !== 0,
  };
}

/**
 * Parse the parameter block of a CSI-u sequence — the text between `ESC [` and
 * the final `u`. Shapes we accept:
 *
 *   "13"            bare Enter
 *   "13;2"          Shift+Enter
 *   "13;2:1"        Shift+Enter, explicit press event (`:3` is a key RELEASE)
 *   "13;2;10"       with associated text; the text params are ignored
 *
 * Returns null for a release event or anything we can't read as a key, so the
 * caller swallows the sequence instead of acting on it twice.
 */
export function parseCsiU(params: string): KeyEvent | null {
  if (params === "" || params.startsWith("?") || params.startsWith(">")) return null;
  const fields = params.split(";");
  const code = Number.parseInt(fields[0]!.split(":")[0] ?? "", 10);
  if (!Number.isFinite(code)) return null;

  const modField = fields[1];
  if (modField !== undefined) {
    // The sub-parameter after ':' is the event type: 1 press, 2 repeat, 3 release.
    // We only requested press events, but be defensive: never act on a release.
    const eventType = modField.split(":")[1];
    if (eventType === "3") return null;
  }
  return { code, mods: modsFromParam(modField?.split(":")[0]) };
}

/**
 * Parse xterm's modifyOtherKeys form: `CSI 27 ; <mods> ; <code> ~`. Given the
 * parameter block (without the trailing `~`), returns the key event, or null if
 * this isn't that shape (e.g. it's a plain PgUp `5~`).
 */
export function parseModifyOtherKeys(params: string): KeyEvent | null {
  const fields = params.split(";");
  if (fields.length !== 3 || fields[0] !== "27") return null;
  const code = Number.parseInt(fields[2]!, 10);
  if (!Number.isFinite(code)) return null;
  return { code, mods: modsFromParam(fields[1]) };
}

/** What the editor should do about a key. */
export type Action =
  | { kind: "insert"; text: string }
  /** Insert a literal newline into the buffer — compose, don't send. */
  | { kind: "newline" }
  /** Send the buffer. */
  | { kind: "submit" }
  | { kind: "escape" }
  | { kind: "backspace" }
  | { kind: "tab" }
  | { kind: "interrupt" } // Ctrl-C
  | { kind: "eof" } // Ctrl-D
  | { kind: "home" } // Ctrl-A
  | { kind: "end" } // Ctrl-E
  | { kind: "kill-to-start" } // Ctrl-U
  | { kind: "kill-to-end" } // Ctrl-K
  | { kind: "none" };

const NONE: Action = { kind: "none" };

// Codepoints of the ctrl-letter bindings the editor honours.
const CTRL_LETTERS: Record<number, Action> = {
  97: { kind: "home" }, // a
  101: { kind: "end" }, // e
  117: { kind: "kill-to-start" }, // u
  107: { kind: "kill-to-end" }, // k
  99: { kind: "interrupt" }, // c
  100: { kind: "eof" }, // d
  105: { kind: "tab" }, // i — Ctrl-I *is* Tab
  106: { kind: "newline" }, // j — the universal newline fallback; see below
  109: { kind: "submit" }, // m — Ctrl-M *is* Enter
};

/**
 * Map a decoded key event to an editor action.
 *
 * The newline bindings, in order of preference:
 *  - Shift+Enter  — the one users reach for. Needs an enhanced protocol to be
 *    visible at all; under legacy encoding it is byte-identical to Enter.
 *  - Alt+Enter    — also needs the protocol, *or* a terminal configured to send
 *    ESC as a meta prefix (tui.ts decodes `ESC CR` as Alt+Enter).
 *  - Ctrl+Enter   — free to support, works where the protocol is on.
 *  - Ctrl+J       — the fallback that works EVERYWHERE. It is a real, distinct
 *    legacy byte (LF, 0x0A) that no terminal conflates with Enter in raw mode
 *    (raw mode disables ICRNL, so Enter is always CR), and under the Kitty
 *    protocol it arrives as CSI 106;5u, handled by the same table.
 *
 * A bare Enter always submits. That is load-bearing: it is the only binding
 * that existed before, and regressing it would strand every user.
 */
export function classify(ev: KeyEvent): Action {
  const { code, mods } = ev;
  const bare = !mods.shift && !mods.alt && !mods.ctrl;

  switch (code) {
    case 13: // Enter / CR
      return bare ? { kind: "submit" } : { kind: "newline" };
    case 27: // Escape
      return { kind: "escape" };
    case 9: // Tab
      return bare ? { kind: "tab" } : NONE;
    case 8:
    case 127: // Backspace
      return { kind: "backspace" };
  }

  if (mods.ctrl && !mods.alt) {
    return CTRL_LETTERS[code] ?? NONE;
  }

  // Printable, no ctrl/alt. The Kitty protocol doesn't send these as CSI-u at
  // flag level 1 (printable keys keep their legacy text encoding), but a
  // terminal at a higher level might, so decode them rather than dropping them.
  if (!mods.ctrl && !mods.alt && code >= 32 && code !== 127) {
    return { kind: "insert", text: String.fromCodePoint(code) };
  }
  return NONE;
}

/**
 * Interpret one legacy byte (or one printable JS char, which may be a multi-byte
 * UTF-8 codepoint) from the raw stream.
 *
 * The control bytes are turned back into the key events they stand for, so both
 * encodings share one decision table. Note LF (0x0A) maps to Ctrl+J rather than
 * to Enter: in raw mode Enter is always CR, so a lone LF really is Ctrl+J, and
 * that is what makes the fallback newline binding work on terminals with no
 * enhanced keyboard support.
 */
export function classifyByte(ch: string): Action {
  const code = ch.codePointAt(0) ?? 0;

  // Printable (including multi-byte characters, which arrive as whole JS chars).
  if (code >= 32 && code !== 127) return { kind: "insert", text: ch };

  switch (code) {
    case 13:
      return classify({ code: 13, mods: NO_MODS });
    case 10: // LF == Ctrl+J
      return classify({ code: 106, mods: { ...NO_MODS, ctrl: true } });
    case 9:
      return classify({ code: 9, mods: NO_MODS });
    case 27:
      return classify({ code: 27, mods: NO_MODS });
    case 8:
    case 127:
      return classify({ code: 127, mods: NO_MODS });
  }
  // Ctrl-<letter>: 0x01..0x1A map onto 'a'..'z'.
  if (code >= 1 && code <= 26) {
    return classify({ code: 96 + code, mods: { ...NO_MODS, ctrl: true } });
  }
  return NONE;
}
