# Programs

A program is a Markdown file with YAML-like front matter followed by natural
language instructions for the agent.

Repo-local programs are named:

```text
program.md
```

Create one from a bundled template:

```bash
autotester init --program simplifier
```

## Front matter

Common fields:

```yaml
---
provider: github-copilot
model: gpt-5.5
thinking: medium
mode: optimize
gate: |
  uv run pytest -q
metric: |
  python metric.py
baseline_description: initial baseline
---
```

Fields:

- `provider`: currently only `github-copilot` is supported.
- `model`: Copilot model passed to `CopilotAgentSession`.
- `thinking`: reasoning effort, one of `low`, `medium`, `high`, `xhigh`.
- `mode`: `optimize` or `bugfix`; omitted means `optimize`.
- `gate`: shell command that proves the repo still works.
- `metric`: optimize-mode shell command that prints a number. Lower is better.
- `baseline_description`: optional history description for attempt `0`.

Bugfix mode does not require `metric`; the harness supplies:

```text
metric = -verified_regression_fixes
```

## Body instructions

The Markdown body tells the agent what kinds of changes to make and avoid. The
harness appends its own contract to every prompt, but policy belongs in the
program where possible.

Good program bodies are specific about:

- what counts as an improvement,
- what files or APIs are sensitive,
- what changes are out of scope,
- when the agent should stop without committing.

## Bundled templates

Current templates:

- `simplifier`
- `type-tightener`
- `coverage-raiser`
- `doc-writer`
- `dep-pruner`
- `bug-finder`

List them with:

```bash
autotester programs
```
