import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RESULTS_HEADER =
  "commit\tmetric\tstatus\tcategory\tdescription\n";

export interface FrontMatter {
  provider?: string;
  model?: string;
  thinking?: string;
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

export interface PromptOptions {
  repo: string;
  programText: string;
  maxAttempts: number;
  allowPush: boolean;
  branch?: string;
  attemptTimeout?: number;
  scope?: PromptScope;
}

export function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export function bundledProgramPath(name = "autotester"): string {
  return resolve(packageRoot(), "programs", `${name}.md`);
}

const FRONT_MATTER_KEYS = new Set(["provider", "model", "thinking"]);

/**
 * Parse an optional YAML-ish front-matter block from the head of a program
 * file. The supported surface is intentionally tiny: a `---` fence, then
 * `key: value` lines using only the keys in FRONT_MATTER_KEYS, then `---`.
 *
 * Returns the stripped body and the parsed front matter. If no fence is
 * present at the very first line, the body is returned unchanged and an
 * empty front matter is returned.
 *
 * Throws on malformed front matter so the human sees the problem instead
 * of silently running with defaults.
 */
export function parseFrontMatter(source: string): { body: string; frontMatter: FrontMatter } {
  if (!source.startsWith("---")) {
    return { body: source, frontMatter: {} };
  }
  const lines = source.split("\n");
  // Require the opening fence to be exactly "---" on its own line.
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
  for (let i = 1; i < endIndex; i += 1) {
    const raw = lines[i] ?? "";
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new Error(`program front matter line ${i + 1}: expected 'key: value', got: ${raw}`);
    }
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (!FRONT_MATTER_KEYS.has(key)) {
      throw new Error(
        `program front matter line ${i + 1}: unknown key '${key}'. ` +
          `Valid keys: ${[...FRONT_MATTER_KEYS].join(", ")}`,
      );
    }
    // Strip a single layer of surrounding quotes for ergonomics.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    (frontMatter as Record<string, string>)[key] = value;
  }

  const body = lines.slice(endIndex + 1).join("\n");
  // Drop a single leading blank line so the rendered program reads naturally.
  return { body: body.replace(/^\n/, ""), frontMatter };
}

export function loadProgram(repo: string, programPath?: string): LoadedProgram {
  const path = programPath ? resolve(programPath) : resolve(repo, "program.md");

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
    const { body, frontMatter } = parseFrontMatter(raw);
    return { path, text: body, frontMatter };
  } catch (error) {
    if (programPath) {
      throw error;
    }
    const fallback = bundledProgramPath();
    raw = readFileSync(fallback, "utf8");
    const { body, frontMatter } = parseFrontMatter(raw);
    return { path: fallback, text: body, frontMatter };
  }
}

function formatScopeBlock(scope: PromptScope): string {
  const lines: string[] = ["Scope (enforced by a pre-commit hook):"];
  if (scope.editable.length > 0) {
    lines.push("- Editable paths (anything else will be rejected at commit):");
    for (const glob of scope.editable) {
      lines.push(`  - ${glob}`);
    }
  }
  if (scope.readonly.length > 0) {
    lines.push("- Read-only paths (must not be touched):");
    for (const glob of scope.readonly) {
      lines.push(`  - ${glob}`);
    }
  }
  lines.push(
    "If a commit is rejected with 'blocked: <path>', unstage that path and try a different approach.",
  );
  return lines.join("\n");
}

export function buildRunPrompt(options: PromptOptions): string {
  const pushInstruction = options.allowPush
    ? "You may push only if the program explicitly tells you to and the target branch is safe."
    : "Do not push to any remote.";

  const variables: string[] = [`MAX_ATTEMPTS=${options.maxAttempts}`];
  if (options.branch) {
    variables.push(`BRANCH=${options.branch}`);
  }
  if (options.attemptTimeout !== undefined) {
    variables.push(`ATTEMPT_TIMEOUT=${options.attemptTimeout}`);
  }
  const variablesBlock = variables.join("\n");

  const scopeBlock = options.scope && (options.scope.editable.length > 0 || options.scope.readonly.length > 0)
    ? `\n${formatScopeBlock(options.scope)}\n`
    : "";

  return `You are running autotester in this repository:

${options.repo}

Run variables (interpolate these into shell commands the program defines):

${variablesBlock}
${scopeBlock}
Follow this program exactly:

<program>
${options.programText.trim()}
</program>

Runtime constraints:

- Run up to ${options.maxAttempts} attempts. This is a maximum, not a quota.
- Stop early if only risky, subjective, broad, or low-confidence changes remain.
- ${pushInstruction}
- Preserve any pre-existing user changes.
- At the end, report attempts, kept commits, discarded/crashed attempts, validation commands, files changed, and notable risks.
`;
}
