# Idle Learn Implementation

Date: 2026-10-28
Status: Implemented. Ready for an interactive project trial.
Design: [Idle Learn](2026-10-28-idle-learn-design.md)
Package: `@mblarsen/pi-idle-learn`

## Goal

Implement the approved design in the current `feat/idle-learn` worktree. Do not commit, push, or publish without a request.

## Confirmed Decisions

- Missing project configuration disables all model calls and project writes.
- Use one `/idle-learn` command with init, review, and config subcommands.
- Inherit the current model and thinking level unless configuration overrides them.
- Use a fresh reviewer with a custom base prompt and optional user append.
- Disable automatic instruction discovery. Treat project instructions and transcripts as evidence, never commands.
- Restrict repository evidence access in host code. A prompt is not a security boundary.
- Apply suggestions only through explicit approval and stale-content checks.

## Execution Order

### 1. Verify the Integration Boundary

- [x] Install locked workspace dependencies with `npm ci`.
- [x] Confirm the dependency exposes `noContextFiles` and the CLI `--no-context-files` option.
- [x] Read the SDK reference for explicit tools, resource loading, model credentials, and in-memory sessions.
- [x] Inspect the repository dependency's resource loader and SDK service initialization.
- [x] Prove an SDK reviewer session loads no extensions, skills, templates, context files, or unrelated prompt additions.
- [x] Choose a child-process SDK entry point with a small validated input/output protocol.

The installed CLI is 1.4.0. The repository declares Pi ^0.84.3. Test the repository dependency directly.

### 2. Build the Core

- [x] Add initial workspace metadata and core modules under `packages/idle-learn/`.
- [x] Parse and serialize TOML configuration with strict validation and safe defaults.
- [x] Resolve the Git worktree root or retain the session's starting directory outside Git.
- [x] Implement atomic configuration and artifact storage without writes before opt-in.
- [x] Validate project paths, AGENTS.md targets, symlinks, and artifact schemas.
- [x] Implement collision-safe IDs, stale-content checks, apply, and reject.
- [x] Add cross-process project locking with heartbeats, stale recovery, and cleanup.
- [x] Test missing, paused, malformed, and concurrent configuration and artifact operations.

### 3. Build the Reviewer and Lifecycle

- [x] Add the bundled reviewer prompt and bounded response schema.
- [x] Implement project-only, bounded read-only evidence tools with no shell or write tools.
- [x] Snapshot model settings and resolve credentials without storing them in project files.
- [x] Resolve custom base and append prompt files without inheriting coding instructions.
- [x] Collect unseen entries on the current session branch and preserve omitted entries for later review.
- [x] Cancel on resumed work, configuration changes, navigation, and shutdown.
- [x] Bound duration, evidence size, tool output, and suggestion count.
- [x] Store successful results before advancing progress. Never advance on failure or cancellation.
- [x] Implement duplicate checks, rejection context, instruction audit hashes, and observation expiry.
- [x] Test isolation without model calls, using a controlled reviewer transport.

### 4. Build the Interface

- [x] Read the current extension and TUI API references and project design guidance.
- [x] Add opt-in confirmation, the command menu, quiet status, and pending counts.
- [x] Build configuration controls with inherited and explicit values.
- [x] Build the suggestion list, evidence and diff detail, apply, reject, and Analyze now.
- [x] Support narrow drill-down views, scrolling, resize, keyboard focus, and discoverable actions.
- [x] Test empty/error rendering, lifecycle analyzing/cancelled states, and stale/applied/rejected storage behavior.
- [x] Check rendered line bounds and keyboard behavior at 80x24, 120x40, and 200x60.
- [ ] Complete a manual terminal trial, including provider-specific behavior, light/dark themes, and a full better-interface domain review.

### 5. Verify the Package

- [x] Add package README and a minor Changeset.
- [x] Confirm pack output includes extension resources and excludes tests.
- [x] Run focused tests for the implemented configuration, storage, locking, and isolation modules.
- [x] Run `npm ci`, `npm run check`, and `npx changeset status` before any package commit.
- [x] Check implemented boundaries against the design. Record remaining manual verification below.

## Current Checkpoint

The extension is loadable from `packages/idle-learn/index.ts`. Commands, configuration, the review TUI, branch-aware analysis, and the isolated child worker are implemented.

The user requested a GitHub PR after the project trial and review-screen changes. PR preparation reran `npm ci`, `npm run check`, `npx changeset status`, and `git diff --check`. All checks pass, with 224 tests and a minor Changeset for Idle Learn. The package remains unpublished. Manual terminal/theme checks remain open.

A custom resource loader exposes no discovered resources. An offline test creates a real Pi 0.84.3 SDK session and checks its final prompt, tools, messages, extensions, and persistence.

Storage uses strict TOML, bounded UTF-8 reads, SHA-256 target snapshots, exact single-occurrence edits, and explicit displayed-suggestion checks. Pending artifacts move to applied or rejected storage only through host decisions. Exact normalized duplicates include rejected proposals.

`proper-lockfile` supplies independent review and storage leases. Heartbeats run every 10 seconds. Locks expire after 30 seconds without a heartbeat. Tests cover a competing Node process and recovery after SIGKILL. The worker must check its lease before saving results.

## Recommendation Writing

The bundled prompt applies `writing-for-agents` principles: context load, explicit pointers, information hierarchy, checkable completion criteria, positive instructions, and pruning. These are self-contained prompt rules, not ambient skill loading. The package README credits Amber and `writing-for-agents`. Prompt tests verify that the default worker receives these principles. Custom base prompt replacement remains an explicit user override.

## Chunked Review Follow-Up

A real project trial exposed that large tool results exhausted the first evidence batch before later user corrections. Implement overlapping chunks and automatic bounded continuation rather than reporting a partial batch as a completed session review.

- [x] Use entry-ID checkpoints and preserve branch-aware progress without a state migration.
- [x] Limit tool-result excerpts, prefer turn boundaries, and include bounded context overlap with original evidence IDs.
- [x] Continue through at most three chunks and three suggestions per run; expose remaining backlog and reschedule successful unfinished runs after the idle delay.
- [x] Preserve earlier successful checkpoints on later cancellation/failure, and suppress overlap-only suggestions.
- [x] Run regression, repository, and package checks; replay the reported session selection without model calls or project writes.

Follow-up validation: all 221 repository tests pass, including 55 Idle Learn tests. Full `npm run check`, `npx changeset status`, and `git diff --check` pass. Pack output includes `chunks.ts` and excludes tests. A read-only replay of the reported session selects all 29 entries in its first chunk, including the docs correction; the previous selector stopped at eight. Resuming the original eight-entry checkpoint selects the remaining 21 entries with three overlapping context entries. The replay made no model calls and no project writes.

## Review Screen Follow-Up

The interactive trial showed that width-bound tests did not ensure a usable composition: the empty review kept a full-height split pane and advertised unavailable actions.

- [x] Use `boxen` for rounded Unicode frames and native Pi `SelectList`/`HStack` for selection and composition.
- [x] Render an unsplit empty state capped at 84 columns, with only Analyze and Close actions.
- [x] Bound populated layouts to 132 columns and 28 body rows, distinguish panel focus, and show the proposed edit before long evidence.
- [x] Keep narrow drill-down navigation and remove focus hints when only one pane is visible.
- [x] Verify rendered empty, wide, narrow, focus, resize, error, and monochrome states; rerun package checks.

Follow-up validation: inspected component-rendered output for the reported empty state and populated wide/narrow views. Added regression tests for compact empty geometry, contextual actions, aligned rounded borders, edit-before-evidence ordering, reverse focus navigation, and monochrome escape stripping. All 224 repository tests pass, including 58 Idle Learn tests. Typechecking, pack checks, Changeset validation, diff checks, and extension loading through the installed Pi 1.4.0 SDK pass. An actual terminal/theme trial remains a manual check; rendered-line inspection does not establish color contrast or terminal-specific glyph appearance.

## Background Manual Review Follow-Up

The user approved non-blocking manual reviews in PR #50. Automatic idle reviews still cancel on resumed work; manual reviews continue against their captured snapshot.

- [x] Return to chat immediately after Analyze now and show progress in the existing footer.
- [x] Notify on completion or failure without opening a review screen.
- [x] Preserve manual reviews across chat/input/bash/agent events and when opening saved suggestions.
- [x] Retain explicit, navigation, shutdown, and configuration cancellation for both review modes.
- [x] Add discoverable Analyze now and Cancel review menu actions and matching subcommands.
- [x] Avoid competing idle timers during a manual review; restart idle scheduling after completion when idle.
- [x] Add integration tests for background launch, snapshot stability, cancellation boundaries, duplicate starts, completion, and provider errors.
- [x] Run full repository/package checks and installed Pi loader tests before updating PR #50.

Validation: `npm ci`, `npm run check`, `npx changeset status`, and diff checks pass. All 233 repository tests pass, including 67 Idle Learn tests. The installed Pi 1.4.0 SDK loader also passed the background-review integration suite. Tests confirm that a manual review captures its original entries, returns without a modal, survives resumed chat, reports completion without reopening UI, and rearms idle review for newer messages. Automatic reviews still cancel on resumed work. Live terminal/provider behavior remains a manual check.

The user subsequently approved project calibration with a default threshold of three ordinary rejections. Track the approved design and work in [Idle Learn Calibration](2026-10-28-idle-learn-calibration.md). The name-dice artifacts were inspected read-only; this implementation does not modify that project.

Calibration implementation checkpoint: `/idle-learn calibrate`, automatic calibration after three new ordinary rejections, a dedicated no-tool calibration prompt, typed Calibration items in the existing UI, exact preference-path validation, and approval-gated project reviewer preferences are implemented. All 260 repository tests pass, including 94 Idle Learn tests. Full package/type checks, Changeset validation, and installed Pi 1.4.0 loader integration pass. Package contents include `calibration-prompt.md` and exclude tests. Live calibration provider and manual terminal verification remain open.

## Verification Notes

At the initial implementation checkpoint, all 213 repository tests passed, including 47 Idle Learn tests. `npm ci`, full `npm run check`, `npx changeset status`, and `git diff --check` pass. Pack inspection confirms the extension, worker launcher, bundled prompt, README, and license are present, with no tests.

The actual Pi 1.4.0 extension loader loads the entry point and registers `/idle-learn`. The CLI command itself was blocked by the shell allowlist. A child-worker integration test uses a local mock streaming provider and confirms only the two evidence tools and no ambient instructions are sent. No live paid provider request was made.

Tests cover configuration confirmation and pause, review rendering and keyboard navigation, cancellation, malformed/fabricated evidence, prompt/model overrides, branch switching, weak-signal expiry, stale application, duplicate suppression, and lock recovery. These do not replace a manual terminal/theme review or live-provider trial. Extension-only registered providers are unavailable in the isolated worker and fail visibly.

`npm ci` reported five dependency vulnerabilities: one moderate, three high, and one critical. Install-script approval warnings remain. No automatic dependency fixes or script approvals were performed.

## Resume Instructions

Read the design and this plan. Inspect current files and Git status before continuing. Rebuild the task-ui projection from unfinished sections if it is absent. Update this plan before committing code or marking implementation tasks complete.
