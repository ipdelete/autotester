#!/usr/bin/env python3
"""Mini Python autotester spike using ttasks idioms.

This is not a port. It is an architecture probe for optimize mode using the
same style as ttasks' live e2e tests:

- build explicit ``TaskGraph`` objects,
- save each graph to ``SQLiteStore`` before running it,
- run graphs through a store-backed ``TaskExecutor``,
- use task results as the data channel between graph execution and harness
  adjudication,
- collect lifecycle/output events from the executor,
- reopen the SQLite store and verify task/graph state roundtrips,
- use one long-lived ``CopilotAgentSession`` for all agent tasks.

The public autotester ledger remains ``results.tsv``. The rich execution ledger
is ``.autotester/ttasks.db``.

Run from this repo with local ttasks and the packaged Copilot SDK wheel:

    uv run --python 3.12 \
      --with 'ttasks @ file:///home/cip/src/ttasks' \
      --with github-copilot-sdk \
      python spikes/ttasks_mini_autotester.py
"""

from __future__ import annotations

import os
import shlex
import shutil
import sys
import tempfile
import textwrap
import time
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from ttasks import (
    CopilotAgentSession,
    SQLiteStore,
    Task,
    TaskEvent,
    TaskEventType,
    TaskExecutor,
    TaskGraph,
    TaskStatus,
    TaskType,
)

RESULTS_HEADER = "attempt\telapsed_s\tmetric\tstatus\tcommit\tdescription\n"


@dataclass(frozen=True)
class AttemptOutcome:
    attempt: int
    elapsed_s: int
    metric: float
    status: str
    commit: str
    description: str
    graph_id: str


def q(value: str | Path) -> str:
    """Shell-quote a path or string for trusted bash task payloads."""
    return shlex.quote(str(value))


def collect_events(executor: TaskExecutor) -> list[TaskEvent]:
    """Subscribe to executor events and return a list that accumulates them."""
    captured: list[TaskEvent] = []
    executor.events.subscribe(captured.append)
    return captured


def terminals_by_task(events: Iterable[TaskEvent]) -> dict[str, TaskEvent]:
    """Map task_id to its single terminal event."""
    terminal_types = {
        TaskEventType.SUCCEEDED,
        TaskEventType.FAILED,
        TaskEventType.CANCELLED,
        TaskEventType.BLOCKED,
    }
    out: dict[str, TaskEvent] = {}
    for event in events:
        if event.type in terminal_types:
            if event.task_id in out:
                raise RuntimeError(f"task {event.task_id} got multiple terminal events")
            out[event.task_id] = event
    return out


def task_output(task: Task) -> str:
    """Return a succeeded task's stdout/output, or raise with useful context."""
    if task.status is not TaskStatus.SUCCEEDED or task.result is None:
        raise RuntimeError(
            f"task {task.title!r} did not succeed: status={task.status.value} error={task.error!r}"
        )
    return task.result.output.strip()


def save_and_run(graph: TaskGraph, executor: TaskExecutor, store: SQLiteStore) -> TaskGraph:
    """Persist graph before execution, then run it through ttasks."""
    store.graphs.save(graph)
    return graph.run(executor, max_workers=1)


def assert_graph_ok(graph: TaskGraph) -> None:
    """Raise a compact error if the graph did not complete successfully."""
    if graph.ok:
        return
    statuses = {task.title: task.status.value for task in graph}
    errors = {task.title: task.error for task in graph if task.error}
    raise RuntimeError(f"graph {graph.title!r} not ok: statuses={statuses} errors={errors}")


def setup_graph(repo: Path) -> TaskGraph:
    """Create a passing scratch repo with a metric that can be improved."""
    setup = Task.bash(
        textwrap.dedent(
            f"""
            set -euo pipefail
            cd {q(repo)}
            git init
            git config user.email smoke@example.invalid
            git config user.name 'ttasks mini autotester'

            cat > string_utils.py <<'PY'
            '''Small string helpers.'''

            # TODO: this implementation is correct, but the surrounding comments are stale.
            def normalize_name(name: str) -> str:
                '''Normalize whitespace and title-case a display name.'''
                # TODO: remove this stale note once behavior is covered by tests.
                return " ".join(name.strip().split()).title()
            PY

            cat > test_string_utils.py <<'PY'
            import unittest

            from string_utils import normalize_name


            class StringUtilsTest(unittest.TestCase):
                def test_normalize_name(self):
                    self.assertEqual(normalize_name("  ada   lovelace "), "Ada Lovelace")


            if __name__ == "__main__":
                unittest.main()
            PY

            cat > README.md <<'MD'
            # Scratch string utils

            TODO: remove stale development notes while preserving behavior.
            MD

            cat > metric.py <<'PY'
            from pathlib import Path

            paths = [Path("string_utils.py"), Path("README.md")]
            print(sum(path.read_text().count("TODO") for path in paths))
            PY

            cat > .gitignore <<'GI'
            __pycache__/
            *.py[cod]
            .autotester/
            results.tsv
            GI

            git add .
            git commit -m 'Initial passing project with stale TODOs'
            """
        ).strip(),
        title="setup scratch optimize repo",
        timeout=60,
    )

    graph = TaskGraph(title="mini autotester setup")
    graph.add(setup)
    return graph


def baseline_graph(repo: Path, python: str) -> tuple[TaskGraph, dict[str, Task]]:
    """Baseline gate and metric graph."""
    gate = Task.bash(
        f"set -euo pipefail\ncd {q(repo)}\n{q(python)} -m unittest -q",
        title="baseline gate",
        timeout=60,
    )
    metric = Task.bash(
        f"set -euo pipefail\ncd {q(repo)}\n{q(python)} metric.py",
        title="baseline metric",
        timeout=60,
    )
    head = Task.bash(
        f"set -euo pipefail\ngit -C {q(repo)} rev-parse HEAD",
        title="baseline head",
        timeout=10,
    )

    graph = TaskGraph(title="mini autotester baseline")
    graph.add(gate)
    graph.add(metric, after=[gate])
    graph.add(head, after=[metric])
    return graph, {"gate": gate, "metric": metric, "head": head}


def attempt_prompt(best_metric: float, attempt: int) -> str:
    """Build the one-attempt optimize prompt."""
    return textwrap.dedent(
        f"""
        You are operating in a temporary git repository for an autotester architecture spike.

        Goal: make a small conservative improvement that lowers the metric while preserving behavior.

        Contract:
        - Gate command: `python -m unittest -q`
        - Metric command: `python metric.py`
        - Lower metric is better.
        - Current best metric: {best_metric}
        - You must edit only files relevant to lowering the metric.
        - You must run the gate and metric yourself before committing.
        - If you make a valid improvement, commit it.
        - If there is no safe improvement, do not commit.

        For this spike, inspect the project and remove stale TODO/development-note text without changing behavior.
        This is attempt {attempt}.
        """
    ).strip()


def attempt_graph(repo: Path, python: str, attempt: int, best_metric: float) -> tuple[TaskGraph, dict[str, Task]]:
    """One persisted attempt graph: before -> agent -> after -> gate -> metric."""
    before = Task.bash(
        f"set -euo pipefail\ngit -C {q(repo)} rev-parse HEAD",
        title=f"attempt {attempt} before head",
        timeout=10,
    )
    agent = Task.agent(
        attempt_prompt(best_metric, attempt),
        title=f"agent attempt {attempt}",
        timeout=600,
    )
    after = Task.bash(
        f"set -euo pipefail\ngit -C {q(repo)} rev-parse HEAD",
        title=f"attempt {attempt} after head",
        timeout=10,
    )
    gate = Task.bash(
        f"set -euo pipefail\ncd {q(repo)}\n{q(python)} -m unittest -q",
        title=f"gate attempt {attempt}",
        timeout=60,
    )
    metric = Task.bash(
        f"set -euo pipefail\ncd {q(repo)}\n{q(python)} metric.py",
        title=f"metric attempt {attempt}",
        timeout=60,
    )
    clean = Task.bash(
        f"set -euo pipefail\ntest -z \"$(git -C {q(repo)} status --short)\"",
        title=f"clean worktree attempt {attempt}",
        timeout=10,
    )

    graph = TaskGraph(title=f"mini autotester attempt {attempt}")
    graph.add(before)
    graph.add(agent, after=[before])
    graph.add(after, after=[agent])
    graph.add(gate, after=[after])
    graph.add(metric, after=[gate])
    graph.add(clean, after=[metric])
    return graph, {
        "before": before,
        "agent": agent,
        "after": after,
        "gate": gate,
        "metric": metric,
        "clean": clean,
    }


def reset_graph(repo: Path, commit: str, attempt: int) -> TaskGraph:
    """Persisted reset graph used by discard paths."""
    reset = Task.bash(
        f"set -euo pipefail\ngit -C {q(repo)} reset --hard {q(commit)}",
        title=f"reset attempt {attempt}",
        timeout=30,
    )
    graph = TaskGraph(title=f"mini autotester reset attempt {attempt}")
    graph.add(reset)
    return graph


def final_graph(repo: Path, python: str) -> tuple[TaskGraph, dict[str, Task]]:
    """Final validation graph after harness adjudication."""
    gate = Task.bash(
        f"set -euo pipefail\ncd {q(repo)}\n{q(python)} -m unittest -q",
        title="final gate",
        timeout=60,
    )
    metric = Task.bash(
        f"set -euo pipefail\ncd {q(repo)}\n{q(python)} metric.py",
        title="final metric",
        timeout=60,
    )
    log = Task.bash(
        f"set -euo pipefail\ngit -C {q(repo)} --no-pager log --oneline --decorate -5",
        title="final git log",
        timeout=10,
    )
    graph = TaskGraph(title="mini autotester final validation")
    graph.add(gate)
    graph.add(metric, after=[gate])
    graph.add(log, after=[metric])
    return graph, {"gate": gate, "metric": metric, "log": log}


def append_result(repo: Path, row: AttemptOutcome) -> None:
    """Append to the public autotester metric ledger."""
    path = repo / "results.tsv"
    if not path.exists():
        path.write_text(RESULTS_HEADER)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(
            f"{row.attempt}\t{row.elapsed_s}\t{row.metric}\t{row.status}\t"
            f"{row.commit}\t{row.description}\n"
        )


def adjudicate_attempt(
    *,
    repo: Path,
    store: SQLiteStore,
    executor: TaskExecutor,
    graph: TaskGraph,
    tasks: dict[str, Task],
    attempt: int,
    started: float,
    best_metric: float,
) -> AttemptOutcome:
    """Harness-owned keep/discard decision after ttasks graph execution."""
    elapsed_s = int(time.monotonic() - started)
    before = task_output(tasks["before"])
    after = task_output(tasks["after"]) if tasks["after"].status is TaskStatus.SUCCEEDED else before

    if after == before:
        return AttemptOutcome(
            attempt=attempt,
            elapsed_s=elapsed_s,
            metric=float("inf"),
            status="discard",
            commit=before[:12],
            description="no commit produced",
            graph_id=graph.id,
        )

    if not graph.ok:
        save_and_run(reset_graph(repo, before, attempt), executor, store)
        return AttemptOutcome(
            attempt=attempt,
            elapsed_s=elapsed_s,
            metric=float("inf"),
            status="discard",
            commit=before[:12],
            description="attempt graph failed",
            graph_id=graph.id,
        )

    metric = float(task_output(tasks["metric"]))
    if metric >= best_metric:
        save_and_run(reset_graph(repo, before, attempt), executor, store)
        return AttemptOutcome(
            attempt=attempt,
            elapsed_s=elapsed_s,
            metric=metric,
            status="discard",
            commit=before[:12],
            description="metric did not improve",
            graph_id=graph.id,
        )

    agent_lines = task_output(tasks["agent"]).splitlines()
    description = (agent_lines or ["improved metric"])[0].replace("\t", " ")
    return AttemptOutcome(
        attempt=attempt,
        elapsed_s=elapsed_s,
        metric=metric,
        status="keep",
        commit=after[:12],
        description=description,
        graph_id=graph.id,
    )


def print_run_summary(repo: Path, store: SQLiteStore, events: list[TaskEvent]) -> None:
    """Print public ledger, persisted graph ledger, and event sanity summary."""
    print("\n[results.tsv]")
    print((repo / "results.tsv").read_text(), end="")

    print("\n[ttasks store]")
    print(f"path: {store.path}")
    print(f"tasks: {len(store.tasks)}")
    print(f"graphs: {len(store.graphs)}")
    for graph_id in store.graphs:
        graph = store.graphs[graph_id]
        print(f"- graph {graph_id[:12]} ok={graph.ok} title={graph.title!r}")
        for task in graph:
            result = task.result
            duration = "?" if result is None else f"{result.duration:.2f}s"
            reason = "" if not (result and result.termination_reason) else f" reason={result.termination_reason}"
            print(f"    {task.status.value:9} {duration:>8} {task.title}{reason}")

    terminals = terminals_by_task(events)
    print("\n[events]")
    print(f"events: {len(events)}")
    print(f"terminal events: {len(terminals)}")


def assert_store_roundtrip(db: Path, graph_ids: Iterable[str]) -> None:
    """Reopen SQLite and verify persisted graph/task snapshots are usable."""
    reopened = SQLiteStore(db)
    for graph_id in graph_ids:
        graph = reopened.graphs[graph_id]
        for task in graph:
            persisted = reopened.tasks[task.id]
            if persisted.status != task.status:
                raise RuntimeError(f"persisted status mismatch for {task.title}")
            if (persisted.result is None) != (task.result is None):
                raise RuntimeError(f"persisted result presence mismatch for {task.title}")


def main() -> int:
    model = os.environ.get("TTASKS_SMOKE_MODEL", "gpt-5.5")
    reasoning = os.environ.get("TTASKS_SMOKE_REASONING", "medium")
    keep = os.environ.get("TTASKS_SMOKE_KEEP") == "1"
    max_attempts = int(os.environ.get("TTASKS_SMOKE_ATTEMPTS", "2"))

    repo = Path(tempfile.mkdtemp(prefix="ttasks-mini-autotester-"))
    db = repo / ".autotester" / "ttasks.db"
    db.parent.mkdir(parents=True, exist_ok=True)

    print(f"scratch repo: {repo}")
    print(f"model: {model}")
    print(f"reasoning_effort: {reasoning}")
    print(f"max_attempts: {max_attempts}")

    graph_ids: list[str] = []
    try:
        store = SQLiteStore(db)
        with CopilotAgentSession(
            model=model,
            reasoning_effort=reasoning,
            working_directory=str(repo),
        ) as agent:
            executor = TaskExecutor(store=store)
            events = collect_events(executor)
            executor.register(TaskType.AGENT, agent.handler())

            setup = setup_graph(repo)
            save_and_run(setup, executor, store)
            assert_graph_ok(setup)
            graph_ids.append(setup.id)

            baseline, baseline_tasks = baseline_graph(repo, sys.executable)
            save_and_run(baseline, executor, store)
            assert_graph_ok(baseline)
            graph_ids.append(baseline.id)

            best_metric = float(task_output(baseline_tasks["metric"]))
            baseline_head = task_output(baseline_tasks["head"])
            append_result(
                repo,
                AttemptOutcome(
                    attempt=0,
                    elapsed_s=0,
                    metric=best_metric,
                    status="baseline",
                    commit=baseline_head[:12],
                    description="baseline",
                    graph_id=baseline.id,
                ),
            )

            for attempt in range(1, max_attempts + 1):
                graph, tasks = attempt_graph(repo, sys.executable, attempt, best_metric)
                started = time.monotonic()
                save_and_run(graph, executor, store)
                graph_ids.append(graph.id)

                outcome = adjudicate_attempt(
                    repo=repo,
                    store=store,
                    executor=executor,
                    graph=graph,
                    tasks=tasks,
                    attempt=attempt,
                    started=started,
                    best_metric=best_metric,
                )
                append_result(repo, outcome)
                print(
                    f"[harness] attempt {attempt}: {outcome.status} "
                    f"metric={outcome.metric} graph={outcome.graph_id[:12]} {outcome.description}"
                )

                if outcome.status == "keep":
                    best_metric = outcome.metric
                if best_metric <= 0:
                    print("[harness] optimal metric reached")
                    break

            final, final_tasks = final_graph(repo, sys.executable)
            save_and_run(final, executor, store)
            assert_graph_ok(final)
            graph_ids.append(final.id)
            final_metric = float(task_output(final_tasks["metric"]))
            if final_metric != best_metric:
                raise RuntimeError(f"final metric {final_metric} != best metric {best_metric}")
            if best_metric >= 3:
                raise RuntimeError("agent never improved the metric")

            assert_store_roundtrip(db, graph_ids)
            print_run_summary(repo, store, events)

        print("\nPASS: ttasks-idiomatic mini autotester loop works")
        return 0
    finally:
        if keep:
            print(f"keeping scratch repo: {repo}")
        else:
            shutil.rmtree(repo, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
