import { spawnSync } from "node:child_process";
import type { CommandResult, CommandRunner } from "./forge.js";

/**
 * A fake forge: everything `git fetch`/`git push`/`gh` would do, in memory,
 * against a real local repo. This is the test double every suite that exercises
 * the PR landing flow injects as `run`, so NOT ONE test in this repo performs a
 * network operation, needs the `gh` binary, or needs a GitHub account.
 *
 * It carries the `.test.ts` suffix on purpose: that is what keeps it out of the
 * build (tsconfig excludes `**\/*.test.ts`) and out of `dist`. It declares no
 * tests of its own, so the runner simply loads it — and importing it from
 * another suite therefore registers nothing extra.
 *
 * WHAT IT SIMULATES, and why it is not just a stub:
 *  - remote branches are a map; `git fetch` writes them into the repo's real
 *    `refs/remotes/origin/*`, so the code under test reads the remote-tracking
 *    refs with real git exactly as it does in production.
 *  - `git push` honours `--force-with-lease`: a lease that no longer matches
 *    fails, the way it would against a branch someone else moved.
 *  - `gh pr merge --merge` builds a REAL two-parent merge commit in the repo
 *    (commit-tree over the base and head shas) and moves the fake `origin/dev`
 *    to it. So a test can assert the resulting topology — two parents, per-job
 *    commits preserved — instead of trusting a mock's say-so. It refuses a head
 *    that is not a descendant of the base, like GitHub refusing a stale PR.
 *  - `--delete-branch` is never handled because production never passes it;
 *    every command is recorded in `calls` so a test can assert that.
 *
 * Any git command that is NOT about the remote (rev-parse, merge-base, …) is
 * delegated to real git in the repo, so the fake never has to model git itself.
 */

export interface FakePr {
  number: number;
  title: string;
  body: string;
  /** The head BRANCH name (this flow never uses cross-fork `owner:branch`). */
  head: string;
  base: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergeCommit?: string;
}

export interface FakeForge {
  /** Inject this as LandingOptions.run / FeatureManagerOptions.run. */
  run: CommandRunner;
  /** The remote's branches: name -> sha. Seed `dev` before anything else. */
  branches: Map<string, string>;
  prs: FakePr[];
  /** Every command the code under test ran, as "<cmd> <args…>". */
  calls: string[];
  /** Just the pushes, for the common assertion. */
  pushes: string[];
  /** Flip to model a missing/unauthenticated gh or a repo with no remote. */
  ghInstalled: boolean;
  ghAuthed: boolean;
  hasRemote: boolean;
  /** When set, `gh pr merge` fails with this message. */
  mergeError: string | null;
  prFor(branch: string): FakePr | undefined;
}

const REPO_URL = "https://github.com/acme/repo";

function real(repo: string, args: string[]): CommandResult {
  const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function ok(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "" };
}
function fail(stderr: string, code = 1): CommandResult {
  return { code, stdout: "", stderr };
}

/** Read a `--flag value` pair out of an argv array. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

export function makeFakeForge(repo: string, seed: { dev?: string } = {}): FakeForge {
  const f: FakeForge = {
    run: async () => ok(),
    branches: new Map(),
    prs: [],
    calls: [],
    pushes: [],
    ghInstalled: true,
    ghAuthed: true,
    hasRemote: true,
    mergeError: null,
    prFor: (branch) => f.prs.find((p) => p.head === branch && p.state === "OPEN"),
  };
  if (seed.dev) f.branches.set("dev", seed.dev);

  const fetchIntoRepo = (): CommandResult => {
    for (const [branch, sha] of f.branches) {
      const res = real(repo, ["update-ref", `refs/remotes/origin/${branch}`, sha]);
      if (res.code !== 0) return res;
    }
    return ok();
  };

  const doPush = (args: string[]): CommandResult => {
    const lease = args.find((a) => a.startsWith("--force-with-lease="));
    const spec = args.find((a) => a.includes(":") && !a.startsWith("--"));
    if (!spec) return fail("fake forge: no refspec in push");
    const [src, dst] = spec.split(":");
    const branch = (dst ?? "").replace(/^refs\/heads\//, "") || (src ?? "");
    const resolved = real(repo, ["rev-parse", src!]);
    if (resolved.code !== 0) return fail(`fake forge: cannot resolve ${src}`);
    const sha = resolved.stdout.trim();
    if (lease) {
      const expected = lease.slice("--force-with-lease=".length).split(":")[1] ?? "";
      const actual = f.branches.get(branch) ?? "";
      if (expected !== actual) {
        return fail(`! [rejected] ${branch} -> ${branch} (stale info)`);
      }
    }
    f.branches.set(branch, sha);
    f.pushes.push(`${branch}=${sha}`);
    return ok();
  };

  const prJson = (pr: FakePr, fields: string[]): Record<string, unknown> => {
    const all: Record<string, unknown> = {
      number: pr.number,
      url: `${REPO_URL}/pull/${pr.number}`,
      title: pr.title,
      body: pr.body,
      headRefOid: f.branches.get(pr.head) ?? "",
      baseRefName: pr.base,
      state: pr.state,
      mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null,
    };
    const out: Record<string, unknown> = {};
    for (const key of fields) if (key in all) out[key] = all[key];
    return out;
  };

  const doGh = (args: string[]): CommandResult => {
    if (!f.ghInstalled) return fail("gh: command not found", 127);
    if (args[0] === "--version") return ok("gh version 2.62.0 (fake)\n");
    if (args[0] === "auth" && args[1] === "status") {
      return f.ghAuthed
        ? ok("github.com\n  ✓ Logged in to github.com as tester\n")
        : fail("You are not logged into any GitHub hosts. Run gh auth login to authenticate.");
    }
    if (args[0] !== "pr") return fail(`fake forge: unsupported gh command ${args.join(" ")}`);

    const fields = (flag(args, "--json") ?? "").split(",").filter(Boolean);

    if (args[1] === "list") {
      const head = flag(args, "--head");
      const base = flag(args, "--base");
      const matches = f.prs.filter(
        (p) => p.state === "OPEN" && (!head || p.head === head) && (!base || p.base === base),
      );
      return ok(JSON.stringify(matches.map((p) => prJson(p, fields))));
    }

    if (args[1] === "create") {
      const head = flag(args, "--head") ?? "";
      const base = flag(args, "--base") ?? "dev";
      if (!f.branches.has(head)) {
        return fail(`pull request create failed: no branch '${head}' on the remote`);
      }
      if (f.prs.some((p) => p.head === head && p.state === "OPEN")) {
        return fail(`a pull request for branch '${head}' already exists`);
      }
      const pr: FakePr = {
        number: f.prs.length + 1,
        title: flag(args, "--title") ?? "",
        body: flag(args, "--body") ?? "",
        head,
        base,
        state: "OPEN",
      };
      f.prs.push(pr);
      return ok(`${REPO_URL}/pull/${pr.number}\n`);
    }

    const number = Number(args[2]);
    const pr = f.prs.find((p) => p.number === number);
    if (!pr) return fail(`no pull request found for number ${args[2]}`);

    if (args[1] === "edit") {
      const title = flag(args, "--title");
      const body = flag(args, "--body");
      if (title !== undefined) pr.title = title;
      if (body !== undefined) pr.body = body;
      return ok(`${REPO_URL}/pull/${pr.number}\n`);
    }

    if (args[1] === "view") return ok(JSON.stringify(prJson(pr, fields)));

    if (args[1] === "merge") {
      if (f.mergeError) return fail(f.mergeError);
      if (pr.state !== "OPEN") return fail(`Pull request #${pr.number} is already ${pr.state.toLowerCase()}`);
      const head = f.branches.get(pr.head);
      const base = f.branches.get(pr.base);
      if (!head || !base) return fail("Pull request is not mergeable");
      // GitHub refuses a head that isn't on top of the base; so does this.
      if (real(repo, ["merge-base", "--is-ancestor", base, head]).code !== 0) {
        return fail("Pull request is not mergeable: the base branch has moved");
      }
      const tree = real(repo, ["rev-parse", `${head}^{tree}`]);
      if (tree.code !== 0) return tree;
      const message = `Merge pull request #${pr.number} from ${pr.head}\n\n${pr.title}`;
      const commit = real(repo, ["commit-tree", "-p", base, "-p", head, "-m", message, tree.stdout.trim()]);
      if (commit.code !== 0) return commit;
      const merged = commit.stdout.trim();
      f.branches.set(pr.base, merged);
      pr.state = "MERGED";
      pr.mergeCommit = merged;
      return ok(`Merged pull request #${pr.number}\n`);
    }
    return fail(`fake forge: unsupported gh pr ${args[1]}`);
  };

  f.run = async (command, args, cwd) => {
    f.calls.push(`${command} ${args.join(" ")}`);
    if (command === "gh") return doGh(args);
    if (command !== "git") return fail(`fake forge: unexpected command ${command}`);
    if (args[0] === "fetch") return fetchIntoRepo();
    if (args[0] === "push") return doPush(args);
    if (args[0] === "remote") {
      return f.hasRemote ? ok(`${REPO_URL}.git\n`) : fail("error: No such remote 'origin'", 128);
    }
    return real(cwd || repo, args);
  };

  return f;
}
