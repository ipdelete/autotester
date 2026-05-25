import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { RESULTS_HEADER } from "./prompt.js";

export type AttemptStatus = "keep" | "discard" | "crash";

export interface ResultsRow {
  attempt: number;
  elapsedSec: number;
  metric: number;
  status: AttemptStatus;
  commit: string;
  description: string;
}

function ensureFile(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, RESULTS_HEADER);
    return;
  }
  // If the file exists but has the old (pre-v2) header, migrate it: rotate
  // the old file aside and start fresh. We never silently mix shapes.
  const head = readFileSync(path, "utf8").split("\n", 1)[0] ?? "";
  if (head + "\n" !== RESULTS_HEADER) {
    const backup = `${path}.v1-${Date.now()}`;
    writeFileSync(backup, readFileSync(path));
    writeFileSync(path, RESULTS_HEADER);
  }
}

function formatMetric(metric: number): string {
  if (!Number.isFinite(metric)) return "inf";
  // Preserve integers as integers; otherwise up to 6 significant digits.
  return Number.isInteger(metric) ? String(metric) : String(Number(metric.toPrecision(6)));
}

function sanitize(s: string): string {
  return s.replace(/\t/g, " ").replace(/\r?\n/g, " ").trim();
}

export function appendResultsRow(repo: string, row: ResultsRow): void {
  const path = resolve(repo, "results.tsv");
  ensureFile(path);
  const line =
    [
      String(row.attempt),
      String(Math.round(row.elapsedSec)),
      formatMetric(row.metric),
      row.status,
      row.commit,
      sanitize(row.description),
    ].join("\t") + "\n";
  appendFileSync(path, line);
}
