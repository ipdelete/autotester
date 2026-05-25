---
provider: github-copilot
model: claude-opus-4.7
gate: |
  set -e
  uv run pytest -q
  uv run ruff check .
  uv run ty check
  # Public API invariant: hash signatures of names in ttasks.__all__ and
  # compare against the snapshot taken at the first run. The snapshot file
  # is bootstrapped on the first pass and then frozen.
  uv run python - <<'PY'
  import hashlib, inspect, json, os, pathlib, sys
  import ttasks  # noqa
  parts = []
  for name in getattr(ttasks, "__all__", []):
      obj = getattr(ttasks, name)
      try:
          sig = str(inspect.signature(obj))
      except (TypeError, ValueError):
          sig = "<no-signature>"
      parts.append(f"{name}{sig}")
  current = hashlib.sha256("\n".join(parts).encode()).hexdigest()
  snap = pathlib.Path(".autotester.api-hash")
  if not snap.exists():
      snap.write_text(current + "\n")
      print(f"api-hash bootstrapped: {current[:12]}")
  else:
      expected = snap.read_text().strip()
      if expected != current:
          print(f"api-hash mismatch: expected {expected[:12]}, got {current[:12]}", file=sys.stderr)
          sys.exit(1)
      print(f"api-hash ok: {current[:12]}")
  PY
metric: |
  set -e
  uv run python - <<'PY'
  import pathlib
  n = 0
  for p in pathlib.Path("src/ttasks").rglob("*.py"):
      for line in p.read_text().splitlines():
          s = line.strip()
          if s and not s.startswith("#"):
              n += 1
  print(f"metric: {n}")
  PY
---

# ttasks autotester program

The harness runs gate and metric. The gate ensures (a) tests pass, (b)
`ruff` is clean, (c) `ty` type-checks, and (d) the public API hash for
`ttasks.__all__` matches the snapshot in `.autotester.api-hash`. The
metric is `cloc` SLOC of `src/ttasks/` only.

## What to optimize

Lower the SLOC of `src/ttasks/` without changing the public API and
without breaking the gate. The snapshot file `.autotester.api-hash` is
created on the first gate run; do not edit or delete it.

## Allowed kinds of change

- **Simplify**: replace bespoke loops with comprehensions or stdlib
  helpers where the result is no less readable.
- **Deduplicate**: merge handlers, factories, or branches that do the same
  thing under different names.
- **Compact**: combine adjacent statements when no clarity is lost.
- **Inline**: collapse one-shot helpers that obscure rather than clarify.

## Disallowed kinds of change

- Touching anything outside `src/ttasks/` (the pre-commit hook will reject
  it; don't try).
- Renaming, adding, or removing anything in `ttasks.__all__` or changing
  any public signature (the api-hash gate will reject it).
- Behavior changes the test suite doesn't cover but a user might rely on
  (be conservative — when in doubt, leave it).
- Reformatting, quote-style churn, comment-deletion sprees.

## Attempt protocol

The harness will tell you the current best metric each turn. To make an
attempt: edit files in `src/ttasks/`, write `.autotester/attempt.json`
with a short description, then `git commit`. Do not run gate or metric
yourself; the harness will. If only risky/subjective changes remain, say
so in plain text and don't commit — the harness will stop.
