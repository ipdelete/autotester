#!/usr/bin/env node
import { copyFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bundledProgramPath, RESULTS_HEADER } from "./prompt.js";
import { installPreCommitHook, writeConfig } from "./scope.js";
import { runAutotester } from "./runner.js";
import { formatHistoryTable, listRunSummaries } from "./history.js";

interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Map<string, string[] | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[] | boolean>();
  let command: string | undefined;

  function pushFlag(name: string, value: string | true): void {
    if (value === true) {
      flags.set(name, true);
      return;
    }
    const prior = flags.get(name);
    if (Array.isArray(prior)) {
      prior.push(value);
    } else {
      flags.set(name, [value]);
    }
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg.startsWith("--")) {
      const [name, inlineValue] = arg.slice(2).split("=", 2);
      if (!name) {
        throw new Error(`Invalid flag: ${arg}`);
      }
      if (inlineValue !== undefined) {
        pushFlag(name, inlineValue);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          pushFlag(name, next);
          i += 1;
        } else {
          pushFlag(name, true);
        }
      }
      continue;
    }
    if (!command) {
      command = arg;
    } else {
      positionals.push(arg);
    }
  }

  return { command, positionals, flags };
}

function flagString(
  flags: Map<string, string[] | boolean>,
  name: string,
): string | undefined {
  const value = flags.get(name);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    throw new Error(`--${name} requires a value`);
  }
  if (value.length > 1) {
    throw new Error(`--${name} given more than once`);
  }
  return value[0];
}

function flagStringList(
  flags: Map<string, string[] | boolean>,
  name: string,
): string[] {
  const value = flags.get(name);
  if (value === undefined) {
    return [];
  }
  if (typeof value === "boolean") {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function flagInt(
  flags: Map<string, string[] | boolean>,
  name: string,
  fallback: number,
): number {
  const value = flagString(flags, name);
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function help(): string {
  return `autotester

Usage:
  autotester init    <repo> [--program <path>] [--force]
                            [--editable <glob>]... [--readonly <glob>]...
  autotester run     <repo> [--program <path>]
                            [--max-attempts <n>] [--time-budget <seconds>]
                            [--max-no-finding-attempts <n>]
                            [--attempt-timeout <seconds>] [--allow-dirty]
                            [--tag <name>]
                            [--provider <id>] [--model <pattern>] [--thinking <level>]
  autotester history <repo>

Commands:
  init     Copy a program.md, initialize results.tsv, write .autotester.json,
           and install a pre-commit hook enforcing the declared scope.
  run     Drive the agent: harness runs gate/metric, agent proposes commits,
           harness keeps or discards each attempt. Loop terminates on
           --max-attempts, --time-budget, bugfix no-finding budget, or agent stop signal.
  history  Print the table of past runs recorded in .autotester/runs/.
`;
}

function requireRepo(positionals: string[]): string {
  const repo = positionals[0];
  if (!repo) {
    throw new Error("Missing <repo>");
  }
  return resolve(repo);
}

function init(repoArg: string, flags: Map<string, string[] | boolean>): void {
  const repo = resolve(repoArg);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    throw new Error(`${repo} is not a directory`);
  }
  const programPath = resolve(repo, "program.md");
  const resultsPath = resolve(repo, "results.tsv");
  const force = flags.get("force") === true;
  const source = flagString(flags, "program") ?? bundledProgramPath();

  if (existsSync(programPath) && !force) {
    throw new Error(`${programPath} already exists; pass --force to overwrite it`);
  }

  copyFileSync(source, programPath);
  if (!existsSync(resultsPath)) {
    writeFileSync(resultsPath, RESULTS_HEADER, "utf8");
  }
  console.log(`wrote ${programPath}`);
  console.log(`initialized ${resultsPath}`);

  const editable = flagStringList(flags, "editable");
  const readonly = flagStringList(flags, "readonly");
  if (editable.length > 0 || readonly.length > 0) {
    writeConfig(repo, { editable, readonly });
    console.log(`wrote ${resolve(repo, ".autotester.json")}`);
    if (existsSync(resolve(repo, ".git"))) {
      const result = installPreCommitHook(repo);
      const hookPath = resolve(repo, ".git", "hooks", "pre-commit");
      if (result.chained) {
        console.log(
          `installed pre-commit hook at ${hookPath} (existing hook chained as pre-commit.user)`,
        );
      } else {
        console.log(`installed pre-commit hook at ${hookPath}`);
      }
    } else {
      console.log(
        "warning: no .git directory found; scope is declared but no pre-commit hook installed",
      );
    }
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.command || parsed.flags.has("help") || parsed.command === "help") {
    console.log(help());
    return 0;
  }

  if (parsed.command === "init") {
    init(requireRepo(parsed.positionals), parsed.flags);
    return 0;
  }

  if (parsed.command === "run") {
    const timeBudgetRaw = flagString(parsed.flags, "time-budget");
    const timeBudget = timeBudgetRaw === undefined
      ? undefined
      : (() => {
          const n = Number.parseInt(timeBudgetRaw, 10);
          if (!Number.isFinite(n) || n < 1) {
            throw new Error("--time-budget must be a positive integer (seconds)");
          }
          return n;
        })();
    await runAutotester({
      repo: requireRepo(parsed.positionals),
      program: flagString(parsed.flags, "program"),
      maxAttempts: flagInt(parsed.flags, "max-attempts", 10),
      timeBudget,
      maxNoFindingAttempts: flagInt(parsed.flags, "max-no-finding-attempts", 3),
      allowDirty: parsed.flags.get("allow-dirty") === true,
      allowPush: parsed.flags.get("push") === true,
      provider: flagString(parsed.flags, "provider"),
      model: flagString(parsed.flags, "model"),
      thinking: flagString(parsed.flags, "thinking"),
      tag: flagString(parsed.flags, "tag"),
      attemptTimeout: flagInt(parsed.flags, "attempt-timeout", 600),
    });
    return 0;
  }

  if (parsed.command === "history") {
    const repo = requireRepo(parsed.positionals);
    const runs = listRunSummaries(repo);
    console.log(formatHistoryTable(runs));
    return 0;
  }

  throw new Error(`Unknown command: ${parsed.command}`);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
