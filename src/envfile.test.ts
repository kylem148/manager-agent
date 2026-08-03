import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvText, upsertEnv } from "./envfile.js";

/**
 * The upsert is the only thing in this app that edits a file the captain also
 * edits by hand, so what is pinned here is mostly what it must NOT do: lose a
 * comment, reorder anything, or resurrect a line that was commented out on
 * purpose. Both callers (`co auth bedrock` and `/model`) depend on that.
 */

test("an existing key is replaced in place, with the file around it untouched", () => {
  const before = [
    "# my own notes",
    "AWS_REGION=us-west-2",
    "BEDROCK_MODEL_ID=us.anthropic.claude-opus-5",
    "",
    "CO_EFFORT=low",
    "",
  ].join("\n");

  const after = upsertEnv(before, { BEDROCK_MODEL_ID: "us.anthropic.claude-sonnet-5" });

  assert.equal(
    after,
    [
      "# my own notes",
      "AWS_REGION=us-west-2",
      "BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-5",
      "",
      "CO_EFFORT=low",
      "",
    ].join("\n"),
  );
});

test("a key that isn't there yet is appended, and a missing file is just empty text", () => {
  assert.equal(upsertEnv("", { BEDROCK_MODEL_ID: "x" }), "BEDROCK_MODEL_ID=x\n");
  assert.equal(
    upsertEnv("CO_EFFORT=high", { BEDROCK_MODEL_ID: "x" }),
    "CO_EFFORT=high\nBEDROCK_MODEL_ID=x\n",
    "and the file it appends to gets its missing trailing newline",
  );
});

test("a commented-out assignment stays commented out", () => {
  // The captain commented that line out on purpose. Un-commenting it would be an
  // edit nobody asked for, so the key is appended instead.
  const after = upsertEnv("# BEDROCK_MODEL_ID=old\n", { BEDROCK_MODEL_ID: "new" });
  assert.match(after, /^# BEDROCK_MODEL_ID=old$/m);
  assert.match(after, /^BEDROCK_MODEL_ID=new$/m);
});

test("parsing ignores comments and junk rather than failing on them", () => {
  const parsed = parseEnvText("# note\n\nBEDROCK_MODEL_ID=us.anthropic.claude-opus-5\ngarbage\n=nokey\n");
  assert.deepEqual(parsed, { BEDROCK_MODEL_ID: "us.anthropic.claude-opus-5" });
});
