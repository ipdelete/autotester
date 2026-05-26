# Quickstart

## Run from GitHub

Run without installing permanently:

```bash
uvx --from git+https://github.com/ipdelete/autotester.git autotester programs
```

Run from a branch or tag:

```bash
uvx --from git+https://github.com/ipdelete/autotester.git@master autotester --help
```

If `uvx` cannot find `uv`, check both commands:

```bash
which uv uvx
uvx --version
```

Some `uvx` installs expect a sibling `uv` binary at `~/.local/bin/uv`. If your
working `uv` is `/usr/bin/uv`, this fixes that layout:

```bash
ln -sfn /usr/bin/uv ~/.local/bin/uv
```

## Install as a uv tool

```bash
uv tool install git+https://github.com/ipdelete/autotester.git
```

Upgrade or reinstall from a specific ref:

```bash
uv tool install --force git+https://github.com/ipdelete/autotester.git@master
```

## Initialize a program

Inside the repository you want autotester to work on:

```bash
autotester init --program simplifier
```

Edit `program.md` before running. At minimum, set a real gate and metric:

```yaml
---
provider: github-copilot
model: gpt-5.5
thinking: medium
gate: |
  uv run pytest -q
metric: |
  python metric.py
---
```

Lower metric values are better.

## Run optimize mode

```bash
autotester run --tag simplify-001 --max-attempts 5
```

## Run bugfix mode

```bash
autotester init --program bug-finder --force
autotester run --tag bugfix-001 --max-attempts 5 --max-no-finding-attempts 3
```

Bugfix mode requires `mode: bugfix` in `program.md`; the bundled bug-finder
template already includes it.

## View history

```bash
autotester history
```

History is rendered from the ttasks SQLite ledger, not from `results.tsv`.
