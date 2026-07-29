import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PANE_WAIT_SEC, paneWaitSec } from "./config.js";

/**
 * Tests for the env-driven config readers that resolve lazily at the point of
 * use (rather than through loadConfig), so the value the caller sees is the one
 * in the environment right now.
 *
 * `co pane`'s countdown is one of those. What is pinned here is the DEFAULT — the
 * wait a captain who has set nothing actually sits through — because that is the
 * whole of the tuning: the countdown itself is a bare sleep loop in runPaneAnchor
 * with no condition attached, and the real designation (does the focused Ghostty
 * pane get picked up) is AppleScript against a live app and is not reachable from
 * a test at all.
 */

function withEnv(value: string | undefined, fn: () => void): void {
  const prior = process.env.CO_PANE_WAIT;
  if (value === undefined) delete process.env.CO_PANE_WAIT;
  else process.env.CO_PANE_WAIT = value;
  try {
    fn();
  } finally {
    if (prior === undefined) delete process.env.CO_PANE_WAIT;
    else process.env.CO_PANE_WAIT = prior;
  }
}

test("co pane waits 2 seconds by default", () => {
  assert.equal(DEFAULT_PANE_WAIT_SEC, 2);
  withEnv(undefined, () => {
    assert.equal(paneWaitSec(), 2);
  });
});

test("CO_PANE_WAIT retunes the countdown without a code change", () => {
  withEnv("6", () => assert.equal(paneWaitSec(), 6));
  withEnv("1", () => assert.equal(paneWaitSec(), 1));
});

test("a junk CO_PANE_WAIT falls back to the default rather than breaking co pane", () => {
  // Neither an instant grab (0 / negative / unparseable) nor a hang: a
  // fat-fingered value degrades to the default, matching the rest of config.ts.
  for (const junk of ["", "0", "-3", "soon"]) {
    withEnv(junk, () => assert.equal(paneWaitSec(), DEFAULT_PANE_WAIT_SEC));
  }
});
