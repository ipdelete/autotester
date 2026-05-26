# Storage

Autotester uses ttasks' `SQLiteStore` as its source of truth.

By default, the database path comes from git metadata:

```bash
git rev-parse --git-path autotester/ttasks.db
```

That usually resolves under `.git/`, not in the worktree. This means autotester
state does not require:

```text
.autotester/
results.tsv
```

## What is stored

The SQLite ledger stores:

- task definitions,
- task lifecycle status,
- task results,
- stdout/stderr for shell tasks,
- assistant output for agent tasks,
- graph membership and dependency edges,
- adjudication records as JSON task output.

## History

`autotester history` scans graphs whose titles start with:

```text
autotester adjudication
```

and renders the JSON records stored by those tasks.

## Override database path

Use `--db` for experiments or custom storage:

```bash
autotester run --db /tmp/autotester.db
autotester history --db /tmp/autotester.db
```

## Worktree files

The bugfix agent writes `.autotester/attempt.json` in the worktree as a manifest
for the current candidate. The harness reads it but does not use `.autotester/`
as the durable run ledger.
