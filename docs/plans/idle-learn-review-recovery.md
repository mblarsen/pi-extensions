# Idle Learn Review Recovery

## Follow-up design

The batch integration design in `docs/superpowers/specs/2026-10-29-idle-learn-batch-integration-design.md` replaces the per-suggestion Apply flow described below.
The checked items record the earlier implementation, not completion of batch integration.
Concurrent analysis, short storage locks, state merging, and retry safety remain requirements.
The per-session review lock and the calibration lock below were later removed. Suggestion generation now holds no long-running locks, and only an integration batch is locked while it runs.

## Approved behavior

- Keep failed suggestions pending, selected, and visible in the review screen.
- Refresh stale edits with the configured reviewer model, preserving original evidence and target.
- Present the refreshed diff before a separate Apply confirmation.
- Recheck the target and pending artifact under a short storage lock before saving or applying.
- Allow different sessions to analyze concurrently; serialize same-session analysis and calibration separately.
- Merge progress and observations under the storage lock, without holding it during model calls.
- Do not change existing project artifacts or undo applied instructions during development.

## Work

- [x] Add refresh transport, validation, and storage tests.
- [x] Add retryable review UI and lifecycle cancellation.
- [x] Add per-session review locking and concurrent state-merge tests.
- [x] Update package documentation and add a minor changeset.
- [x] Run dependency installation, full checks, and Changesets validation.

## Validation

- `npm ci` completed. The audit still reports five dependency vulnerabilities.
- `npm run check` passed type checking, 283 tests, and package packing.
- Package packing includes the refresh prompt and implementation, and excludes tests.
- `npx changeset status` reports a minor release for pi-idle-learn.
- `git diff --check` passed.
- One earlier full-suite run hit an existing three-second configuration-watcher test timeout. Subsequent full-suite runs passed.
- The current project suggestion records and applied target files were not changed.
- The code is not committed, published, or installed in the active Pi/PiG copies.

The separate worker SDK packaging issue remains outside this change; temporary installed dependencies remain in place.
