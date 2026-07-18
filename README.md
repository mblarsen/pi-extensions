# pi-extensions

Personal extensions for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

## Extensions

| Extension | Description |
|-----------|-------------|
| [continue-from](continue-from/) | Resume or nudge a stalled conversation. `/continue-from` with interactive picker + **Alt+C** keybinding. |
| [fux](fux/) | Fork a session into a side tmux pane for tangential exploration, then merge back into same tree. |
| [footer-manager](footer-manager/) | Toggle, reorder, and zen-mode the Pi status footer interactively. |
| [follow-ups](follow-ups/) | Capture notes—even during an active response—anchored to assistant messages, then pop them into the chat input later. |
| [slack-emojis](slack-emojis/) | Convert Slack/GitHub-style shortcodes like `:moon:` into emoji, with editor autocomplete. |
| [update-changelog](update-changelog/) | Interactive changelog viewer and updater for installed Pi packages. |
| [workmux-rename](workmux-rename/) | Rename the current workmux worktree and move the active Pi session with it. |

## Agent Skills

| Skill | Description |
|-------|-------------|
| [fux](fux/fux-skill/) | When the user says "fork", prefer `fux_fork` over subagents. |

## Install

```bash
pi install git:github.com/mblarsen/pi-extensions
```

To enable only a subset, filter in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/mblarsen/pi-extensions",
      "extensions": ["continue-from/index.ts", "fux/index.ts"],
      "skills": ["fux/fux-skill/SKILL.md"]
    }
  ]
}
```

See each extension's README for details.
