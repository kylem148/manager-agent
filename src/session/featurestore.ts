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
 * restart on their own. The INTENT does not: it is the one-line description the
 * co authored at `feature_create` time, it lives nowhere in git, and until now it
 * lived only in a Map that died with the session. That made the Ctrl-O features
 * tab lie after every restart — every recovered worktree showed up nameless.
 *
 * So intents are persisted here, keyed by slug (the handle that survives — the
 * human name is not recoverable from a branch), as a small JSON object under the
 * instance's `.dispatch/` dir: the same tier the dispatch config, the review
 * inbox and the per-job captures live in, since a feature worktree is dispatch
 * state. Never written into the user's repo, and never into the worktree itself
 * (a file there would show up as an untracked change in the captain's diff).
 *
 * It is a CACHE of authored prose, not a source of truth about anything: a
 * missing, corrupt or unwritable file degrades to "no description" and must never
 * fail a create, a merge or a session start. Writes therefore swallow their own
 * errors and ride the shared memory write queue, so a whole-file rewrite can't
 * interleave with the other tool calls of one model round.
 */

/** The on-disk shape: `{ "<slug>": "<intent>" }`. Deliberately the smallest
 *  thing that works — one authored line per feature, obvious to read and safe to
 *  hand-edit. */
export type FeatureIntents = Record<string, string>;

/** Drop anything that isn't a slug → non-empty-string pair, so a hand-edited or
 *  half-written file can never poison the panel or the next write. */
function coerce(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [slug, intent] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof slug !== "string" || slug === "") continue;
    if (typeof intent !== "string") continue;
    const trimmed = intent.trim();
    if (trimmed === "") continue;
    out.set(slug, trimmed);
  }
  return out;
}

export class FeatureStore {
  private readonly intents: Map<string, string>;

  private constructor(
    private readonly filePath: string,
    intents: Map<string, string>,
  ) {
    this.intents = intents;
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
   *  unlinked instance has no `.dispatch/` tier to write into). */
  static ephemeral(intents: FeatureIntents = {}): FeatureStore {
    return new FeatureStore("", coerce(intents));
  }

  /** The stored one-liner for a slug, or undefined when none was ever set. */
  intent(slug: string): string | undefined {
    return this.intents.get(slug);
  }

  /** Every stored intent, as a plain object (a copy — callers must not mutate
   *  the store through it). */
  all(): FeatureIntents {
    return Object.fromEntries(this.intents);
  }

  get size(): number {
    return this.intents.size;
  }

  /**
   * Record a feature's intent. Blank input is a no-op rather than a stored empty
   * string: a create with no intent must not wipe the description an earlier
   * create set. The in-memory map updates synchronously so the very next paint
   * sees it; the returned promise resolves when the file has been rewritten.
   */
  setIntent(slug: string, intent: string): Promise<void> {
    const trimmed = intent.trim();
    if (slug === "" || trimmed === "") return Promise.resolve();
    if (this.intents.get(slug) === trimmed) return Promise.resolve();
    this.intents.set(slug, trimmed);
    return this.persist();
  }

  /** Drop a feature's intent — it landed, or it was abandoned. A no-op for a
   *  slug that was never stored, so teardown paths can call it blindly. */
  forget(slug: string): Promise<void> {
    if (!this.intents.delete(slug)) return Promise.resolve();
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
