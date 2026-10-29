# Guided analysis implementation

Approved design: ../specs/2026-10-29-idle-learn-guided-analysis-design.md

- [x] Capture a bounded suffix of recent session evidence, including reviewed entries.
- [x] Pass optional guidance to the reviewer without relaxing evidence checks.
- [x] Save proposals and observations without advancing ordinary checkpoints or audit hashes.
- [x] Parse direct command guidance and prompt from menu Analyze now and review-screen a.
- [x] Test Enter, Escape, guided command routing, evidence limits, validation, and checkpoint preservation.
- [x] Update README and add a minor Changeset.
- [x] Run npm ci, npm run check, npx changeset status, and git diff --check.

Verification: 315 repository tests pass, typecheck passes, package content checks pass. No real model calls or installation performed.
