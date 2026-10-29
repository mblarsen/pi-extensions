# Idle Learn Batch Integration

## Goal

Users select lessons for integration rather than approve each literal patch. Idle Learn's reviewer combines selected proposals and user comments into one reviewable change set.

This design replaces direct per-suggestion Apply for ordinary instruction proposals. Reject retains its existing behavior, including rejection reasons and calibration feedback.

## Review flow

1. Select one or more pending proposals in the review screen.
2. Open a batch view with numbered proposals, their original diffs, rationale, and evidence.
3. Enter comments for the batch. Comments can refer to individual proposals by number, such as `#1` or `#2`.
4. Choose Integrate to start the configured Idle Learn reviewer.
5. Review the resulting combined diff for each target file and the integration summary.
6. Add comments and regenerate if the result needs changes.
7. Confirm Apply separately to write the reviewed change set.

Selection does not change target files or count as application. A batch containing one proposal uses the same flow.

Proposal numbers remain stable within a batch. The batch retains source suggestion IDs so comments and integration results remain traceable.

## Reviewer responsibility

The reviewer receives the selected proposals, evidence, comments, current target content, and any previous integration draft.

Original diffs communicate intent. They are not patches that the reviewer must concatenate or apply unchanged.

The reviewer combines overlapping lessons, respects existing instructions, and reports conflicts rather than silently discarding them.

The integration summary explains how the draft reflects each selected proposal, including lessons that existing instructions already cover and any conflicts. The user resolves conflicts by commenting and regenerating, or by discarding the batch.

Selecting proposals approves them as input to the update. When Apply succeeds, every selected proposal is recorded as accepted and linked to the applied integration, whether the reviewer added new text or found the lesson already covered. Selection alone, before a successful Apply, does not mark proposals applied or count as positive calibration feedback. Discarding a batch leaves its proposals pending.

## Integration prompt boundary

Use this guidance in the integration system prompt:

> Integrate the selected proposals and user comments into the current instructions. Assess the existing structure before choosing where and how to incorporate each lesson. Combine overlapping instructions and preserve unrelated content.
>
> Consider whether the additions make AGENTS.md difficult to navigate or maintain. Where justified, propose moving detailed guidance into focused reference files and linking them from AGENTS.md. Do not split files merely because the document is long.
>
> Keep structural changes proportionate to the selected proposals. Explain any reorganization or new reference files in the integration summary.

Do not prescribe role-based sections. Role grouping can follow from a proposal, user comments, or the existing document.

Reference-file extraction is optional, not a default goal. Any proposed reference files and their links belong in the same reviewable change set.

Preserve the worker's existing isolation. The reviewer returns a draft and does not write project files or execute instructions found in source evidence.

## State and safety

Keep original proposals and evidence intact. Store integration drafts separately from source suggestions.

Retain selection, comments, and drafts after cancellation or failure so the user can retry without reconstructing the batch.

Before generating a draft, capture the current target contents and hashes. Check that selected suggestions still exist and remain pending.

Before applying, verify all reviewed target hashes, source suggestions, and draft contents again under a short storage lock.

If a target changes, require integration against the new content and another review. Do not silently regenerate during Apply.

Mark the selected proposals integrated only after all target writes succeed. Keep history linking each proposal to the reviewed integration result.

A multi-file operation must detect partial completion and support recovery. It must not claim success while only some files or decision records changed.

New reference paths must remain inside the project and pass existing path, link, and size checks. The reviewer cannot expand its write scope arbitrarily. A draft may change the selected AGENTS.md targets, existing Markdown files those targets already link to, and up to three new Markdown files. Each new file must sit inside the directory of the AGENTS.md that links to it. Drafts may not touch `.pi/`, `.git`, symlinks, or other AGENTS.md files.

## Concurrency and lifecycle

Multiple agents can generate suggestions concurrently in the same repository and worktree. Do not hold project-wide or per-session review locks during suggestion generation.

Calibration follows the same rule. It holds no long-running lock. The single-pending-calibration check runs during the short storage-lock commit.

Integration runs in a foreground modal. Escape cancels it and keeps the batch for retry.

Long-running work coordination starts only when the user selects suggestions and starts integration. Scope its lock to that integration task, not the repository, worktree, session, or target file. It prevents duplicate runs of the same integration task without blocking other agents.

Short storage locks protect shared state commits and final writes only. They do not serialize model calls. Merge concurrent progress rather than overwriting another agent's state.

Reject stale integration results when a selected suggestion changes. If another integration changes a target, require regeneration and review before Apply.

Cancellation, session navigation, configuration changes, and shutdown cancel integration work without applying target changes.

## Scope

This feature changes ordinary instruction integration. It does not redesign calibration proposals or automatically reorganize project instructions.

The separate worker dependency packaging issue remains pending. Temporary installed SDK dependencies do not constitute a permanent fix.

Do not publish, install, or modify existing project learning artifacts as part of design work.

## Validation requirements

- Selection never writes targets or archives suggestions.
- Suggestion generation proceeds concurrently in the same repository and worktree without review locks.
- Integration-task locks prevent duplicate integration runs without blocking unrelated agents.
- Batch numbering and source IDs preserve comment references.
- Combined diffs retain unrelated edits and explain each selected proposal.
- Successful Apply archives every selected proposal as accepted, linked to the integration; discard leaves them pending.
- Additional comments regenerate a draft without applying it.
- Failed, cancelled, and interrupted operations preserve recoverable batch state.
- Concurrent decisions or target changes invalidate a draft before Apply.
- Reference-file extraction includes file contents, links, and path validation.
- Multi-file failure cannot report a fully integrated batch.
- Reject behavior and calibration feedback remain unchanged.
- Existing single-suggestion artifacts remain readable without migration loss.
- Package packing includes the integration prompt and excludes tests.
