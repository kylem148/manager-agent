/**
 * The completion sentinel: the single line both dispatch transports (and the
 * Stop hook) append to a capture file to signal a run finished, plus its parser.
 *
 * Extracted into its own tiny module so the Stop-hook entry (crewstophook.ts)
 * can share the EXACT marker the registry polls for without pulling in the whole
 * transport graph (child_process, AppleScript composition, pane planning). The
 * contract is unchanged — transport.ts re-exports these so its public surface,
 * and every test that imports them from there, keeps working.
 */

/** The marker appended to a capture file once a run signals completion. The
 *  number after it is the run's exit code: taken from the crew process's real
 *  `$?` on the transport paths (see transport.ts), or 0 from the Stop hook,
 *  which fires only on a clean turn completion (an interrupt/API error fires
 *  StopFailure, not Stop, so the hook never reports a bad run as done). It is
 *  -1 only when missing or unparseable. */
export const SENTINEL_PREFIX = "__CO_DISPATCH_DONE__";

export function sentinelLine(exitCode: number): string {
  return `${SENTINEL_PREFIX} ${exitCode}`;
}

/** Parse a completion sentinel out of captured text. Returns the exit code, or
 *  null if the run hasn't signalled completion yet. Scans from the END, so when
 *  more than one sentinel is present (the Stop hook's early one on first finish
 *  plus the job script's exit-time one when the crew process finally exits) the
 *  last — the real process exit code — wins. */
export function parseSentinel(captured: string): { exitCode: number } | null {
  const idx = captured.lastIndexOf(SENTINEL_PREFIX);
  if (idx === -1) return null;
  const rest = captured.slice(idx + SENTINEL_PREFIX.length).trim();
  const code = Number.parseInt(rest.split(/\s/)[0] ?? "", 10);
  return { exitCode: Number.isFinite(code) ? code : -1 };
}
