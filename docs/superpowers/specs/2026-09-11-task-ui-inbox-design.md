# Task UI Inbox Design

## Summary

Add an Inbox to `@mblarsen/pi-task-ui` for concise user-facing information and unresolved questions that must remain visible while an agent continues working.

The Inbox supplements normal assistant responses. It never replaces them. Agents continue to send complete user-facing responses in chat and use `task_ui_inbox` to store a concise Markdown summary of the part that the user may need later.

## Problem

Long-running agents can answer a user, request a decision, or relay a sub-agent question and then continue producing output. Important messages scroll out of view. The existing sidebar shows projected work but has no durable place for these user-facing messages.

## Goals

- Keep important user-facing summaries visible while work continues.
- Distinguish informational summaries from unresolved user feedback.
- Prevent unanswered feedback from being silently evicted.
- Let users retrieve and read summaries as rendered Markdown in TUI browse mode.
- Link a summary to a projected task when useful without requiring a task.
- Give agents structured results and actionable next-step suggestions.

## Non-goals

- Replace the normal assistant response.
- Capture or reproduce complete assistant responses automatically.
- Create a communication backend or execute work.
- Let the user edit or resolve entries directly in the non-interactive sidebar.
- Treat Inbox entries as projected tasks.

## Terminology

- **Inbox**: The combined user-message section.
- **Info**: A non-blocking summary that can roll off automatically.
- **Feedback needed**: A question or decision that remains until the agent resolves it.
- **Summary**: Agent-authored Markdown stored in an Inbox entry. It can differ from the corresponding normal response.

## Data model

Extend the existing task-ui projection:

```ts
type InboxEntryKind = "info" | "feedback_needed";

type InboxEntry = {
  id: string;
  kind: InboxEntryKind;
  markdown: string;
  taskId?: string;
  createdAt: string;
};

type TaskUiState = {
  tasks: TaskRecord[];
  inbox: InboxEntry[];
  nextInboxId: number;
  // Existing state fields remain unchanged.
};
```

Inbox IDs are stable and concise, such as `inbox-1`. `nextInboxId` prevents reuse after an entry is resolved or evicted.

Older snapshots restore with an empty Inbox and an initialized counter. Inbox data uses the existing task-ui snapshot and mutation publication path.

Task removal and task-only clearing preserve Inbox entries. Backend adapter snapshots replace projected tasks without replacing Inbox entries or their ID counter.

## Lifecycle and limits

### Informational entries

- Retain the newest 10 entries.
- Adding entry 11 evicts the oldest informational entry.
- Informational entries do not require explicit resolution.
- The `clear` operation removes all informational entries.

### Feedback-needed entries

- Retain each entry until an agent resolves it.
- Resolving an entry removes it immediately.
- Permit at most 20 unresolved entries.
- Reject entry 21. Never evict unresolved feedback automatically.
- The rejection must instruct the agent to list entries, resolve obsolete or duplicate entries, preserve every entry that still needs a user response, prioritize the remainder, and retry the addition.

### Task links

- `task_id` is optional when adding an entry.
- If supplied, the projected task must exist at creation time.
- Removing the linked task does not remove the Inbox entry.
- A retained entry continues to display its stored task ID even if the task no longer exists.

### Summary length

`markdown` accepts at most 400 source characters. This is a practical approximation of the requested presented-character limit and avoids a rendering-dependent validation pass.

## Tool API

Register one sequential tool named `task_ui_inbox`.

```ts
type TaskUiInboxInput = {
  operation: "add" | "resolve" | "list" | "clear";
  kind?: "info" | "feedback_needed";
  markdown?: string;
  task_id?: string;
  entry_id?: string;
};
```

Manual validation enforces operation-specific fields and rejects irrelevant combinations.

### `add`

Requires `kind` and `markdown`. Accepts optional `task_id`.

Returns:

- the created `entry`;
- updated `counts`;
- `evictedInfoIds` when the rolling info cap removed entries;
- `suggestedNextTask` from the current task dashboard;
- a `suggestedAction`.

Every successful result reminds the agent that the Inbox entry supplements the normal user-facing response. The result instructs the agent to send the complete response as usual and continue the planned work.

For feedback-needed entries, the suggestion also names the entry ID and instructs the agent to resolve it after the user answers.

### `resolve`

Requires `entry_id`. The entry must exist and have kind `feedback_needed`.

Returns:

- `resolvedEntry`;
- updated `counts`;
- `nextFeedbackEntry`, when one remains;
- `suggestedNextTask` from the current task dashboard;
- a `suggestedAction`.

### `list`

Accepts optional `kind`. Without it, returns all entries in display order.

Returns:

- matching `entries`;
- `selector`;
- updated `counts`;
- `suggestedNextTask` from the current task dashboard;
- a `suggestedAction`.

The suggestion calls for cleanup and prioritization when unresolved feedback approaches the cap.

### `clear`

Removes informational entries only. It never removes unresolved feedback.

Returns:

- `removedCount`;
- updated `counts`;
- `suggestedNextTask` from the current task dashboard;
- a `suggestedAction`.

### Structured result details

```ts
type InboxCounts = {
  info: number;
  feedbackNeeded: number;
  total: number;
};

type InboxToolDetails = {
  action: "add" | "resolve" | "list" | "clear";
  entry?: InboxEntry;
  entries?: InboxEntry[];
  selector?: { kind?: InboxEntryKind };
  counts: InboxCounts;
  evictedInfoIds?: string[];
  resolvedEntry?: InboxEntry;
  nextFeedbackEntry?: InboxEntry | null;
  removedCount?: number;
  suggestedNextTask?: TaskRecord | null;
  suggestedAction?: string;
};
```

Tool-call and tool-result rendering follows the existing task-ui presentation patterns.

## Sidebar design

The sidebar remains non-interactive. Its visual order is:

1. projected task list;
2. active task descriptions;
3. Inbox.

The Inbox renders even when no projected tasks exist. This requires removing the current early return for an empty task list.

### Inbox card

- Use one bordered section titled `Inbox`.
- Show at most three stacked entries.
- Order feedback-needed entries before informational entries.
- Sort each kind newest-first.
- Show an overflow count when entries are not visible.
- Each entry shows a fixed category badge, optional linked task ID, and at most two summary preview lines.
- Render the preview with Pi's Markdown component, then crop it to the available two lines; browse-mode details remain the authoritative complete rendering.

### Height allocation

After rendering the task list, allocate available rows in this priority:

1. feedback-needed Inbox entries;
2. active task descriptions;
3. informational Inbox entries.

The final visual order remains descriptions above Inbox even though feedback reserves its rows first. Content that cannot fit remains available in the Inbox tab in browse mode.

## Browse-mode design

Extend the existing interactive TUI browse mode with two tabs:

- **Tasks**
- **Inbox**

`Tab` switches tabs. The existing task view and its controls remain unchanged.

The Inbox tab:

- lists the complete unresolved feedback set and retained informational entries;
- uses the same category and newest-first ordering as the sidebar;
- supports arrow keys and `j`/`k` for selection;
- opens the selected entry with `d`;
- renders the complete stored summary with Pi's `Markdown` component and `getMarkdownTheme()`;
- keeps existing close, half-page, and scroll controls where applicable.

The `/task-ui inbox` command opens browse mode directly on the Inbox tab. The existing `Alt+U` mode cycle continues to open browse mode without adding another global keybinding.

## Markdown export

`task_ui_to_md` continues to represent the complete task-ui projection. Add an Inbox section containing:

1. unresolved feedback-needed entries, newest first;
2. retained informational entries, newest first.

Each exported entry includes its ID, category, optional task link, timestamp, and Markdown summary.

## Agent guidance

Update the packaged skill and tool description with a prominent invariant:

> `task_ui_inbox` never replaces the normal user-facing response. Send the complete response as usual and also call the Inbox tool when an Inbox entry is applicable.

Require each `info` summary to be a concise, self-contained takeaway. Require each `feedback_needed` summary to state the exact question or decision needed.

Document these cases:

1. **Continue after answering**: Add an `info` summary, send the normal answer, and continue planned work.
2. **Non-blocking feedback**: Add a `feedback_needed` summary, ask the question normally, and continue unrelated work.
3. **Sub-agent feedback**: When a sub-agent reports that it needs user input, the coordinating agent records the question in its user-visible Inbox.
4. **Timer or heartbeat**: Before ending a turn that schedules continued monitoring, add the applicable summary and send the normal response.
5. **Resolution**: After the user answers, resolve the corresponding feedback entry before or while acting on the answer.

Do not add Inbox entries for routine acknowledgements, raw tool output, or a terminal completion summary when no work or monitoring will continue.

## Error behavior

Errors are explicit and actionable:

- missing fields identify the fields required for the selected operation;
- summaries over 400 source characters state the limit;
- unknown task IDs and entry IDs name the missing ID;
- resolving an informational entry explains that only feedback-needed entries are resolved;
- the 20-entry feedback limit returns the agreed cleanup, preservation, prioritization, and retry instructions.

No failed operation mutates state.

## Testing

### Core tests

- initialize and restore Inbox state;
- generate non-reused IDs;
- add and order both kinds;
- retain only the newest 10 informational entries;
- reject feedback entry 21 without mutation;
- resolve feedback and reject invalid resolutions;
- clear info without removing feedback;
- validate optional task links;
- retain entries after linked task removal.

### Tool tests

- validate each operation's input contract;
- verify text and structured return values;
- verify suggestions for add, list, resolve, and clear;
- verify the exact actionable feedback-cap error;
- verify the dual-output reminder in the description and successful add result.

### TUI tests

- render Inbox without tasks;
- render no more than three sidebar entries;
- enforce feedback, description, and info height priority;
- show linked task IDs and overflow counts;
- switch Tasks and Inbox tabs;
- navigate Inbox entries;
- render selected details as Markdown.

### Export and packaging tests

- export Inbox entries to Markdown;
- keep existing task-only snapshots backward-compatible;
- include the extension and updated skill in `pack:check`;
- run the repository's required package checks.

## Release

This is a backward-compatible feature for `@mblarsen/pi-task-ui`. Add a minor Changeset with a user-facing summary such as:

> Add a persistent Inbox for informational updates and unresolved user feedback.
