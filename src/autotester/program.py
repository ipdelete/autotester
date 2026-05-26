"""Program template and front-matter handling."""

from __future__ import annotations

import re
import shutil
from dataclasses import dataclass
from importlib.resources import files
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Program:
    path: Path
    front_matter: dict[str, Any]
    body: str


_SOURCE_BUNDLED = Path(__file__).resolve().parents[2] / "programs"


def bundled_programs_dir() -> Path:
    if _SOURCE_BUNDLED.exists():
        return _SOURCE_BUNDLED
    return Path(str(files("autotester") / "programs"))


def bundled_program_path(name: str = "simplifier") -> Path:
    candidate = bundled_programs_dir() / f"{name}.md"
    if not candidate.exists():
        names = ", ".join(sorted(path.stem for path in bundled_programs_dir().glob("*.md")))
        raise FileNotFoundError(f"unknown bundled program {name!r}; available: {names}")
    return candidate


def init_program(repo: Path, *, name: str = "simplifier", force: bool = False) -> Path:
    dest = repo / "program.md"
    if dest.exists() and not force:
        raise FileExistsError(f"{dest} already exists; pass --force to overwrite")
    shutil.copyfile(bundled_program_path(name), dest)
    return dest


def load_program(repo: Path, explicit: str | None = None) -> Program:
    path = Path(explicit) if explicit else repo / "program.md"
    if not path.is_absolute():
        path = repo / path
    text = path.read_text(encoding="utf-8")
    front_matter, body = parse_front_matter(text)
    return Program(path=path, front_matter=front_matter, body=body)


def parse_front_matter(text: str) -> tuple[dict[str, Any], str]:
    """Parse a small YAML-front-matter subset used by program templates."""
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---", 4)
    if end == -1:
        raise ValueError("front matter starts with --- but has no closing ---")
    raw = text[4:end]
    body_start = end + len("\n---")
    if text[body_start:body_start + 1] == "\n":
        body_start += 1
    return _parse_simple_yaml(raw), text[body_start:]


def _parse_simple_yaml(raw: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    lines = raw.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        i += 1
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$", line)
        if not match:
            raise ValueError(f"unsupported front matter line: {line!r}")
        key, value = match.group(1), match.group(2) or ""
        if value in {"|", ">"}:
            block: list[str] = []
            while i < len(lines):
                child = lines[i]
                if child.startswith("  ") or not child.strip():
                    block.append(child[2:] if child.startswith("  ") else "")
                    i += 1
                    continue
                break
            out[key] = "\n".join(block).rstrip() + "\n"
        else:
            out[key] = _coerce_scalar(value.strip())
    return out


def _coerce_scalar(value: str) -> Any:
    if value == "":
        return ""
    if value in {"true", "false"}:
        return value == "true"
    is_double_quoted = value.startswith('"') and value.endswith('"')
    is_single_quoted = value.startswith("'") and value.endswith("'")
    if is_double_quoted or is_single_quoted:
        return value[1:-1]
    try:
        if "." in value:
            return float(value)
        return int(value)
    except ValueError:
        return value


def require_str(front_matter: dict[str, Any], key: str) -> str:
    value = front_matter.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"program front matter must declare non-empty {key!r}")
    return value
