import fsp from "node:fs/promises";
import path from "node:path";
import type { InstancePaths } from "../paths.js";
import { serializeWrite, notifyWrite } from "./writequeue.js";

/**
 * The user-facing document tier: flat markdown under an instance's `docs/`.
 *
 * This is the co-manager's only general-purpose file surface, and it is
 * deliberately narrow. It can address exactly one thing — a `*.md` file sitting
 * directly in this instance's `docs/` — and is structurally incapable of
 * reaching the `.memory/` substrate, `.env`, anything else under CO_HOME, or any
 * path outside the instance. Names are validated as bare filenames (no
 * separators, no traversal, no absolute paths) and then the resolved real path
 * is re-checked against the real `docs/` directory, so a symlink planted inside
 * `docs/` cannot be used to escape either.
 *
 * Errors are structured: a machine-readable code plus a sentence that says what
 * to do next, because the caller is a model choosing its next tool call.
 */

export type DocErrorCode =
  | "INVALID_DOC_NAME"
  | "DOC_NOT_FOUND"
  | "DOC_EXISTS"
  | "DOC_NOT_A_FILE"
  | "PATH_ESCAPE"
  | "NO_MATCH"
  | "MULTIPLE_MATCHES"
  | "DOC_CHANGED";

export class DocError extends Error {
  constructor(
    readonly code: DocErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DocError";
  }
}

/**
 * A legal document name: a bare `.md` filename. Leading dot is out (no `.env`,
 * no dotfiles), as are separators, traversal, and anything a shell or a
 * filesystem would find surprising.
 */
const DOC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

export function isValidDocName(name: string): boolean {
  if (!DOC_NAME_RE.test(name)) return false;
  if (name.includes("..")) return false;
  // Redundant with the pattern, but stated explicitly: this is the guard that
  // matters most, so it should not depend on reading a regex correctly.
  if (name.includes("/") || name.includes("\\")) return false;
  if (path.basename(name) !== name) return false;
  if (path.isAbsolute(name)) return false;
  return true;
}

async function ensureDocsDir(paths: InstancePaths): Promise<void> {
  await fsp.mkdir(paths.docs, { recursive: true });
}

/**
 * Validate a name and resolve it to an absolute path inside `docs/`, proving
 * the result really is in `docs/` on disk (not via a symlink pointing out).
 * Called by every command, including the ones that only read.
 */
export async function resolveDocPath(paths: InstancePaths, name: string): Promise<string> {
  if (!isValidDocName(name)) {
    throw new DocError(
      "INVALID_DOC_NAME",
      `"${name}" is not a valid doc name. Use a bare markdown filename such as "plan.md": ` +
        `no directories, no path traversal, no absolute paths. docs/ is flat.`,
    );
  }
  await ensureDocsDir(paths);
  const realDocs = await fsp.realpath(paths.docs);
  const target = path.join(realDocs, name);

  // If something already exists at the target, it must be a regular file that
  // is not a symlink — a symlink inside docs/ is the one way a valid-looking
  // name could still address a file outside the sandbox.
  let stat: Awaited<ReturnType<typeof fsp.lstat>> | null = null;
  try {
    stat = await fsp.lstat(target);
  } catch {
    stat = null;
  }
  if (stat?.isSymbolicLink()) {
    throw new DocError(
      "PATH_ESCAPE",
      `"${name}" is a symbolic link. The doc tool only operates on real files inside docs/.`,
    );
  }
  if (stat && !stat.isFile()) {
    throw new DocError("DOC_NOT_A_FILE", `"${name}" is not a regular file.`);
  }
  if (path.dirname(target) !== realDocs) {
    throw new DocError("PATH_ESCAPE", `"${name}" resolves outside docs/.`);
  }
  return target;
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
}

function notFound(name: string): DocError {
  return new DocError(
    "DOC_NOT_FOUND",
    `No doc named "${name}" in docs/. Use the list command to see what exists.`,
  );
}

/** Every `.md` file directly inside docs/, sorted. Missing docs/ lists empty. */
export async function listDocs(paths: InstancePaths): Promise<string[]> {
  let entries;
  try {
    entries = await fsp.readdir(paths.docs, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && isValidDocName(e.name))
    .map((e) => e.name)
    .sort();
}

/** Create a new doc. Refuses to clobber: overwrite is the explicit way to do that. */
export async function createDoc(
  paths: InstancePaths,
  name: string,
  content: string,
): Promise<{ name: string; bytes: number }> {
  return serializeWrite(async () => {
    const file = await resolveDocPath(paths, name);
    const body = content.endsWith("\n") ? content : content + "\n";
    try {
      await fsp.writeFile(file, body, { encoding: "utf8", flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        throw new DocError(
          "DOC_EXISTS",
          `"${name}" already exists. Use the overwrite command to replace it, or str_replace to edit part of it.`,
        );
      }
      throw e;
    }
    notifyWrite({ kind: "doc", name });
    return { name, bytes: Buffer.byteLength(body) };
  });
}

export async function readDoc(paths: InstancePaths, name: string): Promise<string> {
  const file = await resolveDocPath(paths, name);
  const content = await readIfExists(file);
  if (content === null) throw notFound(name);
  return content;
}

/**
 * Replace a unique occurrence of `oldStr` with `newStr`, following the native
 * editor's semantics: the match must appear exactly once. Zero matches or more
 * than one is an error, never a guess — an ambiguous edit silently applied to
 * the wrong place is far worse than a retry with a longer anchor.
 */
export async function strReplaceDoc(
  paths: InstancePaths,
  name: string,
  oldStr: string,
  newStr: string,
): Promise<{ name: string; replacedAtLine: number }> {
  // Serialized: read-modify-write, so a concurrent write to the same doc within
  // one tool round would be silently lost. See writequeue.ts.
  return serializeWrite(async () => {
    const file = await resolveDocPath(paths, name);
    const content = await readIfExists(file);
    if (content === null) throw notFound(name);

    if (oldStr === "") {
      throw new DocError(
        "NO_MATCH",
        `old_str is empty. Give the exact text to replace, or use overwrite to rewrite "${name}" in full.`,
      );
    }
    const first = content.indexOf(oldStr);
    if (first === -1) {
      throw new DocError(
        "NO_MATCH",
        `old_str was not found in "${name}". Read the doc and copy the target text exactly, whitespace included.`,
      );
    }
    if (content.indexOf(oldStr, first + 1) !== -1) {
      throw new DocError(
        "MULTIPLE_MATCHES",
        `old_str appears more than once in "${name}". Include more surrounding context to make it unique.`,
      );
    }
    const updated = content.slice(0, first) + newStr + content.slice(first + oldStr.length);
    await fsp.writeFile(file, updated, "utf8");
    notifyWrite({ kind: "doc", name });
    return { name, replacedAtLine: content.slice(0, first).split("\n").length };
  });
}

/** Replace a doc's whole content. Creates it if it does not exist yet. */
export async function overwriteDoc(
  paths: InstancePaths,
  name: string,
  content: string,
): Promise<{ name: string; bytes: number; created: boolean }> {
  return serializeWrite(async () => {
    const file = await resolveDocPath(paths, name);
    const existed = (await readIfExists(file)) !== null;
    const body = content.endsWith("\n") ? content : content + "\n";
    await fsp.writeFile(file, body, "utf8");
    notifyWrite({ kind: "doc", name });
    return { name, bytes: Buffer.byteLength(body), created: !existed };
  });
}

/**
 * Replace a doc's whole content, but only if it still holds `baseline`.
 *
 * The write behind the Ctrl-O panel's doc editor. The captain opens a doc,
 * types into a buffer for as long as they like, and saves — and in that window
 * the co-manager's own doc tool can have rewritten the same file underneath
 * them. A plain overwrite would eat that silently, so the text the editor
 * OPENED on is carried back here and checked against what is on disk now.
 *
 * The read and the compare happen INSIDE the write lane (see writequeue.ts),
 * not around it: a check outside the lane is a race with any write already
 * queued, which is precisely the case it exists to catch.
 *
 * A doc that has been deleted since reads as "" and therefore mismatches, so a
 * save can never quietly resurrect a document the co removed either.
 */
export async function overwriteDocIfUnchanged(
  paths: InstancePaths,
  name: string,
  content: string,
  baseline: string,
): Promise<{ name: string; bytes: number }> {
  return serializeWrite(async () => {
    const file = await resolveDocPath(paths, name);
    const current = (await readIfExists(file)) ?? "";
    if (current !== baseline) {
      throw new DocError(
        "DOC_CHANGED",
        `"${name}" changed on disk while it was open. Nothing was written.`,
      );
    }
    const body = content.endsWith("\n") ? content : content + "\n";
    await fsp.writeFile(file, body, "utf8");
    notifyWrite({ kind: "doc", name });
    return { name, bytes: Buffer.byteLength(body) };
  });
}

/** Delete an existing doc. Refuses anything that is not an existing plain file. */
export async function deleteDoc(paths: InstancePaths, name: string): Promise<{ name: string }> {
  return serializeWrite(async () => {
    const file = await resolveDocPath(paths, name);
    let stat;
    try {
      stat = await fsp.lstat(file);
    } catch {
      throw notFound(name);
    }
    if (!stat.isFile()) {
      throw new DocError("DOC_NOT_A_FILE", `"${name}" is not a regular file; refusing to delete it.`);
    }
    await fsp.rm(file);
    notifyWrite({ kind: "doc", name });
    return { name };
  });
}

/**
 * Docs surfaced in the cold-start live-state block. They are read there but
 * written like any other doc, through the doc tool: privileged read, ordinary
 * write. Absent files are simply skipped — docs/ starts empty and a document is
 * born when its workflow begins.
 */
export const SURFACED_DOCS = ["architecture.md", "plan.md"] as const;

export interface SurfacedDoc {
  name: string;
  content: string;
}

/**
 * Character budget for a doc surfaced into the system prompt.
 *
 * These docs get a privileged cold-start read, which means they sit in the cache
 * prefix and are re-sent on every ROUND of every turn for the whole session — so
 * an unbounded one is charged tens of times per session for content most turns
 * never touch. On measured instances `architecture.md` had reached 19,276
 * characters, a fifth of the entire prefix, with no size discipline anywhere in
 * this path.
 *
 * A budget rather than a hard failure: the doc is the captain's, the co only
 * borrows it, and a session must never refuse to start over the size of a
 * markdown file. Over budget it is truncated with a pointer to the `doc` tool,
 * which can read the whole thing on demand.
 */
export const SURFACED_DOC_MAX_CHARS = 8_000;

/** Cut at a paragraph boundary where possible, so the tail is not a half
 *  sentence, and say plainly that there is more. */
function budget(name: string, content: string, max: number): string {
  if (content.length <= max) return content;
  const head = content.slice(0, max);
  const brk = head.lastIndexOf("\n\n");
  const kept = brk > max * 0.6 ? head.slice(0, brk) : head;
  return (
    kept +
    `\n\n_[Truncated at ${max.toLocaleString("en-US")} characters to keep it out of` +
    ` every turn's context. This document is longer than what you see here: read` +
    ` the whole of it with \`doc read ${name}\` when you need the rest, and consider` +
    ` proposing a trim to the captain.]_`
  );
}

export async function readSurfacedDocs(paths: InstancePaths): Promise<SurfacedDoc[]> {
  const out: SurfacedDoc[] = [];
  for (const name of SURFACED_DOCS) {
    const content = await readIfExists(paths.docFile(name));
    if (content !== null && content.trim()) {
      out.push({ name, content: budget(name, content, SURFACED_DOC_MAX_CHARS) });
    }
  }
  return out;
}
