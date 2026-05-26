import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  changedFiles,
  commitCount,
  createBranch,
  createDetachedWorktree,
  currentBranch,
  currentHead,
  gitStatus,
  hasTrackedChanges,
  isGitRepo,
  localBranchExists,
  remoteBranchExists,
  removeWorktree,
  resetHard,
  summarizeGit,
  type GitSummary,
} from "../src/git.js";

function git(repo: string, args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

describe("git helpers", () => {
  it("detects git repos and tracked changes", () => {
    const repo = mkdtempSync(join(tmpdir(), "autotester-git-"));
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test User"]);
    writeFileSync(join(repo, "README.md"), "# test\n", "utf8");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "initial"]);

    expect(isGitRepo(repo)).toBe(true);
    expect(currentBranch(repo)).toBe("main");
    expect(hasTrackedChanges(repo)).toBe(false);

    writeFileSync(join(repo, "README.md"), "# changed\n", "utf8");
    expect(hasTrackedChanges(repo)).toBe(true);
  });

  it("tracks branch, history, reset, and worktree helpers", () => {
    const repo = mkdtempSync(join(tmpdir(), "autotester-git-"));
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test User"]);
    writeFileSync(join(repo, "README.md"), "# test\n", "utf8");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "initial"]);
    const base = currentHead(repo);

    expect(gitStatus(repo)).toBe("");
    expect(localBranchExists(repo, "feature/test")).toBe(false);
    createBranch(repo, "feature/test");
    expect(currentBranch(repo)).toBe("feature/test");
    expect(localBranchExists(repo, "feature/test")).toBe(true);

    writeFileSync(join(repo, "README.md"), "# changed\n", "utf8");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "change readme"]);
    expect(commitCount(repo, base)).toBe(1);
    expect(changedFiles(repo, base)).toEqual(["README.md"]);

    const remote = mkdtempSync(join(tmpdir(), "autotester-remote-"));
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "origin", "HEAD:feature/test"]);
    expect(remoteBranchExists(repo, "feature/test")).toBe(true);

    const worktree = createDetachedWorktree(repo, currentHead(repo));
    expect(isGitRepo(worktree)).toBe(true);
    removeWorktree(repo, worktree);
    expect(existsSync(worktree)).toBe(false);

    writeFileSync(join(repo, "README.md"), "# dirty\n", "utf8");
    writeFileSync(join(repo, "scratch.txt"), "remove me\n", "utf8");
    writeFileSync(join(repo, "results.tsv"), "keep me\n", "utf8");
    resetHard(repo, base);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("# test\n");
    expect(existsSync(join(repo, "scratch.txt"))).toBe(false);
    expect(readFileSync(join(repo, "results.tsv"), "utf8")).toBe("keep me\n");

    const summary: GitSummary = summarizeGit(repo, base);
    expect(summary.branch).toBe("feature/test");
    expect(summary.status).toBe("?? results.tsv");
    expect(summary.recentCommits).toBe("");
  });
});
