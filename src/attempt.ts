import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

export interface AttemptManifest {
  description: string;
  repro_command?: string;
  test_command?: string;
  test_files?: string[];
  fix_files?: string[];
  parent_failure_pattern?: string;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`attempt manifest: '${field}' must be a non-empty string`);
  }
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`attempt manifest: '${field}' must be a non-empty string array`);
  }
  const out = value.map((v, i) => {
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`attempt manifest: '${field}[${i}]' must be a non-empty string`);
    }
    return v;
  });
  return out;
}

export function parseAttemptManifest(raw: string): AttemptManifest {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const description = asString(parsed.description, "description").replace(/\r?\n/g, " ").trim();
  return {
    description,
    repro_command: typeof parsed.repro_command === "string" ? parsed.repro_command : undefined,
    test_command: typeof parsed.test_command === "string" ? parsed.test_command : undefined,
    test_files: Array.isArray(parsed.test_files) ? parsed.test_files.filter((v): v is string => typeof v === "string") : undefined,
    fix_files: Array.isArray(parsed.fix_files) ? parsed.fix_files.filter((v): v is string => typeof v === "string") : undefined,
    parent_failure_pattern: typeof parsed.parent_failure_pattern === "string" ? parsed.parent_failure_pattern : undefined,
  };
}

export function requireBugfixManifest(manifest: AttemptManifest): Required<Pick<AttemptManifest,
  "description" | "repro_command" | "test_command" | "test_files" | "fix_files"
>> & Pick<AttemptManifest, "parent_failure_pattern"> {
  const description = asString(manifest.description, "description");
  const repro_command = asString(manifest.repro_command, "repro_command");
  const test_command = asString(manifest.test_command, "test_command");
  const test_files = asStringArray(manifest.test_files, "test_files");
  const fix_files = asStringArray(manifest.fix_files, "fix_files");
  if (manifest.parent_failure_pattern !== undefined) {
    try {
      // Validate early so harness failures are explicit protocol crashes.
      new RegExp(manifest.parent_failure_pattern);
    } catch (err) {
      throw new Error(`attempt manifest: invalid parent_failure_pattern: ${(err as Error).message}`);
    }
  }
  return {
    description,
    repro_command,
    test_command,
    test_files,
    fix_files,
    parent_failure_pattern: manifest.parent_failure_pattern,
  };
}

/** Read .autotester/attempt.json and delete it. */
export function consumeAttemptManifest(repo: string): AttemptManifest | undefined {
  const path = resolve(repo, ".autotester", "attempt.json");
  if (!existsSync(path)) return undefined;
  try {
    return parseAttemptManifest(readFileSync(path, "utf8"));
  } finally {
    try { rmSync(path); } catch { /* ignore */ }
  }
}
