"""History rendering from ttasks SQLiteStore adjudication tasks."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from ttasks import SQLiteStore

from .git import git_path


@dataclass(frozen=True)
class HistoryRow:
    attempt: int
    elapsed_s: int
    metric: float
    status: str
    commit: str
    description: str
    graph_id: str


def default_db_path(repo: Path) -> Path:
    path = git_path(repo, "autotester/ttasks.db")
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def load_history(repo: Path, db: Path | None = None) -> list[HistoryRow]:
    path = db or default_db_path(repo)
    if not path.exists():
        return []
    store = SQLiteStore(path)
    rows: list[HistoryRow] = []
    for graph_id in store.graphs:
        graph = store.graphs[graph_id]
        if not graph.title.startswith("autotester adjudication "):
            continue
        for task in graph:
            if task.result is None or not task.result.output.strip():
                continue
            data = json.loads(task.result.output)
            rows.append(
                HistoryRow(
                    attempt=int(data["attempt"]),
                    elapsed_s=int(data["elapsed_s"]),
                    metric=float(data["metric"]),
                    status=str(data["status"]),
                    commit=str(data["commit"]),
                    description=str(data["description"]),
                    graph_id=str(data["graph_id"]),
                )
            )
    return sorted(rows, key=lambda row: (row.attempt, row.status != "baseline"))


def format_history(rows: list[HistoryRow]) -> str:
    header = "attempt\telapsed_s\tmetric\tstatus\tcommit\tgraph\tdescription"
    lines = [header]
    for row in rows:
        lines.append(
            f"{row.attempt}\t{row.elapsed_s}\t{row.metric:g}\t{row.status}\t"
            f"{row.commit}\t{row.graph_id[:12]}\t{row.description}"
        )
    return "\n".join(lines) + "\n"
