# @mblarsen/pi-idle-learn

## 0.3.0

### Minor Changes

- cf6aa65: Add optional guidance to `/idle-learn analyze`. Guided analysis revisits recent conversation, including previously reviewed entries, without advancing normal review progress. Analyze now from the menu and the review screen asks for optional guidance; submit an empty input for normal analysis or Escape to cancel.
- cf6aa65: Replace one-at-a-time Apply for instruction suggestions with batch integration. Select several suggestions, comment on them by number, and have the isolated reviewer combine them into one draft. Review the per-file diffs, regenerate as needed, then confirm Apply separately. Drafts may extract linked reference files within strict path limits. Apply is journaled and can be resumed after an interruption. Calibration items keep single-item Apply, with a refresh option for stale diffs.
  
  Suggestion generation and calibration no longer hold long-running locks. Agents can analyze the same repository and session concurrently, and progress and observations are merged when saved. Only one session at a time can integrate a given batch. Short storage locks protect shared writes.

### Patch Changes

- cf6aa65: Fix reviewer workers when Idle Learn is installed through Pi. Workers now load SDK peers from the running Pi host instead of requiring a separate SDK installation beside the extension.

## 0.2.1

### Patch Changes

- 9edf065: Declare host-provided packages as wildcard peer dependencies to avoid duplicate runtime modules and Pi extension warnings.

## 0.2.0

### Minor Changes

- 1005afd: Add opt-in idle session reviews with an isolated reviewer, configurable model and prompts, and a terminal interface for approving project AGENTS.md suggestions. Use writing-for-agents principles to produce concise, actionable instructions. Review large sessions in overlapping, resumable chunks, limit bulky tool output, and show the remaining backlog. Use compact empty states, rounded terminal frames, native selection controls, and contextual review actions. Run manual reviews in the background with footer progress and completion notifications while chat continues. Add analyze and cancel subcommands. Calibrate project reviewer preferences from accepted and rejected suggestions with a separate prompt and approval-gated Calibration items in the existing review UI. Add the calibrate command and an automatic threshold of three new rejections, configurable down to manual-only. Prevent delayed configuration notifications from cancelling newly started reviews, and show the cause when review or calibration is cancelled. Show the effective model and thinking level, including inherited or explicit settings, on their configuration menu rows. Keep session analysis out of populated suggestion review screens; retain it in the main menu and empty review state.
