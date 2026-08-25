# pi-extensions

Independent npm packages for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

## Packages

| Package | Description |
|---|---|
| [`@mblarsen/pi-burn-more-tokens`](packages/burn-more-tokens/) | Send successful-run messages to AWTRIX and macOS speech. |
| [`@mblarsen/pi-continue-from`](packages/continue-from/) | Resume or nudge a stalled conversation. |
| [`@mblarsen/pi-ferd`](packages/ferd/) | Fork Pi into a Herdr pane and merge the session later. |
| [`@mblarsen/pi-follow-ups`](packages/follow-ups/) | Save follow-up notes for assistant messages. |
| [`@mblarsen/pi-footer-manager`](packages/footer-manager/) | Toggle, reorder, and simplify the Pi status footer. |
| [`@mblarsen/pi-fux`](packages/fux/) | Fork Pi into a tmux pane and merge the session later. |
| [`@mblarsen/pi-observational-memory-leanctx-bridge`](packages/pi-observational-memory-leanctx-bridge/) | Store observational memories in Lean Context with exact evidence recall. |
| [`@mblarsen/pi-session-handoff`](packages/session-handoff/) | Warn when a session is expensive or stale enough to hand off. |
| [`@mblarsen/pi-slack-emojis`](packages/slack-emojis/) | Convert Slack and GitHub emoji shortcodes. |
| [`@mblarsen/pi-task-ui`](packages/task-ui/) | Show backend-neutral task state in a Pi sidebar. |
| [`@mblarsen/pi-update-changelog`](packages/update-changelog/) | View changelogs and update installed Pi packages. |
| [`@mblarsen/pi-workmux-rename`](packages/workmux-rename/) | Rename a workmux worktree and move its Pi session. |

The `fux`, `ferd`, and `task-ui` packages include their Agent Skills.

## Install

Install only the packages that you need:

```bash
pi install npm:@mblarsen/pi-task-ui
pi install npm:@mblarsen/pi-fux
```

Run `/reload` or restart Pi after installation.

See each package README for its requirements and commands.

## Development

Install dependencies and run all checks:

```bash
npm ci
npm run check
```

Add a changeset for each user-visible package change:

```bash
npm run changeset
```
