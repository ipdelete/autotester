# autotester

`autotester` is a tiny protocol for agent-driven repository improvement loops.

It borrows the core idea from autonomous research loops: make one small change, run the repo's checks, keep the change only if it is clearly better, and log every attempt. Instead of optimizing a training metric, `autotester` optimizes code quality through conservative gates: passing tests, small diffs, behavior preservation, and obvious maintainability wins.

## Quick start

Run directly from GitHub with `uv`:

```bash
uvx --from git+https://github.com/ipdelete/autotester autotester init
```

Or, from this repository:

```bash
uv run autotester init
```

This writes two files into the current repository:

- `program.md` — instructions for a coding agent.
- `results.tsv` — an untracked experiment log.

Then start your coding agent with:

```txt
Read program.md and start an autotester run. Establish the baseline, then make one small code-quality improvement at a time. Keep only changes that pass validation and are clearly simpler, safer, or better tested.
```

## What the loop does

Each iteration:

1. Finds one high-confidence improvement.
2. Makes the smallest useful change.
3. Runs targeted validation.
4. Keeps and commits the change only when checks pass and the improvement is obvious.
5. Logs the result to `results.tsv`.
6. Reverts ambiguous, risky, broad, or failing changes.

## Good first tracks

- **test hardening**: add missing edge cases or strengthen weak assertions.
- **simplification**: remove unnecessary branches, wrappers, or indirection.
- **dead code**: delete unused code when the repo's tools confirm it is safe.
- **type safety**: replace unsafe casts or nullable assumptions with real checks.
- **error handling**: make failure modes explicit and useful.

## Safety model

`autotester` is intentionally conservative. It does not try to assign a single numeric score to code quality. A change is kept only if it passes hard gates and is easy for a human reviewer to understand.

The default program tells the agent to avoid broad rewrites, preserve user changes, avoid dependency changes unless explicitly allowed, and revert work that is not clearly better.

## Files

```text
src/autotester/programs/autotester.md  default agent program
examples/results.tsv                   example experiment log
```

## License

MIT
