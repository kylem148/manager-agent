import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import * as readline from "node:readline";
import type { Config } from "../config.js";
import { redactSecret } from "../config.js";
import { c, line } from "../ui.js";

/**
 * `co auth bedrock` — set up the Bedrock bearer token for comanager.
 *
 * comanager needs its OWN Bedrock credential; it does not read Claude Code's
 * token. This writes AWS_BEARER_TOKEN_BEDROCK into ~/co-managers/.env (mode
 * 0600) and ensures AWS_REGION + BEDROCK_MODEL_ID defaults exist. The token is
 * never echoed while typing (hidden input) and never printed back in full.
 */

const DEFAULT_REGION = "us-west-2";
const DEFAULT_MODEL = "us.anthropic.claude-opus-4-8";

export async function runAuthBedrock(cfg: Config): Promise<number> {
  const home = cfg.home;
  const envPath = path.join(home, ".env");

  await fsp.mkdir(home, { recursive: true });

  line();
  line(c.bold("co auth bedrock"));
  line(c.dim(`  Sets your Bedrock bearer token in ${envPath}`));
  line(c.dim("  comanager uses its own token — it does not read Claude Code's settings."));
  line();

  const token = await promptSecret("Paste your Bedrock bearer token (AWS_BEARER_TOKEN_BEDROCK): ");
  if (!token) {
    line(c.yellow("no token entered — nothing changed."));
    return 1;
  }

  // Upsert the token (overwrite), and add region/model only if missing.
  const existing = readEnvFileSafe(envPath);
  const updates: Record<string, string> = { AWS_BEARER_TOKEN_BEDROCK: token };
  const defaultsAdded: string[] = [];
  if (!(("AWS_REGION" in existing) && existing.AWS_REGION)) {
    updates.AWS_REGION = DEFAULT_REGION;
    defaultsAdded.push(`AWS_REGION=${DEFAULT_REGION}`);
  }
  if (!(("BEDROCK_MODEL_ID" in existing) && existing.BEDROCK_MODEL_ID)) {
    updates.BEDROCK_MODEL_ID = DEFAULT_MODEL;
    defaultsAdded.push(`BEDROCK_MODEL_ID=${DEFAULT_MODEL}`);
  }

  const merged = upsertEnv(readRawSafe(envPath), updates);
  await writeEnvSecure(envPath, merged);

  line();
  line(c.green(`saved AWS_BEARER_TOKEN_BEDROCK=${redactSecret(token)}`));
  for (const d of defaultsAdded) line(c.dim(`added ${d}`));
  line(c.dim(`file: ${envPath}${permissionNote(envPath)}`));
  line();
  line(c.dim("verify with:  co doctor --models"));
  return 0;
}

/**
 * Prompt for a secret with echo suppressed where possible. On a TTY we mute
 * keystroke output; if that's not possible we warn that input will be visible.
 */
function promptSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  const canHide = Boolean(input.isTTY);

  if (!canHide) {
    // Non-interactive (piped) — read a single line, note it may be visible.
    line(c.yellow("note: input is not a TTY; the token may be visible in your terminal/history."));
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output, terminal: canHide });

    // Mute echo: intercept the readline's output writes while capturing input.
    let muted = canHide;
    const realWrite = (output.write as (...a: unknown[]) => boolean).bind(output);
    if (canHide) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (rl as any)._writeToOutput = (chunk: string) => {
        // Allow the prompt itself through once; suppress typed characters.
        if (muted && !chunk.includes(prompt)) return;
        realWrite(chunk);
      };
    }

    output.write(prompt);
    rl.question("", (answer) => {
      muted = false;
      rl.close();
      if (canHide) output.write("\n"); // terminate the (hidden) input line
      resolve(answer.trim());
    });
  });
}

// --- .env read / merge / write -------------------------------------------------

function readRawSafe(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Parse KEY=VALUE lines into a map (best-effort; comments/blank lines ignored). */
function readEnvFileSafe(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readRawSafe(file).split("\n")) {
    const lineTrim = raw.trim();
    if (!lineTrim || lineTrim.startsWith("#")) continue;
    const eq = lineTrim.indexOf("=");
    if (eq <= 0) continue;
    const key = lineTrim.slice(0, eq).trim();
    const val = lineTrim.slice(eq + 1).trim();
    out[key] = val;
  }
  return out;
}

/**
 * Return the env-file text with the given keys upserted: existing uncommented
 * assignments are replaced in place (preserving surrounding lines/comments);
 * new keys are appended. Values are written raw (tokens are single-line).
 */
function upsertEnv(content: string, updates: Record<string, string>): string {
  const lines = content.length ? content.split("\n") : [];
  const remaining = new Set(Object.keys(updates));

  const rewritten = lines.map((ln) => {
    const trimmed = ln.trim();
    if (!trimmed || trimmed.startsWith("#")) return ln;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return ln;
    const key = trimmed.slice(0, eq).trim();
    if (remaining.has(key)) {
      remaining.delete(key);
      return `${key}=${updates[key]}`;
    }
    return ln;
  });

  const additions: string[] = [];
  for (const key of Object.keys(updates)) {
    if (remaining.has(key)) additions.push(`${key}=${updates[key]}`);
  }

  let body = rewritten.join("\n");
  if (additions.length) {
    if (body.length && !body.endsWith("\n")) body += "\n";
    body += additions.join("\n") + "\n";
  } else if (body.length && !body.endsWith("\n")) {
    body += "\n";
  }
  return body;
}

/** Write the env file with 0600 perms (best-effort on platforms that support it). */
async function writeEnvSecure(file: string, content: string): Promise<void> {
  await fsp.writeFile(file, content, { encoding: "utf8", mode: 0o600 });
  try {
    await fsp.chmod(file, 0o600); // ensure perms even if the file pre-existed
  } catch {
    // Non-POSIX filesystem; perms may not be enforceable.
  }
}

function permissionNote(file: string): string {
  try {
    const mode = fs.statSync(file).mode & 0o777;
    return mode === 0o600 ? " (mode 0600)" : ` (mode ${mode.toString(8)})`;
  } catch {
    return "";
  }
}
