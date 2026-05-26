"""Small git subprocess helpers for autotester."""

from __future__ import annotations

import subprocess
from pathlib import Path


class GitError(RuntimeError):
    """Raised when a git command fails."""


def run_git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    """Run git in ``repo`` and return the completed process."""
    completed = subprocess.run(
        ["git", "-C", str(repo), *args],
        text=True,
        capture_output=True,
        check=False,
    )
    if check and completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise GitError(f"git {' '.join(args)} failed: {detail}")
    return completed


def is_git_repo(repo: Path) -> bool:
    return run_git(repo, "rev-parse", "--is-inside-work-tree", check=False).returncode == 0


def head(repo: Path) -> str:
    return run_git(repo, "rev-parse", "HEAD").stdout.strip()


def current_branch(repo: Path) -> str:
    return run_git(repo, "branch", "--show-current").stdout.strip()


def has_tracked_changes(repo: Path) -> bool:
    return bool(run_git(repo, "status", "--porcelain", "--untracked-files=no").stdout.strip())


def local_branch_exists(repo: Path, branch: str) -> bool:
    completed = run_git(
        repo,
        "show-ref",
        "--verify",
        "--quiet",
        f"refs/heads/{branch}",
        check=False,
    )
    return completed.returncode == 0


def remote_branch_exists(repo: Path, branch: str) -> bool:
    completed = run_git(repo, "ls-remote", "--heads", "origin", branch, check=False)
    return completed.returncode == 0 and bool(completed.stdout.strip())


def create_branch(repo: Path, branch: str) -> None:
    run_git(repo, "checkout", "-b", branch)


def reset_hard(repo: Path, commit: str) -> None:
    run_git(repo, "reset", "--hard", commit)


def git_path(repo: Path, relative: str) -> Path:
    return Path(run_git(repo, "rev-parse", "--git-path", relative).stdout.strip())
