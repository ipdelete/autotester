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
from .bugfix import parse_attempt_manifest, validate_bugfix_attempt
from .graphs import (
    Adjudication,
    adjudication_graph,
    attempt_graph,
    baseline_graph,
    bugfix_attempt_graph,
    elapsed_since,
    parse_metric_output,
    reset_graph,
    save_and_run,
    task_output,
)
from .history import default_db_path
from .program import Program, load_program, require_str
from .prompt import attempt_prompt, bugfix_prompt

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
    max_no_finding_attempts: int = 3
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
    if mode not in {"optimize", "bugfix"}:
        raise RuntimeError("mode must be 'optimize' or 'bugfix'")
    provider = str(fm.get("provider", "github-copilot"))
    if provider != "github-copilot":
        raise RuntimeError("Python rewrite currently supports only provider: github-copilot")
    gate = require_str(fm, "gate")
    metric = require_str(fm, "metric") if mode == "optimize" else "printf '0\\n'"
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
    print(f"mode: {mode}")
    print(f"max attempts: {options.max_attempts}")
    if mode == "bugfix":
        print(f"max no-finding attempts: {options.max_no_finding_attempts}")

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

        verified_fixes = 0
        consecutive_no_finding = 0
        prior_failures: list[str] = []
        for attempt in range(1, options.max_attempts + 1):
            if mode == "bugfix":
                outcome = _run_bugfix_attempt(
                    repo=repo,
                    program=program,
                    executor=executor,
                    store=store,
                    gate=gate,
                    attempt=attempt,
                    verified_fixes=verified_fixes,
                    timeout=options.attempt_timeout,
                    prior_failures=prior_failures,
                )
                if outcome.status == "keep":
                    verified_fixes += 1
                    best_metric = outcome.metric
                    consecutive_no_finding = 0
                    prior_failures = []
                elif outcome.description == "no finding produced":
                    consecutive_no_finding += 1
                    prior_failures = _record_prior_failure(prior_failures, outcome.description)
                    if consecutive_no_finding >= options.max_no_finding_attempts:
                        _record(executor, store, outcome)
                        print(
                            f"[harness] attempt {attempt}: {outcome.status} "
                            f"metric={outcome.metric:g} {outcome.description}"
                        )
                        print("[harness] stopping: no-finding budget exhausted")
                        break
                else:
                    consecutive_no_finding = 0
                    prior_failures = _record_prior_failure(prior_failures, outcome.description)
            else:
                outcome = _run_optimize_attempt(
                    repo=repo,
                    program=program,
                    executor=executor,
                    store=store,
                    gate=gate,
                    metric=metric,
                    attempt=attempt,
                    best_metric=best_metric,
                    timeout=options.attempt_timeout,
                )
                if outcome.status == "keep":
                    best_metric = outcome.metric
            _record(executor, store, outcome)
            print(
                f"[harness] attempt {attempt}: {outcome.status} "
                f"metric={outcome.metric:g} {outcome.description}"
            )

    return 0


def _run_optimize_attempt(
    *,
    repo: Path,
    program: Program,
    executor: TaskExecutor,
    store: SQLiteStore,
    gate: str,
    metric: str,
    attempt: int,
    best_metric: float,
    timeout: float,
) -> Adjudication:
    prompt = attempt_prompt(program, attempt=attempt, best_metric=best_metric)
    graph, tasks = attempt_graph(
        repo,
        attempt=attempt,
        prompt=prompt,
        gate=gate,
        metric=metric,
        timeout=timeout,
    )
    started = time.monotonic()
    save_and_run(graph, executor, store)
    return _adjudicate_optimize(
        repo=repo,
        executor=executor,
        store=store,
        graph_id=graph.id,
        tasks=tasks,
        attempt=attempt,
        elapsed_s=elapsed_since(started),
        best_metric=best_metric,
    )


PRIOR_FAILURE_WINDOW = 3


def _record_prior_failure(prior: list[str], description: str) -> list[str]:
    """Append ``description`` to the recent-failure window, capped at PRIOR_FAILURE_WINDOW."""
    return [*prior, description][-PRIOR_FAILURE_WINDOW:]


def _run_bugfix_attempt(
    *,
    repo: Path,
    program: Program,
    executor: TaskExecutor,
    store: SQLiteStore,
    gate: str,
    attempt: int,
    verified_fixes: int,
    timeout: float,
    prior_failures: list[str] | None = None,
) -> Adjudication:
    prompt = bugfix_prompt(
        program,
        attempt=attempt,
        verified_fixes=verified_fixes,
        prior_failures=prior_failures,
    )
    graph, tasks = bugfix_attempt_graph(repo, attempt=attempt, prompt=prompt, timeout=timeout)
    started = time.monotonic()
    save_and_run(graph, executor, store)
    elapsed_s = elapsed_since(started)
    before = task_output(tasks["before"])
    after = task_output(tasks["after"]) if tasks["after"].status is TaskStatus.SUCCEEDED else before
    if after == before:
        return Adjudication(
            "attempt", attempt, "discard", float("inf"), before[:12],
            "no finding produced", elapsed_s, graph.id,
        )
    if tasks["clean"].status is not TaskStatus.SUCCEEDED:
        save_and_run(reset_graph(repo, before, attempt), executor, store)
        return Adjudication(
            "attempt", attempt, "discard", float("inf"), before[:12],
            "attempt graph failed", elapsed_s, graph.id,
        )
    try:
        manifest = parse_attempt_manifest(task_output(tasks["agent"]))
        validation = validate_bugfix_attempt(
            repo=repo,
            store=store,
            executor=executor,
            before=before,
            after=after,
            attempt=attempt,
            gate=gate,
            manifest=manifest,
            timeout=timeout,
        )
    except Exception as exc:
        save_and_run(reset_graph(repo, before, attempt), executor, store)
        return Adjudication(
            "attempt", attempt, "discard", float("inf"), before[:12],
            f"bugfix validation failed: {exc}", elapsed_s, graph.id,
        )
    if not validation.ok:
        save_and_run(reset_graph(repo, before, attempt), executor, store)
        if validation.failed_stage:
            reason = f"bugfix validation failed at: {validation.failed_stage}"
            if validation.failure_detail:
                reason += f" — {validation.failure_detail}"
        else:
            reason = "bugfix validation graph failed"
        return Adjudication(
            "attempt", attempt, "discard", float("inf"), before[:12],
            reason, elapsed_s, validation.graph_id or graph.id,
        )
    metric = -(verified_fixes + 1)
    return Adjudication(
        "attempt", attempt, "keep", float(metric), after[:12],
        validation.description, elapsed_s, validation.graph_id or graph.id,
    )


def _adjudicate_optimize(
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
