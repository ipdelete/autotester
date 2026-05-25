import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AttemptManifest } from "./attempt.js";
import { requireBugfixManifest } from "./attempt.js";
import { runShell, type GateResult } from "./metric.js";
import {
  changedFiles,
  createDetachedWorktree,
  removeWorktree,
} from "./git.js";
import type { AttemptStatus } from "./results.js";

export interface BugfixValidationOptions {
  repo: string;
  attempt: number;
  parent: string;
  child: string;
  manifest?: AttemptManifest;
  gate: string;
  timeoutSec: number;
  verifiedRegressionFixes: number;
  repairs?: RepairRecord[];
}

export interface BugfixValidationResult {
  status: AttemptStatus;
  metric: number;
  description: string;
  reason: string;
  diagnostic: AttemptDiagnostic;
}

export interface RepairRecord {
  trigger: string;
  before: AttemptDiagnostic;
  after?: {
    status: AttemptStatus;
    reason: string;
    child: string;
  };
}

interface CommandDiag {
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

export interface AttemptDiagnostic {
  attempt: number;
  status: AttemptStatus;
  reason: string;
  parent: string;
  child: string;
  description: string;
  changedFiles?: string[];
  manifest?: AttemptManifest;
  repaired: boolean;
  repairCount: number;
  repairs: RepairRecord[];
  commands: {
    parent_repro?: CommandDiag;
    child_repro?: CommandDiag;
    targeted_test?: CommandDiag;
    gate?: CommandDiag;
  };
}

const PROTECTED_PATHS = [
  "program.md",
  "results.tsv",
  ".autotester.json",
  ".autotester/attempt.json",
];

const PROTECTED_PREFIXES = [
  ".autotester/runs/",
  ".autotester/attempts/",
];

export function isProtectedPath(path: string): boolean {
  return PROTECTED_PATHS.includes(path) || PROTECTED_PREFIXES.some((p) => path.startsWith(p));
}

export function validateChangedFiles(
  files: string[],
  testFiles: string[],
  fixFiles: string[],
): string | undefined {
  const changed = new Set(files);
  const declared = new Set([...testFiles, ...fixFiles]);
  for (const file of files) {
    if (isProtectedPath(file)) return `protected file changed: ${file}`;
    if (!declared.has(file)) return `changed file not declared in manifest: ${file}`;
  }
  for (const file of declared) {
    if (!changed.has(file)) return `manifest-declared file was not changed: ${file}`;
  }
  return undefined;
}

function tail(s: string, max = 4000): string {
  return s.length <= max ? s : s.slice(-max);
}

function diag(r: GateResult): CommandDiag {
  return {
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    durationMs: r.durationMs,
    stdoutTail: tail(r.stdout),
    stderrTail: tail(r.stderr),
  };
}

export function writeBugfixDiagnostic(repo: string, diagnostic: AttemptDiagnostic): void {
  const dir = resolve(repo, ".autotester", "attempts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, `${String(diagnostic.attempt).padStart(4, "0")}.json`),
    JSON.stringify(diagnostic, null, 2) + "\n",
  );
}

function result(
  repo: string,
  diagnostic: AttemptDiagnostic,
  status: AttemptStatus,
  metric: number,
  reason: string,
): BugfixValidationResult {
  diagnostic.status = status;
  diagnostic.reason = reason;
  writeBugfixDiagnostic(repo, diagnostic);
  return { status, metric, reason, description: diagnostic.description, diagnostic };
}

export function validateBugfixAttempt(options: BugfixValidationOptions): BugfixValidationResult {
  const diagnostic: AttemptDiagnostic = {
    attempt: options.attempt,
    status: "crash",
    reason: "not-started",
    parent: options.parent,
    child: options.child,
    description: options.manifest?.description ?? "(invalid or missing bugfix manifest)",
    manifest: options.manifest,
    repaired: (options.repairs?.length ?? 0) > 0,
    repairCount: options.repairs?.length ?? 0,
    repairs: options.repairs ?? [],
    commands: {},
  };

  let manifest: ReturnType<typeof requireBugfixManifest>;
  try {
    if (!options.manifest) throw new Error("missing .autotester/attempt.json");
    manifest = requireBugfixManifest(options.manifest);
    diagnostic.description = manifest.description;
  } catch (err) {
    return result(options.repo, diagnostic, "crash", Number.POSITIVE_INFINITY, (err as Error).message);
  }

  const files = changedFiles(options.repo, options.parent, options.child);
  diagnostic.changedFiles = files;
  const fileError = validateChangedFiles(files, manifest.test_files, manifest.fix_files);
  if (fileError) {
    return result(options.repo, diagnostic, "crash", Number.POSITIVE_INFINITY, fileError);
  }

  let parentWorktree: string | undefined;
  let childWorktree: string | undefined;
  try {
    parentWorktree = createDetachedWorktree(options.repo, options.parent);
    childWorktree = createDetachedWorktree(options.repo, options.child);

    const parentRepro = runShell(parentWorktree, manifest.repro_command, options.timeoutSec);
    diagnostic.commands.parent_repro = diag(parentRepro);
    if (parentRepro.timedOut) {
      return result(options.repo, diagnostic, "crash", Number.POSITIVE_INFINITY, "parent repro timed out");
    }
    if (parentRepro.ok) {
      return result(options.repo, diagnostic, "discard", Number.POSITIVE_INFINITY, "parent repro passed; bug not proven pre-existing");
    }
    if (manifest.parent_failure_pattern) {
      const re = new RegExp(manifest.parent_failure_pattern);
      const combined = `${parentRepro.stdout}\n${parentRepro.stderr}`;
      if (!re.test(combined)) {
        return result(options.repo, diagnostic, "discard", Number.POSITIVE_INFINITY, "parent failure did not match parent_failure_pattern");
      }
    }

    const childRepro = runShell(childWorktree, manifest.repro_command, options.timeoutSec);
    diagnostic.commands.child_repro = diag(childRepro);
    if (!childRepro.ok) {
      return result(options.repo, diagnostic, childRepro.timedOut ? "crash" : "discard", Number.POSITIVE_INFINITY, "child repro failed");
    }

    const targetedTest = runShell(childWorktree, manifest.test_command, options.timeoutSec);
    diagnostic.commands.targeted_test = diag(targetedTest);
    if (!targetedTest.ok) {
      return result(options.repo, diagnostic, targetedTest.timedOut ? "crash" : "discard", Number.POSITIVE_INFINITY, "targeted regression test failed");
    }

    const gate = runShell(childWorktree, options.gate, options.timeoutSec);
    diagnostic.commands.gate = diag(gate);
    if (!gate.ok) {
      return result(options.repo, diagnostic, gate.timedOut ? "crash" : "discard", Number.POSITIVE_INFINITY, "full gate failed");
    }

    return result(
      options.repo,
      diagnostic,
      "keep",
      -(options.verifiedRegressionFixes + 1),
      "verified defect retired",
    );
  } catch (err) {
    return result(options.repo, diagnostic, "crash", Number.POSITIVE_INFINITY, (err as Error).message);
  } finally {
    if (parentWorktree) removeWorktree(options.repo, parentWorktree);
    if (childWorktree) removeWorktree(options.repo, childWorktree);
  }
}
