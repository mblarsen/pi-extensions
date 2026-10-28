# Idle Learn Calibration

Date: 2026-10-28
Status: Implemented and verified for PR #50; live terminal/provider trial remains open.

## Approved Behavior

`/idle-learn calibrate` reviews this project's ordinary accepted/rejected suggestions, rejection reasons, and existing reviewer preferences. It runs in the background and proposes reviewer preference changes, not AGENTS.md edits.

Use the existing review list, detail, diff, and Apply/Reject actions. Label these items Calibration in the list and detail. Their only valid target is `.pi/idle-learn/reviewer-preferences.md`. Applying a calibration changes future review criteria for this project. Pending or rejected calibrations do not change reviewer behavior.

Calibration is event-triggered, not continuous. Default to three new ordinary rejections:

```toml
[calibration]
after_rejections = 3
```

Zero disables automatic calibration but retains the manual command. One allows calibration after every rejection. Accept values from 0 to 1000. Missing configuration uses three. Store policy in config.toml and processed rejection IDs in machine-local state.json. Never update configuration as routine bookkeeping.

At the next idle window, run calibration if enough unprocessed ordinary rejection IDs exist. Consider both accepted and rejected ordinary decisions. Do not count calibration decisions. Do not start another calibration while one is active or pending approval. Explicit requests bypass the threshold, not opt-in, project locks, pending-item suppression, or safety checks.

## Boundaries

- Use the same isolated worker, configured model/thinking, project review lease, timeout, cancellation, and cost bounds.
- Supply bounded decision excerpts and the current preference snapshot as data. The calibration worker receives no repository tools or normal reviewer prompt overrides.
- Use a dedicated calibration system prompt. Existing preferences are evidence during calibration, not instructions to the calibrator.
- Return at most one combined preference edit with exact decision-ID quote evidence. Zero changes is normal.
- Infer a preference, not a blanket prohibition. An isolated feature rejection does not establish that all domain-specific guidance is unwanted.
- Preserve ordinary AGENTS.md path restrictions. Only host-selected calibration output can target the exact preference path.
- Applying an item rechecks its displayed artifact and target snapshot. Preserve symlink, hard-link, traversal, size, and atomic-write protections.
- Validate configuration, source decisions, preference snapshot, lease, and cancellation before saving. Advance only the included rejection IDs after successful storage, including successful zero-result runs.
- New rejections during a run remain unprocessed. Failures and cancellation do not advance their checkpoint.
- Retain calibration decisions for provenance and duplicate suppression, but exclude them from future calibration input and ordinary suggestion history.
- Append approved project preferences to future ordinary reviewer prompts. They cannot relax host validation or write permissions.
- Manual calibration continues while chat resumes. Automatic calibration cancels on resumed work. Explicit cancellation, navigation, shutdown, and configuration changes stop either kind.
- After successful automatic calibration, return to ordinary idle scheduling. Do not automatically retry failed calibration on a timer.

## Implementation Checklist

- [x] Add strict threshold configuration and backward-compatible calibration progress.
- [x] Add typed calibration artifacts with exact preference-path dispatch and shared safe approval/archive handling.
- [x] Add bounded decision selection, quote validation, checkpointing, and isolated calibration execution.
- [x] Append only applied project preferences to ordinary reviewer prompts.
- [x] Wire manual/automatic calibration, shared job exclusion, status, and labeled review items.
- [x] Test opt-in, thresholds, retries, shared project-lock exclusion, decision provenance, invalid targets, stale/symlink/hard-link targets, and approval gating. The underlying lock already has a cross-process regression test.
- [x] Test command/menu flow, idle scheduling, cancellation modes, and label rendering without a separate screen.
- [x] Update README, design, implementation plan, Changeset, and package resources.
- [x] Run npm ci, full checks, Changeset validation, installed Pi loader tests, and package-content inspection.
- [x] Prepare the PR #50 update and verify the staged diff before committing.

## Verification Checkpoint

All 260 repository tests pass, including 94 Idle Learn tests. `npm ci`, `npm run check`, `npx changeset status`, and diff checks pass. The installed Pi 1.4.0 SDK loader and all 13 entry-point integration tests pass. Package inspection includes the dedicated calibration prompt and modules and excludes tests.

A real child-worker integration test exercises both normal review and calibration against a local mock provider. Calibration sends the separate system prompt with no tools, no normal review instructions, and no ambient resources. Tests cover default/manual thresholds, bounded decision excerpts, untouched project config, checkpoint preservation and retry, concurrent new rejections, source edits, typed target validation, stale and symlink/hard-link protection, shared lock exclusion, prompt overrides, label rendering, explicit approval, and idle/manual cancellation semantics.

No live paid calibration request or manual terminal calibration trial was performed. name-dice remains unchanged. npm reports the existing five dependency vulnerabilities and install-script approval warnings; no unrelated dependency fixes or script approvals were applied.
