import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { buildRunPrompt, loadProgram } from "./prompt.js";
import {
  currentBranch,
  currentHead,
  gitStatus,
  hasTrackedChanges,
  isGitRepo,
  summarizeGit,
} from "./git.js";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export interface RunOptions {
  repo: string;
  program?: string;
  maxAttempts: number;
  allowDirty: boolean;
  allowPush: boolean;
  model?: string;
  thinking?: string;
}

function parseModel(value: string): { provider: string; modelId: string } {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error("--model must be in provider/model form");
  }
  return {
    provider: value.slice(0, slash),
    modelId: value.slice(slash + 1),
  };
}

function printEvent(event: AgentSessionEvent): void {
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta") {
      process.stdout.write(update.delta);
    }
  } else if (event.type === "tool_execution_start") {
    process.stdout.write(`\n[tool] ${event.toolName}\n`);
  } else if (event.type === "tool_execution_end") {
    process.stdout.write(`[tool] ${event.toolName} done\n`);
  }
}

function tailResults(repo: string): string {
  const path = resolve(repo, "results.tsv");
  if (!existsSync(path)) {
    return "";
  }
  return readFileSync(path, "utf8").trim().split("\n").slice(-10).join("\n");
}

export async function runAutotester(options: RunOptions): Promise<number> {
  const repo = resolve(options.repo);

  if (!isGitRepo(repo)) {
    throw new Error(`${repo} is not a git repository`);
  }

  if (!options.allowDirty && hasTrackedChanges(repo)) {
    throw new Error(
      `${repo} has uncommitted tracked changes. Commit/stash them or pass --allow-dirty.`,
    );
  }

  if (options.thinking && !THINKING_LEVELS.has(options.thinking)) {
    throw new Error(
      `Invalid --thinking value '${options.thinking}'. Expected one of: ${[
        ...THINKING_LEVELS,
      ].join(", ")}`,
    );
  }

  const startHead = currentHead(repo);
  const program = loadProgram(repo, options.program);
  const prompt = buildRunPrompt({
    repo,
    programText: program.text,
    maxAttempts: options.maxAttempts,
    allowPush: options.allowPush,
  });

  console.log(`repo: ${repo}`);
  console.log(`branch: ${currentBranch(repo)}`);
  console.log(`program: ${program.path}`);
  console.log(`max attempts: ${options.maxAttempts}`);
  console.log(`start: ${startHead}`);
  const preStatus = gitStatus(repo);
  if (preStatus) {
    console.log(`status before:\n${preStatus}`);
  }

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const sessionOptions: Parameters<typeof createAgentSession>[0] = {
    cwd: repo,
    authStorage,
    modelRegistry,
    tools: ["read", "bash", "edit", "write"],
  };

  if (options.model) {
    const parsed = parseModel(options.model);
    const model = modelRegistry.find(parsed.provider, parsed.modelId);
    if (!model) {
      throw new Error(`Could not find Pi model '${options.model}'`);
    }
    sessionOptions.model = model;
  }

  if (options.thinking) {
    sessionOptions.thinkingLevel = options.thinking as NonNullable<
      typeof sessionOptions.thinkingLevel
    >;
  }

  const { session, modelFallbackMessage } = await createAgentSession(sessionOptions);
  if (modelFallbackMessage) {
    console.error(modelFallbackMessage);
  }

  const unsubscribe = session.subscribe(printEvent);
  try {
    await session.prompt(prompt, { expandPromptTemplates: false });
  } finally {
    unsubscribe();
  }

  console.log("\n\n--- autotester summary ---");
  const summary = summarizeGit(repo, startHead);
  console.log(`branch: ${summary.branch}`);
  if (summary.recentCommits) {
    console.log(`commits:\n${summary.recentCommits}`);
  } else {
    console.log("commits: none");
  }
  if (summary.status) {
    console.log(`status:\n${summary.status}`);
  } else {
    console.log("status: clean");
  }
  const results = tailResults(repo);
  if (results) {
    console.log(`results.tsv tail:\n${results}`);
  }
  return 0;
}
