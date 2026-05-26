import { describe, expect, it } from "vitest";
import { parseMetric, runMetric, runShell, type GateResult, type MetricResult } from "../src/metric.js";

describe("parseMetric", () => {
  it("parses an integer metric", () => {
    expect(parseMetric("metric: 1234\n")).toBe(1234);
  });

  it("parses a float metric", () => {
    expect(parseMetric("metric: 12.5\n")).toBe(12.5);
  });

  it("parses inf", () => {
    expect(parseMetric("metric: inf\n")).toBe(Number.POSITIVE_INFINITY);
  });

  it("returns the LAST metric line when several appear", () => {
    expect(parseMetric("metric: 100\nblah\nmetric: 42\n")).toBe(42);
  });

  it("returns undefined when no metric line is present", () => {
    expect(parseMetric("hello world\n")).toBeUndefined();
  });

  it("ignores 'metric:' that has no number", () => {
    expect(parseMetric("metric: foo\n")).toBeUndefined();
  });

  it("sets UV_LINK_MODE=copy for harness shell commands by default", () => {
    const r: GateResult = runShell(process.cwd(), 'test "$UV_LINK_MODE" = copy', 5);
    expect(r.ok).toBe(true);
  });

  it("runs metric commands and parses the last metric line", () => {
    const r: MetricResult = runMetric(process.cwd(), "printf 'metric: 99\\nmetric: 7\\n'", 5);
    expect(r.value).toBe(7);
    expect(r.stdout).toContain("metric: 99");
  });

  it("throws when a successful metric command emits no metric line", () => {
    expect(() => runMetric(process.cwd(), "echo no metric here", 5)).toThrow(/produced no 'metric: <float>' line/);
  });
});
