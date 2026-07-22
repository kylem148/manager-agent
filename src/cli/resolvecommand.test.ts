import { test } from "node:test";
import assert from "node:assert/strict";
import { unquoteAliasBody, parseCommandV, resolveCommandWord } from "./resolvecommand.js";

/**
 * Tests for the login-shell command resolver. The parser is pure and tested
 * against the EXACT output shapes bash and zsh emit for `command -v` (captured
 * live: see the shapes inline). One end-to-end test resolves a real alias through
 * a spawned zsh to prove the interactive-shell path actually works on this box.
 */

test("unquoteAliasBody handles bare zsh bodies and single-quoted bodies", () => {
  // zsh prints a simple body bare.
  assert.equal(unquoteAliasBody("claude"), "claude");
  // bash/zsh single-quote a body with special characters.
  assert.equal(unquoteAliasBody(`'CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude'`), `CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude`);
  assert.equal(unquoteAliasBody(`'claude'`), "claude");
  // An embedded single quote comes back as the '\'' escape sequence.
  assert.equal(unquoteAliasBody(`'it'\\''s'`), "it's");
});

test("parseCommandV expands an alias line to its body (the cc/ccw case)", () => {
  // zsh: `alias cc=claude`
  const cc = parseCommandV("cc", "alias cc=claude", 0);
  assert.equal(cc.kind, "alias");
  assert.equal(cc.command, "claude");
  assert.equal(cc.runnable, true);

  // zsh: `alias ccw='CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude'`
  const ccw = parseCommandV("ccw", `alias ccw='CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude'`, 0);
  assert.equal(ccw.kind, "alias");
  assert.equal(ccw.command, `CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude`);
  assert.equal(ccw.runnable, true);

  // bash quotes even a simple body: `alias cc='claude'`
  const bashCc = parseCommandV("cc", "alias cc='claude'", 0);
  assert.equal(bashCc.command, "claude");
});

test("parseCommandV treats an absolute path as a runnable binary, storing the word", () => {
  const r = parseCommandV("git", "/usr/bin/git", 0);
  assert.equal(r.kind, "binary");
  assert.equal(r.command, "git"); // the word, not the path: PATH is inherited on dispatch
  assert.equal(r.runnable, true);
});

test("parseCommandV flags a function/builtin as a non-runnable shell-word", () => {
  // `command -v myfunc` prints the bare name for a function or builtin.
  const fn = parseCommandV("myfunc", "myfunc", 0);
  assert.equal(fn.kind, "shell-word");
  assert.equal(fn.command, "myfunc");
  assert.equal(fn.runnable, false);
});

test("parseCommandV returns unresolved for a missing word (empty output / nonzero exit)", () => {
  const miss = parseCommandV("nope123", "", 1);
  assert.equal(miss.kind, "unresolved");
  assert.equal(miss.command, "nope123"); // stored verbatim so the operator can fix it
  assert.equal(miss.runnable, false);
  // Empty output even with a zero exit is still unresolved.
  assert.equal(parseCommandV("x", "   ", 0).kind, "unresolved");
});

test("resolveCommandWord expands a real alias through a spawned interactive zsh", async () => {
  // Only meaningful where zsh exists; skip elsewhere rather than fail.
  const zsh = "/bin/zsh";
  const { existsSync } = await import("node:fs");
  if (!existsSync(zsh)) return;
  // Define the alias in a throwaway rc via ZDOTDIR so we don't depend on the
  // developer's personal aliases. -i reads $ZDOTDIR/.zshrc.
  const os = await import("node:os");
  const path = await import("node:path");
  const fsp = await import("node:fs/promises");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "co-resolve-"));
  try {
    await fsp.writeFile(
      path.join(dir, ".zshrc"),
      `alias demo='CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude'\n`,
      "utf8",
    );
    const prevZdot = process.env.ZDOTDIR;
    process.env.ZDOTDIR = dir;
    try {
      const r = await resolveCommandWord("demo", { shell: zsh });
      assert.equal(r.kind, "alias", `expected alias, got ${JSON.stringify(r)}`);
      assert.equal(r.command, `CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude`);
      assert.equal(r.runnable, true);
    } finally {
      if (prevZdot === undefined) delete process.env.ZDOTDIR;
      else process.env.ZDOTDIR = prevZdot;
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
