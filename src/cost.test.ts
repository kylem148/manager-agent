import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { instancePaths, type InstancePaths } from "./paths.js";
import {
  addUsage,
  costOf,
  CostLedger,
  DAY_RETENTION,
  dayBefore,
  daysSpanned,
  emptyUsage,
  fmtDuration,
  fmtUsd,
  formatCostReport,
  formatFleetReport,
  localDay,
  normalizeModelId,
  ratesFor,
  sparkline,
  type TokenUsage,
} from "./cost.js";

/**
 * The spend meter.
 *
 * What actually has to hold: the rates are BEDROCK's (not Anthropic's cheaper
 * first-party list), all four token classes are priced rather than output alone,
 * the meter survives a restart, and a model with no rate on file degrades to
 * "tokens counted, cost unknown" instead of inventing a number.
 *
 * No model call, no terminal, no clock — dates and paths are injected.
 */

async function makeInstance(): Promise<{ paths: InstancePaths; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "co-cost-"));
  const paths = instancePaths(home, "inst");
  return { paths, cleanup: () => rm(home, { recursive: true, force: true }) };
}

function usage(over: Partial<TokenUsage> = {}): TokenUsage {
  return { ...emptyUsage(), ...over };
}

// --- rates --------------------------------------------------------------------

test("model ids resolve regardless of geo and provider prefix", () => {
  assert.equal(normalizeModelId("us.anthropic.claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(normalizeModelId("eu.anthropic.claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(normalizeModelId("anthropic.claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(normalizeModelId("claude-opus-4-8"), "claude-opus-4-8");

  // The id the app actually sends must price, prefix and all.
  assert.ok(ratesFor("us.anthropic.claude-opus-4-8"));
});

test("opus 4.8 carries the bedrock rate, not the first-party one", () => {
  const r = ratesFor("us.anthropic.claude-opus-4-8")!;
  // Anthropic's own API is $5/$25; Bedrock is $6/$30. Pricing this app off the
  // first-party table would understate every invoice by 20%.
  assert.equal(r.input, 6);
  assert.equal(r.output, 30);
  assert.equal(r.cacheWrite5m, 7.5);
  assert.equal(r.cacheWrite1h, 12);
  assert.equal(r.cacheRead, 0.6);
});

test("an unknown model has no rates rather than a guessed one", () => {
  assert.equal(ratesFor("us.anthropic.claude-something-9"), null);
});

test("opus 5 is priced, but flagged as derived rather than published", () => {
  // The model this app is actually pointed at. AWS publishes no Opus 5 row, but
  // Anthropic documents it as a drop-in at Opus 4.8's pricing and Bedrock
  // resells that tier at a flat 1.2x — so it is priced, and the report says the
  // rate is derived rather than passing an inference off as a quote.
  const r = ratesFor("us.anthropic.claude-opus-5")!;
  assert.ok(r, "the configured model must price, or the meter is useless");
  assert.equal(r.input, 6);
  assert.equal(r.output, 30);
  assert.equal(r.confirmed, false);

  assert.equal(ratesFor("us.anthropic.claude-opus-4-8")!.confirmed, true);
});

test("a derived rate is announced on the report's rate line", async () => {
  const ledger = CostLedger.ephemeral();
  await ledger.record("us.anthropic.claude-opus-5", usage({ output: 1_000 }));
  const text = plain(
    formatCostReport({ ledger, modelId: "us.anthropic.claude-opus-5", cacheTtl: "1h" }),
  );
  assert.match(text, /rate derived, not published by AWS/);
  assert.doesNotMatch(text, /no bedrock rate on file/, "it IS priced, just not quoted");
  assert.match(text, /\$0\.0300/, "1,000 output tokens at $30/Mtok");
});

test("launch pricing applies inside its window and lapses after", () => {
  const promo = ratesFor("us.anthropic.claude-sonnet-5", "2026-07-27")!;
  assert.equal(promo.input, 2);
  assert.equal(promo.output, 10);

  const onLastDay = ratesFor("us.anthropic.claude-sonnet-5", "2026-08-31")!;
  assert.equal(onLastDay.input, 2, "the through date is inclusive");

  const standard = ratesFor("us.anthropic.claude-sonnet-5", "2026-09-01")!;
  assert.equal(standard.input, 3);
  assert.equal(standard.output, 15);
});

// --- pricing ------------------------------------------------------------------

test("cost sums all four token classes, not just output", () => {
  const r = ratesFor("us.anthropic.claude-opus-4-8")!;
  const u = usage({ input: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 });
  // 6 + 12 (1h write) + 0.6 + 30
  assert.equal(costOf(u, r, "1h"), 48.6);
  // 6 + 7.5 (5m write) + 0.6 + 30
  assert.equal(costOf(u, r, "5m"), 44.1);
});

test("pricing output alone would understate a realistic turn badly", () => {
  const r = ratesFor("us.anthropic.claude-opus-4-8")!;
  // The shape of a warm turn in this app: tiny uncached input, a big cached
  // prefix read back, a modest reply.
  const turn = usage({ input: 200, cacheWrite: 0, cacheRead: 22_000, output: 900 });
  const total = costOf(turn, r, "1h");
  const outputOnly = (900 * r.output) / 1_000_000;
  assert.ok(total > outputOnly, "the prompt side is real money");
  assert.ok(
    total - outputOnly > 0.01,
    `prompt side was ${(total - outputOnly).toFixed(5)} — expected it to be material`,
  );
});

test("a cold turn costs far more than the same turn warm", () => {
  const r = ratesFor("us.anthropic.claude-opus-4-8")!;
  const cold = costOf(usage({ cacheWrite: 22_000, output: 900 }), r, "1h");
  const warm = costOf(usage({ cacheRead: 22_000, output: 900 }), r, "1h");
  assert.ok(cold > warm);
  // The write/read spread on the prefix is the 1h TTL's whole justification.
  assert.equal(
    Number(((cold - warm) * 1_000_000).toFixed(0)),
    22_000 * (r.cacheWrite1h - r.cacheRead),
  );
});

test("zero usage costs zero", () => {
  const r = ratesFor("us.anthropic.claude-opus-4-8")!;
  assert.equal(costOf(emptyUsage(), r, "1h"), 0);
});

test("sub-dollar spend keeps enough places to be readable", () => {
  assert.equal(fmtUsd(0), "$0.0000");
  assert.equal(fmtUsd(0.0123), "$0.0123");
  assert.equal(fmtUsd(12.3456), "$12.35");
});

// --- the ledger ---------------------------------------------------------------

test("usage adds class by class", () => {
  const a = usage({ input: 1, cacheWrite: 2, cacheRead: 3, output: 4 });
  const b = usage({ input: 10, cacheWrite: 20, cacheRead: 30, output: 40 });
  assert.deepEqual(addUsage(a, b), { input: 11, cacheWrite: 22, cacheRead: 33, output: 44 });
});

test("the ledger separates this session from all time", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const first = await CostLedger.load(paths, new Date("2026-07-01T00:00:00.000Z"));
    await first.record("us.anthropic.claude-opus-4-8", usage({ output: 100, cacheRead: 5_000 }));

    // A second process opens the same instance: it inherits the lifetime total
    // but starts a fresh session total.
    const second = await CostLedger.load(paths);
    assert.deepEqual(second.session(), {}, "a new session starts at zero");
    assert.equal(second.lifetime().models["us.anthropic.claude-opus-4-8"]!.output, 100);
    assert.equal(second.lifetime().since, "2026-07-01T00:00:00.000Z", "since survives");

    await second.record("us.anthropic.claude-opus-4-8", usage({ output: 40 }));
    assert.equal(second.session()["us.anthropic.claude-opus-4-8"]!.output, 40);
    assert.equal(second.lifetime().models["us.anthropic.claude-opus-4-8"]!.output, 140);
    assert.equal(second.lifetime().models["us.anthropic.claude-opus-4-8"]!.turns, 2);
  } finally {
    await cleanup();
  }
});

test("a turn that billed nothing is not counted as a turn", async () => {
  const ledger = CostLedger.ephemeral();
  await ledger.record("m", emptyUsage());
  assert.deepEqual(ledger.session(), {});
  assert.deepEqual(ledger.lifetime().models, {});
});

test("switching models keeps separate buckets so old tokens keep their price", async () => {
  const ledger = CostLedger.ephemeral();
  await ledger.record("us.anthropic.claude-opus-4-8", usage({ output: 1_000_000 }));
  await ledger.record("us.anthropic.claude-sonnet-5", usage({ output: 1_000_000 }));

  const models = ledger.lifetime().models;
  assert.equal(Object.keys(models).length, 2);

  // Priced per bucket: $30 of Opus output plus $10 of promo-priced Sonnet.
  const opus = costOf(models["us.anthropic.claude-opus-4-8"]!, ratesFor("us.anthropic.claude-opus-4-8")!, "1h");
  const sonnet = costOf(
    models["us.anthropic.claude-sonnet-5"]!,
    ratesFor("us.anthropic.claude-sonnet-5", "2026-07-27")!,
    "1h",
  );
  assert.equal(opus, 30);
  assert.equal(sonnet, 10);
});

test("the meter is written after every turn, not at exit", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    const ledger = await CostLedger.load(paths);
    await ledger.record("us.anthropic.claude-opus-4-8", usage({ output: 7 }));
    // No close, no exit — a kill here must not lose the record of money spent.
    const raw = JSON.parse(await readFile(paths.costLedger, "utf8"));
    assert.equal(raw.models["us.anthropic.claude-opus-4-8"].output, 7);
  } finally {
    await cleanup();
  }
});

test("a corrupt meter file is a fresh meter, never a failed session start", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    await mkdir(path.dirname(paths.costLedger), { recursive: true });
    await writeFile(paths.costLedger, "{ this is not json", "utf8");
    const ledger = await CostLedger.load(paths, new Date("2026-07-27T00:00:00.000Z"));
    assert.deepEqual(ledger.lifetime().models, {});
    assert.equal(ledger.lifetime().since, "2026-07-27T00:00:00.000Z");
  } finally {
    await cleanup();
  }
});

test("garbage fields in the meter file coerce to zero rather than NaN", async () => {
  const { paths, cleanup } = await makeInstance();
  try {
    await mkdir(path.dirname(paths.costLedger), { recursive: true });
    await writeFile(
      paths.costLedger,
      JSON.stringify({ version: 1, since: "2026-01-01T00:00:00.000Z", models: { m: { output: "lots", input: -5 } } }),
      "utf8",
    );
    const ledger = await CostLedger.load(paths);
    assert.deepEqual(ledger.lifetime().models.m, {
      input: 0,
      cacheWrite: 0,
      cacheRead: 0,
      output: 0,
      turns: 0,
      ms: 0,
    });
  } finally {
    await cleanup();
  }
});

// --- the report ---------------------------------------------------------------

function plain(lines: string[]): string {
  // Strip ANSI so assertions read on content, not colour.
  return lines.join("\n").replace(/\[[0-9;]*m/g, "");
}

test("the report leads with output tokens and a real cost", async () => {
  const ledger = CostLedger.ephemeral({ since: "2026-07-20T09:00:00.000Z" });
  await ledger.record(
    "us.anthropic.claude-opus-4-8",
    usage({ input: 1_000, cacheWrite: 10_000, cacheRead: 500_000, output: 20_000 }),
    { now: at("2026-07-27", 10) },
  );

  const text = plain(
    formatCostReport({
      ledger,
      modelId: "us.anthropic.claude-opus-4-8",
      cacheTtl: "1h",
      now: at("2026-07-27", 12),
    }),
  );

  assert.match(text, /20,000 out/, "output tokens are the headline");
  // 0.006 + 0.12 + 0.30 + 0.60 = $1.026
  assert.match(text, /\$1\.03/);
  assert.match(text, /session/);
  assert.match(text, /all time/);
  assert.match(text, /cache read 500,000/, "the prompt side is shown, since it is where the money goes");
  assert.match(text, /since 2026-07-20/);
});

test("an un-priced model reports tokens and says the cost is unknown", async () => {
  const ledger = CostLedger.ephemeral();
  await ledger.record("us.anthropic.claude-mystery-1", usage({ output: 5_000 }));

  const text = plain(
    formatCostReport({ ledger, modelId: "us.anthropic.claude-mystery-1", cacheTtl: "1h" }),
  );

  assert.match(text, /5,000 out/, "tokens are still counted");
  assert.match(text, /no bedrock rate on file/);
  assert.match(text, /\$0\.0000\+/, "the total is marked incomplete, not stated as zero");
  assert.match(text, /claude-mystery-1/);
});

test("a session with no turns yet reports zeroes without blowing up", () => {
  const text = plain(
    formatCostReport({
      ledger: CostLedger.ephemeral({ since: "2026-07-27T00:00:00.000Z" }),
      modelId: "us.anthropic.claude-opus-4-8",
      cacheTtl: "1h",
      now: at("2026-07-27", 12),
    }),
  );
  assert.match(text, /0 out/);
  assert.match(text, /\$0\.0000/);
  assert.match(text, /nothing metered yet/, "no turns means no misleading average");
});

// --- time ---------------------------------------------------------------------

/** A local-time Date on the given local day, so day bucketing is unambiguous. */
function at(day: string, hour = 12): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, m! - 1, d!, hour, 0, 0);
}

test("days are bucketed in the captain's timezone, not UTC", () => {
  // 6pm local on the 27th is already the 28th in UTC. A UTC-keyed meter would
  // file an evening's work under tomorrow and report "today: $0" at 6:01pm.
  const evening = at("2026-07-27", 18);
  assert.equal(localDay(evening), "2026-07-27");

  const earlyMorning = at("2026-07-27", 1);
  assert.equal(localDay(earlyMorning), "2026-07-27");
});

test("day arithmetic spans inclusively and steps backwards", () => {
  assert.equal(daysSpanned("2026-07-27", "2026-07-27"), 1, "one day of use is one day");
  assert.equal(daysSpanned("2026-07-20", "2026-07-27"), 8);
  assert.equal(daysSpanned("2026-02-26", "2026-03-02"), 5, "crosses a month boundary");
  assert.equal(dayBefore("2026-03-02", 5), "2026-02-25");
  assert.equal(dayBefore("2026-01-01", 1), "2025-12-31", "crosses a year boundary");
});

test("turns land in the day bucket they happened on", async () => {
  const ledger = CostLedger.ephemeral({ since: "2026-07-25T00:00:00.000Z" });
  await ledger.record("m", usage({ output: 10 }), { now: at("2026-07-25") });
  await ledger.record("m", usage({ output: 20 }), { now: at("2026-07-26") });
  await ledger.record("m", usage({ output: 5 }), { now: at("2026-07-26") });

  assert.equal(ledger.day("2026-07-25").m!.output, 10);
  assert.equal(ledger.day("2026-07-26").m!.output, 25);
  assert.equal(ledger.day("2026-07-26").m!.turns, 2);
  assert.deepEqual(ledger.day("2026-07-27"), {}, "a day with no turns is empty, not absent-crashing");
});

test("the day series is capped but all-time totals are not", async () => {
  const ledger = CostLedger.ephemeral({ since: "2020-01-01T00:00:00.000Z" });
  for (let i = 0; i < DAY_RETENTION + 10; i++) {
    const d = new Date(2024, 0, 1 + i);
    await ledger.record("us.anthropic.claude-opus-4-8", usage({ output: 100 }), { now: d });
  }
  const life = ledger.lifetime();
  assert.equal(Object.keys(life.days).length, DAY_RETENTION, "old days age out of the series");
  assert.equal(
    life.models["us.anthropic.claude-opus-4-8"]!.output,
    100 * (DAY_RETENTION + 10),
    "but the aggregate keeps every token",
  );
});

test("wall-clock is accumulated per turn", async () => {
  const ledger = CostLedger.ephemeral();
  await ledger.record("m", usage({ output: 1 }), { ms: 4_000, now: at("2026-07-27") });
  await ledger.record("m", usage({ output: 1 }), { ms: 6_500, now: at("2026-07-27") });
  assert.equal(ledger.lifetime().models.m!.ms, 10_500);
  assert.equal(ledger.day("2026-07-27").m!.ms, 10_500);
});

test("durations read at the coarsest useful unit", () => {
  assert.equal(fmtDuration(0), "0s");
  // Sub-second must not read as "0s": some time passed, and claiming none did
  // is the kind of small lie that makes a meter untrustworthy.
  assert.equal(fmtDuration(360), "<1s");
  assert.equal(fmtDuration(12_400), "12s");
  assert.equal(fmtDuration(252_000), "4m 12s");
  assert.equal(fmtDuration(13_680_000), "3h 48m");
});

test("the last-turn stamp is on the same clock as the day buckets", async () => {
  // 11pm local is already tomorrow in UTC. If "today" is the local day, the
  // last-turn stamp has to be local too, or the report shows two clocks.
  const ledger = CostLedger.ephemeral({ since: "2026-07-27T00:00:00.000Z" });
  await ledger.record("us.anthropic.claude-opus-4-8", usage({ output: 10 }), {
    now: at("2026-07-27", 23),
  });
  const text = plain(
    formatCostReport({
      ledger,
      modelId: "us.anthropic.claude-opus-4-8",
      cacheTtl: "1h",
      now: at("2026-07-27", 23),
    }),
  );
  assert.match(text, /last turn 2026-07-27 23:00/);
});

test("a sparkline distinguishes an idle day from a cheap one", () => {
  // Flattening "I didn't work" into a short bar is how an average starts lying.
  assert.equal(sparkline([0, 0, 0]), "···");
  const s = sparkline([0, 1, 10]);
  assert.equal(s[0], "·", "zero is a gap");
  assert.equal(s[2], "█", "the peak is full height");
  assert.notEqual(s[1], "·", "a small nonzero is still a bar");
  assert.equal(sparkline([]), "");
});

test("both daily averages are reported, because one of them always misleads", async () => {
  const ledger = CostLedger.ephemeral({ since: "2026-07-20T09:00:00.000Z" });
  // $30 of output on two active days, inside an 8-day calendar span.
  await ledger.record("us.anthropic.claude-opus-4-8", usage({ output: 500_000 }), {
    now: at("2026-07-21"),
  });
  await ledger.record("us.anthropic.claude-opus-4-8", usage({ output: 500_000 }), {
    now: at("2026-07-26"),
  });

  const text = plain(
    formatCostReport({
      ledger,
      modelId: "us.anthropic.claude-opus-4-8",
      cacheTtl: "1h",
      now: at("2026-07-27"),
    }),
  );

  assert.match(text, /\$15\.00 per active day \(2\)/, "$30 over 2 working days");
  assert.match(text, /\$3\.75 per calendar day \(8\)/, "$30 over the 8 days since first use");
});

test("today's row counts only today, and the 7-day window shows the shape", async () => {
  const ledger = CostLedger.ephemeral({ since: "2026-07-20T09:00:00.000Z" });
  await ledger.record("us.anthropic.claude-opus-4-8", usage({ output: 100_000 }), {
    now: at("2026-07-24"),
  });
  await ledger.record("us.anthropic.claude-opus-4-8", usage({ output: 33_333 }), {
    now: at("2026-07-27"),
  });

  const text = plain(
    formatCostReport({
      ledger,
      modelId: "us.anthropic.claude-opus-4-8",
      cacheTtl: "1h",
      now: at("2026-07-27", 15),
    }),
  );

  // 33,333 output tokens at $30/Mtok = $0.99999
  assert.match(text, /today {6}33,333 out\s+\$1\.00/, "today is today only, not all time");
  assert.match(text, /all time\s+133,333 out/);
  // The window is 07-21..07-27: idle, idle, idle, spend, idle, idle, spend.
  assert.match(text, /last 7d\s+···[^·]··[^·]\s+\$4\.00\s+\(07-21 → 07-27\)/);
});

test("a turn recorded today shows up under today even late in the evening", async () => {
  const ledger = CostLedger.ephemeral({ since: "2026-07-27T00:00:00.000Z" });
  await ledger.record("us.anthropic.claude-opus-4-8", usage({ output: 1_000 }), {
    now: at("2026-07-27", 23),
  });
  const text = plain(
    formatCostReport({
      ledger,
      modelId: "us.anthropic.claude-opus-4-8",
      cacheTtl: "1h",
      now: at("2026-07-27", 23),
    }),
  );
  assert.match(text, /today {6}1,000 out/);
});

// --- the fleet view (`co cost`) -----------------------------------------------

/** An instance whose meter already holds `output` tokens on `day`. */
async function fleetMember(name: string, day: string, output: number, ms = 0) {
  const ledger = CostLedger.ephemeral({ since: `${day}T09:00:00.000Z` });
  if (output > 0) {
    await ledger.record("us.anthropic.claude-opus-5", usage({ output }), { now: at(day), ms });
  }
  return { name, ledger };
}

test("the fleet view sums every instance, because the bedrock key is shared", async () => {
  // The whole reason `co cost` exists: three co-managers on one key produce one
  // invoice, and no per-instance /cost can show it.
  const entries = [
    await fleetMember("alpha", "2026-07-26", 100_000),
    await fleetMember("bravo", "2026-07-27", 200_000),
    await fleetMember("idle", "2026-07-27", 0),
  ];

  const text = plain(
    formatFleetReport({ entries, cacheTtl: "1h", home: "/home/co", now: at("2026-07-27") }),
  );

  assert.match(text, /cost across 3 co-managers/);
  // $3 + $6 of output at $30/Mtok.
  assert.match(text, /alpha\s+100,000\s+\$3\.00/);
  assert.match(text, /bravo\s+200,000\s+\$6\.00/);
  assert.match(text, /total\s+300,000\s+\$9\.00\s+2/, "totals tokens, dollars and turns");
});

test("the fleet view lists idle instances rather than hiding them", async () => {
  const entries = [
    await fleetMember("busy", "2026-07-27", 100_000),
    await fleetMember("never-used", "2026-07-27", 0),
  ];
  const text = plain(
    formatFleetReport({ entries, cacheTtl: "1h", home: "/home/co", now: at("2026-07-27") }),
  );
  assert.match(text, /never-used\s+0\s+\$0\.0000\s+0\s+—/, "zero spend is information");
});

test("the fleet view is ordered by spend so the culprit is on top", async () => {
  const entries = [
    await fleetMember("cheap", "2026-07-27", 1_000),
    await fleetMember("expensive", "2026-07-27", 900_000),
    await fleetMember("middling", "2026-07-27", 50_000),
  ];
  const lines = plain(
    formatFleetReport({ entries, cacheTtl: "1h", home: "/home/co", now: at("2026-07-27") }),
  ).split("\n");
  const order = lines
    .map((l) => ["expensive", "middling", "cheap"].find((n) => l.trimStart().startsWith(n)))
    .filter(Boolean);
  assert.deepEqual(order, ["expensive", "middling", "cheap"]);
});

test("fleet day averages merge the series across instances", async () => {
  // Two instances active on two different days: $3 each, 2 active days, and a
  // calendar span starting at the EARLIEST instance's first turn.
  const entries = [
    await fleetMember("alpha", "2026-07-25", 100_000),
    await fleetMember("bravo", "2026-07-27", 100_000),
  ];
  const text = plain(
    formatFleetReport({ entries, cacheTtl: "1h", home: "/home/co", now: at("2026-07-27") }),
  );
  assert.match(text, /\$3\.00 per active day \(2\)/);
  assert.match(text, /\$2\.00 per calendar day \(3\)/, "07-25 → 07-27 inclusive");
});

test("fleet wall-clock is summed across instances", async () => {
  const entries = [
    await fleetMember("alpha", "2026-07-27", 10, 60_000),
    await fleetMember("bravo", "2026-07-27", 10, 180_000),
  ];
  const text = plain(
    formatFleetReport({ entries, cacheTtl: "1h", home: "/home/co", now: at("2026-07-27") }),
  );
  assert.match(text, /model time 4m 0s all time/);
});

test("an empty home says so instead of rendering an empty table", () => {
  const text = plain(formatFleetReport({ entries: [], cacheTtl: "1h", home: "/home/co" }));
  assert.match(text, /no co-managers yet in \/home\/co/);
});

test("the fleet view flags a derived rate and never pads rows with trailing space", async () => {
  const entries = [await fleetMember("solo", "2026-07-27", 1_000)];
  const lines = formatFleetReport({
    entries,
    cacheTtl: "1h",
    home: "/home/co",
    now: at("2026-07-27"),
  });
  assert.match(plain(lines), /rate derived, not published by AWS/);
  for (const l of lines) {
    assert.equal(l, l.replace(/\s+$/, ""), `line has trailing whitespace: ${JSON.stringify(l)}`);
  }
});
