import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { discoverAndLoadExtensions, type ExtensionAPI, type ExtensionCommandContext, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import idleLearn from "./index.ts";
import { CONFIG_PATH, initializeConfig, loadConfig, requireOptIn, saveConfig } from "./config.ts";
import { atomicProjectWrite, contentHash, readProjectFile } from "./files.ts";
import { refreshSuggestion } from "./refresh.ts";
import { integrateBatch } from "./integrate.ts";
import { listBatches, readBatch } from "./batch.ts";
import { PREFERENCES_PATH, readPreferences } from "./preferences.ts";
import { decideSuggestion, listSuggestions, saveProposals } from "./store.ts";
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

async function backgroundFixture(setup?: (root: string) => Promise<void>, refresher?: typeof refreshSuggestion, integrator?: typeof integrateBatch) {
	const root = directory();
	initializeConfig(root);
	if (setup) await setup(root);
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	let command!: RegisteredCommand;
	const notifications: Array<{ message: string; type: string }> = [];
	const statuses: string[] = [];
	const menus: Array<{ title: string; options: string[] }> = [];
	const reviews: ReviewInput[] = [];
	const selections: string[] = [];
	const rendered: string[] = [];
	const confirmations: string[] = [];
	const confirmationEffects: Array<() => void> = [];
	const comments: string[] = [];
	const inputs: Array<string | undefined> = [];
	const inputPrompts: string[] = [];
	let finish!: (value: ReviewResult) => void;
	let fail!: (error: Error) => void;
	let customCalls = 0;
	let branch = [{ id: "captured", type: "message", message: { role: "user", content: "Use docs/." } }];
	let idle = true;
	const review = (input: ReviewInput) => {
		reviews.push(input);
		return new Promise<ReviewResult>((resolve, reject) => {
			finish = resolve; fail = reject;
			input.signal.throwIfAborted();
			input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
		});
	};
	idleLearn({
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand(_name: string, value: RegisteredCommand) { command = value; },
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI, review, review, refresher, integrator);
	const ctx = {
		cwd: root, mode: "tui", hasUI: true, model: { provider: "test", id: "snapshot-model" }, isIdle: () => idle,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: { getSessionId: () => "background-session", getBranch: () => branch },
		ui: {
			setStatus(_key: string, value?: string) { statuses.push(value ?? ""); },
			notify(message: string, type: string) { notifications.push({ message, type }); },
			select: async (title: string, options: string[]) => { menus.push({ title, options }); return selections.shift(); },
			input: async (title: string) => { inputPrompts.push(title); return inputs.length ? inputs.shift() : title.startsWith("Analysis guidance") ? "" : "Too feature-specific."; },
			editor: async () => comments.shift(),
			confirm: async (title: string, body: string) => { confirmations.push(`${title}\n${body}`); confirmationEffects.shift()?.(); return true; },
			custom: async (factory: any) => new Promise((resolve) => {
				customCalls++;
				const component = factory({ terminal: { rows: 24 }, requestRender() {} }, { fg: (_color: string, text: string) => text }, { matches: () => false }, resolve);
				const screen = component.render(80).join("\n");
				rendered.push(screen);
				if (screen.includes("Idle Learn / Refresh diff") || screen.includes("Idle Learn / Integrate")) {
					if (selections[0] === "cancel-refresh") { selections.shift(); component.handleInput("\x1b"); }
					return;
				}
				const action = selections.shift();
				if (action?.startsWith("keys:")) { for (const key of action.slice(5)) component.handleInput(key === "E" ? "\x1b" : key); return; }
				if (action === "apply" || action === "reject" || action === "refresh") { component.handleInput("\r"); component.handleInput(action === "apply" ? "p" : action === "refresh" ? "f" : "r"); }
				else { component.handleInput(action === "analyze" ? "a" : "\x1b"); if (action !== "analyze") component.handleInput("\x1b"); }
			}),
		},
	} as unknown as ExtensionCommandContext;
	const emit = async (event: string) => { for (const handler of handlers.get(event) ?? []) await handler({}, ctx); };
	await emit("session_start");
	return {
		ctx, reviews, notifications, statuses, selections, rendered, confirmations, confirmationEffects, menus, emit, comments, inputs, inputPrompts,
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

test("configuration rows show inherited and explicit model and thinking values", async () => {
	for (const explicit of [false, true]) {
		const run = await backgroundFixture(async (root) => {
			if (explicit) saveConfig(root, { enabled: true, idle_minutes: 10, provider: "custom", model: "review-model", thinking: "medium" }, readProjectFile(root, CONFIG_PATH)!);
		});
		try {
			run.selections.push("Back");
			await run.command("config");
			const options = run.menus.at(-1)!.options;
			assert.ok(options.includes(explicit ? "Reviewer model: custom/review-model (explicit)" : "Reviewer model: test/snapshot-model (follow session)"));
			assert.ok(options.includes(explicit ? "Thinking level: medium (explicit)" : "Thinking level: off (follow session)"));
		} finally { await run.close(); }
	}
});

test("configuration value rows still open model and thinking selectors", async () => {
	const run = await backgroundFixture();
	try {
		run.selections.push("Reviewer model: test/snapshot-model (follow session)", "Follow current session", "Thinking level: off (follow session)", "off", "Back");
		await run.command("config");
		assert.ok(run.menus.some((menu) => menu.title === "Reviewer provider and model"));
		assert.ok(run.menus.some((menu) => menu.title === "Reviewer thinking"));
		assert.ok(run.menus.at(-1)!.options.includes("Thinking level: off (explicit)"));
		assert.equal(requireOptIn(run.ctx.cwd).thinking, "off");
	} finally { await run.close(); }
});

test("direct analyze guidance bypasses input and reaches the reviewer", async () => {
	const run = await backgroundFixture();
	try {
		await run.command("analyze include the guidance we just discussed");
		assert.equal(run.reviews[0].guidance, "include the guidance we just discussed");
		assert.equal(run.inputPrompts.length, 0);
		run.finish(); await settleBackground();
	} finally { await run.close(); }
});

test("review a and menu Analyze now ask for optional guidance; Enter is normal and Escape cancels", async () => {
	for (const source of ["review", "menu"]) for (const guidance of ["Include recent guidance", "", undefined]) {
		const run = await backgroundFixture();
		try {
			run.inputs.push(guidance);
			run.selections.push(source === "review" ? "analyze" : "Analyze now");
			await run.command(source === "review" ? "review" : "");
			assert.match(run.inputPrompts[0], /Analysis guidance.*optional/);
			assert.equal(run.reviews.length, guidance === undefined ? 0 : 1);
			if (guidance !== undefined) {
				assert.equal(run.reviews[0].guidance, guidance || undefined);
				run.finish(); await settleBackground();
			}
		} finally { await run.close(); }
	}
});

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

async function ordinaryItem(root: string, index: number, reject = true) {
	const [item] = await saveProposals(root, [{ title: `Feature rule ${index}`, target: `feature-${index}/AGENTS.md`, rationale: "A feature correction.",
		evidence: [{ session: "test", entry: String(index), quote: "Check the feature." }], baseHash: null, before: "", after: `Check feature ${index}.\n` }]);
	return reject ? decideSuggestion(root, item, "reject", "Too feature-specific.") : item;
}

test("manual calibration uses the same background status and cancellation flow", async () => {
	const run = await backgroundFixture();
	try {
		run.selections.push("Calibrate reviewer");
		await run.command("");
		assert.equal(run.customCalls, 0);
		assert.equal(run.reviews[0].purpose, "calibration");
		assert.deepEqual(run.reviews[0].entries, []);
		assert.match(run.statuses.join("\n"), /Calibrating/);
		await run.emit("input"); await run.emit("agent_start");
		assert.equal(run.reviews[0].signal.aborted, false);
		await run.command("analyze");
		assert.equal(run.reviews.length, 1);
		await run.command("cancel"); await settleBackground();
		assert.equal(run.reviews[0].signal.aborted, true);
	} finally { await run.close(); }
});

test("opening review after waiting preserves a running manual calibration", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const run = await backgroundFixture();
	try {
		await run.command("calibrate");
		t.mock.timers.tick(60_000); await settleBackground();
		await run.command("review");
		assert.equal(run.reviews[0].signal.aborted, false);
		assert.doesNotMatch(run.rendered.at(-1)!, /Cancelled/);
		run.finish(); await settleBackground();
		await run.command("review");
		assert.doesNotMatch(run.rendered.at(-1)!, /Cancelled/);
	} finally { await run.close(); }
});

test("a queued config watcher event does not cancel calibration started with the new settings", { timeout: 3000 }, async (t) => {
	const run = await backgroundFixture();
	try {
		const changed = new Promise<void>((resolve) => {
			const watcher = watch(join(run.ctx.cwd, ".pi/idle-learn"), { signal: t.signal }, (_event, filename) => {
				if (filename?.toString() === "config.toml") { watcher.close(); resolve(); }
			});
		});
		const previous = readProjectFile(run.ctx.cwd, CONFIG_PATH)!;
		saveConfig(run.ctx.cwd, { enabled: true, idle_minutes: 5, calibration: { after_rejections: 2 } }, previous);
		await run.command("calibrate");
		await changed;
		await settleBackground();
		await run.command("review");
		assert.equal(run.reviews[0].signal.aborted, false);
		assert.doesNotMatch(run.rendered.at(-1)!, /Cancelled/);
	} finally { await run.close(); }
});

test("a configuration change during calibration still cancels it and explains why", { timeout: 3000 }, async (t) => {
	const run = await backgroundFixture();
	try {
		await run.command("calibrate");
		await new Promise<void>((resolve) => {
			const watcher = watch(join(run.ctx.cwd, ".pi/idle-learn"), { signal: t.signal }, (_event, filename) => {
				if (filename?.toString() === "config.toml") { watcher.close(); resolve(); }
			});
			const previous = readProjectFile(run.ctx.cwd, CONFIG_PATH)!;
			saveConfig(run.ctx.cwd, { enabled: true, idle_minutes: 5, calibration: { after_rejections: 2 } }, previous);
		});
		await settleBackground();
		await run.command("review");
		assert.equal(run.reviews[0].signal.aborted, true);
		assert.match(run.rendered.at(-1)!, /Cancelled calibration: project configuration changed/);
		assert.doesNotMatch(run.rendered.at(-1)!, /chunks|will retry/);
	} finally { await run.close(); }
});

test("persisted rejection threshold queues automatic calibration only after the idle delay", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const run = await backgroundFixture(async (root) => { for (let index = 1; index <= 3; index++) await ordinaryItem(root, index); });
	try {
		assert.equal(run.reviews.length, 0);
		t.mock.timers.tick(599_999); await settleBackground();
		assert.equal(run.reviews.length, 0);
		t.mock.timers.tick(1); await settleBackground();
		assert.equal(run.reviews.length, 1);
		assert.equal(run.reviews[0].purpose, "calibration");
		assert.equal(run.customCalls, 0);
		await run.emit("input"); await settleBackground();
		assert.equal(run.reviews[0].signal.aborted, true);
	} finally { await run.close(); }
});

test("third rejection in the existing review UI queues calibration without a new screen", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const run = await backgroundFixture(async (root) => {
		await ordinaryItem(root, 1); await ordinaryItem(root, 2); await ordinaryItem(root, 3, false);
	});
	try {
		run.selections.push("reject");
		await run.command("review");
		assert.equal(run.reviews.length, 0);
		t.mock.timers.tick(600_000); await settleBackground();
		assert.equal(run.reviews[0].purpose, "calibration");
		assert.equal(run.customCalls, 2);
	} finally { await run.close(); }
});

test("ordinary idle reviews switch to calibration after feedback arrives during the run", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const run = await backgroundFixture(async (root) => { await ordinaryItem(root, 1); await ordinaryItem(root, 2); });
	try {
		await run.emit("agent_settled");
		t.mock.timers.tick(600_000); await settleBackground();
		assert.equal(run.reviews[0].purpose, undefined);
		await ordinaryItem(run.ctx.cwd, 3);
		run.finish(); await settleBackground();
		t.mock.timers.tick(600_000); await settleBackground();
		assert.equal(run.reviews.length, 2);
		assert.equal(run.reviews[1].purpose, "calibration");
	} finally { await run.close(); }
});

test("manual-only configuration suppresses automatic calibration but not the command", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const run = await backgroundFixture(async (root) => {
		for (let index = 1; index <= 3; index++) await ordinaryItem(root, index);
		saveConfig(root, { ...requireOptIn(root), calibration: { after_rejections: 0 } }, readProjectFile(root, CONFIG_PATH)!);
	});
	try {
		t.mock.timers.tick(600_000); await settleBackground();
		assert.equal(run.reviews.length, 0);
		await run.command("calibrate");
		assert.equal(run.reviews[0].purpose, "calibration");
	} finally { await run.close(); }
});

test("calibration uses the existing approval surface with its label and exact target", async () => {
	const run = await backgroundFixture(async (root) => {
		await saveProposals(root, [{ kind: "calibration", title: "Prefer lasting conventions", target: PREFERENCES_PATH, rationale: "Repeated feedback.",
			evidence: [{ session: "decision", entry: "example", quote: "Too feature-specific." }], baseHash: null, before: "", after: "Prefer lasting project conventions.\n" }], undefined, undefined, "calibration");
	});
	try {
		run.selections.push("apply");
		await run.command("review");
		assert.match(run.rendered.join("\n"), /Calibration/);
		assert.match(run.confirmations[0], /Apply this calibration\?/);
		assert.match(run.confirmations[0], /reviewer-preferences\.md/);
		assert.match(readPreferences(run.ctx.cwd)!, /lasting project conventions/);
		assert.equal(readProjectFile(run.ctx.cwd, "AGENTS.md"), null);
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

async function stalePending(root: string) {
	atomicProjectWrite(root, PREFERENCES_PATH, "One. Two.\n", null);
	await saveProposals(root, [{ kind: "calibration", title: "Improve preference", target: PREFERENCES_PATH, rationale: "Decision feedback", evidence: [{ session: "decision", entry: "e1", quote: "Use these terms." }],
		baseHash: contentHash("One. Two.\n"), before: "Two", after: "Second" }], undefined, undefined, "calibration");
	atomicProjectWrite(root, PREFERENCES_PATH, "First. Two.\n", "One. Two.\n");
}

test("stale calibration Apply refreshes the diff, keeps details visible, and needs a separate Apply", async () => {
	let calls = 0;
	const run = await backgroundFixture(stalePending, (input, item) => refreshSuggestion(input, item, async () => {
		calls++; return { before: "Two", after: "Second" };
	}));
	try {
		run.selections.push("apply", "close");
		await run.command("review");
		assert.equal(calls, 1);
		assert.equal(readPreferences(run.ctx.cwd), "First. Two.\n");
		assert.equal(listSuggestions(run.ctx.cwd).length, 1);
		assert.match(run.rendered.at(-1)!, /Refreshed diff ready/);
		assert.match(run.rendered.at(-1)!, /Proposed edit/);
		assert.equal(run.confirmations.filter((item) => item.startsWith("Apply")).length, 0);
		run.selections.push("apply", "close");
		await run.command("review");
		assert.equal(readPreferences(run.ctx.cwd), "First. Second.\n");
		assert.equal(listSuggestions(run.ctx.cwd, "applied").length, 1);
		assert.equal(calls, 1);
	} finally { await run.close(); }
});

test("a failed refresh returns to the pending suggestion details with its error", async () => {
	const run = await backgroundFixture(stalePending, async () => { throw new Error("Provider unavailable"); });
	try {
		run.selections.push("apply", "close");
		await run.command("review");
		assert.equal(listSuggestions(run.ctx.cwd).length, 1);
		assert.match(run.rendered.at(-1)!, /Error: Provider unavailable/);
		assert.match(run.rendered.at(-1)!, /Proposed edit/);
		assert.equal(readPreferences(run.ctx.cwd), "First. Two.\n");
	} finally { await run.close(); }
});

test("Escape cancels refresh without hiding or applying the pending suggestion", async () => {
	const run = await backgroundFixture(stalePending, (input) => new Promise((_resolve, reject) => {
		input.signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
	}));
	try {
		run.selections.push("refresh", "cancel-refresh", "close");
		await run.command("review");
		assert.equal(listSuggestions(run.ctx.cwd).length, 1);
		assert.match(run.rendered.at(-1)!, /Refresh cancelled/);
		assert.match(run.rendered.at(-1)!, /Proposed edit/);
	} finally { await run.close(); }
});

test("session navigation cancels an active diff refresh", async () => {
	let started!: () => void;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	const run = await backgroundFixture(stalePending, (input) => new Promise((_resolve, reject) => {
		input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
		started();
	}));
	try {
		run.selections.push("refresh", "close");
		const review = run.command("review");
		await ready;
		await run.emit("session_before_switch");
		await review;
		assert.equal(listSuggestions(run.ctx.cwd).length, 1);
		assert.match(run.rendered.at(-1)!, /session switch/);
	} finally { await run.close(); }
});

const AGENTS = "# Project\n\nRun npm test.\n";
async function twoLessons(root: string) {
	writeFileSync(join(root, "AGENTS.md"), AGENTS);
	for (const index of [1, 2]) await saveProposals(root, [{ title: `Lesson ${index}`, target: "AGENTS.md", rationale: "Role feedback", evidence: [{ session: "s", entry: `e${index}`, quote: `Quote ${index}` }],
		baseHash: contentHash(AGENTS), before: "Run npm test.", after: `Run npm test.\nLesson ${index}.` }]);
}
const integrationOutput = (text: string) => async () => ({ summary: "Combined lessons.", notes: [{ number: 1, note: "Added." }, { number: 2, note: "Merged." }],
	files: [{ path: "AGENTS.md", edits: [{ before: "Run npm test.", after: `Run npm test.\n${text}` }] }] });

test("instruction suggestions have no direct Apply; select, comment, integrate, regenerate, then Apply separately", async () => {
	const requests: string[] = [];
	const run = await backgroundFixture(twoLessons, undefined, (input, id) => integrateBatch(input, id, async (request) => {
		requests.push(request.evidence);
		return integrationOutput(requests.length === 1 ? "Lessons 1 and 2." : "- Lesson 1\n- Lesson 2")();
	}));
	try {
		run.selections.push("keys:\rpfEE");
		await run.command("review");
		assert.equal(run.confirmations.length, 0);
		assert.equal(listSuggestions(run.ctx.cwd).length, 2);
		assert.doesNotMatch(run.rendered.join("\n"), /p apply/);
		run.comments.push("Merge #1 and #2.", "Use bullets.");
		run.selections.push("keys: j i", "keys:c", "keys:g", "keys:c", "keys:g", "keys:E", "close");
		await run.command("review");
		assert.equal(requests.length, 2);
		assert.deepEqual(JSON.parse(requests[1]).comments, ["Merge #1 and #2.", "Use bullets."]);
		assert.match(JSON.parse(requests[1]).previousDraft.files[0].content, /Lessons 1 and 2/);
		assert.equal(readProjectFile(run.ctx.cwd, "AGENTS.md"), AGENTS);
		assert.equal(listSuggestions(run.ctx.cwd).length, 2);
		assert.match(run.rendered.join("\n"), /Selected proposals/);
		assert.match(run.rendered.join("\n"), /\+- Lesson 2/);
		assert.match(run.rendered.join("\n"), /Batch saved|Draft ready/);
		run.selections.push("keys:b", "keys:p", "close");
		await run.command("review");
		assert.match(run.confirmations.at(-1)!, /Apply this integration draft\?[\s\S]*AGENTS\.md[\s\S]*2 selected proposals/);
		assert.equal(readProjectFile(run.ctx.cwd, "AGENTS.md"), "# Project\n\nRun npm test.\n- Lesson 1\n- Lesson 2\n");
		assert.deepEqual(listSuggestions(run.ctx.cwd), []);
		assert.equal(listSuggestions(run.ctx.cwd, "applied").length, 2);
		assert.match(run.rendered.at(-1)!, /2 proposals recorded as accepted/);
	} finally { await run.close(); }
});

test("a target change after integration disables Apply until regeneration", async () => {
	const run = await backgroundFixture(twoLessons, undefined, (input, id) => integrateBatch(input, id, integrationOutput("Combined.")));
	try {
		run.selections.push("keys: j i", "keys:g", "keys:E", "close");
		await run.command("review");
		writeFileSync(join(run.ctx.cwd, "AGENTS.md"), `${AGENTS}User edit.\n`);
		run.selections.push("keys:b", "keys:pE", "close");
		await run.command("review");
		const batchScreen = run.rendered.findLast((screen) => screen.includes("Integration batch"))!;
		assert.match(batchScreen, /AGENTS\.md changed since this draft/);
		assert.doesNotMatch(batchScreen, /p apply/);
		assert.equal(run.confirmations.filter((item) => item.startsWith("Apply")).length, 0);
		assert.equal(readProjectFile(run.ctx.cwd, "AGENTS.md"), `${AGENTS}User edit.\n`);
		assert.equal(listSuggestions(run.ctx.cwd).length, 2);
	} finally { await run.close(); }
});

test("Escape, session navigation, and configuration cancel integration and keep the batch", async () => {
	for (const how of ["escape", "session_before_tree", "session_shutdown", "cancel"]) {
		let started!: () => void;
		const ready = new Promise<void>((resolve) => { started = resolve; });
		const run = await backgroundFixture(twoLessons, undefined, (input) => new Promise((_resolve, reject) => {
			input.signal.addEventListener("abort", () => reject(input.signal.reason ?? new Error("Cancelled")), { once: true });
			started();
		}));
		try {
			run.selections.push("keys: i", "keys:g", ...(how === "escape" ? ["cancel-refresh"] : []), "keys:E", "close");
			const review = run.command("review");
			await ready;
			if (how === "cancel") await run.command("cancel");
			else if (how !== "escape") await run.emit(how);
			await review;
			assert.equal(readProjectFile(run.ctx.cwd, "AGENTS.md"), AGENTS, how);
			assert.equal(listSuggestions(run.ctx.cwd).length, 2, how);
			const [batch] = listBatches(run.ctx.cwd);
			assert.equal(batch?.status, "open", how);
			assert.equal(readBatch(run.ctx.cwd, batch.id).sources.length, 1, how);
			if (how === "escape") assert.match(run.rendered.join("\n"), /Integration cancelled/);
		} finally { await run.close(); }
	}
});

test("Reject keeps its reason and still counts toward calibration", async () => {
	const run = await backgroundFixture(twoLessons);
	try {
		run.selections.push("reject", "close");
		await run.command("review");
		const [rejected] = listSuggestions(run.ctx.cwd, "rejected");
		assert.equal(rejected.reason, "Too feature-specific.");
		assert.equal(listSuggestions(run.ctx.cwd).length, 1);
	} finally { await run.close(); }
});
