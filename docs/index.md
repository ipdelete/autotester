# autotester

`autotester` runs conservative coding-agent loops against a git repository. It
uses:

- `ttasks` for persisted task and graph execution,
- GitHub Copilot SDK for the coding-agent session,
- repo-local `program.md` files for run policy,
- a SQLite task ledger under git metadata for history.

The current Python rewrite supports two modes:

- **Optimize mode**: lower a metric while keeping a gate green.
- **Bugfix mode**: discover, test, fix, and prove one real bug at a time.

## Start here

- [Quickstart](quickstart.md): run from GitHub with `uvx`, initialize a program,
  and start a run.
- [Commands](commands.md): CLI reference for `init`, `programs`, `run`, and
  `history`.
- [Programs](programs.md): how `program.md` front matter and instructions work.
- [Optimize mode](modes/optimize.md): metric-driven improvement loop.
- [Bugfix mode](modes/bugfix.md): deterministic regression-fix validation.
- [Storage](storage.md): where the ttasks SQLite ledger lives and what it
  contains.

## Design summary

Autotester deliberately separates proposing from adjudicating:

```text
Copilot agent proposes one commit
    ↓
ttasks runs gate/metric/proof graphs
    ↓
Python harness decides keep/discard
    ↓
adjudication is persisted to SQLiteStore
```

The agent does not decide whether an attempt is accepted. The harness does.
