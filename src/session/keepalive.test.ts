import { test } from "node:test";
import assert from "node:assert/strict";
import { startCacheKeepAlive, type KeepAliveSnapshot } from "./keepalive.js";
import { emptyUsage, type TokenUsage } from "../cost.js";

/**
 * The cache keep-alive.
 *
 * What actually has to hold: it probes while the captain is thinking, it NEVER
 * probes over the top of a turn, it gives up on an abandoned session rather than
 * refreshing a cache nobody will read, and no failure inside it can escape.
 *
 * Driven on short real intervals rather than mocked timers — the thing under test
 * is a self-rescheduling async timer, and faking the clock around an awaited
 * probe tests the fake more than the code.
 */

const TICK = 6;

function snap(): KeepAliveSnapshot {
  return { system: "sys", messages: [{ role: "user", content: "hi" }], tools: [] };
}

function usage(over: Partial<TokenUsage> = {}): TokenUsage {
  return { ...emptyUsage(), ...over };
}

/** Let `n` intervals elapse, with slack for the awaited probe inside each. */
function settle(n: number): Promise<void> {
  return new Promise((r) => setTimeout(r, TICK * n + TICK * 3));
}

test("probes fire on the interval and are metered", async () => {
  const recorded: TokenUsage[] = [];
  const ka = startCacheKeepAlive({
    intervalMs: TICK,
    maxConsecutive: 10,
    isBusy: () => false,
    snapshot: snap,
    refresh: async () => ({ usage: usage({ cacheRead: 25_000 }), ms: 1 }),
    record: async (u) => void recorded.push(u),
  });
  try {
    await settle(3);
    assert.ok(recorded.length >= 2, `expected repeated probes, got ${recorded.length}`);
    assert.equal(recorded[0]!.cacheRead, 25_000);
  } finally {
    ka.stop();
  }
});

test("it stands down after the consecutive cap rather than billing all night", async () => {
  let probes = 0;
  const ka = startCacheKeepAlive({
    intervalMs: TICK,
    maxConsecutive: 2,
    isBusy: () => false,
    snapshot: snap,
    refresh: async () => {
      probes += 1;
      return { usage: usage({ cacheRead: 1 }), ms: 1 };
    },
    record: async () => {},
  });
  try {
    await settle(8);
    // An abandoned terminal must stop costing money, not keep refreshing a
    // prefix no turn is ever going to read.
    assert.equal(probes, 2);
  } finally {
    ka.stop();
  }
});

test("a real turn resets the cap so a long session keeps its cache warm", async () => {
  let probes = 0;
  const ka = startCacheKeepAlive({
    intervalMs: TICK,
    maxConsecutive: 1,
    isBusy: () => false,
    snapshot: snap,
    refresh: async () => {
      probes += 1;
      return { usage: usage({ cacheRead: 1 }), ms: 1 };
    },
    record: async () => {},
  });
  try {
    await settle(3);
    assert.equal(probes, 1, "capped at one");
    ka.noteTurn();
    await settle(3);
    assert.equal(probes, 2, "the turn re-armed it");
  } finally {
    ka.stop();
  }
});

test("it never probes over the top of a turn", async () => {
  let probes = 0;
  let busy = true;
  const ka = startCacheKeepAlive({
    intervalMs: TICK,
    maxConsecutive: 10,
    isBusy: () => busy,
    snapshot: snap,
    refresh: async () => {
      probes += 1;
      return { usage: usage({ cacheRead: 1 }), ms: 1 };
    },
    record: async () => {},
  });
  try {
    await settle(4);
    // A probe issued mid-turn races the real request for the same entry and can
    // write where the turn meant to read.
    assert.equal(probes, 0);
    busy = false;
    await settle(3);
    assert.ok(probes > 0, "it resumes once the turn is done");
  } finally {
    ka.stop();
  }
});

test("nothing to keep warm yet is not a reason to give up", async () => {
  let probes = 0;
  let ready = false;
  const ka = startCacheKeepAlive({
    intervalMs: TICK,
    maxConsecutive: 2,
    isBusy: () => false,
    snapshot: () => (ready ? snap() : null),
    refresh: async () => {
      probes += 1;
      return { usage: usage({ cacheRead: 1 }), ms: 1 };
    },
    record: async () => {},
  });
  try {
    await settle(4);
    assert.equal(probes, 0, "no prefix, no probe");
    ready = true;
    await settle(3);
    // The skipped rounds must not have burned the consecutive budget.
    assert.ok(probes > 0, "it probes once there is a prefix");
  } finally {
    ka.stop();
  }
});

test("a probe that throws is swallowed and probing continues", async () => {
  let calls = 0;
  const ka = startCacheKeepAlive({
    intervalMs: TICK,
    maxConsecutive: 10,
    isBusy: () => false,
    snapshot: snap,
    refresh: async () => {
      calls += 1;
      throw new Error("bedrock said no");
    },
    record: async () => {},
  });
  try {
    await settle(3);
    // An optimisation behind a prompt must cost an unrefreshed cache and nothing
    // else — not an unhandled rejection, and not a dead timer.
    assert.ok(calls >= 2, `expected it to keep trying, got ${calls}`);
  } finally {
    ka.stop();
  }
});

test("a failing meter does not kill the keep-alive either", async () => {
  let calls = 0;
  const ka = startCacheKeepAlive({
    intervalMs: TICK,
    maxConsecutive: 10,
    isBusy: () => false,
    snapshot: snap,
    refresh: async () => {
      calls += 1;
      return { usage: usage({ cacheRead: 1 }), ms: 1 };
    },
    record: async () => {
      throw new Error("disk full");
    },
  });
  try {
    await settle(3);
    assert.ok(calls >= 2);
  } finally {
    ka.stop();
  }
});

test("stop is final and idempotent", async () => {
  let probes = 0;
  const ka = startCacheKeepAlive({
    intervalMs: TICK,
    maxConsecutive: 10,
    isBusy: () => false,
    snapshot: snap,
    refresh: async () => {
      probes += 1;
      return { usage: usage({ cacheRead: 1 }), ms: 1 };
    },
    record: async () => {},
  });
  ka.stop();
  ka.stop();
  await settle(3);
  assert.equal(probes, 0);
});

test("a probe already in flight when stop lands is not metered", async () => {
  const recorded: TokenUsage[] = [];
  let release: (() => void) | null = null;
  const ka = startCacheKeepAlive({
    intervalMs: TICK,
    maxConsecutive: 10,
    isBusy: () => false,
    snapshot: snap,
    refresh: () =>
      new Promise((resolve) => {
        release = () => resolve({ usage: usage({ cacheRead: 1 }), ms: 1 });
      }),
    record: async (u) => void recorded.push(u),
  });
  // Wait for the probe to be in flight, then tear down mid-request. The session
  // stops the keep-alive right before the exit distill, so this is the real
  // ordering, not a contrived one.
  await new Promise((r) => setTimeout(r, TICK * 3));
  assert.ok(release, "probe should be in flight");
  ka.stop();
  release!();
  await settle(2);
  assert.deepEqual(recorded, [], "a probe resolving after stop must not be recorded");
});
