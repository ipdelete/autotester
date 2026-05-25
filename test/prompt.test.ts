import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRunPrompt, loadProgram } from "../src/prompt.js";

describe("buildRunPrompt", () => {
  it("injects the program and bounded-run instructions", () => {
    const prompt = buildRunPrompt({
      repo: "/tmp/repo",
      programText: "# program\n\nDo useful work.",
      maxAttempts: 3,
      allowPush: false,
    });

    expect(prompt).toContain("/tmp/repo");
    expect(prompt).toContain("# program");
    expect(prompt).toContain("Run up to 3 attempts");
    expect(prompt).toContain("maximum, not a quota");
    expect(prompt).toContain("Do not push to any remote");
  });
});

describe("loadProgram", () => {
  it("prefers the target repo program.md", () => {
    const repo = mkdtempSync(join(tmpdir(), "autotester-"));
    writeFileSync(join(repo, "program.md"), "repo program", "utf8");

    const program = loadProgram(repo);

    expect(program.path).toBe(join(repo, "program.md"));
    expect(program.text).toBe("repo program");
  });
});
