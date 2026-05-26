# Python autotester on ttasks: required ttasks surface

## Status as of ttasks v0.4.0

This ttasks surface has been implemented and released in `v0.4.0`.

- GitHub issue: https://github.com/ipdelete/ttasks/issues/44
- Merged PR: https://github.com/ipdelete/ttasks/pull/46
- Release tag: `v0.4.0`
- Follow-up extraction issue: https://github.com/ipdelete/ttasks/issues/45

Implemented ttasks changes:

- Added `ttasks.CopilotAgentSession` / `ttasks.copilot.CopilotAgentSession`.
- Kept the existing one-shot `make_copilot_agent_handler()` behavior unchanged.
- Added an opt-in shared-session handler via `CopilotAgentSession.handler()`.
- Added sync and async context-manager lifecycle.
- Added `send_and_wait(prompt, timeout=...)` for direct async use.
- Added `on_event=` and `.on(handler)` event subscription support.
- Forwarded `model`, `reasoning_effort`, `working_directory`, and generic
  `**session_options` into `CopilotClient.create_session(...)`.
- Serialized synchronous handler turns through the shared session so graph
  execution with multiple workers cannot overlap turns on one Copilot session.
- Added cancellation handling that cancels the in-flight future and calls
  `CopilotSession.abort()` when the SDK session supports it.
- Added fake-SDK unit tests and a live graph smoke test demonstrating a
  multi-turn shared Copilot session.

Validation at merge time:

- `uv run pytest -q` passed with 100% non-live coverage.
- `uv run ruff check .` passed.
- Live tests, including the shared-session graph test, passed separately.

The remaining follow-up is issue #45: extract built-in task handlers from
`TaskExecutor` into their own handler modules/objects later. That was
intentionally not included in `v0.4.0`.

## Corrected direction

The goal is not for autotester to recreate Copilot/Pi tools in Python.

The goal is:

```text
autotester becomes a Python program built on ttasks

ttasks:
  - represents attempts, validation steps, cleanup, repair turns as Task/TaskGraph
  - executes bash/python/etc
  - executes Copilot AGENT tasks

copilot-sdk:
  - provides built-in agent tools
  - handles file edit/read/shell behavior
  - maintains session state
```

So the missing piece is not custom SDK tools. The missing piece is:

> Multiple `Task.agent(...)` executions should be able to share the same long-lived `CopilotSession`.

## Original ttasks limitation

Before `v0.4.0`, `Task.agent()` went through `make_copilot_agent_handler()`,
which ultimately did roughly:

```python
async with CopilotClient() as client:
    async with await client.create_session(...) as session:
        response = await session.send_and_wait(context.payload)
```

That meant each AGENT task got a fresh Copilot client/session.

That limitation is now resolved for callers that opt into
`CopilotAgentSession`. The default handler still uses the original one-shot
behavior.

For autotester we want:

```text
attempt 1 agent task -> same Copilot session
harness validates
attempt 2 agent task -> same Copilot session
repair turn agent task -> same Copilot session
...
```

## Implemented ttasks API shape

ttasks now uses a session-backed handler object rather than making every
`Task.agent()` carry session details.

Example API:

```python
from ttasks import Task, TaskExecutor, TaskType
from ttasks.copilot import CopilotAgentSession

with CopilotAgentSession(
    model="gpt-5.5",
    reasoning_effort="medium",
    working_directory="/path/to/repo",
    # plus passthrough copilot-sdk create_session options
) as session:
    executor = TaskExecutor.empty()
    executor.register(TaskType.AGENT, session.handler())

    executor.execute(Task.agent("Attempt 1..."))
    executor.execute(Task.agent("Attempt 2..."))
```

`Task.agent("...")` remains a simple work declaration. Runtime/session policy lives in the registered handler.

This matches ttasks' existing model:

```text
Task = domain object
TaskExecutor/handler = runtime behavior
```

## Implemented ttasks surface

### 1. Long-lived `CopilotAgentSession`

Implemented shape:

```python
class CopilotAgentSession:
    def __init__(
        self,
        *,
        model: str = DEFAULT_COPILOT_AGENT_MODEL,
        reasoning_effort: str | None = None,
        working_directory: str | None = None,
        timeout: float | None = None,
        on_event: Callable[[SessionEvent], None] | None = None,
        **session_options: Any,
    ): ...

    def __enter__(self) -> CopilotAgentSession: ...
    def __exit__(self, exc_type, exc, tb) -> None: ...

    async def __aenter__(self) -> CopilotAgentSession: ...
    async def __aexit__(self, exc_type, exc, tb) -> None: ...

    async def send_and_wait(
        self,
        prompt: str,
        *,
        timeout: float | None = None,
    ) -> str: ...

    def on(self, handler: Callable[[SessionEvent], None]) -> Callable[[], None]: ...

    def handler(self) -> TaskHandler: ...
```

The important parts are:

- one `CopilotClient`,
- one `CopilotSession`,
- many `send_and_wait()` calls,
- context-manager lifecycle,
- `handler()` for `TaskExecutor.register(TaskType.AGENT, ...)`.

### 2. Pass-through Copilot session options

`CopilotAgentSession` passes through the important
`CopilotClient.create_session(...)` options.

At minimum:

```python
model: str
reasoning_effort: Literal["low", "medium", "high", "xhigh"] | None
working_directory: str | None
```

And preferably broad passthrough for advanced use:

```python
available_tools: list[str] | None = None
excluded_tools: list[str] | None = None
system_message: SystemMessageConfig | None = None
streaming: bool | None = True
include_sub_agent_streaming_events: bool | None = True
enable_config_discovery: bool | None = None
skill_directories: list[str] | None = None
instruction_directories: list[str] | None = None
mcp_servers: dict[str, MCPServerConfig] | None = None
agent: str | None = None
default_agent: DefaultAgentConfig | dict[str, Any] | None = None
custom_agents: list[CustomAgentConfig] | None = None
```

Do not over-design this. The simplest useful pattern may be:

```python
CopilotAgentSession(
    model="gpt-5.5",
    reasoning_effort="medium",
    working_directory=repo,
    **session_options,
)
```

### 3. Shared-session `Task.agent` handler

`CopilotAgentSession.handler()` returns a synchronous `TaskHandler` usable by
`TaskExecutor`:

```python
executor = TaskExecutor.empty()
executor.register(TaskType.AGENT, session.handler())
executor.execute(Task.agent(prompt))
```

Because `TaskExecutor` is synchronous today, this uses a sync bridge around the
async Copilot session.

Implementation approach:

- run an asyncio event loop in a background thread,
- create `CopilotClient` and `CopilotSession` in that loop,
- `handler(context)` submits `session.send_and_wait(context.payload)` via `asyncio.run_coroutine_threadsafe`,
- wait for the future while observing task cancellation,
- abort the active SDK turn on cancellation when supported,
- close session/client/loop in `close()` / `__exit__`.

This keeps sync `TaskExecutor` ergonomic while preserving a long-lived async session internally.

### 4. Event subscription

Autotester wants to print progress, e.g. assistant deltas and tool activity.

`CopilotSession` already has:

```python
session.on(handler) -> unsubscribe
```

`CopilotAgentSession` exposes this:

```python
unsubscribe = session.on(lambda event: ...)
```

or accept:

```python
CopilotAgentSession(on_event=...)
```

For autotester, the initial requirement is just enough to print useful progress and diagnose prompt/session failures. The task handler can still return assistant text.

### 5. Lifecycle cleanup

Must support deterministic cleanup:

```python
with CopilotAgentSession(...) as session:
    ...
# session closed here
```

and async equivalent:

```python
async with CopilotAgentSession(...) as session:
    ...
```

This is important for long overnight runs and for tests.

## What autotester would do with this

A Python autotester runner could look like:

```python
from ttasks import Task, TaskExecutor, TaskType
from ttasks.copilot import CopilotAgentSession

with CopilotAgentSession(
    model=program.model,
    reasoning_effort=program.thinking,
    working_directory=repo,
    on_event=print_event,
) as agent:
    executor = TaskExecutor.empty()
    executor.register(TaskType.AGENT, agent.handler())

    for attempt in range(1, max_attempts + 1):
        before = git_head(repo)
        executor.execute(Task.agent(build_attempt_prompt(...)))
        after = git_head(repo)

        # Python harness validates gate/metric or bugfix proof,
        # writes results.tsv, resets or keeps, etc.
```

No custom Copilot SDK tools are required. Copilot SDK's built-in tools handle repo read/edit/bash/etc in the configured `working_directory`.

## Do we need TaskGraph for autotester?

Not at first.

A Python autotester can use plain Python control flow for the main loop and use `Task.agent` via `TaskExecutor` for agent turns.

Later, bugfix validation could be represented as a `TaskGraph`:

```text
create parent worktree
create child worktree
run parent repro
run child repro
run targeted test
run full gate
cleanup parent worktree (finally)
cleanup child worktree (finally)
```

But that is optional. The first useful port only needs shared agent sessions.

## Implemented smoke test

The live smoke test does not define custom tools. It tests shared session +
built-in Copilot agent behavior through a `TaskGraph`.

Example:

```python
from ttasks import Task, TaskExecutor, TaskType
from ttasks.copilot import CopilotAgentSession

with CopilotAgentSession(
    model="gpt-5.5",
    reasoning_effort="medium",
    working_directory=scratch_repo,
) as session:
    executor = TaskExecutor.empty()
    executor.register(TaskType.AGENT, session.handler())

    executor.execute(Task.agent(
        "Create file a.txt containing 'one'. Commit it. Remember the code word is blue-sparrow."
    ))
    executor.execute(Task.agent(
        "Create memory.txt containing the code word I gave you earlier. Commit it."
    ))
```

Then verify:

```bash
git log --oneline
cat a.txt
cat memory.txt
```

If `memory.txt` contains `blue-sparrow`, the two tasks shared conversational session state. Even without that memory check, the repo-edit/commit behavior proves the built-in agent tools are usable in the configured cwd.

## Completed ttasks implementation order

1. Added `CopilotAgentSession` async context manager.
2. Added sync context manager with background event loop.
3. Added `.handler()` returning a `TaskHandler` so `Task.agent` tasks share the session.
4. Forwarded `model`, `reasoning_effort`, `working_directory`, and generic session options.
5. Exposed `.on(handler)` / `on_event`.
6. Added unit tests with fake `CopilotClient` / fake session.
7. Added one live/e2e graph test marked `live`.

## Non-goals for the first ttasks change

- Do not add custom autotester tools to ttasks.
- Do not make `Task.agent()` take every Copilot option directly.
- Do not port autotester yet.
- Do not require TaskGraph for the first proof.
- Do not replace existing one-shot `make_copilot_agent_handler()` behavior.

These non-goals were preserved in `v0.4.0`.

## Bottom line

A Python autotester on top of ttasks is viable because ttasks now has the core
primitive:

```text
long-lived CopilotAgentSession + handler() for shared-session Task.agent execution
```

The Copilot SDK already had the underlying primitives. ttasks now surfaces them
in a way that fits its existing `Task`/`TaskExecutor` model.
