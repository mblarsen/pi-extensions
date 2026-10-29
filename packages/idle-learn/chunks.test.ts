import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { selectChunk, selectRecentChunk, CHUNK_BYTES } from "./chunks.ts";
import { initializeConfig } from "./config.ts";
import { IdleReviewer } from "./lifecycle.ts";
import { analyze, type ReviewInput } from "./reviewer.ts";
import { readProgress } from "./state.ts";

test("recent evidence is a bounded chronological suffix, not the oldest backlog", () => {
	const entries = Array.from({ length: 10 }, (_, index) => ({ id: String(index), text: `[user]\n${"x".repeat(10000)}` }));
	const chunk = selectRecentChunk(entries);
	assert.deepEqual(chunk.entries.map((entry) => entry.id), ["6", "7", "8", "9"]);
	assert.equal(chunk.remaining, 0);
	assert.deepEqual(chunk.overlap, []);
	assert.ok(chunk.entries.reduce((size, entry) => size + Buffer.byteLength(JSON.stringify(entry)), 0) <= CHUNK_BYTES);
	assert.deepEqual(selectRecentChunk([]).entries, []);
	assert.throws(() => selectRecentChunk([{ id: "large", text: "x".repeat(CHUNK_BYTES + 1) }]), /exceeds/);
	assert.match(selectRecentChunk([{ id: "tool", text: `[toolResult]\n${"x".repeat(CHUNK_BYTES * 2)}` }]).entries[0].text, /omitted/);
});

const empty = { suggestions: [], observations: [] };
function fixture(entries: ReviewInput["entries"]): ReviewInput {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "idle-chunks-")));
	initializeConfig(root);
	return { root, session: "test", entries, provider: "test", model: "test", thinking: "off", signal: new AbortController().signal };
}

test("large tool output does not hide a later documentation correction", async () => {
	const entries = [
		{ id: "request", text: "[user]\nWrite a spec." },
		...Array.from({ length: 5 }, (_, i) => ({ id: `tool-${i}`, text: `[toolResult]\n${"x".repeat(24000)}` })),
		{ id: "correction", text: "[user]\nPlans and specs should always go in docs/ subfolders." },
	];
	const request = fixture(entries);
	try {
		const result = await analyze(request, async (worker) => {
			const evidence = JSON.parse(worker.evidence);
			assert.ok(evidence.entries.some((entry: { id: string }) => entry.id === "correction"));
			assert.match(worker.evidence, /Tool output omitted/);
			return empty;
		});
		assert.equal(result.remaining, 0);
		assert.equal(result.reviewed, entries.length);
	} finally { rmSync(request.root, { recursive: true, force: true }); }
});

test("chunks overlap with original IDs, prefer turn boundaries, and cover all unseen entries", () => {
	const entries = Array.from({ length: 12 }, (_, i) => ({ id: `entry-${i}`, text: `${i % 2 ? "[assistant]" : "[user]"}\n${"a".repeat(7000)}` }));
	const reviewed: string[] = [];
	let iterations = 0;
	while (reviewed.length < entries.length) {
		const chunk = selectChunk(entries, reviewed);
		assert.ok(chunk.entries.length);
		assert.ok(Buffer.byteLength(JSON.stringify([...chunk.overlap, ...chunk.entries])) < CHUNK_BYTES);
		assert.equal(chunk.entries[0].text.startsWith("[user]"), true);
		if (reviewed.length) assert.ok(chunk.overlap.length);
		assert.ok(chunk.overlap.every((entry) => reviewed.includes(entry.id)));
		reviewed.push(...chunk.entries.map((entry) => entry.id));
		assert.equal(chunk.remaining, entries.length - reviewed.length);
		assert.ok(++iterations < 10);
	}
	assert.equal(new Set(reviewed).size, entries.length);
	const fork = selectChunk([{ id: "entry-0", text: "[user]\nshared" }, { id: "right", text: "[user]\nnew branch" }], reviewed);
	assert.deepEqual(fork.entries.map((entry) => entry.id), ["right"]);
	assert.deepEqual(fork.overlap.map((entry) => entry.id), ["entry-0"]);
});

test("oversized conversational messages fail without skipping them", () => {
	assert.throws(() => selectChunk([{ id: "large", text: `[user]\n${"x".repeat(CHUNK_BYTES)}` }], []), /exceeds/);
});

test("lifecycle automatically continues but limits a run to three chunks", async () => {
	let calls = 0;
	const reviewer = new IdleReviewer(() => {}, async () => {
		calls++;
		return { suggestions: [], reviewed: 2, remaining: 10 - calls * 2, message: "chunk" };
	});
	const request = fixture([]);
	try {
		const result = await reviewer.start(request);
		assert.equal(calls, 3);
		assert.equal(result.reviewed, 6);
		assert.equal(result.remaining, 4);
		assert.match(reviewer.status, /4 entries remain/);
	} finally { rmSync(request.root, { recursive: true, force: true }); }
});

test("successful idle runs schedule backlog continuation after another idle delay", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const request = fixture([]);
	let calls = 0;
	const reviewer = new IdleReviewer(() => {}, async () => ({ suggestions: [], reviewed: 1, remaining: Math.max(0, 5 - ++calls), message: "chunk" }));
	try {
		reviewer.schedule(1000, () => request);
		t.mock.timers.tick(1000);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(calls, 3);
		t.mock.timers.tick(1000);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(calls, 5);
		assert.equal(reviewer.remaining, 0);
		await reviewer.cancel();
	} finally { rmSync(request.root, { recursive: true, force: true }); }
});

test("cancelling a later chunk preserves completed progress", async () => {
	const entries = Array.from({ length: 12 }, (_, i) => ({ id: `entry-${i}`, text: `[user]\n${"a".repeat(7000)}` }));
	const request = fixture(entries);
	const controller = new AbortController();
	try {
		let count = 0;
		const runner = new IdleReviewer(() => {}, (input) => analyze({ ...input, signal: controller.signal }, async () => {
			if (++count === 2) controller.abort();
			return empty;
		}));
		await assert.rejects(() => runner.start(request));
		assert.equal(count, 2);
		assert.deepEqual(readProgress(request.root).reviewed.test, selectChunk(entries, []).entries.map((entry) => entry.id));
	} finally { rmSync(request.root, { recursive: true, force: true }); }
});

test("overlap-only corrections do not produce a new suggestion", async () => {
	const request = fixture([{ id: "old", text: "[user]\nUse npm." }]);
	try {
		await analyze(request, async () => empty);
		await analyze({ ...request, entries: [...request.entries, { id: "new", text: "[user]\nContinue." }] }, async (worker) => {
			assert.equal(JSON.parse(worker.evidence).overlap[0].id, "old");
			return { observations: [], suggestions: [{ title: "Use npm", target: "AGENTS.md", rationale: "Use the correct package manager.", category: "correction", evidence: [{ session: "test", entry: "old", quote: "Use npm." }], baseHash: null, before: "", after: "Use npm.\n" }] };
		}).then((result) => assert.deepEqual(result.suggestions, []));
	} finally { rmSync(request.root, { recursive: true, force: true }); }
});

test("failure on a later chunk preserves earlier checkpoints and retries the failed chunk", async () => {
	const entries = Array.from({ length: 12 }, (_, i) => ({ id: `entry-${i}`, text: `[user]\n${"a".repeat(7000)}` }));
	const request = fixture(entries);
	let calls = 0;
	let failedIds: string[] = [];
	const reviewer = new IdleReviewer(() => {}, (input) => analyze(input, async (worker) => {
		if (++calls === 2) {
			failedIds = JSON.parse(worker.evidence).entries.map((entry: { id: string }) => entry.id);
			throw new Error("provider offline");
		}
		return empty;
	}));
	try {
		await assert.rejects(() => reviewer.start(request), /provider offline/);
		const progress = readProgress(request.root).reviewed.test;
		assert.ok(progress.length);
		assert.ok(failedIds.every((id) => !progress.includes(id)));
		await analyze(request, async (worker) => {
			const evidence = JSON.parse(worker.evidence);
			assert.deepEqual(evidence.entries.map((entry: { id: string }) => entry.id), failedIds);
			assert.ok(evidence.overlap.length);
			return empty;
		});
	} finally { rmSync(request.root, { recursive: true, force: true }); }
});
