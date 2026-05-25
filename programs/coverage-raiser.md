---
provider: github-copilot
model: claude-opus-4.7
thinking: medium
gate: |
  set -e
  # TODO: Replace with your coverage-producing test command.
  # Python/coverage.py example:
  #   uv run coverage run -m pytest -q
  #   uv run coverage json -q -o .autotester/coverage.json
  echo "TODO: edit program.md and set gate to run tests with coverage" >&2
  exit 1
metric: |
  set -e
  # Starter metric for coverage.py JSON: count missing lines. Lower is better.
  # TODO: Ensure gate writes .autotester/coverage.json, or replace this metric.
  python3 - <<'PY'
  import json, pathlib, sys
  path = pathlib.Path(".autotester/coverage.json")
  if not path.exists():
      print("metric: inf")
      sys.exit(0)
  data = json.loads(path.read_text())
  missing = 0
  for file_data in data.get("files", {}).values():
      missing += len(file_data.get("missing_lines", []))
  print(f"metric: {missing}")
  PY
baseline_description: initial baseline (uncovered lines)
---

# Coverage raiser

You are adding or improving tests to reduce uncovered behavior. The harness
runs `gate` and `metric` after each committed attempt.

Before running, customize:

- `gate` to run the test suite with coverage and write the coverage report used
  by `metric`.
- The editable scope at `autotester init` time. For this role it is often
  `tests/**`, not `src/**`.

## Goal

Lower the uncovered-line metric by adding high-value tests. Production code
changes are allowed only when a new test exposes a real, small bug and the fix
is obvious.

## Good attempts

- Add tests for uncovered branches, edge cases, and error paths.
- Prefer stable assertions over snapshot churn.
- Prefer one behavior per test.
- Name tests after behavior, not implementation details.
- Use existing fixtures/helpers before inventing new ones.

## Avoid

- Tests that merely execute lines without meaningful assertions.
- Brittle time/order/randomness assumptions.
- Rewriting production code just to make coverage easier.
- Broad fixture framework rewrites.
- Lowering coverage thresholds or excluding files to improve the metric.

## Attempt protocol

For each attempt, add one focused test improvement, write
`.autotester/attempt.json` with a short description, commit, then stop. Do not
run the gate, metric, or edit `results.tsv`; the harness does that.

If the next useful test would require product/design judgment, say so and do not
commit.
