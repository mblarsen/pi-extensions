import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import footerManager, { formatBuiltinStats, formatTokens } from "./index.ts";

test("manager keeps discovered keys in holding across reloads until placed or hidden", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "footer-manager-"));
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	t.after(async () => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await rm(home, { recursive: true, force: true });
	});
	const settingsPath = join(home, ".pi", "agent", "settings.json");
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	const events = new Map<string, Function>();
	const createExtension = () => footerManager({
		registerCommand(_name, options) { command = options; },
		on(name, handler) { events.set(name, handler); return () => {}; },
	} satisfies Pick<ExtensionAPI, "registerCommand" | "on"> as unknown as ExtensionAPI);
	createExtension();
	const statuses = new Map([["first-status", "First"], ["overflow-status", "Overflow"]]);
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const tui = { requestRender() {} };
	let renderManager: ((width: number) => string[]) | undefined;
	let renderFooter: ((width: number) => string[]) | undefined;
	const errors: string[] = [];
	const ctx = {
		ui: {
			notify(message: string, level: string) { if (level === "error") errors.push(message); },
			setFooter(factory: Function | undefined) {
				if (!factory) return;
				const footer = factory(tui, theme, {
					getExtensionStatuses: () => statuses,
					getGitBranch: () => null,
					getAvailableProviderCount: () => 1,
					onBranchChange: () => () => {},
				});
				renderFooter = (width) => footer.render(width);
			},
			async custom(factory: Function) {
				const manager = factory(tui, theme, {}, () => {});
				renderManager = (width) => manager.render(width);
			},
		},
		sessionManager: { getCwd: () => "/test", getSessionId: () => "session", getLeafId: () => null, getSessionName: () => "", getEntries: () => [] },
		getContextUsage: () => undefined,
	} as unknown as ExtensionCommandContext;
	assert.ok(command);
	await events.get("session_start")!({}, ctx);
	assert.ok(renderFooter);
	assert.match(renderFooter(120).join("\n"), /no-model/);
	ctx.model = { id: "cx/gpt-6-astra", provider: "9router" } as NonNullable<typeof ctx.model>;
	ctx.modelRegistry = { isUsingOAuth: () => false } as unknown as typeof ctx.modelRegistry;
	assert.match(renderFooter(120).join("\n"), /\(9router\) cx\/gpt-6-astra/);
	ctx.model = undefined;
	await command.handler("", ctx);
	assert.ok(renderManager);
	for (const width of [80, 120, 200]) {
		const lines = renderManager(width);
		const controls = lines.findIndex((line) => line.includes("Controls"));
		assert.doesNotMatch(lines.join("\n"), /Details|reading position|Move:/);
		assert.match(lines.slice(controls).join("\n"), /u move up.*d move down in layout/);
		assert.match(lines[1], /^│ Footer manager/);
		assert.match(lines[controls + 1], /select/);
		assert.match(lines.at(-2)!, /esc close/);
		const items = lines.findIndex((line) => line.includes("Layout items"));
		assert.match(lines[items + 1], /builtin\..*row 1 left/);
		assert.ok(lines.every((line) => [...line].length === width));
	}
	const output = renderManager(120).join("\n");
	assert.match(output, /first-status.*unplaced/);
	assert.match(output, /overflow-status.*unplaced/);
	assert.match(output, /4 visible.*0 hidden.*2 unplaced/);
	statuses.set("late-status", "Late");
	assert.match(renderManager(120).join("\n"), /late-status.*unplaced/);
	await events.get("session_shutdown")!({}, ctx);
	const stored = JSON.parse(await readFile(settingsPath, "utf8"));
	assert.deepEqual(stored.footerManager.unplaced, [...statuses.keys()]);

	statuses.clear();
	createExtension();
	await events.get("session_start")!({}, ctx);
	await command.handler("", ctx);
	assert.match(renderManager(120).join("\n"), /overflow-status.*unplaced/);
	assert.match(renderManager(120).join("\n"), /no current text/);
	await command.handler("ext overflow-status", ctx);
	await command.handler("ext overflow-status", ctx);
	await command.handler("ext first-status", ctx);
	const placed = JSON.parse(await readFile(settingsPath, "utf8"));
	assert.deepEqual(placed.footerManager.unplaced, ["late-status"]);
	assert.ok(placed.footerManager.order.includes("overflow-status"));
	assert.ok(placed.footerManager.hidden.includes("first-status"));

	await command.handler("reset", ctx);
	assert.match(renderManager(120).join("\n"), /late-status/);
	await events.get("session_shutdown")!({}, ctx);
	assert.deepEqual(errors, []);
	await writeFile(settingsPath, "invalid json");
	await assert.rejects(command.handler("status-line on", ctx));
	assert.equal(await readFile(settingsPath, "utf8"), "invalid json");
});

test("repaints reuse session stats while live footer data and branch revisions stay fresh", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "footer-cache-"));
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	t.after(async () => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await rm(home, { recursive: true, force: true });
	});
	const events = new Map<string, Function>();
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	footerManager({
		registerCommand(_name, options) { command = options; },
		on(name, handler) { events.set(name, handler); },
	} satisfies Pick<ExtensionAPI, "registerCommand" | "on"> as unknown as ExtensionAPI);
	let footer: { render(width: number): string[]; invalidate(): void; dispose(): void };
	let manager: { render(width: number): string[] };
	let onGitBranchChange = () => {};
	let gitBranch = "main";
	let leafId: string | null = null;
	let sessionId = "session-1";
	let sessionName = "First session";
	let percent: number | null = 10;
	let subscription = false;
	let scans = 0;
	let contextReads = 0;
	let nameReads = 0;
	const entries: Parameters<typeof formatBuiltinStats>[0][number][] = [];
	const statuses = new Map<string, string>();
	const tui = { requestRender() {} };
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const model = { id: "test-model", provider: "test-provider", contextWindow: 100_000 };
	const ctx = {
		ui: {
			notify() {},
			setFooter(factory: Function | undefined) {
				if (factory) footer = factory(tui, theme, {
					getGitBranch: () => gitBranch,
					getExtensionStatuses: () => statuses,
					getAvailableProviderCount: () => 1,
					onBranchChange(callback: () => void) { onGitBranchChange = callback; return () => {}; },
				});
			},
			async custom(factory: Function) { manager = factory(tui, theme, {}, () => {}); },
		},
		sessionManager: {
			getCwd: () => "/test",
			getSessionId: () => sessionId,
			getLeafId: () => leafId,
			getSessionName: () => { nameReads++; return sessionName; },
			getEntries: () => { scans++; return entries; },
		},
		model,
		modelRegistry: {
			isUsingOAuth: () => subscription,
			getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
		},
		getContextUsage: () => { contextReads++; return { contextWindow: model.contextWindow, percent }; },
	} as unknown as ExtensionCommandContext;
	const render = () => footer.render(200).join("\n");
	const assertReads = (expected: number) => assert.deepEqual({ scans, contextReads, nameReads }, {
		scans: expected, contextReads: expected, nameReads: expected,
	});
	await events.get("session_start")!({}, ctx);
	assert.match(render(), /10.0%\/100k/);
	for (let i = 0; i < 100; i++) {
		footer!.invalidate();
		footer!.render(80 + i);
	}
	assertReads(1);

	gitBranch = "fix/footer";
	onGitBranchChange();
	assert.match(render(), /fix\/footer/);
	statuses.set("live", "Live status");
	await command!.handler("ext live", ctx);
	await command!.handler("ext live", ctx);
	statuses.set("live", "Changed status");
	assert.match(render(), /Changed status/);
	await command!.handler("", ctx);
	manager!.render(160);
	assertReads(1);

	entries.push({ type: "usage", usage: usage({ input: 100, cost: { total: 0.1 } }) });
	leafId = "usage-1";
	percent = 20;
	assert.match(render(), /↑100.*\$0.100.*20.0%/);
	assertReads(2);
	// Renames and compaction append entries, even when no new assistant message exists.
	leafId = "compaction-1";
	sessionName = "Renamed session";
	percent = null;
	assert.match(render(), /Renamed session/);
	assert.match(render(), /\?\/100k/);
	assertReads(3);

	model.id = "other-model";
	model.provider = "other-provider";
	model.contextWindow = 200_000;
	percent = 5;
	assert.match(render(), /\(other-provider\) other-model/);
	assert.match(render(), /5.0%\/200k/);
	assertReads(4);
	subscription = true;
	assert.match(render(), /\$0.100 \(sub\)/);
	assertReads(5);

	// Session identity must distinguish identical leaf ids after a switch.
	sessionId = "session-2";
	sessionName = "Second session";
	assert.match(render(), /Second session/);
	assertReads(6);
	await events.get("session_tree")!({}, ctx);
	render();
	assertReads(7);
	footer!.dispose();
	await events.get("session_start")!({}, ctx);
	render();
	assertReads(8);
	await events.get("session_shutdown")!({}, ctx);
});

function usage(values: Partial<Omit<Usage, "cost">> & { cost?: Partial<Usage["cost"]> }): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		...values,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
			...values.cost,
		},
	};
}

test("formats builtin stats like Pi's default footer", () => {
	const entries = [
		{ type: "message", message: { role: "assistant", usage: usage({ input: 1_000, output: 500, cacheRead: 8_000, cacheWrite: 1_000, cost: { total: 0.1 } }) } },
		{ type: "message", message: { role: "toolResult", usage: usage({ input: 200, output: 100, cost: { total: 0.02 } }) } },
		{ type: "usage", usage: usage({ input: 300, cacheRead: 100, cost: { total: 0.03 } }) },
		{ type: "branch_summary", usage: usage({ input: 400, output: 200, cost: { total: 0.04 } }) },
		{ type: "compaction", usage: usage({ input: 500, output: 300, cost: { total: 0.05 } }) },
	];

	assert.equal(
		formatBuiltinStats(entries, { contextWindow: 200_000, percent: 75 }, 128_000, false),
		"↑2.4k ↓1.1k R8.1k W1.0k CH80.0% $0.240 75.0%/200k (auto)",
	);
});

test("uses Pi's token thresholds and empty-session defaults", () => {
	assert.deepEqual(
		[999, 1_000, 9_999, 10_000, 999_999, 1_000_000, 9_999_999, 10_000_000].map(formatTokens),
		["999", "1.0k", "10.0k", "10k", "1000k", "1.0M", "10.0M", "10M"],
	);
	assert.equal(formatBuiltinStats([], { contextWindow: 128_000, percent: null }, 0, false), "?/128k (auto)");
	assert.equal(formatBuiltinStats([], undefined, 128_000, true), "$0.000 (sub) 0.0%/128k (auto)");
});
