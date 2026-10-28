import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { discoverAndLoadExtensions, type ExtensionAPI, type ExtensionCommandContext, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import idleLearn from "./index.ts";
import { initializeConfig, loadConfig } from "./config.ts";
import type { ReviewInput, ReviewResult } from "./reviewer.ts";

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

async function backgroundFixture() {
	const root = directory();
	initializeConfig(root);
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	let command!: RegisteredCommand;
	const notifications: Array<{ message: string; type: string }> = [];
	const statuses: string[] = [];
	const reviews: ReviewInput[] = [];
	const selections: string[] = [];
	let finish!: (value: ReviewResult) => void;
	let fail!: (error: Error) => void;
	let customCalls = 0;
	let branch = [{ id: "captured", type: "message", message: { role: "user", content: "Use docs/." } }];
	let idle = true;
	idleLearn({
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand(_name: string, value: RegisteredCommand) { command = value; },
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI, (input) => {
		reviews.push(input);
		return new Promise((resolve, reject) => {
			finish = resolve; fail = reject;
			input.signal.throwIfAborted();
			input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
		});
	});
	const ctx = {
		cwd: root, mode: "tui", hasUI: true, model: { provider: "test", id: "snapshot-model" }, isIdle: () => idle,
		sessionManager: { getSessionId: () => "background-session", getBranch: () => branch },
		ui: {
			setStatus(_key: string, value?: string) { statuses.push(value ?? ""); },
			notify(message: string, type: string) { notifications.push({ message, type }); },
			select: async () => selections.shift(),
			custom: async (factory: any) => new Promise((resolve) => {
				customCalls++;
				const component = factory({ terminal: { rows: 24 }, requestRender() {} }, { fg: (_color: string, text: string) => text }, { matches: () => false }, resolve);
				component.render(80);
				component.handleInput(selections.shift() === "analyze" ? "a" : "\x1b");
			}),
		},
	} as unknown as ExtensionCommandContext;
	const emit = async (event: string) => { for (const handler of handlers.get(event) ?? []) await handler({}, ctx); };
	await emit("session_start");
	return {
		ctx, reviews, notifications, statuses, selections, emit,
		command: (args: string) => command.handler(args, ctx),
		get customCalls() { return customCalls; },
		setIdle: (value: boolean) => { idle = value; },
		appendEntry: () => { branch = [...branch, { id: "new", type: "message", message: { role: "user", content: "Continue work." } }]; },
		finish: () => finish({ suggestions: [], reviewed: 1, remaining: 0, message: "1 entry reviewed; 0 suggestions." }),
		fail: () => fail(new Error("Provider unavailable")),
		close: async () => { await emit("session_shutdown"); rmSync(root, { recursive: true, force: true }); },
	};
}
const settleBackground = () => new Promise<void>((resolve) => setImmediate(resolve));

test("manual analysis returns to chat, keeps its snapshot through chat events, and notifies without reopening UI", async () => {
	const run = await backgroundFixture();
	try {
		await run.command("analyze");
		assert.equal(run.customCalls, 0);
		assert.equal(run.reviews.length, 1);
		assert.match(run.statuses.join("\n"), /Analyzing/);
		run.setIdle(false); run.appendEntry();
		for (const event of ["input", "user_bash", "agent_start", "agent_settled"]) await run.emit(event);
		assert.equal(run.reviews[0].signal.aborted, false);
		assert.deepEqual(run.reviews[0].entries.map((entry) => entry.id), ["captured"]);
		await run.command("analyze");
		assert.equal(run.reviews.length, 1);
		assert.match(run.notifications.at(-1)!.message, /already running/);
		await run.command("review");
		assert.equal(run.reviews[0].signal.aborted, false);
		run.finish(); await settleBackground();
		assert.match(run.notifications.at(-1)!.message, /0 suggestions.*\/idle-learn review/);
		assert.equal(run.customCalls, 1);
		assert.equal(run.statuses.at(-1), "Idle Learn: 0 pending");
	} finally { await run.close(); }
});

test("manual completion rearms the idle timer for messages received during the review", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const run = await backgroundFixture();
	try {
		await run.command("analyze");
		run.appendEntry();
		await run.emit("agent_settled");
		run.finish(); await settleBackground();
		t.mock.timers.tick(600_000);
		await settleBackground();
		assert.equal(run.reviews.length, 2);
		assert.deepEqual(run.reviews[1].entries.map((entry) => entry.id), ["captured", "new"]);
		await run.emit("input"); await settleBackground();
		assert.equal(run.reviews[1].signal.aborted, true);
	} finally { await run.close(); }
});

test("Analyze now from the review screen closes the screen while work continues", async () => {
	const run = await backgroundFixture();
	try {
		run.selections.push("analyze");
		await run.command("review");
		assert.equal(run.customCalls, 1);
		assert.equal(run.reviews.length, 1);
		assert.equal(run.reviews[0].signal.aborted, false);
		await run.command("cancel"); await settleBackground();
		assert.equal(run.reviews[0].signal.aborted, true);
		assert.equal(run.notifications.some((item) => item.type === "error"), false);
	} finally { await run.close(); }
});

test("background provider failures are reported without opening a modal or escaping the command", async () => {
	const run = await backgroundFixture();
	try {
		run.selections.push("Analyze now");
		await run.command("");
		run.fail(); await settleBackground();
		assert.equal(run.customCalls, 0);
		assert.match(run.notifications.at(-1)!.message, /Provider unavailable/);
		assert.equal(run.notifications.at(-1)!.type, "error");
	} finally { await run.close(); }
});

test("session navigation and configuration still cancel manual reviews", async () => {
	for (const event of ["session_before_tree", "session_before_switch", "session_before_fork", "session_shutdown", "config"]) {
		const run = await backgroundFixture();
		try {
			await run.command("analyze");
			if (event === "config") { run.selections.push("Back"); await run.command("config"); }
			else await run.emit(event);
			assert.equal(run.reviews[0].signal.aborted, true, event);
			await settleBackground();
			assert.equal(run.notifications.some((item) => item.type === "error"), false, event);
		} finally { await run.close(); }
	}
});
