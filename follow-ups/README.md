# follow-ups

Capture follow-up notes anchored to the nearest previous assistant message, then pop them back into the Pi chat input later.

Use it when the agent says something you want to revisit, but you do not want to interrupt the current flow.

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
      "extensions": ["follow-ups/index.ts"]
    }
  ]
}
```

## Usage

| Command | Description |
|---|---|
| `/follow-up` | Open a composer and save a follow-up anchored to the nearest previous non-empty assistant message. |
| `/follow-up list` | Open the follow-ups list for the current session. |

Follow-ups are stored in `.pi/follow-ups.jsonl` at the project root.

When not-done follow-ups exist, the footer status item with key `follow-up` shows `follow-up: <count>`.

## List controls

| Key | Action |
|---|---|
| `enter` | Pop selected follow-up into the chat input and mark it done. |
| `p` | Preview the anchored assistant message in a scrollable window. |
| `e` | Edit selected follow-up. |
| `ctrl-d` | Delete selected follow-up with confirmation. |
| `u` / `d` | Move selected follow-up up or down. |
| `tab` | Toggle between current-session and whole-project scope. |
| `n` | Create a new follow-up using the selected item’s anchor. |
| `j` / `k`, arrows | Navigate. |
| `q`, `escape`, `ctrl-c` | Close the list, or close preview mode when previewing. |

Done follow-ups stay in the list, move below active items, and are dimmed.

## Anchor model

Each follow-up stores:

- message text
- created timestamp
- session ID
- Pi tree node ID
- worktree/project root
- snippet of the anchored assistant message
- full anchored assistant text for previewing

The anchor search walks backward through the current session branch and skips empty or aborted assistant entries.

In preview mode, use `j`/`k` or arrows to scroll and `p`/`q`/`escape` to close.
