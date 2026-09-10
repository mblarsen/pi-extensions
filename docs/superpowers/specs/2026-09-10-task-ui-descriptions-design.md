# Task UI Descriptions

## Goal

The task-ui extension will show task descriptions in the sidebar and task browser.

Descriptions help agents and users remember the purpose and context of active work. A description remains separate from the task subject.

## Scope

This change will use the existing optional `TaskRecord.description` field.

The existing create, batch-create, update, snapshot, upsert, and persistence paths already support descriptions. This change will not add a character limit or change the task state version.

The change will add two presentation features:

- A dimmed description box below the main sidebar box.
- A scrollable details pane inside browse mode.

## Shared Description Rendering

A shared helper will wrap descriptions to the available terminal width. It will measure visible terminal width and preserve explicit line breaks.

Whitespace-only descriptions will count as absent. Sidebar rendering will crop wrapped text when necessary. Browser rendering will keep every wrapped line available through scrolling.

## Sidebar Description Box

`TaskBarComponent` will render the existing task box first. It will then render a small gap and a separate description box.

The description box will have these properties:

- It will have no title.
- Its border, dividers, and text will use the theme's dim style.
- It will show descriptions only. It will not repeat task numbers, subjects, labels, icons, or telemetry.
- It will show at most three descriptions.
- It will separate descriptions with a dim horizontal divider.
- It will hide when no description qualifies.

A task description qualifies only when all these conditions are true:

- The task status is `in_progress`.
- The task has `executing: true`.
- The task has a non-empty description.

The component will order qualifying tasks with the existing depth-first display order. It will select the first three descriptions from that order.

Each description can use at most three lines. If more text exists, the third line will end with an ellipsis.

### Sidebar Height

The component will receive the available overlay height from the TUI. It will render the main task box before it allocates space to the description box.

The description box will use only the remaining height. It can reduce the visible lines or omit lower-priority descriptions when the terminal is short. It will hide if there is not enough space for its border and one content line.

This behavior prevents the framework from clipping the bottom description box. The existing main task list keeps priority.

## Browse Details Mode

Pressing `d` in browse mode will open a details pane inside the existing browser border. Pressing `d` again will close it.

The pane will appear below the task list. A divider will separate the list and details content.

The pane will show the selected task's complete wrapped description. It will show `No description` when the selected task has no description.

The pane height will grow with short descriptions. It will use at most 40 percent of the browser viewport for long descriptions.

### Details Navigation

The details pane will receive navigation focus while it is open.

- `Up`, `Down`, `j`, and `k` will scroll one description line.
- `Ctrl-U` and `Ctrl-D` will scroll half of the details viewport.
- `d` and `Esc` will close the details pane.
- `q` will close browse mode and return to the sidebar.
- `Alt-U` will hide both task-ui views.

A range indicator such as `1–8/24` will show the visible description lines. The contextual footer will show the active details controls.

Closing the pane will restore the existing task-list controls.

### Selection Visibility

Opening the details pane will reduce the task-list viewport. The browser will recalculate its list capacity before rendering the pane.

The browser will adjust its task-list scroll offset when necessary. The selected task must remain visible above the details pane.

Closing the pane will expand the list viewport. Resizing the terminal will recalculate both viewports and clamp both scroll offsets.

If the selected task disappears, the browser will use its existing fallback selection. It will reset the description scroll offset for the new selection.

## Component Structure

The implementation will keep all view state inside the existing presentation components.

`TaskBarComponent` will render two visually separate boxes from one non-capturing overlay component. This keeps their width, position, visibility, and responsive height synchronized.

`TaskBrowserComponent` will own these transient values:

- Whether details mode is open.
- The description scroll offset.

The extension will not persist these values in `TaskUiState`.

## Error Handling

Description rendering will not modify task state.

Empty descriptions will use the defined sidebar and browser behavior. Narrow or short terminals will clamp widths, heights, and offsets to valid values.

A resize or task update must not produce a negative capacity or an invalid scroll offset.

## Tests

Sidebar tests will cover these cases:

- Only executing `in_progress` tasks qualify.
- Tasks without descriptions do not qualify.
- Depth-first order selects descriptions.
- The box shows at most three descriptions.
- Each description uses at most three lines.
- Cropped descriptions end with an ellipsis.
- Dividers appear only between descriptions.
- The border, dividers, and text use the dim style.
- The box has no title.
- The box hides when no descriptions qualify.
- A constrained terminal height reduces or hides description content without clipping the main box.

Browser tests will cover these cases:

- `d` opens and closes details mode.
- `Esc` closes details mode before it closes browse mode.
- `q` and `Alt-U` keep their existing browser behavior.
- A description wraps to the available width.
- A missing description shows `No description`.
- Line and half-page keys scroll long descriptions.
- The range indicator reports the visible line range.
- The selected task stays visible when details mode opens.
- Resize clamps the list and description scroll offsets.
- Closing details mode restores task-list navigation.

The README will document both description views and their keys. The bundled task-ui skill will tell agents to add concise descriptions when that context helps users or future agent turns.

## Release

This feature adds new package behavior. The implementation will include a minor Changeset for `@mblarsen/pi-task-ui`.
