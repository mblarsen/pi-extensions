# Task UI Inbox Implementation Plan

## Objective

Add the approved Inbox feature to `@mblarsen/pi-task-ui`: persistent informational and feedback-needed summaries, one operation-based agent tool, a three-entry sidebar section, an Inbox tab in TUI browse mode, Markdown export, agent guidance, and a minor Changeset.

## Reference

Implement the approved design in:

- `docs/superpowers/specs/2026-09-11-task-ui-inbox-design.md`

Do not treat the Inbox as a task backend or replace normal user-facing responses.

## Progress

- [x] Task 1: Add the Inbox domain model and lifecycle
- [x] Task 2: Export Inbox entries to Markdown
- [x] Task 3: Register and implement `task_ui_inbox`
- [x] Task 4: Render Inbox entries in the sidebar
- [x] Task 5: Add the Inbox tab to browse mode
- [x] Task 6: Document the dual-output workflow and release impact
- [x] Task 7: Verify the complete package change

## Task 1: Add the Inbox domain model and lifecycle

**Files**

- Modify: `packages/task-ui/core.test.ts`
- Modify: `packages/task-ui/core.ts`

### 1. Write failing core tests

Extend the `task-ui projection` suite with tests for:

- `createInitialTaskUiState()` returning `inbox: []` and `nextInboxId: 1`;
- `normalizeStoredTaskUiState()` migrating a task-only snapshot to the new state version with an empty Inbox;
- cloning Inbox arrays and entries without shared references;
- adding `info` and `feedback_needed` entries with stable `inbox-N` IDs and ISO timestamps;
- ordering feedback before info and each kind newest-first;
- retaining only the newest 10 info entries and returning evicted IDs;
- accepting 20 feedback entries and rejecting entry 21 without mutation;
- resolving feedback immediately;
- rejecting unknown IDs and attempts to resolve info;
- clearing info without removing feedback;
- rejecting empty or over-400-character summaries;
- validating optional task links at creation;
- retaining an entry after its linked task is removed;
- preserving Inbox entries and their ID counter when tasks are cleared or replaced by an adapter snapshot;
- never reusing an ID after resolution or eviction.

Run:

```bash
node --test packages/task-ui/core.test.ts
```

Expected: the new tests fail because the Inbox API does not exist.

### 2. Implement the core model

In `packages/task-ui/core.ts`:

- bump `TASK_UI_STATE_VERSION` from 5 to 6;
- export `INBOX_ENTRY_KINDS`;
- export limits for 400 summary characters, 10 info entries, and 20 unresolved feedback entries;
- add `InboxEntryKind`, `InboxEntry`, `InboxListSelector`, `InboxCounts`, and operation input types;
- extend `TaskUiState` with `inbox` and `nextInboxId`;
- update initial state, cloning, replacement, and stored-state normalization;
- keep task replacement helpers explicit about Inbox preservation rather than resetting unrelated projection state;
- add pure functions for:
  - display ordering;
  - counts;
  - addition and info eviction;
  - listing with an optional kind selector;
  - feedback resolution;
  - informational clearing.

Keep validation and lifecycle rules in `core.ts`. Do not bury them in tool execution or rendering code.

The feedback-cap error must instruct the agent to list entries, resolve obsolete or duplicate entries, preserve entries that still need a response, prioritize the remainder, and retry.

### 3. Run the focused tests

```bash
node --test packages/task-ui/core.test.ts
```

Expected: pass.

## Task 2: Export Inbox entries as Markdown

**Files**

- Modify: `packages/task-ui/markdown.test.ts`
- Modify: `packages/task-ui/markdown.ts`

### 1. Write failing export tests

Add cases for:

- task-only output remaining unchanged when the Inbox is empty;
- an Inbox-only projection no longer returning `_No projected tasks._`;
- an `Inbox` section with feedback before info and newest-first ordering;
- entry ID, category, timestamp, optional task ID, and unmodified Markdown summary;
- `writeTaskUiMarkdown()` writing the expanded projection.

Run:

```bash
node --test packages/task-ui/markdown.test.ts
```

Expected: the Inbox cases fail.

### 2. Extend the renderer

In `packages/task-ui/markdown.ts`:

- split task and Inbox rendering into focused helpers;
- retain current task output byte-for-byte when Inbox is empty;
- render `_No projected tasks._` only as the task section's empty state when Inbox content exists;
- append the ordered Inbox section with metadata and original Markdown summaries.

### 3. Run the focused tests

```bash
node --test packages/task-ui/markdown.test.ts
```

Expected: pass.

## Task 3: Register `task_ui_inbox` with agent-oriented results

**Files**

- Modify: `packages/task-ui/index.test.ts`
- Modify: `packages/task-ui/index.ts`

### 1. Write failing tool tests

Use the existing extension harness to verify:

- `task_ui_inbox` is registered as a sequential presentation tool;
- its description prominently says the normal response is still required;
- `add`, `resolve`, `list`, and `clear` validate their operation-specific fields;
- successful operations persist state and request updated rendering;
- add results contain `entry`, `counts`, `evictedInfoIds`, `suggestedNextTask`, and `suggestedAction`;
- feedback add suggestions name the entry ID and require later resolution;
- list results contain `entries`, `selector`, `counts`, `suggestedNextTask`, and cleanup guidance near the cap;
- resolve results contain `resolvedEntry`, `nextFeedbackEntry`, `counts`, `suggestedNextTask`, and `suggestedAction`;
- clear results contain `removedCount`, `counts`, `suggestedNextTask`, and `suggestedAction`;
- user-visible result text mirrors the structured guidance;
- the 21st feedback entry returns the exact actionable cleanup error;
- unknown task and entry IDs fail without state mutation;
- `task_ui_clear` and `task-ui:snapshot` replace tasks while preserving Inbox entries and `nextInboxId`.

Run:

```bash
node --test packages/task-ui/index.test.ts
```

Expected: the new tool tests fail.

### 2. Implement schema, execution, and rendering

In `packages/task-ui/index.ts`:

- import the Inbox core API and types;
- add `InboxToolDetails` rather than overloading task-only details;
- define the operation-based TypeBox schema with `additionalProperties: false`;
- manually enforce operation-specific required and irrelevant fields;
- implement concise Inbox summaries for tool text output;
- implement suggestions for every operation;
- register `task_ui_inbox` near the other presentation tools;
- use existing `renderToolCall` and `renderToolResult` conventions;
- persist mutations through `persistMutation()`.

The successful add result must say:

> The Inbox entry supplements the normal user-facing response. Include the full response as usual and continue the planned work.

### 3. Run the focused tests

```bash
node --test packages/task-ui/index.test.ts
```

Expected: pass.

## Task 4: Render the sidebar Inbox

**Files**

- Modify: `packages/task-ui/index.test.ts`
- Modify: `packages/task-ui/index.ts`

### 1. Write failing sidebar tests

Add render cases for:

- no tasks and no Inbox retaining the existing hidden-sidebar behavior;
- Inbox entries rendering when there are no tasks;
- a bordered `Inbox` section below task descriptions;
- fixed `Info` and `Feedback needed` badges;
- optional task IDs;
- feedback before info and newest-first ordering;
- no more than three entries;
- an overflow count;
- at most two rendered Markdown preview lines per entry;
- feedback reserving height before descriptions and info;
- descriptions remaining visually above Inbox after allocation;
- informational entries disappearing before descriptions when height shrinks.

Run:

```bash
node --test packages/task-ui/index.test.ts
```

Expected: the new sidebar cases fail.

### 2. Implement rendering and allocation

In `packages/task-ui/index.ts`:

- add Inbox display constants and badge styling helpers;
- change `TaskBarComponent.render()` to return no UI only when both tasks and Inbox are empty;
- calculate the row budget before producing sections;
- reserve feedback rows, then description rows, then info rows;
- render the sections in visual order: tasks, descriptions, Inbox;
- use Pi's `Markdown` component for previews and crop its rendered output to two available lines;
- keep every final line within the supplied width;
- invalidate nested Markdown components when the theme changes.

Do not add root margins to the sidebar or Inbox section. Parent layout owns external spacing.

### 3. Run the focused tests

```bash
node --test packages/task-ui/index.test.ts
```

Expected: pass.

## Task 5: Add the Inbox tab to browse mode

**Files**

- Modify: `packages/task-ui/index.test.ts`
- Modify: `packages/task-ui/index.ts`

### 1. Write failing interaction tests

Extend browse-mode tests to verify:

- the header exposes Tasks and Inbox tabs with counts;
- `Tab` switches between tabs;
- task navigation and details remain unchanged;
- Inbox opens with the first ordered entry selected;
- arrow keys and `j`/`k` navigate entries;
- `d` opens the selected summary;
- Inbox details use Pi's Markdown rendering rather than plain dim text;
- details scroll and close with existing controls;
- selection recovers when an entry is resolved or evicted;
- `/task-ui inbox` opens browse mode directly on the Inbox tab;
- command completions and usage text include `inbox`;
- `Alt+U` and `Alt+Shift+U` keep their current behavior and add no new global shortcut.

Run:

```bash
node --test packages/task-ui/index.test.ts
```

Expected: the new browse-mode cases fail.

### 2. Refactor `TaskBrowserComponent`

In `packages/task-ui/index.ts`:

- add a `"tasks" | "inbox"` active-tab state;
- keep independent selected IDs and scroll offsets for each tab;
- share navigation mechanics only where it reduces duplication;
- render tab labels in the existing border header;
- use the ordered Inbox projection for the Inbox list;
- render full selected summaries through `Markdown` and `getMarkdownTheme()`;
- preserve existing details height limits and width safety;
- let `showBrowser()` accept an initial tab;
- route `/task-ui inbox` to `showBrowser(ctx, "inbox")`.

### 3. Run the focused tests

```bash
node --test packages/task-ui/index.test.ts
```

Expected: pass.

## Task 6: Document the dual-output workflow and release impact

**Files**

- Modify: `packages/task-ui/skills/task-ui/SKILL.md`
- Modify: `packages/task-ui/README.md`
- Create: `.changeset/task-ui-inbox.md`

### 1. Update the packaged skill

Add a prominent rule that `task_ui_inbox` never replaces a normal assistant response.

Include examples for:

- an informational answer followed by continued work;
- a non-blocking feedback request while unrelated work continues;
- a coordinating agent relaying a sub-agent's user question;
- a response after which the agent stops but a timer or heartbeat continues monitoring;
- resolving the entry after the user answers;
- cases that must not create Inbox entries.

State that info summaries are concise, self-contained takeaways and feedback summaries contain the exact question or decision needed.

### 2. Update the package README

Document:

- sidebar Inbox behavior and limits;
- Tasks/Inbox browse tabs and keys;
- `/task-ui inbox`;
- all `task_ui_inbox` operations;
- structured return values and suggestions;
- the normal-response invariant;
- retention, resolution, clear, and feedback-cap behavior.

### 3. Add the Changeset

Create `.changeset/task-ui-inbox.md`:

```md
---
"@mblarsen/pi-task-ui": minor
---

Add a persistent Inbox for informational updates and unresolved user feedback.
```

## Task 7: Verify the complete package change

### 1. Run focused tests together

```bash
node --test packages/task-ui/core.test.ts packages/task-ui/index.test.ts packages/task-ui/markdown.test.ts
```

Expected: pass.

### 2. Run required repository checks

```bash
npm ci
npm run check
npx changeset status
```

Expected:

- typecheck passes;
- all tests pass;
- `pack:check` includes `index.ts`, `core.ts`, `markdown.ts`, `README.md`, `assets`, and `skills/task-ui/SKILL.md` for `@mblarsen/pi-task-ui`;
- package tests are excluded from the packed files;
- Changesets reports one minor bump for `@mblarsen/pi-task-ui`.

### 3. Inspect the final diff

```bash
git diff --check
git status --short
git diff --stat
git diff -- packages/task-ui .changeset docs/superpowers
```

Confirm:

- no generated `.superpowers` files are staged;
- no package version or changelog was edited manually;
- the design spec reflects any implementation adjustment;
- tool documentation uses the exact operation and field names;
- every active ExecPlan or design document is current before committing.
