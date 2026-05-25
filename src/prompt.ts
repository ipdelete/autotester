import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RESULTS_HEADER =
  "commit\tstatus\tcategory\tfiles_changed\ttests\tresult\tdescription\n";

export interface PromptOptions {
  repo: string;
  programText: string;
  maxAttempts: number;
  allowPush: boolean;
}

export function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export function bundledProgramPath(name = "autotester"): string {
  return resolve(packageRoot(), "programs", `${name}.md`);
}

export function loadProgram(repo: string, programPath?: string): {
  path: string;
  text: string;
} {
  const path = programPath
    ? resolve(programPath)
    : resolve(repo, "program.md");

  try {
    return { path, text: readFileSync(path, "utf8") };
  } catch (error) {
    if (programPath) {
      throw error;
    }
    const fallback = bundledProgramPath();
    return { path: fallback, text: readFileSync(fallback, "utf8") };
  }
}

export function buildRunPrompt(options: PromptOptions): string {
  const pushInstruction = options.allowPush
    ? "You may push only if the program explicitly tells you to and the target branch is safe."
    : "Do not push to any remote.";

  return `You are running autotester in this repository:

${options.repo}

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
