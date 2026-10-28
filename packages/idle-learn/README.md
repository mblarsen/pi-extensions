# Idle Learn

Review idle Pi sessions for useful project instructions. Approve each proposed change before Idle Learn updates an `AGENTS.md` file.

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
5. Press `a` in the review screen to analyze now.

Nothing runs before project opt-in. Init creates `.pi/idle-learn/config.toml` and never overwrites an existing file.

Inside Git, the project is the current worktree root. Outside Git, the project is Pi's starting directory.

A committed enabled configuration also enables sessions in that checkout. Keep it untracked for local opt-in.

## Commands

| Command | Action |
| --- | --- |
| `/idle-learn` | Show project status, pending count, and menu |
| `/idle-learn init` | Confirm opt-in and create configuration |
| `/idle-learn review` | Inspect, apply, reject, or analyze now |
| `/idle-learn config` | Change enable/pause, delay, model, thinking, and prompt files |

In review, use Up/Down or `j`/`k` to select. At narrow widths, press Enter to open details.
At wide widths, press Tab or Shift+Tab to switch between list and details.
The review uses native Pi selection/layout components and `boxen` frames. Empty reviews stay compact; populated views cap their width for readable diffs and show only actions available in the current view.
Use Up/Down or Page Up/Page Down to scroll details. Press `p` to apply, `r` to reject, or Escape to return.
Apply asks for confirmation and checks the displayed suggestion and current target again. Reject accepts an optional reason.

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

## Review Boundaries

The reviewer runs in a separate process with a fresh, nonpersistent session.
It receives no coding prompt, automatic project/global instructions, skills, extensions, MCP tools, or earlier model messages.
Project instructions and transcript text appear only as evidence. Their contents do not become reviewer instructions.

The reviewer has two bounded evidence tools: project file listing and project file reading.
It has no shell or write tools. Hidden directories, dependencies, generated files, and common key files are excluded from discovery.
Only project `AGENTS.md` files can receive proposed edits, including nested or new files.
Path validation rejects traversal, symlinks, hard links, and targets outside the project.

Each run reviews up to three chunks and produces at most three suggestions. Zero suggestions is normal.
Chunks use a 48 KiB transcript budget, including up to 8 KiB of overlap from the preceding two conversation turns. Idle Learn prefers turn boundaries and limits each tool-result entry to a 4 KiB excerpt so large outputs do not hide later user corrections.
Overlap preserves source entry IDs and does not count as repeated evidence. Successful chunks checkpoint their entry IDs; branch changes retain shared progress without skipping unseen branch entries.
The review screen shows the active chunk. Results show entries reviewed and the remaining backlog. If the run limit leaves a backlog, analysis continues after another idle delay, or you can press `a` to resume sooner.
Weak evidence remains in observations for up to 60 days. Rejections help suppress repeated proposals.

Each chunk can last up to three minutes, with at most three worker calls per run. Work resumption, navigation, shutdown, and configuration changes cancel active reviews.
Only successful storage advances progress. Completed chunks stay saved if a later chunk fails or is cancelled; the unfinished chunk remains available for the next review. Failures do not schedule automatic retries.
Oversized conversational entries cause an error instead of silent omission. Split large pasted messages before retrying. Tool-result excerpts retain their beginning and end and explicitly mark omitted content.
A project lock prevents overlapping reviewers across Pi processes. A stopped owner's lock expires after 30 seconds.

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
```

Keep or ignore `config.toml` separately, according to the opt-in policy you want.

## Checks

```bash
node --test packages/idle-learn/*.test.ts
npm run check
npx changeset status
```

Tests cover the real SDK resource boundary, a child worker with a local mock provider, project locks, stale application, and TUI layouts.
Manual terminal testing remains useful for provider-specific behavior and terminal themes.
