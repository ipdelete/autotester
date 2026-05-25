import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProtectedPath, validateBugfixAttempt, validateChangedFiles } from "../src/bugfix.js";
import { headSha } from "../src/git.js";

function git(repo: string, args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

function repoWithBug(): { repo: string; parent: string; child: string } {
  const repo = mkdtempSync(join(tmpdir(), "autotester-bugfix-"));
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "tests"));
  writeFileSync(join(repo, "src", "calc.py"), "def reciprocal(x):\n    return 1 / x\n", "utf8");
  writeFileSync(join(repo, "tests", "test_calc.py"), "from src.calc import reciprocal\nassert reciprocal(2) == 0.5\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  const parent = headSha(repo);

  writeFileSync(join(repo, "src", "calc.py"), "def reciprocal(x):\n    if x == 0:\n        return 0\n    return 1 / x\n", "utf8");
  writeFileSync(join(repo, "tests", "test_calc.py"), "from src.calc import reciprocal\nassert reciprocal(2) == 0.5\nassert reciprocal(0) == 0\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "fix zero reciprocal"]);
  const child = headSha(repo);
  return { repo, parent, child };
}

describe("bugfix validation helpers", () => {
  it("detects protected paths", () => {
    expect(isProtectedPath("program.md")).toBe(true);
    expect(isProtectedPath(".autotester/runs/x.json")).toBe(true);
    expect(isProtectedPath("src/app.py")).toBe(false);
  });

  it("validates changed files against manifest", () => {
    expect(validateChangedFiles(["src/a.py", "tests/test_a.py"], ["tests/test_a.py"], ["src/a.py"])).toBeUndefined();
    expect(validateChangedFiles(["src/a.py", "README.md"], [], ["src/a.py"])).toMatch(/not declared/);
    expect(validateChangedFiles(["program.md"], [], ["program.md"])).toMatch(/protected/);
    expect(validateChangedFiles(["src/a.py"], ["tests/test_a.py"], ["src/a.py"])).toMatch(/not changed/);
  });

  it("keeps a proven parent-fail child-pass bugfix", () => {
    const { repo, parent, child } = repoWithBug();
    const repro = "python3 - <<'PY'\nfrom src.calc import reciprocal\nassert reciprocal(0) == 0\nPY";
    const res = validateBugfixAttempt({
      repo,
      attempt: 1,
      parent,
      child,
      manifest: {
        description: "fix zero reciprocal",
        repro_command: repro,
        test_command: "PYTHONPATH=. python3 tests/test_calc.py",
        test_files: ["tests/test_calc.py"],
        fix_files: ["src/calc.py"],
        parent_failure_pattern: "ZeroDivisionError",
      },
      gate: "PYTHONPATH=. python3 tests/test_calc.py",
      timeoutSec: 30,
      verifiedRegressionFixes: 0,
    });
    expect(`${res.status}: ${res.reason}`).toBe("keep: verified defect retired");
    expect(res.metric).toBe(-1);
  });

  it("discards when parent repro already passes", () => {
    const { repo, parent, child } = repoWithBug();
    const res = validateBugfixAttempt({
      repo,
      attempt: 1,
      parent,
      child,
      manifest: {
        description: "normal behavior",
        repro_command: "python3 - <<'PY'\nfrom src.calc import reciprocal\nassert reciprocal(2) == 0.5\nPY",
        test_command: "PYTHONPATH=. python3 tests/test_calc.py",
        test_files: ["tests/test_calc.py"],
        fix_files: ["src/calc.py"],
      },
      gate: "PYTHONPATH=. python3 tests/test_calc.py",
      timeoutSec: 30,
      verifiedRegressionFixes: 0,
    });
    expect(res.status).toBe("discard");
    expect(res.reason).toMatch(/parent repro passed/);
  });
});
