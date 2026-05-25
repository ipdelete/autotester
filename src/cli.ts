#!/usr/bin/env node
import { copyFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bundledProgramPath, RESULTS_HEADER } from "./prompt.js";
import { runAutotester } from "./runner.js";

interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  let command: string | undefined;

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
        flags.set(name, inlineValue);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          flags.set(name, next);
          i += 1;
        } else {
          flags.set(name, true);
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

function flagString(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function flagInt(flags: Map<string, string | boolean>, name: string, fallback: number): number {
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
  autotester init <repo> [--program <path>] [--force]
  autotester run <repo> [--program <path>] [--max-attempts <n>] [--allow-dirty] [--model <provider/model>] [--thinking <level>]

Commands:
  init   Copy a program.md and initialize results.tsv in a target repo
  run    Run a bounded program-driven Pi coding-agent loop in a target repo
`;
}

function requireRepo(positionals: string[]): string {
  const repo = positionals[0];
  if (!repo) {
    throw new Error("Missing <repo>");
  }
  return resolve(repo);
}

function init(repoArg: string, flags: Map<string, string | boolean>): void {
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
    await runAutotester({
      repo: requireRepo(parsed.positionals),
      program: flagString(parsed.flags, "program"),
      maxAttempts: flagInt(parsed.flags, "max-attempts", 10),
      allowDirty: parsed.flags.get("allow-dirty") === true,
      allowPush: parsed.flags.get("push") === true,
      model: flagString(parsed.flags, "model"),
      thinking: flagString(parsed.flags, "thinking"),
    });
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
