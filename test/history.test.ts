import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatHistoryTable, writeRunSummary, type RunSummary } from "../src/history.js";

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    tag: "bug2",
    branch: "autotester/bug2",
    startSha: "abc1234",
    startedAt: "2026-05-25T21:00:00.000Z",
    endedAt: "2026-05-25T21:10:00.000Z",
    wallClockSec: 600,
    baselineMetric: 0,
    bestMetric: -2,
    delta: -2,
    attempts: 2,
    keeps: 2,
    discards: 0,
    crashes: 0,
    blocked: 0,
    repairs: 1,
    model: "github-copilot/gpt-5.5",
    reason: "max-attempts",
    ...overrides,
  };
}

describe("formatHistoryTable", () => {
  it("includes repair counts", () => {
    const table = formatHistoryTable([summary()]);
    expect(table).toContain("REP");
    expect(table).toContain("  1  ");
  });

  it("writes run summaries for tags that contain slashes", () => {
    const repo = mkdtempSync(join(tmpdir(), "autotester-history-"));
    const path = writeRunSummary(repo, summary({ tag: "feature/bugfix" }));

    expect(path).toContain("feature-bugfix.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ tag: "feature/bugfix" });
  });
});
