# autotester

`autotester` runs program-driven coding-agent loops for conservative repository
improvement.

The product is the program: `program.md` tells the agent how to inspect, refine,
validate, commit, discard, and log small changes. The CLI is intentionally thin;
it loads the program, starts a Pi coding-agent session in the target repository,
and prints a summary when the run finishes.

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

Initialize a repository with the default program:

```bash
autotester init ~/src/my-repo
```

Run a bounded local-only loop:

```bash
autotester run ~/src/my-repo
```

Use a repo-specific program:

```bash
autotester run ~/src/my-repo --program ~/src/my-repo/program.md --max-attempts 10
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
  echo "metric: $(cloc --quiet --csv src 2>/dev/null \
    | awk -F, 'NR>2 && $1!="SUM" {sum+=$5} END {print sum+0}')"
---

# program body: what kinds of changes to propose, what's out of bounds.
```

Per-attempt protocol enforced by the harness:

1. Agent edits files.
2. Agent writes `.autotester/attempt.json` with `{"description": "..."}`.
3. Agent commits.
4. Harness runs `gate` then `metric`, appends one row to `results.tsv`,
   and either keeps the commit (metric strictly improved) or `git
   reset --hard`s it.
5. If HEAD doesn't move after a turn, the harness treats it as the
   agent's stop signal and ends the run.

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
- `.autotester/attempt.json` — transient; the agent writes it before each
  commit, the harness consumes it.
- `.git/hooks/pre-commit` — installed by `init` when scope is declared.
  Rejects staged paths that violate the scope.

## License

MIT
