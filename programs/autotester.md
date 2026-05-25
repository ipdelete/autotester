---
provider: github-copilot
model: claude-opus-4.7
gate: |
  set -e
  # Replace with the commands that prove the repo is still correct.
  # Must exit 0 to allow the attempt. Example for a typical Python project:
  #   uv run pytest -q
  #   uv run ruff check .
  exit 1
metric: |
  set -e
  # Print exactly one line `metric: <float>` to stdout. Lower is better.
  # Default: non-blank non-comment lines under ./src (pure shell + find).
  total=$(find src -type f \( -name '*.py' -o -name '*.ts' -o -name '*.js' -o -name '*.go' -o -name '*.rs' \) -print0 2>/dev/null \
    | xargs -0 -r cat \
    | awk 'NF && $1 !~ /^(#|\/\/)/ {n++} END {print n+0}')
  echo "metric: ${total:-0}"
baseline_description: initial baseline (configure gate and metric in program.md front matter)
---

# autotester program

This is the **default** program — most of its substance is in the front
matter, not the body. The harness reads `gate` and `metric` from the front
matter, runs them itself between agent turns, and decides whether each
attempt is kept or discarded. Your job (as the agent) is only to propose
focused, gate-passing changes.

## What to optimize

Lower the metric (measured by the `metric` shell snippet above) while
keeping the gate green. The default metric is total source SLOC; the
default gate is intentionally `exit 1` so you must replace it before this
program will run end-to-end.

## What kinds of changes are appropriate

- **Simplify**: collapse needless indirection, fuse equivalent branches,
  remove dead parameters, replace bespoke code with stdlib idioms.
- **Deduplicate**: merge exception handlers that do the same thing, fold
  three near-identical helpers into one parametrized helper.
- **Compact**: combine related statements when no clarity is lost.

## What kinds of changes are **not** appropriate

- Don't reformat. Don't change quoting style. Don't rename public names.
- Don't touch tests, fixtures, vendored code, generated code, schemas,
  config, or anything outside the editable scope declared at `init` time.
- Don't change behavior under any input the gate exercises. The gate is
  the contract; if a "simplification" needs gate changes to pass, the
  simplification is wrong.

## How to make an attempt

The harness will tell you the current best metric and the protocol each
turn. Briefly: edit files, write `.autotester/attempt.json` with a one-line
description, then `git commit`. The harness will then run gate + metric
and either keep the commit or reset it. Do not run gate/metric yourself.

## When to stop

If you see only risky, broad, or subjective changes remaining, do not
commit — say so in plain text and the harness will stop the loop.
