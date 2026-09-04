import { test } from "node:test";
import assert from "node:assert/strict";
import {
  awaitPrChecks,
  checksLine,
  failedChecks,
  summarizeChecks,
  type ChecksPolicy,
} from "./checks.js";
import type { CheckRun, CommandResult, ForgeOptions, PrChecksRead } from "./forge.js";

/**
 * Unit tests for the checks gate, one level below the landing engine: how a raw
 * `gh pr checks` read becomes a verdict, and how the bounded wait behaves.
 *
 * The gh SEAM is a scripted CommandRunner rather than the fake forge, so each
 * test states gh's exact contract in the shape gh actually produces — including
 * the two things that are easy to get wrong and were verified against the real
 * binary (gh 2.96): with `--json`, gh exits 0 EVEN FOR FAILING CHECKS, and it
 * exits 1 with "no checks reported on the '<branch>' branch" on stderr when
 * there is nothing to report.
 */

const NOW: ChecksPolicy = { intervalMs: 1, sleep: async () => {} };

function run(name: string, bucket: CheckRun["bucket"]): CheckRun {
  return { name, bucket, state: bucket.toUpperCase() };
}
function read(runs: CheckRun[] | null, requiredOnly = false): PrChecksRead {
  return { runs, requiredOnly };
}

/** A forge whose gh calls are answered from a script, one entry per read of the
 *  ALL-checks list. `--required` always reports none, unless `required` is set. */
function scriptedForge(script: CommandResult[], required?: CommandResult): {
  o: ForgeOptions;
  reads: () => number;
} {
  let i = 0;
  const o: ForgeOptions = {
    repoPath: "/fake",
    remote: "origin",
    devBranch: "dev",
    run: async (_cmd, args) => {
      if (args.includes("--required")) {
        return required ?? { code: 1, stdout: "", stderr: "no required checks reported on the 'b' branch" };
      }
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      return step;
    },
  };
  return { o, reads: () => i };
}

const json = (runs: { name: string; bucket: string }[]): CommandResult => ({
  code: 0,
  stdout: JSON.stringify(runs.map((r) => ({ ...r, state: r.bucket.toUpperCase(), link: "" }))),
  stderr: "",
});
const noChecks: CommandResult = {
  code: 1,
  stdout: "",
  stderr: "no checks reported on the 'co/feat-x' branch",
};

test("no checks at all is `none` and UNGATED — the case that must never read as a failure", () => {
  const s = summarizeChecks(read(null), 0);
  assert.equal(s.verdict, "none");
  assert.equal(s.ungated, true);
  assert.equal(s.total, 0);
  assert.equal(s.failed, 0, "an ungated PR has no failures — it has no checks");
});

test("a verdict is read off the buckets: red beats pending, and skipped is not blocking", () => {
  assert.equal(summarizeChecks(read([run("a", "pass"), run("b", "pass")]), 0).verdict, "passed");
  assert.equal(summarizeChecks(read([run("a", "pass"), run("b", "skipping")]), 0).verdict, "passed");
  assert.equal(summarizeChecks(read([run("a", "skipping")]), 0).verdict, "passed");
  assert.equal(summarizeChecks(read([run("a", "pass"), run("b", "pending")]), 0).verdict, "pending");
  // A red result is reported at once even with work outstanding: GitHub blocks
  // the merge either way, and the resolver can start now rather than in 20 min.
  assert.equal(summarizeChecks(read([run("a", "fail"), run("b", "pending")]), 0).verdict, "failed");
  // A cancelled check did not pass, and a protected branch blocks on it.
  assert.equal(summarizeChecks(read([run("a", "cancel")]), 0).verdict, "failed");
});

test("counts and failedChecks name exactly what a resolver would be sent at", () => {
  const s = summarizeChecks(
    read([run("build", "pass"), run("test", "fail"), run("e2e", "cancel"), run("docs", "skipping")]),
    0,
  );
  assert.deepEqual([s.total, s.passed, s.failed, s.pending, s.skipped], [4, 1, 2, 0, 1]);
  assert.deepEqual(failedChecks(s).map((r) => r.name), ["test", "e2e"]);
  assert.match(checksLine(s), /2 of 4 checks failed: test, e2e/);
});

test("checksLine says 'required check' when only required checks were gated on", () => {
  const s = summarizeChecks(read([run("build", "pass")], true), 0);
  assert.match(checksLine(s), /1 required check passed/);
  assert.match(checksLine(summarizeChecks(read(null), 0)), /no CI checks reported/);
});

test("awaitPrChecks: a green read returns at once, with no second look", async () => {
  const { o, reads } = scriptedForge([json([{ name: "build", bucket: "pass" }])]);
  const s = await awaitPrChecks(o, 1, NOW);
  assert.equal(s.verdict, "passed");
  assert.equal(reads(), 1);
});

test("awaitPrChecks: gh exits 0 with failing checks in the JSON — the buckets decide, not the code", async () => {
  const { o } = scriptedForge([json([{ name: "build", bucket: "fail" }])]);
  const s = await awaitPrChecks(o, 1, NOW);
  assert.equal(s.verdict, "failed", "a zero exit with a fail bucket is a FAILURE");
  assert.equal(s.failed, 1);
});

test("awaitPrChecks polls a pending check and returns the moment it settles", async () => {
  const { o, reads } = scriptedForge([
    json([{ name: "build", bucket: "pending" }]),
    json([{ name: "build", bucket: "pending" }]),
    json([{ name: "build", bucket: "pass" }]),
  ]);
  const s = await awaitPrChecks(o, 1, { ...NOW, timeoutMs: 10_000 });
  assert.equal(s.verdict, "passed");
  assert.equal(reads(), 3);
});

test("awaitPrChecks is BOUNDED: a check that never settles comes back pending + timedOut", async () => {
  const { o } = scriptedForge([json([{ name: "build", bucket: "pending" }])]);
  const s = await awaitPrChecks(o, 1, { ...NOW, timeoutMs: 0 });
  assert.equal(s.verdict, "pending");
  assert.equal(s.timedOut, true, "and it says so, rather than pretending to a verdict");
});

test("no checks + nothing published: the ungated answer is immediate, with no grace spent", async () => {
  const { o, reads } = scriptedForge([noChecks]);
  const s = await awaitPrChecks(o, 1, { ...NOW, graceMs: 30_000 }, { published: false });
  assert.equal(s.verdict, "none");
  assert.equal(s.ungated, true);
  assert.equal(reads(), 1, "there is nothing to wait for on a head that published nothing");
});

test("no checks right after a push: the grace window looks again before calling it ungated", async () => {
  const { o, reads } = scriptedForge([noChecks, noChecks, json([{ name: "build", bucket: "pass" }])]);
  const s = await awaitPrChecks(o, 1, { ...NOW, timeoutMs: 10_000, graceMs: 5_000 }, { published: true });
  assert.equal(s.verdict, "passed", "a check GitHub had not registered yet is not 'no CI'");
  assert.equal(reads(), 3);
});

test("required checks are preferred, and their absence falls back to all checks", async () => {
  const withRequired = scriptedForge([json([{ name: "everything", bucket: "fail" }])], json([
    { name: "build", bucket: "pass" },
  ]));
  const s = await awaitPrChecks(withRequired.o, 1, NOW);
  assert.equal(s.requiredOnly, true);
  assert.equal(s.verdict, "passed", "a non-required red does not block what GitHub would let merge");
  assert.deepEqual(s.runs.map((r) => r.name), ["build"]);

  const noneRequired = scriptedForge([json([{ name: "build", bucket: "fail" }])]);
  const t = await awaitPrChecks(noneRequired.o, 1, NOW);
  assert.equal(t.requiredOnly, false);
  assert.equal(t.verdict, "failed");
});

test("a broken gh read throws instead of degrading to 'no checks'", async () => {
  const { o } = scriptedForge([{ code: 1, stdout: "", stderr: "HTTP 502 from api.github.com" }]);
  await assert.rejects(awaitPrChecks(o, 1, NOW), /gh pr checks 1.*502/);
});

test("an unreadable JSON body fails loudly rather than passing an empty gate", async () => {
  const { o } = scriptedForge([{ code: 0, stdout: "not json at all", stderr: "" }]);
  await assert.rejects(awaitPrChecks(o, 1, NOW), /could not read the checks on PR #1/);
});

test("an unknown bucket counts as pending, never as a pass", async () => {
  const { o } = scriptedForge([json([{ name: "build", bucket: "a-bucket-gh-has-not-invented-yet" }])]);
  const s = await awaitPrChecks(o, 1, { ...NOW, timeoutMs: 0 });
  assert.equal(s.verdict, "pending");
  assert.equal(s.passed, 0, "the worst an unknown bucket costs is a wait, never a false green");
});
