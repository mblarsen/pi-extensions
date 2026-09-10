# @mblarsen/pi-task-ui

## 2.2.0

### Minor Changes

- e299574: Show task descriptions in a dimmed sidebar panel and a scrollable task browser details view.

## 2.1.0

### Minor Changes

- 9e1570c: Add `task_ui_to_md` to write the complete task projection to a Markdown file.

## 2.0.0

### Major Changes

- 3b4d0c9: Require task list calls to select a workflow scope or exact status, and add agent-oriented next-task and follow-up call guidance to tool results.

## 1.0.0

### Major Changes

- ebf2bcd: Change Alt+U and `/task-ui cycle` to cycle through the sidebar, browser, and hidden states. Add `/task-ui sidebar`, `/task-ui browse`, and `/task-ui hide` to select a state directly. In browse mode, q or Escape returns to the sidebar, while Alt+U hides both views.

## 0.3.0

### Minor Changes

- ea16b15: Add a read-only full task browser with ordered navigation and scrolling.

## 0.2.1

### Patch Changes

- 519a4a3: Keep stopped task text dim after rendering its status icon.

## 0.2.0

### Minor Changes

- bd193de: Remind agents to reconcile active tasks after successful Git commits and `link_send` calls.

### Patch Changes

- 852e786: Dim stopped tasks and their labels in the history section.
