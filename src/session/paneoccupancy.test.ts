import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  isIdleProcessName,
  judgePane,
  normalizeTty,
  parsePsLines,
  pidAlive,
  psTtyProbe,
  type TtyProcess,
} from "./paneoccupancy.js";

/**
 * Tests for the occupancy predicate — the safety question behind pane reuse.
 * The predicate is pure, so every case below is exercised with the process/tty
 * lookup stubbed: no panes, no Ghostty, no timing.
 *
 * The asymmetry is the thing under test as much as the mechanism: a false
 * "occupied" costs one extra split, a false "free" types a launch line into
 * whatever the captain is doing. So every uncertain case must come back NOT
 * free, and the tests say which uncertainty each one is.
 */

const SHELL: TtyProcess[] = [
  { pid: 100, ppid: 1, stat: "Ss", name: "login" },
  { pid: 101, ppid: 100, stat: "S+", name: "zsh" },
];
const IDENTITY = { tty: "ttys004", shellPid: 101 };

test("a pane that exists, is unleased and holds only shells is reusable", () => {
  assert.deepEqual(judgePane({ exists: true, identity: IDENTITY, procs: SHELL }), { free: true });
});

test("a pane co holds a lease on is occupied, whatever its tty says", () => {
  // The lease is what covers the launch window (the wrapper `sh` is up but the
  // agent has not exec'd yet) and the long tail where the captain keeps talking
  // to an agent that already filed its report.
  const v = judgePane({ exists: true, leasedBy: "job job-003", identity: IDENTITY, procs: SHELL });
  assert.equal(v.free, false);
  assert.equal(v.free === false && v.reason, "leased");
  assert.match(v.free === false ? v.detail : "", /job-003/);
});

test("a non-shell process on the tty means occupied, and names what is running", () => {
  const procs = [...SHELL, { pid: 200, ppid: 101, stat: "S+", name: "claude" }];
  const v = judgePane({ exists: true, identity: IDENTITY, procs });
  assert.equal(v.free, false);
  assert.equal(v.free === false && v.reason, "busy");
  assert.match(v.free === false ? v.detail : "", /claude \(pid 200\)/);
});

test("a background process still attached to the tty counts as occupied", () => {
  // Conservative on purpose: a disowned job or a leaked helper is not proof the
  // pane is idle, and being wrong the other way costs the captain work.
  const procs = [...SHELL, { pid: 201, ppid: 101, stat: "S", name: "caffeinate" }];
  assert.equal(judgePane({ exists: true, identity: IDENTITY, procs }).free, false);
});

test("a pane that no longer exists is 'gone', not merely occupied", () => {
  // The caller prunes on this reason rather than keeping a dead pane on the books.
  const v = judgePane({ exists: false, identity: IDENTITY, procs: SHELL });
  assert.equal(v.free === false && v.reason, "gone");
});

test("a pane co has never run a job in is unproven — never free", () => {
  const v = judgePane({ exists: true, procs: SHELL });
  assert.equal(v.free === false && v.reason, "unproven");
  // Half an identity is no identity: both the tty and the shell pid are required.
  assert.equal(judgePane({ exists: true, identity: { tty: "ttys004" }, procs: SHELL }).free, false);
  assert.equal(judgePane({ exists: true, identity: { shellPid: 101 }, procs: SHELL }).free, false);
});

test("an unreadable or empty process table is unproven, never free", () => {
  assert.equal(judgePane({ exists: true, identity: IDENTITY, procs: null }).free, false);
  assert.equal(judgePane({ exists: true, identity: IDENTITY, procs: [] }).free, false);
});

test("the recorded shell must still be alive on that tty, or the tty proves nothing", () => {
  // tty device names are recycled. Without the pane's own shell on it, an idle
  // ttys004 is somebody else's idle pane — and adopting it is forbidden.
  const strangers: TtyProcess[] = [
    { pid: 900, ppid: 1, stat: "Ss", name: "login" },
    { pid: 901, ppid: 900, stat: "S+", name: "zsh" },
  ];
  const v = judgePane({ exists: true, identity: IDENTITY, procs: strangers });
  assert.equal(v.free === false && v.reason, "unproven");
  assert.match(v.free === false ? v.detail : "", /pid 101/);
});

test("shell names are recognised with or without a login dash", () => {
  for (const name of ["zsh", "-zsh", "bash", "-bash", "sh", "fish", "login", "/bin/zsh"]) {
    assert.equal(isIdleProcessName(name), true, name);
  }
  for (const name of ["node", "claude", "vim", "2.1.220", "caffeinate", "python3"]) {
    assert.equal(isIdleProcessName(name), false, name);
  }
});

test("normalizeTty strips /dev/ and refuses anything that isn't a device name", () => {
  assert.equal(normalizeTty("/dev/ttys004"), "ttys004");
  assert.equal(normalizeTty("  ttys004\n"), "ttys004");
  assert.equal(normalizeTty(""), undefined);
  assert.equal(normalizeTty(undefined), undefined);
  assert.equal(normalizeTty("not a tty"), undefined, "`tty`'s own failure text");
  assert.equal(normalizeTty("??"), undefined, "what ps prints for no controlling terminal");
  assert.equal(normalizeTty("-x"), undefined, "never something that could read as a ps flag");
});

test("parsePsLines keeps the whole remainder as the process name", () => {
  const out = [
    " 6753 29127 Ss   login",
    " 6754  6753 S+   zsh",
    "40002 13615 S+   Some App",
    "garbage line",
  ].join("\n");
  assert.deepEqual(parsePsLines(out), [
    { pid: 6753, ppid: 29127, stat: "Ss", name: "login" },
    { pid: 6754, ppid: 6753, stat: "S+", name: "zsh" },
    { pid: 40002, ppid: 13615, stat: "S+", name: "Some App" },
  ]);
});

test("psTtyProbe reads a real tty and returns null for one that isn't there", async () => {
  // The one test that touches the real `ps`. Which ttys exist depends on the
  // machine, so this asserts the contract, not a particular pane: a device with
  // no processes (or no device at all) is null, and a device that does exist
  // comes back parsed.
  assert.equal(await psTtyProbe("ttys999"), null, "a device that does not exist");
  assert.equal(await psTtyProbe("not a device"), null, "a name that could never be one");

  const listing = spawnSync("ps", ["-Ao", "tty="], { encoding: "utf8" });
  const someTty = (listing.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .find((t) => /^ttys\d+$/.test(t));
  if (!someTty) return; // no terminal sessions on this box (CI); nothing to assert
  const procs = await psTtyProbe(someTty);
  assert.ok(procs && procs.length > 0, `expected processes on ${someTty}`);
  assert.ok(
    procs!.every((p) => Number.isInteger(p.pid) && p.name.length > 0),
    "every row parses into a pid and a name",
  );
});

test("pidAlive answers for this process and for one that cannot exist", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  // A pid far above the OS maximum is guaranteed absent.
  assert.equal(pidAlive(4_000_000_000), false);
});
