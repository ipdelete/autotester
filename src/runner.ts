import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  buildFirstAttemptPrompt,
  buildNextAttemptPrompt,
  loadProgram,
  type AttemptHistoryEntry,
  type FrontMatter,
} from "./prompt.js";
import {
  createBranch,
  currentBranch,
  gitStatus,
  hasTrackedChanges,
  headSha,
  isGitRepo,
  localBranchExists,
  remoteBranchExists,
  resetHard,
  summarizeGit,
} from "./git.js";
import { configToScope, loadConfig } from "./scope.js";
import { runMetric, runShell } from "./metric.js";
import { appendResultsRow, type AttemptStatus } from "./results.js";
import { writeRunSummary, type RunSummary } from "./history.js";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

const DEFAULT_PROVIDER = "github-copilot";
const DEFAULT_MODEL = "claude-opus-4.7";
const DEFAULT_ATTEMPT_TIMEOUT = 600;

export interface RunOptions {
  repo: string;
  program?: string;
  maxAttempts: number;
  timeBudget?: number; // seconds; undefined = no wall-clock cap
  allowDirty: boolean;
  allowPush: boolean;
  provider?: string;
  model?: string;
  thinking?: string;
  tag?: string;
  attemptTimeout?: number;
}

type Source = "flag" | "program" | "default";
interface Resolved<T> { value: T; source: Source; }

function resolveField<T>(flag: T | undefined, program: T | undefined, fallback: T): Resolved<T> {
  if (flag !== undefined) return { value: flag, source: "flag" };
  if (program !== undefined) return { value: program, source: "program" };
  return { value: fallback, source: "default" };
}

function splitModelRef(ref: string, expectedProvider?: string): { provider?: string; modelId: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return { modelId: ref };
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
    if (update.type === "text_delta") process.stdout.write(update.delta);
  } else if (event.type === "tool_execution_start") {
    process.stdout.write(`\n[tool] ${event.toolName}\n`);
  } else if (event.type === "tool_execution_end") {
    process.stdout.write(`[tool] ${event.toolName} done\n`);
  }
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

/** Read .autotester/attempt.json and delete it. Returns description or undefined. */
function consumeAttemptManifest(repo: string): string | undefined {
  const path = resolve(repo, ".autotester", "attempt.json");
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as { description?: string };
    return typeof parsed.description === "string" ? parsed.description : undefined;
  } catch {
    return undefined;
  } finally {
    try { rmSync(path); } catch { /* ignore */ }
  }
}

export async function runAutotester(options: RunOptions): Promise<number> {
  const repo = resolve(options.repo);
  if (!isGitRepo(repo)) throw new Error(`${repo} is not a git repository`);

  if (options.thinking && !THINKING_LEVELS.has(options.thinking)) {
    throw new Error(
      `Invalid --thinking value '${options.thinking}'. Expected one of: ${[...THINKING_LEVELS].join(", ")}`,
    );
  }

  const program = loadProgram(repo, options.program);
  const frontMatter: FrontMatter = program.frontMatter;

  if (!frontMatter.gate || !frontMatter.metric) {
    throw new Error(
      `program ${program.path} must declare 'gate' and 'metric' in YAML front matter. ` +
        `See programs/simplifier.md for the expected shape.`,
    );
  }

  // Per-field resolution: CLI > front matter > default.
  let cliProvider = options.provider;
  let cliModel = options.model;
  if (cliModel) {
    const split = splitModelRef(cliModel, cliProvider);
    if (split.provider) { cliProvider = split.provider; cliModel = split.modelId; }
  }
  let programProvider = frontMatter.provider;
  let programModel = frontMatter.model;
  if (programModel) {
    const split = splitModelRef(programModel, programProvider);
    if (split.provider) { programProvider = split.provider; programModel = split.modelId; }
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

  // Validate model before any git mutation.
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const resolvedModel = modelRegistry.find(providerResolved.value, modelResolved.value);
  if (!resolvedModel) {
    throw new Error(modelNotFoundError(providerResolved.value, modelResolved.value));
  }

  // --tag: fresh branch from HEAD; refuses to reuse.
  if (options.tag) {
    const branchName = `autotester/${options.tag}`;
    if (localBranchExists(repo, branchName)) {
      throw new Error(`Branch '${branchName}' already exists locally. Pick a new --tag.`);
    }
    if (remoteBranchExists(repo, branchName)) {
      throw new Error(`Branch '${branchName}' already exists on a remote. Pick a new --tag.`);
    }
    if (!options.allowDirty && hasTrackedChanges(repo)) {
      throw new Error(`${repo} has uncommitted tracked changes. Commit/stash them or pass --allow-dirty.`);
    }
    createBranch(repo, branchName);
  } else if (!options.allowDirty && hasTrackedChanges(repo)) {
    throw new Error(`${repo} has uncommitted tracked changes. Commit/stash them or pass --allow-dirty.`);
  }

  const startHead = headSha(repo);
  const attemptTimeout = options.attemptTimeout ?? DEFAULT_ATTEMPT_TIMEOUT;
  const branchName = currentBranch(repo);
  const config = loadConfig(repo);
  const scope = configToScope(config);
  const modelString = `${providerResolved.value}/${modelResolved.value}`;

  console.log(`repo: ${repo}`);
  console.log(`branch: ${branchName}`);
  console.log(`program: ${program.path}`);
  console.log(`model: ${modelString} (provider: ${providerResolved.source}, model: ${modelResolved.source})`);
  if (thinkingResolved.value) console.log(`thinking: ${thinkingResolved.value} (${thinkingResolved.source})`);
  console.log(`max attempts: ${options.maxAttempts}`);
  if (options.timeBudget !== undefined) console.log(`time budget: ${options.timeBudget}s`);
  console.log(`attempt timeout: ${attemptTimeout}s`);
  console.log(`start: ${startHead}`);
  if (scope) {
    if (scope.editable.length > 0) console.log(`editable: ${scope.editable.join(", ")}`);
    if (scope.readonly.length > 0) console.log(`readonly: ${scope.readonly.join(", ")}`);
  }

  // --- Baseline ----------------------------------------------------------
  console.log("\n[harness] running baseline gate + metric...");
  const t0 = Date.now();
  const baselineGate = runShell(repo, frontMatter.gate, attemptTimeout);
  if (!baselineGate.ok) {
    throw new Error(
      `Baseline gate failed (exit=${baselineGate.exitCode}). The repo must be in a passing state before autotester runs.\n${baselineGate.stderr || baselineGate.stdout}`,
    );
  }
  const baselineMetric = runMetric(repo, frontMatter.metric, attemptTimeout);
  console.log(`[harness] baseline metric: ${baselineMetric.value} (gate ${baselineGate.durationMs}ms, metric ${baselineMetric.durationMs}ms)`);

  appendResultsRow(repo, {
    attempt: 0,
    elapsedSec: (Date.now() - t0) / 1000,
    metric: baselineMetric.value,
    status: "keep",
    commit: startHead,
    description: frontMatter.baseline_description ?? "initial baseline",
  });

  let bestMetric = baselineMetric.value;
  let lastKeptHead = startHead;
  const history: AttemptHistoryEntry[] = [];
  let keeps = 0, discards = 0, crashes = 0, blocked = 0;
  let reason: RunSummary["reason"] = "completed";
  let errorMessage: string | undefined;

  // --- Session -----------------------------------------------------------
  const sessionOptions: Parameters<typeof createAgentSession>[0] = {
    cwd: repo,
    authStorage,
    modelRegistry,
    tools: ["read", "bash", "edit", "write"],
    model: resolvedModel,
  };
  if (thinkingResolved.value) {
    sessionOptions.thinkingLevel = thinkingResolved.value as NonNullable<typeof sessionOptions.thinkingLevel>;
  }

  const { session, modelFallbackMessage } = await createAgentSession(sessionOptions);
  if (modelFallbackMessage) console.error(modelFallbackMessage);
  const unsubscribe = session.subscribe(printEvent);

  const startedAt = new Date().toISOString();
  try {
    // --- Attempt loop --------------------------------------------------
    for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
      const elapsedSec = (Date.now() - t0) / 1000;
      if (options.timeBudget !== undefined && elapsedSec >= options.timeBudget) {
        console.log(`\n[harness] time budget exhausted at attempt ${attempt}`);
        reason = "time-budget";
        break;
      }
      const remainingSeconds = options.timeBudget !== undefined
        ? Math.max(0, Math.floor(options.timeBudget - elapsedSec))
        : undefined;

      const turnPrompt = attempt === 1
        ? buildFirstAttemptPrompt({
            repo,
            programText: program.text,
            branch: branchName,
            scope,
            baselineMetric: baselineMetric.value,
            bestMetric,
            maxAttempts: options.maxAttempts,
            timeBudgetSeconds: options.timeBudget,
            attemptNumber: 1,
          })
        : buildNextAttemptPrompt({
            attemptNumber: attempt,
            remainingAttempts: options.maxAttempts - attempt + 1,
            remainingSeconds,
            bestMetric,
            recent: history,
          });

      process.stdout.write(`\n[harness] --- attempt ${attempt}/${options.maxAttempts} (best=${bestMetric}, elapsed=${Math.round(elapsedSec)}s) ---\n`);
      const headBefore = headSha(repo);
      await session.prompt(turnPrompt, { expandPromptTemplates: false });
      const headAfter = headSha(repo);

      if (headAfter === headBefore) {
        process.stdout.write(`\n[harness] HEAD did not move; treating as agent stop signal\n`);
        reason = "agent-stopped";
        break;
      }

      const description = consumeAttemptManifest(repo) ?? "(no description)";

      // Gate
      process.stdout.write(`[harness] gate...\n`);
      const gate = runShell(repo, frontMatter.gate, attemptTimeout);
      let status: AttemptStatus;
      let metricValue: number;

      if (gate.timedOut || !gate.ok) {
        status = gate.timedOut ? "crash" : "discard";
        metricValue = Number.POSITIVE_INFINITY;
        process.stdout.write(`[harness] gate FAILED (exit=${gate.exitCode}${gate.timedOut ? ", timed out" : ""}); resetting to ${headBefore}\n`);
        resetHard(repo, headBefore);
        if (status === "crash") crashes += 1; else discards += 1;
      } else {
        let parsed: number | undefined;
        try {
          parsed = runMetric(repo, frontMatter.metric, attemptTimeout).value;
        } catch (err) {
          parsed = undefined;
          process.stdout.write(`[harness] metric command failed: ${(err as Error).message}\n`);
        }
        if (parsed === undefined || !Number.isFinite(parsed)) {
          status = "crash";
          metricValue = Number.POSITIVE_INFINITY;
          resetHard(repo, headBefore);
          crashes += 1;
        } else if (parsed < bestMetric) {
          status = "keep";
          metricValue = parsed;
          bestMetric = parsed;
          lastKeptHead = headAfter;
          keeps += 1;
          process.stdout.write(`[harness] kept: metric ${parsed} < best ${bestMetric === parsed ? "(new best)" : ""}\n`);
        } else {
          status = "discard";
          metricValue = parsed;
          process.stdout.write(`[harness] discarded: metric ${parsed} not better than best ${bestMetric}; resetting\n`);
          resetHard(repo, headBefore);
          discards += 1;
        }
      }

      appendResultsRow(repo, {
        attempt,
        elapsedSec: (Date.now() - t0) / 1000,
        metric: metricValue,
        status,
        commit: headAfter,
        description,
      });
      history.push({ attempt, status, metric: metricValue, description });

      if (attempt === options.maxAttempts) {
        reason = "max-attempts";
      }
    }
  } catch (err) {
    reason = "error";
    errorMessage = (err as Error).message;
    throw err;
  } finally {
    unsubscribe();

    const endedAt = new Date().toISOString();
    const wallClockSec = (Date.now() - t0) / 1000;
    const summary: RunSummary = {
      tag: options.tag ?? "(no-tag)",
      branch: branchName,
      startSha: startHead,
      startedAt,
      endedAt,
      wallClockSec,
      baselineMetric: baselineMetric.value,
      bestMetric,
      delta: bestMetric - baselineMetric.value,
      attempts: keeps + discards + crashes,
      keeps,
      discards,
      crashes,
      blocked,
      model: modelString,
      reason,
      errorMessage,
    };
    const summaryPath = writeRunSummary(repo, summary);

    console.log("\n\n--- autotester summary ---");
    console.log(`branch: ${branchName}`);
    console.log(`baseline -> best: ${baselineMetric.value} -> ${bestMetric} (Δ ${summary.delta >= 0 ? "+" : ""}${summary.delta})`);
    console.log(`attempts: ${summary.attempts} (${keeps} keep, ${discards} discard, ${crashes} crash)`);
    console.log(`wall clock: ${Math.round(wallClockSec)}s`);
    console.log(`stop reason: ${reason}`);
    console.log(`last kept HEAD: ${lastKeptHead}`);
    const git = summarizeGit(repo, startHead);
    if (git.recentCommits) console.log(`commits:\n${git.recentCommits}`);
    if (git.status) console.log(`status:\n${git.status}`);
    console.log(`summary: ${summaryPath}`);
  }

  return 0;
}
