---
"@mblarsen/pi-idle-learn": minor
---

Replace one-at-a-time Apply for instruction suggestions with batch integration. Select several suggestions, comment on them by number, and have the isolated reviewer combine them into one draft. Review the per-file diffs, regenerate as needed, then confirm Apply separately. Drafts may extract linked reference files within strict path limits. Apply is journaled and can be resumed after an interruption. Calibration items keep single-item Apply, with a refresh option for stale diffs.

Suggestion generation and calibration no longer hold long-running locks. Agents can analyze the same repository and session concurrently, and progress and observations are merged when saved. Only one session at a time can integrate a given batch. Short storage locks protect shared writes.
