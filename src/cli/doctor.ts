import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import { authModeLabel, bearerMismatchWarning } from "../config.js";
import { describeSearch } from "../research.js";
import { ModelProvider } from "../model.js";
import { instancesDir, instancePaths } from "../paths.js";
import { listInstances } from "../memory/memory.js";
import { readDispatchConfig } from "../session/dispatchconfig.js";
import { checkRepoPath } from "../session/worktrees.js";
import { c, line } from "../ui.js";

type Status = "ok" | "warn" | "fail";

interface Check {
  name: string;
  status: Status;
  detail: string;
}

function mark(s: Status): string {
  if (s === "ok") return c.green("✓");
  if (s === "warn") return c.yellow("!");
  return c.red("✗");
}

/** Resolve the installed runtime path + version from this module's location. */
function runtimeInfo(): { entry: string; version: string } {
  const here = fileURLToPath(import.meta.url); // <pkg>/dist/cli/doctor.js
  const distRoot = path.dirname(path.dirname(here)); // <pkg>/dist
  const entry = path.join(distRoot, "index.js");
  let version = "unknown";
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(distRoot, "..", "package.json"), "utf8"),
    ) as { version?: string };
    if (pkg.version) version = pkg.version;
  } catch {
    // package.json not found next to dist/ — leave version unknown
  }
  return { entry, version };
}

/** Report where configuration is coming from: real env vars and/or .env files. */
function configSources(home: string): string {
  const sources: string[] = [];
  const cwdEnv = path.join(process.cwd(), ".env");
  const homeEnv = path.join(home, ".env");
  if (fs.existsSync(cwdEnv)) sources.push(cwdEnv);
  if (fs.existsSync(homeEnv)) sources.push(homeEnv);
  const hasRealEnv = Boolean(process.env.BEDROCK_API_KEY || process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.AWS_REGION);
  if (hasRealEnv) sources.push("environment variables");
  return sources.length ? sources.join(", ") : "defaults (no .env or env vars found)";
}

/** Prettify a path under the home dir for display. */
function tildify(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/** Run environment/config diagnostics. Optionally ping the model. */
export async function runDoctor(cfg: Config, opts: { ping: boolean }): Promise<number> {
  const checks: Check[] = [];

  // Memory root writability
  try {
    await fsp.mkdir(cfg.home, { recursive: true });
    const probe = path.join(cfg.home, ".write-probe");
    await fsp.writeFile(probe, "ok");
    await fsp.rm(probe);
    checks.push({ name: "memory root", status: "ok", detail: `${tildify(cfg.home)} (writable)` });
  } catch (e) {
    checks.push({ name: "memory root", status: "fail", detail: `${tildify(cfg.home)}: ${(e as Error).message}` });
  }

  // Workspace layout: every instance should be on the two-tier docs/ + .memory/
  // layout. Flag any still carrying pre-reorg live/ or logs/ dirs; those migrate
  // automatically the next time they are opened.
  const stale = listInstances(cfg.home).filter((n) => {
    const ip = instancePaths(cfg.home, n);
    return fs.existsSync(path.join(ip.root, "live")) || fs.existsSync(path.join(ip.root, "logs"));
  });
  checks.push({
    name: "workspace layout",
    status: stale.length ? "warn" : "ok",
    detail: stale.length
      ? `${stale.length} instance(s) on the old live/+logs/ layout: ${stale.join(", ")} (migrates on next open)`
      : "two-tier (docs/ + .memory/)",
  });

  // Linked repos. Every crew dispatch and every git call in the feature layer
  // runs with the linked repoPath as its cwd, so a stale or malformed one takes
  // out both — and does it as an ENOENT from inside git plumbing, which reads
  // like a missing git rather than a bad config value. Checked here so `co
  // doctor` answers the question directly instead of leaving it to a lever to
  // fail. An unlinked instance is not a fault: dispatch is opt-in.
  const repoIssues: string[] = [];
  let linkedCount = 0;
  for (const n of listInstances(cfg.home)) {
    const dc = await readDispatchConfig(instancePaths(cfg.home, n));
    if (!dc) continue;
    linkedCount++;
    const repo = await checkRepoPath(dc.repoPath);
    if (!repo.ok) repoIssues.push(`${n} → ${repo.reason}`);
  }
  checks.push({
    name: "linked repos",
    status: repoIssues.length ? "fail" : "ok",
    detail: repoIssues.length
      ? `${repoIssues.join("; ")} — re-run \`co link <name>\``
      : linkedCount
        ? `${linkedCount} linked, each a git repository root`
        : "none linked (dispatch is opt-in)",
  });

  // Bedrock auth (bearer token preferred, SigV4 fallback)
  if (cfg.model.authMode === "bearer") {
    checks.push({ name: "auth mode", status: "ok", detail: authModeLabel("bearer") });
  } else if (cfg.model.authMode === "sigv4") {
    checks.push({ name: "auth mode", status: "ok", detail: authModeLabel("sigv4") });
  } else {
    checks.push({
      name: "auth mode",
      status: "fail",
      detail: "none found — set AWS_BEARER_TOKEN_BEDROCK (run: co auth bedrock) or AWS credentials",
    });
  }

  checks.push({ name: "region", status: cfg.model.region ? "ok" : "fail", detail: cfg.model.region || "unset" });
  checks.push({ name: "model id", status: cfg.model.modelId ? "ok" : "fail", detail: cfg.model.modelId || "unset" });

  // Research
  const searchDesc = describeSearch(cfg.research);
  checks.push({
    name: "research search",
    status: searchDesc.includes("not configured") ? "warn" : "ok",
    detail: searchDesc,
  });
  checks.push({
    name: "research fetch",
    status: "ok",
    detail: cfg.research.useJina ? "Jina Reader (+ HTTP fallback)" : "direct HTTP",
  });

  // Optional live connectivity test
  if (opts.ping) {
    const authOk = checks.find((c) => c.name === "auth mode")?.status === "ok";
    if (!authOk) {
      checks.push({ name: "model ping", status: "fail", detail: "skipped — no usable credentials" });
    } else {
      try {
        const reply = await new ModelProvider(cfg.model).ping();
        checks.push({
          name: "model ping",
          status: reply.toLowerCase().includes("ok") ? "ok" : "warn",
          detail: `reply: ${JSON.stringify(reply.slice(0, 40))}`,
        });
      } catch (e) {
        checks.push({ name: "model ping", status: "fail", detail: (e as Error).message });
      }
    }
  }

  const rt = runtimeInfo();
  const coHomeSet = Boolean(process.env.CO_HOME);

  line();
  line(c.bold("co doctor"));
  line();
  // Layer 1: the installed runtime (the app).
  line(c.dim("  runtime (the app)"));
  line(`    ${"co / comanager".padEnd(16)} ${c.dim(`v${rt.version}`)}`);
  line(`    ${"entry".padEnd(16)} ${c.dim(rt.entry)}`);
  line(`    ${"node".padEnd(16)} ${c.dim(process.version)}`);
  line(`    ${"model backend".padEnd(16)} ${c.dim("Amazon Bedrock Claude")}`);
  line();
  // Layer 2: the markdown memory workspace (the data).
  line(c.dim("  memory workspace (plain markdown — no npm here)"));
  line(
    `    ${"CO_HOME".padEnd(16)} ${c.dim(
      `${tildify(cfg.home)}${coHomeSet ? "" : " (default; set CO_HOME to override)"}`,
    )}`,
  );
  line(`    ${"instances".padEnd(16)} ${c.dim(tildify(instancesDir(cfg.home)))}`);
  line(`    ${"config source".padEnd(16)} ${c.dim(configSources(cfg.home))}`);
  line();
  line(c.dim("  checks"));
  for (const ch of checks) {
    line(`    ${mark(ch.status)} ${ch.name.padEnd(16)} ${c.dim(ch.detail)}`);
  }
  line();

  const mismatch = bearerMismatchWarning(cfg.model.authMode);
  if (mismatch) {
    line(c.yellow("  warning: " + mismatch[0]));
    for (const l of mismatch.slice(1)) line(l ? c.dim("  " + l) : "");
    line();
  }

  const hasFail = checks.some((c) => c.status === "fail");
  if (hasFail) line(c.red("some checks failed — see above."));
  else line(c.green("ready."));

  return hasFail ? 1 : 0;
}
