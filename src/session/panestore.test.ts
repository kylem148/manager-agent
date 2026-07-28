import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { instancePaths } from "../paths.js";
import { serializeWrite } from "../memory/writequeue.js";
import { PaneStore } from "./panestore.js";

/**
 * Tests for the pane records: what co owns, what it knows about each pane, and
 * who is using it. This is a cache of addresses, so the load path is as much
 * about degrading quietly (missing file, corrupt file, junk rows) as it is about
 * round-tripping — a broken store must cost splits, never a session.
 */

async function tmpInstance(): Promise<{ paths: ReturnType<typeof instancePaths>; cleanup: () => Promise<void> }> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "co-panestore-"));
  const paths = instancePaths(home, "inst");
  await fsp.mkdir(paths.dispatch, { recursive: true });
  return { paths, cleanup: () => fsp.rm(home, { recursive: true, force: true }) };
}

const ALIVE = (): boolean => true;
const DEAD = (): boolean => false;

test("a pane's identity and lease round-trip through disk", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const store = await PaneStore.load(paths, ALIVE);
    await store.remember("pane-a", { role: "anchor", tty: "/dev/ttys004", shellPid: 4242, usedAt: 10 });
    await store.acquire("pane-a", { session: "sess-1", pid: process.pid, job: "job-001", at: 11 });

    const reread = await PaneStore.load(paths, ALIVE);
    const record = reread.get("pane-a");
    assert.equal(record?.role, "anchor");
    assert.equal(record?.tty, "ttys004", "the /dev/ prefix is normalized away on the way in");
    assert.equal(record?.shellPid, 4242);
    assert.equal(record?.lease?.session, "sess-1");
    assert.deepEqual(reread.identity("pane-a"), { tty: "ttys004", shellPid: 4242 });
  } finally {
    await cleanup();
  }
});

test("a missing or corrupt store is an empty one, never a throw", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    assert.equal((await PaneStore.load(paths, ALIVE)).size, 0, "no file yet");
    await fsp.writeFile(paths.paneStore, "{ not json", "utf8");
    assert.equal((await PaneStore.load(paths, ALIVE)).size, 0, "corrupt");
    await fsp.writeFile(paths.paneStore, JSON.stringify({ panes: [{ nope: 1 }, "x", null] }), "utf8");
    assert.equal((await PaneStore.load(paths, ALIVE)).size, 0, "junk rows are dropped individually");
  } finally {
    await cleanup();
  }
});

test("a lease whose owning process is gone is swept at load; a live one survives", async () => {
  // The stale-lease rule: a co that was killed must not poison its panes.
  const { paths, cleanup } = await tmpInstance();
  try {
    const store = await PaneStore.load(paths, ALIVE);
    await store.remember("pane-a", { tty: "ttys004", shellPid: 1 });
    await store.acquire("pane-a", { session: "dead", pid: 4242 });

    const kept = await PaneStore.load(paths, ALIVE);
    assert.equal(kept.get("pane-a")?.lease?.session, "dead", "a live owner keeps its lease");

    // The sweep persists, so the claim is gone for good rather than being
    // re-judged on every read.
    const swept = await PaneStore.load(paths, DEAD);
    assert.equal(swept.get("pane-a")?.lease, undefined, "the dead session's claim is dropped");
    assert.equal(swept.get("pane-a")?.tty, "ttys004", "but the pane itself is still known");
    // The sweep's own write is fire-and-forget by design (nothing waits on a
    // cache write), so a test reading the file back has to wait for the shared
    // write lane to drain — queueing a no-op behind it does exactly that.
    await serializeWrite(async () => {});
    assert.equal(
      (await PaneStore.load(paths, ALIVE)).get("pane-a")?.lease,
      undefined,
      "and the sweep was written down",
    );
  } finally {
    await cleanup();
  }
});

test("sweepLeases reports what it cleaned and leaves unleased panes alone", () => {
  const store = PaneStore.ephemeral([
    { id: "a", role: "worker", lease: { session: "s1", pid: 10 } },
    { id: "b", role: "worker", lease: { session: "s2", pid: 11 } },
    { id: "c", role: "worker" },
  ]);
  assert.deepEqual(store.sweepLeases((pid) => pid === 11).sort(), ["a"]);
  assert.equal(store.get("a")?.lease, undefined);
  assert.equal(store.get("b")?.lease?.session, "s2");
  assert.equal(store.get("c")?.lease, undefined);
});

test("leaseHolder names our own job, and marks another session as foreign", () => {
  const store = PaneStore.ephemeral([
    { id: "mine", role: "worker", lease: { session: "s1", pid: 10, job: "job-007" } },
    { id: "theirs", role: "worker", lease: { session: "s2", pid: 11 } },
    { id: "free", role: "worker" },
  ]);
  assert.match(store.leaseHolder("mine", { session: "s1" })!, /job-007/);
  assert.match(store.leaseHolder("theirs", { session: "s1" })!, /another co session/);
  assert.equal(store.leaseHolder("free", { session: "s1" }), undefined);
  assert.equal(store.leaseHolder("unknown", { session: "s1" }), undefined);
});

test("release drops only our own claim, never another session's", async () => {
  const store = PaneStore.ephemeral([
    { id: "mine", role: "worker", lease: { session: "s1", pid: 10 } },
    { id: "theirs", role: "worker", lease: { session: "s2", pid: 11 } },
  ]);
  await store.release("mine", "s1");
  await store.release("theirs", "s1");
  assert.equal(store.get("mine")?.lease, undefined);
  assert.equal(store.get("theirs")?.lease?.session, "s2", "someone else's claim is not ours to drop");
});

test("remember patches independently: omitting a field never wipes it", async () => {
  const store = PaneStore.ephemeral();
  await store.remember("p", { role: "worker", tty: "ttys004", shellPid: 5, usedAt: 1 });
  // A later launch whose script could not report a tty must leave the last good
  // reading alone rather than blinding co to a pane it knows.
  await store.remember("p", { usedAt: 2 });
  assert.deepEqual(store.get("p"), {
    id: "p",
    role: "worker",
    tty: "ttys004",
    shellPid: 5,
    usedAt: 2,
  });
  // Junk is refused rather than stored.
  await store.remember("p", { tty: "not a tty", shellPid: 0 });
  assert.equal(store.get("p")?.tty, "ttys004");
  assert.equal(store.get("p")?.shellPid, 5);
});

test("list orders by least-recently-used, so reuse rotates through the panes", () => {
  const store = PaneStore.ephemeral([
    { id: "recent", role: "worker", usedAt: 300 },
    { id: "old", role: "worker", usedAt: 100 },
    { id: "never", role: "worker" },
  ]);
  assert.deepEqual(
    store.list().map((r) => r.id),
    ["never", "old", "recent"],
  );
});

test("forget drops a pane the captain closed, and says whether there was one", () => {
  const store = PaneStore.ephemeral([{ id: "gone", role: "worker" }]);
  assert.equal(store.forget("gone"), true);
  assert.equal(store.forget("gone"), false);
  assert.equal(store.size, 0);
});

test("an ephemeral store writes nothing to disk", async () => {
  const { paths, cleanup } = await tmpInstance();
  try {
    const store = PaneStore.ephemeral();
    await store.remember("p", { tty: "ttys004", shellPid: 1 });
    await assert.rejects(() => fsp.readFile(paths.paneStore, "utf8"));
  } finally {
    await cleanup();
  }
});
