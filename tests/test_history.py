from pathlib import Path

from ttasks import SQLiteStore, TaskExecutor

from autotester.graphs import Adjudication, adjudication_graph, save_and_run
from autotester.history import format_history, load_history


def test_history_loads_adjudication_tasks(tmp_path: Path):
    db = tmp_path / "ttasks.db"
    store = SQLiteStore(db)
    executor = TaskExecutor(store=store)

    save_and_run(
        adjudication_graph(
            Adjudication(
                kind="baseline",
                attempt=0,
                status="baseline",
                metric=3.0,
                commit="abc123",
                description="baseline",
                elapsed_s=0,
                graph_id="graph-baseline",
            )
        ),
        executor,
        store,
    )
    save_and_run(
        adjudication_graph(
            Adjudication(
                kind="attempt",
                attempt=1,
                status="keep",
                metric=1.0,
                commit="def456",
                description="improved",
                elapsed_s=12,
                graph_id="graph-attempt",
            )
        ),
        executor,
        store,
    )

    rows = load_history(tmp_path, db)

    assert [row.status for row in rows] == ["baseline", "keep"]
    assert rows[1].metric == 1.0
    assert "attempt\telapsed_s\tmetric" in format_history(rows)
    assert "1\t12\t1\tkeep\tdef456" in format_history(rows)
