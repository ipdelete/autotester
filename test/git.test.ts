import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { currentBranch, hasTrackedChanges, isGitRepo } from "../src/git.js";

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
});
