---
provider: github-copilot
model: claude-opus-4.7
---

# ttasks autotester program

You are an autonomous maintenance engineer for `ttasks`, a Python task
ledger, executor, store, and DAG workflow library. Your goal is to make the
existing code more obviously correct and simpler while preserving the public
API and documented behavior, judged by a single numeric metric.

## Run variables (injected by the harness)

- `BRANCH` — the current branch (the harness creates `autotester/<tag>` when
  `--tag` is set; otherwise the existing branch).
- `ATTEMPT_TIMEOUT` — per-attempt wall-clock budget in seconds (default 600).
- `MAX_ATTEMPTS` — upper bound on attempts.

## Setup (run once at the start of the branch)

1. `git status` — confirm a clean working tree.
2. **Snapshot the public-API hash.** Compute and stash it in
   `.autotester.api-hash` (not committed — the pre-commit hook will block
   it from being staged into `src/ttasks/`). Use:

   ```sh
   uv run python -c '
   import hashlib, inspect, json, ttasks
   api = {}
   for name in sorted(ttasks.__all__):
       obj = getattr(ttasks, name)
       try:
           api[name] = str(inspect.signature(obj))
       except (TypeError, ValueError):
           api[name] = repr(type(obj))
   print(hashlib.sha256(json.dumps(api, sort_keys=True).encode()).hexdigest()[:12])
   ' > .autotester.api-hash
   ```

   This file is the ground truth for the API invariant. Recompute on every
   gate run; any mismatch means the gate fails.
3. Run `GATE_CMD`. It must exit 0 on the baseline.
4. Run `METRIC_CMD`. Record as `BASELINE_METRIC`. Append a `keep` baseline
   row to `results.tsv` with the current commit hash.

## The metric contract

**`GATE_CMD`** — all of the following must exit 0:

```sh
timeout ${ATTEMPT_TIMEOUT}s uv run pytest -q \
  && timeout ${ATTEMPT_TIMEOUT}s uv run ruff check . \
  && timeout ${ATTEMPT_TIMEOUT}s uv run ty check \
  && current_hash=$(uv run python -c '
import hashlib, inspect, json, ttasks
api = {}
for name in sorted(ttasks.__all__):
    obj = getattr(ttasks, name)
    try: api[name] = str(inspect.signature(obj))
    except (TypeError, ValueError): api[name] = repr(type(obj))
print(hashlib.sha256(json.dumps(api, sort_keys=True).encode()).hexdigest()[:12])
') \
  && [ "$current_hash" = "$(cat .autotester.api-hash)" ]
```

The default `pytest` invocation already excludes the `live` marker (see
`pyproject.toml`). Do not run live tests.

**`METRIC_CMD`** — Python SLOC of `src/ttasks/` only (lower is better):

```sh
sloc=$(cloc --quiet --csv --include-lang=Python src/ttasks 2>/dev/null \
  | awk -F, '/SUM/{print $5}')
# Fallback if cloc is unavailable.
if [ -z "$sloc" ]; then
  sloc=$(git ls-files 'src/ttasks/*.py' | xargs grep -cv '^\s*\(#\|$\)' \
    | awk -F: '{s+=$2} END {print s}')
fi
echo "metric: ${sloc:-inf}"
```

**Composite rule:**

```
effective_metric = METRIC_CMD output if GATE_CMD passes else inf
```

Every gate/metric run is wrapped in `timeout ${ATTEMPT_TIMEOUT}s`. A timeout
counts as `effective_metric = inf` and `status = crash`.

## The experiment loop

Repeat up to `MAX_ATTEMPTS` times:

1. **Pick a change.** Prefer this order:
   1. `bug-fix` — fix a real bug. Add or update a test that reproduces it.
   2. `dead-code` — remove code proven unused by grep and tests.
   3. `deduplicate` — collapse duplicate internal logic.
   4. `state-machine` — use the existing task lifecycle state machine more
      consistently.
   5. `simplify` — simplify internal code without changing behavior.
   6. `type-safety` — tighten types in a way `ty check` can verify.
2. **Make the change** in a single commit on `BRANCH`. One internal concern
   per commit. The pre-commit hook restricts edits to `src/ttasks/**`; if
   you genuinely need a test change, stage it separately and commit it
   first (`git commit --no-verify` is only for the human, not for you).
3. **Validate.** Run `GATE_CMD`. On non-zero or timeout:
   `git reset --hard HEAD~1`; append `status=crash, metric=inf`; continue.
4. **Measure.** Run `METRIC_CMD`; parse `metric:` line.
5. **Decide.**
   - `new_metric < best_metric_so_far`: keep the commit, update best.
   - else: `git reset --hard HEAD~1`, status `discard`.
6. **Log.** Append one row to `results.tsv` for every attempt.

Stop early when only cosmetic, risky, or subjective changes remain.

## Hard rules

- Do not change the public API surface. Enforced by the API-hash gate.
- Do not change SQLite schema or persistence format unless fixing a
  confirmed bug; if so, add a migration and a test.
- Do not add features.
- Do not add dependencies.
- Do not modify `pyproject.toml` beyond what a refactor strictly requires.
- Do not touch generated docs or build artifacts.
- Do not push to any remote.
- Do not commit `program.md`, `results.tsv`, `.autotester.json`, or
  `.autotester.api-hash`.
- Respect the scope block injected by the harness. The pre-commit hook
  rejects out-of-scope commits regardless.

## `results.tsv` format

```
commit	metric	status	category	description
```

- `commit` — short hash (7). Pre-attempt hash for `discard`/`crash`.
- `metric` — float (lower is better) or `inf` for crashes.
- `status` — `keep`, `discard`, `crash`.
- `category` — one of the categories listed above.
- `description` — one short line, no tabs or newlines.
