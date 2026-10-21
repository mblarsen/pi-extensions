# @mblarsen/pi-assistant-jump

Jump the fullscreen transcript to the previous or next message.

Pi already jumps between prompts with `tui.altScreen.previousPrompt` and
`nextPrompt` (`ctrl+shift+up` / `ctrl+shift+down` on macOS and Linux). Those
jumps land on OSC 133 zone starts, and an assistant block only emits that zone
when the turn made no tool calls. Replies produced while tools run, and the
final reply after a steer, are therefore skipped.

This extension does its own row maths over the live transcript component tree,
so it lands on every reply, and it lands on the **text** rather than on the top
of the message. Turns that only thought or only called tools have no reply to
read, so they are not stops. Your own prompts are stops as well: in a
tool-heavy session most assistant turns carry no prose, and the prompts are what
give the jumps a readable cadence. Nothing is re-rendered, copied, or
duplicated: it scrolls the transcript you already have.

## Install

```bash
pi install npm:@mblarsen/pi-assistant-jump
```

Restart Pi, or run `/reload`.

## Usage

| Key | Command | Effect |
| --- | --- | --- |
| `ctrl+shift+k` | `/reply prev` | Jump to the previous message |
| `ctrl+shift+j` | `/reply next` | Jump to the next message |

`/reply` also carries `context` and `debug`. Type a space to list the
subcommands, and `context` followed by a space to list common settings. The
letters `p`, `n`, `c` and `d` are accepted as shorthands:

| Command | Effect |
| --- | --- |
| `/reply` | Show the usage line and the current context |
| `/reply context` | Show the current setting |
| `/reply context 2/3` | Two thirds of the viewport (default) |
| `/reply context 1/2` | Half of the viewport |
| `/reply context 5` | Five rows of context |
| `/reply context 0` | Message at the very top |
| `/reply debug` | Write the transcript state the jumps can see |

An unknown subcommand, or an argument a subcommand does not take, prints the
usage line instead.

Both keys work in fullscreen mode (`tuiMode: fullscreen`). In regular mode the
terminal owns the scrollback, so there is nothing to jump and the extension
says so. The commands exist for terminals that intercept the key combinations.

Jumping stops follow-tail: new output does not pull the view back to the
bottom while you read. `ctrl+end` returns to the bottom and resumes following.

A jump puts the message's first line two thirds of the way down the screen, so
the tail of what came before it stays visible as context. Change that with
`/reply context`.

Navigation is measured from the message you are on, not from the viewport top.
That keeps the message you just read from being picked again, and it reaches a
message that sits inside the context band above it. That also holds when pi
clamps a jump at the end of the transcript, where it lands above the row the
extension asked for. Move the view yourself and the jumps fall back to measuring
from the viewport top.

From inside a long reply, `ctrl+shift+k` scrolls to that reply's opening line,
and the next press moves to the message before it. Thinking blocks above the
text are skipped, so the first visible row is the reply itself.

How many stops there are depends on the transcript. A session that runs tools
for a while produces many assistant turns with thinking and tool calls but no
prose; those turns are not stops, so a jump can cover a lot of rows. The stops
you can count on are the prompts and the turns that ended in text.

## Limits

Run `/reply debug` to see what the extension can see: how many stops it found,
where the viewport sits, and every row it would stop at. Pi hides footer
notifications while the transcript is scrolled up, so the same report is
written to `/tmp/pi-assistant-jump-debug.json` together with the last 20 jumps.
That file is the thing to send with a bug report.

The extension walks Pi's transcript components, which have no public scrolling
API. Assistant components are recognised by behaviour (`lastMessage.role` and
`updateContent`) and prompts by their `text` plus `rebuild` members, not by
class name, and every step is defensive: when a Pi release moves these
internals, the shortcut reports that it cannot find the transcript instead of
throwing.
