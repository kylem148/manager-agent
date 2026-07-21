import { test } from "node:test";
import assert from "node:assert/strict";
import { MarkdownRenderer, renderTable, highlightCode, type Rendered } from "./markdown.js";
import { stripAnsi, visibleWidth } from "./wrap.js";
import { colorEnabled } from "../ui.js";

/**
 * Tests for markdown → ANSI rendering, with tables as the main event.
 *
 * These are written to pass in BOTH colour modes, because `colorEnabled` is
 * decided once at import from the real stdout. Run the suite twice to cover
 * both paths:
 *
 *   npm test                                  # piped  → colorEnabled false
 *   script -q /dev/null npm test              # pty    → colorEnabled true
 *
 * So assertions are about structure (widths, alignment, content survival) and
 * use stripAnsi/visibleWidth rather than matching literal escape sequences.
 */

/** Drive complete lines through the renderer the way the TUI does. */
function render(lines: string[], width = 80): string[] {
  const md = new MarkdownRenderer();
  const out: string[] = [];
  const take = (entries: Rendered[]): void => {
    for (const e of entries) {
      if (e.kind === "table") out.push(...renderTable(e.table, width));
      else out.push(e.text);
    }
  };
  for (const l of lines) take(md.feed(l, width));
  take(md.flushBlock(width));
  return out;
}

const plain = (lines: string[]): string[] => lines.map(stripAnsi);

/**
 * The multiset of non-whitespace, non-box characters in a string, as a sorted
 * string. Comparing this before and after layout proves nothing was dropped
 * without caring where the wrapper chose to break — word wrapping eats boundary
 * spaces and hard-splitting breaks mid-token, so position isn't stable but the
 * characters are.
 */
const chars = (s: string): string =>
  s
    .replace(/[│┌┐└┘├┤┬┴┼─]/g, "")
    .replace(/\s/g, "")
    .split("")
    .sort()
    .join("");

const TABLE = [
  "| Option | Cost | Notes |",
  "| --- | ---: | :---: |",
  "| Managed queue | $420 | fastest to ship |",
  "| Self-hosted | $95 | more ops load |",
];

// --- tables ------------------------------------------------------------------

test("a table renders as a box with every row the same visible width", () => {
  const out = render([...TABLE, ""], 80);
  const box = out.filter((l) => stripAnsi(l).trim() !== "");
  assert.ok(box.length >= 6, `expected header, rule and body rows, got ${box.length}`);

  const widths = new Set(box.map((l) => visibleWidth(l)));
  assert.equal(widths.size, 1, `ragged table rows: ${[...widths].join(", ")}`);
  assert.ok([...widths][0]! <= 80);

  const text = plain(out).join("\n");
  assert.match(text, /^┌.*┐$/m);
  assert.match(text, /^├.*┤$/m);
  assert.match(text, /^└.*┘$/m);
  // Cell content survives; the pipe markup does not.
  assert.match(text, /Managed queue/);
  assert.match(text, /more ops load/);
  assert.ok(!text.includes("---"), "delimiter row leaked into output");
});

test("column alignment from the delimiter row is honoured", () => {
  const out = plain(render([...TABLE, ""], 80));
  const row = out.find((l) => l.includes("$420"))!;
  // ": ---:" is right-aligned, so the number hugs the right edge of its cell.
  assert.match(row, /\$420 │/, `expected right-aligned cost, got: ${row}`);
});

test("a table wider than the terminal shrinks and wraps instead of overflowing", () => {
  const wide = [
    "| Service | Owner | Description | Runbook |",
    "| --- | --- | --- | --- |",
    "| ingest-worker | platform | consumes the kafka topic and writes normalized rows to warehouse | https://example.internal/runbooks/ingest-worker |",
    "| api-gateway | edge | terminates TLS and routes to the service mesh | https://example.internal/runbooks/api-gateway |",
  ];
  const out = render([...wide, ""], 60);
  const box = out.filter((l) => stripAnsi(l).trim() !== "");

  for (const l of box) {
    assert.ok(visibleWidth(l) <= 60, `row overflows 60 cols: ${visibleWidth(l)}`);
  }
  const widths = new Set(box.map((l) => visibleWidth(l)));
  assert.equal(widths.size, 1, "wrapped table lost its rectangular shape");

  // Wrapping splits cells across lines — and an unbreakable token like a URL is
  // hard-split mid-word — so no single word is guaranteed contiguous. What must
  // hold is that not one character of cell content is dropped.
  const source = [...wide[0]!.split("|"), ...wide.slice(2).flatMap((r) => r.split("|"))];
  assert.equal(chars(plain(out).join("")), chars(source.join("")), "wrapping dropped content");

  // Wrapped rows get a rule between them so records don't blur together.
  const rules = out.filter((l) => stripAnsi(l).startsWith("├")).length;
  assert.equal(rules, 2, "expected a header rule plus one divider between the two records");
});

test("more columns than the terminal can hold falls back to labelled stanzas, losing nothing", () => {
  const many = [
    "| A | B | C | D | E | F | G | H |",
    "| - | - | - | - | - | - | - | - |",
    "| a1 | b1 | c1 | d1 | e1 | f1 | g1 | h1 |",
  ];
  const out = plain(render([...many, ""], 40));
  const text = out.join("\n");
  assert.ok(!text.includes("┌"), "should not have drawn a box it cannot fit");
  for (const cell of ["a1", "b1", "c1", "d1", "e1", "f1", "g1", "h1"]) {
    assert.match(text, new RegExp(`\\b${cell}\\b`), `stanza fallback dropped ${cell}`);
  }
  assert.match(text, /A: a1/);
  for (const l of out) assert.ok(visibleWidth(l) <= 40, `stanza row overflows: ${l}`);
});

test("the same table re-lays out cleanly at a different width (resize)", () => {
  const md = new MarkdownRenderer();
  let block: Rendered | undefined;
  for (const l of [...TABLE, ""]) {
    for (const e of md.feed(l, 100)) if (e.kind === "table") block = e;
  }
  assert.ok(block && block.kind === "table", "expected a table entry");

  for (const w of [100, 72, 48, 30]) {
    const rows = renderTable(block.table, w);
    const widths = new Set(rows.map((l) => visibleWidth(l)));
    assert.equal(widths.size, 1, `ragged at width ${w}`);
    assert.ok([...widths][0]! <= w, `overflows at width ${w}`);
    assert.match(plain(rows).join("\n"), /Managed queue|Managed/, `content lost at width ${w}`);
  }
});

test("escaped pipes stay content, not cell separators", () => {
  const out = plain(render(["| Expr | Meaning |", "| --- | --- |", "| a \\| b | union |", ""], 80));
  assert.match(out.join("\n"), /a \| b/);
});

test("a table carrying the speaker gutter stays rectangular", () => {
  const lead = "\x1b[32mco  › \x1b[0m";
  const out = render([lead + TABLE[0]!, ...TABLE.slice(1), ""], 80);
  const box = out.filter((l) => stripAnsi(l).trim() !== "");
  const widths = new Set(box.map((l) => visibleWidth(l)));
  assert.equal(widths.size, 1, `gutter broke alignment: ${[...widths].join(", ")}`);
  assert.ok([...widths][0]! <= 80);
});

test("the speaker label doesn't hide block markers on the first line, coloured or not", () => {
  // The label is only escape-wrapped when colour is on; under NO_COLOR it is
  // bare text, and a naive peel would leave "## " to print literally.
  for (const lead of ["\x1b[32mco  › \x1b[0m", "co  › "]) {
    const out = plain(render([lead + "## Heading", lead + "- item"]));
    assert.equal(out[0], "co  › Heading", `heading markup leaked after "${lead}"`);
    assert.equal(out[1], "co  › • item", `list markup leaked after "${lead}"`);
  }
});

test("a table with no trailing blank line still renders on flush", () => {
  const out = plain(render(TABLE, 80));
  assert.match(out.join("\n"), /└.*┘/);
  assert.match(out.join("\n"), /Self-hosted/);
});

// --- streaming ---------------------------------------------------------------

test("table rows are held until the block closes, then commit as one entry", () => {
  const md = new MarkdownRenderer();
  assert.deepEqual(md.feed(TABLE[0]!, 80), [], "header should be held pending a delimiter row");
  assert.deepEqual(md.feed(TABLE[1]!, 80), [], "delimiter row opens the table");
  assert.deepEqual(md.feed(TABLE[2]!, 80), [], "body rows accumulate");

  const done = md.feed("", 80);
  assert.equal(done.length, 2, "expected the table plus the blank line that ended it");
  assert.equal(done[0]!.kind, "table");
  assert.equal(md.hasOpenBlock(), false);
});

test("a pending table is displayed live and absorbs the still-streaming row", () => {
  const md = new MarkdownRenderer();
  md.feed(TABLE[0]!, 80);
  md.feed(TABLE[1]!, 80);

  // Mid-word on the next row: it should already appear inside the box.
  const view = md.pendingLines(80, "| Managed que");
  assert.equal(view.absorbed, true, "partial row should be folded into the live table");
  assert.match(plain(view.rows).join("\n"), /Managed que/);
  assert.match(plain(view.rows).join("\n"), /┌/);

  // A partial line that isn't a row is left for the caller to draw itself.
  assert.equal(md.pendingLines(80, "and that is why").absorbed, false);
});

test("a pipe-bearing line that turns out not to be a table renders as a normal line", () => {
  const out = plain(render(["use a | b to pipe", "next line"], 80));
  assert.deepEqual(out, ["use a | b to pipe", "next line"]);
});

test("pipes inside a code fence never start a table", () => {
  const out = plain(render(["```sh", "cat x | wc -l", "| a | b |", "```"], 80));
  assert.match(out.join("\n"), /cat x \| wc -l/);
  assert.match(out.join("\n"), /\| a \| b \|/);
  assert.ok(!out.join("\n").includes("┌"), "drew a table inside a code fence");
});

// --- other block and inline elements -----------------------------------------

test("block markup is replaced by styling, never printed literally", () => {
  const out = plain(
    render([
      "# Heading",
      "### Deeper",
      "Some **bold** and *italic* and `code` and ~~gone~~.",
      "> quoted line",
      "---",
      "- top item",
      "  - nested item",
      "    - deepest item",
      "1. first",
      "2. second",
      "- [ ] todo",
      "- [x] done",
      "See [docs](https://example.com).",
    ]),
  );
  const text = out.join("\n");

  assert.match(text, /^Heading$/m);
  assert.match(text, /^Deeper$/m);
  assert.match(text, /Some bold and italic and code and gone\./);
  assert.match(text, /│ quoted line/);
  assert.match(text, /^─{3,}$/m);
  assert.match(text, /^• top item$/m);
  assert.match(text, /^ {2}◦ nested item$/m);
  assert.match(text, /^ {4}▪ deepest item$/m);
  assert.match(text, /^1\. first$/m);
  assert.match(text, /^• ☐ todo$/m);
  assert.match(text, /^• ☑ done$/m);
  assert.match(text, /docs \(https:\/\/example\.com\)/);

  // None of the source markers survive.
  for (const marker of ["#", "**", "~~", "`", "[ ]", "[x]", "](" ]) {
    assert.ok(!text.includes(marker), `raw marker "${marker}" leaked through`);
  }
});

test("fence markers become a rule carrying the language, and code keeps its text", () => {
  const out = plain(render(["```ts", "const x = 1; // hi", "```"]));
  assert.ok(!out.join("\n").includes("```"), "backtick fence leaked through");
  assert.match(out[0]!, /ts/);
  assert.equal(out[1], "const x = 1; // hi");
  assert.match(out[2]!, /^─{3,}$/);
});

// --- lossless-ness -----------------------------------------------------------

test("highlighting only adds escapes — the source text is recoverable exactly", () => {
  const samples: Array<[string, string]> = [
    ["ts", `const s = "a \\" b"; // trailing`],
    ["ts", "function f<T>(x: T): T { return x }"],
    ["py", "def f(x):  # comment with 'quotes'"],
    ["py", "s = 'unterminated"],
    ["go", "for i := 0; i < 10; i++ { /* block */ }"],
    ["rust", "let v: Vec<u8> = vec![1, 2, 3];"],
    ["sh", "grep -rn 'foo' . | wc -l  # count"],
    ["sql", "SELECT a, b FROM t WHERE x = 'y' -- note"],
    ["json", `{"a": [1, 2, null], "b": true}`],
    ["clike", "int main(void) { return 0; /* unterminated"],
    ["unknown-lang", "anything at all | with pipes"],
    ["ts", ""],
    ["ts", "   indented   spacing   preserved   "],
  ];
  for (const [lang, src] of samples) {
    assert.equal(stripAnsi(highlightCode(src, lang)), src, `mangled ${lang}: ${src}`);
  }
});

test("rendering never drops the visible text of a line", () => {
  const lines = [
    "plain sentence",
    "- item with `code` and **bold**",
    "> a quote with a [link](https://x.test)",
    "### heading with *emphasis*",
  ];
  const out = plain(render(lines));
  for (const word of ["sentence", "item", "code", "bold", "quote", "link", "heading", "emphasis"]) {
    assert.ok(out.join("\n").includes(word), `lost "${word}"`);
  }
});

test("with colour disabled the output carries no escape sequences at all", () => {
  if (colorEnabled) return; // covered by the piped run of this suite
  const out = render([...TABLE, "", "# heading", "```ts", "const a = 1;", "```", "- item"], 80);
  for (const l of out) {
    assert.ok(!l.includes("\x1b"), `escape leaked into non-colour output: ${JSON.stringify(l)}`);
  }
});
