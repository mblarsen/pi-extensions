# Task UI Markdown Export

## Goal

The task-ui extension will add a `task_ui_to_md` tool. The tool will render the complete current task projection as Markdown.

The extension will generate the Markdown. The tool will not ask the agent to reconstruct task state or formatting.

## Scope

The tool will include every projected task and its current status. It will include task descriptions and declared dependencies when present.

The tool will exclude labels, focus, progress, owners, timestamps, task output, and execution telemetry.

The tool will not write a file. It will return Markdown so the caller can display, copy, or save it.

## Tool Contract

The tool will have this interface:

```ts
task_ui_to_md({})
```

The tool will accept no parameters. It will not modify or persist task-ui state.

The text content of a successful result will contain only the generated Markdown. It will not add confirmation text, summaries, or suggested actions.

The structured result details will contain:

- `action: "to_md"`
- the ordered task records
- status counts for the complete projection

The custom TUI result will show `N projected task(s) exported`. It will not print the complete Markdown document in the tool result view.

For an empty projection, the tool will return:

```md
_No projected tasks._
```

## Markdown Mapping

The renderer will preserve the stable hierarchy and number order used by the task browser.

Each task will map to these Markdown elements:

1. The task depth selects the heading level.
2. The hierarchical display number and subject form the heading text.
3. The description follows the heading when present.
4. A metadata line follows the description.
5. The metadata line contains the status and declared dependencies.

Root tasks will use level-one headings. Child tasks will use level-two headings. Each additional hierarchy level will add one heading level.

Markdown supports six heading levels. Tasks deeper than level six will continue to use level-six headings. Their hierarchical display numbers will continue to show their exact depth.

The renderer will show these readable status values:

| Stored status | Markdown status |
|---|---|
| `pending` | `pending` |
| `in_progress` | `in progress` |
| `completed` | `completed` |
| `failed` | `failed` |
| `stopped` | `stopped` |

The renderer will normalize a task subject to one line before it creates a heading. It will retain Markdown formatting in task descriptions.

## Dependency Links

The renderer will include every declared dependency. This includes dependencies that are complete.

A known dependency will use its display number and subject as the link label. The link will target the dependency task heading in the same document.

The renderer will generate GitHub-flavored Markdown heading anchors. It will resolve anchor collisions in document order so each dependency link targets the correct task.

A missing dependency cannot link to a task heading. The renderer will show its task ID as inline code instead.

Multiple dependencies will use a comma-separated list.

## Example

```md
# 1. Define export format

Document the Markdown structure.

**Status:** completed

# 2. Add task hierarchy helpers

Expose stable numbering and ordering.

**Status:** completed

# 3. Implement Markdown renderer

Generate the complete task document.

**Status:** in progress · **Dependencies:** [1. Define export format](#1-define-export-format), [2. Add task hierarchy helpers](#2-add-task-hierarchy-helpers)

## 3.1. Add renderer tests

Cover nested tasks, multiple dependencies, and missing dependency IDs.

**Status:** pending · **Dependencies:** [1. Define export format](#1-define-export-format), [3. Implement Markdown renderer](#3-implement-markdown-renderer)
```

## Components

### Markdown renderer

A pure `renderTaskUiMarkdown` function will accept task-ui state and return a Markdown string.

The renderer will prepare all headings and anchors before it renders dependency links. This pass will make links independent of task creation order.

### Shared task ordering

The Markdown renderer and the TUI will use one task-ordering helper. The helper will preserve the current root and subtask ordering behavior.

### Tool registration

The extension will register `task_ui_to_md` as a sequential, read-only tool. The tool will read the current in-memory state and call the pure renderer.

## Data Flow

1. The caller invokes `task_ui_to_md({})`.
2. The tool reads the current in-memory task-ui state.
3. The renderer orders all tasks.
4. The renderer calculates each heading, display number, and local anchor.
5. The renderer generates each task section and its dependency links.
6. The tool returns the Markdown and structured details.

No step changes task-ui state.

## Error Handling

An empty projection will return the documented empty-state Markdown.

A missing dependency will render as an inline task ID. It will not make the tool fail.

An orphaned task will render as a root task, which matches the current display ordering behavior.

The renderer will not mutate task records or arrays. Unexpected internal errors will use Pi's normal tool error handling.

## Tests

Unit tests for the renderer will cover:

- an empty projection
- all five status values
- root tasks and nested tasks
- hierarchy deeper than six levels
- stable hierarchy and number ordering
- descriptions that are present or absent
- descriptions that contain Markdown
- normalized multiline subjects
- one dependency and multiple dependencies
- completed dependencies
- missing dependency IDs
- heading anchor escaping and collisions
- input state immutability

Extension tests will verify:

- registration under the `task_ui_to_md` name
- an empty parameter schema
- exact Markdown text content
- ordered task records and status counts in structured details
- a compact TUI result
- no state mutation or persistence

## Documentation and Release

The README will list `task_ui_to_md` with the other presentation tools. It will explain that the extension creates the Markdown and does not write a file.

The bundled Agent Skill will explain when to use the tool and that its text result is ready to save without reformatting.

This feature adds a new public tool. The change will include a minor Changeset for `@mblarsen/pi-task-ui`.
