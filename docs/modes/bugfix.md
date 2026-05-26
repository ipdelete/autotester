# Bugfix mode

Bugfix mode asks the agent to discover one real latent defect, add a regression
test, fix the bug, and commit exactly one test+fix commit.

Use the bundled template:

```bash
autotester init --program bug-finder
```

## Required front matter

```yaml
---
mode: bugfix
gate: |
  uv run pytest -q
---
```

The harness supplies the metric:

```text
metric = -verified_regression_fixes
```

Lower is better. A run with three verified fixes has metric `-3`.

## Attempt manifest

After committing, the agent must include one JSON manifest object in its final
assistant response. The harness reads this from the persisted ttasks agent task
output; no `.autotester/attempt.json` file is needed.

```json
{
  "description": "Fix empty input crash in parser",
  "repro_command": "python - <<'PY'\nfrom package import parse\nassert parse('') == []\nPY",
  "test_command": "pytest tests/test_parser.py::test_empty_input -q",
  "test_files": ["tests/test_parser.py"],
  "fix_files": ["src/package/parser.py"],
  "parent_failure_pattern": "AssertionError|ValueError"
}
```

Required fields:

- `description`
- `repro_command`
- `test_command`
- `test_files`
- `fix_files`

Optional:

- `parent_failure_pattern`

The committed diff must contain only the declared regression test and fix files.

## Validation

For each committed candidate, the harness validates:

1. exactly one commit was created,
2. changed files are declared in `test_files` or `fix_files`,
3. at least one declared test file changed,
4. at least one declared fix file changed,
5. parent repro fails on the pre-fix commit,
6. child repro passes on the new commit,
7. targeted regression test passes on the new commit,
8. full gate passes on the new commit.

Parent and child checks run in detached temporary worktrees. The proof graph is
persisted in the ttasks SQLite ledger.

## No-finding budget

If the agent produces no commit, the attempt is recorded as:

```text
discard / no finding produced
```

Bugfix mode stops after `--max-no-finding-attempts` consecutive no-finding
attempts. The default is `3`.

## Current limitations

Repair turns are not implemented yet. If the bug proof passes but the full gate
fails due to formatting or lint fallout, the attempt is discarded in the current
rewrite.
