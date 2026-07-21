import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrock, AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import type { Config } from "../config.js";
import { authModeLabel, bearerMismatchWarning, readClaudeCodeSettings } from "../config.js";
import { c, line } from "../ui.js";

/**
 * `co doctor --models` — empirically determine which Claude models actually
 * answer on THIS account, region, endpoint, and auth path.
 *
 * Why probe instead of list? With a Bedrock API key (bearer token) we cannot
 * call the Bedrock control plane (ListFoundationModels / ListInferenceProfiles
 * need AWS credentials and a different IAM action), and a control-plane listing
 * would include models that on-demand throughput then rejects anyway. A probe
 * sends a 1-token request down the exact path real usage takes, so "it
 * answered" means "it works for us" — which is the only claim worth trusting.
 *
 * It also reads Claude Code's own settings (secrets redacted) and probes the
 * model ids Claude Code is configured to use, to answer directly: what model
 * did Claude Code actually use successfully on this path?
 */

// --- error classification -----------------------------------------------------

type FailKind =
  | "ftu-form-missing" // needs an inference-profile / cross-region id (on-demand rejects the bare foundation id)
  | "model-unavailable" // 404: model not present / account not entitled in this region
  | "wrong-region" // model/profile not offered in the configured region
  | "invalid-model-id" // 400: malformed or unknown id
  | "iam-denied" // 403: principal lacks bedrock:InvokeModel*
  | "auth-invalid" // 401: bad/expired bearer token or creds
  | "endpoint-unreachable" // DNS/connection failure (e.g. Mantle host for a non-entitled key)
  | "rate-limited"
  | "server-error"
  | "unknown";

interface ProbeResult {
  id: string;
  ok: boolean;
  modelReturned?: string; // what the API echoed back on success
  kind?: FailKind;
  status?: number;
  detail?: string;
}

function classify(
  e: unknown,
  ctx?: { id: string; region: string },
): { kind: FailKind; status?: number; detail: string } {
  if (e instanceof Anthropic.APIConnectionError) {
    return { kind: "endpoint-unreachable", detail: shorten((e as Error).message) };
  }
  if (e instanceof Anthropic.APIError && typeof e.status === "number") {
    const status = e.status;
    const msg = extractMessage(e);
    const low = msg.toLowerCase();

    if (status === 400) {
      if (low.includes("on-demand throughput") || low.includes("inference profile")) {
        return { kind: "ftu-form-missing", status, detail: msg };
      }
      if (low.includes("region") && (low.includes("not supported") || low.includes("isn't supported"))) {
        return { kind: "wrong-region", status, detail: msg };
      }
      // Bedrock reports a geo-prefixed profile used in a mismatched region as a
      // bare "invalid identifier" 400. Detect the geo/region mismatch directly
      // so we can name the real cause (wrong region) rather than "invalid id".
      if (ctx && geoMismatch(ctx.id, ctx.region)) {
        return {
          kind: "wrong-region",
          status,
          detail: `${msg} (id is a '${idGeo(ctx.id)}' inference profile but region is '${ctx.region}')`,
        };
      }
      return { kind: "invalid-model-id", status, detail: msg };
    }
    if (status === 401) return { kind: "auth-invalid", status, detail: msg };
    if (status === 403) return { kind: "iam-denied", status, detail: msg };
    if (status === 404) {
      // Bedrock 404s both for "not entitled" and "not in this region"; the
      // message usually says which. Default to model-unavailable.
      if (low.includes("region")) return { kind: "wrong-region", status, detail: msg };
      return { kind: "model-unavailable", status, detail: msg };
    }
    if (status === 429) return { kind: "rate-limited", status, detail: msg };
    if (status >= 500) return { kind: "server-error", status, detail: msg };
    return { kind: "unknown", status, detail: msg };
  }
  return { kind: "unknown", detail: shorten((e as Error)?.message ?? String(e)) };
}

function extractMessage(e: InstanceType<typeof Anthropic.APIError>): string {
  // Bedrock error bodies vary; prefer a nested message, fall back to e.message.
  const err = e.error as unknown;
  if (err && typeof err === "object") {
    const anyErr = err as Record<string, unknown>;
    const nested = anyErr.message ?? (anyErr.error as Record<string, unknown> | undefined)?.message;
    if (typeof nested === "string" && nested.trim()) return shorten(nested);
  }
  return shorten(e.message);
}

function shorten(s: string, n = 240): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

const KIND_LABEL: Record<FailKind, string> = {
  "ftu-form-missing": "FTU form missing — needs an inference-profile id (on-demand rejects the bare foundation id)",
  "model-unavailable": "model unavailable — not present or account not entitled in this region",
  "wrong-region": "wrong region — model/profile not offered in this region",
  "invalid-model-id": "invalid model id — malformed or unknown",
  "iam-denied": "IAM denied — principal lacks bedrock:InvokeModel* for this model",
  "auth-invalid": "auth invalid — bearer token / AWS credentials rejected",
  "endpoint-unreachable": "endpoint unreachable — host did not resolve/connect",
  "rate-limited": "rate limited — throttled (the model itself is reachable)",
  "server-error": "server error — Bedrock 5xx",
  unknown: "unknown error",
};

// --- probing -------------------------------------------------------------------

type ProbeClient = Pick<AnthropicBedrock, "messages">;

async function probe(client: ProbeClient, id: string, region: string): Promise<ProbeResult> {
  try {
    const msg = await client.messages.create({
      model: id,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
    return { id, ok: true, modelReturned: msg.model };
  } catch (e) {
    const { kind, status, detail } = classify(e, { id, region });
    return { id, ok: false, kind, status, detail };
  }
}

function mark(ok: boolean): string {
  return ok ? c.green("✓") : c.red("✗");
}

function printProbe(r: ProbeResult, indent = "    "): void {
  if (r.ok) {
    const echoed = r.modelReturned && r.modelReturned !== r.id ? c.dim(` → returned ${r.modelReturned}`) : "";
    line(`${indent}${mark(true)} ${r.id}${echoed}`);
  } else {
    line(`${indent}${mark(false)} ${r.id}`);
    line(`${indent}    ${c.yellow(KIND_LABEL[r.kind ?? "unknown"])}${r.status ? c.dim(` [${r.status}]`) : ""}`);
    if (r.detail) line(`${indent}    ${c.dim(r.detail)}`);
  }
}

// --- candidate models ----------------------------------------------------------

/** Bedrock geo prefix for cross-region inference profiles, from the region. */
function geoPrefix(region: string): string {
  if (region.startsWith("eu-")) return "eu";
  if (region.startsWith("ap-")) return "apac";
  return "us"; // us-*, and a reasonable default elsewhere
}

/** The geo prefix embedded in an inference-profile id (us./eu./apac.), or null. */
function idGeo(id: string): string | null {
  const m = /^(us|eu|apac)\./.exec(id);
  return m ? (m[1] ?? null) : null;
}

/** True when an id's geo prefix contradicts the configured region's geo. */
function geoMismatch(id: string, region: string): boolean {
  const g = idGeo(id);
  return g !== null && g !== geoPrefix(region);
}

/** A small, current spread of Claude models on Bedrock, in inference-profile form. */
function candidateModels(region: string): string[] {
  const g = geoPrefix(region);
  return [
    `${g}.anthropic.claude-opus-4-8`,
    `${g}.anthropic.claude-sonnet-4-5-20250929-v1:0`,
    `${g}.anthropic.claude-3-7-sonnet-20250219-v1:0`,
    `${g}.anthropic.claude-3-5-sonnet-20241022-v2:0`,
    `${g}.anthropic.claude-3-5-haiku-20241022-v1:0`,
  ];
}

/** Rank working ids to recommend one: configured first, then newest/most-capable. */
function recommend(configured: string, working: string[]): string | null {
  if (working.includes(configured)) return configured;
  const order = ["opus-4-8", "sonnet-4-5", "3-7-sonnet", "3-5-sonnet", "haiku", "anthropic.claude"];
  for (const needle of order) {
    const hit = working.find((id) => id.includes(needle));
    if (hit) return hit;
  }
  return working[0] ?? null;
}

// --- fast-failing clients for probing -----------------------------------------

function makeRuntime(cfg: Config): AnthropicBedrock {
  return new AnthropicBedrock({
    awsRegion: cfg.model.region,
    ...(cfg.model.apiKey ? { apiKey: cfg.model.apiKey } : {}),
    timeout: 20000,
    maxRetries: 0,
  });
}

function makeMantle(cfg: Config): AnthropicBedrockMantle {
  return new AnthropicBedrockMantle({
    awsRegion: cfg.model.region,
    ...(cfg.model.apiKey ? { apiKey: cfg.model.apiKey } : {}),
    timeout: 20000,
    maxRetries: 0,
  });
}

// --- main ----------------------------------------------------------------------

export async function runModelsDoctor(cfg: Config): Promise<number> {
  const region = cfg.model.region;
  const authLabel = authModeLabel(cfg.model.authMode);
  const configured = cfg.model.modelId;

  line();
  line(c.bold("co doctor --models"));
  line();

  // (1) Header: region, endpoint mode, auth mode, configured model.
  line(c.dim("  setup"));
  line(`    ${"region".padEnd(16)} ${c.dim(region)}`);
  line(`    ${"endpoint mode".padEnd(16)} ${c.dim("runtime — AnthropicBedrock (bedrock-runtime)")}`);
  line(`    ${"auth mode".padEnd(16)} ${cfg.model.authMode === "none" ? c.red(authLabel) : c.dim(authLabel)}`);
  line(`    ${"configured model".padEnd(16)} ${c.dim(configured)}`);
  line();

  // Surface the exact SigV4-vs-bearer mismatch this project hit.
  const mismatch = bearerMismatchWarning(cfg.model.authMode);
  if (mismatch) {
    line(c.yellow("  warning: " + mismatch[0]));
    for (const l of mismatch.slice(1)) line(l ? c.dim("  " + l) : "");
    line();
  }

  if (cfg.model.authMode === "none") {
    line(c.red("  no usable credentials — run `co auth bedrock` (or set AWS creds), then retry."));
    line();
    return 1;
  }

  const runtime = makeRuntime(cfg);
  const working = new Set<string>();
  const record = (r: ProbeResult) => {
    if (r.ok) working.add(r.id);
    return r;
  };

  // (2) Probe the configured model on the runtime path.
  line(c.dim("  configured model (runtime)"));
  const configuredResult = record(await probe(runtime, configured, region));
  printProbe(configuredResult);
  line();

  // (5) Runtime vs Mantle for the configured id (Mantle is implemented, so compare).
  line(c.dim("  runtime vs mantle (configured id)"));
  const runtimeCmp = configuredResult; // already probed above
  const mantleCmp = await probe(makeMantle(cfg), configured, region);
  line(`    ${c.bold("runtime")} ${mantleOrRuntimeSummary(runtimeCmp)}`);
  printProbe(runtimeCmp, "      ");
  line(`    ${c.bold("mantle ")} ${mantleOrRuntimeSummary(mantleCmp)}`);
  printProbe(mantleCmp, "      ");
  if (runtimeCmp.ok && !mantleCmp.ok) {
    line(c.dim("    → this account/key works on the runtime path but not Mantle; stay on runtime."));
  } else if (!runtimeCmp.ok && mantleCmp.ok) {
    line(c.dim("    → Mantle works here but runtime does not; the app's endpoint choice may need revisiting."));
  }
  line();

  // (4) Claude Code config + probe its model ids — answers the key question.
  const cc = readClaudeCodeSettings();
  line(c.dim("  Claude Code config (~/.claude/settings.json, secrets redacted)"));
  if (!cc) {
    line(`    ${c.dim("not found — skipping")}`);
    line();
  } else {
    if (Object.keys(cc.env).length === 0) {
      line(`    ${c.dim("no MODEL/REGION/BEDROCK/AWS/CLAUDE keys in .env")}`);
    } else {
      for (const [k, v] of Object.entries(cc.env)) {
        line(`    ${c.cyan(k)} ${c.dim("=")} ${v}`);
      }
    }
    line();
    if (cc.modelIds.length) {
      line(c.dim("  what Claude Code actually uses — probed on THIS path (runtime)"));
      for (const id of cc.modelIds) {
        printProbe(record(await probe(runtime, id, region)));
      }
      const ccWorking = cc.modelIds.filter((id) => working.has(id));
      line();
      if (ccWorking.length) {
        line(
          c.green(
            `  → Claude Code's configured model(s) that actually answer here: ${ccWorking.join(", ")}`,
          ),
        );
      } else {
        line(
          c.yellow(
            "  → none of Claude Code's configured model ids answered on this path — its success likely came from a different region, endpoint, or a Bedrock ID format not captured in settings.json.",
          ),
        );
      }
      line();
    }
  }

  // (3) If the configured model failed, sweep candidates to find something that works.
  if (!configuredResult.ok) {
    line(c.yellow(`  configured model failed (${KIND_LABEL[configuredResult.kind ?? "unknown"]}).`));
    line(c.dim("  probing candidate Claude models for this region…"));
    for (const id of candidateModels(region)) {
      if (id === configured) continue;
      printProbe(record(await probe(runtime, id, region)));
    }
    line();
  }

  // (4) Recommend a BEDROCK_MODEL_ID that actually works.
  const rec = recommend(configured, [...working]);
  line(c.dim("  recommendation"));
  if (rec) {
    if (rec === configured && configuredResult.ok) {
      line(c.green(`    configured model works. keep:`));
    } else {
      line(c.yellow(`    configured model is not the best working option. use:`));
    }
    line(`    ${c.bold(`BEDROCK_MODEL_ID=${rec}`)}`);
  } else {
    line(c.red("    no probed model answered on this path. check region, entitlement, and IAM (see errors above)."));
  }
  line();

  return configuredResult.ok || working.size > 0 ? 0 : 1;
}

function mantleOrRuntimeSummary(r: ProbeResult): string {
  return r.ok ? c.green("works") : c.red(`fails (${r.kind})`);
}
