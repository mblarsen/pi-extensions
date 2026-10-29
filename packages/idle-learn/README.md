# Idle Learn

Review idle Pi sessions for useful project instructions. Select the lessons you want, and Idle Learn's reviewer integrates them into one reviewed `AGENTS.md` change that you apply separately. Calibrate project reviewer preferences from accepted and rejected suggestions, with the same approval flow.

## Inspiration

- [Amber](https://amber.benhid.dev/) inspired idle session reviews and evidence-based suggestions.
- The `writing-for-agents` skill guides recommendation writing: concise instructions, clear triggers, checkable completion criteria, and one source of truth.

These writing principles are part of the bundled reviewer prompt. The worker does not discover or load installed skills.
Idle Learn does not require Rex or Claude Code.

## Load

Use Pi 0.84.3 or later and Node.js 22.14 or later.

From this repository, install workspace dependencies with `npm ci`. Start Pi in the project you want to review:

```bash
pi -e /absolute/path/to/pi-extensions/packages/idle-learn/index.ts
```

After npm publication, install the package with `pi install npm:@mblarsen/pi-idle-learn`.

## Start

1. Run `/idle-learn init` in Pi.
2. Confirm the project path and model usage notice.
3. Work normally. Idle Learn reviews unseen session entries after ten idle minutes.
4. Run `/idle-learn review` to inspect saved suggestions.
5. Run `/idle-learn analyze`, choose Analyze now from the menu, or press `a` when the review screen has no pending suggestions.

Analyze now returns immediately to chat. The footer shows progress, and a notification reports completion.
Manual reviews continue against their captured snapshot while you chat. New messages wait for a later review.
Use `/idle-learn cancel` to stop a review. Completed chunks remain saved.

Nothing runs before project opt-in. Init creates `.pi/idle-learn/config.toml` and never overwrites an existing file.

Inside Git, the project is the current worktree root. Outside Git, the project is Pi's starting directory.

A committed enabled configuration also enables sessions in that checkout. Keep it untracked for local opt-in.

## Commands

| Command | Action |
| --- | --- |
| `/idle-learn` | Show project status, pending count, and menu |
| `/idle-learn init` | Confirm opt-in and create configuration |
| `/idle-learn analyze [guidance]` | Start a background review; optional guidance revisits recent conversation |
| `/idle-learn calibrate` | Propose project reviewer preferences from accepted/rejected suggestions |
| `/idle-learn review` | Inspect, select, integrate, or reject suggestions; apply Calibration items; analyze when no suggestions are pending |
| `/idle-learn cancel` | Stop the active review and pending idle timer |
| `/idle-learn config` | Change enable/pause, delay, calibration threshold, model, thinking, and prompt files |

In review, use Up/Down or `j`/`k` to select. At narrow widths, press Enter to open details.
At wide widths, press Tab or Shift+Tab to switch between list and details.
The review uses native Pi selection/layout components and `boxen` frames. Empty reviews stay compact; populated views cap their width for readable diffs and show only actions available in the current view.
Use Up/Down or Page Up/Page Down to scroll details. Press `r` to reject with an optional reason. Press Escape to return.

## Guided Analysis

Use `/idle-learn analyze include the guidance we just discussed` to focus a review on a specific topic. Guided analysis revisits the newest conversation on the current branch, including entries reviewed before, within the 48 KiB evidence budget. It does not scan the full history or advance normal analysis checkpoints. Guidance is limited to 8 KiB. Proposals still require transcript evidence and appear in the normal review list; nothing is applied automatically.

Pressing `a` in an empty review screen or choosing Analyze now from the menu asks for optional guidance. Enter with no text starts ordinary analysis of unseen entries. Escape cancels. Plain `/idle-learn analyze` starts ordinary analysis without a prompt.

## Integrating Suggestions

Ordinary suggestions are lessons, not patches to apply one at a time. Proposals from different sessions or agent roles often touch the same `AGENTS.md`, so they are combined before anything is written.

1. Press Space to select one or more suggestions. Selected items show `●`; unselected items show `○`. Selection writes nothing.
2. Press `i` to open the selection as a batch. With nothing selected, `i` uses the highlighted suggestion.
3. The batch view numbers each proposal (`#1`, `#2`, …) and shows its original diff, rationale, and evidence.
4. Press `c` to add comments, such as "Merge #1 and #3 under Testing".
5. Press `g` to integrate. The isolated reviewer combines the proposals, your comments, and the current files into one draft. It reports which proposals were already covered and any conflicts.
6. Review the summary, per-proposal notes, and the combined diff for each file.
7. Add comments and press `g` again to regenerate, or press `p` and confirm to apply.

Selecting proposals approves them as input. A successful Apply records every proposal in the batch as accepted and links it to the integration, including lessons the reviewer found already covered. Press `x` to remove a proposal from the batch, or `d` to discard the batch. Either way, those proposals stay pending. Proposal numbers never change, so earlier comments stay accurate.

Integration runs in a foreground screen. Press Escape to cancel it. Cancellation, failure, session navigation, configuration changes, and shutdown keep the batch, comments, and previous draft. Saved batches appear in the review screen; press `b` to reopen them.

The reviewer can extract detailed guidance into linked reference files when that keeps `AGENTS.md` navigable. It does not split files just because they are long. A draft may change only:

- the `AGENTS.md` targets of its proposals;
- existing Markdown files those targets already link to;
- up to three new Markdown files inside the linking `AGENTS.md` directory, which the drafted `AGENTS.md` must link to.

Drafts cannot change other `AGENTS.md` files, `.pi/`, symlinks, or paths outside the project. All files keep the 256 KiB limit.

Apply checks the draft, every proposal, and every file's hash under a short storage lock. If a file or proposal changed since the draft was generated, Apply is disabled until you regenerate and review again. Idle Learn never regenerates during Apply.
Apply journals its writes first. If it is interrupted, the batch shows as partially applied and never reports success. Press `b`, then `u`, to resume. Files already at the reviewed content are skipped, and a file someone else changed stops recovery.

Calibration items keep single-item review. Press `p` to apply or `f` to refresh a stale preference diff. Refresh sends the current preference file and the original proposal to the configured reviewer. It does not apply changes. Review the refreshed diff, then press `p` and confirm Apply separately.

Analyze is a session-wide action, not a proposal action. It is unavailable while suggestions are displayed, including Calibration items.

## Configuration

```toml
enabled = true
idle_minutes = 10

# Optional overrides. Omit these to follow the active session.
# provider = "anthropic"
# model = "claude-sonnet-4-5"
# thinking = "medium"

# Optional UTF-8 prompt files. Relative paths start at the project root.
# prompt_file = "reviewer.md"
# append_file = "reviewer-extra.md"

[calibration]
after_rejections = 3 # 0 = manual only; 1 = after each rejection
```

Provider and model must appear together. Thinking must be supported by the selected model. Idle delay accepts 1-1440 minutes.
Use `enabled = false` to pause new analysis without deleting progress or saved suggestions.

By default, each review uses the session's current provider, model, and thinking level.
The worker uses existing Pi credentials. It never writes credentials to project configuration.
Providers registered only by an extension are unavailable in the isolated worker. Configure them in Pi's `models.json` instead.
Missing models, credentials, or prompt files cause an error. Idle Learn never silently switches models.

The configuration screen can show the bundled and effective prompts.
A replacement file replaces the reviewer prompt. An append file extends that selected prompt, not Pi's coding prompt.
Prompt files must contain nonempty UTF-8 text and cannot exceed 32 KiB each.

## Calibration

Run `/idle-learn calibrate` or choose Calibrate reviewer from the menu. It returns immediately to chat, like Analyze now.
Calibration uses accepted/rejected ordinary suggestions (proposals applied through a batch count as accepted), rejection reasons, and the current project reviewer preferences. It does not review session transcripts.

Automatic calibration waits for three new ordinary rejections, then starts at the next configured idle window. Missing threshold configuration also uses three.
Set `calibration.after_rejections` to `0` for manual-only use, `1` after every rejection, or another whole number up to `1000`.
Accepted suggestions provide context but do not trigger automatic calibration.
Processed rejection IDs live in machine-local `state.json`; routine calibration does not rewrite configuration.
Failed or cancelled runs leave those IDs unprocessed. Successful zero-result runs consume only the rejection IDs they considered.

Calibration uses a dedicated bundled `calibration-prompt.md`, not Pi's coding prompt or the normal reviewer prompt.
Normal reviewer prompt replacements/appends do not affect calibration. The calibrator has no repository tools.
Existing preferences are evidence for calibration, not instructions that prevent their revision.

Proposals appear in the existing review list with a **Calibration** label, decision-ID evidence, and a preference-file diff.
Apply requires confirmation. Pending or rejected Calibration items do not change reviewer behavior.
Applied preferences extend future ordinary reviewer prompts for this project only; host validation and evidence thresholds remain in force.

A pending Calibration item suppresses further calibration until you apply or reject it.
Calibration decisions do not count toward the threshold or become future calibration input.
One run considers at most 30 decisions within a 96 KiB excerpt budget and proposes at most one combined preference edit.
Omitted rejections remain unprocessed. The preference file is limited to 32 KiB; the complete ordinary reviewer prompt is limited to 64 KiB.
Manual calibration continues while you chat or open Review suggestions. Automatic calibration cancels on resumed work.
Configuration changes, session navigation, reload, or explicit cancellation stop a running calibration. The review status shows the cancellation cause; run `/idle-learn calibrate` to retry.
A calibration started with new settings is not cancelled by a delayed notification for that earlier configuration change.
Calibration holds no long-running lock. If two calibrations race, only the first saves a Calibration item. Shared storage writes use short locks.

## Review Boundaries

The reviewer runs in a separate process with a fresh, nonpersistent session.
It receives no coding prompt, automatic project/global instructions, skills, extensions, MCP tools, or earlier model messages.
Project instructions and transcript text appear only as evidence. Their contents do not become reviewer instructions.

The reviewer has two bounded evidence tools: project file listing and project file reading.
It has no shell or write tools. Hidden directories, dependencies, generated files, and common key files are excluded from discovery.
Ordinary reviews can propose edits only to project `AGENTS.md` files, including nested or new files.
Calibration can target only `.pi/idle-learn/reviewer-preferences.md`.
Path validation rejects traversal, symlinks, hard links, and targets outside the project.

Each run reviews up to three chunks and produces at most three suggestions. Zero suggestions is normal.
Chunks use a 48 KiB transcript budget, including up to 8 KiB of overlap from the preceding two conversation turns. Idle Learn prefers turn boundaries and limits each tool-result entry to a 4 KiB excerpt so large outputs do not hide later user corrections.
Overlap preserves source entry IDs and does not count as repeated evidence. Successful chunks checkpoint their entry IDs; branch changes retain shared progress without skipping unseen branch entries.
The footer shows the active chunk. Results show entries reviewed and the remaining backlog. If the run limit leaves a backlog, analysis continues after another idle delay, or you can press `a` to resume sooner.
Weak evidence remains in observations for up to 60 days. Rejections help suppress repeated proposals.

Each chunk can last up to three minutes, with at most three worker calls per run.
Resuming work cancels automatic idle reviews, but manual reviews continue on their original snapshot.
Navigation, shutdown, configuration changes, and `/idle-learn cancel` stop either kind. Opening configuration also stops the active review.
Opening saved suggestions does not cancel a manual review. Reviews never open the review screen automatically.
Only successful storage advances progress. Completed chunks stay saved if a later chunk fails or is cancelled; the unfinished chunk remains available for the next review. Failures do not schedule automatic retries.
Oversized conversational entries cause an error instead of silent omission. Split large pasted messages before retrying. Tool-result excerpts retain their beginning and end and explicitly mark omitted content.
Suggestion generation holds no project-wide or per-session lock. Any number of agents can analyze the same repository and worktree concurrently, including the same session. Duplicate proposals are skipped, and progress and observations are merged when saved. Long-running coordination exists only per integration batch: one session at a time can integrate a given batch, without blocking other batches or analysis. Short storage locks protect suggestions, batches, decisions, and merged progress. Model calls never hold storage locks. A stopped owner's lock expires after 30 seconds.

Model reviews consume provider usage and send selected transcript and project evidence to that provider.
Do not enable analysis for projects whose evidence you cannot send to the selected provider.

## Local Files

Idle Learn stores configuration, suggestions, decisions, observations, and progress under `.pi/idle-learn/`.
Only quoted evidence appears in suggestion artifacts, not the complete session transcript.

Consider these `.gitignore` entries for machine-local data. Idle Learn does not change `.gitignore` itself:

```gitignore
.pi/idle-learn/state.json
.pi/idle-learn/observations.md
.pi/idle-learn/*.lock/
.pi/idle-learn/suggestions/
.pi/idle-learn/applied/
.pi/idle-learn/rejected/
.pi/idle-learn/batches/
```

Keep or ignore `config.toml` separately, according to the opt-in policy you want.
Keep or ignore `reviewer-preferences.md` separately, according to whether the project should share approved reviewer preferences.

## Checks

```bash
node --test packages/idle-learn/*.test.ts
npm run check
npx changeset status
```

Tests pack and install the actual npm tarball without SDK peer copies, then run all four worker modes against a local mock provider. Workers use SDK peers from the running Pi host.

Tests also cover SDK resource isolation, child workers with a local mock provider, concurrent session progress, batch integration and recovery, write-scope validation, stale-diff refresh, application races, and TUI recovery.
Manual terminal testing remains useful for provider-specific behavior and terminal themes.
