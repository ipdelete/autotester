# Commands

## `autotester programs`

List bundled starter templates:

```bash
autotester programs
```

Example output:

```text
bug-finder
coverage-raiser
dep-pruner
doc-writer
simplifier
type-tightener
```

## `autotester init`

Copy a bundled program template to repo-local `program.md`:

```bash
autotester init --program simplifier
```

Options:

- `--repo PATH`: target repository, default `.`.
- `--program NAME`: bundled template name, default `simplifier`.
- `--force`: overwrite an existing `program.md`.

## `autotester run`

Run the program in the target repository:

```bash
autotester run --tag run-001 --max-attempts 5
```

Options:

- `--repo PATH`: target repository, default `.`.
- `--program PATH`: explicit program file, default `program.md` in the repo.
- `--max-attempts N`: maximum agent attempts, default `5`.
- `--attempt-timeout SECONDS`: timeout for agent/gate/metric/proof tasks,
  default `600`.
- `--max-no-finding-attempts N`: bugfix-mode no-commit budget, default `3`.
- `--allow-dirty`: allow tracked changes before starting.
- `--tag NAME`: create branch `autotester/NAME` before running.
- `--model MODEL`: override model from `program.md`.
- `--thinking LEVEL`: override reasoning effort from `program.md`.
- `--db PATH`: override the ttasks SQLite database path.

## `autotester history`

Render adjudication history from the ttasks SQLite ledger:

```bash
autotester history
```

Options:

- `--repo PATH`: target repository, default `.`.
- `--db PATH`: explicit SQLite database path.

The output is a tab-separated view of persisted adjudication tasks:

```text
attempt elapsed_s metric status commit graph description
```
