"""ttasks graph builders for the Python rewrite."""

from __future__ import annotations

import json
import shlex
import time
from dataclasses import asdict, dataclass
from pathlib import Path

from ttasks import SQLiteStore, Task, TaskExecutor, TaskGraph, TaskStatus


def q(value: str | Path) -> str:
    return shlex.quote(str(value))


@dataclass(frozen=True)
class Adjudication:
    kind: str
    attempt: int
    status: str
    metric: float
    commit: str
    description: str
    elapsed_s: int
    graph_id: str


def task_output(task: Task) -> str:
    if task.status is not TaskStatus.SUCCEEDED or task.result is None:
        raise RuntimeError(
            f"task {task.title!r} did not succeed: status={task.status.value} error={task.error!r}"
        )
    return task.result.output.strip()


def save_and_run(graph: TaskGraph, executor: TaskExecutor, store: SQLiteStore) -> TaskGraph:
    store.graphs.save(graph)
    return graph.run(executor, max_workers=1)


def baseline_graph(
    repo: Path,
    gate: str,
    metric: str,
    timeout: float,
) -> tuple[TaskGraph, dict[str, Task]]:
    gate_task = Task.bash(
        f"set -euo pipefail\ncd {q(repo)}\n{gate}",
        title="baseline gate",
        timeout=timeout,
    )
    metric_task = Task.bash(
        f"set -euo pipefail\ncd {q(repo)}\n{metric}",
        title="baseline metric",
        timeout=timeout,
    )
    head_task = Task.bash(
        f"set -euo pipefail\ngit -C {q(repo)} rev-parse HEAD",
        title="baseline head",
        timeout=10,
    )
    graph = TaskGraph(title="autotester baseline")
    graph.add(gate_task)
    graph.add(metric_task, after=[gate_task])
    graph.add(head_task, after=[metric_task])
    return graph, {"gate": gate_task, "metric": metric_task, "head": head_task}


def attempt_graph(
    repo: Path,
    *,
    attempt: int,
    prompt: str,
    gate: str,
    metric: str,
    timeout: float,
) -> tuple[TaskGraph, dict[str, Task]]:
    before = Task.bash(
        f"set -euo pipefail\ngit -C {q(repo)} rev-parse HEAD",
        title=f"attempt {attempt} before head",
        timeout=10,
    )
    agent = Task.agent(prompt, title=f"agent attempt {attempt}", timeout=timeout)
    after = Task.bash(
        f"set -euo pipefail\ngit -C {q(repo)} rev-parse HEAD",
        title=f"attempt {attempt} after head",
        timeout=10,
    )
    gate_task = Task.bash(
        f"set -euo pipefail\ncd {q(repo)}\n{gate}",
        title=f"gate attempt {attempt}",
        timeout=timeout,
    )
    metric_task = Task.bash(
        f"set -euo pipefail\ncd {q(repo)}\n{metric}",
        title=f"metric attempt {attempt}",
        timeout=timeout,
    )
    clean = Task.bash(
        f"set -euo pipefail\ntest -z \"$(git -C {q(repo)} status --short --untracked-files=no)\"",
        title=f"clean tracked worktree attempt {attempt}",
        timeout=10,
    )
    graph = TaskGraph(title=f"autotester attempt {attempt}")
    graph.add(before)
    graph.add(agent, after=[before])
    graph.add(after, after=[agent])
    graph.add(gate_task, after=[after])
    graph.add(metric_task, after=[gate_task])
    graph.add(clean, after=[metric_task])
    return graph, {
        "before": before,
        "agent": agent,
        "after": after,
        "gate": gate_task,
        "metric": metric_task,
        "clean": clean,
    }


def reset_graph(repo: Path, commit: str, attempt: int) -> TaskGraph:
    reset = Task.bash(
        f"set -euo pipefail\ngit -C {q(repo)} reset --hard {q(commit)}",
        title=f"reset attempt {attempt}",
        timeout=30,
    )
    graph = TaskGraph(title=f"autotester reset attempt {attempt}")
    graph.add(reset)
    return graph


def adjudication_graph(adjudication: Adjudication) -> TaskGraph:
    payload = json.dumps(asdict(adjudication), sort_keys=True)
    record = Task.bash(
        f"printf '%s\n' {q(payload)}",
        title=f"adjudication {adjudication.kind} {adjudication.attempt}",
        timeout=10,
    )
    graph = TaskGraph(title=f"autotester adjudication {adjudication.kind} {adjudication.attempt}")
    graph.add(record)
    return graph


def parse_metric_output(output: str) -> float:
    text = output.strip()
    for line in reversed(text.splitlines()):
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("metric:"):
            stripped = stripped.split(":", 1)[1].strip()
        return float(stripped)
    raise ValueError("metric command produced no output")


def elapsed_since(start: float) -> int:
    return int(time.monotonic() - start)
