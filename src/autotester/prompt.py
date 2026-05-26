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
