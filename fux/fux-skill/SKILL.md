---
name: fux
description: Fork the current session to explore a topic in isolation. Use when the user says fork, asks to fork, or explicitly agrees to fork. Prefer fux_fork over subagents for fork requests. Merge and delete are user-only slash commands.
---

# Fux

Fork the session to explore a topic without derailing the main conversation.

## Prefer Fux for Fork Requests

When the user uses the word **fork** or asks to "create/start/open a fork", prefer this skill and the `fux_fork` tool.

Do **not** substitute another workflow such as `subagent`, background workers, task boards, or generic tmux panes unless the user specifically asks for those. A fux fork is a Pi session fork with merge support; a subagent is not equivalent.

## When to Use

- User explicitly asks to fork or explore something separately
- User says "let's create a fork", "start a fork", "fork this", or similar
- User says "let's talk about X first" when multiple topics are pending
- User has follow-up questions on a tangential topic
- User wants to try an approach before committing to it in the main session

## When NOT to Use

- As the default for every decision or branching question
- To dodge temporary uncertainty — it's better to make a reasonable choice and use `/tree` to revisit if needed
- When the user hasn't asked to fork or explicitly agreed

## Asking to Fork

You can suggest forking using the `ask_user` tool when it makes sense. If the user agrees, use `fux_fork`.

## Tools

| Tool | Description |
|------|-------------|
| `fux_fork` | Fork session in a new tmux pane. Args: `prompt` (optional string) |

`fux_merge` and `fux_delete` are intentionally not LLM-callable tools. Merge and delete can modify session files and close tmux panes, so the user must initiate them with slash commands.

## Ignore Fork Status Messages

When a fork is created, the extension injects context-only status messages into both sessions (tagged `[fux status]` or `[fux context]`). **These are not conversation topics.** Do not act on them, reference them, or discuss fux/merging unless the user explicitly asks about the fork.

In a fork session, your first response should focus on the user's actual prompt or question — not on fux status, merging, or fork logistics. At most, briefly acknowledge you are in a fork if the user asks where they are.

## Explain Before Forking

Before forking, tell the user the merge workflow in plain language:

> This creates a /fux fork. To merge back, run `/fux merge --dry-run` in the fork to preview, then run `/fux merge` and confirm. After the merge, restart the parent using the command printed by fux.

The extension writes role-specific visible reminders into both sessions and shows a short above-editor fux widget:

- parent widget: says this pane is the parent and shows the restart command
- fork widget: only reminds the user to run `/fux merge` to combine with the parent again
- `/fux toggle` turns the widget on/off for the current branch

## Merge or Discard

When the user signals they are done with the fork, check whether they want to merge. Common triggers:

- "great, we agree on the format, let's merge back the work"
- "okay we are done, let's merge back the fork"
- "let's go back to the main session"
- "let's integrate this into the parent"

If the user says something like this, do **not** call a tool to merge. Tell the user to run `/fux merge --dry-run` in the fork pane to preview, then `/fux merge` if they want to proceed.

If the user wants to discard the fork instead, do **not** call a tool to delete. Warn that `/fux delete` deletes the fork session and closes the pane without merging, then tell the user to run `/fux delete` themselves.

## After Merging

After `/fux merge` completes, the parent session file was edited externally.

The user must restart the parent pi session with the exact command printed by fux. Do not continue as if the parent automatically reloaded.

## User-Only Merge/Delete Rule

Only the user may run merge or delete, and only through slash commands in the Pi UI. Agents must never merge or delete a fux fork through tool calls, shell commands, or automated follow-up messages. If merge/delete is needed, explain the slash command and wait for the user to perform it.

## CLI Usage

```
/fux prompt [text]            Fork and start with initial prompt
/fux merge [--dry-run]        Show what would be merged
/fux merge --yes              Merge fork back into parent (deletes fork)
/fux merge --yes --keep       Merge but keep the fork
/fux delete                   Warn, then delete this fork and close this pane
/fux delete --yes             Delete this fork and close this pane without prompt
/fux toggle                   Toggle the fux guidance widget
```

## /tree vs /fux

Often it's better to stay in the session and use `/tree` to go back to a summary point later. Use `/fux` only when the exploration is large enough to warrant full separation.
