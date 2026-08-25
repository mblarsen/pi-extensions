---
name: task-ui
description: Keeps the task-ui sidebar synchronized while coordinating multi-step work or external task backends. Use when the user asks to track tasks, when work has several meaningful steps, when backend tasks should be mirrored with task_ui_* presentation tools, or when a new session resumes work managed by a task backend.
---

# Task UI

Use the `task_ui_*` tools to maintain a truthful UI projection of work. These tools never plan, execute, coordinate, cancel, or inspect backend work themselves.

## When to track

Track work when:

- the user asks for task tracking
- the request has multiple meaningful steps whose state helps the user
- work is delegated to workers or an external task backend
- several tasks may run concurrently

Do not create a task list for a trivial single action.

## Start a task set

Prefer `task_ui_batch_create` when the initial set is known. Use `task_ui_create` for work discovered later.

Give each task:

- a concise outcome-oriented `subject`
- the backend task ID as `id` when mirroring a backend
- an optional short `label` when a meaningful category or workflow applies, such as `research` or `grilling`; do not add brackets
- `parent_id` when the task is a subtask
- `blocked_by` IDs for real dependencies
- `pending` status until work begins

Labels render right-aligned. The same label receives the same theme-derived color everywhere; omit the label rather than inventing a meaningless category.

Do not invent dependencies, progress, token counts, or backend IDs.

## Parent tasks and subtasks

Set `parent_id` to nest a task beneath an existing parent. Batch creation may include parents and their descendants together.

Parents remain independently executable tasks:

- a parent and its subtasks may execute concurrently
- parent status and progress are never derived from its children
- completing, failing, or stopping a parent does not change its children
- `blocked_by` expresses execution dependencies; `parent_id` expresses hierarchy only

Use `task_ui_update` with `parent_id: null` to detach a subtask and make it a root task. Pass an empty `label` to clear an existing label. Do not create parent cycles.

## Mirror execution

Before actively executing a task, call `task_ui_update` with:

```json
{
  "task_id": "backend-or-ui-id",
  "label": "verification",
  "status": "in_progress",
  "executing": true,
  "active_form": "Running regression tests…"
}
```

Use present-progress wording for `active_form`. Several tasks may be `in_progress` or `executing` concurrently.

Update `input_tokens`, `output_tokens`, and `started_at` only when reliable telemetry is available. Never estimate or fabricate telemetry.

If work remains in progress but is not currently executing, set `executing` to `false` and keep `status` as `in_progress`.

### Delegated and sub-agent work

When a sub-agent or backend worker starts actively working on a task, immediately mirror that execution with `task_ui_update`:

```json
{
  "task_id": "worker-task-id",
  "status": "in_progress",
  "executing": true,
  "active_form": "Implementing task hierarchy…"
}
```

This changes the static `◼` in-progress icon to the animated `✳`/`✽` spinner. Multiple delegated tasks may show spinners concurrently.

When the worker stops running but the task remains unfinished, set `executing: false` and leave it `in_progress`. When it completes, fails, requires input, or is canceled, clear `executing` while mirroring the confirmed backend state.

Spawning a sub-agent does not automatically update task-ui. The coordinating agent must call the backend tool and the matching `task_ui_update` separately.

## Finish or interrupt work

After successful completion, call `task_ui_update` with `status: "completed"`, `executing: false`, and `progress: 100`.

After failure, set `status: "failed"` and `executing: false`. Add concise diagnostic output with `task_ui_output` when useful.

To stop real backend work:

1. Cancel or stop it through the actual backend.
2. Confirm the backend action succeeded or report uncertainty.
3. Call `task_ui_stop` to move the projection into stopped history.

`task_ui_stop` alone never stops backend work.

Use `task_ui_remove` when one obsolete item should disappear from the projection. Its children become root tasks. Use `task_ui_clear` only when the user explicitly wants the entire projected list cleared. Neither tool changes or cancels backend work; perform any matching backend action separately.

## Read and resynchronize

Call `task_ui_get` without `task_id` to retrieve:

- every active task
- the next unblocked pending task
- the focused task

Call it with `task_id` for full details about one task. Use `task_ui_list` for full or status-filtered projection reads.

Use `task_ui_output` only for concise, user-relevant projected output. Do not stream large logs into the sidebar.

### New-session resynchronization

When a new Pi session resumes work managed by `ctx_task` or another persistent task backend:

1. Call `task_ui_list` to inspect the current projection; resumed Pi sessions may already contain UI state.
2. Query the backend with its `list` operation.
3. Treat backend IDs and states as authoritative.
4. Create missing projected tasks with `task_ui_create` or `task_ui_batch_create`.
5. Update existing projected tasks whose confirmed backend state changed.
6. Mirror only relevant active, pending, input-required, or recent terminal tasks; do not import an entire backend archive.

Never blindly batch-create backend tasks before reading task-ui, because duplicate IDs are rejected. Do not reset a restored projection merely because a new conversation turn began.

If no persistent backend is being used, do not invent one or attempt synchronization. A fresh UI-only session may correctly begin with no tasks.

## Backend coordination

When using `ctx_task` or another backend, perform each backend operation separately and then mirror the confirmed result with `task_ui_*`.

Keep backend state authoritative. If backend and projection disagree, read the backend first and update task-ui to match it.

### `ctx_task` synchronization

Mirror each confirmed backend mutation:

| Confirmed `ctx_task` action or state | Follow-up presentation call |
|---|---|
| `create` succeeds | `task_ui_create` using the returned task ID |
| state becomes `working` | `task_ui_update` with `status: "in_progress"`; set `executing` truthfully |
| state becomes `input-required` | `task_ui_update` with `status: "in_progress"` and `executing: false`; optionally append a concise input-needed note |
| state becomes `completed` | `task_ui_update` with `status: "completed"`, `executing: false`, and `progress: 100` |
| state becomes `failed` | `task_ui_update` with `status: "failed"` and `executing: false` |
| `cancel` succeeds or state becomes `canceled` | `task_ui_stop` with the confirmed reason |
| a user-relevant `message` arrives | optionally append a concise summary with `task_ui_output` |

Use `ctx_task get` or `ctx_task list` as authoritative reads. They do not require a presentation mutation unless they reveal that the projection is stale.

Do not copy large logs, private worker messages, or every backend message into `task_ui_output`.

If the backend mutation succeeds but its task-ui mirror fails, do not undo or repeat the backend mutation. Retry or repair only the presentation call.
