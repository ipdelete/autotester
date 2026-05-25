import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { appendResultsRow } from "../src/results.js";
import { RESULTS_HEADER } from "../src/prompt.js";

function tmpRepo(): string {
  return mkdtempSync(resolve(tmpdir(), "autotester-results-"));
}

describe("appendResultsRow", () => {
  it("creates the file with the v2 header and appends a row", () => {
    const repo = tmpRepo();
    appendResultsRow(repo, {
      attempt: 0,
      elapsedSec: 0,
      metric: 2008,
      status: "keep",
      commit: "abc1234",
      description: "initial baseline",
    });
    const text = readFileSync(resolve(repo, "results.tsv"), "utf8");
    expect(text.startsWith(RESULTS_HEADER)).toBe(true);
    expect(text.trim().split("\n")).toHaveLength(2);
    expect(text).toMatch(/\b0\t0\t2008\tkeep\tabc1234\tinitial baseline$/m);
  });

  it("formats inf and integers cleanly", () => {
    const repo = tmpRepo();
    appendResultsRow(repo, {
      attempt: 1,
      elapsedSec: 12.6,
      metric: Number.POSITIVE_INFINITY,
      status: "crash",
      commit: "def5678",
      description: "broke tests",
    });
    const lines = readFileSync(resolve(repo, "results.tsv"), "utf8").trim().split("\n");
    // elapsedSec rounds; metric prints "inf"
    expect(lines[1]).toBe("1\t13\tinf\tcrash\tdef5678\tbroke tests");
  });

  it("sanitizes tab/newline in description", () => {
    const repo = tmpRepo();
    appendResultsRow(repo, {
      attempt: 2,
      elapsedSec: 1,
      metric: 99,
      status: "discard",
      commit: "0000000",
      description: "had\ta tab and\nnewline",
    });
    const text = readFileSync(resolve(repo, "results.tsv"), "utf8");
    expect(text.split("\n")).toHaveLength(3); // header + row + trailing newline
    expect(text).toMatch(/had a tab and newline/);
  });
});
