/**
 * The confirm verb: the one word that answers an armed dispatch's gate.
 *
 * It sits at the root, beside the other shared primitives, because two layers
 * now ask the same question and must never answer it differently. The session
 * parses a confirm for what it GRANTS — which crew agent, which lane (see
 * `parseConfirm`). The TUI only needs to know whether a line IS one, so it can
 * let a queued confirm through an armed gate and hold everything else back.
 *
 * Two spellings of "is this a confirm" would drift, and the drift has exactly
 * two shapes, both bad: a queued line the TUI thought was a confirm reaches the
 * gate and CANCELS the order, or a real confirm sits in the queue while the
 * captain wonders why his dispatch never fired.
 *
 * Only the first token decides. `confirm write`, `confirm ccw` and
 * `confirm write ccw` are all confirms here — what those extra words mean is the
 * session's business, not the queue's.
 */
export function isConfirmVerb(raw: string): boolean {
  return raw.trim().split(/\s+/)[0]?.toLowerCase() === "confirm";
}
