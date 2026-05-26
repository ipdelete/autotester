---
provider: github-copilot
model: claude-opus-4.7
gate: |
  set -e
  # TODO: Replace with your repo's normal correctness gate and optional doc linter.
  # Python examples:
  #   uv run pytest -q
  #   uv run ruff check .
  # Node examples:
  #   npm test
  #   npm run lint
  echo "TODO: edit program.md and set a real gate command" >&2
  exit 1
metric: |
  set -e
  # Starter metric for Python: count public classes/functions missing docstrings.
  # TODO: Replace for other languages or narrower public-surface rules.
  python3 - <<'PY'
  import ast, pathlib
  n = 0
  for path in pathlib.Path("src").rglob("*.py"):
      tree = ast.parse(path.read_text(errors="ignore"))
      for node in ast.iter_child_nodes(tree):
          if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
              if not node.name.startswith("_") and ast.get_docstring(node) is None:
                  n += 1
  print(f"metric: {n}")
  PY
baseline_description: initial baseline (public symbols missing docstrings)
---

# Documentation writer

You are improving public-facing documentation without changing behavior. The
harness runs `gate` and `metric` after each committed attempt.

Before running, customize:

- `gate` to the repo's tests and optional doc linter.
- `metric` to match the public surface you care about.

## Goal

Lower the documentation metric by adding concise, accurate docs to public
symbols or user-facing files.

## Good attempts

- Add docstrings to public functions/classes/modules.
- Clarify parameter meaning, return values, raised exceptions, and side effects
  when the implementation/tests prove them.
- Improve README/API snippets that are stale or incomplete.
- Prefer concise docs that explain why/contract over obvious restatement.

## Avoid

- Inventing behavior not proven by code/tests.
- Large prose rewrites unrelated to the metric.
- Marketing language.
- Commenting every private helper.
- Changing runtime code except tiny examples/docs fixtures if required.

## Attempt protocol

For each attempt, make one focused documentation improvement, write
`.autotester/attempt.json` with a short description, commit, then stop. Do not
run the gate, metric, or edit `results.tsv`; the harness does that.

If remaining docs require product intent or user-facing decisions, say so and do
not commit.
