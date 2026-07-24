import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { config as loadDotenv } from "dotenv";

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
 */
export function parseEffort(raw: string | undefined): Effort | null {
  const lower = raw?.trim().toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(lower ?? "")
    ? (lower as Effort)
    : null;
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

export function loadConfig(): Config {
  loadEnvFiles();

  // Adaptive thinking is on by default. Opus 4.8 runs without thinking unless it
  // is explicitly requested, and adaptive is its only accepted on-mode (the
  // legacy budget_tokens form is rejected with a 400). Set CO_THINKING=off to
  // opt out entirely.
  const thinkingRaw = (env("CO_THINKING") ?? "adaptive").toLowerCase();
  const thinking = thinkingRaw === "off" ? "off" : "adaptive";

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
  const effort: Effort = parseEffort(env("CO_EFFORT")) ?? "high";

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
      modelId: env("BEDROCK_MODEL_ID") ?? "us.anthropic.claude-opus-4-8",
      maxTokens: parseIntOr("CO_MAX_TOKENS", 32000),
      thinking,
      effort,
      debugTiming: (env("CO_DEBUG_TIMING") ?? "").toLowerCase() === "true",
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
