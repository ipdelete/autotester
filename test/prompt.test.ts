import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFirstAttemptPrompt, buildNextAttemptPrompt, loadProgram } from "../src/prompt.js";

describe("buildFirstAttemptPrompt", () => {
  it("injects repo, program, baseline, and protocol", () => {
    const prompt = buildFirstAttemptPrompt({
      repo: "/tmp/repo",
      programText: "# program\n\nDo useful work.",
      branch: "autotester/x",
      baselineMetric: 100,
      bestMetric: 100,
      maxAttempts: 3,
      attemptNumber: 1,
    });

    expect(prompt).toContain("/tmp/repo");
    expect(prompt).toContain("# program");
    expect(prompt).toContain("BASELINE_METRIC=100");
    expect(prompt).toContain("BRANCH=autotester/x");
    expect(prompt).toContain(".autotester/attempt.json");
    expect(prompt).toContain("HEAD did not move");
  });

  it("includes the time budget when set", () => {
    const prompt = buildFirstAttemptPrompt({
      repo: "/tmp/repo",
      programText: "p",
      branch: "b",
      baselineMetric: 1,
      bestMetric: 1,
      maxAttempts: 2,
      timeBudgetSeconds: 3600,
      attemptNumber: 1,
    });
    expect(prompt).toContain("TIME_BUDGET_SECONDS=3600");
  });
});

describe("buildNextAttemptPrompt", () => {
  it("summarizes recent attempts and remaining budget", () => {
    const prompt = buildNextAttemptPrompt({
      attemptNumber: 4,
      remainingAttempts: 7,
      remainingSeconds: 1200,
      bestMetric: 1990,
      recent: [
        { attempt: 1, status: "keep", metric: 1995, description: "a" },
        { attempt: 2, status: "discard", metric: 1996, description: "b" },
        { attempt: 3, status: "keep", metric: 1990, description: "c" },
      ],
    });
    expect(prompt).toContain("Attempt 4");
    expect(prompt).toContain("Current best metric: 1990");
    expect(prompt).toContain("7 attempts");
    expect(prompt).toContain("1200s time budget");
    expect(prompt).toContain("attempt 1: keep");
    expect(prompt).toContain("attempt 3: keep");
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

  it("reports parse errors in the target repo program.md", () => {
    const repo = mkdtempSync(join(tmpdir(), "autotester-"));
    writeFileSync(join(repo, "program.md"), "---\ntemperature: 0.7\n---\nbody", "utf8");

    expect(() => loadProgram(repo)).toThrow(/unknown key 'temperature'/);
  });
});
