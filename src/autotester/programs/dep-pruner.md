---
provider: github-copilot
model: claude-opus-4.7
thinking: medium
gate: |
  set -e
  # TODO: Replace with the full suite that proves dependency/import pruning is safe.
  # Python example:
  #   uv run pytest -q
  #   uv run ruff check .
  #   uv run ty check
  # Node example:
  #   npm test
  #   npm run lint
  echo "TODO: edit program.md and set a real gate command" >&2
  exit 1
metric: |
  set -e
  # Starter metric: count likely unused imports reported by ruff F401. Lower is better.
  # TODO: Replace with dependency-count or depcheck output if pruning manifests.
  if [ -f pyproject.toml ] || [ -f uv.lock ]; then
    count=$(uv run ruff check . --select F401 --output-format concise 2>/dev/null | wc -l | tr -d ' ')
    echo "metric: ${count:-0}"
  else
    echo "metric: 0"
  fi
baseline_description: initial baseline (likely unused imports)
---

# Dependency and import pruner

You are removing unused imports, dead dependency references, and stale manifest
entries conservatively. The harness runs `gate` and `metric` after each
committed attempt.

Before running, customize:

- `gate` to the repo's full test/lint/type suite.
- `metric` to what you actually want to prune: unused imports, dependency
  count, depcheck findings, lockfile-only packages, etc.

## Goal

Lower the metric by pruning unused things while preserving runtime behavior,
packaging behavior, and optional/plugin behavior.

## Good attempts

- Remove unused imports identified by the linter.
- Remove private dead modules only after proving nothing imports them.
- Remove manifest dependencies only when there is strong evidence they are not
  imported, dynamically loaded, used by build tooling, or used by optional
  extras/plugins.
- Update lockfiles when manifest dependencies change.
- Prefer one dependency/import cluster per attempt.

## Avoid

- Removing optional, plugin, test, docs, build, or packaging dependencies without
  explicit evidence.
- Assuming grep proves absence when dynamic imports or entry points exist.
- Broad dependency upgrades/downgrades.
- Combining pruning with unrelated refactors.
- Editing vendored or generated files.

## Attempt protocol

For each attempt, prune one focused dependency/import cluster, write
`.autotester/attempt.json` with a short description, commit, then stop. Do not
run the gate, metric, or edit `results.tsv`; the harness does that.

If remaining candidates are ambiguous, say so and do not commit.
