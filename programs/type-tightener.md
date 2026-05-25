---
provider: github-copilot
model: claude-opus-4.7
thinking: medium
gate: |
  set -e
  # TODO: Replace with your repo's tests plus type checker.
  # Python examples:
  #   uv run pytest -q
  #   uv run mypy .
  #   uv run pyright
  #   uv run ty check
  # TypeScript examples:
  #   npm test
  #   npx tsc --noEmit
  echo "TODO: edit program.md and set gate to tests + type checker" >&2
  exit 1
metric: |
  set -e
  # Starter metric for Python: count unannotated defs in src/. Lower is better.
  # TODO: Replace with a type-checker error count if that better matches your repo.
  python3 - <<'PY'
  import ast, pathlib
  n = 0
  for path in pathlib.Path("src").rglob("*.py"):
      tree = ast.parse(path.read_text(errors="ignore"))
      for node in ast.walk(tree):
          if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
              if node.name.startswith("_"):
                  continue
              args = node.args.posonlyargs + node.args.args + node.args.kwonlyargs
              missing_args = any(a.annotation is None for a in args if a.arg not in {"self", "cls"})
              missing_return = node.returns is None
              if missing_args or missing_return:
                  n += 1
  print(f"metric: {n}")
  PY
baseline_description: initial baseline (untyped public Python functions)
---

# Type tightener

You are improving static types without changing runtime behavior. The harness
runs `gate` and `metric` after each committed attempt.

Before running, customize the front matter:

- Set `gate` to the repo's normal tests plus its type checker.
- Set `metric` to count the type problems you want to drive down.

## Goal

Lower the metric by adding or tightening types while keeping the gate green.

## Good attempts

- Add obvious parameter and return annotations.
- Introduce small local type aliases when they reduce repetition.
- Replace imprecise `Any` with concrete types when usage proves the type.
- Tighten optionals/unions with local guards.
- Add generic parameters to internal helpers or containers.
- Remove unnecessary casts or ignores after making types precise.

## Avoid

- Runtime behavior changes.
- Large type framework rewrites.
- `# type: ignore`, `cast(Any, ...)`, or `Any` as a way to hide problems.
- Changing public APIs unless the repo explicitly permits it.
- Reformatting or unrelated cleanups.

## Attempt protocol

For each attempt, make one focused typing improvement, write
`.autotester/attempt.json` with a short description, commit, then stop. Do not
run the gate, metric, or edit `results.tsv`; the harness does that.

If remaining type issues require design decisions or public API changes, say so
and do not commit.
