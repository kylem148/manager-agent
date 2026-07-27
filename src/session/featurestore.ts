import fsp from "node:fs/promises";
import path from "node:path";
import type { InstancePaths } from "../paths.js";
import { serializeWrite } from "../memory/writequeue.js";

/**
 * The durable half of a feature record: what git cannot tell us.
 *
 * A feature is otherwise fully recoverable from disk — the boot reconcile
 * (worktrees.ts `reconcileFeatures`) rebuilds a record for every feature
 * worktree it finds, so the branch, the checkout and the slug all survive a
 * restart on their own. What does NOT survive is the PROSE the co wrote about the
 * feature, which lives nowhere in git: the INTENT (the one-line description
 * authored at `feature_create` time) and, since the authored-PR-message slice,
 * the PR TITLE and BODY the co composes when it enqueues a finished feature.
 * Both used to live only in a Map that died with the session — which made the
 * Ctrl-O features tab lie after every restart, and would make a re-processed head
 * silently fall back to the mechanical PR message.
 *
 * So that prose is persisted here, keyed by slug (the handle that survives — the
 * human name is not recoverable from a branch), as a small JSON object under the
 * instance's `.dispatch/` dir: the same tier the dispatch config, the review
 * inbox and the per-job captures live in, since a feature worktree is dispatch
 * state. Never written into the user's repo, and never into the worktree itself
 * (a file there would show up as an untracked change in the captain's diff).
 *
 * It is a CACHE of authored prose, not a source of truth about anything: a
 * missing, corrupt or unwritable file degrades to "no description" (and, for the
 * PR message, to landing.ts's mechanical composition) and must never fail a
 * create, an enqueue, a merge or a session start. Writes therefore swallow their
 * own errors and ride the shared memory write queue, so a whole-file rewrite
 * can't interleave with the other tool calls of one model round.
 */

/** Everything stored about one feature. Every field is optional and independent:
 *  a feature may have an intent and no PR message, a PR title and no body, or
 *  nothing at all (in which case it holds no row). */
export interface FeatureMeta {
  /** The one-line description the co gave at create time. */
  intent?: string;
  /** The PR title the co authored at enqueue time. Consumed by landing.ts; the
   *  mechanical composition applies when it is absent. */
  prTitle?: string;
  /** The PR description the co authored at enqueue time — human prose only. co's
   *  fenced evidence block is never part of it (it is stripped before storing and
   *  regenerated on top at prepare time). */
  prBody?: string;
}

/** The on-disk shape: `{ "<slug>": { intent?, prTitle?, prBody? } }`.
 *
 * A bare string value is the LEGACY shape (`{ "<slug>": "<intent>" }`, all this
 * file held before the PR message joined it) and is read as an intent-only row,
 * so a store written by an older build keeps every description it had. Writes are
 * always the object form. */
export type StoredFeatures = Record<string, FeatureMeta | string>;

/** A trimmed non-empty string, or undefined — the only thing worth storing. */
function text(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Coerce one row. A string is the legacy intent-only form; an object keeps only
 *  the fields it declares, as non-empty strings. Returns undefined for a row with
 *  nothing left in it, so junk never becomes an empty entry. */
function coerceMeta(raw: unknown): FeatureMeta | undefined {
  const legacy = text(raw);
  if (legacy) return { intent: legacy };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const meta: FeatureMeta = {};
  const intent = text(o.intent);
  const prTitle = text(o.prTitle);
  const prBody = text(o.prBody);
  if (intent) meta.intent = intent;
  if (prTitle) meta.prTitle = prTitle;
  if (prBody) meta.prBody = prBody;
  return Object.keys(meta).length === 0 ? undefined : meta;
}

/** Drop anything that isn't a slug → usable row, so a hand-edited or half-written
 *  file can never poison the panel, a PR message, or the next write. */
function coerce(raw: unknown): Map<string, FeatureMeta> {
  const out = new Map<string, FeatureMeta>();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [slug, row] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof slug !== "string" || slug === "") continue;
    const meta = coerceMeta(row);
    if (meta) out.set(slug, meta);
  }
  return out;
}

export class FeatureStore {
  private readonly features: Map<string, FeatureMeta>;

  private constructor(
    private readonly filePath: string,
    features: Map<string, FeatureMeta>,
  ) {
    this.features = features;
  }

  /**
   * Read the store from disk. A missing file is an empty store (the common first
   * run); a corrupt or unreadable one is ALSO an empty store rather than a failed
   * session start — a broken cache of descriptions must never stop the co
   * opening.
   */
  static async load(paths: InstancePaths): Promise<FeatureStore> {
    const file = paths.featureStore;
    try {
      const raw = await fsp.readFile(file, "utf8");
      return new FeatureStore(file, coerce(JSON.parse(raw)));
    } catch {
      return new FeatureStore(file, new Map());
    }
  }

  /** In-memory store with no file behind it, for tests and degraded paths (an
   *  unlinked instance has no `.dispatch/` tier to write into). Seeds accept
   *  either shape, exactly as the file does. */
  static ephemeral(seed: StoredFeatures = {}): FeatureStore {
    return new FeatureStore("", coerce(seed));
  }

  /** The stored one-liner for a slug, or undefined when none was ever set. */
  intent(slug: string): string | undefined {
    return this.features.get(slug)?.intent;
  }

  /**
   * The PR title and body the co authored for a feature, or undefined when it
   * never authored one. Both fields are independently optional: a feature may
   * carry a title and no body, and landing.ts falls back to its mechanical
   * composition for whichever half is missing.
   */
  prMessage(slug: string): { prTitle?: string; prBody?: string } | undefined {
    const meta = this.features.get(slug);
    if (!meta || (!meta.prTitle && !meta.prBody)) return undefined;
    return {
      ...(meta.prTitle ? { prTitle: meta.prTitle } : {}),
      ...(meta.prBody ? { prBody: meta.prBody } : {}),
    };
  }

  /** Everything stored, as a plain object (a copy — callers must not mutate the
   *  store through it). */
  all(): Record<string, FeatureMeta> {
    return Object.fromEntries([...this.features].map(([slug, meta]) => [slug, { ...meta }]));
  }

  get size(): number {
    return this.features.size;
  }

  /**
   * Record a feature's intent. Blank input is a no-op rather than a stored empty
   * string: a create with no intent must not wipe the description an earlier
   * create set. The in-memory map updates synchronously so the very next paint
   * sees it; the returned promise resolves when the file has been rewritten.
   */
  setIntent(slug: string, intent: string): Promise<void> {
    return this.update(slug, { intent });
  }

  /**
   * Record the PR message the co authored for a feature at enqueue time. Each
   * field is an INDEPENDENT override: supplying one replaces the stored value,
   * OMITTING one (or passing blank) leaves whatever is stored alone. That is what
   * makes a re-enqueue with no arguments — the retry after a resolver run, or any
   * automatic re-process — reuse the message the co already wrote instead of
   * wiping it back to the mechanical fallback.
   *
   * `allowClear` is the one caller that means it: the captain editing the message
   * in the Ctrl-O panel (D-20260727-15). A description they deleted must not come
   * back the next time a PR is created for that feature, so there a supplied-but-
   * empty field really does erase the stored one. An omitted field still leaves
   * it alone, so the rule that protects a bare re-enqueue is untouched.
   */
  setPrMessage(
    slug: string,
    message: { prTitle?: string; prBody?: string },
    opts: { allowClear?: boolean } = {},
  ): Promise<void> {
    return this.update(slug, message, opts);
  }

  /** Drop everything stored for a feature — it landed, or it was abandoned. A
   *  no-op for a slug that was never stored, so teardown paths can call it
   *  blindly. */
  forget(slug: string): Promise<void> {
    if (!this.features.delete(slug)) return Promise.resolve();
    return this.persist();
  }

  /** Merge non-blank fields into a feature's row, and persist only if something
   *  actually changed. The single write path: every setter is this, so "blank
   *  never wipes" and "unchanged never rewrites" hold for every field at once —
   *  except for a caller that passes `allowClear` and an explicit empty string,
   *  which is a deliberate erase (see setPrMessage). A row left with no fields at
   *  all is dropped rather than stored as an empty object. */
  private update(
    slug: string,
    patch: FeatureMeta,
    opts: { allowClear?: boolean } = {},
  ): Promise<void> {
    if (slug === "") return Promise.resolve();
    const current = this.features.get(slug);
    const next: FeatureMeta = { ...current };
    let changed = false;
    for (const key of ["intent", "prTitle", "prBody"] as const) {
      if (!(key in patch)) continue; // omitted: never touched
      const value = text(patch[key]);
      if (value === undefined) {
        if (!opts.allowClear || next[key] === undefined) continue;
        delete next[key];
        changed = true;
        continue;
      }
      if (next[key] === value) continue;
      next[key] = value;
      changed = true;
    }
    if (!changed) return Promise.resolve();
    if (Object.keys(next).length === 0) this.features.delete(slug);
    else this.features.set(slug, next);
    return this.persist();
  }

  /**
   * Rewrite the whole file. It is a handful of short lines, so a rewrite is
   * cheaper than any merge scheme would be, and it rides the shared serialized
   * write lane for the same reason the review inbox does.
   *
   * NEVER REJECTS. Callers reach this from a create, a merge and a teardown —
   * paths where failing on a cosmetic cache would cost real work — so a write
   * error degrades to "the description won't survive this restart" and nothing
   * more. The in-memory map is already updated either way.
   */
  private async persist(): Promise<void> {
    if (this.filePath === "") return;
    const snapshot = this.all();
    const file = this.filePath;
    try {
      await serializeWrite(async () => {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
      });
    } catch {
      // A description that didn't make it to disk is not worth failing a feature
      // operation over. See the class comment.
    }
  }
}
