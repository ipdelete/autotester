---
provider: github-copilot
model: claude-opus-4.7
gate: |
  set -e
  # TODO: Replace this with the commands that prove your repo still works.
  # Common Python/uv starter:
  #   uv run pytest -q
  #   uv run ruff check .
  #   uv run ty check
  # Common Node starter:
  #   npm test
  #   npm run lint
  if [ -f uv.lock ] || [ -f pyproject.toml ]; then
    if [ -d tests ]; then uv run pytest -q; fi
    if command -v uv >/dev/null 2>&1; then
      uv run ruff check . 2>/dev/null || true
    fi
  elif [ -f package.json ]; then
    npm test
  else
    echo "TODO: edit program.md and set a real gate command" >&2
    exit 1
  fi
metric: |
  set -e
  # Starter metric: non-blank, non-comment source lines. Lower is better.
  # TODO: Adjust SOURCE_DIRS for your repo.
  export SOURCE_DIRS="src"
  python3 - <<'PY'
  import os, pathlib
  dirs = [pathlib.Path(p) for p in os.environ.get("SOURCE_DIRS", "src").split()]
  suffixes = {".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs"}
  comment_prefixes = ("#", "//")
  n = 0
  for root in dirs:
      if not root.exists():
          continue
      for path in root.rglob("*"):
          if path.suffix not in suffixes or not path.is_file():
              continue
          for line in path.read_text(errors="ignore").splitlines():
              s = line.strip()
              if s and not s.startswith(comment_prefixes):
                  n += 1
  print(f"metric: {n}")
  PY
baseline_description: initial baseline (source SLOC)
---

# Code simplifier

You are making small, behavior-preserving simplifications. The harness runs
`gate` and `metric` from the front matter after each committed attempt. Your
job is only to propose one focused commit at a time.

Before the first run, the human should review this file and customize:

- `gate` so it proves the repo still works.
- `SOURCE_DIRS` in `metric` so it measures the code you want to simplify.
- Any repo-specific rules below.

## Goal

Lower the metric while keeping the gate green. Prefer changes that reduce
code size and cognitive load without changing public behavior.

## Good attempts

- Merge branches or exception handlers that do the same thing.
- Inline one-shot helpers that obscure more than they clarify.
- Remove dead private parameters, locals, or internal helper functions.
- Replace bespoke loops with comprehensions or standard-library helpers.
- Collapse repeated setup/teardown into a smaller shared helper.
- Simplify conditionals when the new form is clearly equivalent.

## Avoid

- Public API changes: names, signatures, return types, exceptions, CLI flags,
  file formats, database schemas, wire formats.
- Test rewrites to make a change pass.
- Formatting-only churn, import sorting, quote-style churn.
- Broad architectural rewrites.
- Comment/docstring deletion unless the text is obsolete after a simplification.
- Clever golfed code that is smaller but harder to maintain.

## Attempt protocol

For each attempt:

1. Inspect enough code to identify one safe simplification.
2. Edit only the files needed for that simplification.
3. Write `.autotester/attempt.json` with a short description, for example:
   `{"description":"Collapsed duplicate error-handling branches in parser"}`.
4. Commit the change.
5. Stop. Do not run the gate, metric, or edit `results.tsv`; the harness does
   that and will tell you whether the commit was kept.

If only risky or subjective changes remain, say so and do not commit.
