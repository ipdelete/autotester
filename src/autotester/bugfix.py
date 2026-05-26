"""Bugfix-mode validation for autotester."""

from __future__ import annotations

import json
import re
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ttasks import SQLiteStore, Task, TaskExecutor, TaskGraph

from . import git
from .graphs import q, save_and_run


@dataclass(frozen=True)
class AttemptManifest:
    description: str
    repro_command: str
    test_command: str
    test_files: tuple[str, ...]
    fix_files: tuple[str, ...]
    parent_failure_pattern: str | None = None


@dataclass(frozen=True)
class BugfixValidation:
    ok: bool
    description: str
    graph_id: str | None = None


REQUIRED_MANIFEST_FIELDS = {
    "description",
    "repro_command",
    "test_command",
    "test_files",
    "fix_files",
}


def load_attempt_manifest(repo: Path) -> AttemptManifest:
    path = repo / ".autotester" / "attempt.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError("missing .autotester/attempt.json") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"malformed .autotester/attempt.json: {exc}") from exc
    if not isinstance(raw, dict):
        raise ValueError("attempt manifest must be a JSON object")
    missing = sorted(REQUIRED_MANIFEST_FIELDS - raw.keys())
    if missing:
        raise ValueError(f"attempt manifest missing required fields: {', '.join(missing)}")

    description = _required_str(raw, "description")
    repro_command = _required_str(raw, "repro_command")
    test_command = _required_str(raw, "test_command")
    test_files = _required_str_list(raw, "test_files")
    fix_files = _required_str_list(raw, "fix_files")
    parent_failure_pattern = raw.get("parent_failure_pattern")
    if parent_failure_pattern is not None and not isinstance(parent_failure_pattern, str):
        raise ValueError("parent_failure_pattern must be a string when present")
    return AttemptManifest(
        description=description,
        repro_command=repro_command,
        test_command=test_command,
        test_files=tuple(test_files),
        fix_files=tuple(fix_files),
        parent_failure_pattern=parent_failure_pattern,
    )


def validate_manifest_and_diff(
    repo: Path,
    before: str,
    after: str,
    manifest: AttemptManifest,
) -> None:
    count = int(git.run_git(repo, "rev-list", "--count", f"{before}..{after}").stdout.strip())
    if count != 1:
        raise ValueError(f"bugfix attempts must create exactly one commit; got {count}")
    changed = set(_changed_files(repo, before, after))
    allowed = set(manifest.test_files) | set(manifest.fix_files)
    extra = sorted(changed - allowed)
    if extra:
        raise ValueError(f"commit changed files not declared in manifest: {', '.join(extra)}")
    if not set(manifest.test_files) & changed:
        raise ValueError("commit did not change any declared test_files")
    if not set(manifest.fix_files) & changed:
        raise ValueError("commit did not change any declared fix_files")
    protected = [
        path for path in changed
        if path.startswith(".autotester/") or path == "program.md"
    ]
    if protected:
        raise ValueError(f"commit changed protected harness files: {', '.join(sorted(protected))}")


def validate_bugfix_attempt(
    *,
    repo: Path,
    store: SQLiteStore,
    executor: TaskExecutor,
    before: str,
    after: str,
    attempt: int,
    gate: str,
    manifest: AttemptManifest,
    timeout: float,
) -> BugfixValidation:
    validate_manifest_and_diff(repo, before, after, manifest)
    root = Path(tempfile.mkdtemp(prefix="autotester-bugfix-"))
    parent = root / "parent"
    child = root / "child"
    try:
        graph = bugfix_validation_graph(
            repo=repo,
            parent=parent,
            child=child,
            before=before,
            after=after,
            attempt=attempt,
            gate=gate,
            manifest=manifest,
            timeout=timeout,
        )
        save_and_run(graph, executor, store)
        return BugfixValidation(ok=graph.ok, description=manifest.description, graph_id=graph.id)
    finally:
        _remove_worktree(repo, parent)
        _remove_worktree(repo, child)
        shutil.rmtree(root, ignore_errors=True)


def bugfix_validation_graph(
    *,
    repo: Path,
    parent: Path,
    child: Path,
    before: str,
    after: str,
    attempt: int,
    gate: str,
    manifest: AttemptManifest,
    timeout: float,
) -> TaskGraph:
    create_parent = Task.bash(
        f"set -euo pipefail\ngit -C {q(repo)} worktree add --detach {q(parent)} {q(before)}",
        title=f"bugfix {attempt} create parent worktree",
        timeout=60,
    )
    create_child = Task.bash(
        f"set -euo pipefail\ngit -C {q(repo)} worktree add --detach {q(child)} {q(after)}",
        title=f"bugfix {attempt} create child worktree",
        timeout=60,
    )
    parent_repro = Task.bash(
        _parent_repro_payload(parent, root=parent.parent, manifest=manifest),
        title=f"bugfix {attempt} parent repro fails",
        timeout=timeout,
    )
    child_repro = Task.bash(
        _run_payload(child, manifest.repro_command),
        title=f"bugfix {attempt} child repro passes",
        timeout=timeout,
    )
    targeted = Task.bash(
        _run_payload(child, manifest.test_command),
        title=f"bugfix {attempt} targeted regression passes",
        timeout=timeout,
    )
    full_gate = Task.bash(
        _run_payload(child, gate),
        title=f"bugfix {attempt} full gate passes",
        timeout=timeout,
    )

    graph = TaskGraph(title=f"autotester bugfix validation {attempt}")
    graph.add(create_parent)
    graph.add(create_child)
    graph.add(parent_repro, after=[create_parent])
    graph.add(child_repro, after=[create_child])
    graph.add(targeted, after=[child_repro])
    graph.add(full_gate, after=[targeted])
    return graph


def _parent_repro_payload(parent: Path, *, root: Path, manifest: AttemptManifest) -> str:
    out = root / "parent-repro.out"
    err = root / "parent-repro.err"
    payload = f"""set -euo pipefail
cd {q(parent)}
set +e
(
{manifest.repro_command}
) > {q(out)} 2> {q(err)}
code=$?
set -e
cat {q(out)}
cat {q(err)} >&2
if [ "$code" -eq 0 ]; then
  echo 'parent repro unexpectedly passed' >&2
  exit 1
fi
"""
    if manifest.parent_failure_pattern:
        pattern = q(manifest.parent_failure_pattern)
        payload += f"cat {q(out)} {q(err)} | grep -E {pattern} >/dev/null\n"
    return payload


def _run_payload(cwd: Path, command: str) -> str:
    return f"""set -euo pipefail
cd {q(cwd)}
{command}
"""


def _changed_files(repo: Path, before: str, after: str) -> list[str]:
    output = git.run_git(repo, "diff", "--name-only", before, after).stdout
    return [line.strip() for line in output.splitlines() if line.strip()]


def _remove_worktree(repo: Path, path: Path) -> None:
    if path.exists():
        git.run_git(repo, "worktree", "remove", "--force", str(path), check=False)


def _required_str(raw: dict[str, Any], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"attempt manifest field {key!r} must be a non-empty string")
    return value


def _required_str_list(raw: dict[str, Any], key: str) -> list[str]:
    value = raw.get(key)
    if not isinstance(value, list) or not value:
        raise ValueError(f"attempt manifest field {key!r} must be a non-empty string list")
    if not all(isinstance(item, str) and item.strip() for item in value):
        raise ValueError(f"attempt manifest field {key!r} must be a non-empty string list")
    return value


def manifest_error_matches(error: str) -> bool:
    return bool(re.search("manifest|attempt", error, re.IGNORECASE))
