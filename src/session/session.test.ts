import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { completionTurn, parseConfirm, runModelCommand, type ModelSwitch } from "./session.js";
import { DEFAULT_MODEL_ID, MODEL_ID_KEY, persistInstanceModel, type ModelOrigin } from "../config.js";
import { readEnvFile } from "../envfile.js";
import type { Job } from "./registry.js";

/**
 * End-to-end tests for the piped / non-TTY read loop (PlainIO).
 *
 * These spawn the real CLI and feed it a script on stdin, because the bug they
 * guard against only appears with a real piped stdin: the whole script arrives
 * in one chunk and readline emits every line at once. A unit test with a fake
 * stream would not reproduce it.
 *
 * Only slash-commands that never call the model are used, so these run with no
 * Bedrock credentials.
 */

const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = path.dirname(SRC);
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const ENTRY = path.join(SRC, "index.ts");

/**
 * Run the CLI with `input` on stdin under a throwaway CO_HOME.
 *
 * `env` adds to (or blanks out) the inherited environment. The model tests pass
 * `BEDROCK_MODEL_ID: ""` so a value exported in the developer's own shell can't
 * change what the test is looking at — config treats an empty value as unset.
 */
async function runCli(
  coHome: string,
  args: string[],
  input: string,
  env: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [ENTRY, ...args], {
      cwd: ROOT,
      env: { ...process.env, CO_HOME: coHome, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });

    // A hang is the failure mode we are testing for, so never wait forever.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI did not exit within 60s. Output so far:\n${out}`));
    }, 60_000);

    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", () => { clearTimeout(timer); resolve(out); });

    child.stdin.write(input);
    child.stdin.end();
  });
}

async function withInstance(fn: (coHome: string) => Promise<void>): Promise<void> {
  const coHome = await mkdtemp(path.join(os.tmpdir(), "co-session-test-"));
  try {
    await runCli(coHome, ["create", "t"], "");
    await fn(coHome);
  } finally {
    await rm(coHome, { recursive: true, force: true });
  }
}

test("a piped session runs every command, not just the first", async () => {
  await withInstance(async (coHome) => {
    const out = await runCli(
      coHome,
      ["t"],
      "/effort low\n/effort high\n/effort max\n/exit\n",
    );
    // Each command must have produced its own transition line, in order. The
    // first transition starts from the configured default (see loadConfig).
    assert.match(out, /effort: high → low/);
    assert.match(out, /effort: low → high/);
    assert.match(out, /effort: high → max/);
  });
});

test("a piped session ends cleanly at EOF with no trailing /exit", async () => {
  await withInstance(async (coHome) => {
    const out = await runCli(coHome, ["t"], "/effort low\n/effort\n");
    assert.match(out, /effort: high → low/);
    assert.match(out, /effort: low {2}\(levels:/);
    assert.match(out, /bye\./);
  });
});

test("empty stdin exits cleanly instead of hanging", async () => {
  await withInstance(async (coHome) => {
    const out = await runCli(coHome, ["t"], "");
    assert.match(out, /co-manager: t/);
  });
});

test("a final line with no trailing newline is still read", async () => {
  await withInstance(async (coHome) => {
    const out = await runCli(coHome, ["t"], "/effort low\n/effort high");
    assert.match(out, /effort: low → high/);
  });
});

test("parseConfirm reads the interlock verb, the lane word, and an optional agent override", () => {
  // Bare confirm → fire with the default agent (no override).
  assert.deepEqual(parseConfirm("confirm"), { isConfirm: true });
  // The verb is case-insensitive and tolerant of surrounding whitespace.
  assert.deepEqual(parseConfirm("  CONFIRM  "), { isConfirm: true });
  // `confirm <name>` selects that agent for this dispatch only.
  assert.deepEqual(parseConfirm("confirm ccw"), { isConfirm: true, agent: "ccw" });
  assert.deepEqual(parseConfirm("confirm cc"), { isConfirm: true, agent: "cc" });
  // Only the first token after the verb is the agent; trailing words are ignored.
  assert.deepEqual(parseConfirm("confirm cc please"), { isConfirm: true, agent: "cc" });

  // `write` is the word that buys a second WRITING lane in an occupied worktree
  // (D-20260729-5). It is part of the confirm verb, not a second question after
  // it, so the typed-confirm interlock is still exactly one keystroke away from
  // either outcome and neither one is a cancel-trap.
  assert.deepEqual(parseConfirm("confirm write"), { isConfirm: true, write: true });
  assert.deepEqual(parseConfirm("  CONFIRM  WRITE  "), { isConfirm: true, write: true });
  // The lane word and an agent override compose, in that order.
  assert.deepEqual(parseConfirm("confirm write ccw"), { isConfirm: true, write: true, agent: "ccw" });
  assert.deepEqual(parseConfirm("confirm write cc please"), {
    isConfirm: true,
    write: true,
    agent: "cc",
  });

  // Anything that isn't the confirm verb cancels — never a partial confirm.
  assert.deepEqual(parseConfirm("cancel"), { isConfirm: false });
  assert.deepEqual(parseConfirm("confirmation"), { isConfirm: false });
  assert.deepEqual(parseConfirm(""), { isConfirm: false });
  // Including the lane word on its own, and the two obvious near-misses. The
  // gate is worth nothing if a stray line can be read as half a confirm.
  assert.deepEqual(parseConfirm("write"), { isConfirm: false });
  assert.deepEqual(parseConfirm("write confirm"), { isConfirm: false });
  assert.deepEqual(parseConfirm("confirm-write"), { isConfirm: false });
});

/** A finished job, as the completion drain sees one. */
function finished(lane: Job["lane"], extra: Partial<Job> = {}): Job {
  return {
    id: "job-007",
    order: "do the thing",
    lane,
    label: "do the thing",
    transport: "ghostty",
    status: "done",
    captureFile: "/tmp/job-007.log",
    startedAt: 0,
    exitCode: 0,
    feature: "auth",
    ...extra,
  };
}

test("a writer's completion is a review to reach; a reader's is context to answer with", () => {
  const record = "diffstat: 3 files changed";
  const writer = completionTurn(finished("writer"), record, "the crew agent's own session transcript");
  // A run that produced work is reviewed, and the review is silent by default.
  assert.match(writer, /review it now for the captain/);
  assert.match(writer, /SAY NOTHING UNLESS IT IS VITAL/);
  assert.match(writer, /Otherwise say nothing at all and let the run pass/);
  assert.match(writer, /accept \/ fix-commit \/ rework/);
  assert.ok(writer.includes(record), "with the run's record attached");

  const reader = completionTurn(finished("reader", { readOnlyEnforced: true }), record, "the crew agent's final message");
  // The whole point: an audit never gets a verdict at all.
  assert.match(reader, /DO NOT REVIEW THIS RUN/);
  assert.ok(!reader.includes("SAY NOTHING UNLESS IT IS VITAL"), "the review instruction is gone, not merely softened");
  assert.match(reader, /do not give it a verdict/i);
  assert.match(reader, /CONTEXT FOR YOU TO ANSWER WITH/);
  assert.ok(reader.includes(record), "and the findings are still handed over whole");
});

test("an advisory-only audit says so in the turn, instead of claiming it was enforced", () => {
  const enforced = completionTurn(finished("reader", { readOnlyEnforced: true }), "found nothing", "src");
  assert.match(enforced, /write-capable tools were also denied at launch/);
  assert.match(enforced, /it produced no diff and changed nothing/);

  const advisory = completionTurn(finished("reader", { readOnlyEnforced: false }), "found nothing", "src");
  assert.match(advisory, /advisory only for this agent/);
  assert.match(
    advisory,
    /if the record shows it wrote anything, say so plainly/,
    "an unenforced lane is a thing the co has to actually check, not assume",
  );
  assert.match(advisory, /It was supposed to produce no diff/, "supposed to, not did");
});

// --- /model --------------------------------------------------------------------
//
// The command's decisions are unit-tested against injected halves (no Bedrock
// account, no session), and the persistence is then proved end to end against
// the real CLI below: a value written by the same function the command calls is
// in force in a FRESH process, and in that instance only.

function origin(over: Partial<ModelOrigin> = {}): ModelOrigin {
  return {
    modelId: DEFAULT_MODEL_ID,
    source: "default",
    where: "the built-in default",
    shadowed: [],
    ...over,
  };
}

interface Spy {
  probed: string[];
  persisted: string[];
  committed: string[];
  deps: ModelSwitch;
}

function spy(over: Partial<ModelSwitch> = {}): Spy {
  const probed: string[] = [];
  const persisted: string[] = [];
  const committed: string[] = [];
  return {
    probed,
    persisted,
    committed,
    deps: {
      current: DEFAULT_MODEL_ID,
      origin: origin(),
      probe: async (id) => {
        probed.push(id);
        return { ok: true };
      },
      persist: async (id) => {
        persisted.push(id);
        return "/co/instances/one/.env";
      },
      commit: (id) => {
        committed.push(id);
        return null;
      },
      ...over,
    },
  };
}

test("bare /model reports the model in force and where it came from", async () => {
  const s = spy({
    current: "us.anthropic.claude-sonnet-5",
    origin: origin({
      modelId: "us.anthropic.claude-sonnet-5",
      source: "instance",
      where: "/co/instances/one/.env",
      shadowed: [{ modelId: "us.anthropic.claude-opus-4-8", where: "/co/.env" }],
    }),
  });
  const out = (await runModelCommand("", s.deps)).join("\n");

  assert.match(out, /model: {2}us\.anthropic\.claude-sonnet-5/);
  assert.match(out, /source: this co-manager — \/co\/instances\/one\/\.env/);
  assert.match(out, /shadowing us\.anthropic\.claude-opus-4-8 in \/co\/\.env/);
  assert.deepEqual(s.probed, [], "reporting costs nothing and asks the API nothing");
  assert.deepEqual(s.persisted, []);
});

test("an exported BEDROCK_MODEL_ID wins, and /model refuses rather than splitting the answer", async () => {
  // Beating the variable for one session and losing to it at the next restart
  // would give "which model is this co-manager on" two answers depending on when
  // you asked — the exact confusion the command exists to end.
  const s = spy({
    current: "us.anthropic.claude-opus-4-8",
    origin: origin({
      modelId: "us.anthropic.claude-opus-4-8",
      source: "env",
      where: `${MODEL_ID_KEY} in the environment`,
    }),
  });
  const out = (await runModelCommand("us.anthropic.claude-sonnet-5", s.deps)).join("\n");

  assert.match(out, new RegExp(`${MODEL_ID_KEY} is set in your environment`));
  assert.match(out, /nothing was changed/);
  assert.match(out, /unset/, "and it names the way out");
  assert.deepEqual(s.probed, [], "no call is made for a switch that cannot happen");
  assert.deepEqual(s.persisted, []);
  assert.deepEqual(s.committed, []);
});

test("an id the API refuses leaves the previous model in force, with the API's own error", async () => {
  const s = spy({
    probe: async () => ({ ok: false, error: '404 {"message":"The provided model identifier is invalid."}' }),
  });
  const out = (await runModelCommand("us.anthropic.claude-nope", s.deps)).join("\n");

  assert.match(out, new RegExp(`staying on ${DEFAULT_MODEL_ID.replace(/\./g, "\\.")}`));
  assert.match(out, /The provided model identifier is invalid\./, "verbatim, not paraphrased");
  assert.deepEqual(s.persisted, [], "and nothing is written for a model that does not answer");
  assert.deepEqual(s.committed, []);
});

test("a model that answers is stored for this co-manager and switched from the next turn", async () => {
  const s = spy();
  const out = (await runModelCommand("us.anthropic.claude-sonnet-5", s.deps)).join("\n");

  assert.deepEqual(s.probed, ["us.anthropic.claude-sonnet-5"], "asked before committed");
  assert.deepEqual(s.persisted, ["us.anthropic.claude-sonnet-5"]);
  assert.deepEqual(s.committed, ["us.anthropic.claude-sonnet-5"]);
  assert.match(out, /→ us\.anthropic\.claude-sonnet-5 \(from the next turn\)/);
  assert.match(out, /stored for this co-manager in \/co\/instances\/one\/\.env/);
});

test("a switch that lowers effort says so instead of dropping it quietly", async () => {
  const s = spy({ commit: () => "effort xhigh → high: us.anthropic.claude-sonnet-4-6 does not accept xhigh" });
  const out = (await runModelCommand("us.anthropic.claude-sonnet-4-6", s.deps)).join("\n");
  assert.match(out, /effort xhigh → high/);
});

test("a switch that cannot be stored still applies, announced as this-session-only", async () => {
  const s = spy({
    persist: async () => {
      throw new Error("EACCES: permission denied");
    },
  });
  const out = (await runModelCommand("us.anthropic.claude-sonnet-5", s.deps)).join("\n");

  assert.deepEqual(s.committed, ["us.anthropic.claude-sonnet-5"], "the captain asked for it");
  assert.match(out, /this session only/, "but it must not look permanent");
  assert.match(out, /EACCES: permission denied/);
});

test("re-setting the model already in force pins it without asking the API again", async () => {
  const s = spy();
  const out = (await runModelCommand(DEFAULT_MODEL_ID, s.deps)).join("\n");
  assert.deepEqual(s.probed, [], "it is answering turns already");
  assert.deepEqual(s.persisted, [DEFAULT_MODEL_ID], "and pinning it is the point of typing it");
  assert.match(out, /already in force/);
});

test("a model id that could not survive a KEY=VALUE line is refused before anything happens", async () => {
  const s = spy();
  const out = (await runModelCommand("two words", s.deps)).join("\n");
  assert.match(out, /usage: \/model <bedrock model id>/);
  assert.deepEqual(s.probed, []);
  assert.deepEqual(s.persisted, []);
});

const ESCAPED_DEFAULT = DEFAULT_MODEL_ID.replace(/\./g, "\\.");

test("a model set for one co-manager is in force after a restart, and only there", async () => {
  const coHome = await mkdtemp(path.join(os.tmpdir(), "co-model-test-"));
  try {
    await runCli(coHome, ["create", "a"], "");
    await runCli(coHome, ["create", "b"], "");
    // Written by the same function the command calls, then read back by a FRESH
    // process through the loader every session uses.
    await persistInstanceModel(
      path.join(coHome, "instances", "a"),
      "us.anthropic.claude-sonnet-4-6",
    );

    const a = await runCli(coHome, ["a"], "/model\n", { BEDROCK_MODEL_ID: "" });
    assert.match(a, /^model us\.anthropic\.claude-sonnet-4-6 · region/m, "in force for the session");
    assert.match(a, /model: {2}us\.anthropic\.claude-sonnet-4-6/);
    assert.match(a, /source: this co-manager/);

    const b = await runCli(coHome, ["b"], "/model\n", { BEDROCK_MODEL_ID: "" });
    assert.match(b, new RegExp(`model: {2}${ESCAPED_DEFAULT}`), "the sibling is untouched");
    assert.match(b, /source: the built-in default/);
  } finally {
    await rm(coHome, { recursive: true, force: true });
  }
});

test("an exported variable outranks the stored choice, and the session says which is winning", async () => {
  const coHome = await mkdtemp(path.join(os.tmpdir(), "co-model-test-"));
  try {
    await runCli(coHome, ["create", "a"], "");
    const root = path.join(coHome, "instances", "a");
    await persistInstanceModel(root, "us.anthropic.claude-sonnet-4-6");

    const out = await runCli(coHome, ["a"], "/model\n/model us.anthropic.claude-sonnet-5\n", {
      BEDROCK_MODEL_ID: "us.anthropic.claude-opus-4-8",
    });

    assert.match(out, /model: {2}us\.anthropic\.claude-opus-4-8/);
    assert.match(out, new RegExp(`source: ${MODEL_ID_KEY} in the environment`));
    assert.match(out, /shadowing us\.anthropic\.claude-sonnet-4-6/, "the stored choice is covered, not lost");
    assert.match(out, /nothing was changed/);
    assert.equal(
      readEnvFile(path.join(root, ".env"))[MODEL_ID_KEY],
      "us.anthropic.claude-sonnet-4-6",
      "and a refused set writes nothing",
    );
  } finally {
    await rm(coHome, { recursive: true, force: true });
  }
});

test("an id the API will not serve fails visibly and leaves the co-manager where it was", async () => {
  // The real CLI and the real client. With credentials the call is refused by
  // Bedrock; without them it fails in the credential chain. Either way the
  // command must surface what came back, change nothing, and store nothing.
  const coHome = await mkdtemp(path.join(os.tmpdir(), "co-model-test-"));
  try {
    await runCli(coHome, ["create", "a"], "");
    const out = await runCli(coHome, ["a"], "/model not-a-real-model\n/model\n", {
      BEDROCK_MODEL_ID: "",
    });

    assert.match(out, new RegExp(`not-a-real-model did not answer — staying on ${ESCAPED_DEFAULT}\\.`));
    assert.match(out, new RegExp(`model: {2}${ESCAPED_DEFAULT}`), "still the model in force");
    assert.match(out, /source: the built-in default/);
    assert.deepEqual(
      readEnvFile(path.join(coHome, "instances", "a", ".env")),
      {},
      "nothing was persisted",
    );
  } finally {
    await rm(coHome, { recursive: true, force: true });
  }
});
