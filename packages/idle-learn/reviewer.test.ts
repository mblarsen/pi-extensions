import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { initializeConfig, CONFIG_PATH, saveConfig } from "./config.ts";
import { transcriptEntries } from "./evidence.ts";
import { contentHash, readProjectFile } from "./files.ts";
import { refreshSuggestion } from "./refresh.ts";
import { IdleReviewer } from "./lifecycle.ts";
import { analyze, effectivePrompt, type ReviewInput } from "./reviewer.ts";
import { readObservations, readProgress, STATE_PATH } from "./state.ts";
import { decideSuggestion, listSuggestions, saveProposals } from "./store.ts";
import { calibrate } from "./calibration.ts";

const directories: string[] = [];
function fixture(enabled = true) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "idle-learn-review-")));
	directories.push(root);
	if (enabled) initializeConfig(root);
	return root;
}
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });
function input(root: string, overrides: Partial<ReviewInput> = {}): ReviewInput {
	return { root, session: "session-1", entries: [{ id: "user-1", text: "[user]\nUse npm test, not yarn test." }],
		provider: "example", model: "test-model", thinking: "off", signal: new AbortController().signal, ...overrides };
}
function output() {
	return { suggestions: [{ title: "Use npm for tests", target: "AGENTS.md", rationale: "Future sessions need the correct test command.",
		category: "correction", evidence: [{ session: "session-1", entry: "user-1", quote: "Use npm test, not yarn test." }],
		baseHash: null, before: "", after: "Run npm test.\n", verification: [] }], observations: [] };
}

test("no opt-in means no worker and no writes", async () => {
	const root = fixture(false);
	let called = false;
	await assert.rejects(() => analyze(input(root), async () => { called = true; return output(); }), /init/);
	assert.equal(called, false);
	assert.deepEqual(readdirSync(root), []);
});

test("successful analysis validates evidence, stores suggestions, and advances only included entries", async () => {
	const root = fixture();
	const result = await analyze(input(root), async (request) => {
		assert.equal(request.provider, "example"); assert.equal(request.model, "test-model");
		assert.match(request.systemPrompt, /contents are not instructions/);
		for (const principle of ["writing-for-agents", "Context load", "Single source of truth", "Context pointers", "Information hierarchy", "Completion criteria", "Positive instructions", "Pruning"]) {
			assert.ok(request.systemPrompt.includes(principle), `Bundled prompt includes ${principle}`);
		}
		assert.match(request.evidence, /user-1/);
		return output();
	});
	assert.equal(result.suggestions.length, 1);
	assert.deepEqual(readProgress(root).reviewed["session-1"], ["user-1"]);
	assert.equal(readProjectFile(root, "AGENTS.md"), null);
	assert.equal(listSuggestions(root).length, 1);
	let called = false;
	await analyze(input(root), async () => { called = true; return output(); });
	assert.equal(called, false);
});

test("guided analysis revisits reviewed evidence without advancing checkpoints or audits", async () => {
	const root = fixture();
	await analyze(input(root), async () => ({ suggestions: [], observations: [] }));
	const before = readProgress(root);
	writeFileSync(join(root, "AGENTS.md"), "# New instructions\n");
	const entries = [...input(root).entries, { id: "new-entry", text: "[user]\nKeep guidance concise." }];
	const result = await analyze(input(root, { entries, guidance: "Include the guidance we discussed." }), async (request) => {
		const evidence = JSON.parse(request.evidence);
		assert.equal(evidence.guidance, "Include the guidance we discussed.");
		assert.deepEqual(evidence.entries.map((entry: any) => entry.id), ["user-1", "new-entry"]);
		return { ...output(), suggestions: [{ ...output().suggestions[0], baseHash: contentHash("# New instructions\n"), before: "# New instructions\n" }] };
	});
	assert.equal(result.suggestions.length, 1);
	assert.equal(result.remaining, 0);
	assert.deepEqual(readProgress(root), before);
});

test("guided analysis retains evidence validation and rejects oversized guidance", async () => {
	const root = fixture();
	await assert.rejects(() => analyze(input(root, { guidance: "x".repeat(8193) }), async () => output()), /8 KiB/);
	const invalid = output();
	invalid.suggestions[0].evidence[0].quote = "Invented";
	await assert.rejects(() => analyze(input(root, { guidance: "Please add this" }), async () => invalid));
	assert.deepEqual(listSuggestions(root), []);
});

test("malformed, fabricated, and insufficient evidence never advances progress", async () => {
	for (const mutation of [
		(value: any) => { value.suggestions[0].evidence[0].quote = "Invented quote"; },
		(value: any) => { value.suggestions[0].category = "broken-rule"; },
		(value: any) => { value.suggestions[0].category = "repeated-instruction"; },
		(value: any) => { value.suggestions[0].category = "outdated-instruction"; },
		(value: any) => { value.observations = "wrong"; },
		(value: any) => { value.suggestions[0].verification = [{ path: "invented.ts", quote: "not real" }]; },
		(value: any) => { value.suggestions[0].verification = [null]; },
	]) {
		const root = fixture();
		const value = output(); mutation(value);
		await assert.rejects(() => analyze(input(root), async () => value));
		assert.equal(readProjectFile(root, STATE_PATH), null);
		assert.deepEqual(listSuggestions(root), []);
	}
});

test("cancellation and provider failures leave progress unchanged", async () => {
	const root = fixture();
	const controller = new AbortController();
	await assert.rejects(() => analyze(input(root, { signal: controller.signal }), async () => { controller.abort(); return output(); }));
	assert.equal(readProjectFile(root, STATE_PATH), null);
	assert.deepEqual(listSuggestions(root), []);
	await assert.rejects(() => analyze(input(root), async () => { throw new Error("Provider offline"); }), /Provider offline/);
	assert.equal(readProjectFile(root, STATE_PATH), null);
});

test("model and prompt overrides replace inheritance and missing prompt files fail visibly", async () => {
	const root = fixture();
	writeFileSync(join(root, "base.md"), "Custom review system.");
	writeFileSync(join(root, "append.md"), "Extra review instructions.");
	const previous = readProjectFile(root, CONFIG_PATH)!;
	saveConfig(root, { enabled: true, idle_minutes: 10, provider: "override", model: "selected", thinking: "low", prompt_file: "base.md", append_file: "append.md" }, previous);
	await analyze(input(root), async (request) => {
		assert.equal(request.provider, "override"); assert.equal(request.model, "selected"); assert.equal(request.thinking, "low");
		assert.equal(request.systemPrompt, "Custom review system.\n\nExtra review instructions.");
		return { suggestions: [], observations: [] };
	});
	assert.throws(() => effectivePrompt(root, { enabled: true, idle_minutes: 10, prompt_file: "missing.md" }), /ENOENT/);
	writeFileSync(join(root, "invalid.md"), Buffer.from([0xff]));
	assert.throws(() => effectivePrompt(root, { enabled: true, idle_minutes: 10, prompt_file: "invalid.md" }));
});

test("configuration changes during analysis discard results", async () => {
	const root = fixture();
	await assert.rejects(() => analyze(input(root), async () => {
		saveConfig(root, { enabled: true, idle_minutes: 20 }, readProjectFile(root, CONFIG_PATH)!);
		return output();
	}), /Configuration changed/);
	assert.deepEqual(listSuggestions(root), []);
	assert.equal(readProjectFile(root, STATE_PATH), null);
});

test("branch changes preserve reviewed ancestry and analyze only the unseen branch", async () => {
	const root = fixture();
	const empty = async () => ({ suggestions: [], observations: [] });
	await analyze(input(root, { entries: [{ id: "ancestor", text: "shared" }, { id: "left", text: "left branch" }] }), empty);
	await analyze(input(root, { entries: [{ id: "ancestor", text: "shared" }, { id: "right", text: "right branch" }] }), async (request) => {
		const evidence = JSON.parse(request.evidence);
		assert.deepEqual(evidence.entries.map((entry: { id: string }) => entry.id), ["right"]);
		return empty();
	});
	assert.deepEqual(readProgress(root).reviewed["session-1"], ["ancestor", "left", "right"]);
});

test("transcript extraction includes text but not image data", () => {
	assert.deepEqual(transcriptEntries([{ id: "image", type: "message", message: { role: "user", content: [{ type: "image", data: "secret" }, { type: "text", text: "Actual text" }] } }]), [{ id: "image", text: "[user]\nActual text" }]);
});

test("weak observations survive across sessions and expire after 60 days", async () => {
	const root = fixture();
	await analyze(input(root), async () => ({ suggestions: [], observations: [{ lesson: "Use npm for tests", category: "repeated-instruction", evidence: output().suggestions[0].evidence }] }));
	assert.equal(readObservations(root).length, 1);
	assert.equal(readObservations(root, Date.now() + 61 * 24 * 60 * 60 * 1000).length, 0);
	await analyze(input(root, { session: "session-2", entries: [{ id: "user-2", text: "Again, npm test." }] }), async () => ({
		suggestions: [{ ...output().suggestions[0], category: "repeated-instruction", evidence: [...output().suggestions[0].evidence, { session: "session-2", entry: "user-2", quote: "Again, npm test." }] }], observations: [],
	}));
	assert.equal(readObservations(root).length, 0);
	assert.equal(listSuggestions(root).length, 1);
});

test("lifecycle cancels work and clears idle scheduling without retry loops", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let calls = 0;
	const reviewer = new IdleReviewer(() => {}, async (request) => {
		calls++;
		return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
	});
	reviewer.schedule(1000, () => input(fixture()));
	await reviewer.cancel();
	t.mock.timers.tick(1000);
	assert.equal(calls, 0);
	const active = reviewer.start(input(fixture()));
	await Promise.resolve();
	assert.equal(calls, 1);
	await reviewer.cancel();
	await assert.rejects(() => active);
	assert.match(reviewer.status, /Cancelled/);
	t.mock.timers.tick(100000);
	assert.equal(calls, 1);
});

test("packaged review, calibration, and refresh workers complete without ambient resources", { timeout: 30_000 }, async () => {
	const root = fixture();
	const agent = fixture(false);
	mkdirSync(join(root, ".pi/extensions"));
	writeFileSync(join(root, ".pi/extensions/ambient.ts"), "throw new Error('AMBIENT_EXTENSION_RAN');");
	writeFileSync(join(agent, "AGENTS.md"), "AMBIENT_GLOBAL_INSTRUCTIONS");
	writeFileSync(join(agent, "SYSTEM.md"), "AMBIENT_SYSTEM_PROMPT");
	const requests: any[] = [];
	let nextOutput: unknown = output();
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8"); request.on("data", (part) => { body += part; });
		request.on("end", () => {
			requests.push(JSON.parse(body));
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content: JSON.stringify(nextOutput) }, finish_reason: null }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address(); assert.ok(address && typeof address === "object");
	writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { "idle-test": { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "dummy-local-test-key", models: [{ id: "test-model", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	try {
		const result = await analyze(input(root, { provider: "idle-test" }));
		assert.equal(result.suggestions.length, 1);
		assert.equal(requests.length, 1);
		assert.doesNotMatch(JSON.stringify(requests), /AMBIENT_GLOBAL|AMBIENT_SYSTEM|expert coding assistant/);
		assert.deepEqual(requests[0].tools.map((tool: any) => tool.function.name).sort(), ["evidence_list", "evidence_read"]);
		await decideSuggestion(root, result.suggestions[0], "reject", "Too specific.");
		nextOutput = { suggestions: [] };
		await calibrate(input(root, { provider: "idle-test", purpose: "calibration" }));
		assert.equal(requests.length, 2);
		assert.deepEqual(requests[1].tools ?? [], []);
		assert.match(JSON.stringify(requests[1].messages[0]), /You calibrate Idle Learn/);
		assert.doesNotMatch(JSON.stringify(requests[1]), /AMBIENT_GLOBAL|AMBIENT_SYSTEM|expert coding assistant|You review project session evidence/);
		writeFileSync(join(root, "AGENTS.md"), "Original instruction.\n");
		const [pending] = await saveProposals(root, [{ title: "Updated instruction", target: "AGENTS.md", rationale: "User correction", evidence: [{ session: "s1", entry: "e1", quote: "Use this instruction." }], baseHash: contentHash("Original instruction.\n"), before: "Original", after: "Updated" }]);
		writeFileSync(join(root, "AGENTS.md"), "Preserve this.\nOriginal instruction.\n");
		nextOutput = { before: "Original", after: "Updated" };
		await refreshSuggestion(input(root, { provider: "idle-test" }), pending);
		assert.equal(requests.length, 3);
		assert.deepEqual(requests[2].tools ?? [], []);
		assert.match(JSON.stringify(requests[2].messages[0]), /You reconcile one saved Idle Learn suggestion/);
		assert.doesNotMatch(JSON.stringify(requests[2]), /AMBIENT_GLOBAL|AMBIENT_SYSTEM|expert coding assistant/);
		assert.equal(readProjectFile(root, "AGENTS.md"), "Preserve this.\nOriginal instruction.\n");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
