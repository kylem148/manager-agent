import fsp from "node:fs/promises";
import path from "node:path";
import type { InstancePaths } from "./paths.js";
import { serializeWrite } from "./memory/writequeue.js";
import { c } from "./ui.js";

/**
 * The meter: what every model turn cost, in tokens and in dollars.
 *
 * The design rule is that this is invisible. Nothing here prints during a
 * session, nothing warns, nothing nags — the captain should never be thinking
 * about spend while thinking about architecture. It accumulates silently and
 * surfaces in exactly one place, `/cost`, on demand.
 *
 * Two numbers matter and they are not the same number:
 *
 *  - OUTPUT TOKENS are what the captain asked to see, and they are the number a
 *    human can hold onto ("I've generated 200k tokens of thinking this month").
 *  - THE BILL is dominated by the prompt side, not output. This app re-sends a
 *    ~22k-token prefix on every round trip; even at the 0.1x cached rate that
 *    routinely outweighs the generated tokens. Pricing output alone would
 *    understate the real invoice by a wide margin, so cost is computed from all
 *    four token classes Bedrock bills separately (see Rates).
 *
 * So `/cost` leads with output tokens and reports a cost that is actually the
 * cost. Both are shown for this session and for the life of the instance.
 */

/** The four token classes Bedrock prices separately, as counted on one turn. */
export interface TokenUsage {
  /** Prompt tokens processed at full rate: everything after the last cache
   *  breakpoint. A SMALL number here is the good outcome, not a small prompt. */
  input: number;
  /** Prompt tokens written into the cache this turn, billed at a premium. */
  cacheWrite: number;
  /** Prompt tokens served from the cache, billed at a tenth of base. */
  cacheRead: number;
  /** Generated tokens. Includes thinking, which is billed even when not shown. */
  output: number;
}

export function emptyUsage(): TokenUsage {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
  };
}

export function isEmptyUsage(u: TokenUsage): boolean {
  return u.input === 0 && u.cacheWrite === 0 && u.cacheRead === 0 && u.output === 0;
}

/** US dollars per million tokens, per class. */
export interface Rates {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  /** False when AWS does not publish a row for this model and the rate is
   *  derived instead. /cost says so on the rate line rather than presenting an
   *  inference as a quote. */
  confirmed: boolean;
}

/**
 * Cache traffic is priced as fixed multiples of a model's base input rate, and
 * these three multiples are the best-established numbers in this file: Anthropic
 * publishes them as a table (5-minute write 1.25x, 1-hour write 2x, read 0.1x),
 * and Bedrock applies the same shape. Deriving from them means a new model needs
 * only its input/output pair.
 *
 * The 20:1 ratio between the 1-hour write and the read is the single fact that
 * drives most of this app's cost design: re-reading cached bytes costs a
 * twentieth of rewriting them, which is why the cache keep-alive exists and why
 * history compaction has to be rare to pay for itself.
 */
const WRITE_5M_MULTIPLE = 1.25;
const WRITE_1H_MULTIPLE = 2;
const READ_MULTIPLE = 0.1;

/** Derived rates are rounded because binary floats don't do this cleanly:
 *  6 * 0.1 is 0.6000000000000001, and that artifact would otherwise be printed
 *  verbatim in the /cost rate line. Published rates never need more places. */
function money(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function rates(input: number, output: number, confirmed = true): Rates {
  return {
    input,
    output,
    cacheWrite5m: money(input * WRITE_5M_MULTIPLE),
    cacheWrite1h: money(input * WRITE_1H_MULTIPLE),
    cacheRead: money(input * READ_MULTIPLE),
    confirmed,
  };
}

interface RateEntry {
  rates: Rates;
  /** Launch pricing that supersedes `rates` through this date (inclusive, ISO
   *  yyyy-mm-dd). Encoded rather than ignored: a meter that quietly bills the
   *  post-promo rate is wrong by the size of the discount. */
  promo?: { rates: Rates; through: string };
}

/**
 * Bedrock rates for the GLOBAL endpoint. A geo-scoped profile adds GEO_PREMIUM
 * on top (see below), which is where the `us.` prefix this app ships with lands.
 *
 * Keyed by the id with its geo and provider prefixes stripped (see
 * normalizeModelId), so `us.`, `global.` and a bare id share one entry.
 *
 * EVERY OPUS-TIER RATE HERE IS DERIVED AND FLAGGED AS SUCH, because AWS does not
 * publish a row this app could transcribe. What the evidence actually says, read
 * 2026-07-29:
 *
 *  - Anthropic prices Opus 5 and Opus 4.8 at $5/$25 first-party, and states that
 *    Bedrock pricing matches the direct API in standard regions.
 *  - Independent trackers list Bedrock Opus 5 at $5/$25 global and $5.50/$27.50
 *    regional, with cache classes at exactly 1.1x. That the two differ by
 *    precisely the documented regional premium is the strongest check available.
 *  - AWS's own pricing page renders no Opus 5 row at all, and the $6.00 figure
 *    this table used to carry is consistent with a RETIRED model's Extended
 *    Access row (Claude 3.5 Sonnet shows $6/$30 against a $3/$15 first-party
 *    price — 2x, not the 1.2x a flat resale markup would imply).
 *
 * So: priced, because a meter that reports nothing for the model in use is worse
 * than a well-founded estimate that announces itself — and flagged, because the
 * only authoritative figure is the invoice. Reconcile against the Bedrock bill
 * and replace these the moment AWS publishes a row.
 *
 * A model that is not in here is not a failure: /cost still reports its tokens
 * and says plainly it has no rate on file. Adding one is a single line.
 */
const BEDROCK_RATES: Record<string, RateEntry> = {
  "claude-opus-5": { rates: rates(5, 25, /*confirmed*/ false) },
  "claude-opus-4-8": { rates: rates(5, 25, /*confirmed*/ false) },
  "claude-sonnet-5": {
    rates: rates(3, 15, /*confirmed*/ false),
    promo: { rates: rates(2, 10, /*confirmed*/ false), through: "2026-08-31" },
  },
};

/**
 * The premium a geo-scoped inference profile carries over the global one.
 *
 * Anthropic documents this plainly for Bedrock: "Regional endpoints carry a 10%
 * pricing premium over global endpoints", scoped to Opus 4.5, Sonnet 4.5, Haiku
 * 4.5 "and all future models". It applies to every token class, not just input.
 *
 * This is the most actionable number in the file. `us.anthropic.claude-opus-5`
 * and `global.anthropic.claude-opus-5` are the same model; the prefix is a
 * data-residency choice, and choosing US-and-Canada residency costs 10% of the
 * entire bill. Modelled here so /cost shows the difference rather than hiding it
 * behind a single blended rate — otherwise there is no way to see what the
 * choice costs, and it is one environment variable.
 */
const GEO_PREMIUM = 1.1;

/** True for a geo-scoped inference profile (`us.`, `eu.`, `au.`, …) as opposed
 *  to `global.` or a bare model id. */
export function isGeoScoped(modelId: string): boolean {
  return /^(us|eu|apac|au|jp)\./.test(modelId.toLowerCase());
}

function withGeoPremium(r: Rates): Rates {
  return {
    input: money(r.input * GEO_PREMIUM),
    output: money(r.output * GEO_PREMIUM),
    cacheWrite5m: money(r.cacheWrite5m * GEO_PREMIUM),
    cacheWrite1h: money(r.cacheWrite1h * GEO_PREMIUM),
    cacheRead: money(r.cacheRead * GEO_PREMIUM),
    confirmed: r.confirmed,
  };
}

/** Strip the inference-profile geo prefix and the provider prefix. */
export function normalizeModelId(modelId: string): string {
  return modelId
    .toLowerCase()
    .replace(/^(us|eu|apac|global)\./, "")
    .replace(/^anthropic\./, "");
}

/** Bedrock rates for a model id, or null when none are on file. `today` is
 *  injected (ISO yyyy-mm-dd) so promo-window behaviour is testable. */
export function ratesFor(
  modelId: string,
  today = new Date().toISOString().slice(0, 10),
): Rates | null {
  const entry = BEDROCK_RATES[normalizeModelId(modelId)];
  if (!entry) return null;
  const base = entry.promo && today <= entry.promo.through ? entry.promo.rates : entry.rates;
  // The prefix is not decoration: it decides the bill by 10% (see GEO_PREMIUM).
  return isGeoScoped(modelId) ? withGeoPremium(base) : base;
}

/**
 * What one bundle of usage cost, in dollars.
 *
 * `cacheTtl` picks the write rate, and it is a parameter rather than a constant
 * because the TTL is a live decision in model.ts (currently 1h, worth a 2x write
 * premium to survive a captain's thinking pause). If that flips back to the
 * 5-minute default, the meter follows it instead of silently over-billing.
 */
export function costOf(usage: TokenUsage, r: Rates, cacheTtl: "5m" | "1h"): number {
  const write = cacheTtl === "1h" ? r.cacheWrite1h : r.cacheWrite5m;
  return (
    (usage.input * r.input +
      usage.cacheWrite * write +
      usage.cacheRead * r.cacheRead +
      usage.output * r.output) /
    1_000_000
  );
}

// --- time ---------------------------------------------------------------------

/**
 * The calendar day a turn belongs to, in the CAPTAIN's timezone, not UTC.
 *
 * This is load-bearing rather than cosmetic. A session at 6pm Pacific is already
 * tomorrow in UTC, so a UTC-keyed meter would file an evening's work under the
 * next day and report "today: $0.00" to someone who has been working since
 * breakfast. A daily figure is only useful if the day is the one the captain is
 * living in.
 */
export function localDay(when: Date): string {
  const y = when.getFullYear();
  const m = String(when.getMonth() + 1).padStart(2, "0");
  const d = String(when.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Whole days from `a` to `b` inclusive of both ends, on yyyy-mm-dd keys. */
export function daysSpanned(a: string, b: string): number {
  const start = Date.parse(`${a}T00:00:00Z`);
  const end = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 1;
  return Math.round((end - start) / 86_400_000) + 1;
}

/** The day `n` days before `day` (yyyy-mm-dd in, yyyy-mm-dd out). */
export function dayBefore(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  return new Date(t - n * 86_400_000).toISOString().slice(0, 10);
}

// --- the durable ledger -------------------------------------------------------

/**
 * Per-model running totals. Two non-token counters ride along:
 *
 *  - `turns`, so an average per turn is available;
 *  - `ms`, the wall-clock the captain actually spent waiting on the model. That
 *    is the other thing "how much has this cost me" can mean, and it is free to
 *    collect — runTurn already times itself for the debug line.
 */
export interface ModelTotals extends TokenUsage {
  turns: number;
  ms: number;
  /**
   * Model calls, not turns. A tool-using turn makes several rounds and re-sends
   * the whole prompt on each one, so rounds-per-turn is the multiplier on the
   * entire input side of the bill. Without it, "cache read per turn" is a number
   * you cannot act on: 200k over two rounds is a 100k prompt, over five rounds
   * it is a 40k prompt, and those call for opposite fixes.
   */
  rounds: number;
  /**
   * Cache-write tokens billed on the opening round of each turn — the cost of
   * the cache having lapsed between turns. See ModelProvider.pendingRebuild.
   * Near-zero means the cache is surviving the captain's thinking pauses; large
   * means the prefix is being rebuilt at the 2x write rate instead of read at
   * 0.1x, which is the single most expensive avoidable thing this app can do.
   */
  rebuild: number;
  /**
   * Wall-clock the captain spent NOT waiting on the model: the gap between one
   * turn finishing and the next starting, summed. Recorded because the cache TTL
   * is a bet on the length of these gaps — a co-manager is a thinking partner,
   * so they are long by design, and their distribution is what decides whether
   * the 5-minute or 1-hour entry is the right one to be paying for.
   */
  idleMs: number;
  /**
   * Cache-refresh probes sent (see ModelProvider.refreshCache). Counted apart
   * from `turns` because a probe is not a turn: it answers nothing, and folding
   * it in would quietly halve the per-turn averages while the captain's actual
   * turns stayed the same. Its TOKENS are folded into the usage totals, though —
   * it is real spend, and a keep-alive that cost more than the rebuilds it
   * prevented has to be visible as such or there is no way to tell.
   */
  keepAlives: number;
}

/** A day's spend, still split per model so it can be priced correctly. */
export type DayTotals = Record<string, ModelTotals>;

export interface LedgerData {
  version: 1;
  /** ISO timestamp of the first turn ever metered for this instance. */
  since: string;
  /** ISO timestamp of the most recent metered turn. */
  last: string;
  /** All-time, keyed by the model id exactly as configured, so a switch between
   *  models keeps two honest buckets rather than pricing old tokens at a new
   *  rate. Never trimmed — this is the aggregate of record. */
  models: Record<string, ModelTotals>;
  /** The time series: local calendar day -> model -> totals. Rolling, capped at
   *  DAY_RETENTION. Trimming a day never touches `models`, so the all-time
   *  numbers stay exact even after the daily detail behind them ages out. */
  days: Record<string, DayTotals>;
}

/**
 * How many days of per-day detail to keep. Over a year of history, a few tens
 * of KB, and enough for any "what did this month cost" question. Older days
 * age out of the series but stay counted in `models`.
 */
export const DAY_RETENTION = 400;

function emptyTotals(): ModelTotals {
  return { ...emptyUsage(), turns: 0, ms: 0, rounds: 0, rebuild: 0, idleMs: 0, keepAlives: 0 };
}

/** Sum two buckets, tokens and counters alike. One place to change when a
 *  counter is added, so a new field cannot be summed in one roll-up and
 *  silently dropped in the other. */
function addTotals(a: ModelTotals, b: ModelTotals): ModelTotals {
  return {
    ...addUsage(a, b),
    turns: a.turns + b.turns,
    ms: a.ms + b.ms,
    rounds: a.rounds + b.rounds,
    rebuild: a.rebuild + b.rebuild,
    idleMs: a.idleMs + b.idleMs,
    keepAlives: a.keepAlives + b.keepAlives,
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

function coerceTotals(v: unknown): ModelTotals | null {
  if (!v || typeof v !== "object") return null;
  const t = v as Record<string, unknown>;
  return {
    input: num(t.input),
    cacheWrite: num(t.cacheWrite),
    cacheRead: num(t.cacheRead),
    output: num(t.output),
    turns: num(t.turns),
    ms: num(t.ms),
    // Absent in ledgers written before these counters existed. Zero-filled
    // rather than back-filled: a rounds figure we never measured would make the
    // per-turn averages read as though early sessions ran at one round each,
    // which is exactly the wrong conclusion. `/cost` suppresses the line until
    // there is real data behind it.
    rounds: num(t.rounds),
    rebuild: num(t.rebuild),
    idleMs: num(t.idleMs),
    keepAlives: num(t.keepAlives),
  };
}

/**
 * Tolerant read: any shape we don't recognise degrades to zeros, never throws.
 *
 * Also the upgrade path. A ledger written before the time series existed has no
 * `days` and no `last`; it loads with its all-time totals intact and an empty
 * series, so per-day figures simply start from the upgrade rather than being
 * back-filled with numbers we cannot know.
 */
function coerce(raw: unknown, fallback: string): LedgerData {
  const data: LedgerData = { version: 1, since: fallback, last: fallback, models: {}, days: {} };
  if (!raw || typeof raw !== "object") return data;
  const o = raw as Record<string, unknown>;
  if (typeof o.since === "string" && o.since !== "") data.since = o.since;
  data.last = typeof o.last === "string" && o.last !== "" ? o.last : data.since;

  if (o.models && typeof o.models === "object") {
    for (const [id, v] of Object.entries(o.models as Record<string, unknown>)) {
      const t = coerceTotals(v);
      if (t) data.models[id] = t;
    }
  }
  if (o.days && typeof o.days === "object") {
    for (const [day, byModel] of Object.entries(o.days as Record<string, unknown>)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !byModel || typeof byModel !== "object") continue;
      const bucket: DayTotals = {};
      for (const [id, v] of Object.entries(byModel as Record<string, unknown>)) {
        const t = coerceTotals(v);
        if (t) bucket[id] = t;
      }
      if (Object.keys(bucket).length > 0) data.days[day] = bucket;
    }
  }
  return data;
}

/** Drop the oldest days past the retention cap. Mutates in place. */
function trimDays(days: Record<string, DayTotals>, cap = DAY_RETENTION): void {
  const keys = Object.keys(days).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - cap))) delete days[k];
}

/**
 * The instance's spend, split into what this session did and what the instance
 * has done since it was created.
 *
 * Persisted after every turn rather than at exit, for the same reason the
 * transcript is: a Ctrl-C, a kill, or a pulled cord must not lose the record of
 * money that has already been spent. The file is a few hundred bytes and the
 * write rides the shared serialized lane, so the cost of doing it per turn is
 * nothing next to the model round trip that just happened.
 */
export class CostLedger {
  private data: LedgerData;
  private sessionTotals: Record<string, ModelTotals> = {};

  private constructor(
    private readonly filePath: string,
    data: LedgerData,
  ) {
    this.data = data;
  }

  /** A missing file is a fresh meter; a corrupt one is ALSO a fresh meter rather
   *  than a failed session start — a broken counter must never stop the co. */
  static async load(paths: InstancePaths, now = new Date()): Promise<CostLedger> {
    const file = paths.costLedger;
    const iso = now.toISOString();
    try {
      const raw = await fsp.readFile(file, "utf8");
      return new CostLedger(file, coerce(JSON.parse(raw), iso));
    } catch {
      return new CostLedger(file, { version: 1, since: iso, last: iso, models: {}, days: {} });
    }
  }

  /** In-memory meter with no file behind it, for tests and degraded paths. */
  static ephemeral(data?: Partial<LedgerData>): CostLedger {
    const since = data?.since ?? "1970-01-01T00:00:00.000Z";
    return new CostLedger("", {
      version: 1,
      since,
      last: data?.last ?? since,
      models: data?.models ?? {},
      days: data?.days ?? {},
    });
  }

  /** The instance-lifetime record, including the per-day series. */
  lifetime(): LedgerData {
    return { ...this.data, models: { ...this.data.models }, days: { ...this.data.days } };
  }

  /** What this process has spent since it started. */
  session(): Record<string, ModelTotals> {
    return { ...this.sessionTotals };
  }

  /** One day's spend by model, or an empty bucket for a day with no turns. */
  day(key: string): DayTotals {
    return { ...(this.data.days[key] ?? {}) };
  }

  /**
   * Fold one turn in and persist. A turn that billed nothing (a slash command, a
   * turn that threw before the first round landed) is dropped rather than
   * counted, so the per-turn average stays meaningful.
   *
   * `ms` is the wall-clock the turn took; `now` decides which calendar day it
   * lands in. Both are injected so the whole time series is testable without a
   * clock.
   */
  async record(
    modelId: string,
    usage: TokenUsage,
    opts: {
      ms?: number;
      now?: Date;
      /** Model calls this turn made (see ModelTotals.rounds). */
      rounds?: number;
      /** Cache-write tokens on the turn's opening round (see ModelTotals.rebuild). */
      rebuild?: number;
      /** Idle gap before this turn started (see ModelTotals.idleMs). */
      idleMs?: number;
    } = {},
  ): Promise<void> {
    if (isEmptyUsage(usage)) return;
    const now = opts.now ?? new Date();
    const ms = Math.max(0, Math.round(opts.ms ?? 0));
    // A turn that billed tokens made at least one round, whatever the caller
    // passed: the counters are diagnostics and must never contradict the meter.
    const rounds = Math.max(1, Math.round(opts.rounds ?? 1));
    const rebuild = Math.max(0, Math.round(opts.rebuild ?? 0));
    const idleMs = Math.max(0, Math.round(opts.idleMs ?? 0));

    const bump = (into: Record<string, ModelTotals>) => {
      const prev = into[modelId] ?? emptyTotals();
      into[modelId] = {
        ...addUsage(prev, usage),
        turns: prev.turns + 1,
        ms: prev.ms + ms,
        rounds: prev.rounds + rounds,
        rebuild: prev.rebuild + rebuild,
        idleMs: prev.idleMs + idleMs,
        keepAlives: prev.keepAlives,
      };
    };
    bump(this.sessionTotals);
    bump(this.data.models);

    const key = localDay(now);
    const bucket = (this.data.days[key] ??= {});
    bump(bucket);
    trimDays(this.data.days);

    this.data.last = now.toISOString();
    if (this.data.since === "") this.data.since = this.data.last;

    if (this.filePath === "") return;
    await this.persist();
  }

  /**
   * Fold in one cache-refresh probe (see ModelProvider.refreshCache).
   *
   * Separate from `record` because a probe is spend without being a turn. Its
   * tokens belong in every dollar figure the report prints — it is billed like
   * anything else — but counting it as a turn would understate cost-per-turn and
   * dilute the rounds average, which are the two numbers the keep-alive is meant
   * to be judged by. So: usage yes, turn no, and its own counter so the trade can
   * actually be audited.
   */
  async recordKeepAlive(
    modelId: string,
    usage: TokenUsage,
    opts: { ms?: number; now?: Date } = {},
  ): Promise<void> {
    if (isEmptyUsage(usage)) return;
    const now = opts.now ?? new Date();
    const ms = Math.max(0, Math.round(opts.ms ?? 0));

    const bump = (into: Record<string, ModelTotals>) => {
      const prev = into[modelId] ?? emptyTotals();
      into[modelId] = {
        ...addUsage(prev, usage),
        turns: prev.turns,
        ms: prev.ms + ms,
        rounds: prev.rounds,
        rebuild: prev.rebuild,
        idleMs: prev.idleMs,
        keepAlives: prev.keepAlives + 1,
      };
    };
    bump(this.sessionTotals);
    bump(this.data.models);
    const key = localDay(now);
    bump((this.data.days[key] ??= {}));
    trimDays(this.data.days);

    this.data.last = now.toISOString();
    if (this.filePath === "") return;
    await this.persist();
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2) + "\n";
    await serializeWrite(async () => {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      await fsp.writeFile(this.filePath, snapshot, "utf8");
    });
  }
}


// --- rendering ----------------------------------------------------------------

function fmtTokens(n: number): string {
  return n.toLocaleString("en-US");
}

/** Sub-dollar spend needs more places than an invoice does, or a real session
 *  of work rounds to "$0.00" and the meter looks broken. */
export function fmtUsd(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

/** Wall-clock, at the coarsest unit that still says something: "3h 48m", "12s".
 *  Sub-second reads as "<1s" rather than "0s", which would claim no time passed
 *  when some did. */
export function fmtDuration(ms: number): string {
  if (ms <= 0) return "0s";
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "2026-07-27 14:32" in the captain's timezone — matching the day buckets,
 *  which are local too. Rendering this one stamp in UTC while "today" means the
 *  local day would put two different clocks in the same report. */
function fmtLocalStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${localDay(d)} ${hh}:${mm}`;
}

/** Everything /cost needs about one bundle of per-model totals, priced. */
interface Summary {
  output: number;
  cost: number;
  turns: number;
  ms: number;
  tokens: TokenUsage;
  /** Models with tokens but no rate on file — their spend is NOT in `cost`. */
  unpriced: string[];
  rounds: number;
  rebuild: number;
  idleMs: number;
  keepAlives: number;
  /** What the `rebuild` tokens cost, priced at each model's own write rate.
   *  Computed here rather than in the renderer because only this loop knows
   *  which model each bucket belongs to. */
  rebuildCost: number;
}

function summarize(
  totals: Record<string, ModelTotals>,
  cacheTtl: "5m" | "1h",
  today?: string,
): Summary {
  const s: Summary = {
    output: 0,
    cost: 0,
    turns: 0,
    ms: 0,
    tokens: emptyUsage(),
    unpriced: [],
    rounds: 0,
    rebuild: 0,
    idleMs: 0,
    keepAlives: 0,
    rebuildCost: 0,
  };
  for (const [modelId, t] of Object.entries(totals)) {
    s.output += t.output;
    s.turns += t.turns;
    s.ms += t.ms;
    s.rounds += t.rounds;
    s.rebuild += t.rebuild;
    s.idleMs += t.idleMs;
    s.keepAlives += t.keepAlives;
    s.tokens = addUsage(s.tokens, t);
    const r = ratesFor(modelId, today);
    if (r) {
      s.cost += costOf(t, r, cacheTtl);
      const write = cacheTtl === "1h" ? r.cacheWrite1h : r.cacheWrite5m;
      s.rebuildCost += (t.rebuild * write) / 1_000_000;
    } else if (t.output > 0) s.unpriced.push(modelId);
  }
  return s;
}

/** A scope row: output tokens (the headline), then the money, then the turns. */
function scopeRow(label: string, s: Summary): string {
  const money = s.unpriced.length > 0 ? `${fmtUsd(s.cost)}+` : fmtUsd(s.cost);
  return (
    `  ${label.padEnd(10)} ${(fmtTokens(s.output) + " out").padEnd(18)} ` +
    `${money.padEnd(11)} ${c.dim(`${fmtTokens(s.turns)} turn(s)`)}`
  );
}

const BARS = "▁▂▃▄▅▆▇█";

/**
 * A sparkline over the given daily costs. A day with no turns is a gap (·)
 * rather than a short bar, because "I didn't work" and "I worked cheaply" are
 * different facts and flattening them is how an average starts lying.
 */
export function sparkline(values: number[]): string {
  const peak = Math.max(...values, 0);
  if (peak <= 0) return values.map(() => "·").join("");
  return values
    .map((v) => {
      if (v <= 0) return "·";
      const i = Math.ceil((v / peak) * (BARS.length - 1));
      return BARS[Math.min(BARS.length - 1, Math.max(0, i))];
    })
    .join("");
}

/**
 * The `/cost` report. Returns lines rather than printing so the whole thing is
 * provable without a terminal.
 *
 * Three scopes (session / today / all time), then the time dimension, then the
 * breakdown that explains where the money actually went. Longer than the first
 * cut, but /cost is on-demand and a spend report that can't answer "is this
 * getting worse?" isn't worth opening.
 */
export function formatCostReport(opts: {
  ledger: CostLedger;
  modelId: string;
  cacheTtl: "5m" | "1h";
  /** Injected so the whole report is testable without a clock. */
  now?: Date;
}): string[] {
  const { ledger, modelId, cacheTtl } = opts;
  const now = opts.now ?? new Date();
  const today = localDay(now);
  const life = ledger.lifetime();

  const session = summarize(ledger.session(), cacheTtl, today);
  const allTime = summarize(life.models, cacheTtl, today);
  const todaySum = summarize(ledger.day(today), cacheTtl, today);

  const out: string[] = [
    "",
    c.bold("cost"),
    scopeRow("session", session),
    scopeRow("today", todaySum),
    scopeRow("all time", allTime),
    "",
  ];

  // --- the time dimension ---
  //
  // Two averages, because they answer different questions and one of them is
  // always the misleading one. Per ACTIVE day is "what does a working day cost
  // me"; per CALENDAR day is "what is this costing me to run". An instance used
  // hard on two days out of thirty has a very different number for each, and
  // showing only one invites the wrong conclusion.
  const firstDay = localDay(new Date(life.since));
  const calendarDays = daysSpanned(firstDay, today);
  const dayCosts = new Map<string, number>();
  for (const [day, byModel] of Object.entries(life.days)) {
    dayCosts.set(day, summarize(byModel, cacheTtl, day).cost);
  }
  const activeDays = [...dayCosts.values()].filter((v) => v > 0).length;

  if (allTime.turns === 0) {
    out.push(c.dim("  per day    nothing metered yet"));
  } else {
    const perActive = activeDays > 0 ? allTime.cost / activeDays : 0;
    const perCalendar = allTime.cost / Math.max(1, calendarDays);
    out.push(
      c.dim(
        `  per day    ${fmtUsd(perActive)} per active day (${activeDays}) · ` +
          `${fmtUsd(perCalendar)} per calendar day (${calendarDays})`,
      ),
    );
  }

  // The last week as a shape, not a table: enough to see a trend or a spike
  // without turning /cost into a report you have to read.
  const window = Array.from({ length: 7 }, (_, i) => dayBefore(today, 6 - i));
  const windowCosts = window.map((d) => dayCosts.get(d) ?? 0);
  const windowTotal = windowCosts.reduce((a, b) => a + b, 0);
  out.push(
    c.dim(
      `  last 7d    ${sparkline(windowCosts)}  ${fmtUsd(windowTotal)}  ` +
        `(${window[0]!.slice(5)} → ${today.slice(5)})`,
    ),
  );

  if (allTime.ms > 0) {
    out.push(
      c.dim(
        `  model time ${fmtDuration(session.ms)} this session · ` +
          `${fmtDuration(allTime.ms)} all time`,
      ),
    );
  }

  // --- where the money went ---
  //
  // The prompt side, shown for the session, because it is where the money
  // actually goes and a captain looking at a surprising bill needs to see it.
  out.push("");
  const st = session.tokens;
  out.push(
    c.dim(
      `  session tokens: in ${fmtTokens(st.input)} · cache write ${fmtTokens(st.cacheWrite)} · ` +
        `cache read ${fmtTokens(st.cacheRead)} · out ${fmtTokens(st.output)}`,
    ),
  );

  // --- the cache line ---
  //
  // The three numbers that explain the prompt side, and the only place the app
  // says anything about its own efficiency. Suppressed entirely on a ledger
  // written before these counters existed (rounds == 0 with turns > 0), because
  // a zero there means "never measured", not "one round per turn".
  //
  // `rebuild` is the actionable one. It is cache-write tokens billed on the
  // OPENING round of a turn, i.e. what it cost to rediscover a prefix that had
  // already been written and then lapsed. Reading that prefix instead would have
  // cost a twentieth as much (0.1x read against a 2x write), so a large share
  // here is the cheapest money in the whole program to stop spending.
  if (allTime.rounds > 0) {
    const perTurn = (n: number, t: number) => (t > 0 ? n / t : 0);
    const rebuildShare = allTime.cost > 0 ? (allTime.rebuildCost / allTime.cost) * 100 : 0;
    out.push(
      c.dim(
        `  rounds     ${perTurn(allTime.rounds, allTime.turns).toFixed(1)} per turn · ` +
          `${fmtTokens(Math.round(perTurn(allTime.tokens.cacheRead, allTime.rounds)))} read per round`,
      ),
    );
    out.push(
      c.dim(
        `  rebuilds   ${fmtTokens(Math.round(perTurn(allTime.rebuild, allTime.turns)))} tok per turn · ` +
          `${fmtUsd(allTime.rebuildCost)} (${rebuildShare.toFixed(0)}% of spend) re-writing a lapsed cache`,
      ),
    );
    if (allTime.idleMs > 0) {
      out.push(
        c.dim(
          `  idle gap   ${fmtDuration(perTurn(allTime.idleMs, allTime.turns))} average between turns` +
            ` (cache ttl ${cacheTtl})`,
        ),
      );
    }
    // Only once the keep-alive has actually run. Shown beside the rebuild line
    // on purpose: those two numbers ARE the trade, and the probes are only worth
    // sending while they cost less than the rebuilds they prevent.
    if (allTime.keepAlives > 0) {
      out.push(
        c.dim(
          `  keep-alive ${fmtTokens(allTime.keepAlives)} probe(s) to hold the cache open` +
            ` (not counted as turns)`,
        ),
      );
    }
  }

  const r = ratesFor(modelId, today);
  const write = r ? (cacheTtl === "1h" ? r.cacheWrite1h : r.cacheWrite5m) : 0;
  const rate = (n: number) => `$${n.toFixed(2)}`;
  out.push(
    c.dim(
      r
        ? `  ${modelId} — bedrock ${rate(r.input)}/${rate(r.output)} per Mtok · ` +
            `cache write ${rate(write)} (${cacheTtl}) · cache read ${rate(r.cacheRead)}` +
            (r.confirmed ? "" : "  [rate derived, not published by AWS]")
        : `  ${modelId} — no bedrock rate on file; tokens are counted, cost is not`,
    ),
  );
  // Named only when it applies, and priced in dollars rather than left as a
  // percentage, because "10% of everything" is easy to nod at and $8 is not.
  // The same model is one environment variable away; what the prefix actually
  // buys is US-and-Canada data residency, so this is a choice to make knowingly
  // rather than one to have inherited.
  if (r && isGeoScoped(modelId)) {
    const global = allTime.cost / GEO_PREMIUM;
    out.push(
      c.dim(
        `  geo premium +10% for US/Canada residency · ${fmtUsd(allTime.cost - global)} of the` +
          ` above · global.${normalizeModelId(modelId)} is the same model without it`,
      ),
    );
  }
  out.push(
    c.dim(
      allTime.turns > 0
        ? `  since ${firstDay} · last turn ${fmtLocalStamp(life.last)}`
        : `  since ${firstDay}`,
    ),
  );

  const unpriced = [...new Set([...session.unpriced, ...allTime.unpriced])];
  if (unpriced.length > 0) {
    out.push(
      c.yellow(
        `  totals exclude un-priced model(s): ${unpriced.join(", ")} — add rates in src/cost.ts`,
      ),
    );
  }
  return out;
}

// --- the fleet view (`co cost`) -----------------------------------------------

/** One instance's meter, for the cross-instance rollup. */
export interface FleetEntry {
  name: string;
  ledger: CostLedger;
}

/** Sum the per-day series across instances, keeping the per-model split so each
 *  day still prices correctly when instances run different models. */
function mergeDays(entries: FleetEntry[]): Record<string, DayTotals> {
  const merged: Record<string, DayTotals> = {};
  for (const { ledger } of entries) {
    for (const [day, byModel] of Object.entries(ledger.lifetime().days)) {
      const bucket = (merged[day] ??= {});
      for (const [id, t] of Object.entries(byModel)) {
        const prev = bucket[id] ?? emptyTotals();
        bucket[id] = addTotals(prev, t);
      }
    }
  }
  return merged;
}

/** Sum all-time per-model totals across instances. */
function mergeModels(entries: FleetEntry[]): Record<string, ModelTotals> {
  const merged: Record<string, ModelTotals> = {};
  for (const { ledger } of entries) {
    for (const [id, t] of Object.entries(ledger.lifetime().models)) {
      const prev = merged[id] ?? emptyTotals();
      merged[id] = addTotals(prev, t);
    }
  }
  return merged;
}

/**
 * The `co cost` report: every co-manager on this machine, and the total.
 *
 * The per-instance /cost answers "what has THIS co-manager cost me". It cannot
 * answer "what am I actually being billed", because the ledger is per instance
 * and the Bedrock key is not — three co-managers on one key produce one invoice.
 * This is that view: the sum, plus the split, so a surprising total can be
 * attributed to the instance that caused it.
 */
export function formatFleetReport(opts: {
  entries: FleetEntry[];
  cacheTtl: "5m" | "1h";
  home: string;
  now?: Date;
}): string[] {
  const { entries, cacheTtl, home } = opts;
  const now = opts.now ?? new Date();
  const today = localDay(now);

  if (entries.length === 0) {
    return ["", c.dim(`no co-managers yet in ${home}. create one:  co create <name>`)];
  }

  const out: string[] = [
    "",
    c.bold(`cost across ${entries.length} co-manager${entries.length === 1 ? "" : "s"}`),
    "",
  ];

  const nameWidth = Math.max(10, ...entries.map((e) => e.name.length)) + 2;
  out.push(
    c.dim(
      `  ${"co-manager".padEnd(nameWidth)}${"out".padEnd(14)}${"cost".padEnd(12)}` +
        `${"turns".padEnd(8)}last`,
    ),
  );

  // Sort by spend, dearest first: the whole point of the split is attribution,
  // and the instance you need to look at is the one at the top.
  const rows = entries
    .map((e) => {
      const life = e.ledger.lifetime();
      const s = summarize(life.models, cacheTtl, today);
      return { name: e.name, s, last: s.turns > 0 ? fmtLocalStamp(life.last) : "—" };
    })
    .sort((a, b) => b.s.cost - a.s.cost || b.s.output - a.s.output);

  for (const row of rows) {
    const money = row.s.unpriced.length > 0 ? `${fmtUsd(row.s.cost)}+` : fmtUsd(row.s.cost);
    const idle = row.s.turns === 0;
    const text = (
      `  ${row.name.padEnd(nameWidth)}${fmtTokens(row.s.output).padEnd(14)}` +
      `${money.padEnd(12)}${String(row.s.turns).padEnd(8)}${row.last}`
    ).trimEnd();
    out.push(idle ? c.dim(text) : text);
  }

  const allModels = mergeModels(entries);
  const total = summarize(allModels, cacheTtl, today);
  const totalMoney = total.unpriced.length > 0 ? `${fmtUsd(total.cost)}+` : fmtUsd(total.cost);
  out.push(c.dim(`  ${"".padEnd(nameWidth)}${"─".repeat(32)}`));
  out.push(
    c.bold(
      (
        `  ${"total".padEnd(nameWidth)}${fmtTokens(total.output).padEnd(14)}` +
        `${totalMoney.padEnd(12)}${String(total.turns)}`
      ).trimEnd(),
    ),
  );

  // --- the time dimension, summed across the fleet ---
  out.push("");
  const days = mergeDays(entries);
  const dayCosts = new Map<string, number>();
  for (const [day, byModel] of Object.entries(days)) {
    dayCosts.set(day, summarize(byModel, cacheTtl, day).cost);
  }
  const activeDays = [...dayCosts.values()].filter((v) => v > 0).length;

  // Earliest first turn across every instance — the fleet's real start date.
  const firstDay = entries
    .map((e) => localDay(new Date(e.ledger.lifetime().since)))
    .sort()[0]!;
  const calendarDays = daysSpanned(firstDay, today);

  if (total.turns === 0) {
    out.push(c.dim("  per day    nothing metered yet"));
  } else {
    out.push(
      c.dim(
        `  per day    ${fmtUsd(activeDays > 0 ? total.cost / activeDays : 0)} per active day ` +
          `(${activeDays}) · ${fmtUsd(total.cost / Math.max(1, calendarDays))} per calendar day ` +
          `(${calendarDays})`,
      ),
    );
  }

  const window = Array.from({ length: 7 }, (_, i) => dayBefore(today, 6 - i));
  const windowCosts = window.map((d) => dayCosts.get(d) ?? 0);
  out.push(
    c.dim(
      `  last 7d    ${sparkline(windowCosts)}  ` +
        `${fmtUsd(windowCosts.reduce((a, b) => a + b, 0))}  ` +
        `(${window[0]!.slice(5)} → ${today.slice(5)})`,
    ),
  );
  if (total.ms > 0) out.push(c.dim(`  model time ${fmtDuration(total.ms)} all time`));

  // --- what is being billed ---
  out.push("");
  for (const [modelId, t] of Object.entries(allModels).sort((a, b) => b[1].output - a[1].output)) {
    const r = ratesFor(modelId, today);
    out.push(
      c.dim(
        r
          ? `  ${modelId} — $${r.input.toFixed(2)}/$${r.output.toFixed(2)} per Mtok · ` +
              `${fmtTokens(t.output)} out` +
              (r.confirmed ? "" : "  [rate derived, not published by AWS]")
          : `  ${modelId} — no bedrock rate on file; ${fmtTokens(t.output)} out, cost not counted`,
      ),
    );
  }
  // The fleet view is what `co cost` prints, so the premium belongs here too —
  // this is the total the captain actually looks at. Reported once per priced
  // geo-scoped model rather than as a fleet-wide line, since instances can be
  // pointed at different endpoints.
  for (const [modelId, t] of Object.entries(allModels)) {
    const r = ratesFor(modelId, today);
    if (!r || !isGeoScoped(modelId)) continue;
    const spent = costOf(t, r, cacheTtl);
    out.push(
      c.dim(
        `  geo premium +10% for US/Canada residency · ${fmtUsd(spent - spent / GEO_PREMIUM)}` +
          ` of the above · global.${normalizeModelId(modelId)} is the same model without it`,
      ),
    );
  }
  out.push(c.dim(`  since ${firstDay} · ${home}`));

  if (total.unpriced.length > 0) {
    out.push(
      c.yellow(
        `  the total excludes un-priced model(s): ${total.unpriced.join(", ")} — add rates in src/cost.ts`,
      ),
    );
  }
  return out;
}
