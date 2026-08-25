# ferd

Fork a Pi session into a parallel Herdr pane, explore independently, then merge the fork back at the marked leaf.

Provides the `/ferd` slash command and the `ferd_fork` LLM tool. Merge and delete remain slash-command-only for safety.

## Requirements

- Run Pi inside Herdr (`HERDR_ENV=1`).
- Keep the `herdr` CLI available in `PATH`.

## Install

```bash
pi install npm:@mblarsen/pi-ferd
```

## Usage

| Command | Description |
|---|---|
| `/ferd` | Fork the current session into a new Herdr pane |
| `/ferd prompt <text>` | Fork and send an initial prompt to the child |
| `/ferd merge [--dry-run] [--yes] [--keep\|--delete]` | Merge the child fork back into the parent |
| `/ferd delete [--yes]` | Delete the child fork and close its Herdr pane |
| `/ferd toggle` | Show or hide the ferd guidance widget |

**LLM tool:** `ferd_fork` — lets the agent create a fork programmatically.

## Workflow

1. Run `/ferd` or `/ferd prompt <text>` in the parent session.
2. Ferd splits the current Herdr pane and starts the branched Pi session there.
3. Work in the fork. Both sessions show a guidance widget.
4. Run `/ferd merge --dry-run` in the fork, then `/ferd merge` to confirm.
5. Restart the parent session with the command printed by ferd.

The parent session file is modified externally during merge. Restart Pi before continuing in the parent.
