import { test } from "node:test";
import assert from "node:assert/strict";
import { isConfirmVerb } from "./confirmverb.js";

/**
 * The seam between the TUI's queue and the session's dispatch gate. Pinned here
 * rather than only through either caller, because the two layers agreeing is the
 * whole point of the function: the TUI decides from it whether a queued line may
 * be handed to an armed gate, and the session decides from it whether the line it
 * was handed fires or cancels. A disagreement is a cancelled dispatch.
 */

test("only the first token decides, and only when it is the whole word", () => {
  for (const yes of [
    "confirm",
    "CONFIRM",
    "  confirm  ",
    "confirm ccw",
    "confirm write",
    "confirm write ccw",
    "confirm cc please",
    "confirm\tccw",
  ]) {
    assert.equal(isConfirmVerb(yes), true, `"${yes}" is the verb`);
  }

  for (const no of [
    "",
    "   ",
    "confirmed",
    "confirm.",
    "unconfirm",
    "please confirm",
    "yes do it",
    "/confirm",
  ]) {
    assert.equal(isConfirmVerb(no), false, `"${no}" is not the verb`);
  }
});
