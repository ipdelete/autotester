import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitSummary {
  branch: string;
  status: string;
  recentCommits: string;
}

export function git(repo: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function isGitRepo(repo: string): boolean {
  try {
    git(repo, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

export function gitStatus(repo: string): string {
  return git(repo, ["status", "--short", "--untracked-files=all"]);
}

export function hasTrackedChanges(repo: string): boolean {
  const status = git(repo, ["status", "--short", "--untracked-files=no"]);
  return status.length > 0;
}

export function currentBranch(repo: string): string {
  return git(repo, ["branch", "--show-current"]) || "(detached)";
}

export function currentHead(repo: string): string {
  return git(repo, ["rev-parse", "--short=7", "HEAD"]);
}

export function localBranchExists(repo: string, name: string): boolean {
  try {
    git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

export function remoteBranchExists(repo: string, name: string): boolean {
  try {
    const out = git(repo, ["for-each-ref", "--format=%(refname)", `refs/remotes/*/${name}`]);
    return out.length > 0;
  } catch {
    return false;
  }
}

export function createBranch(repo: string, name: string): void {
  git(repo, ["checkout", "-b", name]);
}

export function headSha(repo: string, length = 7): string {
  return git(repo, ["rev-parse", `--short=${length}`, "HEAD"]);
}

export function resetHard(repo: string, ref: string): void {
  git(repo, ["reset", "--hard", ref]);
  // Also clean untracked files that the attempt left behind (e.g. stray
  // build artifacts), but preserve our own .autotester/ and results.tsv.
  git(repo, ["clean", "-fd", "-e", ".autotester/", "-e", "results.tsv", "-e", "program.md"]);
}

export function commitCount(repo: string, from: string, to = "HEAD"): number {
  return Number.parseInt(git(repo, ["rev-list", "--count", `${from}..${to}`]), 10);
}

export function changedFiles(repo: string, from: string, to = "HEAD"): string[] {
  const out = git(repo, ["diff", "--name-only", `${from}..${to}`]);
  return out ? out.split("\n").filter(Boolean) : [];
}

export function createDetachedWorktree(repo: string, ref: string): string {
  const path = mkdtempSync(join(tmpdir(), "autotester-worktree-"));
  git(repo, ["worktree", "add", "--detach", path, ref]);
  return path;
}

export function removeWorktree(repo: string, path: string): void {
  try {
    git(repo, ["worktree", "remove", "--force", path]);
  } catch {
    // Best-effort cleanup. If git refuses, prune stale metadata.
    try { git(repo, ["worktree", "prune"]); } catch { /* ignore */ }
  }
}

export function summarizeGit(repo: string, since?: string): GitSummary {
  const branch = currentBranch(repo);
  const status = gitStatus(repo);
  const logArgs = since
    ? ["log", "--oneline", "--decorate", `${since}..HEAD`]
    : ["log", "--oneline", "--decorate", "-10"];
  let recentCommits = "";
  try {
    recentCommits = git(repo, logArgs);
  } catch {
    recentCommits = "";
  }
  return { branch, status, recentCommits };
}
