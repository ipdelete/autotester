import json
import subprocess
from pathlib import Path

import pytest
from ttasks import SQLiteStore, TaskExecutor

from autotester.bugfix import (
    load_attempt_manifest,
    validate_bugfix_attempt,
    validate_manifest_and_diff,
)


def test_load_attempt_manifest(tmp_path: Path):
    attempt_dir = tmp_path / ".autotester"
    attempt_dir.mkdir()
    (attempt_dir / "attempt.json").write_text(json.dumps({
        "description": "Fix parser empty input",
        "repro_command": "python repro.py",
        "test_command": "pytest tests/test_parser.py -q",
        "test_files": ["tests/test_parser.py"],
        "fix_files": ["src/parser.py"],
        "parent_failure_pattern": "AssertionError",
    }))

    manifest = load_attempt_manifest(tmp_path)

    assert manifest.description == "Fix parser empty input"
    assert manifest.test_files == ("tests/test_parser.py",)
    assert manifest.parent_failure_pattern == "AssertionError"


def test_load_attempt_manifest_rejects_missing_fields(tmp_path: Path):
    attempt_dir = tmp_path / ".autotester"
    attempt_dir.mkdir()
    (attempt_dir / "attempt.json").write_text("{}")

    with pytest.raises(ValueError, match="missing required fields"):
        load_attempt_manifest(tmp_path)


def test_validate_manifest_and_diff_requires_declared_files(tmp_path: Path):
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.email", "test@example.invalid")
    _git(tmp_path, "config", "user.name", "test")
    (tmp_path / "src").mkdir()
    (tmp_path / "tests").mkdir()
    (tmp_path / "src/parser.py").write_text("value = 1\n")
    (tmp_path / "tests/test_parser.py").write_text("def test_parser(): pass\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-m", "initial")
    before = _git(tmp_path, "rev-parse", "HEAD").stdout.strip()

    (tmp_path / "src/parser.py").write_text("value = 2\n")
    (tmp_path / "tests/test_parser.py").write_text("def test_parser(): assert True\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-m", "fix")
    after = _git(tmp_path, "rev-parse", "HEAD").stdout.strip()

    manifest = load_attempt_manifest_from_dict(tmp_path, {
        "description": "Fix parser",
        "repro_command": "python repro.py",
        "test_command": "pytest tests/test_parser.py -q",
        "test_files": ["tests/test_parser.py"],
        "fix_files": ["src/parser.py"],
    })

    validate_manifest_and_diff(tmp_path, before, after, manifest)


def load_attempt_manifest_from_dict(repo: Path, data: dict):
    attempt_dir = repo / ".autotester"
    attempt_dir.mkdir(exist_ok=True)
    (attempt_dir / "attempt.json").write_text(json.dumps(data))
    return load_attempt_manifest(repo)


def test_validate_bugfix_attempt_proves_parent_fail_child_pass(tmp_path: Path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init")
    _git(repo, "config", "user.email", "test@example.invalid")
    _git(repo, "config", "user.name", "test")
    (repo / "calc.py").write_text("def add(a, b):\n    return a - b\n")
    _git(repo, "add", ".")
    _git(repo, "commit", "-m", "initial broken")
    before = _git(repo, "rev-parse", "HEAD").stdout.strip()

    (repo / "calc.py").write_text("def add(a, b):\n    return a + b\n")
    (repo / "test_calc.py").write_text(
        "from calc import add\n\n"
        "def test_add():\n"
        "    assert add(2, 3) == 5\n"
    )
    _git(repo, "add", ".")
    _git(repo, "commit", "-m", "fix add")
    after = _git(repo, "rev-parse", "HEAD").stdout.strip()
    manifest = load_attempt_manifest_from_dict(repo, {
        "description": "Fix add subtraction bug",
        "repro_command": "python - <<'PY'\nfrom calc import add\nassert add(2, 3) == 5\nPY",
        "test_command": "python -m pytest test_calc.py -q",
        "test_files": ["test_calc.py"],
        "fix_files": ["calc.py"],
        "parent_failure_pattern": "AssertionError",
    })
    store = SQLiteStore(tmp_path / "ttasks.db")
    executor = TaskExecutor(store=store)

    result = validate_bugfix_attempt(
        repo=repo,
        store=store,
        executor=executor,
        before=before,
        after=after,
        attempt=1,
        gate="python -m pytest -q",
        manifest=manifest,
        timeout=30,
    )

    assert result.ok is True
    assert result.graph_id in store.graphs


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        text=True,
        capture_output=True,
        check=True,
    )
