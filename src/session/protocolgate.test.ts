import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { instancePaths } from "../paths.js";
import { createInstance } from "../memory/memory.js";
import { makeExecutor, newSideEffects, toolDefinitions } from "./tools.js";
import type { ResearchConfig } from "../config.js";

/**
 * The protocol gate.
 *
 * Moving the orders checklist and the PR template out of the system prompt saves
 * real money, but it opens a specific hole: the co can act without them. That
 * failure is silent — an order that restates the repo, a PR body in the wrong
 * shape; both read plausibly, both ship, and neither raises anything.
 *
 * An inline "call read_protocol first" is a hope. What is pinned here is the
 * enforcement: the refusal HANDS THE PROTOCOL OVER, so there is no path to
 * acting uninformed, and the retry then works because the text is in context.
 */

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "co-gate-"));
  await createInstance(home, "inst");
  const paths = instancePaths(home, "inst");
  const effects = newSideEffects();
  const armed: Array<{ order: string; feature?: string }> = [];
  const execute = makeExecutor({
    paths,
    research: {} as ResearchConfig,
    effects,
    onArmDispatch: async (order: string, feature?: string) => {
      armed.push({ order, ...(feature ? { feature } : {}) });
      return { armed: true, summary: "armed" };
    },
  });
  let n = 0;
  return {
    effects,
    armed,
    dispatch: (order: string) =>
      execute({ type: "tool_use", id: `d${++n}`, name: "dispatch_order", input: { order } }),
    read: (section: string) =>
      execute({ type: "tool_use", id: `r${++n}`, name: "read_protocol", input: { section } }),
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

test("a first dispatch is refused, and the refusal carries the protocol", async () => {
  const fx = await fixture();
  try {
    const res = await fx.dispatch("Go and refactor the thing.");
    assert.ok(res.is_error);
    // Not a pointer to a tool the co might forget to call — the contract itself.
    assert.match(String(res.content), /### Orders protocol/);
    assert.match(String(res.content), /Do NOT restate the repo/);
    assert.match(String(res.content), /Hard limit: 50 lines for the whole report/);
    // And it must be unambiguous that the order did not go anywhere, or the co
    // will tell the captain it dispatched.
    assert.match(String(res.content), /Nothing has been staged/);
    assert.deepEqual(fx.armed, [], "nothing may be staged by a refused call");
  } finally {
    await fx.cleanup();
  }
});

test("the retry goes through, so the gate is one refusal and never a loop", async () => {
  const fx = await fixture();
  try {
    await fx.dispatch("first attempt");
    const res = await fx.dispatch("rewritten to the checklist");
    assert.ok(!res.is_error, String(res.content));
    assert.equal(fx.armed.length, 1);
    assert.equal(fx.armed[0]!.order, "rewritten to the checklist");
  } finally {
    await fx.cleanup();
  }
});

test("reading the protocol first avoids the refusal entirely", async () => {
  const fx = await fixture();
  try {
    // The good path: the co reads BEFORE writing a long order, so it never
    // generates one twice. This is why read_protocol still exists alongside the
    // gate rather than being replaced by it.
    const read = await fx.read("orders");
    assert.ok(!read.is_error);
    const res = await fx.dispatch("written with the checklist in hand");
    assert.ok(!res.is_error);
    assert.equal(fx.armed.length, 1, "armed on the first try");
  } finally {
    await fx.cleanup();
  }
});

test("an empty order is rejected before the gate, and does not consume it", async () => {
  const fx = await fixture();
  try {
    const empty = await fx.dispatch("   ");
    assert.ok(empty.is_error);
    assert.doesNotMatch(String(empty.content), /### Orders protocol/);
    // The gate is still armed for the first REAL order: a validation failure
    // must not be mistaken for having been shown the contract.
    const res = await fx.dispatch("a real order");
    assert.ok(res.is_error);
    assert.match(String(res.content), /### Orders protocol/);
  } finally {
    await fx.cleanup();
  }
});

test("read_protocol is offered on an unlinked instance, because orders still are", () => {
  // An unlinked co writes orders as plain text for the captain to carry, so
  // gating the checklist behind the dispatch link would take it away from
  // exactly the instances with no other way to reach it.
  const unlinked = toolDefinitions({});
  const tool = unlinked.find((t) => t.name === "read_protocol");
  assert.ok(tool, "read_protocol must exist unlinked");
  const props = tool.input_schema.properties as Record<string, { enum?: string[] }>;
  assert.deepEqual(props.section?.enum, ["orders"]);
  assert.ok(!unlinked.some((t) => t.name === "dispatch_order"));

  const linked = toolDefinitions({ dispatch: true });
  const linkedTool = linked.find((t) => t.name === "read_protocol")!;
  const linkedProps = linkedTool.input_schema.properties as Record<string, { enum?: string[] }>;
  assert.deepEqual(linkedProps.section?.enum, ["orders", "features", "lanes", "pr-message"]);
});

test("an unknown section is refused without inventing one", async () => {
  const fx = await fixture();
  try {
    const res = await fx.read("nonsense");
    assert.ok(res.is_error);
    assert.match(String(res.content), /orders/);
  } finally {
    await fx.cleanup();
  }
});
