# Plan: polish bug-finder repair observability

## Context

The bug-finder max-2 run on `ianphil/ttasks` worked:

- Attempt 1 found a documented SQLite storage import-path bug.
- The parent/child proof and targeted test passed.
- The full gate failed initially, so the new repair turn triggered.
- The agent amended the same commit.
- Revalidation passed and the commit was kept.
- Attempt 2 found and fixed a blocked-task retry/no-handler bug.
- Final metric: `0 -> -2` verified defect retirements.

This validates the core `mode: bugfix` loop. The remaining improvements are not architectural; they are observability/polish.

## PR note from the run

`ianphil/ttasks` is a fork of `ipdelete/ttasks`.

The PR I created was:

```text
https://github.com/ianphil/ttasks/pull/1
```

That targets the fork repo itself. If the intended contribution target is upstream, the correct PR shape is instead:

```bash
gh pr create \
  --repo ipdelete/ttasks \
  --base master \
  --head ianphil:autotester/bug2-1701
```

No autotester code change is planned for PR publishing right now; this note is just to avoid confusion.

## Goal

Make bug-finder repair turns more transparent without changing the core loop.

Specifically:

1. Preserve pre-repair diagnostics instead of overwriting them.
2. Mark repaired attempts in structured diagnostics.
3. Reduce noisy `uv` hardlink warnings in temp worktree validation by setting `UV_LINK_MODE=copy` in harness shell commands.
4. Track and report repair count in run summary output/JSON.

These are small changes. No new dependencies. No changes to `program.md` workflow. No publish/PR automation.

## Change 1 — Preserve repair diagnostics

### Current behavior

`validateBugfixAttempt()` writes:

```text
.autotester/attempts/0001.json
```

When a full-gate failure triggers a repair turn, the first validation writes a failed diagnostic, then revalidation writes to the same path and overwrites it with the final keep result.

This loses useful information:

- the first full-gate failure reason,
- the exact failed gate output,
- why the repair turn was triggered.

### Desired behavior

Keep both phases.

Recommended file layout:

```text
.autotester/attempts/0001.json
```

with a single combined diagnostic:

```json
{
  "attempt": 1,
  "status": "keep",
  "reason": "verified defect retired",
  "repaired": true,
  "parent": "...",
  "child": "...",
  "description": "...",
  "changedFiles": [...],
  "manifest": {...},
  "commands": {...final validation...},
  "repairs": [
    {
      "trigger": "full gate failed",
      "before": {
        "status": "discard",
        "reason": "full gate failed",
        "child": "pre-amend-sha",
        "commands": {...initial failed validation...}
      },
      "after": {
        "status": "keep",
        "reason": "verified defect retired",
        "child": "post-amend-sha"
      }
    }
  ]
}
```

Alternative file layout:

```text
.autotester/attempts/0001.initial.json
.autotester/attempts/0001.repair.json
.autotester/attempts/0001.json
```

Recommendation: use the single combined `repairs` array. It keeps `0001.json` as the canonical per-attempt file and avoids extra lookup rules.

### Implementation approach

- Export or add a helper in `src/bugfix.ts` to let the runner capture diagnostics without immediately losing the first one.
- Minimal path:
  - Add an optional `diagnosticSuffix` or `writeDiagnostic` option to `validateBugfixAttempt()`.
  - First validation on a possible repair writes/returns diagnostic object.
  - Revalidation writes final canonical diagnostic including `repairs`.
- Better path:
  - Change `validateBugfixAttempt()` to return `{ result, diagnostic }` and let runner write diagnostics.
  - This is slightly cleaner but a little larger.

Recommendation: keep scope small. Add optional `repairOf?: AttemptDiagnostic` / `repairs?: ...` support inside `validateBugfixAttempt()` and a tiny `mergeRepairDiagnostic()` helper.

## Change 2 — Mark repaired attempts

### Desired fields

Add to bugfix diagnostics:

```json
{
  "repaired": true,
  "repairCount": 1
}
```

For attempts that did not repair:

```json
{
  "repaired": false,
  "repairCount": 0
}
```

This lets humans and future tooling distinguish:

- clean keep,
- keep-after-repair,
- discard-after-repair.

### Results TSV

Do **not** add a TSV column. Keep:

```text
attempt  elapsed_s  metric  status  commit  description
```

`results.tsv` remains compact. Diagnostics carry repair detail.

## Change 3 — Set `UV_LINK_MODE=copy` for harness shell commands

### Problem

Temp worktree validation repeatedly emits warnings like:

```text
warning: Failed to hardlink files; falling back to full copy.
If this is intentional, set `export UV_LINK_MODE=copy` ...
```

This clutters diagnostics and logs.

### Desired behavior

When the harness runs shell commands through `runShell()`, set:

```text
UV_LINK_MODE=copy
```

unless the user already set it.

### Implementation

In `src/metric.ts`, update `spawnSync` env:

```ts
env: {
  ...process.env,
  UV_LINK_MODE: process.env.UV_LINK_MODE ?? "copy",
}
```

This affects gate, metric, repro, and targeted test commands. It should not change correctness; it only suppresses uv hardlink warning noise and makes behavior explicit.

## Change 4 — Track/report repair count

### Current summary

Run summary reports:

```text
attempts: 2 (2 keep, 0 discard, 0 crash)
```

But if one attempt needed repair, the summary hides it.

### Desired summary

Console:

```text
attempts: 2 (2 keep, 0 discard, 0 crash, 1 repaired)
```

JSON:

```json
{
  "repairs": 1
}
```

History table could remain unchanged initially, or add a compact column later.

### Implementation

- Add `repairs: number` to `RunSummary` in `src/history.ts`.
- Initialize `let repairs = 0` in `runner.ts`.
- Increment when a repair turn is triggered, regardless of final keep/discard/crash.
- Include `repairs` in summary JSON.
- Print repair count in final console summary.
- Optional: add to `formatHistoryTable()` as a `REP` column. This is small and useful.

Recommendation: add `REP` to history output now, since summary schema changes anyway.

## Tests

Add/update tests for:

1. `runShell()` env includes `UV_LINK_MODE=copy` when unset.
   - Could test indirectly with a command:
     ```bash
     printf 'metric: 0\n'; test "$UV_LINK_MODE" = copy
     ```
   - Or expose env builder helper for unit test.
2. Bugfix repair diagnostics preserve pre-repair failure.
   - Unit-level test can construct/merge diagnostics without running Pi.
   - If direct runner repair testing is too heavy, test the helper in `bugfix.ts`.
3. `RunSummary` accepts `repairs` and `formatHistoryTable()` displays it.
4. Existing bugfix validation tests still pass.

No need to run a full LLM smoke test for these four changes; the previous max-2 run already validated behavior. A build/test pass is enough.

## Implementation phases

### Phase 1 — Shell env noise fix

- Update `runShell()` env with `UV_LINK_MODE=copy` default.
- Add a small test if convenient.

### Phase 2 — Repair count summary

- Add `repairs` to `RunSummary`.
- Track repairs in `runner.ts`.
- Print repairs in final summary.
- Add `REP` column to `history` table.
- Update/add tests.

### Phase 3 — Diagnostic preservation

- Add repair metadata fields to bugfix diagnostics:
  - `repaired`
  - `repairCount`
  - `repairs`
- Preserve initial full-gate-failed diagnostic when repair is triggered.
- Ensure final `0001.json` includes both final validation and repair history.

### Phase 4 — Docs

- Update README bugfix-mode paragraph:
  - repair turns are recorded in diagnostics,
  - final summary includes repair count,
  - `UV_LINK_MODE=copy` is set by harness for quieter uv validation.

### Phase 5 — Build/test/commit/push

- `pnpm build`
- `pnpm test`
- Commit with message focused on bug-finder repair observability.
- Push to `origin/master`.

## Non-goals

- No PR publishing command.
- No automatic upstream/fork PR handling.
- No additional repair attempts beyond one.
- No TSV schema change.
- No change to bugfix acceptance criteria.
- No change to starter-template workflow.
- No new dependencies.
