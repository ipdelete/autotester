import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { consumeAttemptManifestResult, parseAttemptManifest, requireBugfixManifest } from "../src/attempt.js";

describe("attempt manifest", () => {
  it("parses optimize descriptions", () => {
    const m = parseAttemptManifest('{"description":"small refactor"}');
    expect(m.description).toBe("small refactor");
  });

  it("accepts a complete bugfix manifest", () => {
    const m = requireBugfixManifest(parseAttemptManifest(JSON.stringify({
      description: "fix empty input",
      repro_command: "python repro.py",
      test_command: "pytest tests/test_parser.py -q",
      test_files: ["tests/test_parser.py"],
      fix_files: ["src/parser.py"],
      parent_failure_pattern: "AssertionError",
    })));
    expect(m.test_files).toEqual(["tests/test_parser.py"]);
    expect(m.fix_files).toEqual(["src/parser.py"]);
  });

  it("rejects missing bugfix fields", () => {
    const m = parseAttemptManifest('{"description":"missing fields"}');
    expect(() => requireBugfixManifest(m)).toThrow(/repro_command/);
  });

  it("rejects non-string entries in bugfix file lists", () => {
    expect(() => parseAttemptManifest(JSON.stringify({
      description: "bad file list",
      repro_command: "python repro.py",
      test_command: "pytest tests/test_parser.py -q",
      test_files: ["tests/test_parser.py", 42],
      fix_files: ["src/parser.py"],
    }))).toThrow(/test_files\[1\]/);
  });

  it("returns an error instead of throwing when consuming malformed JSON", () => {
    const repo = mkdtempSync(join(tmpdir(), "autotester-attempt-"));
    const dir = join(repo, ".autotester");
    mkdirSync(dir);
    writeFileSync(join(dir, "attempt.json"), '{"description":"bad" "missing comma"}', "utf8");
    const result = consumeAttemptManifestResult(repo);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/JSON/);
  });

  it("rejects invalid parent failure regex", () => {
    const m = parseAttemptManifest(JSON.stringify({
      description: "bad regex",
      repro_command: "python repro.py",
      test_command: "pytest tests/test_parser.py -q",
      test_files: ["tests/test_parser.py"],
      fix_files: ["src/parser.py"],
      parent_failure_pattern: "[",
    }));
    expect(() => requireBugfixManifest(m)).toThrow(/invalid parent_failure_pattern/);
  });
});
