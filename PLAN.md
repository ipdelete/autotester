# Plan: add `bug-finder.md` with deterministic bugfix validation mode

## Goal

Add a new starter template, `programs/bug-finder.md`, for an autoresearch-style QA loop:

1. Learn how the system is meant to be used.
2. Probe unexpected but plausible usage.
3. Find one real latent bug.
4. Add a regression test.
5. Fix the bug.
6. Commit exactly one test+fix commit.
7. Let the harness prove the bug existed before and is fixed now.

Keep the existing starter-template workflow:

- No roles system.
- No repo card.
- No template composition.
- `autotester init <repo> --program programs/bug-finder.md` copies the starter into `<repo>/program.md`.
- User edits `<repo>/program.md` before running.

This adds one harness validation mode, `mode: bugfix`, beside the current default optimization mode.

## Autoresearch alignment

This should preserve the important autoresearch discipline:

```text
agent proposes experiment -> deterministic evaluator scores it -> branch advances only on verified improvement -> results.tsv logs the trajectory
```

Mapping:

| autoresearch | bug-finder |
| --- | --- |
| experiment = training-code change | experiment = one bug hypothesis + regression test + fix |
| evaluator = `uv run train.py` | evaluator = parent-fail / child-pass / targeted-test-pass / gate-pass harness |
| metric = val_bpb, lower better | metric = `-verified_regression_fixes`, lower better |
| keep if model improves | keep if latent defect is proved and retired |
| reset if worse/crash | reset if not proven |

The LLM proposes. The harness adjudicates.

## Harness vs LLM ownership

### Harness owns

Anything objective, mechanical, security/safety-critical, or easy for the model to silently get wrong:

- Front-matter mode validation.
- Attempt boundary: parent SHA before turn, child SHA after turn.
- Exactly-one-commit check.
- Manifest parsing and required-field validation.
- Protected-file checks.
- Changed-file checks against manifest-declared files.
- Parent and child temp worktree creation/cleanup.
- Parent repro must fail.
- Optional parent failure pattern must match.
- Child repro must pass.
- Targeted regression test must pass.
- Full gate must pass.
- Metric computation: `-verified_regression_fixes`.
- `results.tsv` append.
- Per-attempt diagnostics JSON.
- Reset/clean on reject.

### LLM owns

Judgment/search work:

- Learn public usage from README/docs/examples/tests/API/CLI help.
- Generate bug hypotheses.
- Design the inline reproduction command.
- Add a regression test.
- Make a minimal fix.
- Write `.autotester/attempt.json`.
- Commit exactly the test+fix files.

The LLM never decides whether the attempt counts. It only supplies a candidate proof.

## Metric

Use a lower-is-better negative cumulative metric:

```text
metric = - verified_regression_fixes
```

Human-facing name:

```text
verified defect retirements
```

Meaning:

- Baseline: `metric: 0`.
- One accepted bugfix: `metric: -1`.
- Two accepted bugfixes: `metric: -2`.

This does **not** mean the repo has negative bugs. It means the run has retired N previously unknown defects while keeping the repo in a known-good state.

A kept bugfix increments the count by exactly 1. Do not weight by severity in v1; severity is subjective and gameable.

Rejected bugfix attempts use `metric = inf`, consistent with failed-gate semantics.

## Bugfix acceptance rule

A bugfix attempt is kept iff all of these are true:

1. Agent made exactly one commit since the attempt started.
2. `.autotester/attempt.json` exists and includes required bugfix fields:
   - `description`
   - `repro_command`
   - `test_command`
   - `test_files`
   - `fix_files`
3. The child commit does not touch protected harness files.
4. The child commit changes every file listed in `test_files` and `fix_files`.
5. The child commit changes no files outside `test_files ∪ fix_files`.
6. `repro_command` fails in a temp worktree checked out at the parent commit.
7. Optional `parent_failure_pattern`, if present, matches parent repro output.
8. `repro_command` passes in a temp worktree checked out at the child commit.
9. `test_command` passes in the child worktree.
10. Program front-matter `gate` passes in the child worktree.

If all pass:

- Keep the main repo at the child commit.
- Increment `verified_regression_fixes`.
- Append a row with `metric = -verified_regression_fixes`.

If any check fails:

- Append a row with `metric = inf`.
- Reset the main repo to the parent commit.
- Mark status `discard` or `crash` depending on failure type.

## Status classification

| Failure | Status | Reason |
| --- | --- | --- |
| No commit | stop | Agent stop signal. |
| More than one commit | `crash` | Protocol violation. |
| Missing/invalid manifest | `crash` | Protocol violation. |
| Missing `test_files`/`fix_files` | `crash` | Cannot verify commit shape. |
| Protected file edited | `crash` | Harness control file modification. |
| Manifest file not changed | `crash` | Manifest lied or wrong file listed. |
| Unlisted file changed | `crash` | Attempt is not scoped to declared test+fix. |
| Parent repro times out/infrastructure failure | `crash` | Cannot prove parent behavior. |
| Parent repro passes | `discard` | Not proven to be a pre-existing bug. |
| Parent repro fails but pattern does not match | `discard` | Failure is not the claimed failure. |
| Child repro fails | `discard` | Fix does not satisfy reproduction. |
| Child targeted test fails | `discard` | Regression test does not pass. |
| Full child gate fails | `discard` | Fix regresses the repo. |
| Any unexpected harness exception | `crash` | Unexpected validation failure. |

## Why use `repro_command` instead of only the new test?

The committed regression test does not exist on the parent commit. Running the new test path against the parent would fail because the file is missing, not necessarily because the bug exists.

So the agent must provide an inline reproduction command that works against both parent and child:

- On parent: exits nonzero because the bug exists.
- On child: exits zero because the bug is fixed.

The committed regression test is still required to keep the bug fixed in the future.

## Attempt manifest schema

Existing optimize mode manifest:

```json
{"description": "short summary"}
```

Bugfix mode manifest:

```json
{
  "description": "Fix empty input crash in parser",
  "repro_command": "python - <<'PY'\n...\nPY",
  "test_command": "pytest tests/test_parser.py::test_empty_input -q",
  "test_files": ["tests/test_parser.py"],
  "fix_files": ["src/parser.py"],
  "parent_failure_pattern": "ValueError|AssertionError"
}
```

Required in bugfix mode:

- `description`: one-line human summary.
- `repro_command`: inline command that fails on parent and passes on child.
- `test_command`: command targeting the committed regression test.
- `test_files`: array of test files changed/added by the commit.
- `fix_files`: array of implementation/config files changed by the fix.

Optional:

- `parent_failure_pattern`: regex matched against parent repro stdout+stderr. Useful to prove the parent failed for the claimed reason rather than a syntax/import/setup error.

Potential future fields, not used in v1:

```json
{
  "severity": "low|medium|high",
  "area": "parser"
}
```

Do not weight the metric by these fields in v1.

## Protected files

Reject bugfix commits touching harness control files:

- `program.md`
- `results.tsv`
- `.autotester.json`
- `.autotester/attempt.json`
- `.autotester/runs/**`
- `.autotester/attempts/**`

This should probably become a general harness rule for all modes later, but implement/enforce it for bugfix mode first.

## Harness design

### Front matter

Add supported key:

```yaml
mode: optimize | bugfix
```

Default when omitted:

```yaml
mode: optimize
```

Validation:

- `optimize` requires `gate` and `metric`.
- `bugfix` requires `gate`; `metric` is optional/ignored because the harness supplies `-verified_regression_fixes`.
- Unknown mode is a startup error.

### Runner branching

Current loop validates attempts with:

```text
gate passes && metric improves
```

New shape:

```text
if mode == optimize:
  existing gate + metric improvement path
else if mode == bugfix:
  regression-proof path
```

### Two temp worktrees

Do validation in temp worktrees so repro/test/gate side effects never affect the main repo:

1. `parent = HEAD before agent turn`.
2. Agent commits; `child = HEAD after agent turn`.
3. Create temp detached worktree at parent:

```bash
git worktree add --detach <parent_tmpdir> <parent>
```

4. Create temp detached worktree at child:

```bash
git worktree add --detach <child_tmpdir> <child>
```

5. Run `repro_command` in parent worktree, expect failure.
6. Run `repro_command` in child worktree, expect success.
7. Run `test_command` in child worktree, expect success.
8. Run `gate` in child worktree, expect success.
9. Remove both worktrees in `finally`:

```bash
git worktree remove --force <tmpdir>
```

Use existing `attemptTimeout` for each shell command.

Do not copy untracked files into worktrees. The repro/test/gate must be self-contained from a clean checkout plus normal dependency manager behavior.

### Commit count

Require exactly one commit per attempt:

```bash
git rev-list --count <parent>..HEAD
```

- Count 0: agent stop signal.
- Count 1: continue validation.
- Count >1: `crash`, protocol violation, reset to parent.

### Changed-file validation

Compute changed files:

```bash
git diff --name-only <parent>..<child>
```

Then:

- reject if any protected file changed,
- reject if any `test_files` entry did not change,
- reject if any `fix_files` entry did not change,
- reject if any changed file is not listed in `test_files ∪ fix_files`.

This makes the attempt auditable: one bug, one declared regression test set, one declared fix set.

### Per-attempt diagnostics

Write structured validation diagnostics for every bugfix attempt:

```text
.autotester/attempts/<attempt>.json
```

Example:

```json
{
  "attempt": 2,
  "status": "discard",
  "reason": "parent-repro-passed",
  "parent": "abc1234",
  "child": "def5678",
  "description": "duplicate-id repro",
  "commands": {
    "parent_repro": {"exitCode": 0, "durationMs": 120, "stdoutTail": "...", "stderrTail": "..."},
    "child_repro": null,
    "targeted_test": null,
    "gate": null
  }
}
```

Keep `results.tsv` compact; diagnostics are for audit/debugging.

### Results rows

Keep existing TSV header:

```text
attempt  elapsed_s  metric  status  commit  description
```

For bugfix mode:

- Baseline row: metric `0`, status `keep`, commit start SHA.
- Kept attempt N: metric `-N`, status `keep`, commit child SHA.
- Rejected attempts: metric `inf`, status `discard`/`crash`, commit attempted child SHA.

Example:

```text
attempt elapsed_s metric status  commit  description
0       4         0      keep    c763261 initial baseline
1       180       -1     keep    a1b2c3d fix empty input crash in parser
2       310       inf    discard d4e5f6a duplicate-id repro passed on parent
3       515       -2     keep    987abcd fix cancellation leaving executor blocked
```

## `programs/bug-finder.md` starter

Front matter:

```yaml
---
provider: github-copilot
model: claude-opus-4.7
thinking: high
mode: bugfix
gate: |
  set -e
  # TODO: Replace with your repo's correctness gate.
  # Python/uv:
  #   uv run pytest -q
  #   uv run ruff check .
  #   uv run ty check
  # Node:
  #   npm test
  #   npm run lint
  echo "TODO: edit program.md and set a real gate command" >&2
  exit 1
baseline_description: initial baseline (0 verified defect retirements)
---
```

No `metric` block required.

Body should instruct the agent to:

- Think like a QA tester.
- Keep searching until the harness stops you. Do not ask the human whether to continue.
- If a hypothesis is speculative or not reproducible, abandon it internally and try another subsystem.
- Learn public usage from README, docs, examples, tests, CLI help, public APIs.
- Identify core domain objects and lifecycle operations.
- Probe unexpected but plausible usage:
  - empty inputs
  - malformed inputs
  - duplicate IDs/names
  - deeply nested or complex structures
  - graph cycles/disconnected graphs/dependency issues
  - persistence round trips
  - cancellation/interruption
  - repeated calls/idempotence
  - invalid state transitions
  - serialization/deserialization boundaries
  - unicode/path/env-var edge cases
  - concurrency/race-like behavior where applicable
- Find one real bug.
- Create an inline `repro_command` that fails before the fix and passes after.
- Add a committed regression test.
- Fix the bug minimally.
- Write `.autotester/attempt.json` with `description`, `repro_command`, `test_command`, `test_files`, `fix_files`, and optional `parent_failure_pattern`.
- Commit exactly one commit containing only the declared test and fix files.
- Stop after committing so the harness can validate.

Explicitly forbid:

- Speculative bug reports without reproduction.
- Committing failing tests.
- Broad rewrites.
- Fixing multiple bugs in one attempt.
- Treating missing documentation or style issues as bugs.
- Changing product behavior unless the previous behavior is clearly wrong by docs, tests, invariants, or obvious safety expectations.
- Editing `program.md`, `results.tsv`, or `.autotester*` control files.

## Scope guidance

For bug-finder, users should usually initialize with source and tests editable:

```bash
autotester init ~/src/my-repo \
  --program programs/bug-finder.md \
  --editable 'src/**' \
  --editable 'tests/**'
```

Unlike `simplifier`, this starter is expected to edit both implementation and tests.

## README updates

Add to starter table:

```md
| `programs/bug-finder.md` | Probe behavior like a QA tester; add a regression test and fix for each verified latent bug. |
```

Add a short `bugfix mode` subsection:

- `mode: bugfix` uses negative verified defect retirements.
- Manifest requires `description`, `repro_command`, `test_command`, `test_files`, `fix_files`.
- Harness checks exactly one commit, declared changed files, protected files, parent repro fails, child repro passes, targeted test passes, full gate passes.
- Validation happens in temp worktrees to avoid side effects in the main repo.

## Tests

Add unit/integration tests for:

1. Front matter parses `mode: bugfix`.
2. Unknown `mode` is rejected.
3. Optimize mode still requires `metric`.
4. Bugfix mode permits no `metric`.
5. Manifest parser accepts required bugfix fields.
6. Manifest parser rejects missing `repro_command`/`test_command`/`test_files`/`fix_files` in bugfix mode.
7. Protected-file detection.
8. Changed-file validation against manifest.
9. Worktree parent/child repro helper:
   - create temp git repo with buggy function,
   - child fixes function and adds test,
   - parent repro fails,
   - child repro passes.
10. Diagnostics JSON shape.
11. Runner-level bugfix validation if practical without invoking Pi; otherwise test the validation helper directly.

## Implementation phases

### Phase 1 — Front matter + validation types

- Add `mode?: "optimize" | "bugfix"` to `FrontMatter`.
- Parse and validate `mode`.
- Update runner startup validation:
  - optimize requires `gate` + `metric`
  - bugfix requires `gate`

### Phase 2 — Attempt manifest parsing

- Extract manifest parsing from `runner.ts` into a helper/module.
- Define `AttemptManifest` with optional bugfix fields.
- Add `requireBugfixManifest()` validation helper.

### Phase 3 — Git/worktree + file-validation helpers

- Add helpers:
  - `commitCount(repo, from, to)`
  - `changedFiles(repo, from, to)`
  - `createDetachedWorktree(repo, ref)`
  - `removeWorktree(repo, path)`
  - protected-file detection
  - manifest-file coverage validation
- Ensure worktree cleanup in `finally`.

### Phase 4 — Bugfix validation path

- Implement `validateBugfixAttempt()` returning:
  - status
  - metric (`-count` for keep, `inf` for reject)
  - description
  - reason
  - command diagnostics
- Integrate into runner loop.
- Maintain `verifiedRegressionFixes` count in run state.

### Phase 5 — Diagnostics

- Write `.autotester/attempts/<attempt>.json` for every bugfix attempt.
- Include parent/child SHA, status, reason, manifest fields, command exit/duration/stdout/stderr tails.

### Phase 6 — Starter + docs

- Add `programs/bug-finder.md`.
- Update README starter table and bugfix-mode explanation.

### Phase 7 — Tests + smoke

- Run build/tests.
- Smoke test `autotester init --program programs/bug-finder.md`.
- If time permits, create a tiny temp git repo and test bugfix validation helper without Pi.

## Non-goals

- No issue filing.
- No findings-only artifact mode.
- No severity-weighted metric.
- No multiple commits per attempt.
- No automatic duplicate-bug detection.
- No ttasks-specific code or paths.
- No new dependencies.
