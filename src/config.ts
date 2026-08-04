import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { config as loadDotenv, parse as parseDotenv } from "dotenv";
import { readEnvFile, readEnvText, upsertEnv } from "./envfile.js";

/**
 * Loads .env from the current working directory and from the co-manager home,
 * then reads configuration out of the environment. Real env vars always win
 * over .env files. We intentionally do NOT hardcode any credentials.
 */

function loadEnvFiles(): void {
  // cwd .env first (project-local overrides), then ~/co-managers/.env as a
  // fallback for global defaults. dotenv does not override already-set keys.
  // quiet: true suppresses dotenv's promotional tip banner.
  loadDotenv({ path: path.join(process.cwd(), ".env"), quiet: true });
  loadDotenv({ path: path.join(coHome(), ".env"), quiet: true });
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

/**
 * Keys that came from the ACTUAL environment, captured before any .env file is
 * merged in.
 *
 * dotenv works by writing file values into `process.env`, which means that after
 * loadEnvFiles() has run there is no way to look at `process.env` and tell a real
 * `FOO=bar co …` from a line in `~/co-managers/.env`. Anything needing that
 * distinction has to have taken a snapshot first — and per-instance overrides
 * need it exactly, or the home file shadows the instance file and the override
 * silently does nothing.
 *
 * Evaluated at module load, which is before loadConfig() can be called, so this
 * is genuinely the pre-dotenv environment.
 */
const REAL_ENV: ReadonlySet<string> = new Set(
  Object.entries(process.env)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k]) => k),
);

/** Root directory holding all co-manager instances. */
export function coHome(): string {
  return env("CO_HOME") ?? path.join(os.homedir(), "co-managers");
}

export type AuthMode = "bearer" | "sigv4" | "none";

/** Human-readable label for an auth mode, for diagnostics. */
export function authModeLabel(mode: AuthMode): string {
  switch (mode) {
    case "bearer":
      return "Bedrock bearer token";
    case "sigv4":
      return "AWS credentials (SigV4)";
    default:
      return "none found";
  }
}

/** Accepted effort levels, weakest to strongest. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/**
 * Validate a user- or env-supplied effort string. Returns null for anything
 * unrecognised so callers decide whether to fall back (config) or complain
 * (the /effort command).
 *
 * This checks the level exists at all, not that the configured model accepts
 * it — see effortLevelsFor for the per-model ladder.
 */
export function parseEffort(raw: string | undefined): Effort | null {
  const lower = raw?.trim().toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(lower ?? "")
    ? (lower as Effort)
    : null;
}

/** The ladder without xhigh, for models predating Opus 4.7. */
const NO_XHIGH: readonly Effort[] = ["low", "medium", "high", "max"];

/**
 * Models that reject `xhigh`. The level was introduced with Opus 4.7, so the
 * whole 4.6 generation is one step short — Bedrock answers a request carrying
 * it with a flat 400 (`output_config.effort: Input should be 'low', 'medium',
 * 'high' or 'max'`), which kills the turn rather than degrading it.
 *
 * Verified against the live key on 2026-07-27: on
 * us.anthropic.claude-sonnet-4-6 the low/medium/high/max rungs all answer and
 * xhigh 400s, while us.anthropic.claude-sonnet-5 accepts all five.
 */
const NO_XHIGH_MODELS = /(sonnet-4-6|opus-4-6)/;

/**
 * The effort levels a given Bedrock model id actually accepts.
 *
 * Unknown ids get the full ladder: that is the pre-existing behaviour, so a
 * model nobody has characterised here fails loudly at the API rather than
 * being quietly capped. Models older than the 4.6 generation are not covered —
 * some reject `output_config.effort` outright — but comanager has never been
 * run on one, so this deliberately does not guess on their behalf.
 */
export function effortLevelsFor(modelId: string): readonly Effort[] {
  return NO_XHIGH_MODELS.test(modelId) ? NO_XHIGH : EFFORT_LEVELS;
}

/**
 * Lower an effort level to the strongest accepted rung at or below it. Applied
 * to CO_EFFORT at load so a value left behind by a previous model (xhigh from
 * an Opus 4.8 config, say) degrades instead of 400-ing every turn.
 *
 * Degrading matters more than it sounds: xhigh sits between high and max, so
 * rounding an unsupported xhigh *up* would quietly raise token spend on every
 * turn — the opposite of why anyone moves to a cheaper model.
 */
export function clampEffort(effort: Effort, modelId: string): Effort {
  const levels = effortLevelsFor(modelId);
  if (levels.includes(effort)) return effort;
  const wanted = EFFORT_LEVELS.indexOf(effort);
  const below = EFFORT_LEVELS.filter(
    (l, i) => i <= wanted && levels.includes(l),
  );
  return below[below.length - 1] ?? levels[0]!;
}

/** Accepted terminal-visual levels, richest to plainest. */
export const VISUALS_LEVELS = ["full", "minimal", "off"] as const;
export type VisualsLevel = (typeof VISUALS_LEVELS)[number];

/**
 * Validate a `CO_VISUALS` value. Returns null for anything unrecognised so the
 * caller decides the fallback (the same contract as parseEffort).
 *
 * `full` animates, `minimal` keeps the glyphs but never moves, `off` is a plain
 * static line. The on/off aliases exist because this reads as a switch to most
 * people — `CO_VISUALS=off` is the CO_KEYS=off spelling the rest of the UI
 * toggles use, and `0`/`false`/`none` are what someone reaches for when they
 * mean the same thing. The RESOLVED level is not this value: the environment can
 * only ever degrade it (see resolveVisuals in tui/visuals.ts).
 */
export function parseVisualsLevel(raw: string | undefined): VisualsLevel | null {
  const lower = raw?.trim().toLowerCase();
  if (lower === undefined || lower === "") return null;
  if ((VISUALS_LEVELS as readonly string[]).includes(lower)) return lower as VisualsLevel;
  if (["on", "true", "1", "yes"].includes(lower)) return "full";
  if (["0", "false", "none", "no"].includes(lower)) return "off";
  return null;
}

/**
 * The configured visuals level, straight from the environment. Read lazily at
 * the point of use (rather than plumbed through Config) so it picks up
 * `~/co-managers/.env` — loadConfig() runs before any session opens, and the
 * TUI's sibling toggles (CO_MOUSE, CO_PASTE, CO_KEYS) resolve the same way.
 * Anything unrecognised falls back to `full`: the visuals are opt-in-by-default
 * and every degradation path below them is safe.
 */
export function visualsLevel(): VisualsLevel {
  return parseVisualsLevel(process.env.CO_VISUALS) ?? "full";
}

/** Seconds `co pane` gives you to click the pane you want, when CO_PANE_WAIT is unset. */
export const DEFAULT_PANE_WAIT_SEC = 2;

/**
 * How long `co pane` counts down before grabbing the focused pane (CO_PANE_WAIT,
 * in seconds).
 *
 * This is a pure human-reaction window — nothing is being waited FOR, so the
 * only cost of a short value is the captain not reaching the pane in time, never
 * a failed designation. It was a hardcoded 5, which is a long time to sit and
 * watch a countdown for a command run this often. Two is enough to click a pane
 * that is already on screen; raise it if you're reaching for a different window.
 *
 * Read lazily at the point of use rather than plumbed through Config, the same
 * way CO_VISUALS and the TUI toggles resolve, so it picks up
 * `~/co-managers/.env`. Anything non-numeric or <= 0 falls back to the default:
 * a fat-fingered value should not turn `co pane` into an instant grab or a hang.
 */
export function paneWaitSec(): number {
  return parseIntOr("CO_PANE_WAIT", DEFAULT_PANE_WAIT_SEC);
}

/**
 * Model used when BEDROCK_MODEL_ID is unset.
 *
 * SOME prefix is load-bearing: the bare foundation id is rejected for on-demand
 * throughput ("Retry your request with the ID or ARN of an inference profile").
 * Which prefix is a cost decision, and it did NOT go the way the list price says.
 *
 * On paper `global.` wins: Anthropic documents a 10% premium on Bedrock's geo
 * endpoints over global, on every token class, for the same model. This default
 * was moved to global on that basis on 2026-07-29, and moved back a day later
 * because the meter disagreed.
 *
 * Measured over 71 real turns on global against 152 on `us.`:
 *
 *   cache write per turn   11,026  ->  37,151   (3.4x)
 *   rebuilds as a share of all writes:  85%
 *   cost per turn          $0.428  ->  $0.536   (+25%)
 *
 * Rebuilds are cache writes billed on a turn's OPENING round, and 85% of writes
 * landing there means the prefix was being rebuilt at the start of nearly every
 * turn — with an average gap between turns of 38 seconds, against a one-hour
 * TTL. No expiry explains that. AWS warns that cross-region inference "may lead
 * to increased cache writes", and global routes across the widest pool there is,
 * so a request can simply land where the cache is not.
 *
 * The lesson generalises past this one setting: a 10% list-price saving is worth
 * nothing next to a 20:1 write-to-read spread, and the only way to know which
 * way a routing change lands is the rebuild line in `/cost`.
 *
 * The Sonnet tier runs at a materially lower per-token rate;
 * `us.anthropic.claude-sonnet-5` answers on this account if cost outranks
 * capability. Note Sonnet 4.6 does not accept effort=xhigh — see effortLevelsFor.
 */
export const DEFAULT_MODEL_ID = "us.anthropic.claude-opus-5";

/**
 * The one env key that names the Bedrock model, wherever it is read or written:
 * the environment, a `.env`, an instance's own `.env`, and `/model`. Named once
 * so the command that writes it and the loader that reads it cannot drift.
 */
export const MODEL_ID_KEY = "BEDROCK_MODEL_ID";

/** A row of the `/model` picker: the name a person uses, and the id it sets. */
export interface ModelChoice {
  label: string;
  id: string;
}

/**
 * The models bare `/model` offers, in the order the picker lists them.
 *
 * IT IS CURATED AND FIXED, and it is here rather than fetched because Bedrock
 * cannot answer the question a picker has to answer - "what may this key
 * actually invoke". ListFoundationModels returns every model in the region
 * regardless of access, and GetFoundationModelAvailability has been observed
 * reporting AUTHORIZED for models that still 403 on invoke. A list built from
 * either would offer rows that cannot be selected, which is worse than a short
 * list somebody maintains. The probe `/model` runs before it persists stays the
 * only honest check, and `/model <id>` remains the escape hatch for anything not
 * on this list.
 *
 * Every id is the cross-region INFERENCE PROFILE form (`us.`). The bare
 * `anthropic.claude-…` spelling is rejected for on-demand throughput (see
 * model.ts), so a list carrying it would fail its own probe on every row.
 *
 * It lives beside DEFAULT_MODEL_ID deliberately: the picker marks the model in
 * force, and a default that had drifted out of the list would leave the picker
 * with nothing marked.
 */
export const MODEL_CHOICES: readonly ModelChoice[] = [
  { label: "Opus 4.8", id: "us.anthropic.claude-opus-4-8" },
  { label: "Opus 5", id: DEFAULT_MODEL_ID },
  { label: "Sonnet 5", id: "us.anthropic.claude-sonnet-5" },
];

export interface ModelConfig {
  region: string;
  /**
   * Bedrock bearer token. Resolved from AWS_BEARER_TOKEN_BEDROCK first, then
   * BEDROCK_API_KEY. Undefined => fall back to AWS SigV4 credentials.
   */
  apiKey?: string;
  /** How Bedrock will actually be authenticated, for diagnostics. */
  authMode: AuthMode;
  modelId: string;
  maxTokens: number;
  thinking: "adaptive" | "off";
  effort?: Effort;
  /**
   * CO_DEBUG_TIMING: print per-round latency and token/cache counters into the
   * transcript. Off by default. This is the only way to tell whether prompt
   * caching is actually engaging on the Bedrock runtime path, which Anthropic
   * does not document as having full feature parity — see model.ts.
   */
  debugTiming: boolean;
  /**
   * Cache keep-alive: how long an idle prompt waits before touching the cached
   * prefix to restart its TTL, in milliseconds. 0 disables it.
   *
   * Default is 45 minutes, chosen against the 1-hour TTL in model.ts with a
   * generous margin — a probe that lands after the entry has already lapsed pays
   * the rebuild it existed to prevent, so being early is free and being late is
   * the whole cost. If CACHE_TTL ever drops back to the 5-minute default this
   * has to come down with it (roughly 4 minutes), which is why they are worth
   * keeping in view of each other.
   */
  cacheKeepAliveMs: number;
  /**
   * How many probes in a row, with no real turn between them, before the
   * keep-alive gives up. Bounds the cost of a terminal left open overnight.
   * Three probes at the default interval covers a bit over two hours of thinking
   * time, which is longer than any real pause and short enough that an abandoned
   * session stops billing.
   */
  cacheKeepAliveMax: number;
  /**
   * The HARD ceiling on message-history size, in bytes (CO_HISTORY_MAX_BYTES).
   * Crossing it compacts everything but a recent tail into a summary.
   * 0 disables it (CO_COMPACT=off).
   *
   * Generous on purpose. Compaction trades cheap reads for expensive writes
   * (see compaction.ts), so on a normal session it should never fire — this is
   * the guard that keeps a runaway session from growing until the API refuses
   * it, not routine housekeeping.
   */
  historyMaxBytes: number;
  /** Intact exchanges kept verbatim when compacting. Everything older becomes a
   *  summary. */
  compactKeepTurns: number;
}

export type SearchProviderName = "auto" | "exa" | "brave" | "tavily" | "searxng" | "none";

export interface ResearchConfig {
  searchProvider: SearchProviderName;
  exaApiKey?: string;
  braveApiKey?: string;
  tavilyApiKey?: string;
  searxngUrl?: string;
  useJina: boolean;
  jinaApiKey?: string;
  fetchMaxChars: number;
}

export interface Config {
  home: string;
  model: ModelConfig;
  research: ResearchConfig;
}

function parseIntOr(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Model settings a single instance may override, in its own `.env`.
 *
 * Deliberately an allowlist rather than a general env layer. The point is to be
 * able to run one co-manager on a different model than another — to A/B a
 * cheaper tier against a control instance without guessing from one blended
 * number — and that is worth exactly these keys. Anything wider turns "which
 * config is in effect" into a question you have to go and answer.
 *
 * Precedence is home `.env` < instance `.env` < real environment variables. The
 * environment still wins so a one-off `BEDROCK_MODEL_ID=… co testing` overrides
 * the file, which is what you want when checking something quickly.
 */
const INSTANCE_KEYS = [MODEL_ID_KEY, "CO_EFFORT", "CO_THINKING", "CO_MAX_TOKENS"] as const;

/**
 * Apply an instance's own `.env` on top of the resolved config.
 *
 * Applied AFTER loadConfig rather than layered into it, because the instance is
 * not known until the command line has been parsed and dotenv will not overwrite
 * a key it has already set. Parsing the file directly sidesteps that ordering
 * entirely and keeps the precedence rule explicit instead of emergent.
 *
 * A missing or unreadable file is simply no override — a per-instance setting is
 * a convenience, and failing to read one must never stop a session opening.
 */
export function applyInstanceOverrides(
  cfg: Config,
  instanceRoot: string,
  /** Injected only by tests; production always uses the module snapshot. */
  opts: { realEnv?: ReadonlySet<string> } = {},
): Config {
  let raw: Record<string, string>;
  try {
    raw = parseDotenv(fs.readFileSync(path.join(instanceRoot, ".env"), "utf8"));
  } catch {
    return cfg;
  }

  const realEnv = opts.realEnv ?? REAL_ENV;
  const pick = (key: (typeof INSTANCE_KEYS)[number]): string | undefined => {
    // The real environment outranks the file, so a value set there is left alone
    // rather than quietly replaced by the instance's default. Checked against the
    // pre-dotenv snapshot, NOT process.env: by now the home .env has been merged
    // into process.env and would otherwise look identical to a real variable,
    // which would make every instance override a no-op.
    if (realEnv.has(key)) return undefined;
    const v = raw[key];
    return v === undefined || v.trim() === "" ? undefined : v.trim();
  };

  const model = { ...cfg.model };
  const modelId = pick("BEDROCK_MODEL_ID");
  if (modelId) model.modelId = modelId;

  const thinking = pick("CO_THINKING");
  if (thinking) model.thinking = thinking.toLowerCase() === "off" ? "off" : "adaptive";

  const maxTokens = pick("CO_MAX_TOKENS");
  if (maxTokens) {
    const n = Number.parseInt(maxTokens, 10);
    if (Number.isFinite(n) && n > 0) model.maxTokens = n;
  }

  // Re-clamped against whichever model is now in effect, not the one the home
  // config resolved against: an instance moved to a model with a shorter effort
  // ladder must degrade rather than 400 every turn (see clampEffort).
  const effort = parseEffort(pick("CO_EFFORT")) ?? model.effort;
  if (effort) model.effort = clampEffort(effort, model.modelId);

  return { ...cfg, model };
}

// --- which model is in force, and why -----------------------------------------

/** Where the model id in force came from, strongest first. */
export type ModelSource = "env" | "instance" | "dotenv" | "default";

/** One rung of the ladder: an id and a human-readable account of where it is. */
export interface ModelCandidate {
  modelId: string;
  /** Human-readable "where", e.g. a path or "the environment". */
  where: string;
}

export interface ModelOrigin extends ModelCandidate {
  source: ModelSource;
  /**
   * Lower-precedence values this one is hiding, strongest first. A stored
   * per-instance choice that an exported variable is overriding shows up here,
   * which is the case `/model` exists to make visible instead of puzzling.
   */
  shadowed: ModelCandidate[];
}

/**
 * Resolve which model a session opened right now would use, and where that
 * value comes from.
 *
 * This walks the SAME ladder the loader does — real environment, then the
 * instance's own `.env`, then the `.env` files loadEnvFiles reads (cwd before
 * home), then the built-in default — and it has to keep walking it in lockstep
 * with loadConfig + applyInstanceOverrides, because a `/model` that reported a
 * different answer than the next turn actually used would be worse than no
 * report at all.
 *
 * Everything is read fresh off disk rather than off the loaded Config: this is
 * asked after `/model` has just rewritten a file, and it must see that write.
 * `realEnv` is the pre-dotenv snapshot for the same reason applyInstanceOverrides
 * takes one — by now process.env cannot tell an exported variable from a line in
 * a `.env`.
 */
export function resolveModelOrigin(opts: {
  instanceRoot: string;
  home?: string;
  cwd?: string;
  /** Injected only by tests; production always uses the module snapshot. */
  realEnv?: ReadonlySet<string>;
  /** Injected only by tests. */
  env?: NodeJS.ProcessEnv;
}): ModelOrigin {
  const realEnv = opts.realEnv ?? REAL_ENV;
  const processEnv = opts.env ?? process.env;
  const home = opts.home ?? coHome();
  const cwd = opts.cwd ?? process.cwd();

  const fromFile = (file: string, where: string): ModelCandidate | null => {
    const v = readEnvFile(file)[MODEL_ID_KEY]?.trim();
    return v ? { modelId: v, where } : null;
  };

  const exported = realEnv.has(MODEL_ID_KEY) ? processEnv[MODEL_ID_KEY]?.trim() : undefined;
  const instanceEnv = path.join(opts.instanceRoot, ".env");
  const homeEnv = path.join(home, ".env");
  const cwdEnv = path.join(cwd, ".env");

  const ladder: { source: ModelSource; candidate: ModelCandidate | null }[] = [
    {
      source: "env",
      candidate: exported
        ? { modelId: exported, where: `${MODEL_ID_KEY} in the environment` }
        : null,
    },
    { source: "instance", candidate: fromFile(instanceEnv, instanceEnv) },
    // cwd before home, matching loadEnvFiles: dotenv does not overwrite a key it
    // has already set, so whichever file is read first wins.
    { source: "dotenv", candidate: cwdEnv === homeEnv ? null : fromFile(cwdEnv, cwdEnv) },
    { source: "dotenv", candidate: fromFile(homeEnv, homeEnv) },
  ];

  const present = ladder.filter((r) => r.candidate !== null);
  const winner = present[0];
  if (!winner?.candidate) {
    return {
      modelId: DEFAULT_MODEL_ID,
      source: "default",
      where: "the built-in default",
      shadowed: [],
    };
  }
  return {
    ...winner.candidate,
    source: winner.source,
    shadowed: present.slice(1).map((r) => r.candidate!),
  };
}

/**
 * A model id this app is willing to write into an env file and send verbatim.
 *
 * Deliberately a shape check and nothing more: there is no alias table and no
 * registry of known ids, because either would go stale the day a new model
 * ships and would then reject an id that works. What this rejects is what
 * cannot survive a `KEY=VALUE` line or would make one ambiguous — whitespace,
 * quotes, `#`, `=`. Whether the id EXISTS is Bedrock's answer to give, and
 * /model asks it before committing.
 */
export function isPlausibleModelId(raw: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(raw);
}

/**
 * Store a model id as this instance's own choice, in the instance `.env` the
 * loader already reads (see applyInstanceOverrides).
 *
 * Per-instance because that is the whole ask: one co-manager per project, each
 * on the model that project wants. It goes in the instance's own folder under
 * CO_HOME — never in the captain's repo, and never in the home `.env`, which
 * every other instance would inherit.
 *
 * The file is edited in place rather than rewritten from a parsed map, so the
 * captain's other keys, comments and ordering survive a `/model`. Created 0600
 * because a `.env` is where secrets end up; an existing file's mode is left
 * exactly as the captain set it.
 *
 * Returns the path written, for the receipt. Throws on a failed write — a
 * silent failure here would promise a persistence that isn't there.
 */
export async function persistInstanceModel(
  instanceRoot: string,
  modelId: string,
): Promise<string> {
  const file = path.join(instanceRoot, ".env");
  const next = upsertEnv(readEnvText(file), { [MODEL_ID_KEY]: modelId });
  await fsp.mkdir(instanceRoot, { recursive: true });
  await fsp.writeFile(file, next, { encoding: "utf8", mode: 0o600 });
  return file;
}

export function loadConfig(): Config {
  loadEnvFiles();

  // Adaptive thinking is on by default. Opus 4.8 runs without thinking unless it
  // is explicitly requested, and adaptive is its only accepted on-mode (the
  // legacy budget_tokens form is rejected with a 400). Set CO_THINKING=off to
  // opt out entirely.
  const thinkingRaw = (env("CO_THINKING") ?? "adaptive").toLowerCase();
  const thinking = thinkingRaw === "off" ? "off" : "adaptive";

  const modelId = env("BEDROCK_MODEL_ID") ?? DEFAULT_MODEL_ID;

  // Effort controls thinking depth and overall token spend. Default high, which
  // is what Anthropic recommends for Opus 4.8 on "intelligence-sensitive
  // workloads" — they reserve xhigh for coding and agentic use, and a co-manager
  // is explicitly neither: it reasons and writes prose, it never touches a repo.
  // This used to default to xhigh on the theory that more effort pulls the model
  // away from over-literal answers. It does, but it also buys thinking depth we
  // mostly don't spend, on every turn, including "what did we decide about X".
  // Effort governs ALL output tokens, not just thinking, so high also means
  // fewer and more consolidated tool calls — which is the second-order win here,
  // since every extra tool call is another full round trip.
  // Raise it per-session with /effort, or set CO_EFFORT to make a change stick.
  //
  // Clamped to the model's ladder: not every model accepts every rung, and an
  // unsupported level is a 400 on every turn rather than a soft degrade.
  const effort: Effort = clampEffort(parseEffort(env("CO_EFFORT")) ?? "high", modelId);

  const searchRaw = (env("CO_SEARCH_PROVIDER") ?? "auto").toLowerCase();
  const searchProvider: SearchProviderName = (
    ["auto", "exa", "brave", "tavily", "searxng", "none"].includes(searchRaw) ? searchRaw : "auto"
  ) as SearchProviderName;

  // Auth priority, matching Claude Code: Bedrock bearer token first, then the
  // BEDROCK_API_KEY alias, then standard AWS SDK credentials (SigV4).
  const bearer = env("AWS_BEARER_TOKEN_BEDROCK") ?? env("BEDROCK_API_KEY");
  const authMode: AuthMode = bearer ? "bearer" : hasAwsCredsInEnv() ? "sigv4" : "none";

  return {
    home: coHome(),
    model: {
      region: env("AWS_REGION") ?? "us-west-2",
      apiKey: bearer,
      authMode,
      modelId,
      maxTokens: parseIntOr("CO_MAX_TOKENS", 32000),
      thinking,
      effort,
      debugTiming: (env("CO_DEBUG_TIMING") ?? "").toLowerCase() === "true",
      // parseIntOr rejects 0 as "not a positive int" and falls back, so the
      // off switch is its own env var rather than CO_CACHE_KEEPALIVE_MS=0.
      cacheKeepAliveMs:
        (env("CO_CACHE_KEEPALIVE") ?? "").toLowerCase() === "off"
          ? 0
          : parseIntOr("CO_CACHE_KEEPALIVE_MS", 45 * 60 * 1000),
      cacheKeepAliveMax: parseIntOr("CO_CACHE_KEEPALIVE_MAX", 3),
      historyMaxBytes:
        (env("CO_COMPACT") ?? "").toLowerCase() === "off"
          ? 0
          : parseIntOr("CO_HISTORY_MAX_BYTES", 200_000),
      compactKeepTurns: parseIntOr("CO_COMPACT_KEEP_TURNS", 6),
    },
    research: {
      searchProvider,
      exaApiKey: env("EXA_API_KEY"),
      braveApiKey: env("BRAVE_API_KEY"),
      tavilyApiKey: env("TAVILY_API_KEY"),
      searxngUrl: env("SEARXNG_URL"),
      useJina: (env("CO_FETCH_JINA") ?? "true").toLowerCase() !== "false",
      jinaApiKey: env("JINA_API_KEY"),
      fetchMaxChars: parseIntOr("CO_FETCH_MAX_CHARS", 12000),
    },
  };
}

/** True if any AWS-style credential is discoverable in the environment. */
export function hasAwsCredsInEnv(): boolean {
  return Boolean(
    env("AWS_ACCESS_KEY_ID") ||
      env("AWS_PROFILE") ||
      fs.existsSync(path.join(os.homedir(), ".aws", "credentials")),
  );
}

// --- secret hygiene ----------------------------------------------------------

/** Env keys whose values are secrets and must never be printed in full. */
export const SECRET_KEY_RE = /(TOKEN|KEY|SECRET|CREDENTIAL|PASSWORD)/i;

/**
 * Redact a secret to a short, non-reversible hint: «redacted…abcd». Shows at
 * most the last 4 chars so a user can sanity-check which token is set without
 * exposing it. Never returns the full value.
 */
export function redactSecret(value: string): string {
  if (!value) return value;
  const tail = value.length >= 4 ? value.slice(-4) : "";
  return `«redacted${tail ? `…${tail}` : ""}»`;
}

export interface ClaudeCodeSettings {
  path: string;
  /** Relevant env keys with secrets redacted. */
  env: Record<string, string>;
  /** Whether Claude Code has a Bedrock bearer token configured. */
  hasBearerToken: boolean;
  /** Model ids Claude Code is configured to send (non-secret values only). */
  modelIds: string[];
}

const CC_RELEVANT_KEY = /(MODEL|REGION|BEDROCK|AWS|CLAUDE|MANTLE)/i;
const CC_MODEL_KEY =
  /(ANTHROPIC_MODEL|DEFAULT_OPUS_MODEL|DEFAULT_SONNET_MODEL|DEFAULT_HAIKU_MODEL|SMALL_FAST_MODEL)/i;

/**
 * Read Claude Code's settings.json for diagnostics only, redacting secrets.
 * comanager never imports a secret from here automatically — it only reports.
 */
export function readClaudeCodeSettings(): ClaudeCodeSettings | null {
  const file = path.join(os.homedir(), ".claude", "settings.json");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed: { env?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw) as { env?: Record<string, unknown> };
  } catch {
    return { path: file, env: {}, hasBearerToken: false, modelIds: [] };
  }
  const ccEnv = parsed.env ?? {};
  const out: Record<string, string> = {};
  const modelIds: string[] = [];
  for (const [k, v] of Object.entries(ccEnv)) {
    if (!CC_RELEVANT_KEY.test(k)) continue;
    const value = String(v);
    out[k] = SECRET_KEY_RE.test(k) ? redactSecret(value) : value;
    if (CC_MODEL_KEY.test(k) && value && !SECRET_KEY_RE.test(k)) modelIds.push(value);
  }
  const bearerVal = ccEnv["AWS_BEARER_TOKEN_BEDROCK"];
  const hasBearerToken = typeof bearerVal === "string" && bearerVal.trim() !== "";
  return { path: file, env: out, hasBearerToken, modelIds: [...new Set(modelIds)] };
}

/**
 * The exact problem this project hit: Claude Code has a Bedrock bearer token in
 * its settings, but comanager fell through to SigV4 (its own token wasn't set).
 * Returns warning lines when that mismatch is present, else null.
 */
export function bearerMismatchWarning(mode: AuthMode): string[] | null {
  if (mode === "bearer") return null;
  const cc = readClaudeCodeSettings();
  if (!cc?.hasBearerToken) return null;
  return [
    `Claude Code is configured with AWS_BEARER_TOKEN_BEDROCK, but co is using ${
      mode === "sigv4" ? "AWS credentials / SigV4" : "no credentials"
    }.`,
    "These may have different model access.",
    "",
    "To match Claude Code, run:",
    "  co auth bedrock",
    "",
    "or add this to ~/co-managers/.env:",
    "  AWS_BEARER_TOKEN_BEDROCK=<your token>",
  ];
}
