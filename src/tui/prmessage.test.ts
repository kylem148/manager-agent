import { test } from "node:test";
import assert from "node:assert/strict";
import { composeEvidence, composePrMessage } from "../session/landing.js";
import { spliceEvidence, splitEvidence } from "../session/forge.js";
import { renderQueueHeadDetail, type PanelChecks, type QueueHeadDetail } from "./tui.js";
import { stripAnsi } from "./wrap.js";

/**
 * The composed PR message, end to end: from landing.ts, through the body that
 * goes to GitHub, back out to the rows the Ctrl-O queue tab paints
 * (D-20260727-10).
 *
 * This file crosses a layer on purpose. Production never does — the Tui takes a
 * structurally-typed detail and imports nothing from the session — so the ONE
 * thing that could go wrong is exactly what these tests pin: the panel showing a
 * message that isn't the message the pull request carries. Every assertion here
 * compares painted rows against composePrMessage's own output rather than
 * against a hand-written string, so a change to the composition rules either
 * shows up in both places or fails here.
 *
 * The other half of the pin is negative: co's evidence fence must never reach
 * the screen. Its markers are HTML comments GitHub hides, and what they wrap is
 * the checks verdict and commit list the panel already renders from the detail's
 * own structured fields. Painting the raw body shows all of it, twice.
 */

const GREEN: PanelChecks = {
  verdict: "passed",
  ungated: false,
  requiredOnly: false,
  total: 2,
  passed: 2,
  failed: 0,
  pending: 0,
  skipped: 0,
  runs: [
    { name: "typecheck", bucket: "pass" },
    { name: "test", bucket: "pass" },
  ],
  ms: 40,
};

const COMMITS = ["abc1234 job: the card form", "def5678 job: the totals"];

/** The whole real pipeline for one feature: compose the message, compose the
 *  evidence, splice them the way ensurePr does — then split it back out the way
 *  the merge queue hands it to the panel. */
function headDetail(
  feature: string,
  commits: string[] = COMMITS,
  kind: "ready" | "awaiting" = "ready",
): { detail: QueueHeadDetail; title: string; body: string } {
  const message = composePrMessage({ feature, commits, branch: `feat/${feature.replace(/ /g, "-")}` });
  const evidence = composeEvidence({
    commits,
    devSha: "0123456789abcdef",
    featureSha: "fedcba9876543210",
    devRef: "origin/dev",
    checks: {
      verdict: "passed",
      ungated: false,
      requiredOnly: false,
      total: 2,
      passed: 2,
      failed: 0,
      pending: 0,
      skipped: 0,
      runs: [],
      ms: 40,
    },
  });
  const body = spliceEvidence(message.body, evidence);
  return {
    title: message.title,
    body: message.body,
    detail: {
      kind,
      feature,
      target: "dev",
      commits,
      checks: GREEN,
      pr: {
        number: 42,
        url: "https://github.com/acme/repo/pull/42",
        title: message.title,
        body,
        prose: splitEvidence(body).prose,
      },
    },
  };
}

const painted = (detail: QueueHeadDetail, width = 76): string =>
  renderQueueHeadDetail(detail, width).map(stripAnsi).join("\n");

test("the queue tab paints the title and body landing.ts composed, not a second rendering of them", () => {
  const { detail, title, body } = headDetail("checkout flow");
  const frame = painted(detail);

  // Composed, not asserted-as-a-literal: these strings come out of the same call
  // prepareLanding makes, so the rules can only be stated in one place.
  assert.ok(frame.includes(title), `the composed title is on screen: ${title}`);
  assert.ok(frame.includes(body.trim()), `the composed body sentence is on screen: ${body.trim()}`);
  assert.match(title, /^feat: checkout flow$/, "and it really is the branch-typed title");
  assert.match(body, /^Checkout flow, in 2 commits\.$/m, "and the plain one-line description");
});

test("a single-commit head shows that commit's own subject as the title, exactly as the PR does", () => {
  const { detail, title } = headDetail("one slice", ["abc1234 fix(auth): stop refreshing dead tokens"]);
  assert.equal(title, "fix(auth): stop refreshing dead tokens", "the composition's rule, unchanged");
  assert.ok(painted(detail).includes(title), "and the panel shows that same line");
});

test("co's evidence fence never reaches the screen, and nothing in it is painted twice", () => {
  const { detail } = headDetail("checkout flow");
  const frame = painted(detail);

  for (const marker of ["<!-- co:evidence -->", "<!-- /co:evidence -->", "<!--", "### Checks", "### Commits"]) {
    assert.ok(!frame.includes(marker), `the panel never paints ${marker}`);
  }
  // The commit list is rendered once, from the detail's own commits — not again
  // out of the markdown copy inside the fence.
  assert.equal(frame.split("abc1234").length - 1, 1, "each commit appears exactly once");
  assert.equal(frame.split("def5678").length - 1, 1);
  assert.match(frame, /commits \(2\)/);
});

test("the checks evidence stays its own block, above the message", () => {
  const { detail } = headDetail("checkout flow");
  const rows = renderQueueHeadDetail(detail, 76).map(stripAnsi);
  const checks = rows.findIndex((r) => r.includes("checks green"));
  const rule = rows.findIndex((r) => r.includes("── pull request ──"));
  const title = rows.findIndex((r) => r.includes("feat: checkout flow"));
  assert.ok(checks >= 0, "the checks verdict is still rendered");
  assert.ok(rule > checks, "the message opens a block of its own below it");
  assert.ok(title > rule, "and the title is inside that block, not among the evidence");
});

test("an awaiting head carries the same message — the PR exists, only the verdict is missing", () => {
  const { detail, title, body } = headDetail("slow thing", COMMITS, "awaiting");
  const frame = painted(detail);
  assert.ok(frame.includes(title));
  assert.ok(frame.includes(body.trim()));
  assert.match(frame, /commits \(2\)/);
});

test("a source that does not split the body falls back to painting it whole", () => {
  // The pre-split behaviour, kept so a bare QueuePanelSource (and every test that
  // injects one) still renders a description rather than nothing at all.
  const { detail } = headDetail("checkout flow");
  if (detail.kind === "blocked" || !detail.pr) return assert.fail("expected a ready head with a PR");
  const { prose: _dropped, ...withoutProse } = detail.pr;
  const frame = painted({ ...detail, pr: withoutProse });
  assert.match(frame, /Checkout flow, in 2 commits\./, "the description is still shown");
});
