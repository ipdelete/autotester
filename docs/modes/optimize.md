# Optimize mode

Optimize mode asks the agent to make one focused commit at a time that lowers a
numeric metric while keeping a gate green.

`mode: optimize` is the default when `mode` is omitted.

## Required front matter

```yaml
---
mode: optimize
gate: |
  uv run pytest -q
metric: |
  python metric.py
---
```

The metric command must print a number. It may print either a bare number:

```text
42
```

or a `metric:` line:

```text
metric: 42
```

Lower is better.

## Attempt graph

Each attempt is persisted as a ttasks graph:

```text
before head
  -> agent attempt
    -> after head
      -> gate
        -> metric
          -> clean tracked worktree
```

The graph records task status, stdout/stderr, duration, and dependency edges in
SQLite.

## Adjudication

After the graph finishes, the Python harness decides:

- no new commit: discard,
- graph failed: reset and discard,
- metric did not improve: reset and discard,
- metric improved: keep.

The decision is also persisted as an adjudication graph. `autotester history`
renders those persisted adjudication tasks.

## Branches

Use `--tag` to make one run one branch:

```bash
autotester run --tag simplify-001
```

This creates:

```text
autotester/simplify-001
```
