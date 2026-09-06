# Task UI Checkpoint Reminders

## Goal

The task-ui extension will remind the agent to reconcile its task projection after important work checkpoints.

The reminder will help the agent keep task status, progress, and execution state accurate. It must not interrupt the current work.

## Scope

The extension will use two hardcoded checkpoints:

- A successful Bash tool call that contains a likely `git commit` invocation.
- A successful `link_send` tool call.

The extension will not support user-defined checkpoints in this change.

## Trigger and Delivery Flow

The extension will listen for `tool_result` events. It will ignore results where `event.isError` is true.

For a Bash result, the extension will inspect the command input. It will detect common `git commit` forms in shell command positions:

```text
git commit -m "..."
cd repo && git commit
git -C repo commit
command-one; git commit
```

The detector will reject obvious non-invocations such as `echo "git commit"` and `git commitment`. The detector is a focused heuristic, not a complete shell parser.

A compound Bash command counts as successful only when the complete Bash tool call succeeds. For example, `git commit && git push` will not trigger the reminder if the push fails.

For `link_send`, a successful tool result will trigger the reminder without inspecting its input.

The extension will skip the reminder when the projection has no active or pending tasks. It will queue at most one reminder during an agent turn. A `turn_start` event will reset this guard for the new turn.

The extension will use `pi.sendMessage()` with these options:

- A task-ui-specific `customType`.
- `display: false` to hide the message from the transcript.
- `deliverAs: "steer"` to deliver it before the next model response.

The message will include the checkpoint name.

## Reminder Text

```text
Task UI checkpoint: A successful {trigger} just occurred.

Before continuing, reconcile task-ui with the actual work state:
- update affected task statuses, progress, and execution state;
- add newly discovered work only when it is meaningful;
- do not mark a task complete merely because this checkpoint succeeded.

If task-ui is already accurate, make no changes.

If you change task-ui, mention the update in your next natural user-facing status message. Do not interrupt, pause, or redirect the current work solely to report it; resume the ongoing work immediately.
```

The `{trigger}` value will identify `git commit` or `link_send`.

## Components

### Checkpoint classifier

A pure helper will read the tool name, tool input, and error state. It will return the checkpoint name or no match.

The helper will accept only the two hardcoded checkpoint types. It will ignore missing or malformed inputs.

### Reminder coordinator

The extension lifecycle will own one in-memory Boolean guard. The guard will record whether the current turn already queued a reminder.

The coordinator will read the existing task-ui state. It will send a reminder only when at least one task has `pending` or `in_progress` status.

Session start, session tree changes, and session shutdown will clear the guard. The extension will not persist the guard.

## Error Handling

The checkpoint logic will not block or modify the original tool result.

The classifier will return no match for invalid input. If message injection throws, the extension will show a warning when UI is available. The agent will continue its current work.

## Tests

Extension tests will cover these cases:

- A successful `git commit` Bash call queues a reminder.
- A failed `git commit` Bash call does not queue a reminder.
- Common compound command positions match.
- Obvious non-invocations do not match.
- A successful `link_send` call queues a reminder.
- A failed `link_send` call does not queue a reminder.
- An empty projection does not queue a reminder.
- A projection with only terminal tasks does not queue a reminder.
- Multiple checkpoints in one turn queue one reminder.
- A new turn permits another reminder.
- The message uses the approved text, hidden display, and steer delivery.
- Injection errors do not alter the tool result flow.

The README will describe the automatic checkpoints. Existing text will continue to state that task state remains presentation-only.

## Release

This feature adds new package behavior. The change will include a minor Changeset for `@mblarsen/pi-task-ui`.
