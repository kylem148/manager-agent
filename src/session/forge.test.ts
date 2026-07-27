import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_CLOSE,
  EVIDENCE_OPEN,
  checkForgePrereqs,
  checkRemotePrereqs,
  devRef,
  ensurePr,
  findOpenPr,
  mergePr,
  pushFeatureBranch,
  readPrChecks,
  remoteBranchSha,
  remoteDevSha,
  spliceEvidence,
  splitEvidence,
  updatePrEvidence,
  updatePrMessage,
  viewPr,
  type CommandResult,
  type CommandRunner,
  type ForgeOptions,
} from "./forge.js";

/**
 * Unit tests for the remote surface. EVERY git and gh call is scripted here —
 * nothing spawns a process, nothing touches a repo, nothing touches the network.
 * What they pin is the exact argv, because that argv IS the contract: `--merge`
 * and never `--squash`, no `--delete-branch`, a lease on every force push.
 *
 * The behaviour of these commands against a real repo is covered separately, by
 * the suites that drive the whole flow through the fake forge in
 * forgefake.test.ts (landing, features, panelmerge).
 */

interface Script {
  /** Matched against "<command> <args joined>"; first match wins. */
  match: RegExp;
  result: Partial<CommandResult>;
}

interface Harness {
  run: CommandRunner;
  calls: string[];
}

function harness(script: Script[]): Harness {
  const calls: string[] = [];
  const run: CommandRunner = async (command, args) => {
    const line = `${command} ${args.join(" ")}`;
    calls.push(line);
    for (const s of script) {
      if (s.match.test(line)) {
        return { code: s.result.code ?? 0, stdout: s.result.stdout ?? "", stderr: s.result.stderr ?? "" };
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

function opts(run: CommandRunner): ForgeOptions {
  return { repoPath: "/repo", remote: "origin", devBranch: "dev", run };
}

const GH_OK: Script[] = [
  { match: /^gh --version/, result: { stdout: "gh version 2.62.0" } },
  { match: /^gh auth status/, result: { stdout: "Logged in" } },
];
const REMOTE_OK: Script[] = [
  { match: /^git remote get-url origin/, result: { stdout: "git@github.com:acme/repo.git" } },
  { match: /^git fetch origin/, result: {} },
  { match: /^git rev-parse --verify --quiet refs\/remotes\/origin\/dev/, result: { stdout: "devsha\n" } },
];

test("devRef names the remote-tracking integration ref, never the local branch", () => {
  assert.equal(devRef({ remote: "origin", devBranch: "dev" }), "origin/dev");
  assert.equal(devRef({ remote: "upstream", devBranch: "integration" }), "upstream/integration");
});

test("prereqs pass when gh is installed, authenticated, and origin/dev resolves", async () => {
  const h = harness([...GH_OK, ...REMOTE_OK]);
  assert.deepEqual(await checkForgePrereqs(opts(h.run)), { ok: true });
  // The fetch is part of the check: the ref it verifies must be a FRESH one.
  assert.ok(h.calls.includes("git fetch origin"), `fetched: ${h.calls.join(" | ")}`);
});

test("a missing gh fails cleanly, names the tool, and stops before touching git", async () => {
  const h = harness([{ match: /^gh --version/, result: { code: 127, stderr: "command not found" } }]);
  const check = await checkForgePrereqs(opts(h.run));
  assert.equal(check.ok, false);
  assert.match(check.ok === false ? check.reason : "", /GitHub CLI/);
  assert.match(check.ok === false ? check.reason : "", /cli\.github\.com/);
  assert.deepEqual(h.calls, ["gh --version"], "it stops at the first missing prerequisite");
});

test("an unauthenticated gh fails cleanly and says how to fix it", async () => {
  const h = harness([
    { match: /^gh --version/, result: {} },
    { match: /^gh auth status/, result: { code: 1, stderr: "You are not logged into any GitHub hosts." } },
  ]);
  const check = await checkForgePrereqs(opts(h.run));
  assert.equal(check.ok, false);
  assert.match(check.ok === false ? check.reason : "", /gh auth login/);
  assert.ok(!h.calls.some((c) => c.startsWith("git")), "no git ran after the auth failure");
});

test("a repo with no origin remote fails cleanly", async () => {
  const h = harness([
    ...GH_OK,
    { match: /^git remote get-url origin/, result: { code: 128, stderr: "No such remote" } },
  ]);
  const check = await checkForgePrereqs(opts(h.run));
  assert.equal(check.ok, false);
  assert.match(check.ok === false ? check.reason : "", /no 'origin' remote/);
  assert.ok(!h.calls.includes("git fetch origin"), "it does not fetch a remote that isn't there");
});

test("a missing origin/dev fails cleanly and refuses to create it", async () => {
  const h = harness([
    ...GH_OK,
    { match: /^git remote get-url origin/, result: { stdout: "url" } },
    { match: /^git fetch origin/, result: {} },
    { match: /^git rev-parse --verify --quiet refs\/remotes\/origin\/dev/, result: { code: 1 } },
  ]);
  const check = await checkRemotePrereqs(opts(h.run));
  assert.equal(check.ok, false);
  assert.match(check.ok === false ? check.reason : "", /no 'origin\/dev' branch on the remote/);
  assert.match(check.ok === false ? check.reason : "", /co never creates it/);
  assert.ok(
    !h.calls.some((c) => /^git (branch|push|update-ref)/.test(c)),
    `nothing was created: ${h.calls.join(" | ")}`,
  );
});

test("a failing fetch is reported as the prereq failure, not swallowed", async () => {
  const h = harness([
    ...GH_OK,
    { match: /^git remote get-url origin/, result: { stdout: "url" } },
    { match: /^git fetch origin/, result: { code: 128, stderr: "could not read from remote" } },
  ]);
  const check = await checkRemotePrereqs(opts(h.run));
  assert.equal(check.ok, false);
  assert.match(check.ok === false ? check.reason : "", /git fetch origin.*could not read/s);
});

test("remoteDevSha and remoteBranchSha read the remote-tracking refs", async () => {
  const h = harness([
    { match: /^git rev-parse refs\/remotes\/origin\/dev/, result: { stdout: "aaa111\n" } },
    { match: /^git rev-parse --verify --quiet refs\/remotes\/origin\/co\/feat-known/, result: { stdout: "bbb222\n" } },
    { match: /^git rev-parse --verify --quiet refs\/remotes\/origin\/co\/feat-new/, result: { code: 1 } },
  ]);
  assert.equal(await remoteDevSha(opts(h.run)), "aaa111");
  assert.equal(await remoteBranchSha(opts(h.run), "co/feat-known"), "bbb222");
  assert.equal(await remoteBranchSha(opts(h.run), "co/feat-new"), null, "an unknown branch reads as null");
});

test("a branch the remote has never seen is created with a plain push, no force", async () => {
  const h = harness([{ match: /^git rev-parse --verify --quiet/, result: { code: 1 } }]);
  const res = await pushFeatureBranch(opts(h.run), "co/feat-a", "newsha");
  assert.deepEqual(res, { pushed: true, created: true });
  const push = h.calls.find((c) => c.startsWith("git push"))!;
  assert.equal(push, "git push origin co/feat-a:refs/heads/co/feat-a");
  assert.ok(!push.includes("--force"), "a create never forces");
});

test("a rebased branch is force-pushed WITH a lease on the sha we observed", async () => {
  const h = harness([{ match: /^git rev-parse --verify --quiet/, result: { stdout: "oldsha\n" } }]);
  const res = await pushFeatureBranch(opts(h.run), "co/feat-a", "rebasedsha");
  assert.deepEqual(res, { pushed: true, created: false });
  const push = h.calls.find((c) => c.startsWith("git push"))!;
  assert.equal(push, "git push --force-with-lease=co/feat-a:oldsha origin co/feat-a:refs/heads/co/feat-a");
  assert.ok(!/--force(?!-with-lease)/.test(push), "never a bare --force");
});

test("a push whose lease is stale fails loudly and says to re-process", async () => {
  const h = harness([
    { match: /^git rev-parse --verify --quiet/, result: { stdout: "oldsha\n" } },
    { match: /^git push/, result: { code: 1, stderr: "! [rejected] (stale info)" } },
  ]);
  await assert.rejects(
    pushFeatureBranch(opts(h.run), "co/feat-a", "rebasedsha"),
    /stale info[\s\S]*re-process the head/,
  );
});

test("a branch the remote already holds at this sha is not pushed again", async () => {
  const h = harness([{ match: /^git rev-parse --verify --quiet/, result: { stdout: "samesha\n" } }]);
  const res = await pushFeatureBranch(opts(h.run), "co/feat-a", "samesha");
  assert.deepEqual(res, { pushed: false, created: false });
  assert.ok(!h.calls.some((c) => c.startsWith("git push")), "no push at all");
});

test("findOpenPr asks for the open PR from the branch into dev, and reads null for none", async () => {
  const empty = harness([{ match: /^gh pr list/, result: { stdout: "[]" } }]);
  assert.equal(await findOpenPr(opts(empty.run), "co/feat-a"), null);
  assert.equal(
    empty.calls[0],
    "gh pr list --head co/feat-a --base dev --state open --limit 1 --json number,url,title,body,headRefOid,baseRefName,state",
  );

  const found = harness([
    {
      match: /^gh pr list/,
      result: { stdout: JSON.stringify([{ number: 7, url: "u", title: "t", body: "b", headRefOid: "h" }]) },
    },
  ]);
  const pr = await findOpenPr(opts(found.run), "co/feat-a");
  assert.equal(pr?.number, 7);
  assert.equal(pr?.headRefOid, "h");
});

test("ensurePr CREATES with the composed title and body when none is open", async () => {
  const h = harness([
    { match: /^gh pr list/, result: { stdout: "[]" } },
    { match: /^gh pr create/, result: { stdout: "https://github.com/acme/repo/pull/12\n" } },
  ]);
  const res = await ensurePr(opts(h.run), {
    branch: "co/feat-a",
    title: "add auth",
    body: "prose",
    evidence: "EV",
  });
  assert.equal(res.created, true);
  assert.equal(res.pr.number, 12, "the number falls back to the created URL when the re-read finds nothing");
  const create = h.calls.find((c) => c.startsWith("gh pr create"))!;
  assert.match(create, /gh pr create --base dev --head co\/feat-a --title add auth --body /);
  assert.match(create, /prose[\s\S]*co:evidence[\s\S]*EV/);
});

test("ensurePr returns an already-open PR UNTOUCHED — its body is the captain's until evidence lands", async () => {
  const captainBody = `The captain rewrote this description.\n\n${EVIDENCE_OPEN}\nold evidence\n${EVIDENCE_CLOSE}\n`;
  const h = harness([
    {
      match: /^gh pr list/,
      result: {
        stdout: JSON.stringify([
          { number: 5, url: "u", title: "a title the captain chose", body: captainBody },
        ]),
      },
    },
  ]);
  const res = await ensurePr(opts(h.run), {
    branch: "co/feat-a",
    title: "co would have called it this",
    body: "co's original prose",
    evidence: "co would have written this",
  });
  assert.equal(res.created, false);
  assert.equal(res.pr.number, 5);
  assert.equal(res.pr.body, captainBody, "nothing is rewritten just by looking it up");
  assert.ok(!h.calls.some((c) => c.startsWith("gh pr edit")), "and nothing is sent");
});

test("updatePrEvidence rewrites only the evidence block, never the captain's title or prose", async () => {
  const captainBody = `The captain rewrote this description.\n\n${EVIDENCE_OPEN}\nold evidence\n${EVIDENCE_CLOSE}\n`;
  const h = harness([]);
  const res = await updatePrEvidence(
    opts(h.run),
    { number: 5, url: "u", title: "a title the captain chose", body: captainBody },
    "fresh evidence",
  );
  assert.equal(res.bodyUpdated, true);
  const edit = h.calls.find((c) => c.startsWith("gh pr edit"))!;
  assert.match(edit, /^gh pr edit 5 --body /);
  assert.match(edit, /The captain rewrote this description\./, "their prose survives");
  assert.match(edit, /fresh evidence/, "the evidence is refreshed");
  assert.ok(!edit.includes("old evidence"), "the stale evidence is gone");
  assert.ok(!edit.includes("--title"), "the title is never overwritten on an update");
  assert.equal(res.pr.title, "a title the captain chose");
});

test("updatePrMessage rewrites the title and the prose, and carries the evidence across untouched", async () => {
  const evidence = "### Checks\n**green** — 2 checks passed.";
  const body = `The first draft.\n\n${EVIDENCE_OPEN}\n${evidence}\n${EVIDENCE_CLOSE}\n`;
  const h = harness([]);
  const res = await updatePrMessage(
    opts(h.run),
    { number: 42, url: "u", title: "old title", body },
    { title: "a better title", prose: "A better description.\n\nWith a second paragraph." },
  );
  const edit = h.calls.find((chk) => chk.startsWith("gh pr edit"))!;
  assert.match(edit, /^gh pr edit 42 --title a better title --body /, "one edit, title and body together");
  assert.ok(!edit.includes("The first draft."), "the old prose is gone");
  assert.match(res.body, /A better description\./);
  assert.match(res.body, /With a second paragraph\./);
  // The block co owns is preserved exactly, and exactly once.
  assert.equal(splitEvidence(res.body).evidence, evidence, "byte-for-byte the block that was there");
  assert.equal(res.body.match(new RegExp(EVIDENCE_OPEN, "g"))?.length, 1, "one opening marker");
  assert.equal(res.body.match(new RegExp(EVIDENCE_CLOSE, "g"))?.length, 1, "one closing marker");
  assert.equal(res.title, "a better title");
});

test("updatePrMessage folds a multi-line title and refuses an empty one before sending", async () => {
  const h = harness([]);
  const res = await updatePrMessage(
    opts(h.run),
    { number: 42, url: "u", title: "t", body: "prose" },
    { title: "  a title\nsplit over lines  ", prose: "p" },
  );
  assert.equal(res.title, "a title split over lines", "GitHub titles are one line");

  const empty = harness([]);
  await assert.rejects(
    () =>
      updatePrMessage(
        opts(empty.run),
        { number: 42, url: "u", title: "t", body: "prose" },
        { title: "   ", prose: "p" },
      ),
    /needs a title/,
  );
  assert.deepEqual(empty.calls, [], "nothing was sent at all");
});

test("updatePrMessage adds no fence to a body that has none, and strips one out of the prose", async () => {
  const h = harness([]);
  const plain = await updatePrMessage(
    opts(h.run),
    { number: 42, url: "u", title: "t", body: "just prose, no block\n" },
    { title: "t", prose: "still just prose" },
  );
  assert.equal(plain.body.includes(EVIDENCE_OPEN), false, "co's next processing splices one in, not this");
  assert.equal(plain.body, "still just prose\n");

  // Prose that arrives carrying a fence (a paste, a hand-edited store) is
  // stripped, for the same reason an authored body is: a frozen copy of the
  // checks would be stale the moment the head re-processes.
  const smuggled = await updatePrMessage(
    opts(harness([]).run),
    { number: 42, url: "u", title: "t", body: `p\n\n${EVIDENCE_OPEN}\nreal\n${EVIDENCE_CLOSE}\n` },
    { title: "t", prose: `mine\n\n${EVIDENCE_OPEN}\nfrozen and wrong\n${EVIDENCE_CLOSE}` },
  );
  assert.equal(splitEvidence(smuggled.body).evidence, "real", "the PR's own block wins");
  assert.equal(splitEvidence(smuggled.body).prose, "mine");
  assert.equal(smuggled.body.match(new RegExp(EVIDENCE_OPEN, "g"))?.length, 1, "never two fences");
});

test("an update with unchanged evidence sends nothing at all", async () => {
  const body = `prose\n\n${EVIDENCE_OPEN}\nsame\n${EVIDENCE_CLOSE}\n`;
  const h = harness([]);
  const res = await updatePrEvidence(opts(h.run), { number: 5, url: "u", title: "t", body }, "same");
  assert.equal(res.bodyUpdated, false);
  assert.ok(!h.calls.some((c) => c.startsWith("gh pr edit")), "no edit call");
});

test("readPrChecks asks for the REQUIRED checks first and gates on those alone", async () => {
  const h = harness([
    {
      match: /^gh pr checks 5 --json .* --required/,
      result: { stdout: JSON.stringify([{ name: "build", bucket: "pass", state: "SUCCESS" }]) },
    },
  ]);
  const res = await readPrChecks(opts(h.run), 5);
  assert.equal(res.requiredOnly, true);
  assert.deepEqual(res.runs?.map((r) => r.name), ["build"]);
  assert.equal(h.calls.filter((c) => c.startsWith("gh pr checks")).length, 1, "no second read needed");
  assert.match(h.calls[0]!, /^gh pr checks 5 --json name,state,bucket,link,workflow,description --required$/);
});

test("readPrChecks falls back to ALL checks when branch protection defines none", async () => {
  const h = harness([
    {
      match: /--required/,
      result: { code: 1, stderr: "no required checks reported on the 'co/feat-a' branch" },
    },
    {
      match: /^gh pr checks 5/,
      result: { stdout: JSON.stringify([{ name: "test", bucket: "fail", state: "FAILURE" }]) },
    },
  ]);
  const res = await readPrChecks(opts(h.run), 5);
  assert.equal(res.requiredOnly, false);
  assert.deepEqual(res.runs?.map((r) => r.bucket), ["fail"]);
});

test("readPrChecks reports NO CHECKS as null, not as an error — gh exits 1 for both", async () => {
  const h = harness([
    { match: /^gh pr checks/, result: { code: 1, stderr: "no checks reported on the 'co/feat-a' branch" } },
  ]);
  const res = await readPrChecks(opts(h.run), 5);
  assert.equal(res.runs, null, "null is the ungated case; the caller must not treat it as red");
});

test("readPrChecks throws on any OTHER nonzero gh exit, so a broken read is never an ungated pass", async () => {
  const h = harness([
    { match: /^gh pr checks/, result: { code: 1, stderr: "HTTP 401: Bad credentials" } },
  ]);
  await assert.rejects(readPrChecks(opts(h.run), 5), /gh pr checks 5.*401/);
});

test("spliceEvidence replaces a fenced block and appends when the fence is gone", () => {
  const fenced = `intro\n\n${EVIDENCE_OPEN}\nold\n${EVIDENCE_CLOSE}\n\noutro`;
  const replaced = spliceEvidence(fenced, "new");
  assert.match(replaced, /intro[\s\S]*new[\s\S]*outro/);
  assert.ok(!replaced.includes("old"));

  const rewritten = spliceEvidence("the captain replaced the whole body", "new");
  assert.match(rewritten, /the captain replaced the whole body/);
  assert.match(rewritten, /new/);
});

test("splitEvidence undoes spliceEvidence: the human message back on one side, co's block on the other", () => {
  // The round trip is the property that matters: whatever co spliced in comes
  // back out whole, and the prose is left exactly as its author wrote it.
  const prose = "User auth, in 2 commits.";
  const evidence = "### Checks\n**green** — 2 checks passed.";
  const parts = splitEvidence(spliceEvidence(prose, evidence));
  assert.equal(parts.prose, prose, "the description survives verbatim");
  assert.equal(parts.evidence, evidence, "and so does the block, without its markers");
  // The markers themselves never come back out — they are HTML comments GitHub
  // hides, and anything painting the prose would print them literally.
  assert.ok(!parts.prose.includes(EVIDENCE_OPEN) && !parts.prose.includes(EVIDENCE_CLOSE));
  assert.ok(!parts.evidence.includes(EVIDENCE_OPEN) && !parts.evidence.includes(EVIDENCE_CLOSE));

  // A captain who writes on BOTH sides of the fence keeps both halves, as
  // paragraphs — the fence is co's region, not a divider in their text.
  const both = splitEvidence(`above\n\n${EVIDENCE_OPEN}\nblock\n${EVIDENCE_CLOSE}\n\nbelow`);
  assert.equal(both.prose, "above\n\nbelow");
  assert.equal(both.evidence, "block");

  // No fence at all (a body the captain replaced wholesale, or a PR co never
  // wrote): it is ALL prose, and nothing is invented as evidence.
  const bare = splitEvidence("just a description");
  assert.equal(bare.prose, "just a description");
  assert.equal(bare.evidence, "");
});

test("mergePr merges with a MERGE COMMIT and never squashes, rebases or deletes the branch", async () => {
  const h = harness([
    { match: /^gh pr merge/, result: { stdout: "Merged" } },
    { match: /^git fetch/, result: {} },
    {
      match: /^gh pr view/,
      result: {
        stdout: JSON.stringify({
          number: 9,
          url: "https://github.com/acme/repo/pull/9",
          title: "t",
          body: "b",
          state: "MERGED",
          mergeCommit: { oid: "mergesha" },
        }),
      },
    },
  ]);
  const res = await mergePr(opts(h.run), 9);
  assert.equal(res.mergeCommitSha, "mergesha");
  assert.equal(res.url, "https://github.com/acme/repo/pull/9");
  const merge = h.calls.find((c) => c.startsWith("gh pr merge"))!;
  assert.equal(merge, "gh pr merge 9 --merge");
  const forbidden = ["--squash", "--rebase", "--delete-branch", "--auto"];
  for (const flagName of forbidden) {
    assert.ok(!h.calls.some((c) => c.includes(flagName)), `${flagName} is never passed`);
  }
  assert.ok(h.calls.some((c) => c.startsWith("git fetch")), "co learns dev moved by fetching afterwards");
});

test("a refused merge throws with gh's own reason and reports no merge commit", async () => {
  const h = harness([
    { match: /^gh pr merge/, result: { code: 1, stderr: "Pull request is not mergeable" } },
  ]);
  await assert.rejects(mergePr(opts(h.run), 4), /gh pr merge 4 --merge.*not mergeable/s);
});

test("viewPr surfaces the forge's head sha, base and state for the pre-merge guards", async () => {
  const h = harness([
    {
      match: /^gh pr view/,
      result: {
        stdout: JSON.stringify({
          number: 3,
          url: "u",
          title: "t",
          body: "b",
          headRefOid: "headsha",
          baseRefName: "dev",
          state: "OPEN",
          mergeCommit: null,
        }),
      },
    },
  ]);
  const pr = await viewPr(opts(h.run), 3);
  assert.equal(pr.headRefOid, "headsha");
  assert.equal(pr.baseRefName, "dev");
  assert.equal(pr.state, "OPEN");
  assert.equal(pr.mergeCommitSha, undefined);
});

test("unreadable gh output fails with a clear message instead of an opaque parse error", async () => {
  const h = harness([{ match: /^gh pr list/, result: { stdout: "not json at all" } }]);
  await assert.rejects(findOpenPr(opts(h.run), "co/feat-a"), /could not read the open PRs/);
});
