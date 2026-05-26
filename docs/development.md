# Development

## Install

```bash
uv sync --dev
```

Use a local ttasks checkout while iterating on both projects:

```bash
uv run --with 'ttasks @ file:///home/cip/src/ttasks' autotester programs
```

## Checks

```bash
uv run ruff check src/autotester tests
uv run pytest -q
uv run ty check src/autotester tests
```

## Build package

```bash
uv build
```

## Build docs

```bash
uv run mkdocs build --strict --site-dir site
```

Autotester is primarily a CLI. Unlike ttasks, it does not currently publish a
pdoc API reference.

## GitHub Pages

The docs are MkDocs Material docs. Publish the generated `site/` directory with
the repository's GitHub Pages workflow or with `mkdocs gh-deploy` if using a
local deploy flow.
