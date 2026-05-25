import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One row per recorded attempt. Lower metric is better; status is one of
 * keep | discard | crash. The commit column is always the *attempted* SHA
 * (kept for keep, reset-discarded for discard, never-committed for crash).
 */
export const RESULTS_HEADER =
  "attempt\telapsed_s\tmetric\tstatus\tcommit\tdescription\n";

export interface FrontMatter {
  provider?: string;
  model?: string;
  thinking?: string;
  /** Shell snippet that must exit 0 for an attempt to be kept. */
  gate?: string;
  /** Shell snippet that prints `metric: <float>` to stdout. */
  metric?: string;
  /** Optional human description for the baseline row. */
  baseline_description?: string;
}

export interface LoadedProgram {
  path: string;
  text: string;
  frontMatter: FrontMatter;
}

export interface PromptScope {
  readonly: string[];
  editable: string[];
}

export interface AttemptHistoryEntry {
  attempt: number;
  status: "keep" | "discard" | "crash";
  metric: number;
  description: string;
}

export interface FirstAttemptOptions {
  repo: string;
  programText: string;
  branch: string;
  scope?: PromptScope;
  baselineMetric: number;
  bestMetric: number;
  maxAttempts: number;
  timeBudgetSeconds?: number;
  attemptNumber: number;
}

export interface NextAttemptOptions {
  attemptNumber: number;
  remainingAttempts: number;
  remainingSeconds?: number;
  bestMetric: number;
  recent: AttemptHistoryEntry[];
}

export function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export function bundledProgramPath(name = "simplifier"): string {
  return resolve(packageRoot(), "programs", `${name}.md`);
}

const SCALAR_KEYS = new Set(["provider", "model", "thinking", "baseline_description"]);
const BLOCK_KEYS = new Set(["gate", "metric"]);
const ALL_KEYS = new Set<string>([...SCALAR_KEYS, ...BLOCK_KEYS]);

/**
 * Tiny YAML-ish front-matter parser. Supports two value shapes:
 *
 *   key: value                  (scalar; optional surrounding quotes stripped)
 *   key: |                      (literal block; consumed until dedent)
 *     line one
 *     line two
 *
 * The block dedent uses the minimum indentation of non-empty block lines.
 * Trailing blank lines on the block are dropped. Unknown keys throw.
 */
export function parseFrontMatter(source: string): { body: string; frontMatter: FrontMatter } {
  if (!source.startsWith("---")) {
    return { body: source, frontMatter: {} };
  }
  const lines = source.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { body: source, frontMatter: {} };
  }
  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) {
    throw new Error("program front matter: opening '---' has no matching closing '---'");
  }

  const frontMatter: FrontMatter = {};
  let i = 1;
  while (i < endIndex) {
    const raw = lines[i] ?? "";
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      i += 1;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new Error(`program front matter line ${i + 1}: expected 'key: value', got: ${raw}`);
    }
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (!ALL_KEYS.has(key)) {
      throw new Error(
        `program front matter line ${i + 1}: unknown key '${key}'. ` +
          `Valid keys: ${[...ALL_KEYS].join(", ")}`,
      );
    }

    if (value === "|" || value === "|+" || value === "|-") {
      // Block scalar: consume subsequent indented lines.
      if (!BLOCK_KEYS.has(key)) {
        throw new Error(
          `program front matter line ${i + 1}: key '${key}' does not accept a block value`,
        );
      }
      const blockLines: string[] = [];
      let j = i + 1;
      while (j < endIndex) {
        const blockRaw = lines[j] ?? "";
        if (blockRaw.trim() === "") {
          blockLines.push("");
          j += 1;
          continue;
        }
        const leading = blockRaw.match(/^ +/)?.[0].length ?? 0;
        if (leading === 0) break;
        blockLines.push(blockRaw);
        j += 1;
      }
      // Dedent by the minimum indent of non-empty lines.
      const indents = blockLines
        .filter((l) => l.trim() !== "")
        .map((l) => (l.match(/^ +/)?.[0].length ?? 0));
      const dedent = indents.length > 0 ? Math.min(...indents) : 0;
      const block = blockLines.map((l) => l.slice(dedent)).join("\n").replace(/\n+$/, "");
      (frontMatter as Record<string, string>)[key] = block;
      i = j;
      continue;
    }

    if (BLOCK_KEYS.has(key) && value !== "") {
      // Allow inline single-line shell too: `gate: pytest -q`.
      // Falls through to scalar handling below.
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    (frontMatter as Record<string, string>)[key] = value;
    i += 1;
  }

  const body = lines.slice(endIndex + 1).join("\n");
  return { body: body.replace(/^\n/, ""), frontMatter };
}

export function loadProgram(repo: string, programPath?: string): LoadedProgram {
  const path = programPath ? resolve(programPath) : resolve(repo, "program.md");
  try {
    const raw = readFileSync(path, "utf8");
    const { body, frontMatter } = parseFrontMatter(raw);
    return { path, text: body, frontMatter };
  } catch (error) {
    if (programPath) throw error;
    const fallback = bundledProgramPath();
    const raw = readFileSync(fallback, "utf8");
    const { body, frontMatter } = parseFrontMatter(raw);
    return { path: fallback, text: body, frontMatter };
  }
}

function formatScopeBlock(scope: PromptScope): string {
  const lines: string[] = ["Scope (enforced by a pre-commit hook):"];
  if (scope.editable.length > 0) {
    lines.push("- Editable paths (anything else will be rejected at commit):");
    for (const g of scope.editable) lines.push(`  - ${g}`);
  }
  if (scope.readonly.length > 0) {
    lines.push("- Read-only paths (must not be touched):");
    for (const g of scope.readonly) lines.push(`  - ${g}`);
  }
  lines.push(
    "If a commit is rejected with 'blocked: <path>', unstage that path and try a different approach.",
  );
  return lines.join("\n");
}

const ATTEMPT_PROTOCOL = `Per-attempt protocol (the harness enforces this; do not deviate):

1. Read context: the program above describes what kinds of changes to propose
   and what the metric measures. The harness — not you — runs the gate and
   metric commands declared in the program's front matter.
2. Propose exactly one focused change. Edit files using the edit/write tools.
3. Before committing, write a one-line JSON file at .autotester/attempt.json:
       {"description": "<short past-tense summary of the change>"}
   Create the .autotester/ directory if needed. This file is read by the
   harness to label the row in results.tsv.
4. Stage and commit your change with a clear commit message. The pre-commit
   hook may reject out-of-scope paths; if so, unstage those and try again.
5. STOP after committing. Do not run the gate or metric yourself, do not
   modify results.tsv, do not write the metric anywhere. The harness will
   tell you in the next turn whether the attempt was kept or discarded and
   what the new best metric is.

If you decide there are no more high-confidence changes to make, say so in
plain text in your final message of this turn and do NOT commit. The harness
treats "HEAD did not move" as the stop signal.`;

export function buildFirstAttemptPrompt(opts: FirstAttemptOptions): string {
  const variables: string[] = [
    `REPO=${opts.repo}`,
    `BRANCH=${opts.branch}`,
    `MAX_ATTEMPTS=${opts.maxAttempts}`,
    `BASELINE_METRIC=${opts.baselineMetric}`,
    `BEST_METRIC=${opts.bestMetric}`,
    `ATTEMPT=${opts.attemptNumber}`,
  ];
  if (opts.timeBudgetSeconds !== undefined) {
    variables.push(`TIME_BUDGET_SECONDS=${opts.timeBudgetSeconds}`);
  }
  const scopeBlock =
    opts.scope && (opts.scope.editable.length > 0 || opts.scope.readonly.length > 0)
      ? `\n${formatScopeBlock(opts.scope)}\n`
      : "";
  return `You are running autotester in this repository:

${opts.repo}

Run variables:

${variables.join("\n")}
${scopeBlock}
Program (what to optimize and how to propose changes):

<program>
${opts.programText.trim()}
</program>

${ATTEMPT_PROTOCOL}

This is attempt ${opts.attemptNumber}. Baseline metric is ${opts.baselineMetric};
your goal is to commit a change that lowers it. Begin.
`;
}

export function buildNextAttemptPrompt(opts: NextAttemptOptions): string {
  const recent = opts.recent
    .slice(-3)
    .map((r) => `  - attempt ${r.attempt}: ${r.status} (metric=${r.metric}) — ${r.description}`)
    .join("\n");
  const timeLine =
    opts.remainingSeconds !== undefined
      ? `Remaining: ${opts.remainingAttempts} attempts, ${opts.remainingSeconds}s time budget.`
      : `Remaining: ${opts.remainingAttempts} attempts.`;
  return `Attempt ${opts.attemptNumber}.

Current best metric: ${opts.bestMetric}.
${timeLine}

Recent attempts (most recent last):
${recent || "  (none yet)"}

Propose one more focused change, following the per-attempt protocol. If only
risky or subjective changes remain, say so in plain text and do NOT commit.
`;
}
