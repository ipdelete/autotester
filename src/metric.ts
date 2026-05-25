import { spawnSync } from "node:child_process";

export interface GateResult {
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface MetricResult {
  value: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a shell snippet in `repo` with a wall-clock timeout. Returns the full
 * captured stdout/stderr (truncated by Node's default buffer limits) and
 * exit info.
 */
export function runShell(repo: string, script: string, timeoutSec: number): GateResult {
  const start = Date.now();
  const res = spawnSync("bash", ["-c", script], {
    cwd: repo,
    encoding: "utf8",
    timeout: timeoutSec * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const durationMs = Date.now() - start;
  const timedOut = res.signal === "SIGTERM" || (res.error as NodeJS.ErrnoException | null)?.code === "ETIMEDOUT";
  const exitCode = res.status ?? (timedOut ? 124 : 1);
  return {
    ok: exitCode === 0 && !timedOut,
    exitCode,
    timedOut,
    durationMs,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

/**
 * Run the metric command and parse the *last* `metric: <float>` line from
 * stdout. Throws if the gate has not already been run successfully or if no
 * metric line is found.
 */
export function runMetric(repo: string, script: string, timeoutSec: number): MetricResult {
  const r = runShell(repo, script, timeoutSec);
  if (!r.ok) {
    throw new Error(
      `metric command failed (exit=${r.exitCode}${r.timedOut ? ", timed out" : ""}):\n${r.stderr || r.stdout}`,
    );
  }
  const value = parseMetric(r.stdout);
  if (value === undefined) {
    throw new Error(
      `metric command produced no 'metric: <float>' line. stdout:\n${r.stdout}`,
    );
  }
  return { value, durationMs: r.durationMs, stdout: r.stdout, stderr: r.stderr };
}

const METRIC_RE = /^metric:\s*([-+0-9.eE]+|inf)\s*$/m;

export function parseMetric(stdout: string): number | undefined {
  // Find the *last* match so the agent can log debug "metric: 999" lines
  // earlier in output without confusing the parser.
  let m: RegExpExecArray | null;
  let last: string | undefined;
  const re = new RegExp(METRIC_RE.source, "gm");
  while ((m = re.exec(stdout)) !== null) last = m[1];
  if (last === undefined) return undefined;
  if (last === "inf") return Number.POSITIVE_INFINITY;
  const n = Number(last);
  return Number.isNaN(n) ? undefined : n;
}
