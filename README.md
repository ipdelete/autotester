# autotester

`autotester` runs program-driven coding-agent loops for conservative repository
improvement.

The product is the program: `program.md` tells the agent how to inspect, refine,
validate, commit, discard, and log small changes. The CLI is intentionally thin;
it loads the program, starts a Pi coding-agent session in the target repository,
and prints a summary when the run finishes.

## Requirements

- Node.js 22.19+
- `pnpm`
- Pi authentication/model configuration. Run `pi` and use `/login`, or configure
  provider API keys supported by Pi.

## Usage

From a clone of this repository:

```bash
pnpm install
pnpm build
npm link
```

Initialize a repository with the default program:

```bash
autotester init ~/src/my-repo
```

Run a bounded local-only loop:

```bash
autotester run ~/src/my-repo
```

Use a repo-specific program:

```bash
autotester run ~/src/my-repo --program ~/src/my-repo/program.md --max-attempts 10
```

By default, `run` refuses to start if the target repository has uncommitted
tracked changes. Use `--allow-dirty` only when the program should explicitly
preserve existing work.

## Commands

```text
autotester init <repo> [--program <path>] [--force]
autotester run <repo> [--program <path>] [--max-attempts <n>] [--allow-dirty]
```

`--max-attempts` is a runtime instruction injected into the prompt. It is a
maximum, not a quota; the agent should stop early when only risky or subjective
changes remain.

## Files in target repos

- `program.md` — repo-specific agent policy.
- `results.tsv` — local run log. Do not commit unless you explicitly want to.

## License

MIT
