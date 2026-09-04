import fsp from "node:fs/promises";
import path from "node:path";
import type { InstancePaths } from "../paths.js";
import { serializeWrite } from "../memory/writequeue.js";
import { normalizeTty, pidAlive, type PaneIdentity } from "./paneoccupancy.js";

/**
 * Which panes co owns, and who is using them: the durable half of pane reuse.
 *
 * Ghostty's scripting dictionary gives a pane exactly one durable handle, its
 * `id`, and no way to tag it (a terminal's title is read-only). Everything else
 * co needs to reuse a pane safely — the tty its shell sits on, the pid of that
 * shell, and whether a dispatch currently holds it — has to be remembered here.
 *
 * TWO DIFFERENT THINGS LIVE IN ONE RECORD, and keeping them apart is the point:
 *
 *  - IDENTITY (tty, shellPid) is a fact about a pane that co learned by running
 *    a job in it. It is not state and it is never trusted as state: at dispatch
 *    time it is only the address the live occupancy probe reads (paneoccupancy.ts).
 *  - The LEASE is co's own claim: this session, this pid, this job. It is the
 *    half of occupancy the pane itself cannot report, because a job that has
 *    filed its completion report is still co's until the crew process exits.
 *
 * WHY IT IS PERSISTED. The in-memory pane layout (crewpanes.ts) dies with the
 * session, and a restarted co would otherwise know nothing about the panes it
 * created five minutes ago — it would take over an anchor that still holds a
 * live agent, and split fresh panes beside idle ones it no longer recognises.
 * So the records sit in `.dispatch/panes.json`, beside the dispatch config and
 * the feature store: the tier that already holds dispatch state
 * (never the user's repo).
 *
 * A STALE LEASE MUST NEVER POISON A PANE. A killed session leaves its lease
 * behind with no one to release it, so a lease is only believed while its owning
 * PROCESS is alive: `sweepLeases` drops every lease whose pid is gone, at load
 * and again before each dispatch. The worst a recycled pid can do is cost one
 * extra split. The reverse — a live lease from a second co session — is honoured,
 * so two sessions sharing one Ghostty tab don't launch into each other's panes.
 *
 * It is a CACHE, like featurestore.ts: a missing, corrupt or unwritable file
 * means "co knows no panes", which costs splits and never a failure. Nothing
 * here can break a dispatch.
 */

/** co's claim on a pane, held for as long as a dispatch is using it. */
export interface PaneLease {
  /** The co session holding it (random per session, so a session can recognise
   *  its own lease across a config reload). */
  session: string;
  /** The pid of that session's process — the liveness test that makes a lease
   *  from a killed session stale rather than permanent. */
  pid: number;
  /** The job id, for the log line when a pane is reported occupied. */
  job?: string;
  /** Epoch ms the lease was taken. Diagnostics only; age never expires a lease
   *  (a crew job legitimately runs for hours). */
  at?: number;
}

/** One pane co owns: the anchor the captain designated, or a pane co split. */
export interface PaneRecord {
  id: string;
  role: "anchor" | "worker";
  /** Identity, learned from the launch script of the last job that ran here. */
  tty?: string;
  shellPid?: number;
  /** Epoch ms of the last dispatch into this pane; orders reuse candidates. */
  usedAt?: number;
  lease?: PaneLease;
}

/** The on-disk shape: `{ "panes": [ ... ] }`. An object rather than a bare array
 *  so a later field (a schema version, say) can be added without a migration. */
export interface StoredPanes {
  panes: PaneRecord[];
}

function coerceLease(raw: unknown): PaneLease | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.session !== "string" || !o.session.trim()) return undefined;
  if (!Number.isInteger(o.pid) || Number(o.pid) <= 0) return undefined;
  return {
    session: o.session,
    pid: Number(o.pid),
    ...(typeof o.job === "string" && o.job ? { job: o.job } : {}),
    ...(Number.isFinite(o.at) ? { at: Number(o.at) } : {}),
  };
}

function coerceRecord(raw: unknown): PaneRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id.trim()) return undefined;
  const tty = normalizeTty(typeof o.tty === "string" ? o.tty : undefined);
  const shellPid = Number.isInteger(o.shellPid) && Number(o.shellPid) > 0 ? Number(o.shellPid) : undefined;
  const lease = coerceLease(o.lease);
  return {
    id: o.id,
    role: o.role === "anchor" ? "anchor" : "worker",
    ...(tty ? { tty } : {}),
    ...(shellPid ? { shellPid } : {}),
    ...(Number.isFinite(o.usedAt) ? { usedAt: Number(o.usedAt) } : {}),
    ...(lease ? { lease } : {}),
  };
}

function coerce(raw: unknown): Map<string, PaneRecord> {
  const out = new Map<string, PaneRecord>();
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as StoredPanes).panes)
      ? (raw as StoredPanes).panes
      : [];
  for (const item of list) {
    const record = coerceRecord(item);
    if (record) out.set(record.id, record);
  }
  return out;
}

export class PaneStore {
  private readonly panes: Map<string, PaneRecord>;

  private constructor(
    private readonly filePath: string,
    panes: Map<string, PaneRecord>,
  ) {
    this.panes = panes;
  }

  /**
   * Read the store from disk, dropping any lease whose owning process is gone.
   * A missing file is an empty store (the first run); a corrupt one is ALSO an
   * empty store — co re-learns each pane the next time it runs a job there, and
   * a broken cache must never stop a session opening.
   */
  static async load(paths: InstancePaths, alive: (pid: number) => boolean = pidAlive): Promise<PaneStore> {
    const file = paths.paneStore;
    let panes: Map<string, PaneRecord>;
    try {
      panes = coerce(JSON.parse(await fsp.readFile(file, "utf8")));
    } catch {
      panes = new Map();
    }
    const store = new PaneStore(file, panes);
    store.sweepLeases(alive);
    return store;
  }

  /** In-memory store with no file behind it, for tests and for a session with no
   *  `.dispatch/` tier to write into. */
  static ephemeral(seed: PaneRecord[] = []): PaneStore {
    return new PaneStore("", coerce(seed));
  }

  /** Every known pane, oldest use first — the order reuse prefers, matching the
   *  planner's long-standing "reuse the oldest free pane" rule. A pane co has
   *  never dispatched into sorts first; it has waited longest of all. */
  list(): PaneRecord[] {
    return [...this.panes.values()]
      .map((p) => ({ ...p }))
      .sort((a, b) => (a.usedAt ?? 0) - (b.usedAt ?? 0));
  }

  get(id: string): PaneRecord | undefined {
    const found = this.panes.get(id);
    return found ? { ...found } : undefined;
  }

  /** What the occupancy probe needs to address a pane, or an empty identity when
   *  co has never run a job there (which reads as unproven, never free). */
  identity(id: string): PaneIdentity {
    const record = this.panes.get(id);
    return {
      ...(record?.tty ? { tty: record.tty } : {}),
      ...(record?.shellPid ? { shellPid: record.shellPid } : {}),
    };
  }

  /**
   * Record what a launch just taught us about a pane: it exists, co owns it, and
   * (once its script reports back) which tty and shell it lives on. Identity
   * fields are independent overrides — omitting one never wipes it, so a launch
   * whose script could not report its tty leaves the previous, still-correct
   * reading alone.
   */
  remember(
    id: string,
    patch: { role?: "anchor" | "worker"; tty?: string; shellPid?: number; usedAt?: number },
  ): Promise<void> {
    if (!id) return Promise.resolve();
    const current = this.panes.get(id);
    const next: PaneRecord = { ...(current ?? { id, role: "worker" }), id };
    if (patch.role) next.role = patch.role;
    const tty = normalizeTty(patch.tty);
    if (tty) next.tty = tty;
    if (patch.shellPid && patch.shellPid > 0) next.shellPid = patch.shellPid;
    if (patch.usedAt !== undefined) next.usedAt = patch.usedAt;
    this.panes.set(id, next);
    return this.persist();
  }

  /** Claim a pane for a dispatch. Overwrites any lease already there: the caller
   *  has just decided this pane is free, and a lease it stepped over was either
   *  its own or already judged stale. */
  acquire(id: string, lease: PaneLease): Promise<void> {
    const current = this.panes.get(id) ?? { id, role: "worker" as const };
    this.panes.set(id, { ...current, lease });
    return this.persist();
  }

  /** Release a pane held by `session`. A lease belonging to a different (live)
   *  session is left alone — releasing someone else's claim is never ours to do. */
  release(id: string, session: string): Promise<void> {
    const current = this.panes.get(id);
    if (!current?.lease) return Promise.resolve();
    if (current.lease.session !== session) return Promise.resolve();
    const next = { ...current };
    delete next.lease;
    this.panes.set(id, next);
    return this.persist();
  }

  /** Drop a pane that no longer exists (the captain closed it). Returns whether
   *  a record went, so the caller can log a prune. */
  forget(id: string): boolean {
    const had = this.panes.delete(id);
    if (had) void this.persist();
    return had;
  }

  /**
   * Drop every lease whose owning process is gone: the killed-session case. Done
   * at load and again before each dispatch, so a lease is only ever believed
   * while someone is alive to answer for it. Returns the ids it cleaned, for the
   * caller's own bookkeeping.
   */
  sweepLeases(alive: (pid: number) => boolean = pidAlive): string[] {
    const cleaned: string[] = [];
    for (const [id, record] of this.panes) {
      if (!record.lease) continue;
      if (alive(record.lease.pid)) continue;
      const next = { ...record };
      delete next.lease;
      this.panes.set(id, next);
      cleaned.push(id);
    }
    if (cleaned.length > 0) void this.persist();
    return cleaned;
  }

  /**
   * Who holds a live lease on a pane, phrased for a log line — or undefined when
   * it is unleased. `self` is the calling session; its own lease is named by job
   * so the reason reads "held by job-003" rather than something anonymous.
   * Assumes sweepLeases() has already run, so a lease seen here is a live one.
   */
  leaseHolder(id: string, self: { session: string }): string | undefined {
    const lease = this.panes.get(id)?.lease;
    if (!lease) return undefined;
    if (lease.session === self.session) return lease.job ? `job ${lease.job}` : "a job in this session";
    return `another co session (pid ${lease.pid})`;
  }

  get size(): number {
    return this.panes.size;
  }

  /** Everything, in the on-disk shape. */
  snapshot(): StoredPanes {
    return { panes: this.list() };
  }

  /**
   * Rewrite the whole file. A handful of short rows, so a rewrite beats any merge
   * scheme, and it rides the shared serialized write lane for the same reason the
   * feature store does.
   *
   * NEVER REJECTS. This is a cache of pane addresses; a write that cannot land
   * costs future reuse (an extra split), never a dispatch.
   */
  private async persist(): Promise<void> {
    if (this.filePath === "") return;
    const snapshot = this.snapshot();
    const file = this.filePath;
    try {
      await serializeWrite(async () => {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
      });
    } catch {
      // See the class comment: a pane record that didn't reach disk is not worth
      // failing a dispatch over.
    }
  }
}
