# Plan: replace repo-specific programs with useful starter templates

## Goal

Keep the current `program.md` workflow exactly as-is:

- `programs/*.md` is a library of starter templates.
- `autotester init <repo> --program programs/<name>.md` copies the chosen file to `<repo>/program.md`.
- The user edits `<repo>/program.md` for their repo before running.
- `autotester run` reads that `program.md` and uses the harness-owned `gate`/`metric` contract.

Do **not** add roles, repo cards, template composition, `.autotester.repo.json`, or a new selection mechanism.

The work is to make `programs/` contain broadly useful starter programs instead of one repo-specific test program and one vague placeholder.

## Current problem

### `programs/ttasks.md`

Too repo-specific:

- Hard-codes `src/ttasks/`.
- Hard-codes importing `ttasks` and hashing `ttasks.__all__`.
- Assumes `uv`, `pytest`, `ruff`, and `ty`.
- Was useful for smoke-testing the harness, but is not a good general template.

Action: remove it from the public starter set or move it to an internal smoke-test fixture.

### `programs/autotester.md`

Too generic to be useful:

- Its default gate is `exit 1`.
- It is more of a contract example than a productive starter.
- It does not express a concrete role/user intent.

Action: replace with a real default starter, likely `simplifier.md`, or keep a renamed `blank.md` only as a reference template.

## Design principle for programs

Each starter program should be:

1. **A concrete role** — e.g. simplify code, tighten types, raise coverage.
2. **Editable after init** — include TODO markers where repo-specific commands/paths must be reviewed.
3. **Safe by default** — conservative prompt body, no pushes, no broad rewrites.
4. **Harness-native** — front matter declares `gate` and `metric`; body tells the agent how to propose attempts.
5. **Specific enough to run with small edits** — don't be so abstract that every user has to rewrite it from scratch.

## Proposed starter programs

### 1. `programs/simplifier.md` — default

Purpose: reduce code size/complexity while preserving behavior.

Front matter:

- Default model: `github-copilot/claude-opus-4.7`.
- `gate`: TODO block with common Python/Node examples commented in.
- `metric`: default portable source-line count over `src/` using POSIX tools or Python.

Body:

- Prefer small behavior-preserving refactors.
- Examples: deduplicate branches, inline one-shot helpers, remove dead parameters, replace bespoke loops with stdlib/comprehensions.
- Forbid public API changes, test rewrites, formatting churn, broad architectural changes.
- Stop when only risky/subjective changes remain.

Use as the default bundled program copied by `autotester init` when no `--program` is passed.

### 2. `programs/type-tightener.md`

Purpose: improve static typing without changing runtime behavior.

Metric options:

- Count type-checker errors/warnings.
- Or count unannotated public functions/classes via a small Python AST script.

Gate:

- Repo test command.
- Type checker command (`mypy`, `pyright`, `ty`, `tsc`, etc.) as a TODO.

Body:

- Add annotations, improve generics, remove unnecessary `Any`, narrow unions.
- No behavior changes.
- Prefer local, obvious annotations over large type abstractions.
- Do not silence errors with ignores unless the program explicitly says to.

### 3. `programs/coverage-raiser.md`

Purpose: add or improve tests for uncovered behavior.

Metric options:

- Uncovered line count from coverage XML/JSON.
- Or negative coverage percentage if the harness expects lower-is-better.

Gate:

- Test suite with coverage enabled.

Body:

- Edit tests, not production code, unless a discovered bug requires a minimal fix.
- Prefer high-value branch/edge-case tests.
- No snapshot churn, no brittle time/order-dependent assertions.
- If a new test exposes a real bug, either fix it in the same attempt or discard/stop depending on confidence.

Potential caveat: this role may need editable scope like `tests/**` instead of `src/**`; call that out clearly.

### 4. `programs/doc-writer.md`

Purpose: improve public API documentation/docstrings without changing behavior.

Metric options:

- Count public symbols missing docstrings using a Python AST script.
- Or count markdown/docstring TODO markers.

Gate:

- Repo tests.
- Optional doc linter (`pydocstyle`, `ruff pydocstyle`, `typedoc`, etc.).

Body:

- Add concise docstrings to public functions/classes/modules.
- Document parameters, return values, exceptions only where helpful.
- Do not invent behavior. Read implementation/tests first.
- Avoid noisy comment spam.

### 5. `programs/dep-pruner.md`

Purpose: remove unused dependencies/imports/config entries safely.

Metric options:

- Count dependencies in manifest.
- Count unused import findings from linter.
- Count `pyproject.toml`/`package.json` dependency entries, if that's the target.

Gate:

- Full test/lint/type suite.

Body:

- Remove one dependency/import cluster at a time.
- Verify lockfile updates if dependency manifests are edited.
- Do not remove optional/plugin dependencies without evidence.
- Prefer unused imports first; manifest pruning is higher-risk.

## Handling removed programs

Decisions:

- No `blank.md`; empty contract examples are not useful starters.
- Delete `programs/ttasks.md`; it was repo-specific smoke-test scaffolding, not a public starter.
- Delete/replace `programs/autotester.md`; the new default is `programs/simplifier.md`.

## README updates

Update README to explain:

- `programs/` contains starter templates, not magic roles.
- The default is `programs/simplifier.md`.
- Typical workflow:

```bash
autotester init ~/src/my-repo --program programs/simplifier.md
$EDITOR ~/src/my-repo/program.md   # set gate, metric, paths, repo-specific rules
autotester run ~/src/my-repo --tag simplify-1 --max-attempts 10
```

- List available templates with one-line descriptions.
- Mention that `program.md` is meant to be edited before running.

No CLI changes required beyond changing `bundledProgramPath()` default from `autotester` to `simplifier`.

## Implementation phases

### Phase 1 — Template inventory and naming

- Final template set: `simplifier`, `type-tightener`, `coverage-raiser`, `doc-writer`, `dep-pruner`.
- Remove `autotester.md` and `ttasks.md` from `programs/`.
- Update default bundled program path to `simplifier`.

### Phase 2 — Write templates

- Create each `programs/<name>.md`.
- Use current harness contract:
  - YAML front matter with `provider`, `model`, `gate`, `metric`, optional `baseline_description`.
  - Body describes what kinds of commits to make and avoid.
- Include TODO comments in shell snippets and body where repo-specific edits are expected.

### Phase 3 — Docs

- Rewrite README program/template section.
- Add a short table of templates.
- Add examples for Python/uv and Node/npm gate/metric customization.

### Phase 4 — Tests and smoke checks

- Build and run unit tests.
- `autotester init` smoke test with default template to confirm it copies `simplifier.md`.
- `autotester init --program programs/type-tightener.md` smoke test.
- No need to run a full agent loop for every template; the templates are starter docs, not code paths.

### Phase 5 — Commit and push

- Commit message should emphasize: no new mechanism, only better starter programs.
- Push to `origin/master`.

## Non-goals

- No `--role` flag.
- No `.autotester.repo.json`.
- No template interpolation/composition.
- No automatic role selection.
- No LLM-generated repo cards.
- No new dependencies.
- No change to the harness-owned gate/metric loop.
