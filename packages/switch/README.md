# pi-switch

Switch between Pi and PiG in the same terminal, with the same session.

- Run `/pig` in Pi to continue in PiG.
- Run `/pi` in PiG to continue in Pi.
- A command for the current program does nothing except show a notification.

The launcher waits for the current program to shut down before it starts the other one.
It passes `--session <full-session-id>`, without `--session-dir` or a session file argument.
It keeps the working directory and checks the resumed session file and branch.
A custom handoff entry persists the active branch, including after `/tree` navigation.
This entry stays out of model context and does not change earlier entries.

## Setup

Requires macOS or Linux, Node.js 22.14 or newer, and both `pi` and `pig` on `PATH`.

```sh
npm install -g @mblarsen/pi-switch
pi-switch pi
# Or start in PiG:
pi-switch pig
```

The launcher loads the extension into each program automatically.
You do not need to install the extension separately in each program.
Installing it only through `pi install` or `pig install` does not install the launcher on your shell's `PATH`.

For your normal `pi` and `pig` commands, add these functions to your Bash or Zsh configuration:

```sh
pi() { command pi-switch pi "$@"; }
pig() { command pi-switch pig "$@"; }
```

Replace existing aliases for these names before defining the functions.
The launcher resolves the executables from `PATH`, not from shell functions.
Management commands such as `pi install` and `pig update` pass through without extension injection.
No setup command edits your shell configuration.

For explicit executable paths:

```sh
export PI_SWITCH_PI_BIN=/absolute/path/to/pi
export PI_SWITCH_PIG_BIN=/absolute/path/to/pig
```

Both programs must be able to find the session by ID through their existing configuration.
The extension does not copy sessions or change session-directory settings.
An ID that resolves to another file fails the handoff check.

## Behavior and safeguards

Switch commands accept no arguments and need no confirmation.
Switching requires an idle interactive session with a saved session file.
Finish active work and queued messages, and send or clear unsent editor text first.

An executable or session-file check failure leaves the current program open.
A crash, signal, or cancelled switch does not start the other program.
A normal quit exits the launcher and returns to your shell.
If the target cannot resume the same session and branch, it exits and the launcher prints a recovery command.
The launcher does not automatically retry or alternate between failing programs.

Settings, credentials, models, and extensions remain specific to each program.
Initial command-line flags and prompts apply only to the first program.
The launcher does not replay them after a switch.
In-memory extension state and unsaved UI state do not transfer.

A session started outside the launcher cannot switch in place.
The command explains how to start through the launcher instead of terminating that session.

## Development

From this repository:

```sh
node packages/switch/launcher.mjs pi
node --test packages/switch/*.test.ts
pig install ./packages/switch/index.ts --validate-only --json
python3 packages/switch/pty-smoke.py
```

The optional pseudo-terminal test needs installed Pi and PiG executables and Python 3.
It uses disposable configuration directories and shared temporary session storage, without model requests.
It tests both round-trip directions, with and without tree navigation, terminal resizing, and normal exit.
It does not read or change your live sessions.
