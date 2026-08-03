import fs from "node:fs";

/**
 * Reading and rewriting `KEY=VALUE` env files in place.
 *
 * At the root, and shared, for the same reason confirmverb.ts is: two layers
 * write one of these files — `co auth bedrock` writes the token into the home
 * `.env`, and `/model` writes the model id into an instance's own `.env` — and
 * two spellings of "replace a key without disturbing the file around it" would
 * drift. The drift here costs a captain's hand-written config, so it is one
 * implementation.
 *
 * Deliberately not dotenv's writer (there isn't one) and deliberately not a
 * parse-and-reserialize: a `.env` is a file people edit by hand, with comments
 * and ordering they meant, and rewriting it from a parsed map silently deletes
 * both.
 */

/** A file's text, or "" if it doesn't exist or can't be read. */
export function readEnvText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * Parse `KEY=VALUE` lines into a map. Comments and blank lines are ignored;
 * best-effort by design, because this only ever answers "is this key set here",
 * never "what does the whole file mean".
 */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/** The keys set in an env file on disk (missing file => no keys). */
export function readEnvFile(file: string): Record<string, string> {
  return parseEnvText(readEnvText(file));
}

/**
 * Return the env-file text with the given keys upserted: an existing
 * uncommented assignment is replaced in place, preserving every surrounding
 * line and comment; a key not already there is appended. Values are written
 * raw — everything this writes is single-line and unquoted.
 *
 * A commented-out assignment is left commented and the key appended below it,
 * which is the conservative reading: the captain commented that line out on
 * purpose, and un-commenting it would be an edit nobody asked for.
 */
export function upsertEnv(content: string, updates: Record<string, string>): string {
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
