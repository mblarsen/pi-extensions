---
name: task-ui
description: Keeps the task-ui sidebar synchronized while coordinating multi-step work or external task backends. Use when the user asks to track tasks, when work has several meaningful steps, when backend tasks should be mirrored with task_ui_* presentation tools, or when a new session resumes work managed by a task backend.
---

# Task UI

Use the `task_ui_*` tools to maintain a truthful UI projection of work. These tools never plan, execute, coordinate, cancel, or inspect backend work themselves.

## Inbox: always send the normal response

Use `task_ui_inbox` when an important answer, takeaway, question, or decision must remain visible to the user.

Always do both actions:

1. Send the complete user-facing response in normal chat.
2. Call `task_ui_inbox` with a concise summary or the exact question.

The Inbox entry can differ from the normal response. It supplements the response and never replaces it.

Use `kind: "info"` for a concise, self-contained takeaway. Use `kind: "feedback_needed"` for the exact question or decision that needs a user response.

Inbox Markdown has a 400-character source limit. Link an entry to a projected task with `task_id` when the relationship helps the user.

The Inbox keeps the newest 10 informational entries. It keeps unresolved feedback until the agent resolves it. The tool rejects feedback entry 21. Clean obsolete or duplicate feedback before you retry. Never discard an unanswered request only to make space.

After the user answers, resolve the related entry:

```ts
task_ui_inbox({ operation: "resolve", entry_id: "inbox-3" })
```

`clear` removes informational entries only. It never removes unresolved feedback.

Do not create an Inbox entry for:

- a routine acknowledgment
- an internal agent or worker message
- a routine progress update already visible in the task list
- a terminal completion summary
- a duplicate of an unresolved entry

### Inbox workflow examples

For an informational answer while work continues, send the answer first:

```text
The API accepts one active cursor per session. I will use separate sessions for the two imports and continue the implementation.
```

Then add the takeaway and continue work:

```ts
task_ui_inbox({
  operation: "add",
  kind: "info",
  markdown: "The API permits one active cursor per session. Separate sessions are required for concurrent imports.",
  task_id: "imports",
})
```

For a non-blocking feedback request, ask the user in normal chat. State which independent work will continue. Then add the exact question:

```ts
task_ui_inbox({
  operation: "add",
  kind: "feedback_needed",
  markdown: "Should the export include archived records?",
  task_id: "export",
})
```

Continue unrelated work. Do not treat the Inbox operation as a user response.

When a sub-agent needs user input, the coordinating agent must relay the question in normal chat. The coordinating agent must also add the feedback entry. Do not copy an internal worker message without user context.

When work stops but a timer or heartbeat continues monitoring, send the normal status response first. Add an important takeaway if one must remain visible. Then start or keep the timer or heartbeat. The Inbox call does not replace the status response or the monitoring tool.

After the user answers a feedback question, continue the normal conversation and remove the entry:

```ts
task_ui_inbox({ operation: "resolve", entry_id: "inbox-4" })
```

Use `task_ui_inbox({ operation: "list" })` to inspect all entries. Add `kind` to list only informational or feedback entries.

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
- an optional `description` when context will help the user or a later agent turn recall the work
- the backend task ID as `id` when mirroring a backend
- an optional short `label` when a meaningful category or workflow applies, such as `research` or `grilling`; do not add brackets
- `parent_id` when the task is a subtask
- `blocked_by` IDs for real dependencies
- `pending` status until work begins

A description supplements the subject. Do not repeat the task title in the description. Omit the description for trivial tasks or when no confirmed context is available.

The sidebar shows descriptions only for executing `in_progress` tasks. It selects up to three descriptions in depth-first display order and skips tasks without descriptions. Users can press `d` in browse mode to read the complete selected-task description.

Labels render right-aligned. The same label receives the same theme-derived color everywhere; omit the label rather than inventing a meaningless category.

Do not invent descriptions, dependencies, progress, token counts, or backend IDs.

## Task descriptions

Add a description when the subject alone does not contain enough context to resume the task.

Write one short plain-text paragraph for both the user and a future agent. Include the intended outcome and only the essential context, constraints, or decisions needed to continue.

Do not use Markdown, lists, logs, progress updates, or unnecessary line breaks. Do not repeat the subject, status, owner, or dependencies.

For example:

```text
Generate a human-readable snapshot of all projected tasks. Preserve hierarchy and link each declared dependency to its task heading.
```

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

## Checkpoint reminders

The extension can send a hidden task-ui checkpoint reminder after a successful `git commit` or `link_send` tool call.

When you receive this reminder:

1. Compare the projection with the actual work state.
2. Update affected task status, progress, and execution state.
3. Add newly discovered work only when it is meaningful.
4. Do not mark work complete only because the checkpoint succeeded.
5. If you change task-ui, mention the change in your next natural status update.
6. Resume the current work without waiting for confirmation.

If the projection is accurate, do not change it.

## Finish or interrupt work

After successful completion, call `task_ui_update` with `status: "completed"`, `executing: false`, and `progress: 100`.

After failure, set `status: "failed"` and `executing: false`. Add concise diagnostic output with `task_ui_output` when useful.

To stop real backend work:

1. Cancel or stop it through the actual backend.
2. Confirm the backend action succeeded or report uncertainty.
3. Call `task_ui_stop` to move the projection into stopped history.

`task_ui_stop` alone never stops backend work.

Use `task_ui_remove` when one obsolete item should disappear from the projection. Its children become root tasks. Use `task_ui_clear` only when the user explicitly wants the projected task list cleared. It preserves Inbox entries. Neither tool changes or cancels backend work. Perform any matching backend action separately.

## Read and resynchronize

Call `task_ui_get` without `task_id` to retrieve:

- every active task
- the next unblocked pending task
- the focused task

Call it with `task_id` for full details about one task.

`task_ui_list` requires exactly one of `scope` or `status`. Never omit both, and never provide both.

Prefer `scope` for normal workflow questions:

| Scope | Use it to retrieve |
|---|---|
| `all` | Every projected task, such as during resynchronization |
| `open` | All unfinished tasks: `pending` and `in_progress` |
| `ready` | Only unblocked `pending` tasks that can start now |
| `active` | Only `in_progress` tasks |
| `history` | Terminal tasks: `completed`, `failed`, and `stopped` |

Use `status` instead when you need exactly one stored state without retrieving every task in a broader scope. Valid exact statuses are `pending`, `in_progress`, `completed`, `failed`, and `stopped`. A `pending` query includes blocked tasks; use `scope: "ready"` when blocked tasks must be excluded.

Examples:

```ts
task_ui_list({ scope: "ready" })       // Find work that can start now.
task_ui_list({ scope: "open" })        // Review all unfinished work.
task_ui_list({ scope: "all" })         // Reconcile the complete projection.
task_ui_list({ status: "failed" })     // Inspect failures only.
task_ui_list({ status: "pending" })    // Include blocked and unblocked pending work.
```

Do not call `task_ui_list({ scope: "all" })` and filter the returned tasks yourself when an exact `status` query can return only the required state.

Use `task_ui_output` only for concise, user-relevant projected output. Do not stream large logs into the sidebar.

## Export Markdown

Call `task_ui_to_md({})` when the user needs a readable Markdown handoff of the complete projection. The tool writes a unique file in the system temporary directory by default.

Pass `path` when the user needs a specific location. The tool returns the absolute path to the generated file.

If the target exists, ask the user to confirm before replacement. Call the tool again with the same `path` and `overwrite: true` only after that confirmation.

The extension generates numbered headings, descriptions, statuses, and local dependency links. The export includes every task status.

The export also includes complete Inbox summaries in display order. It records each entry ID, kind, creation time, and optional task link.

The export excludes labels, focus, progress, owners, task output, and execution telemetry.

## Follow tool-result guidance

Tool results can contain two separate agent-oriented fields:

- `suggestedNextTask` identifies the next unblocked pending task when that information is useful. A value of `null` means that no task is ready; an omitted field means the result does not make a next-task recommendation.
- `suggestedAction` is text showing a sensible later `task_ui_*` call with valid call syntax. It describes API usage; it does not select or start backend work.

The structured `details` additions are:

| Tool result | Additional fields |
|---|---|
| `create` | `suggestedNextTask`, `suggestedAction` |
| `batch_create` | `createdIds`, `suggestedNextTask`, `suggestedAction` |
| `list` | `selector`, full-projection `counts`, `suggestedNextTask`, `suggestedAction` |
| `to_md` | output `path`, ordered `tasks`, full-projection `counts` |
| `get` | `blockers`, `isBlocked`, `suggestedAction` |
| `get_dashboard` | `suggestedAction`; the dashboard already contains `next` |
| `update` | `changedFields`, `newlyReady`, `suggestedAction`; terminal transitions also include `suggestedNextTask` |
| `output:*` | `outputCount`; appends also include `suggestedAction` |
| `inbox:add` | `entry`, `counts`, `evictedInfoIds`, `suggestedNextTask`, `suggestedAction` |
| `inbox:list` | `entries`, `selector`, `counts`, `suggestedNextTask`, `suggestedAction` |
| `inbox:resolve` | `resolvedEntry`, `nextFeedbackEntry`, `counts`, `suggestedNextTask`, `suggestedAction` |
| `inbox:clear` | `removedCount`, `counts`, `suggestedNextTask`, `suggestedAction` |
| `remove` | `detachedChildren`, `suggestedNextTask`, `suggestedAction` |
| `clear` | `removedCount`, `suggestedNextTask: null`, `suggestedAction` |
| `stop` | `reason`, `suggestedNextTask`, `suggestedAction` |

For example, starting a projected task can return:

```text
Later call task_ui_update({ task_id: "worker-1", status: "completed", executing: false, progress: 100 }) when the work is complete.
```

Treat both fields as advisory projection guidance. Keep the real backend authoritative, and do not perform a suggested mutation until the corresponding backend state is confirmed.

### New-session resynchronization

When a new Pi session resumes work managed by `ctx_task` or another persistent task backend:

1. Call `task_ui_list({ scope: "all" })` to inspect the current projection; resumed Pi sessions may already contain UI state.
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
