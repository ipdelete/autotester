"""Prompt construction for optimize-mode attempts."""

from __future__ import annotations

from textwrap import dedent

from .program import Program


def attempt_prompt(program: Program, *, attempt: int, best_metric: float) -> str:
    return dedent(
        f"""
        You are running inside autotester. Make exactly one focused committed improvement.

        Harness contract:
        - The harness owns gate/metric validation and keep/discard decisions.
        - Lower metric is better.
        - Current best metric: {best_metric}
        - This is attempt {attempt}.
        - Commit a change only if it is safe and focused.
        - If no safe improvement remains, do not commit.
        - Do not edit autotester's task database or run history.

        Program instructions from {program.path}:

        {program.body.strip()}
        """
    ).strip()


def bugfix_prompt(program: Program, *, attempt: int, verified_fixes: int) -> str:
    return dedent(
        f"""
        You are running inside autotester bugfix mode. Find exactly one real bug,
        add a regression test, fix it, commit once, return a JSON manifest, and stop.

        Harness contract:
        - The harness validates the commit in detached parent/child worktrees.
        - Parent repro must fail on the pre-fix commit.
        - Child repro, targeted test, and full gate must pass on the new commit.
        - Metric is -verified_regression_fixes; current verified fixes: {verified_fixes}.
        - This is attempt {attempt}.
        - If you cannot find a concrete reproducible bug, do not commit.
        - After committing, make your final response include exactly one JSON object
          with description, repro_command, test_command, test_files, fix_files, and
          optional parent_failure_pattern.
        - Do not write .autotester/attempt.json; the harness reads the manifest from
          your persisted assistant output.
        - Do not edit autotester's task database or run history.

        Program instructions from {program.path}:

        {program.body.strip()}
        """
    ).strip()
