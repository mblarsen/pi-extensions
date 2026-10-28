import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import piSwitch from "./index.ts";

test("commands reject unsafe requests without shutdown", async () => {
	const previous = { ...process.env };
	try {
		const handlers = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
		piSwitch({
			on() {},
			registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
				handlers.set(name, options.handler);
			},
		} as unknown as ExtensionAPI);
		assert.deepEqual([...handlers.keys()], ["pi", "pig"]);
		const notices: string[] = [];
		let idle = true;
		let queued = false;
		let editor = "";
		const ctx = {
			mode: "tui", hasUI: true,
			isIdle: () => idle, hasPendingMessages: () => queued,
			ui: { notify: (text: string) => notices.push(text), getEditorText: () => editor },
			sessionManager: { getSessionFile: () => undefined },
			shutdown: () => assert.fail("Must not shut down"),
		} as unknown as ExtensionCommandContext;
		const pig = handlers.get("pig")!;
		delete process.env.PI_SWITCH_SOCKET;
		await pig("", ctx);
		assert.match(notices.pop()!, /Start through/);
		process.env.PI_SWITCH_SOCKET = "/unused";
		process.env.PI_SWITCH_TOKEN = "test";
		process.env.PI_SWITCH_HOST = "pi";
		await handlers.get("pi")!("", ctx);
		assert.match(notices.pop()!, /Already running Pi/);
		await pig("unexpected", ctx);
		assert.match(notices.pop()!, /takes no arguments/);
		idle = false;
		await pig("", ctx);
		assert.match(notices.pop()!, /Finish active work/);
		idle = true; queued = true;
		await pig("", ctx);
		assert.match(notices.pop()!, /queued messages/);
		queued = false; editor = "draft";
		await pig("", ctx);
		assert.match(notices.pop()!, /editor text/);
		editor = "";
		await pig("", ctx);
		assert.match(notices.pop()!, /Save this session/);
	} finally {
		for (const key of ["PI_SWITCH_SOCKET", "PI_SWITCH_TOKEN", "PI_SWITCH_HOST"]) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	}
});

test("switch prepares before shutdown, commits at shutdown, and verifies target identity", async () => {
	const previous = { ...process.env };
	const dir = await mkdtemp(join(tmpdir(), "switch-command-"));
	const file = join(dir, "session.jsonl");
	await writeFile(file, '{"type":"session","id":"test-id"}\n');
	const actions: string[] = [];
	const server = createServer((socket) => {
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			if (!buffer.includes("\n")) return;
			const message = JSON.parse(buffer);
			assert.equal(message.token, "test-token");
			actions.push(message.action);
			if (message.action === "switch") {
				assert.equal(message.target, "pig");
				assert.equal(message.id, "test-id");
			}
			socket.end('{"ok":true}\n');
		});
	});
	await new Promise<void>((resolve) => server.listen(join(dir, "control.sock"), resolve));
	try {
		Object.assign(process.env, { PI_SWITCH_SOCKET: join(dir, "control.sock"), PI_SWITCH_TOKEN: "test-token", PI_SWITCH_HOST: "pi" });
		type Handler = (event: unknown, ctx: ExtensionCommandContext) => Promise<void>;
		const events = new Map<string, Handler>();
		const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
		piSwitch({
			appendEntry: (type: string, data: unknown) => {
				assert.equal(type, "pi-switch.handoff");
				assert.deepEqual(data, { fromLeaf: "leaf-id" });
			},
			on: (name: string, handler: Handler) => events.set(name, handler),
			registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, options.handler),
		} as unknown as ExtensionAPI);
		let shutdowns = 0;
		const notices: string[] = [];
		const ctx = {
			mode: "tui", hasUI: true, cwd: dir, isIdle: () => true, hasPendingMessages: () => false,
			ui: { notify: (text: string) => notices.push(text), getEditorText: () => "" },
			sessionManager: { getSessionFile: () => file, getSessionId: () => "test-id", getLeafId: () => "leaf-id" },
			shutdown: () => { shutdowns++; },
		} as unknown as ExtensionCommandContext;
		await commands.get("pig")!("", ctx);
		assert.equal(shutdowns, 1);
		assert.deepEqual(actions, ["switch"]);
		await events.get("session_shutdown")!({}, ctx);
		assert.deepEqual(actions, ["switch", "commit"]);
		process.env.PI_SWITCH_EXPECTED = JSON.stringify({ id: "test-id", file, leaf: "leaf-id" });
		await events.get("session_start")!({}, ctx);
		assert.deepEqual(actions, ["switch", "commit", "ready"]);
		assert.equal(process.env.PI_SWITCH_EXPECTED, undefined);
		process.env.PI_SWITCH_EXPECTED = JSON.stringify({ id: "test-id", file, leaf: "wrong-leaf" });
		await events.get("session_start")!({}, ctx);
		assert.equal(shutdowns, 2);
		assert.match(notices.pop()!, /did not resume the same session file and branch/);
		assert.equal(actions.length, 3);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
		for (const key of ["PI_SWITCH_SOCKET", "PI_SWITCH_TOKEN", "PI_SWITCH_HOST", "PI_SWITCH_EXPECTED"]) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	}
});
