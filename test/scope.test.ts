import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installPreCommitHook, writeConfig } from "../src/scope.js";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function mkRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "autotester-scope-"));
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  writeFileSync(join(repo, "README.md"), "# test\n", "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

describe("pre-commit scope hook", () => {
  it("blocks commits that touch readonly paths", () => {
    const repo = mkRepo();
    writeConfig(repo, { readonly: ["src/prepare.py"], editable: [] });
    const installed = installPreCommitHook(repo);
    expect(installed.installed).toBe(true);
    const hookPath = join(repo, ".git", "hooks", "pre-commit");
    expect(statSync(hookPath).mode & 0o111).not.toBe(0);

    execFileSync("mkdir", ["-p", join(repo, "src")]);
    writeFileSync(join(repo, "src/prepare.py"), "x = 1\n", "utf8");
    git(repo, ["add", "src/prepare.py"]);

    let blocked = false;
    try {
      execFileSync("git", ["commit", "-m", "touch readonly"], { cwd: repo, stdio: "pipe" });
    } catch (err) {
      blocked = true;
      const message = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
      expect(message).toContain("blocked: src/prepare.py");
    }
    expect(blocked).toBe(true);
  });

  it("blocks commits that touch paths outside editable globs", () => {
    const repo = mkRepo();
    writeConfig(repo, { readonly: [], editable: ["src/**"] });
    installPreCommitHook(repo);

    writeFileSync(join(repo, "outside.txt"), "nope\n", "utf8");
    git(repo, ["add", "outside.txt"]);

    let blocked = false;
    try {
      execFileSync("git", ["commit", "-m", "touch outside"], { cwd: repo, stdio: "pipe" });
    } catch (err) {
      blocked = true;
      const message = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
      expect(message).toContain("blocked: outside.txt");
    }
    expect(blocked).toBe(true);
  });

  it("allows commits within editable globs", () => {
    const repo = mkRepo();
    writeConfig(repo, { readonly: [], editable: ["src/**"] });
    installPreCommitHook(repo);

    execFileSync("mkdir", ["-p", join(repo, "src")]);
    writeFileSync(join(repo, "src/ok.py"), "x = 1\n", "utf8");
    git(repo, ["add", "src/ok.py"]);
    git(repo, ["commit", "-m", "allowed"]);
    const log = git(repo, ["log", "--oneline"]);
    expect(log).toContain("allowed");
  });

  it("chains an existing user hook", () => {
    const repo = mkRepo();
    const hookPath = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const installed = installPreCommitHook(repo);
    expect(installed.chained).toBe(true);
    expect(readFileSync(join(repo, ".git", "hooks", "pre-commit.user"), "utf8")).toContain("exit 0");
    expect(readFileSync(hookPath, "utf8")).toContain("pre-commit.user");
  });
});
