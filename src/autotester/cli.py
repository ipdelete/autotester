"""Command line interface for the Python autotester rewrite."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .history import default_db_path, format_history, load_history
from .program import bundled_programs_dir, init_program
from .runner import RunOptions, run


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="autotester")
    sub = parser.add_subparsers(dest="command")

    init = sub.add_parser("init", help="copy a bundled program template to program.md")
    init.add_argument("--repo", default=".")
    init.add_argument("--program", default="simplifier")
    init.add_argument("--force", action="store_true")

    programs = sub.add_parser("programs", help="list bundled program templates")
    programs.set_defaults(command="programs")

    run_p = sub.add_parser("run", help="run autotester")
    run_p.add_argument("--repo", default=".")
    run_p.add_argument("--program")
    run_p.add_argument("--max-attempts", type=int, default=5)
    run_p.add_argument("--attempt-timeout", type=float, default=600.0)
    run_p.add_argument("--max-no-finding-attempts", type=int, default=3)
    run_p.add_argument("--allow-dirty", action="store_true")
    run_p.add_argument("--tag")
    run_p.add_argument("--model")
    run_p.add_argument("--thinking")
    run_p.add_argument("--db", type=Path)

    hist = sub.add_parser("history", help="render adjudication history from ttasks SQLiteStore")
    hist.add_argument("--repo", default=".")
    hist.add_argument("--db", type=Path)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    command = args.command or "run"
    try:
        if command == "init":
            path = init_program(Path(args.repo).resolve(), name=args.program, force=args.force)
            print(f"wrote {path}")
            return 0
        if command == "programs":
            for path in sorted(bundled_programs_dir().glob("*.md")):
                print(path.stem)
            return 0
        if command == "history":
            repo = Path(args.repo).resolve()
            db = args.db or default_db_path(repo)
            print(format_history(load_history(repo, db)), end="")
            return 0
        if command == "run":
            return run(
                RunOptions(
                    repo=Path(args.repo),
                    program=args.program,
                    max_attempts=args.max_attempts,
                    attempt_timeout=args.attempt_timeout,
                    max_no_finding_attempts=args.max_no_finding_attempts,
                    allow_dirty=args.allow_dirty,
                    tag=args.tag,
                    model=args.model,
                    thinking=args.thinking,
                    db=args.db,
                )
            )
        parser.error(f"unknown command {command!r}")
    except Exception as exc:
        print(f"autotester: error: {exc}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
