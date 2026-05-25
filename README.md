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
                       [--editable <glob>]... [--readonly <glob>]...
autotester run  <repo> [--program <path>] [--max-attempts <n>] [--allow-dirty]
                       [--tag <name>] [--attempt-timeout <seconds>]
                       [--provider <id>] [--model <pattern>] [--thinking <level>]
```

`--tag <name>` creates a fresh `autotester/<name>` branch from current
HEAD and refuses to reuse an existing tag. `--attempt-timeout <sec>` is
injected into the prompt as `ATTEMPT_TIMEOUT` for the program to use when
wrapping its `GATE_CMD`/`METRIC_CMD` invocations.

The model triple is resolved per field with this priority: CLI flag >
program front matter > built-in default (`github-copilot/claude-opus-4.7`,
no thinking level). Programs declare their preferred model in optional
YAML front matter:

```yaml
---
provider: github-copilot
model: claude-opus-4.7
thinking: medium
---
```

`--max-attempts` is a runtime instruction injected into the prompt. It is a
maximum, not a quota; the agent should stop early when only risky or subjective
changes remain.

## Files in target repos

- `program.md` — repo-specific agent policy (optional YAML front matter for
  provider/model/thinking).
- `results.tsv` — local run log. Header is
  `commit\tmetric\tstatus\tcategory\tdescription`. Do not commit unless you
  explicitly want to.
- `.autotester.json` — scope declaration (only present when `init` was given
  `--editable`/`--readonly`).
- `.git/hooks/pre-commit` — installed by `init` when scope is declared.
  Rejects staged paths that violate the scope.

## License

MIT
