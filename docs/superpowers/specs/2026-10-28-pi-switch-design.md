# pi-switch design

Status: approved and implemented. Final validation is recorded below.

## Goal

Publish `@mblarsen/pi-switch` as an independent npm workspace package.
Switch between Pi and PiG without leaving the terminal or creating a new session.

Michael approved the package name, command behavior, and a one-time launcher setup if needed.

## Commands

- `/pig` switches from Pi to PiG.
- `/pi` switches from PiG to Pi.
- A command for the current program reports that the program already runs.
- Commands accept no arguments.
- Normal switches require no confirmation.
- A brief notification identifies the target program.

Keep the session ID, exact session file, active branch, and working directory.
Do not copy, fork, summarize, or import the session.
Each program uses its own settings, credentials, providers, and extensions.
Do not promise identical model behavior or extension UI across programs.

## Evidence

The installed Pi CLI is version 1.4.0.
Both installed CLIs advertise `--session <path|id>`.
PiG's local session-format documentation specifies Pi 1.4.0 compatibility and session schema version 3.
It also specifies preservation of unknown entry fields and entry types.

Pi's extension types expose `isIdle`, `hasPendingMessages`, and `shutdown`.
PiG's extension API documents the same host capabilities.
PiG runs compatible Node extensions in isolated subprocesses.
Replacing that subprocess cannot replace the PiG host.

These facts support the design, but do not prove a successful runtime round trip.
Disposable-session tests must verify compatibility before release.

## Architecture

Use one TypeScript extension and one Node launcher in the package.
The shared extension must work with Pi and PiG's Node compatibility runtime.
This requirement rules out a Go-only extension for this package.

The launcher owns the foreground lifecycle of both programs.
It starts each host with inherited terminal streams and waits for the host to exit.
The extension requests a switch through a private, per-launcher control channel.
The launcher starts the target only after the outgoing host exits cleanly.
There must never be two host writers for the session during a managed switch.

The package provides `pi-switch pi [args...]` and `pi-switch pig [args...]` launch commands.
Document optional shell functions so ordinary `pi` and `pig` invocations use the launcher.
Do not modify shell configuration automatically.
Resolve the real executable paths without invoking shell aliases or constructing shell command strings.
Load the extension explicitly into each managed host so switching back remains available.

If Pi or PiG starts outside the launcher, the command explains the required setup and does not quit.
Do not attempt terminal keystroke injection, detached terminal reopening, or process-parent termination.

## Handoff

1. Confirm an interactive, launcher-managed session.
2. Reject a switch while work runs or queued messages remain.
3. Require a saved, readable session file.
4. Resolve the target executable before shutdown.
5. Capture the absolute session path, session ID, active leaf, and host working directory.
6. Submit a validated handoff request to the launcher.
7. Notify the user and request graceful host shutdown.
8. Append a custom handoff checkpoint through the extension API during shutdown.
   The checkpoint persists the active branch without adding model context.
   Confirm the checkpoint leaf with the launcher, then wait for successful host exit.
   Consume the confirmed request exactly once.
9. Start the target with `--session <session-id>` in the captured working directory.
   Use the full session ID, not a partial UUID.
   Do not add `--session-dir`.
   Verify that ID lookup selects the original session during integration tests.
10. Verify the resumed session identity and active branch before treating the handoff as complete.

The extension must not rewrite session JSONL directly.
An actual-host test showed that ID-based resume does not retain an unpersisted tree cursor.
The shutdown checkpoint solves this through `appendEntry`, without navigating the target or requesting a summary.
The target verifies the checkpoint leaf, whose parent is the outgoing active leaf.
Earlier entries remain unchanged, including entries on other branches.

## Safety and failure behavior

Validate the target as `pi` or `pig`, not an arbitrary command.
Use argument arrays for process creation.
Keep handoff data local and private to the launcher instance.
Use a fresh launch identifier to reject stale requests.
Never include credentials in handoff data.
Clear host-specific transient extension transport variables before starting another host.
Preserve user configuration variables and ordinary environment variables.

Reject unsaved sessions, pending messages, active turns, and unsupported noninteractive modes.
Reject a switch if unsent editor text would otherwise be lost.
Validation failure leaves the current host running.
Shutdown failure must not start the target.
An ordinary exit without a switch request returns to the shell.
A crash or signal must not consume a pending request as a successful switch.

If target startup fails after shutdown, show the error and an exact recovery command for the same session file.
Do not loop between programs or claim that the outgoing program remains open after it has exited.
Forward terminal signals correctly and restore terminal state when the launcher exits.

## Scope

Initial support targets interactive macOS and Linux terminals with Node, Pi, and PiG installed.
No Windows support, remote switching, terminal-pane management, or arbitrary target applications in v1.
No automatic installation, shell edits, model remapping, or configuration migration.
Initial CLI arguments apply to the initial host only.
Do not replay prompts, one-shot flags, or runtime-specific flags into the target host.

## Validation

Unit tests cover command registration, no-op commands, busy guards, missing files, missing executables, and unmanaged startup.
Launcher tests use fake hosts to verify exit ordering, argument boundaries, working directory, signals, crashes, and stale requests.
Paths containing spaces and shell metacharacters must remain literal arguments.

Use disposable configuration directories and sessions for actual-host tests.
Never test lifecycle changes against the user's live session.
Verify Pi-to-PiG-to-Pi and PiG-to-Pi-to-PiG transitions without model requests.
Verify session identity, branch selection, messages, tool results, compaction, custom entries, and unknown fields.
Verify same-terminal input, resize, interrupt, normal exit, and target startup failure through a pseudo-terminal.
Record the tested host versions and any compatibility limits.
The programs must already be configured to discover the same session by ID.
Tests use shared temporary session storage and never pass `--session-dir` during handoff.

Run PiG extension validation without installation.
Add a minor changeset for the new package's switch commands.
Ensure npm pack includes the extension and launcher but excludes tests.
Run `npm ci`, `npm run check`, and `npx changeset status` before a package commit.

## Implementation sequence

1. Prove disposable-session resume and shutdown behavior with both installed hosts.
2. Implement and test the private launcher handoff protocol.
3. Implement the shared extension and refusal paths.
4. Run bidirectional pseudo-terminal tests.
5. Add package documentation, packaging checks, and the changeset.

## Design review

The design separates documented API support from unverified runtime behavior.
Failures before shutdown retain the current program.
Failures after shutdown provide recovery rather than a false rollback guarantee.
The launcher owns process transitions, while the extension owns session validation.
No unrelated package changes belong to this work.

## Implementation and validation record

- Package: `packages/switch`, with an extension and executable Node launcher.
- Protocol: private Unix socket, per-host token, prepare, shutdown confirmation, and target readiness check.
- Handoff confirmation expires after 15 seconds. Failed or missing confirmation does not start the target.
- Initial management commands pass through without extension injection.
- Pi 1.4.0 and PiG 0.5.3 completed all four pseudo-terminal cases: both directions, with and without tree navigation.
- The smoke tests verified identity, branch checkpoints, tool results, compaction, unknown data, terminal resizing, and normal exit.
- `npm ci`, `npm run check` (167 tests, typecheck, and package dry runs), and `npx changeset status` passed.
- PiG extension validation passed with both commands and both lifecycle handlers registered.
- Package dry runs include the extension, control client, and launcher, and exclude tests.
- npm reported five dependency audit findings. No dependency remediation was included in this change.
- Installed a packed local copy without npm publication and configured `pi`/`pig` shell functions to use the launcher.
- Michael confirmed switching works after restarting the shell and using a persistent session instead of `--no-session`.
- Pre-commit validation passed again: `npm ci`, `npm run check` (167 tests, typecheck, and package dry runs), and `npx changeset status`.
- npm publication and changes to existing live sessions remain outside this implementation run.
