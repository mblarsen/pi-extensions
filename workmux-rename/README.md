# workmux-rename

Rename the current [workmux](https://github.com/raine/workmux) worktree without leaving the active Pi conversation behind.

## Usage

| Command | Description |
|---|---|
| `/workmux-rename <new-name>` | Rename the current worktree and move this Pi session into its new directory |
| `/workmux-rename --branch <new-name>` | Also rename the underlying git branch |
| `/workmux-rename -b <new-name>` | Short form of `--branch` |

The extension intentionally supports only workmux's current-worktree form. Renaming another worktree cannot meaningfully move the current Pi session with it.

## How it works

1. Captures the linked worktree's stable Git admin directory.
2. Runs `workmux rename [--branch] <new-name>` with argument-safe process execution.
3. Resolves the renamed directory from Git's updated `gitdir` pointer, avoiding stale process cwd values.
4. Writes a complete live-session snapshot into Pi's session bucket for the renamed directory, including fresh sessions Pi has not flushed to disk yet.
5. Relaunches Pi in the renamed directory and trashes the old session after the replacement starts.

This follows the lifecycle used by `pi-move-session`. If the current `/tree` selection is not the persisted branch tip, the command warns before renaming because the replacement reopens at the persisted tip.

## Requirements

- `workmux` available on `PATH`
- A persisted Pi session
- A non-main workmux worktree
- `trash` is recommended; without it, the original session file is retained rather than permanently deleted

## Install

Install the repository package:

```bash
pi install git:github.com/mblarsen/pi-extensions
```

Then run `/reload` or restart Pi.
