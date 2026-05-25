import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { buildRunPrompt, loadProgram, type FrontMatter } from "./prompt.js";
import {
  createBranch,
  currentBranch,
  currentHead,
  gitStatus,
  hasTrackedChanges,
  isGitRepo,
  localBranchExists,
  remoteBranchExists,
  summarizeGit,
} from "./git.js";
import { configToScope, loadConfig } from "./scope.js";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

const DEFAULT_PROVIDER = "github-copilot";
const DEFAULT_MODEL = "claude-opus-4.7";
const DEFAULT_ATTEMPT_TIMEOUT = 600;

export interface RunOptions {
  repo: string;
  program?: string;
  maxAttempts: number;
  allowDirty: boolean;
  allowPush: boolean;
  provider?: string;
  model?: string;
  thinking?: string;
  tag?: string;
  attemptTimeout?: number;
}

type Source = "flag" | "program" | "default";

interface Resolved<T> {
  value: T;
  source: Source;
}

function resolveField<T>(flag: T | undefined, program: T | undefined, fallback: T): Resolved<T> {
  if (flag !== undefined) {
    return { value: flag, source: "flag" };
  }
  if (program !== undefined) {
    return { value: program, source: "program" };
  }
  return { value: fallback, source: "default" };
}

/**
 * Parse a model reference that may be either `modelId` (paired with an
 * explicit provider) or `provider/modelId` (combined form). Returns a
 * normalized split. When `expectedProvider` is set, a mismatching combined
 * form is an error.
 */
function splitModelRef(
  ref: string,
  expectedProvider?: string,
): { provider?: string; modelId: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    return { modelId: ref };
  }
  const provider = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  if (expectedProvider && provider.toLowerCase() !== expectedProvider.toLowerCase()) {
    throw new Error(
      `Model '${ref}' contradicts provider '${expectedProvider}'. ` +
        `Use either '--provider ${expectedProvider} --model ${modelId}' or just '--model ${ref}'.`,
    );
  }
  return { provider, modelId };
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

function modelNotFoundError(provider: string, modelId: string): string {
  const base = `Could not find Pi model '${provider}/${modelId}'.`;
  if (provider === "github-copilot") {
    return (
      `${base} If you're using a GitHub Copilot subscription, enable the model in ` +
      `VS Code: Copilot Chat → model selector → ${modelId} → Enable. Then retry.`
    );
  }
  return `${base} Run 'pi' and use '/login', or check 'pi --list-models'.`;
}

export async function runAutotester(options: RunOptions): Promise<number> {
  const repo = resolve(options.repo);

  if (!isGitRepo(repo)) {
    throw new Error(`${repo} is not a git repository`);
  }

  if (options.thinking && !THINKING_LEVELS.has(options.thinking)) {
    throw new Error(
      `Invalid --thinking value '${options.thinking}'. Expected one of: ${[
        ...THINKING_LEVELS,
      ].join(", ")}`,
    );
  }

  // Load program first so front-matter can drive model resolution.
  const program = loadProgram(repo, options.program);
  const frontMatter: FrontMatter = program.frontMatter;

  // Per-field resolution: CLI > front matter > default.
  // For provider/model we also support a combined "provider/modelId" form
  // appearing in either the --model flag or the front matter `model` value.
  let cliProvider = options.provider;
  let cliModel = options.model;
  if (cliModel) {
    const split = splitModelRef(cliModel, cliProvider);
    if (split.provider) {
      cliProvider = split.provider;
      cliModel = split.modelId;
    }
  }
  let programProvider = frontMatter.provider;
  let programModel = frontMatter.model;
  if (programModel) {
    const split = splitModelRef(programModel, programProvider);
    if (split.provider) {
      programProvider = split.provider;
      programModel = split.modelId;
    }
  }

  const providerResolved = resolveField(cliProvider, programProvider, DEFAULT_PROVIDER);
  const modelResolved = resolveField(cliModel, programModel, DEFAULT_MODEL);
  const thinkingResolved = resolveField<string | undefined>(
    options.thinking,
    frontMatter.thinking,
    undefined,
  );
  if (thinkingResolved.value && !THINKING_LEVELS.has(thinkingResolved.value)) {
    throw new Error(
      `Invalid thinking level '${thinkingResolved.value}' (source: ${thinkingResolved.source}). ` +
        `Expected one of: ${[...THINKING_LEVELS].join(", ")}`,
    );
  }

  // Validate the model exists *before* mutating git state.
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const resolvedModel = modelRegistry.find(providerResolved.value, modelResolved.value);
  if (!resolvedModel) {
    throw new Error(modelNotFoundError(providerResolved.value, modelResolved.value));
  }

  // --tag: create a fresh branch from current HEAD. Refuses to reuse.
  if (options.tag) {
    const branchName = `autotester/${options.tag}`;
    if (localBranchExists(repo, branchName)) {
      throw new Error(`Branch '${branchName}' already exists locally. Pick a new --tag.`);
    }
    if (remoteBranchExists(repo, branchName)) {
      throw new Error(`Branch '${branchName}' already exists on a remote. Pick a new --tag.`);
    }
    if (!options.allowDirty && hasTrackedChanges(repo)) {
      throw new Error(
        `${repo} has uncommitted tracked changes. Commit/stash them or pass --allow-dirty.`,
      );
    }
    createBranch(repo, branchName);
  } else if (!options.allowDirty && hasTrackedChanges(repo)) {
    throw new Error(
      `${repo} has uncommitted tracked changes. Commit/stash them or pass --allow-dirty.`,
    );
  }

  const startHead = currentHead(repo);
  const attemptTimeout = options.attemptTimeout ?? DEFAULT_ATTEMPT_TIMEOUT;
  const branchName = currentBranch(repo);
  const config = loadConfig(repo);
  const scope = configToScope(config);

  const prompt = buildRunPrompt({
    repo,
    programText: program.text,
    maxAttempts: options.maxAttempts,
    allowPush: options.allowPush,
    branch: branchName,
    attemptTimeout,
    scope,
  });

  console.log(`repo: ${repo}`);
  console.log(`branch: ${branchName}`);
  console.log(`program: ${program.path}`);
  console.log(
    `model: ${providerResolved.value}/${modelResolved.value} ` +
      `(provider: ${providerResolved.source}, model: ${modelResolved.source})`,
  );
  if (thinkingResolved.value) {
    console.log(`thinking: ${thinkingResolved.value} (${thinkingResolved.source})`);
  }
  console.log(`max attempts: ${options.maxAttempts}`);
  console.log(`attempt timeout: ${attemptTimeout}s`);
  console.log(`start: ${startHead}`);
  if (scope) {
    if (scope.editable.length > 0) {
      console.log(`editable: ${scope.editable.join(", ")}`);
    }
    if (scope.readonly.length > 0) {
      console.log(`readonly: ${scope.readonly.join(", ")}`);
    }
  }
  const preStatus = gitStatus(repo);
  if (preStatus) {
    console.log(`status before:\n${preStatus}`);
  }

  const sessionOptions: Parameters<typeof createAgentSession>[0] = {
    cwd: repo,
    authStorage,
    modelRegistry,
    tools: ["read", "bash", "edit", "write"],
    model: resolvedModel,
  };
  if (thinkingResolved.value) {
    sessionOptions.thinkingLevel = thinkingResolved.value as NonNullable<
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
