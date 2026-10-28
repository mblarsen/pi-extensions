import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { discoverAndLoadExtensions, type ExtensionAPI, type ExtensionCommandContext, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import idleLearn from "./index.ts";
import { loadConfig } from "./config.ts";

function directory() { return realpathSync(mkdtempSync(join(tmpdir(), "idle-learn-extension-"))); }

test("the real Pi loader loads index.ts and registers the idle-learn command", async () => {
	const root = directory(); const agent = directory();
	try {
		const loader = process.env.IDLE_LEARN_HOST_SDK
			? (await import(pathToFileURL(process.env.IDLE_LEARN_HOST_SDK).href)).discoverAndLoadExtensions
			: discoverAndLoadExtensions;
		const result = await loader([fileURLToPath(new URL("./index.ts", import.meta.url))], root, agent);
		assert.deepEqual(result.errors, []);
		assert.equal(result.extensions.length, 1);
		assert.ok(result.extensions[0].commands.has("idle-learn"));
		assert.deepEqual(result.extensions[0].tools.size, 0);
		assert.deepEqual(readdirSync(root), []);
	} finally { rmSync(root, { recursive: true, force: true }); rmSync(agent, { recursive: true, force: true }); }
});

test("interactive init requires confirmation, review renders, and config can pause analysis", async () => {
	const root = directory();
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	let command: RegisteredCommand | undefined;
	const selections: string[] = [];
	const notifications: string[] = [];
	let confirmed = false;
	let rendered = "";
	idleLearn({
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand(_name: string, value: RegisteredCommand) { command = value; },
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI);
	const ctx = {
		cwd: root, mode: "tui", hasUI: true, model: undefined, isIdle: () => true,
		sessionManager: { getSessionId: () => "test-session", getBranch: () => [] },
		ui: {
			setStatus() {}, notify(message: string) { notifications.push(message); }, confirm: async () => confirmed,
			select: async () => selections.shift(),
			custom: async (factory: any) => new Promise((resolve) => {
				const component = factory({ terminal: { rows: 24 }, requestRender() {} }, { fg: (_color: string, text: string) => text }, { matches: () => false }, resolve);
				rendered = component.render(80).join("\n"); component.handleInput("\x1b");
			}),
		},
	} as unknown as ExtensionCommandContext;
	try {
		assert.ok(command);
		for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		assert.deepEqual(readdirSync(root), []);
		await command.handler("init", ctx);
		assert.equal(loadConfig(root).status, "missing");
		confirmed = true;
		await command.handler("init", ctx);
		assert.equal(loadConfig(root).enabled, true);
		assert.equal(notifications.some((message) => message.includes("enabled")), true);
		await command.handler("review", ctx);
		assert.match(rendered, /No pending suggestions/);
		selections.push("Pause analysis", "Back");
		await command.handler("config", ctx);
		assert.equal(loadConfig(root).enabled, false);
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
		rmSync(root, { recursive: true, force: true });
	}
});
