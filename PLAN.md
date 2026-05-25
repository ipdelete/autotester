# autotester — close-the-gap plan

Goal: bring autotester to parity with autoresearch's discipline (fixed metric
contract, fixed per-attempt budget, hard read-only split, branch-per-run, scoped
edits) while keeping the harness thin and the program file the primary surface
the human iterates on.

Reference: `~/src/autoresearch/{README.md,program.md}`.

## Guiding principles

- Push policy into `program.md`. Push only enforcement that the agent can
  silently violate into the harness.
- One run = one branch = one append-only `results.tsv`.
- Every attempt produces exactly one float on stdout: `metric: <float>`.
  Lower is better. A failed gate → `metric: inf`.
- No new dependencies. No new tools in the agent session. ~150 LOC total.

---

## Phase 1 — Metric contract (program-only, no code)

**Divergence closed:** #1 (no fixed metric), partially #5 (scope encoded in
gate).

**Change:** rewrite `programs/autotester.md` and `programs/ttasks.md` so each
program declares:

1. `METRIC_CMD` — a shell snippet that exits 0 and prints exactly one line
   `metric: <float>` on stdout. Lower is better.
2. `GATE_CMD` — a shell snippet that exits 0 iff invariants hold (tests, lint,
   types, public-API hash, etc.). On non-zero exit, the attempt's effective
   metric is `inf`.
3. The composite rule: `metric = METRIC_CMD output if GATE_CMD passes else inf`.

**Default `programs/autotester.md`:**

- Gate: project's declared test/lint/type commands all exit 0.
- Minimize: source SLOC via `cloc` (excluding tests/build/generated).

**`programs/ttasks.md` specifics:**

- Gate:
  - `uv run pytest -q`
  - `uv run ruff check .`
  - `uv run ty check`
  - Public-API hash: snapshot at branch start via a small inline Python script
    over `ttasks.__all__` signatures; recompute each attempt; mismatch ⇒ fail.
- Minimize: SLOC of `src/ttasks/` only.

**`results.tsv` columns** (uniform across programs):

```
commit   metric   status   category   description
```

`status ∈ {keep, discard, crash}`. `category` retained from current ttasks
program for human readability; not load-bearing.

**Acceptance:**

- A human can paste the program into any clone, run `METRIC_CMD` by hand, and
  see a single `metric:` line.
- The program tells the agent: "before any change, run `METRIC_CMD` to get
  baseline; after each commit, rerun; if not strictly lower, `git reset --hard`
  and record `discard`."

**Files touched:** `programs/autotester.md`, `programs/ttasks.md`. No source.

---

## Phase 1.5 — Model declared in `program.md`

**Divergence closed:** new — promotes the agent identity to a program-level
choice instead of a CLI argument, matching the spirit of "the program is the
product."

**Program format:** every program gets an optional YAML front-matter block at
the top:

```markdown
---
provider: github-copilot
model: claude-opus-4-7
thinking: medium
---

# ttasks autotester program
...
```

Fields (all optional):
- `provider` — Pi provider id (e.g. `github-copilot`, `anthropic`,
  `openai-codex`). Canonical ids from Pi's model registry; case-insensitive.
- `model` — model id within that provider (e.g. `claude-opus-4-7`).
  May also be given in combined `<provider>/<modelId>` form, in which case
  the `provider` key is redundant. The combined form matches the existing
  `--model` CLI grammar.
- `thinking` — one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

Note the canonical id is `claude-opus-4-7` (dashes), not `claude-opus-4.7`.
This is what Pi's `ModelRegistry` indexes; the dot form will not resolve.

**Resolution order** (highest wins, per field):

1. CLI flags: `--provider`, `--model`, `--thinking`.
2. `program.md` front-matter.
3. Built-in default: `provider: github-copilot`, `model: claude-opus-4-7`,
   no thinking level set. Copilot is the default because that's the primary
   subscription this repo targets; Opus 4.7 is the strongest model exposed
   through it.

If a human is logged in via `pi /login` to Copilot but Copilot hasn't
enabled Claude Opus in their account, `ModelRegistry.find` returns
`undefined` and the runner already fails fast (existing behavior). The
error message should hint: "Enable the model in VS Code: Copilot Chat →
model selector → Claude Opus 4.7 → Enable."

**Runner behavior** (`src/prompt.ts`, `src/runner.ts`, `src/cli.ts`):

- `loadProgram` parses optional front matter and returns
  `{ path, text, frontMatter: { provider?, model?, thinking? } }`. `text`
  is the prompt body with front matter stripped, so the agent never sees
  it.
- New CLI flag `--provider <id>` alongside the existing `--model` /
  `--thinking`. The runner combines: effective provider = CLI > front
  matter > default; same for model and thinking, resolved independently.
- `runAutotester` then calls `modelRegistry.find(provider, modelId)`. The
  existing `parseModel` helper that splits on `/` stays — combined-form
  `--model github-copilot/claude-opus-4-7` still works.
- Run header prints the resolved triple and the source of each value
  (`flag`, `program`, `default`), e.g.:
  ```
  model:    github-copilot/claude-opus-4-7 (program)
  thinking: medium (program)
  ```
- Parse error in front matter ⇒ hard fail with line number; no silent
  fallback.
- `ModelRegistry.find` returning undefined ⇒ existing error message,
  augmented with the Copilot "Enable" hint when `provider === "github-copilot"`.

**Bundled program updates:**

- `programs/autotester.md` and `programs/ttasks.md` both start with:
  ```yaml
  ---
  provider: github-copilot
  model: claude-opus-4-7
  ---
  ```
  This makes the default *explicit* in the artifact the human edits,
  rather than buried in source.

**Acceptance:**

- `autotester run repo` with no flags and no front matter uses
  `github-copilot/claude-opus-4-7`.
- Editing `program.md` front matter to a different provider/model changes
  the run without touching the CLI.
- `autotester run repo --provider anthropic --model claude-opus-4-7`
  overrides whatever the program declared and the header reports
  `source=flag` on both.
- `autotester run repo --model github-copilot/claude-opus-4-7` (combined
  form) is equivalent to `--provider github-copilot --model claude-opus-4-7`.
- A program with no front matter still works (parsed as empty, defaults
  apply).
- A program declaring an unknown provider id fails at parse time with a
  clear error listing valid provider ids from `ModelRegistry`.

**Files touched:** `src/prompt.ts` (~40 lines for a small front-matter
parser — no `yaml` dep needed; surface is three keys, parse by hand),
`src/runner.ts` (~25 lines for per-field resolution + header print),
`src/cli.ts` (~10 lines: add `--provider`, thread through),
`programs/*.md` (3-line front-matter prepend).

---

## Phase 2 — Per-attempt time budget + tag (small CLI changes)

**Divergences closed:** #2 (time budget), #4 (branch discipline).

**CLI surface additions** (`src/cli.ts`):

```text
autotester run <repo>
    [--tag <name>]                 # required for new disciplined runs
    [--attempt-timeout <seconds>]  # default 600
    [existing flags...]
```

**Runner behavior** (`src/runner.ts`, `src/git.ts`):

1. If `--tag` is provided:
   - Refuse if `autotester/<tag>` already exists locally or on `origin`.
     (autoresearch's "fresh run" rule.)
   - `git checkout -b autotester/<tag>` from current HEAD before the agent
     starts.
   - Implicitly satisfies the dirty-tree check for the tagged branch; keep
     `--allow-dirty` semantics for the untagged path unchanged.
2. Inject `ATTEMPT_TIMEOUT` and `BRANCH` as named variables into
   `buildRunPrompt` so the program can reference them in `METRIC_CMD` /
   `GATE_CMD` wrappers (e.g. `timeout ${ATTEMPT_TIMEOUT}s uv run pytest`).
3. Print `tag`, `branch`, `attempt-timeout` in the run header alongside
   existing `start: <sha>`.

**Acceptance:**

- `autotester run repo --tag nov25` creates `autotester/nov25` from HEAD,
  errors if it exists.
- Prompt contains explicit `BRANCH=autotester/nov25` and
  `ATTEMPT_TIMEOUT=600` lines the program template can interpolate.
- No change to single-run untagged behavior (back-compat for ad-hoc use).

**Files touched:** `src/cli.ts` (~15 lines), `src/runner.ts` (~20 lines),
`src/git.ts` (one new `branchExists` helper), `src/prompt.ts` (extend
`PromptOptions`).

---

## Phase 3 — Read-only / editable enforcement (harness, real teeth)

**Divergences closed:** #3 (read-only split), #5 (single-file scope).

This is the only divergence the agent can violate undetected, so the harness
must enforce it. Mechanism: a pre-commit hook installed at `init` time, plus
declarative scope baked into `.autotester.json`.

**`init` surface:**

```text
autotester init <repo>
    [--program <path>]
    [--readonly <glob>]...   # repeatable
    [--editable <glob>]...   # repeatable; if set, everything else read-only
    [--force]
```

**Files written by `init`** (in addition to `program.md` + `results.tsv`):

1. `.autotester.json` — declarative config:

   ```json
   {
     "readonly": ["prepare.py", "**/generated/**"],
     "editable": ["src/ttasks/**"],
     "metric_marker": "metric:"
   }
   ```

2. `.git/hooks/pre-commit` (or chained from existing) — a small POSIX shell
   script that:
   - reads `.autotester.json`,
   - lists `git diff --cached --name-only`,
   - rejects the commit (exit 1) if any staged path matches a `readonly`
     glob, or if `editable` is non-empty and any staged path falls outside
     it,
   - emits a clear `blocked: <path>` message so the agent sees it in tool
     output and can self-correct.

   The hook is idempotent: if a previous autotester hook exists, replace it;
   if a user hook exists, chain (call user hook first, fail if it fails,
   then run autotester checks). Document the chain behavior in the hook
   header comment.

**`run` behavior:**

- On startup, load `.autotester.json` if present, and inject the
  `readonly`/`editable` lists into the prompt verbatim under a "Scope" header
  so the agent gets a soft warning *and* a hard wall.
- If `.autotester.json` is absent, run unchanged (back-compat).

**Acceptance:**

- `autotester init repo --editable 'src/ttasks/**'` writes `.autotester.json`
  and a pre-commit hook.
- A commit that touches `tests/foo.py` is rejected by the hook with a
  diagnostic. The agent sees the diagnostic in its `bash` tool output and
  can recover (revert / re-stage).
- `git commit --no-verify` still works for the human (escape hatch).

**Files touched:** `src/cli.ts` (~30 lines), new `src/hook.ts` (template
literal for the hook script, ~40 lines), `src/prompt.ts` (~10 lines to read
config and prepend scope block), `src/runner.ts` (~5 lines).

---

## Phase 4 — Rewrite `programs/ttasks.md` against the new contract

**Divergence closed:** completes #1, #2, #5 for ttasks specifically.

**Concrete rewrite outline:**

1. Add a "Run variables" section that documents `BRANCH`, `ATTEMPT_TIMEOUT`
   (injected by harness).
2. Add a "Metric" section that defines `GATE_CMD` and `METRIC_CMD`
   verbatim — copy-pasteable shell.
3. Add an "API snapshot" section: first action on the new branch is to
   compute and stash the public-API hash; every gate run recomputes and
   compares.
4. Replace the prose "keep criteria" with the numeric rule: keep iff
   `new_metric < best_metric`. Discard otherwise. Crash iff gate fails *or*
   metric run times out.
5. Keep the existing "categories" list — it's good prose for the
   `description` column, just not the keep decision.
6. Tighten the scope clause: declare editable globs (`src/ttasks/**`) so
   `init --editable 'src/ttasks/**'` is the canonical setup line in the
   README.

**Acceptance:**

- `autotester init ~/tmp/ttasks --program programs/ttasks.md --editable 'src/ttasks/**'` followed by
  `autotester run ~/tmp/ttasks --tag nov25` runs a disciplined experiment.
- `results.tsv` after a session has a numeric `metric` column with at least
  one `keep` strictly improving on the baseline, or all `discard`/`crash`
  rows if no improvement was found.

**Files touched:** `programs/ttasks.md`. No source.

---

## Out of scope (intentional)

- A metric server / dashboard. Tail `results.tsv`; that's the autoresearch
  pattern and it's enough.
- Distributed multi-agent fan-out. autoresearch's
  `autoresearch/<tag>-gpu0/-gpu1/...` convention can be adopted later by
  letting `--tag` carry a suffix; no harness work needed yet.
- Auto-rebase / branch consolidation across runs. Each `--tag` is its own
  story; humans cherry-pick.

## Order of work + rough size

| Phase | What | Code LOC | Doc LOC | Risk |
|-------|------|----------|---------|------|
| 1 | Metric contract in bundled programs | 0 | ~150 | low |
| 1.5 | Provider + model + thinking in front matter; default copilot/opus-4-7 | ~75 | ~15 | low |
| 2 | `--tag`, `--attempt-timeout`, prompt vars | ~50 | ~20 | low |
| 3 | `.autotester.json` + pre-commit hook + scope prompt | ~90 | ~30 | medium (hook chaining is the only fiddly bit) |
| 4 | Rewrite `programs/ttasks.md` against contract | 0 | ~100 | low |

Total: ~215 LOC of TypeScript, ~315 LOC of markdown. No new deps. Phases are
independently shippable; phase 1 alone closes most of the spirit gap.

## Definition of done

A human can:

1. `autotester init <repo> --program <p> --editable '<glob>'`
2. `autotester run <repo> --tag <name> --attempt-timeout 600`
3. Wake up to an `autotester/<name>` branch and a `results.tsv` with a
   monotonically non-increasing `metric` column among `keep` rows, where the
   first `keep` row is the baseline.

That's the autoresearch loop, generalized.
