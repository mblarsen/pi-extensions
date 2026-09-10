# Task UI Descriptions Implementation Plan

## Goal

Show existing task descriptions in two task-ui views.

The sidebar will show a dimmed description box for up to three executing tasks. Browse mode will show a scrollable details pane for the selected task.

## Source Design

Use `docs/superpowers/specs/2026-09-10-task-ui-descriptions-design.md` as the approved behavior specification.

## Files

Modify these files:

- `packages/task-ui/index.ts`
- `packages/task-ui/index.test.ts`
- `packages/task-ui/README.md`
- `packages/task-ui/skill/SKILL.md`

Add this file:

- `.changeset/task-ui-descriptions.md`

The existing data model in `packages/task-ui/core.ts` needs no change.

## Task 1: Add Description Layout Helpers

### Tests

Add focused rendering tests to `packages/task-ui/index.test.ts`.

Cover these helper behaviors through component output:

- Wrap text to the available visible width.
- Preserve explicit line breaks.
- Handle narrow widths without negative lengths.
- Crop sidebar text to three lines.
- Add an ellipsis to cropped text.
- Keep all browser lines available for scrolling.

Run the focused test file and confirm that the new tests fail:

```bash
node --test packages/task-ui/index.test.ts
```

### Implementation

In `packages/task-ui/index.ts`, add constants for:

- Three sidebar description tasks.
- Three sidebar lines per description.
- A 40 percent browser details height limit.

Add small internal helpers that:

1. Split explicit lines.
2. Wrap text by visible terminal width.
3. Crop wrapped lines with an ellipsis.
4. Render a plain dimmed divider.

Use existing `visibleWidth` and `truncateToWidth` utilities. Do not modify task data while formatting it.

Run the focused tests again:

```bash
node --test packages/task-ui/index.test.ts
```

## Task 2: Render the Sidebar Description Box

### Tests

Add sidebar tests to `packages/task-ui/index.test.ts`.

Create tasks that cover:

- Executing `in_progress` tasks with descriptions.
- Non-executing `in_progress` tasks.
- Executing tasks without descriptions.
- Pending and terminal tasks with descriptions.
- A parent, child, and grandchild hierarchy.
- More than three eligible descriptions.
- A description longer than three rendered lines.

Assert these results:

- Only executing `in_progress` tasks appear.
- Missing descriptions are skipped.
- The first three depth-first descriptions appear.
- Task subjects and numbers do not appear in the description box.
- A dim divider separates descriptions.
- The description box has no title.
- The border, divider, and text use the dim theme slot.
- The third description line ends with an ellipsis when cropped.
- No description box appears when no task qualifies.
- Constrained height reduces or hides description content without clipping the main task box.

Run the focused test file and confirm that the tests fail:

```bash
node --test packages/task-ui/index.test.ts
```

### Implementation

Refactor `TaskBarComponent.render()` into clear internal steps:

1. Render the existing main task box without behavior changes.
2. Select eligible descriptions from `orderTasksForDisplay(tasks)`.
3. Wrap and crop each selected description.
4. Allocate remaining overlay rows to the lower box.
5. Append a gap and the untitled dimmed box when content fits.

Add an optional viewport-height callback after the existing constructor arguments. Keep the current three-argument constructor valid for external callers and existing tests.

Update `showOverlay()` to pass the sidebar height derived from the TUI terminal rows and the existing 76 percent overlay limit.

Run the focused tests:

```bash
node --test packages/task-ui/index.test.ts
```

## Task 3: Add Browse Details Mode

### Tests

Extend the browser tests in `packages/task-ui/index.test.ts`.

Test these input and rendering paths:

- `d` opens details mode.
- A second `d` closes details mode.
- `Esc` closes details mode before it closes browse mode.
- `q` still closes browse mode.
- `Alt-U` still hides both views.
- A missing description renders `No description`.
- A short description wraps and remains fully visible.
- A long description uses at most 40 percent of the browser viewport.
- `Up`, `Down`, `j`, and `k` scroll by one line.
- `Ctrl-U` and `Ctrl-D` scroll by half a details viewport.
- Scroll offsets stop at the first and last valid positions.
- The range indicator changes after scrolling.
- Opening details mode keeps the selected task visible.
- A terminal resize clamps list and description offsets.
- Closing details mode restores task-list navigation.
- Removing the selected task uses the existing fallback and resets description scrolling.

Run the focused test file and confirm that the tests fail:

```bash
node --test packages/task-ui/index.test.ts
```

### Implementation

Add transient fields to `TaskBrowserComponent` for:

- Details visibility.
- Description scroll offset.
- The last rendered description capacity and wrapped lines.

Handle details keys before task-list navigation keys.

When details mode opens:

1. Reset the description offset.
2. Wrap the selected description for the current width.
3. Calculate the details capacity.
4. Reduce the list capacity.
5. Reconcile the list offset so the selected task stays visible.

Render the details pane inside the existing browser border. Use a dim divider with the visible range. Render `No description` as one dimmed line when necessary.

Use the contextual details footer while details mode is open. Restore the existing footer after it closes.

Run the focused tests:

```bash
node --test packages/task-ui/index.test.ts
```

## Task 4: Update Package Guidance

### README

Update `packages/task-ui/README.md`.

Document:

- The separate task subject and description fields.
- Sidebar eligibility and depth-first priority.
- The three-task and three-line sidebar limits.
- The `d` details key.
- Details scrolling keys.
- The `No description` fallback.
- Selection visibility during details mode.

### Agent Skill

Update `packages/task-ui/skill/SKILL.md`.

Tell agents to add concise descriptions when context will help the user or a later agent turn. State that descriptions supplement subjects and must not duplicate them.

Do not require descriptions for trivial tasks or invent unconfirmed context.

### Changeset

Create `.changeset/task-ui-descriptions.md`:

```md
---
"@mblarsen/pi-task-ui": minor
---

Show task descriptions in a dimmed sidebar panel and a scrollable task browser details view.
```

Run the focused tests:

```bash
node --test packages/task-ui/index.test.ts
```

## Task 5: Validate and Commit

Inspect the complete diff for unrelated changes:

```bash
git diff --check
git diff -- packages/task-ui .changeset/task-ui-descriptions.md
```

Run the required package checks before the package commit:

```bash
npm ci
npm run check
npx changeset status
```

Manually inspect component output at representative dimensions:

- 80 columns by 24 rows.
- 120 columns by 40 rows.
- 200 columns by 60 rows.

Verify dark, light, and no-color-compatible theme behavior through semantic theme slots.

Commit all package changes only after every check passes:

```bash
git add packages/task-ui .changeset/task-ui-descriptions.md
git commit -m "feat(task-ui): show task descriptions"
```

Do not publish or create a release PR unless the user requests it.

## Progress

- [x] Added description wrapping and cropping helpers.
- [x] Added the responsive sidebar description box.
- [x] Added browse details mode and full-text scrolling.
- [x] Updated the README, agent skill, tool guidance, and Changeset.
- [x] Passed `npm ci`, `npm run check`, and `npx changeset status`.
- [x] Checked 80x24, 120x40, and 200x60 layouts for overflow and selection visibility.
