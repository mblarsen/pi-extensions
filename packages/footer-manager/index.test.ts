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
					getAvailableProviderCount: () => 0,
					onBranchChange: () => () => {},
				});
				renderFooter = (width) => footer.render(width);
			},
			async custom(factory: Function) {
				const manager = factory(tui, theme, {}, () => {});
				renderManager = (width) => manager.render(width);
			},
		},
		sessionManager: { getCwd: () => "/test", getSessionName: () => "", getEntries: () => [] },
		getContextUsage: () => undefined,
	} as unknown as ExtensionCommandContext;
	assert.ok(command);
	await events.get("session_start")!({}, ctx);
	assert.ok(renderFooter);
	renderFooter(120);
	await command.handler("", ctx);
	assert.ok(renderManager);
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
