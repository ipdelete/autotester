from pathlib import Path

from autotester.program import Program
from autotester.prompt import bugfix_prompt


def _program(tmp_path: Path) -> Program:
    return Program(
        path=tmp_path / "program.md",
        front_matter={"mode": "bugfix"},
        body="# probe\n\nLook for bugs in the parser.",
    )


def test_bugfix_prompt_omits_prior_failures_block_by_default(tmp_path: Path):
    program = _program(tmp_path)
    rendered = bugfix_prompt(program, attempt=1, verified_fixes=0)
    assert "Recent attempt failures" not in rendered
    assert "current verified fixes: 0" in rendered


def test_bugfix_prompt_includes_prior_failures(tmp_path: Path):
    program = _program(tmp_path)
    rendered = bugfix_prompt(
        program,
        attempt=4,
        verified_fixes=0,
        prior_failures=[
            "bugfix validation failed at: parent repro fails",
            "bugfix validation failed at: parent repro fails",
            "no finding produced",
        ],
    )
    assert "Recent attempt failures" in rendered
    assert "parent repro fails" in rendered
    assert "no finding produced" in rendered
    assert "behavior that is already correct on baseline" in rendered


def test_bugfix_prompt_empty_prior_failures_treated_as_none(tmp_path: Path):
    program = _program(tmp_path)
    rendered = bugfix_prompt(program, attempt=2, verified_fixes=1, prior_failures=[])
    assert "Recent attempt failures" not in rendered
