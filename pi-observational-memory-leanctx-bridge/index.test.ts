import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import observationalMemoryLeanCtxBridge from "./index.ts";
import type { SessionEntry } from "./core.ts";

test("registers lifecycle syncs, archives evidence, and integrates recall", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "om-leanctx-index-test-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const eventNames: string[] = [];
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any>>();
	const importedFacts: Array<Record<string, unknown>> = [];
	const mergeModes: string[] = [];
	const notifications: string[] = [];
	let commandName: string | undefined;
	let commandDescription: string | undefined;
	let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	let completions: ((prefix: string) => Array<{ value: string }> | null) | undefined;

	const pi = {
		on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any>) {
			eventNames.push(name);
			handlers.set(name, handler);
		},
		registerCommand(name: string, options: {
			description?: string;
			getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null;
			handler: (args: string, ctx: ExtensionContext) => Promise<void>;
		}) {
			commandName = name;
			commandDescription = options.description;
			commandHandler = options.handler;
			completions = options.getArgumentCompletions;
		},
		async exec(command: string, args: string[], options: { cwd?: string }) {
			assert.equal(command, "lean-ctx");
			assert.deepEqual(args.slice(0, 2), ["knowledge", "import"]);
			assert.equal(options.cwd, "/tmp/project");
			const jsonl = await readFile(args[2], "utf8");
			importedFacts.push(...jsonl.trim().split("\n").map((line) => JSON.parse(line)));
			const mergeMode = args[4];
			mergeModes.push(mergeMode);
			return {
				stdout: mergeMode === "replace"
					? "Import complete: 0 added, 0 skipped, 1 replaced (merge=replace)"
					: "Import complete: 1 added, 0 skipped, 0 replaced (merge=skip-existing)",
				stderr: "",
				code: 0,
			};
		},
	} as unknown as ExtensionAPI;

	observationalMemoryLeanCtxBridge(pi, { databasePath: join(directory, "evidence.sqlite") });

	assert.deepEqual(eventNames, [
		"session_start",
		"before_agent_start",
		"session_before_compact",
		"session_compact",
		"session_before_tree",
		"session_tree",
		"session_shutdown",
		"tool_call",
		"tool_result",
	]);
	assert.equal(commandName, "om:leanctx-sync");
	assert.match(commandDescription ?? "", /high\/critical observations/);
	assert.deepEqual(completions?.("--re")?.map((item) => item.value), ["--rescan"]);
	assert.deepEqual(completions?.("--a")?.map((item) => item.value), ["--all"]);
	assert.deepEqual(completions?.("--all --")?.map((item) => item.value), ["--all --rescan"]);
	assert.deepEqual(completions?.("--rescan --")?.map((item) => item.value), ["--rescan --all"]);
	assert.deepEqual(completions?.("o")?.map((item) => item.value), ["off"]);

	const branchEntries: SessionEntry[] = [
				{
					type: "custom",
					id: "ledger001",
					customType: "om.reflections.recorded",
					data: {
						reflections: [{
							id: "123456abcdef",
							content: "The project uses GraphQL.",
							supportingObservationIds: ["abcdef123456"],
						}],
					},
				},
				{
					type: "custom",
					id: "ledger002",
					customType: "om.observations.recorded",
					data: {
						observations: [{
							id: "fedcba654321",
							content: "A tentative implementation detail.",
							timestamp: "2026-07-20 12:10",
							relevance: "low",
							sourceEntryIds: ["source02"],
						}],
					},
				},
	];
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: (message: string) => notifications.push(message) },
		waitForIdle: async () => undefined,
		sessionManager: {
			getSessionId: () => "session-123",
			getBranch: () => branchEntries,
		},
	} as unknown as ExtensionContext;

	await handlers.get("session_start")?.({}, ctx);
	assert.equal(importedFacts.length, 1);
	assert.equal(importedFacts[0].key, "om:reflection:123456abcdef");

	await handlers.get("before_agent_start")?.({}, ctx);
	assert.equal(importedFacts.length, 1, "default sync should ignore low observations and avoid duplicate imports");

	await commandHandler?.("--all", ctx);
	assert.equal(importedFacts.length, 2);
	assert.equal(importedFacts[1].key, "om:observation:fedcba654321");
	assert.deepEqual(mergeModes, ["skip-existing", "skip-existing"]);

	branchEntries.push({
		type: "custom",
		id: "ledger003",
		customType: "om.observations.dropped",
		data: { observationIds: ["fedcba654321"], coversUpToId: "source02" },
	});
	await handlers.get("before_agent_start")?.({}, ctx);
	assert.equal(importedFacts.length, 3);
	assert.equal(importedFacts[2].confidence, 0.2);
	assert.match(importedFacts[2].value as string, /^\[historical:dropped\]/);
	assert.equal(mergeModes.at(-1), "replace");

	await commandHandler?.("--all --rescan", ctx);
	assert.equal(importedFacts.length, 5);
	assert.equal(mergeModes.at(-1), "replace", "rescan should replace existing Lean Context facts");

	const archivedResult = await handlers.get("tool_result")?.({
		toolName: "recall",
		input: { id: "123456abcdef" },
		content: [{ type: "text", text: "not found" }],
		details: { status: "not_found" },
		isError: false,
	}, ctx);
	assert.match(archivedResult.content[0].text, /Persistent observational-memory archive/);
	assert.equal(archivedResult.details.status, "partial");

	const knowledgeResult = await handlers.get("tool_result")?.({
		toolName: "ctx_knowledge",
		input: { action: "recall" },
		content: [{ type: "text", text: "[observational-memory-reflection/om:reflection:123456abcdef]: fact" }],
		details: {},
		isError: false,
	}, ctx);
	assert.match(knowledgeResult.content.at(-1).text, /recall\(<12-character id>\)/);
	assert.match(knowledgeResult.content.at(-1).text, /single most relevant current-looking memory/);
	assert.match(knowledgeResult.content.at(-1).text, /recall only that ID initially/);

	await commandHandler?.("off", ctx);
	assert.match(notifications.at(-1) ?? "", /disabled for this session/);
	const disabledKnowledgeResult = await handlers.get("tool_result")?.({
		toolName: "ctx_knowledge",
		input: { action: "recall" },
		content: [{ type: "text", text: "om:reflection:123456abcdef" }],
	}, ctx);
	assert.match(disabledKnowledgeResult.content.at(-1).text, /recall only that ID initially/);
	const disabledRecallResult = await handlers.get("tool_result")?.({
		toolName: "recall",
		input: { id: "123456abcdef" },
		content: [{ type: "text", text: "not found" }],
		details: { status: "not_found" },
		isError: false,
	}, ctx);
	assert.match(disabledRecallResult.content[0].text, /Persistent observational-memory archive/);
	const importsBeforeDisabledSync = importedFacts.length;
	await handlers.get("before_agent_start")?.({}, ctx);
	assert.equal(importedFacts.length, importsBeforeDisabledSync);
});
