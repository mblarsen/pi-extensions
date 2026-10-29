# Guided analysis implementation

Approved design: ../specs/2026-10-29-idle-learn-guided-analysis-design.md

- [x] Capture a bounded suffix of recent session evidence, including reviewed entries.
- [x] Pass optional guidance to the reviewer without relaxing evidence checks.
- [x] Save proposals and observations without advancing ordinary checkpoints or audit hashes.
- [x] Parse direct command guidance and prompt from menu Analyze now and review-screen a.
- [x] Test Enter, Escape, guided command routing, evidence limits, validation, and checkpoint preservation.
- [x] Update README and add a minor Changeset.
- [x] Run npm ci, npm run check, npx changeset status, and git diff --check.

Verification before the first commit: 315 repository tests passed, typecheck passed, package content checks passed.

## Release prerequisite: installed worker loading

- [x] Reproduce worker loading from an npm tarball installed without SDK peers.
- [x] Pass the running Pi host package directory to the worker launcher.
- [x] Resolve SDK peer entrypoints from that host using ESM export conditions.
- [x] Test the installed tarball's analysis, calibration, refresh, and integration workers against a local mock provider.
- [x] Repeat the installed test against the user's Pi 1.4.0 host.
- [x] Add a package Changeset and document the regression test.

These tests install only into temporary directories and do not change the user's Pi configuration or installed extension. They do not call a real model provider. Full release checks run before committing the prerequisite fix.
