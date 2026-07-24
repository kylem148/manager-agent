import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  classifyByte,
  modsFromParam,
  parseCsiU,
  parseModifyOtherKeys,
  NO_MODS,
} from "./keys.js";

/**
 * The keyboard decode table. These are the cases the multi-line input box rests
 * on: a bare Enter must submit forever, and every spelling of "newline" the
 * various terminal protocols use must land on the same action.
 */

test("modifier parameter decodes as bitmask + 1", () => {
  assert.deepEqual(modsFromParam("1"), NO_MODS);
  assert.deepEqual(modsFromParam("2"), { shift: true, alt: false, ctrl: false });
  assert.deepEqual(modsFromParam("3"), { shift: false, alt: true, ctrl: false });
  assert.deepEqual(modsFromParam("5"), { shift: false, alt: false, ctrl: true });
  assert.deepEqual(modsFromParam("6"), { shift: true, alt: false, ctrl: true });
  // Absent/garbage means unmodified, never a crash.
  assert.deepEqual(modsFromParam(undefined), NO_MODS);
  assert.deepEqual(modsFromParam("x"), NO_MODS);
});

test("CSI-u parses code, modifiers, and ignores extra params", () => {
  assert.deepEqual(parseCsiU("13"), { code: 13, mods: NO_MODS });
  assert.deepEqual(parseCsiU("13;2"), {
    code: 13,
    mods: { shift: true, alt: false, ctrl: false },
  });
  // Associated-text parameters after the modifiers are not our business.
  assert.deepEqual(parseCsiU("97;5;97"), {
    code: 97,
    mods: { shift: false, alt: false, ctrl: true },
  });
});

test("CSI-u ignores key releases and flag-query replies", () => {
  assert.equal(parseCsiU("13;2:3"), null); // :3 == release
  assert.deepEqual(parseCsiU("13;2:1"), {
    code: 13,
    mods: { shift: true, alt: false, ctrl: false },
  });
  // The response to a progressive-enhancement query must not read as a key.
  assert.equal(parseCsiU("?1"), null);
  assert.equal(parseCsiU(""), null);
});

test("modifyOtherKeys form is recognised, plain CSI ~ keys are not", () => {
  assert.deepEqual(parseModifyOtherKeys("27;2;13"), {
    code: 13,
    mods: { shift: true, alt: false, ctrl: false },
  });
  assert.equal(parseModifyOtherKeys("5"), null); // PgUp
  assert.equal(parseModifyOtherKeys("3"), null); // Delete
  assert.equal(parseModifyOtherKeys("27;2"), null);
});

test("bare Enter submits; every modified Enter composes a newline", () => {
  assert.deepEqual(classify({ code: 13, mods: NO_MODS }), { kind: "submit" });
  for (const mods of [
    { shift: true, alt: false, ctrl: false },
    { shift: false, alt: true, ctrl: false },
    { shift: false, alt: false, ctrl: true },
  ]) {
    assert.deepEqual(classify({ code: 13, mods }), { kind: "newline" }, JSON.stringify(mods));
  }
});

test("Ctrl-J is the newline fallback in both encodings", () => {
  // Legacy: a lone LF byte. In raw mode Enter is always CR, so this is Ctrl-J.
  assert.deepEqual(classifyByte("\n"), { kind: "newline" });
  // Kitty protocol turns the same key into CSI 106;5u.
  assert.deepEqual(classify(parseCsiU("106;5")!), { kind: "newline" });
});

test("legacy control bytes keep their existing bindings", () => {
  assert.deepEqual(classifyByte("\r"), { kind: "submit" });
  assert.deepEqual(classifyByte("\x03"), { kind: "interrupt" });
  assert.deepEqual(classifyByte("\x04"), { kind: "eof" });
  assert.deepEqual(classifyByte("\x01"), { kind: "home" });
  assert.deepEqual(classifyByte("\x05"), { kind: "end" });
  assert.deepEqual(classifyByte("\x15"), { kind: "kill-to-start" });
  assert.deepEqual(classifyByte("\x0b"), { kind: "kill-to-end" });
  assert.deepEqual(classifyByte("\t"), { kind: "tab" });
  assert.deepEqual(classifyByte("\x1b"), { kind: "escape" });
  assert.deepEqual(classifyByte("\x7f"), { kind: "backspace" });
  assert.deepEqual(classifyByte("\b"), { kind: "backspace" });
});

test("the same bindings survive the protocol's CSI-u spelling", () => {
  // With the Kitty protocol on, these arrive as CSI u rather than as bytes.
  assert.deepEqual(classify(parseCsiU("27")!), { kind: "escape" });
  assert.deepEqual(classify(parseCsiU("99;5")!), { kind: "interrupt" });
  assert.deepEqual(classify(parseCsiU("109;5")!), { kind: "submit" }); // Ctrl-M is Enter
  assert.deepEqual(classify(parseCsiU("105;5")!), { kind: "tab" }); // Ctrl-I is Tab
  assert.deepEqual(classify(parseCsiU("127")!), { kind: "backspace" });
});

test("Ctrl-O opens the doc viewer in both encodings, and doesn't collide", () => {
  // Legacy control byte 0x0F is Ctrl-O.
  assert.deepEqual(classifyByte("\x0f"), { kind: "open-docs" });
  // Under the Kitty protocol the same key arrives as CSI 111;5u.
  assert.deepEqual(classify(parseCsiU("111;5")!), { kind: "open-docs" });
  // A bare "o" is still ordinary text, not the overlay chord.
  assert.deepEqual(classifyByte("o"), { kind: "insert", text: "o" });
  // The existing ctrl-letter editing bindings are untouched by the new one.
  assert.deepEqual(classifyByte("\x01"), { kind: "home" }); // Ctrl-A
  assert.deepEqual(classifyByte("\x05"), { kind: "end" }); // Ctrl-E
  assert.deepEqual(classifyByte("\x15"), { kind: "kill-to-start" }); // Ctrl-U
  assert.deepEqual(classifyByte("\x0b"), { kind: "kill-to-end" }); // Ctrl-K
});

test("`i` stays a literal character at the editor layer; the tab-cycle bind is panel-only", () => {
  // The panel's `i` (cycle tabs) is decided in tui.ts's overlay dispatch, which is
  // reached only while the panel owns the keyboard. The editor's decode table must
  // never learn about it, or every typed `i` would be eaten.
  assert.deepEqual(classifyByte("i"), { kind: "insert", text: "i" });
  assert.deepEqual(classify({ code: 105, mods: NO_MODS }), { kind: "insert", text: "i" });
  assert.deepEqual(classify(parseCsiU("105")!), { kind: "insert", text: "i" });
  // Ctrl-I is still Tab, and Ctrl-O still the panel key — neither moved.
  assert.deepEqual(classify(parseCsiU("105;5")!), { kind: "tab" });
  assert.deepEqual(classifyByte("\x0f"), { kind: "open-docs" });
});

test("printable input is inserted, unknown combos are swallowed", () => {
  assert.deepEqual(classifyByte("a"), { kind: "insert", text: "a" });
  assert.deepEqual(classifyByte(" "), { kind: "insert", text: " " });
  assert.deepEqual(classifyByte("é"), { kind: "insert", text: "é" });
  assert.deepEqual(classifyByte("😀"), { kind: "insert", text: "😀" });
  assert.deepEqual(classify({ code: 97, mods: NO_MODS }), { kind: "insert", text: "a" });
  // An unbound ctrl combo must not type a stray letter into the buffer.
  assert.deepEqual(classify(parseCsiU("122;5")!), { kind: "none" }); // Ctrl-Z
  assert.deepEqual(classifyByte("\x00"), { kind: "none" });
});
