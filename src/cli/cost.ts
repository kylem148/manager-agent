import type { Config } from "../config.js";
import { instancePaths } from "../paths.js";
import { listInstances } from "../memory/memory.js";
import { CostLedger, formatFleetReport, type FleetEntry } from "../cost.js";
import { CACHE_TTL } from "../model.js";
import { line } from "../ui.js";

/**
 * `co cost` — spend across every co-manager on this machine.
 *
 * The in-session `/cost` is scoped to one instance, because that is where the
 * ledger lives. That is the right answer to "what has this co-manager cost me"
 * and the wrong answer to "what am I being billed": the Bedrock key is shared,
 * so three instances produce one invoice. This walks them all and sums.
 *
 * Read-only, and deliberately usable without opening a session — checking spend
 * should not itself cost a turn.
 */
export async function runCost(cfg: Config): Promise<number> {
  const names = listInstances(cfg.home);

  const entries: FleetEntry[] = [];
  for (const name of names) {
    // Every instance is listed, including ones with no meter yet: "this
    // co-manager has cost nothing" is information, and silently omitting it
    // would make the fleet look smaller than it is.
    entries.push({ name, ledger: await CostLedger.load(instancePaths(cfg.home, name)) });
  }

  for (const l of formatFleetReport({ entries, cacheTtl: CACHE_TTL, home: cfg.home })) {
    line(l);
  }
  return 0;
}
