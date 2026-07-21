import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrateInstanceLayout } from "./memory.js";
import { instancePaths } from "../paths.js";

/**
 * Migration from the pre-reorg layout (live/ + logs/) to docs/ + .memory/.
 *
 * The interesting cases are the conflicts, where a file already exists at the
 * destination. That happens for real: run a stale build against an
 * already-migrated instance and it recreates the old dirs and writes a session's
 * worth of work into them.
 *
 * The two file classes are handled differently on purpose:
 *  - append-only logs ALWAYS combine, so a conflict is a merge;
 *  - full-rewrite snapshots can't be auto-merged, so the loser is parked in the
 *    NEW location rather than abandoned at the old path where nothing reads it.
 */

async function makeInstance(): Promise<{ home: string; root: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "co-migrate-"));
  const root = path.join(home, "instances", "inst");
  return { home, root, cleanup: () => rm(home, { recursive: true, force: true }) };
}

const DECISION_HEADER = "# Decisions\n\n_Append-only log._\n";

test("a clean migration just moves files", async () => {
  const { home, root, cleanup } = await makeInstance();
  try {
    await mkdir(path.join(root, "live"), { recursive: true });
    await mkdir(path.join(root, "logs"), { recursive: true });
    await writeFile(path.join(root, "live", "activeContext.md"), "# ctx\n");
    await writeFile(path.join(root, "logs", "decisions.md"), DECISION_HEADER);

    const r = await migrateInstanceLayout(instancePaths(home, "inst"));

    assert.equal(r.migrated, true);
    assert.equal(r.moved, 2);
    assert.equal(r.conflicts, 0);
    assert.equal(r.mergedEntries, 0);
    assert.deepEqual(r.parked, []);
    assert.equal(await readFile(path.join(root, ".memory", "activeContext.md"), "utf8"), "# ctx\n");
  } finally {
    await cleanup();
  }
});

test("conflicting logs merge, interleaved by timestamp", async () => {
  const { home, root, cleanup } = await makeInstance();
  try {
    await mkdir(path.join(root, "logs"), { recursive: true });
    await mkdir(path.join(root, ".memory"), { recursive: true });
    // Destination already holds the 10:00 and 12:00 entries...
    await writeFile(
      path.join(root, ".memory", "progress.md"),
      "# Progress\n\n\n## 2026-07-18 10:00 UTC\n\nfirst\n\n## 2026-07-18 12:00 UTC\n\nthird\n",
    );
    // ...and the stale build wrote an 11:00 entry to the old path.
    await writeFile(
      path.join(root, "logs", "progress.md"),
      "\n## 2026-07-18 11:00 UTC\n\nsecond\n",
    );

    const r = await migrateInstanceLayout(instancePaths(home, "inst"));

    assert.equal(r.mergedEntries, 1);
    assert.equal(r.conflicts, 0);
    const out = await readFile(path.join(root, ".memory", "progress.md"), "utf8");
    assert.deepEqual(
      [...out.matchAll(/^## (.+)$/gm)].map((m) => m[1]),
      ["2026-07-18 10:00 UTC", "2026-07-18 11:00 UTC", "2026-07-18 12:00 UTC"],
      "the merged entry lands in chronological order, not appended blindly",
    );
    assert.match(out, /second/);
    // The old dir is drained and removed, so the warning can't recur.
    await assert.rejects(() => readdir(path.join(root, "logs")));
  } finally {
    await cleanup();
  }
});

test("a colliding decision id is re-minted; existing ids are never touched", async () => {
  const { home, root, cleanup } = await makeInstance();
  try {
    await mkdir(path.join(root, "logs"), { recursive: true });
    await mkdir(path.join(root, ".memory"), { recursive: true });
    await writeFile(
      path.join(root, ".memory", "decisions.md"),
      DECISION_HEADER +
        "\n## D-20260718-1 — 2026-07-18 10:00 UTC\n\nkeep me\n" +
        "\n## D-20260718-2 — 2026-07-18 11:00 UTC\n\nkeep me too\n",
    );
    await writeFile(
      path.join(root, "logs", "decisions.md"),
      "\n## D-20260718-1 — 2026-07-18 12:00 UTC\n\nthe orphan\n",
    );

    const r = await migrateInstanceLayout(instancePaths(home, "inst"));

    assert.equal(r.mergedEntries, 1);
    assert.deepEqual(r.renumbered, ["D-20260718-1 → D-20260718-3"]);
    const out = await readFile(path.join(root, ".memory", "decisions.md"), "utf8");
    assert.deepEqual(
      [...out.matchAll(/^## (D-\d{8}-\d+)/gm)].map((m) => m[1]),
      ["D-20260718-1", "D-20260718-2", "D-20260718-3"],
      "destination ids are stable — activeContext.md cites them by id",
    );
    assert.match(out, /keep me\b/);
    assert.match(out, /the orphan/);
  } finally {
    await cleanup();
  }
});

test("a conflicting snapshot is parked in the new layout, not left behind", async () => {
  const { home, root, cleanup } = await makeInstance();
  try {
    await mkdir(path.join(root, "live"), { recursive: true });
    await mkdir(path.join(root, ".memory"), { recursive: true });
    await writeFile(path.join(root, ".memory", "activeContext.md"), "the kept one\n");
    await writeFile(path.join(root, "live", "activeContext.md"), "the other one\n");

    const r = await migrateInstanceLayout(instancePaths(home, "inst"));

    assert.equal(r.conflicts, 0, "parking resolves it — nothing is left stranded");
    assert.equal(r.parked.length, 1);
    const parked = r.parked[0]!;
    assert.equal(path.dirname(parked), path.join(root, ".memory"), "parked beside the winner");
    assert.match(path.basename(parked), /^activeContext\.conflict-.+\.md$/);
    // Neither copy is lost, and we did not guess a winner by mtime.
    assert.equal(await readFile(parked, "utf8"), "the other one\n");
    assert.equal(await readFile(path.join(root, ".memory", "activeContext.md"), "utf8"), "the kept one\n");
    await assert.rejects(() => readdir(path.join(root, "live")));
  } finally {
    await cleanup();
  }
});

test("migration is idempotent — a second run is a no-op", async () => {
  const { home, root, cleanup } = await makeInstance();
  try {
    await mkdir(path.join(root, "logs"), { recursive: true });
    await writeFile(path.join(root, "logs", "decisions.md"), DECISION_HEADER);
    await migrateInstanceLayout(instancePaths(home, "inst"));

    const second = await migrateInstanceLayout(instancePaths(home, "inst"));

    assert.equal(second.migrated, false);
    assert.equal(second.moved, 0);
    assert.equal(second.mergedEntries, 0);
  } finally {
    await cleanup();
  }
});
