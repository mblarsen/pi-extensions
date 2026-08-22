# pi-extensions

Personal extensions for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

## Extensions

| Extension | Description |
|-----------|-------------|
| [burn-more-tokens](burn-more-tokens/) | Scroll a random successful-run message on AWTRIX and announce it with macOS `say` outside quiet hours. |
| [continue-from](continue-from/) | Resume or nudge a stalled conversation. `/continue-from` with interactive picker + **Alt+C** keybinding. |
| [fux](fux/) | Fork a session into a side tmux pane for tangential exploration, then merge back into same tree. |
| [ferd](ferd/) | Fork a session into a side Herdr pane for tangential exploration, then merge back into the same tree. |
| [footer-manager](footer-manager/) | Toggle, reorder, and zen-mode the Pi status footer interactively. |
| [follow-ups](follow-ups/) | Capture notes—even during an active response—anchored to assistant messages, then pop them into the chat input later. |
| [pi-observational-memory-leanctx-bridge](pi-observational-memory-leanctx-bridge/) | Index observational memories in Lean Context and persist exact cross-session evidence in SQLite-backed recall. |
| [slack-emojis](slack-emojis/) | Convert Slack/GitHub-style shortcodes like `:moon:` into emoji, with editor autocomplete. |
| [task-ui](task-ui/) | Backend-neutral task sidebar with presentation-only agent tools and `/task-ui` toggle. |
| [update-changelog](update-changelog/) | Interactive changelog viewer and updater for installed Pi packages. |
| [workmux-rename](workmux-rename/) | Rename the current workmux worktree and move the active Pi session with it. |

## Agent Skills

| Skill | Description |
|-------|-------------|
| [fux](fux/fux-skill/) | When the user says "fork", prefer `fux_fork` over subagents. |
| [ferd](ferd/ferd-skill/) | When the user says "fork", prefer `ferd_fork` over subagents while using Herdr. |

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
      "extensions": ["continue-from/index.ts", "ferd/index.ts"],
      "skills": ["ferd/ferd-skill/SKILL.md"]
    }
  ]
}
```

See each extension's README for details.
