from __future__ import annotations

import argparse
import importlib.resources
from pathlib import Path


RESULTS_HEADER = "commit\tstatus\tcategory\tfiles_changed\ttests\tresult\tdescription\n"


def _program_text() -> str:
    return (
        importlib.resources.files("autotester")
        .joinpath("programs/autotester.md")
        .read_text(encoding="utf-8")
    )


def init_repo(force: bool = False, root: Path | None = None) -> None:
    root = root or Path.cwd()
    program_path = root / "program.md"
    results_path = root / "results.tsv"

    if program_path.exists() and not force:
        raise SystemExit("program.md already exists; pass --force to overwrite it")

    program_path.write_text(_program_text(), encoding="utf-8")
    if not results_path.exists():
        results_path.write_text(RESULTS_HEADER, encoding="utf-8")

    print(f"wrote {program_path}")
    if results_path.exists():
        print(f"initialized {results_path}")


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="autotester",
        description="Bootstrap agent-driven repository improvement loops.",
    )
    subparsers = parser.add_subparsers(dest="command")

    init_parser = subparsers.add_parser(
        "init",
        help="write program.md and results.tsv into the current repository",
    )
    init_parser.add_argument(
        "--force",
        action="store_true",
        help="overwrite an existing program.md",
    )

    subparsers.add_parser(
        "print-program",
        help="print the default autotester agent program",
    )

    args = parser.parse_args()

    if args.command == "init":
        init_repo(force=args.force)
    elif args.command == "print-program":
        print(_program_text(), end="")
    else:
        parser.print_help()
