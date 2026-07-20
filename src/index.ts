#!/usr/bin/env node
import * as readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { loadConfig } from "./config.js";
import {
  createInstance,
  deleteInstance,
  instanceExists,
  instanceStats,
  listInstances,
} from "./memory.js";
import { instancePaths, isValidInstanceName } from "./paths.js";
import { runSession } from "./session.js";
import { runDoctor } from "./doctor.js";
import { runModelsDoctor } from "./modelsdoctor.js";
import { runAuthBedrock } from "./auth.js";
import { c, line } from "./ui.js";
import { restoreTerminal } from "./tui.js";

/**
 * CLI entry. Usage:
 *   co <name>            open (create-if-missing) the named co-manager
 *   co list              list instances
 *   co create <name>     create an instance from the template
 *   co doctor [--ping]   diagnostics
 *   co refresh           rebuild the CLI from source (npm run build)
 *   co help
 */

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cfg = loadConfig();

  const first = argv[0];

  if (!first || first === "help" || first === "--help" || first === "-h") {
    printUsage();
    return first ? 0 : 1;
  }

  switch (first) {
    case "list": {
      const names = listInstances(cfg.home);
      if (names.length === 0) {
        line(c.dim(`no co-managers yet in ${cfg.home}. create one:  co create <name>`));
      } else {
        line(c.bold("co-managers:"));
        for (const n of names) line("  " + n);
      }
      return 0;
    }

    case "create": {
      const name = argv[1];
      if (!name) {
        line(c.red("usage: co create <name>"));
        return 1;
      }
      if (!isValidInstanceName(name)) {
        line(c.red(`invalid name "${name}". use letters, digits, . _ - (max 64).`));
        return 1;
      }
      if (instanceExists(cfg.home, name)) {
        line(c.yellow(`"${name}" already exists at ${instancePaths(cfg.home, name).root}`));
        return 0;
      }
      const p = await createInstance(cfg.home, name);
      line(c.green(`created co-manager "${name}"`));
      line(c.dim(`  ${p.root}`));
      line(c.dim(`open it:  co ${name}`));
      return 0;
    }

    case "delete":
    case "rm": {
      const rest = argv.slice(1);
      const force = rest.includes("--force") || rest.includes("-y");
      const name = rest.find((a) => !a.startsWith("-"));
      if (!name) {
        line(c.red(`usage: co delete <name> [--force]`));
        return 1;
      }
      if (!isValidInstanceName(name)) {
        line(c.red(`invalid name "${name}".`));
        return 1;
      }
      if (!instanceExists(cfg.home, name)) {
        line(c.yellow(`"${name}" doesn't exist. nothing to delete.`));
        line(c.dim(`list co-managers:  co list`));
        return 1;
      }
      return deleteInstanceInteractive(cfg.home, name, force);
    }

    case "auth": {
      const sub = argv[1];
      if (sub === "bedrock") {
        return runAuthBedrock(cfg);
      }
      line(c.red("usage: co auth bedrock"));
      return 1;
    }

    case "doctor": {
      if (argv.includes("--models")) {
        return runModelsDoctor(cfg);
      }
      const ping = argv.includes("--ping");
      return runDoctor(cfg, { ping });
    }

    case "refresh":
    case "rebuild":
      return runRefresh();

    default: {
      // Treat the first arg as an instance name.
      const name = first;
      if (!isValidInstanceName(name)) {
        line(c.red(`unknown command or invalid name: "${name}" (try: co help)`));
        return 1;
      }
      if (!instanceExists(cfg.home, name)) {
        line(c.dim(`"${name}" doesn't exist yet — creating it.`));
        await createInstance(cfg.home, name);
      }
      const p = instancePaths(cfg.home, name);
      await runSession(cfg, p);
      return 0;
    }
  }
}

/**
 * Rebuild the CLI from source (`npm run build`). This is a convenience so that
 * after editing src/ you can recompile without leaving the co workflow: just
 * `co refresh`, then start a fresh session to pick up the change.
 *
 * The globally-installed `co` runs <repo>/dist/index.js, so the repo root is two
 * directories up from this module. We run the build there regardless of the
 * caller's cwd, streaming npm's output through so the user sees compile errors.
 */
function runRefresh(): Promise<number> {
  const here = path.dirname(fileURLToPath(import.meta.url)); // <repo>/dist
  const repoRoot = path.resolve(here, "..");
  line(c.dim(`rebuilding co from ${repoRoot}…`));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolve) => {
    const child = spawn(npm, ["run", "build"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    child.on("error", (err) => {
      line(c.red(`failed to run npm: ${(err as Error).message}`));
      resolve(1);
    });
    child.on("close", (code) => {
      if (code === 0) {
        line(c.green("rebuilt. start a fresh session to pick up the change."));
        resolve(0);
      } else {
        line(c.red(`build failed (exit ${code ?? "?"}).`));
        resolve(code ?? 1);
      }
    });
  });
}

/**
 * Delete an instance with a real double-check. The confirmation is deliberately
 * high-friction for an irreversible op: we show exactly what will be destroyed
 * (file count, recorded decisions, generated prompts) and require the user to
 * TYPE THE INSTANCE NAME — a bare y/n is too easy to fat-finger. --force / -y
 * skips the prompt for scripting, but only after the existence check passed.
 */
async function deleteInstanceInteractive(
  home: string,
  name: string,
  force: boolean,
): Promise<number> {
  const root = instancePaths(home, name).root;
  const stats = await instanceStats(home, name);

  line();
  line(c.bold(c.red(`Delete co-manager "${name}"?`)));
  line(c.dim(`  ${root}`));
  const bits = [`${stats.files} file(s)`];
  if (stats.decisions) bits.push(`${stats.decisions} recorded decision(s)`);
  line(c.dim(`  ${bits.join(" · ")}`));
  line(c.yellow("  This permanently deletes the memory workspace. It cannot be undone."));
  line();

  if (!force) {
    if (!process.stdin.isTTY) {
      line(c.red("refusing to delete without confirmation (no TTY). re-run with --force to script it."));
      return 1;
    }
    const typed = await promptLine(c.yellow(`Type the name "${name}" to confirm: `));
    if (typed.trim() !== name) {
      line(c.dim("name did not match — aborted. nothing was deleted."));
      return 1;
    }
  }

  const deleted = await deleteInstance(home, name);
  if (!deleted) {
    line(c.yellow(`"${name}" was already gone.`));
    return 1;
  }
  line(c.green(`deleted "${name}".`));
  return 0;
}

/** One-shot line prompt on stdin. Resolves "" on EOF/closed input. */
function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    // rl.close() emits 'close' synchronously, so guard against a double-resolve:
    // without this, the close handler resolves "" before the answer lands.
    let done = false;
    const finish = (v: string): void => {
      if (done) return;
      done = true;
      resolve(v);
    };
    rl.on("close", () => finish(""));
    rl.question(question, (answer) => {
      finish(answer);
      rl.close();
    });
  });
}

function printUsage(): void {
  line(c.bold("co — terminal co-manager (architecture brain)"));
  line();
  line("usage:");
  line(`  ${c.cyan("co <name>")}           open (create if missing) a co-manager`);
  line(`  ${c.cyan("co list")}             list co-managers`);
  line(`  ${c.cyan("co create <name>")}    create a co-manager from the template`);
  line(`  ${c.cyan("co delete <name>")}    delete a co-manager (type the name to confirm; -y to force)`);
  line(`  ${c.cyan("co auth bedrock")}     set the Bedrock bearer token in ~/co-managers/.env`);
  line(`  ${c.cyan("co doctor [--ping]")}  check config, paths, auth (--ping tests the model)`);
  line(`  ${c.cyan("co doctor --models")}  probe which Claude models actually work on this account`);
  line(`  ${c.cyan("co refresh")}          rebuild the CLI from source after editing src/`);
  line(`  ${c.cyan("co help")}             this help`);
  line();
  line(c.dim("config: env vars or .env (see .env.example). memory root: CO_HOME (default ~/co-managers)."));
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    // Restore the terminal first so the error lands on the primary screen,
    // not inside a fullscreen buffer that's about to be torn down.
    restoreTerminal();
    line(c.red(`\nfatal: ${(e as Error).message}`));
    if (process.env.CO_DEBUG) console.error(e);
    process.exit(1);
  });
