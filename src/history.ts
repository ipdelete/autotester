import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface RunSummary {
  tag: string;
  branch: string;
  startSha: string;
  startedAt: string; // ISO
  endedAt: string;   // ISO
  wallClockSec: number;
  baselineMetric: number;
  bestMetric: number;
  delta: number;
  attempts: number;
  keeps: number;
  discards: number;
  crashes: number;
  blocked: number;
  repairs: number;
  noFindingStreak?: number;
  model: string;
  reason: "completed" | "max-attempts" | "time-budget" | "agent-stopped" | "no-finding-budget" | "error";
  errorMessage?: string;
}

function runsDir(repo: string): string {
  return resolve(repo, ".autotester", "runs");
}

export function writeRunSummary(repo: string, summary: RunSummary): string {
  const dir = runsDir(repo);
  mkdirSync(dir, { recursive: true });
  // File name is sortable by start time + tag for predictable history order.
  const stamp = summary.startedAt.replace(/[:.]/g, "-");
  const safeTag = summary.tag.replace(/[\\/]/g, "-");
  const path = resolve(dir, `${stamp}_${safeTag}.json`);
  writeFileSync(path, JSON.stringify(summary, null, 2) + "\n");
  return path;
}

export function listRunSummaries(repo: string): RunSummary[] {
  const dir = runsDir(repo);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const out: RunSummary[] = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(dir, f), "utf8")) as RunSummary;
      out.push(parsed);
    } catch {
      // skip malformed
    }
  }
  return out;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

export function formatHistoryTable(rows: RunSummary[]): string {
  if (rows.length === 0) return "(no runs recorded)";
  const header = ["TAG", "WHEN", "MODEL", "BASE", "BEST", "Δ", "ATT", "K/D/C/B", "REP", "TIME", "WHY"];
  const lines: string[][] = [header];
  for (const r of rows) {
    const when = r.startedAt.slice(0, 16).replace("T", " ");
    const time = `${Math.round(r.wallClockSec)}s`;
    lines.push([
      r.tag,
      when,
      r.model,
      String(r.baselineMetric),
      String(r.bestMetric),
      r.delta >= 0 ? `+${r.delta}` : String(r.delta),
      String(r.attempts),
      `${r.keeps}/${r.discards}/${r.crashes}/${r.blocked}`,
      String(r.repairs ?? 0),
      time,
      r.reason,
    ]);
  }
  const widths = header.map((_, col) =>
    Math.max(...lines.map((row) => (row[col] ?? "").length)),
  );
  return lines
    .map((row) => row.map((cell, i) => pad(cell ?? "", widths[i] ?? 0)).join("  "))
    .join("\n");
}
