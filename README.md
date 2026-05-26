# autotester

`autotester` is a Python/uv CLI backed by
[`ttasks`](https://github.com/ipdelete/ttasks) and the GitHub Copilot SDK.

The current rewrite supports **optimize mode** only. It keeps the repo-local
`program.md` contract, but the run ledger is now ttasks' `SQLiteStore` rather
than `results.tsv` files.

## Run with uvx

Run directly from GitHub:

```bash
uvx --from git+https://github.com/ipdelete/autotester.git autotester programs
```

Run from a branch or tag:

```bash
uvx --from git+https://github.com/ipdelete/autotester.git@rewrite/python-uv-ttasks autotester --help
```

If `uvx` cannot find `uv`, ensure both commands resolve correctly:

```bash
which uv uvx
uvx --version
```

In this environment, `uvx` expected a sibling `uv` at `~/.local/bin/uv`; a
symlink to the system `uv` fixed it:

```bash
ln -sfn /usr/bin/uv ~/.local/bin/uv
```

## Install as a uv tool

Install persistently from GitHub:

```bash
uv tool install git+https://github.com/ipdelete/autotester.git
```

Install from a branch or tag:

```bash
uv tool install --force git+https://github.com/ipdelete/autotester.git@rewrite/python-uv-ttasks
```

Then run:

```bash
autotester programs
autotester init --program simplifier
autotester run --tag simplify-001 --max-attempts 5
autotester history
```

## Development install

```bash
uv sync --dev
```

When working against a local ttasks checkout during development:

```bash
uv run --with 'ttasks @ file:///home/cip/src/ttasks' autotester programs
```

## Commands

### List bundled programs

```bash
autotester programs
```

### Initialize a repo-local program

```bash
autotester init --program simplifier
```

This copies a bundled program template to `program.md` in the target repo. Edit
the front matter before running:

```yaml
---
provider: github-copilot
model: gpt-5.5
thinking: medium
gate: |
  uv run pytest -q
metric: |
  python metric.py
---
```

Lower metric values are better.

### Run optimize mode

```bash
autotester run --tag simplify-001 --max-attempts 5
```

For each run, autotester:

1. validates the baseline gate and metric,
2. opens one long-lived `CopilotAgentSession`,
3. builds a persisted ttasks graph for each attempt,
4. lets the agent make at most one committed improvement,
5. runs the gate and metric in the graph,
6. adjudicates keep/discard in Python,
7. persists the adjudication as another ttasks graph.

### View history

```bash
autotester history
```

History is rendered from adjudication tasks in the ttasks SQLite database.
There is no primary `results.tsv` ledger in the Python rewrite.

## Storage

By default, the SQLite task/graph ledger is stored under git metadata:

```bash
git rev-parse --git-path autotester/ttasks.db
```

This keeps autotester state outside the worktree, so no `.autotester/` directory
or `results.tsv` file is required.

## Development checks

```bash
uv run ruff check src/autotester tests
uv run pytest -q
uv run ty check src/autotester tests
```

## Status

Implemented:

- Python/uv project skeleton
- `autotester init`
- `autotester programs`
- optimize-mode `autotester run`
- `autotester history`
- ttasks `SQLiteStore` adjudication history
- `uvx` / `uv tool install` support from GitHub

Not yet rewritten:

- bugfix mode
- scope hooks
- repair turns
- no-finding budget
- richer history/detail inspection
