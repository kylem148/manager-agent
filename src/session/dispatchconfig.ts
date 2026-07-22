import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import type { InstancePaths } from "../paths.js";
import type { PaneLayoutConfig, SplitDirection } from "./crewpanes.js";
import { DEFAULT_PANE_LAYOUT } from "./crewpanes.js";

/**
 * Per-instance dispatch configuration — the `co link` registration.
 *
 * This is data, not secrets (a repo path and a command template), so it lives in
 * plain JSON under the instance's .dispatch/ dir rather than in .env. It is
 * separate from the co-manager's markdown memory: dispatch is machinery, not
 * something the model reasons over in prose. Reuses the same instancePaths
 * resolution as everything else; nothing here reaches outside the instance.
 *
 * The command template is agent-agnostic: it is a command line with {prompt} and
 * {repo} placeholders, so Claude Code, OpenCode, or anything else the user runs
 * locally goes through the identical dispatch path. No vendor is hardcoded in the
 * transport — only offered as example templates the user can pick or replace.
 */

/** Safety caps applied to a dispatched run. All optional; a coding agent that
 *  ignores a flag simply runs uncapped on that axis, which is the agent's call. */
export interface SafetyCaps {
  /** Max agent turns, if the agent supports a turn cap. */
  turnLimit?: number;
  /** Token/cost budget cap, if the agent supports one. */
  budget?: number;
  /** Wall-clock timeout in seconds. Enforced by the transport (kills the run). */
  timeoutSec?: number;
  /** Tool-scoping string passed through to the agent (e.g. an allowlist). */
  toolScope?: string;
}

export interface DispatchConfig {
  /** Absolute path to the target repo the coding agent operates in. */
  repoPath: string;
  /** Command line with {prompt} and {repo} placeholders. */
  commandTemplate: string;
  caps: SafetyCaps;
  pane: PaneLayoutConfig;
  /**
   * The designated crew anchor pane, once `co pane` has tagged it. Persisted so
   * the transport finds it every dispatch and across restarts. Null until set.
   */
  anchor: { id: string; title: string } | null;
}

/** Example templates shipped for the two agents the order names. Agent-agnostic
 *  machinery, these are just starting points the user can edit or replace. */
export const EXAMPLE_TEMPLATES: { label: string; template: string }[] = [
  { label: "Claude Code", template: "claude --dir {repo} {prompt}" },
  { label: "OpenCode", template: "opencode run --dir {repo} {prompt}" },
];

export function defaultDispatchConfig(): DispatchConfig {
  return {
    repoPath: "",
    commandTemplate: EXAMPLE_TEMPLATES[0]!.template,
    caps: {},
    pane: { ...DEFAULT_PANE_LAYOUT, directionSequence: [...DEFAULT_PANE_LAYOUT.directionSequence] },
    anchor: null,
  };
}

const VALID_DIRECTIONS: readonly SplitDirection[] = ["right", "down", "left", "up"];

/** Coerce arbitrary parsed JSON into a well-formed DispatchConfig, filling gaps
 *  with defaults. Tolerant by design: a hand-edited config with a typo degrades
 *  to sane values rather than crashing a session. */
function coerce(raw: unknown): DispatchConfig {
  const base = defaultDispatchConfig();
  if (!raw || typeof raw !== "object") return base;
  const o = raw as Record<string, unknown>;

  if (typeof o.repoPath === "string") base.repoPath = o.repoPath;
  if (typeof o.commandTemplate === "string" && o.commandTemplate.trim()) {
    base.commandTemplate = o.commandTemplate;
  }

  const caps = o.caps as Record<string, unknown> | undefined;
  if (caps && typeof caps === "object") {
    if (Number.isFinite(caps.turnLimit)) base.caps.turnLimit = Number(caps.turnLimit);
    if (Number.isFinite(caps.budget)) base.caps.budget = Number(caps.budget);
    if (Number.isFinite(caps.timeoutSec)) base.caps.timeoutSec = Number(caps.timeoutSec);
    if (typeof caps.toolScope === "string") base.caps.toolScope = caps.toolScope;
  }

  const pane = o.pane as Record<string, unknown> | undefined;
  if (pane && typeof pane === "object") {
    if (Array.isArray(pane.directionSequence)) {
      const seq = pane.directionSequence.filter(
        (d): d is SplitDirection => typeof d === "string" && VALID_DIRECTIONS.includes(d as SplitDirection),
      );
      if (seq.length > 0) base.pane.directionSequence = seq;
    }
    if (Number.isFinite(pane.cap) && Number(pane.cap) >= 1) base.pane.cap = Math.floor(Number(pane.cap));
  }

  const anchor = o.anchor as Record<string, unknown> | undefined;
  if (anchor && typeof anchor.id === "string" && typeof anchor.title === "string") {
    base.anchor = { id: anchor.id, title: anchor.title };
  }

  return base;
}

/** True if `co link` has run for this instance (a config file exists). */
export function isLinked(p: InstancePaths): boolean {
  return fs.existsSync(p.dispatchConfig);
}

/** Read the dispatch config, or null if the instance has never been linked. */
export async function readDispatchConfig(p: InstancePaths): Promise<DispatchConfig | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(p.dispatchConfig, "utf8");
  } catch {
    return null;
  }
  try {
    return coerce(JSON.parse(raw));
  } catch {
    // A corrupt config should not wedge dispatch; treat it as unlinked so
    // `co link` can rewrite it, but surface nothing silently destructive.
    return null;
  }
}

/** Write the dispatch config, creating .dispatch/ if needed. Plain 0644 JSON. */
export async function writeDispatchConfig(p: InstancePaths, config: DispatchConfig): Promise<void> {
  await fsp.mkdir(p.dispatch, { recursive: true });
  await fsp.writeFile(p.dispatchConfig, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/** Persist just the anchor, preserving the rest of the config. Used by `co pane`. */
export async function setAnchor(
  p: InstancePaths,
  anchor: { id: string; title: string } | null,
): Promise<DispatchConfig> {
  const config = (await readDispatchConfig(p)) ?? defaultDispatchConfig();
  config.anchor = anchor;
  await writeDispatchConfig(p, config);
  return config;
}

// --- command template resolution --------------------------------------------

/**
 * Split a command template into argv tokens, honoring simple single/double
 * quoting in the TEMPLATE itself (so an author may quote a literal argument that
 * contains spaces). Placeholders are left intact for substitution afterward, so
 * a `{prompt}` token stays exactly one token regardless of what it expands to.
 * This is not a full shell parser — no variable expansion, no operators — just
 * enough to tokenize a command line the user wrote.
 */
export function tokenizeTemplate(template: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let hasToken = false; // distinguishes "" (a real empty quoted arg) from no arg

  for (let i = 0; i < template.length; i++) {
    const ch = template[i]!;
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else cur += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else cur += ch;
      continue;
    }
    if (ch === "'") { inSingle = true; hasToken = true; continue; }
    if (ch === '"') { inDouble = true; hasToken = true; continue; }
    if (ch === " " || ch === "\t") {
      if (hasToken) { tokens.push(cur); cur = ""; hasToken = false; }
      continue;
    }
    cur += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(cur);
  return tokens;
}

/** Replace {key} placeholders in one token with values from `subs`. Unknown
 *  placeholders are left verbatim (a template typo shows rather than vanishing). */
function substituteToken(token: string, subs: Record<string, string>): string {
  return token.replace(/\{(\w+)\}/g, (m, key: string) => (key in subs ? subs[key]! : m));
}

/**
 * Resolve a command template to a concrete argv array: each placeholder is
 * substituted inline, so {prompt} becomes exactly one argv element holding the
 * full order text (newlines and all). This is what the FALLBACK transport spawns
 * directly — no shell, so there is no quoting to get wrong.
 */
export function resolveArgv(template: string, subs: { prompt: string; repo: string }): string[] {
  const map: Record<string, string> = { prompt: subs.prompt, repo: subs.repo };
  return tokenizeTemplate(template).map((t) => substituteToken(t, map));
}

/**
 * POSIX single-quote a string for safe use in a shell command line: wrap in
 * single quotes and escape any embedded single quote as '\''. Handles newlines
 * (they survive inside single quotes) and every shell metacharacter.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * A one-line summary of the resolved command for the confirm UI. The full order
 * text is shown separately, so here the {prompt} placeholder is rendered as a
 * compact marker rather than dumping the whole order into the command preview.
 */
export function displayCommand(template: string, repo: string): string {
  const map: Record<string, string> = { prompt: "<order>", repo };
  return tokenizeTemplate(template)
    .map((t) => substituteToken(t, map))
    .join(" ");
}
