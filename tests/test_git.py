from pathlib import Path

from autotester.git import git_path


def test_git_path_resolves_relative_output_under_repo(monkeypatch, tmp_path: Path):
    class Completed:
        stdout = ".git/autotester/ttasks.db\n"

    monkeypatch.setattr("autotester.git.run_git", lambda *args, **kwargs: Completed())

    assert git_path(tmp_path, "autotester/ttasks.db") == tmp_path / ".git/autotester/ttasks.db"


def test_git_path_keeps_absolute_output(monkeypatch, tmp_path: Path):
    absolute = tmp_path / "gitdir/autotester/ttasks.db"

    class Completed:
        stdout = f"{absolute}\n"

    monkeypatch.setattr("autotester.git.run_git", lambda *args, **kwargs: Completed())

    assert git_path(tmp_path, "autotester/ttasks.db") == absolute
