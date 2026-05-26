"""Optimize-mode autotester runner backed by ttasks."""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

from ttasks import (
    CopilotAgentSession,
    SQLiteStore,
    Task,
    TaskExecutor,
    TaskGraph,
    TaskStatus,
    TaskType,
)

from . import git
from .graphs import (
    Adjudication,
    adjudication_graph,
    attempt_graph,
    baseline_graph,
    elapsed_since,
    parse_metric_output,
    reset_graph,
    save_and_run,
    task_output,
)
from .history import default_db_path
from .program import load_program, require_str
from .prompt import attempt_prompt

DEFAULT_MODEL = "gpt-5.5"
DEFAULT_THINKING = "medium"
DEFAULT_ATTEMPT_TIMEOUT = 600.0
THINKING_LEVELS = {"low", "medium", "high", "xhigh"}


@dataclass(frozen=True)
class RunOptions:
    repo: Path
    program: str | None = None
    max_attempts: int = 5
    attempt_timeout: float = DEFAULT_ATTEMPT_TIMEOUT
    allow_dirty: bool = False
    tag: str | None = None
    model: str | None = None
    thinking: str | None = None
    db: Path | None = None


def run(options: RunOptions) -> int:
    repo = options.repo.resolve()
    if not git.is_git_repo(repo):
        raise RuntimeError(f"{repo} is not a git repository")

    program = load_program(repo, options.program)
    fm = program.front_matter
    mode = str(fm.get("mode", "optimize"))
    if mode != "optimize":
        raise RuntimeError("Python rewrite currently supports only mode: optimize")
    provider = str(fm.get("provider", "github-copilot"))
    if provider != "github-copilot":
        raise RuntimeError("Python rewrite currently supports only provider: github-copilot")
    gate = require_str(fm, "gate")
    metric = require_str(fm, "metric")
    model = options.model or str(fm.get("model", DEFAULT_MODEL))
    thinking = options.thinking or str(fm.get("thinking", DEFAULT_THINKING))
    if thinking not in THINKING_LEVELS:
        raise RuntimeError(
            f"invalid thinking level {thinking!r}; expected one of {sorted(THINKING_LEVELS)}"
        )

    if options.tag:
        branch = f"autotester/{options.tag}"
        if git.local_branch_exists(repo, branch):
            raise RuntimeError(f"branch {branch!r} already exists locally")
        if git.remote_branch_exists(repo, branch):
            raise RuntimeError(f"branch {branch!r} already exists on origin")
        if not options.allow_dirty and git.has_tracked_changes(repo):
            raise RuntimeError(f"{repo} has uncommitted tracked changes")
        git.create_branch(repo, branch)
    elif not options.allow_dirty and git.has_tracked_changes(repo):
        raise RuntimeError(f"{repo} has uncommitted tracked changes")

    db_path = options.db or default_db_path(repo)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    store = SQLiteStore(db_path)

    print(f"repo: {repo}")
    print(f"branch: {git.current_branch(repo)}")
    print(f"program: {program.path}")
    print(f"database: {db_path}")
    print(f"model: {model}")
    print(f"thinking: {thinking}")
    print(f"max attempts: {options.max_attempts}")

    with CopilotAgentSession(
        model=model,
        reasoning_effort=thinking,
        working_directory=str(repo),
    ) as agent:
        executor = TaskExecutor(store=store)
        executor.register(TaskType.AGENT, agent.handler())

        print("\n[harness] baseline...")
        baseline, baseline_tasks = baseline_graph(repo, gate, metric, options.attempt_timeout)
        save_and_run(baseline, executor, store)
        if not baseline.ok:
            raise RuntimeError(_graph_error("baseline failed", baseline))
        best_metric = parse_metric_output(task_output(baseline_tasks["metric"]))
        baseline_head = task_output(baseline_tasks["head"])
        _record(executor, store, Adjudication(
            kind="baseline",
            attempt=0,
            status="baseline",
            metric=best_metric,
            commit=baseline_head[:12],
            description=str(fm.get("baseline_description", "baseline")),
            elapsed_s=0,
            graph_id=baseline.id,
        ))
        print(f"[harness] baseline metric: {best_metric}")

        for attempt in range(1, options.max_attempts + 1):
            prompt = attempt_prompt(program, attempt=attempt, best_metric=best_metric)
            graph, tasks = attempt_graph(
                repo,
                attempt=attempt,
                prompt=prompt,
                gate=gate,
                metric=metric,
                timeout=options.attempt_timeout,
            )
            started = time.monotonic()
            save_and_run(graph, executor, store)
            outcome = _adjudicate(
                repo=repo,
                executor=executor,
                store=store,
                graph_id=graph.id,
                tasks=tasks,
                attempt=attempt,
                elapsed_s=elapsed_since(started),
                best_metric=best_metric,
            )
            _record(executor, store, outcome)
            print(
                f"[harness] attempt {attempt}: {outcome.status} "
                f"metric={outcome.metric:g} {outcome.description}"
            )
            if outcome.status == "keep":
                best_metric = outcome.metric

    return 0


def _adjudicate(
    *,
    repo: Path,
    executor: TaskExecutor,
    store: SQLiteStore,
    graph_id: str,
    tasks: dict[str, Task],
    attempt: int,
    elapsed_s: int,
    best_metric: float,
) -> Adjudication:
    before = task_output(tasks["before"])
    after = task_output(tasks["after"]) if tasks["after"].status is TaskStatus.SUCCEEDED else before
    if after == before:
        return Adjudication(
            "attempt", attempt, "discard", float("inf"), before[:12],
            "no commit produced", elapsed_s, graph_id,
        )
    if any(tasks[name].status is not TaskStatus.SUCCEEDED for name in ["gate", "metric", "clean"]):
        save_and_run(reset_graph(repo, before, attempt), executor, store)
        return Adjudication(
            "attempt", attempt, "discard", float("inf"), before[:12],
            "attempt graph failed", elapsed_s, graph_id,
        )
    value = parse_metric_output(task_output(tasks["metric"]))
    if value >= best_metric:
        save_and_run(reset_graph(repo, before, attempt), executor, store)
        return Adjudication(
            "attempt", attempt, "discard", value, before[:12],
            "metric did not improve", elapsed_s, graph_id,
        )
    description = (task_output(tasks["agent"]).splitlines() or ["improved metric"])[0]
    return Adjudication(
        "attempt", attempt, "keep", value, after[:12], description, elapsed_s, graph_id,
    )


def _record(executor: TaskExecutor, store: SQLiteStore, adjudication: Adjudication) -> None:
    graph = adjudication_graph(adjudication)
    save_and_run(graph, executor, store)
    if not graph.ok:
        raise RuntimeError(_graph_error("failed to record adjudication", graph))


def _graph_error(prefix: str, graph: TaskGraph) -> str:
    statuses = {task.title: task.status.value for task in graph}
    return f"{prefix}: {statuses}"
