# autotester

`autotester` runs program-driven coding-agent loops for conservative repository
improvement.

The product is the program: `program.md` tells the agent what kind of small,
conservative improvement to attempt. The CLI is intentionally thin: `init`
copies a starter template from `programs/` into the target repository as
`program.md`; you edit that file for the repo; `run` drives a Pi coding-agent
session and the harness keeps or discards each committed attempt.

## Requirements

- Node.js 22.19+
- `pnpm`
- Pi authentication/model configuration. Run `pi` and use `/login`, or configure
  provider API keys supported by Pi.

## Usage

From a clone of this repository:

```bash
pnpm install
pnpm build
npm link
```

Initialize a repository with the default starter (`programs/simplifier.md`):

```bash
autotester init ~/src/my-repo
$EDITOR ~/src/my-repo/program.md   # set the real gate, metric paths, repo rules
```

Or choose a different starter:

```bash
autotester init ~/src/my-repo --program programs/type-tightener.md
```

Run a bounded local-only loop after reviewing `program.md`:

```bash
autotester run ~/src/my-repo --tag simplify-1 --max-attempts 10
```

By default, `run` refuses to start if the target repository has uncommitted
tracked changes. Use `--allow-dirty` only when the program should explicitly
preserve existing work.

## Commands

```text
autotester init    <repo> [--program <path>] [--force]
                          [--editable <glob>]... [--readonly <glob>]...
autotester run     <repo> [--program <path>]
                          [--max-attempts <n>] [--time-budget <seconds>]
                          [--attempt-timeout <seconds>] [--allow-dirty]
                          [--tag <name>]
                          [--provider <id>] [--model <pattern>] [--thinking <level>]
autotester history <repo>
```

The loop terminates on whichever comes first: `--max-attempts`,
`--time-budget`, or the agent declining to commit (its stop signal).
`--attempt-timeout` is the wall-clock cap the harness applies to each
individual `gate` or `metric` shell invocation.

`--tag <name>` creates a fresh `autotester/<name>` branch from current
HEAD and refuses to reuse an existing tag.

The model triple is resolved per field with this priority: CLI flag >
program front matter > built-in default (`github-copilot/claude-opus-4.7`,
no thinking level).

## Starter programs

`programs/` contains starter templates, not magic roles. Pick one at `init`
time, then edit the generated `program.md` for your repository.

| Template | Purpose |
| --- | --- |
| `programs/simplifier.md` | Default. Reduce source size/complexity without behavior changes. |
| `programs/type-tightener.md` | Add/tighten static types without runtime changes. |
| `programs/coverage-raiser.md` | Add tests that reduce uncovered behavior. |
| `programs/doc-writer.md` | Add concise, accurate public documentation/docstrings. |
| `programs/dep-pruner.md` | Remove unused imports/dependencies conservatively. |
| `programs/bug-finder.md` | Probe behavior like a QA tester; add a regression test and fix for each verified latent bug. |

## Program contract

A `program.md` declares two shell snippets in YAML front matter: a `gate`
that must exit 0, and a `metric` that prints `metric: <float>` to stdout
(lower is better). The harness — not the agent — runs both between
attempts and decides keep/discard/crash. Example:

```yaml
---
provider: github-copilot
model: claude-opus-4.7
gate: |
  set -e
  uv run pytest -q
  uv run ruff check .
metric: |
  set -e
  python3 - <<'PY'
  import pathlib
  n = sum(1 for p in pathlib.Path("src").rglob("*.py")
          for line in p.read_text(errors="ignore").splitlines()
          if line.strip() and not line.strip().startswith("#"))
  print(f"metric: {n}")
  PY
---

# program body: what kinds of changes to propose, what's out of bounds.
```

Per-attempt protocol enforced by the harness in default `mode: optimize`:

1. Agent edits files.
2. Agent writes `.autotester/attempt.json` with `{"description": "..."}`.
3. Agent commits.
4. Harness runs `gate` then `metric`, appends one row to `results.tsv`,
   and either keeps the commit (metric strictly improved) or `git
   reset --hard`s it.
5. If HEAD doesn't move after a turn, the harness treats it as the
   agent's stop signal and ends the run.

## Bugfix mode

`programs/bug-finder.md` uses `mode: bugfix`. In this mode the harness supplies
the metric:

```text
metric = - verified_regression_fixes
```

Lower is better: `-3` means the run has found, tested, and fixed three latent
defects.

Bugfix attempts require a richer `.autotester/attempt.json`:

```json
{
  "description": "Fix empty input crash in parser",
  "repro_command": "python - <<'PY'\n...\nPY",
  "test_command": "pytest tests/test_parser.py::test_empty_input -q",
  "test_files": ["tests/test_parser.py"],
  "fix_files": ["src/parser.py"],
  "parent_failure_pattern": "AssertionError|ValueError"
}
```

The harness keeps the commit only if exactly one commit was made, protected
harness files were not touched, declared files match the diff, the repro fails
in a temp worktree at the parent commit, the same repro passes in a temp
worktree at the child commit, the targeted regression test passes, and the full
`gate` passes. Validation details are written to `.autotester/attempts/*.json`.

## Files in target repos

- `program.md` — repo-specific agent policy and gate/metric contract.
- `results.tsv` — one row per attempt. Header is
  `attempt\telapsed_s\tmetric\tstatus\tcommit\tdescription`. `commit` is
  always the attempted SHA (reflog-recoverable even when status is
  `discard` or `crash`).
- `.autotester.json` — scope declaration (only present when `init` was
  given `--editable`/`--readonly`).
- `.autotester/runs/*.json` — one machine-readable summary per run, used
  by `autotester history`.
- `.autotester/attempts/*.json` — per-attempt validation diagnostics for
  bugfix mode.
- `.autotester/attempt.json` — transient; the agent writes it before each
  commit, the harness consumes it.
- `.git/hooks/pre-commit` — installed by `init` when scope is declared.
  Rejects staged paths that violate the scope.

## License

MIT
