import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TextEditor,
  joinMessage,
  layoutBuffer,
  scrollToCursor,
  splitMessage,
} from "./editor.js";

/**
 * The buffer/edit model both editors run on: the prompt input bar and the panel's
 * PR message popup. Everything here is pure, so the rules are pinned without a
 * terminal — which matters most for the two things a human cannot check by
 * looking at one frame: that the caret index maps to the (row, col) it VISUALLY
 * occupies on a soft-wrapped line, and that the viewport follows it.
 *
 * The wrapping itself (inputRowStarts) is pinned in input.test.ts, which has
 * covered it since the prompt gained multi-line editing; these tests take it as
 * given and cover what was built on top.
 */

/** The editor after a scripted run of verbs, for compact assertions. */
function editor(text: string, at = 0): TextEditor {
  const e = new TextEditor(text);
  for (let i = 0; i < at; i++) e.right();
  return e;
}

/** Render a buffer's rows with the caret drawn as "‸", so a test states the
 *  cursor's VISUAL position rather than an index it has to compute. */
function screen(e: TextEditor, width: number): string {
  const { segs, cursorRow, cursorCol } = e.layout(width);
  return segs
    .map((s, r) => (r === cursorRow ? s.slice(0, cursorCol) + "‸" + s.slice(cursorCol) : s))
    .join("\n");
}

// --- typing and deleting -----------------------------------------------------

test("typing inserts at the caret and carries it along", () => {
  const e = editor("ac", 1);
  e.insert("b");
  assert.equal(e.text, "abc");
  assert.equal(e.cursor, 2);
  e.insert("XY");
  assert.equal(e.text, "abXYc");
  assert.equal(e.cursor, 4);
});

test("backspace and Delete are conventional, and join lines at a boundary", () => {
  const e = editor("ab\ncd", 3); // caret at the start of "cd"
  e.backspace();
  assert.equal(e.text, "abcd", "backspace at a line start eats the newline and joins");
  assert.equal(e.cursor, 2);

  const f = editor("ab\ncd", 2); // caret at the end of "ab"
  f.deleteForward();
  assert.equal(f.text, "abcd", "Delete at a line end pulls the next line up");
  assert.equal(f.cursor, 2, "and the caret does not move");
});

test("backspace at the very start and Delete at the very end do nothing", () => {
  const e = editor("abc", 0);
  e.backspace();
  assert.equal(e.text, "abc");
  const f = editor("abc", 3);
  f.deleteForward();
  assert.equal(f.text, "abc");
  assert.equal(f.cursor, 3);
});

test("a paste's CR/CRLF become real newlines, and control junk never enters the buffer", () => {
  const e = editor("");
  e.insert("one\r\ntwo\rthree");
  assert.equal(e.text, "one\ntwo\nthree");
  const f = editor("");
  f.insert("a\x1b[31mb\x07");
  assert.equal(f.text, "a[31mb", "the escape and the bell are dropped, their text is not");
});

// --- line-scoped keys --------------------------------------------------------

test("Home/End and the kill keys are line-scoped, not buffer-scoped", () => {
  const e = editor("title\n\nbody line", 8); // inside "body line"
  e.home();
  assert.equal(e.cursor, 7, "Home is the start of THIS line");
  e.end();
  assert.equal(e.cursor, 16, "End is the end of THIS line");

  const kill = editor("title\n\nbody line", 11);
  kill.killToEnd();
  assert.equal(kill.text, "title\n\nbody", "Ctrl-K takes the rest of the line only");

  const back = editor("title\n\nbody line", 11);
  back.killToStart();
  assert.equal(back.text, "title\n\n line", "Ctrl-U takes back to the line start only");
  assert.equal(back.cursor, 7);
});

test("Home on the first line does not run off the front of the buffer", () => {
  const e = editor("\nsecond", 0);
  e.home();
  assert.equal(e.cursor, 0, "a leading newline must not report a line start past the caret");
});

// --- cursor mapping on wrapped lines ----------------------------------------

test("the caret lands where it visually appears on a soft-wrapped line", () => {
  // "hello world" wraps after the space at width 8: rows "hello " / "world".
  const e = editor("hello world", 6); // just before "w"
  assert.deepEqual(e.layout(8).segs, ["hello ", "world"]);
  assert.equal(screen(e, 8), "hello \n‸world", "index 6 is column 0 of the second row");

  const mid = editor("hello world", 3);
  assert.equal(screen(mid, 8), "hel‸lo \nworld", "and an index inside the first row stays there");
});

test("Up/Down move by VISUAL row on a wrapped line and clamp at both ends", () => {
  const e = editor("hello world", 8); // "wo|rld" — row 1, col 2
  assert.equal(screen(e, 8), "hello \nwo‸rld");
  assert.equal(e.moveRow(-1, 8), true);
  assert.equal(screen(e, 8), "he‸llo \nworld", "up keeps the column inside the wrapped row above");
  assert.equal(e.moveRow(-1, 8), false, "there is no row above the first");
  assert.equal(screen(e, 8), "he‸llo \nworld", "and a refused move changes nothing");

  e.moveRow(1, 8);
  assert.equal(e.moveRow(1, 8), false, "nor below the last");
  assert.equal(screen(e, 8), "hello \nwo‸rld");
});

test("Down onto a shorter row parks the caret at that row's end", () => {
  const e = editor("a long first line\nx", 10);
  const rows = e.layout(40).segs;
  assert.deepEqual(rows, ["a long first line", "x"]);
  e.moveRow(1, 40);
  assert.equal(screen(e, 40), "a long first line\nx‸", "clamped to the short line's end");
});

test("a caret parked past the last column gets a row of its own", () => {
  // Eight unbroken characters at width 8: the caret at the end belongs on a
  // fresh row below, or it would be drawn one column off the screen.
  const e = editor("abcdefgh", 8);
  const { segs, cursorRow, cursorCol } = e.layout(8);
  assert.deepEqual(segs, ["abcdefgh", ""]);
  assert.equal(cursorRow, 1);
  assert.equal(cursorCol, 0);
});

// --- the viewport ------------------------------------------------------------

test("the viewport scrolls to keep the caret visible, and clamps at both ends", () => {
  // 20 rows of content in a 5-row window.
  assert.equal(scrollToCursor(0, 0, 5, 20), 0, "the top stays at the top");
  assert.equal(scrollToCursor(0, 4, 5, 20), 0, "the last visible row needs no scroll");
  assert.equal(scrollToCursor(0, 5, 5, 20), 1, "one past it scrolls by exactly one");
  assert.equal(scrollToCursor(10, 3, 5, 20), 3, "moving up above the window pulls it back");
  assert.equal(scrollToCursor(0, 19, 5, 20), 15, "the last row sits at the window's bottom");
  assert.equal(scrollToCursor(99, 19, 5, 20), 15, "and the offset can never exceed the end");
  assert.equal(scrollToCursor(3, 0, 5, 2), 0, "a buffer shorter than the window never scrolls");
});

test("a caret dragged down a tall buffer keeps the window under it", () => {
  const e = editor(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"));
  let scroll = 0;
  for (let n = 0; n < 12; n++) {
    e.moveRow(1, 40);
    const { segs, cursorRow } = e.layout(40);
    scroll = scrollToCursor(scroll, cursorRow, 6, segs.length);
    assert.ok(cursorRow >= scroll && cursorRow < scroll + 6, `row ${cursorRow} visible at ${scroll}`);
  }
  assert.equal(scroll, 7, "twelve rows down a six-row window has moved seven");
});

// --- the git-commit split ----------------------------------------------------

test("line 1 is the title, the blank line is a separator, the rest is the body", () => {
  assert.deepEqual(splitMessage("a title\n\nsome prose\n\nmore prose\n"), {
    title: "a title",
    body: "some prose\n\nmore prose",
  });
  assert.deepEqual(splitMessage("just a title\n"), { title: "just a title", body: "" });
  assert.deepEqual(splitMessage(""), { title: "", body: "" });
  assert.deepEqual(
    splitMessage("  padded  \n\n\n\nbody\n\n\n"),
    { title: "padded", body: "body" },
    "the title is trimmed and blank lines at both ends of the body are dropped",
  );
});

test("an empty title is reported as empty, whatever whitespace it is made of", () => {
  assert.equal(splitMessage("   \n\nbody").title, "");
  assert.equal(splitMessage("\n\nbody").title, "");
});

test("title and body round-trip through the buffer", () => {
  for (const [title, body] of [
    ["feat: a thing", "Why the thing.\n\nAnd a second paragraph."],
    ["feat: a thing", ""],
    ["one", "a\nb\nc"],
  ] as const) {
    const text = joinMessage(title, body);
    assert.deepEqual(splitMessage(text), { title, body }, text);
    // And it is idempotent: opening a saved message and saving it untouched
    // must not creep a blank line on or off the end each time.
    const again = splitMessage(text);
    assert.equal(joinMessage(again.title, again.body), text);
  }
});

test("the buffer opens in git-commit shape: title, blank line, body", () => {
  const e = editor(joinMessage("feat: checkout", "Saved cards."));
  assert.deepEqual(e.layout(40).segs, ["feat: checkout", "", "Saved cards.", ""]);
  assert.equal(e.cursor, 0, "and the caret starts on the title");
});

// --- the dirty flag ----------------------------------------------------------

test("dirty tracks the TEXT, not the keystrokes", () => {
  const e = editor("hello", 5);
  assert.equal(e.dirty, false);
  e.insert("!");
  assert.equal(e.dirty, true);
  e.backspace();
  assert.equal(e.dirty, false, "typed and deleted again is not an edit");
  e.moveRow(-1, 40);
  e.home();
  assert.equal(e.dirty, false, "and moving around is never an edit");
});
