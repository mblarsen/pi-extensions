# fux

Fork a Pi session into a side tmux pane for tangential exploration, then merge changes back.

Provides the `/fux` slash command and the `fux_fork` LLM tool. Merge and delete remain slash-command-only for safety.

## Install

```bash
pi install git:github.com/mblarsen/pi-extensions
```

Filter to just this extension in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/mblarsen/pi-extensions",
      "extensions": ["fux/index.ts"],
      "skills": ["fux/fux-skill/SKILL.md"]
    }
  ]
}
```

## Usage

| Command | Description |
|---|---|
| `/fux` | Fork current session into a new tmux pane |
| `/fux prompt <text>` | Fork with an initial prompt sent to the child |
| `/fux merge [--dry-run] [--yes] [--keep\|--delete]` | Merge child fork back into parent |
| `/fux delete [--yes]` | Delete the child fork and close the pane |
| `/fux toggle` | Show or hide the fux guidance widget |

**LLM tool:** `fux_fork` — available to the agent to fork sessions programmatically.

## Workflow

1. Run `/fux` (or `/fux prompt <text>`) from the parent session.
2. A new tmux pane opens with a branched Pi session.
3. Work in the fork. Both sessions show a guidance widget with the restart command.
4. When done, run `/fux merge --dry-run` in the fork to preview, then `/fux merge` to confirm.
5. Restart the parent session with the printed command (e.g. `pi --resume <path>`).

The parent session file is modified externally during merge — you must restart pi to see the merged history.
