# autotester

`autotester` is a Python/uv CLI for program-driven coding-agent loops backed by
[`ttasks`](https://github.com/ipdelete/ttasks) and the GitHub Copilot SDK.

It supports:

- **Optimize mode**: lower a metric while keeping a gate green.
- **Bugfix mode**: discover, test, fix, and prove one real bug at a time.

Run directly from GitHub:

```bash
uvx --from git+https://github.com/ipdelete/autotester.git autotester programs
```

Install as a persistent uv tool:

```bash
uv tool install git+https://github.com/ipdelete/autotester.git
```

Initialize a repo-local program:

```bash
autotester init --program simplifier
```

Run:

```bash
autotester run --tag simplify-001 --max-attempts 5
```

View history:

```bash
autotester history
```

## Documentation

User docs are published on GitHub Pages:

- [Quickstart](https://ipdelete.github.io/autotester/quickstart/)
- [Commands](https://ipdelete.github.io/autotester/commands/)
- [Programs](https://ipdelete.github.io/autotester/programs/)
- [Optimize mode](https://ipdelete.github.io/autotester/modes/optimize/)
- [Bugfix mode](https://ipdelete.github.io/autotester/modes/bugfix/)
- [Storage](https://ipdelete.github.io/autotester/storage/)

Build docs locally:

```bash
uv run mkdocs build --strict --site-dir site
```

## Development

```bash
uv sync --dev
uv run ruff check src/autotester tests
uv run pytest -q
uv run ty check src/autotester tests
```
