# continue-from

Resume or nudge a conversation that has paused or stalled.

Provides the `/continue-from` and `/nudge` slash commands, plus an **Alt+C** keybinding in the input editor.

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
      "extensions": ["continue-from/index.ts"]
    }
  ]
}
```

## Usage

| Command | Description |
|---|---|
| `/continue-from` | Interactive picker: nudge-only, agent, or user |
| `/continue-from nudge-only` | Send a hidden continue message (no rewind) |
| `/continue-from agent` | Rewind to the last assistant message and continue |
| `/continue-from user` | Rewind to the last user message |
| `/nudge` | Alias for `/continue-from nudge-only` |
| **Alt+C** | Quick shortcut for `/continue-from` |

## How it works

- **Nudge only** — sends a hidden control message prompting the agent to continue from its previous response without modifying session history.
- **Agent** — navigates the session tree to the last assistant message (or after its tool results) and sends a hidden nudge.
- **User** — rewinds to the last user message so you can edit and resend it.

When the last assistant message contains pending tool calls without corresponding tool results, the extension warns you and suggests using the user option instead.
