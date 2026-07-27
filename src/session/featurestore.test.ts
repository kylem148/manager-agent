import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { instancePaths } from "../paths.js";
import { FeatureStore } from "./featurestore.js";

/**
 * The persisted feature intents (featurestore.ts): the one field of a feature
 * record that git cannot rebuild, and therefore the only one that has to be
 * written down. These tests are about the file — that an intent set in one
 * "session" is there in the next, that the store degrades quietly rather than
 * failing a session start, and that it never grows stale entries for features
 * that have landed or been abandoned.
 *
 * The end-to-end proof — an intent surviving a REAL registry rebuild from
 * on-disk worktrees — lives in features.test.ts, where there is a real repo to
 * rebuild from.
 */

async function tmpPaths(): Promise<{ paths: ReturnType<typeof instancePaths>; cleanup: () => Promise<void> }> {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "co-fstore-")));
  return {
    paths: instancePaths(path.join(root, "home"), "inst"),
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

test("an intent written in one session is read back in the next", async () => {
  const { paths, cleanup } = await tmpPaths();
  try {
    const first = await FeatureStore.load(paths);
    assert.equal(first.intent("user-auth"), undefined, "nothing stored yet");
    await first.setIntent("user-auth", "passkey login for the web app");

    // The file lands under .dispatch/, beside the dispatch config and the inbox.
    assert.ok(fs.existsSync(paths.featureStore), "the store is on disk");
    assert.equal(path.basename(paths.featureStore), "features.json");

    const next = await FeatureStore.load(paths);
    assert.equal(next.intent("user-auth"), "passkey login for the web app");
  } finally {
    await cleanup();
  }
});

test("intents are keyed by slug, trimmed, and a blank one never wipes a stored description", async () => {
  const { paths, cleanup } = await tmpPaths();
  try {
    const store = await FeatureStore.load(paths);
    await store.setIntent("checkout", "  stripe checkout  ");
    assert.equal(store.intent("checkout"), "stripe checkout", "stored trimmed");

    // feature_create is idempotent and is often called again with no intent;
    // that must not erase what the first create recorded.
    await store.setIntent("checkout", "");
    await store.setIntent("checkout", "   ");
    assert.equal(store.intent("checkout"), "stripe checkout");

    // A real second intent does replace it.
    await store.setIntent("checkout", "stripe checkout with saved cards");
    assert.equal((await FeatureStore.load(paths)).intent("checkout"), "stripe checkout with saved cards");
  } finally {
    await cleanup();
  }
});

test("an authored PR message survives a reload, beside the intent and independent of it", async () => {
  const { paths, cleanup } = await tmpPaths();
  try {
    const first = await FeatureStore.load(paths);
    assert.equal(first.prMessage("user-auth"), undefined, "nothing authored yet");
    await first.setIntent("user-auth", "passkey login for the web app");
    await first.setPrMessage("user-auth", {
      prTitle: "Add passkey login to the web app",
      prBody: "Passwords were the last thing keeping the support queue busy.",
    });

    // A restart reads both back: this is what stops a re-processed head falling
    // silently back to the mechanical composition.
    const next = await FeatureStore.load(paths);
    assert.deepEqual(next.prMessage("user-auth"), {
      prTitle: "Add passkey login to the web app",
      prBody: "Passwords were the last thing keeping the support queue busy.",
    });
    assert.equal(next.intent("user-auth"), "passkey login for the web app", "the intent is untouched");

    // The two are independent: setting one never disturbs the other.
    await next.setIntent("user-auth", "passkey login, now with recovery codes");
    assert.deepEqual((await FeatureStore.load(paths)).prMessage("user-auth"), {
      prTitle: "Add passkey login to the web app",
      prBody: "Passwords were the last thing keeping the support queue busy.",
    });
  } finally {
    await cleanup();
  }
});

test("each PR message field is its own override: supplying replaces, omitting preserves", async () => {
  const { paths, cleanup } = await tmpPaths();
  try {
    const store = await FeatureStore.load(paths);
    await store.setPrMessage("checkout", { prTitle: "  Add saved cards to checkout  ", prBody: "Why: fewer drop-offs." });
    assert.equal(store.prMessage("checkout")?.prTitle, "Add saved cards to checkout", "stored trimmed");

    // The retry case: a re-enqueue after a resolver run passes nothing. The
    // authored message must still be there afterwards.
    await store.setPrMessage("checkout", {});
    await store.setPrMessage("checkout", { prTitle: "", prBody: "   " });
    assert.deepEqual(store.prMessage("checkout"), {
      prTitle: "Add saved cards to checkout",
      prBody: "Why: fewer drop-offs.",
    });

    // One field supplied replaces only that field.
    await store.setPrMessage("checkout", { prBody: "Why: fewer drop-offs at the payment step." });
    assert.deepEqual((await FeatureStore.load(paths)).prMessage("checkout"), {
      prTitle: "Add saved cards to checkout",
      prBody: "Why: fewer drop-offs at the payment step.",
    });

    // A title with no body is a legitimate half-message; the other half falls
    // back to the mechanical composition at landing time.
    await store.setPrMessage("half", { prTitle: "Split the migration runner out of boot" });
    assert.deepEqual(store.prMessage("half"), { prTitle: "Split the migration runner out of boot" });
  } finally {
    await cleanup();
  }
});

test("forget drops a landed feature's intent from the file, and is a no-op for one never stored", async () => {
  const { paths, cleanup } = await tmpPaths();
  try {
    const store = await FeatureStore.load(paths);
    await store.setIntent("landed", "already merged");
    await store.setPrMessage("landed", { prTitle: "Ship it", prBody: "It shipped." });
    await store.setIntent("kept", "still in flight");

    await store.forget("landed");
    await store.forget("never-existed"); // must not throw, must not rewrite anything

    const reloaded = await FeatureStore.load(paths);
    assert.equal(reloaded.intent("landed"), undefined, "the landed feature's intent is gone");
    assert.equal(reloaded.prMessage("landed"), undefined, "and so is its PR message");
    assert.equal(reloaded.intent("kept"), "still in flight", "the live one survives");
    assert.equal(reloaded.size, 1);
  } finally {
    await cleanup();
  }
});

test("a corrupt or hand-mangled store is an EMPTY store, never a failed session start", async () => {
  const { paths, cleanup } = await tmpPaths();
  try {
    await fsp.mkdir(path.dirname(paths.featureStore), { recursive: true });
    await fsp.writeFile(paths.featureStore, "{ this is not json", "utf8");
    assert.equal((await FeatureStore.load(paths)).size, 0, "unparseable → empty");

    // Well-formed JSON of the wrong shape, and rows of the wrong type, are
    // dropped individually rather than poisoning the whole store. A bare string
    // is the LEGACY intent-only row and is still read (a store written by an
    // older build keeps every description it had).
    await fsp.writeFile(
      paths.featureStore,
      JSON.stringify({
        legacy: "a real intent",
        bad: 42,
        blank: "   ",
        wrongtype: { intent: 42, prTitle: [] },
        halfgood: { intent: "kept", prBody: null },
        empty: {},
      }),
      "utf8",
    );
    const store = await FeatureStore.load(paths);
    assert.equal(store.intent("legacy"), "a real intent", "the pre-PR-message shape still reads");
    assert.equal(store.intent("bad"), undefined);
    assert.equal(store.intent("blank"), undefined);
    assert.equal(store.intent("wrongtype"), undefined, "non-string fields are dropped");
    assert.equal(store.intent("halfgood"), "kept", "and a good field beside a bad one survives");
    assert.equal(store.prMessage("halfgood"), undefined);
    assert.equal(store.intent("empty"), undefined);
    assert.equal(store.size, 2, "only the two rows with something usable in them");

    await fsp.writeFile(paths.featureStore, JSON.stringify(["not", "an", "object"]), "utf8");
    assert.equal((await FeatureStore.load(paths)).size, 0, "an array is not the store shape");
  } finally {
    await cleanup();
  }
});

test("a missing file is simply an empty store (the first run), and writing creates the dir", async () => {
  const { paths, cleanup } = await tmpPaths();
  try {
    assert.ok(!fs.existsSync(paths.dispatch), "no .dispatch/ tier yet");
    const store = await FeatureStore.load(paths);
    assert.equal(store.size, 0);
    await store.setIntent("first", "the very first feature");
    assert.equal((await FeatureStore.load(paths)).intent("first"), "the very first feature");
  } finally {
    await cleanup();
  }
});

test("the ephemeral store behaves identically in memory and writes no file", async () => {
  const { paths, cleanup } = await tmpPaths();
  try {
    const store = FeatureStore.ephemeral({ seeded: "from a test" });
    assert.equal(store.intent("seeded"), "from a test");
    await store.setIntent("added", "in memory only");
    assert.deepEqual(store.all(), {
      seeded: { intent: "from a test" },
      added: { intent: "in memory only" },
    });
    await store.forget("seeded");
    assert.equal(store.intent("seeded"), undefined);
    assert.ok(!fs.existsSync(paths.featureStore), "nothing was written anywhere");
  } finally {
    await cleanup();
  }
});

test("a write that cannot land degrades to a lost description, never a thrown feature op", async () => {
  const { paths, cleanup } = await tmpPaths();
  try {
    const store = await FeatureStore.load(paths);
    // Occupy the store's own path with a DIRECTORY: the write can't succeed, and
    // the caller (a create, a merge, a teardown) must not care.
    await fsp.mkdir(paths.featureStore, { recursive: true });
    await store.setIntent("doomed", "written nowhere");
    assert.equal(store.intent("doomed"), "written nowhere", "in memory for this session");
    await store.forget("doomed"); // the teardown path must survive it too
    assert.equal(store.intent("doomed"), undefined);
  } finally {
    await cleanup();
  }
});
