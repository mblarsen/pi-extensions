# Idle Learn

Date: 2026-10-28
Status: Approved for implementation
Package: `@mblarsen/pi-idle-learn`

## Purpose

Learn from project sessions when Pi is idle. Suggest changes to project instructions. Let the user review every change before application.

The reference is [Amber](https://amber.benhid.dev/) and its [source](https://github.com/benhid/rex-amber). This extension does not require Rex or Claude Code.

## Scope

Ordinary reviews suggest changes to project `AGENTS.md` files, including nested files. Calibration proposes approval-gated project reviewer preferences in `.pi/idle-learn/reviewer-preferences.md`. Neither changes global instructions or creates skills.

The extension uses the upstream Pi extension API used by this repository. PiG compatibility requires separate API verification. Do not assume upstream Pi flags also work in PiG.

## Commands

Use one command namespace:

- `/idle-learn`: show a menu with Review suggestions, Configuration, status, and the pending count.
- `/idle-learn init`: ask for project opt-in, then create configuration.
- `/idle-learn analyze`: start a manual background review without the idle delay.
- `/idle-learn calibrate`: start a manual background calibration from ordinary acceptance/rejection history.
- `/idle-learn review`: open saved suggestions and offer Analyze now.
- `/idle-learn config`: edit configuration through a TUI.
- `/idle-learn cancel`: cancel the active review and pending idle timer.

Analyze now requires project opt-in and must not overlap another project review. It closes the review screen and returns immediately to chat. Show progress in the footer and notify on completion without opening another screen. Manual reviews continue against their captured snapshot when chat resumes. New entries wait for a later review.

## Project opt-in

The explicit opt-in marker is `.pi/idle-learn/config.toml`:

```toml
enabled = true
idle_minutes = 10
```

Resolve the project directory at the Git worktree root. Outside Git, use the session's starting directory. Never search parent directories for opt-in.

Missing configuration means disabled. Do not start background model calls or create project files without opt-in.

`enabled = false` pauses analysis. Preserve existing suggestions and progress. The user can still review saved suggestions.

Init explains that transcript reviews send project evidence to the selected model and consume model usage. It requires confirmation and never overwrites configuration.

The file can remain untracked for local use or be committed for team use. A committed enabled configuration opts in sessions using that checkout.

Treat malformed configuration as disabled. Show an actionable error instead of using enabled defaults.

## Reviewer model

Default to the active session's provider, model, and thinking level at the start of each review.

Configuration allows explicit provider/model selection and a supported thinking level. Show Follow current session as a reset option.

Select provider and model as a valid pair. Only offer thinking levels supported by that model. Report unavailable models or credentials without silent fallback.

Use the configured provider's existing credentials. Never store credentials in project configuration.

## Reviewer prompt and isolation

The reviewer starts fresh. It does not continue the interactive session.

Use the extension's system prompt, with these options:

1. View the bundled prompt and the effective prompt.
2. Replace the bundled prompt with a UTF-8 file.
3. Append a UTF-8 file after the selected base prompt.
4. Reset to the bundled prompt without an append.

Thus, the ordinary effective system prompt is the selected base prompt plus the optional user append and approved project reviewer preferences. Append does not extend Pi's general coding prompt.

Resolve prompt-file paths relative to the project directory. Do not silently ignore missing or unreadable files.

Disable session persistence, skills, extensions, unrelated resource discovery, and inherited project and global instructions in the reviewer.

Verified CLI controls include `--no-session`, `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-themes`, and `--no-context-files`. Disable MCP where supported. `--system-prompt` accepts text or an existing file path. It replaces the coding preamble, but does not disable context-file discovery.

`--no-context-files` prevents automatic `AGENTS.md` and `CLAUDE.md` injection. Files supplied deliberately remain evidence, not instructions. State this rule explicitly in the reviewer prompt.

Built-in read-only tools do not restrict access to the project. Use host-restricted evidence tools through an isolated SDK worker. Verify isolation against the repository dependency, not only the installed CLI.

Provide the transcript, relevant project instructions, previous suggestions, rejections, and observations as evidence. Do not interpret their contents as reviewer instructions.

Use a bounded, read-only repository evidence interface. The reviewer must not have arbitrary shell execution or write access.

The extension validates reviewer output and writes suggestion artifacts. Prompt customization cannot remove path restrictions, output validation, or user approval.

## Idle lifecycle

1. After Pi finishes a response, start the idle timer.
2. Reset the timer when another turn starts.
3. After ten quiet minutes, snapshot the current branch and model settings.
4. Acquire a project review lock and analyze unseen entries.
5. If the user starts another turn, cancel an automatic idle review and discard its uncommitted results. Keep a manually started review running.
6. After successful validation and storage, advance review progress.

Run at most one reviewer per project across Pi processes. Recover stale locks after worker termination.

Identify reviewed entries by session and branch ancestry, not a transcript byte offset. Branches must not cause skipped or duplicate evidence.

Each successful chunk advances progress independently. Failures and cancellation leave the unfinished chunk unreviewed and retain completed chunks. Do not loop automatically on failures while no new activity occurs.

### Chunked backlog review

Use a 48 KiB transcript budget per chunk, reserving up to 8 KiB for overlap from the preceding two conversation turns. Prefer turn boundaries; split exceptionally large turns at entry boundaries. Fail visibly for a conversational entry that exceeds the new-evidence budget. Bound each tool-result entry to a 4 KiB beginning/end excerpt with an explicit omission marker.

Treat reviewed session/entry IDs as branch-aware checkpoints. Include overlap only from the current branch, preserve its source IDs, and never count a repeated appearance as independent evidence. New suggestions must cite new evidence unless this is a changed-instruction audit.

Continue automatically through at most three chunks and three suggestions per run. Snapshot entries and model settings once per run. Each chunk retains the three-minute timeout. Show the active chunk, reviewed-entry count, and remaining backlog. When a successful run reaches its limit with work left, schedule another run after the configured idle delay; Analyze now can resume sooner. Resumed activity cancels automatic idle runs and pending continuation timers. Manual runs continue on their original snapshot. Navigation, shutdown, configuration changes, and explicit cancellation stop either kind. Do not schedule competing reviews while a run is active. When a manual run finishes while Pi is idle, restart the idle timer so newer entries can be reviewed later.

Bound worker duration and evidence size. Never mark omitted entries as reviewed. Surface failures through status without interrupting normal conversation.

Review only sessions observed by the running extension. V1 does not scan all historical sessions or continue after Pi exits.

## Evidence rules

Use Amber's evidence categories:

- Correction: one clear user correction, rejection reason, or redirection.
- Repeated instruction: at least two instances in the conversation.
- Difficult discovery: the same avoidable discovery in two distinct sessions.
- Broken rule: the same instruction failure in two distinct sessions.
- Outdated instruction: direct repository evidence that an instruction is false or contradictory.

Audit outdated instructions when their content changes. Global memory imports are outside V1.

Every suggestion needs quoted evidence, future relevance, and repository verification where applicable.

Reject duplicates of existing instructions, pending suggestions, or rejected suggestions. Rejection reasons also exclude similar proposals.

Produce at most three independent suggestions per review. Zero suggestions is normal.

Store weak signals across sessions. Expire unconfirmed observations after 60 days. Remove observations when they become suggestions.

Place folder-specific instructions in that folder's `AGENTS.md`. Otherwise use the root `AGENTS.md`. Suggest new files only within the project.

## Project Reviewer Calibration

See [the approved calibration design and implementation checklist](2026-10-28-idle-learn-calibration.md).

Default to automatic calibration after three new ordinary rejections, at the next idle window. Configure `[calibration].after_rejections` from 0 to 1000; zero is manual-only. The manual command bypasses the threshold. Keep processed rejection IDs in local state, not configuration.

Use a dedicated bundled calibration prompt, no ordinary reviewer overrides, no transcript evidence, and no repository tools. Existing preferences are evidence for calibration, not calibrator instructions. Consider both ordinary acceptance and rejection decisions; never feed calibration decisions back into calibration.

Propose at most one combined edit to the exact reviewer-preferences.md path, with exact decision-ID quotations. Label the item Calibration in the existing list/detail UI. Require normal explicit approval and stale-target checks before it affects future reviews. Pending items suppress further calibration. Successful runs checkpoint only included rejection IDs; failures and cancellation retain them for retry.

Bound decision context to 30 records and 96 KiB of excerpts. Prioritize unprocessed rejections, then recent supporting ordinary decisions. Keep omitted rejection IDs unprocessed. Preferences are limited to 32 KiB and ordinary effective prompts to 64 KiB. A shared project review lease excludes concurrent ordinary and calibration workers.

## Storage

Keep configuration separate from review artifacts:

```text
.pi/idle-learn/config.toml
.pi/idle-learn/reviewer-preferences.md
.pi/idle-learn/suggestions/<id>.md
.pi/idle-learn/rejected/<id>.md
.pi/idle-learn/applied/<id>.md
.pi/idle-learn/observations.md
.pi/idle-learn/state.json
```

Suggestion files contain target path, source session and entry references, creation time, title, evidence, and a proposed diff.

State contains local transcript progress, audit hashes, and processed calibration rejection IDs. Separate lock directories carry the review/storage leases. Recommend ignoring machine-local state. Do not modify `.gitignore` without confirmation.

Do not persist the complete transcript in suggestion files. Save only the evidence needed for review.

Use atomic writes and collision-safe suggestion IDs. Reject traversal, absolute targets, and symlink escapes. Ordinary reviews can target only project AGENTS.md files. Host-selected calibration output can target only the exact project reviewer-preferences.md path.

## Review interface

Use the project's Pi TUI components and theme tokens. Apply `tui-design` and review the finished flow with `better-interface` and its domain skills.

The review screen shows a suggestion list and a detail view with target, evidence, and diff. Narrow terminals use a single-pane drill-down flow.

Offer Apply, Reject, optional rejection reason, and Analyze now. Escape closes the screen without changing suggestions.

Apply requires an explicit action for the displayed suggestion. Recheck file content before writing. Mark changed targets as stale instead of forcing patches.

Validate each suggestion against the current target, including after another suggestion changes it. Never overwrite unrelated edits.

Show pending counts quietly. Do not open review screens automatically.

Support keyboard-only operation, visible focus, discoverable actions, scrolling, resize, and monochrome meaning. Verify at 80x24 and larger sizes.

Include empty, analyzing, cancelled, error, stale, applied, and rejected states. Errors explain how to recover.

## Configuration interface

Expose enable/pause, idle delay, calibration rejection threshold, provider/model/thinking, and ordinary prompt replacement/append files.

Show inherited versus explicit values clearly. Show the effective model and prompt without exposing credentials.

Save configuration atomically. Invalid edits must not replace working configuration. Configuration changes cancel active analysis before new settings take effect.

## Verification

Test opt-in defaults, configuration validation, idle timing, cancellation, lock contention, and branch-aware progress.

Test model inheritance and overrides, unsupported thinking levels, missing credentials, and effective prompt construction.

Verify worker isolation through integration tests. Test read-only evidence access and restricted target validation independently of the prompt.

Test malformed worker output, retries, duplicate suppression, observations, rejection reasons, stale diffs, and concurrent file edits.

Test TUI navigation, resize, scrolling, and every result state. Inspect the rendered review and configuration flows.

Add a minor Changeset for the new package. Include extension resources in pack checks and exclude tests.

Before a package commit, run `npm ci`, `npm run check`, and `npx changeset status`.

## Implementation gate

The user approved implementation after confirming reviewer isolation and evidence handling. Track implementation and verification in `docs/plans/2026-10-28-idle-learn-implementation.md`.
