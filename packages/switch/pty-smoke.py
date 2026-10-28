#!/usr/bin/env python3
"""Optional actual-host smoke test. No credentials or model calls required."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time
import uuid

LAUNCHER = Path(__file__).resolve().with_name("launcher.mjs")


def check(initial, navigate=False):
    with tempfile.TemporaryDirectory(prefix="pi-switch-smoke-") as temporary:
        root = Path(temporary).resolve()
        sessions = root / "sessions"
        pi = root / "pi"
        pig = root / "pig"
        for directory in [sessions, pi, pig / "agent"]:
            directory.mkdir(parents=True)
        settings = {"quietStartup": True, "sessionDir": str(sessions), "extensions": [], "packages": []}
        for directory in [pi, pig / "agent"]:
            (directory / "settings.json").write_text(json.dumps(settings))
        session_id = str(uuid.uuid4())
        timestamp = "2026-10-28T10:00:00.000Z"
        entries = [{"type": "session", "version": 3, "id": session_id, "timestamp": timestamp, "cwd": str(root)}]
        parent = None

        def entry(kind, identifier, **fields):
            nonlocal parent
            entries.append(dict(type=kind, id=identifier, parentId=parent, timestamp=timestamp, **fields))
            parent = identifier

        entry("thinking_level_change", "11111111", thinkingLevel="off")
        entry("message", "22222222", message={"role": "user", "content": "Offline switch fixture.", "timestamp": 1793181600000})
        entry("message", "33333333", message={"role": "assistant", "content": [{"type": "toolCall", "id": "fixture-call", "name": "read", "arguments": {"path": "fixture.txt"}}], "api": "openai-completions", "provider": "openai", "model": "fixture", "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}, "stopReason": "toolUse", "timestamp": 1793181600000})
        entry("message", "44444444", message={"role": "toolResult", "toolCallId": "fixture-call", "toolName": "read", "content": [{"type": "text", "text": "Fixture content"}], "isError": False, "timestamp": 1793181600000})
        entry("compaction", "55555555", summary="Offline fixture summary.", firstKeptEntryId="22222222", tokensBefore=100)
        entry("custom", "66666666", customType="pi-switch-test", data={"preserve": True}, unknownField="keep")
        entry("future_entry", "77777777", opaque={"preserve": [1, 2, 3]})
        original = "".join(json.dumps(item) + "\n" for item in entries)
        session = sessions / (session_id + ".jsonl")
        session.write_text(original)
        helper = root / "branch.ts"
        helper.write_text('export default function(pi) { pi.registerCommand("test-branch", {description:"test", handler: async (_args, ctx) => { await ctx.navigateTree("66666666", {summarize:false}); ctx.ui.setEditorText(""); }}); }')
        env = dict(os.environ, PI_CODING_AGENT_DIR=str(pi), PIG_HOME=str(pig), PIG_CODING_AGENT_DIR=str(pig / "agent"),
                   PI_CODING_AGENT_SESSION_DIR=str(sessions), PIG_CODING_AGENT_SESSION_DIR=str(sessions), PI_OFFLINE="1", TERM="xterm-256color")
        # Do not inherit transport or launcher state from the session running this test.
        for key in list(env):
            if key.startswith("PIG_EXT_SOCKET") or key.startswith("PI_SWITCH_") and not key.endswith("_BIN"):
                del env[key]
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        process = subprocess.Popen(["node", str(LAUNCHER), initial, "-e", str(helper), "--session", session_id,
                                    "--no-extensions", "--no-skills", "--no-mcp", "--no-context-files", "--no-prompt-templates", "--no-themes"],
                                   cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        output = bytearray()

        def drain(seconds):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        data = os.read(master, 65536)
                        if not data:
                            break
                        output.extend(data)
                        if b"\x1b[6n" in data:
                            os.write(master, b"\x1b[1;1R")
                    except OSError:
                        break

        try:
            other = "pig" if initial == "pi" else "pi"
            drain(5)
            if navigate:
                os.write(master, b"/test-branch\r")
                drain(3)
            os.write(master, ("/" + other + "\r").encode())
            drain(8)
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 100, 0, 0))
            os.killpg(process.pid, signal.SIGWINCH)
            drain(1)
            os.write(master, ("/" + initial + "\r").encode())
            drain(8)
            os.write(master, b"\x04")
            drain(3)
            if process.poll() is None:
                os.write(master, b"\x04")
                drain(3)
            assert process.poll() == 0, f"launcher exit: {process.poll()}"
            text = output.decode(errors="replace")
            assert "Switching to PiG..." in text and "Switching to Pi..." in text
            assert "Recover:" not in text and "pi-switch:" not in text
            saved = [json.loads(line) for line in session.read_text().splitlines()]
            assert saved[:len(entries)] == entries, "Original entries changed"
            assert list(sessions.glob("*.jsonl")) == [session], "A second session was created"
            checkpoints = [item for item in saved if item.get("customType") == "pi-switch.handoff"]
            assert len(checkpoints) == 2, "Missing handoff checkpoints"
            assert checkpoints[0]["parentId"] == ("66666666" if navigate else "77777777")
            print(f"PASS {initial} -> {other} -> {initial} (tree={navigate}): identity, branch, entries, terminal resize, exit")
        except BaseException:
            print(output.decode(errors="replace")[-12000:])
            raise
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            os.close(master)


if __name__ == "__main__":
    for navigate in [False, True]:
        check("pi", navigate)
        check("pig", navigate)
