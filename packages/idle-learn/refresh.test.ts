import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { initializeConfig } from "./config.ts";
import { contentHash, readProjectFile } from "./files.ts";
import { refreshSuggestion } from "./refresh.ts";
import { decideSuggestion, listSuggestions, saveProposals } from "./store.ts";
import type { ReviewInput } from "./reviewer.ts";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
async function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "idle-refresh-"))); directories.push(root);
	initializeConfig(root);
	writeFileSync(join(root, "AGENTS.md"), "One. Two.\n");
	const base = { title: "Improve instruction", target: "AGENTS.md", rationale: "A user correction.", evidence: [{ session: "s1", entry: "e1", quote: "Use these terms." }], baseHash: contentHash("One. Two.\n") };
	const [first, second] = await saveProposals(root, [{ ...base, before: "One", after: "First" }, { ...base, before: "Two", after: "Second" }]);
	await decideSuggestion(root, first, "apply");
	const input: ReviewInput = { root, session: "s1", entries: [], provider: "test", model: "test", thinking: "off", signal: new AbortController().signal };
	return { root, first, second, input };
}

test("refresh preserves applied changes and evidence, and requires a separately reviewed Apply", async () => {
	const { root, first, second, input } = await fixture();
	const refreshed = await refreshSuggestion(input, second, async (request) => {
		assert.equal(request.purpose, "refresh");
		const evidence = JSON.parse(request.evidence);
		assert.equal(evidence.current.content, "First. Two.\n");
		assert.equal(evidence.original.after, "Second");
		return { before: "Two", after: "Second" };
	});
	assert.equal(readProjectFile(root, "AGENTS.md"), "First. Two.\n");
	assert.equal(refreshed.id, second.id);
	assert.deepEqual(refreshed.evidence, second.evidence);
	assert.equal(listSuggestions(root, "applied")[0].id, first.id);
	assert.deepEqual(listSuggestions(root), [refreshed]);
	await assert.rejects(() => decideSuggestion(root, second, "apply"), /changed/);
	await decideSuggestion(root, refreshed, "apply");
	assert.equal(readProjectFile(root, "AGENTS.md"), "First. Second.\n");
});

test("a target race during refresh leaves the original pending and does not write the target", async () => {
	const { root, second, input } = await fixture();
	await assert.rejects(() => refreshSuggestion(input, second, async () => {
		writeFileSync(join(root, "AGENTS.md"), "Newer user edit.\n");
		return { before: "Two", after: "Second" };
	}), /stale|changed/i);
	assert.deepEqual(listSuggestions(root), [second]);
	assert.equal(readProjectFile(root, "AGENTS.md"), "Newer user edit.\n");
});

test("failed, cancelled, or invalid refreshes preserve pending artifacts", async () => {
	for (const mode of ["failure", "cancel", "invalid", "conflict"] as const) {
		const { root, second, input } = await fixture();
		const controller = new AbortController(); input.signal = controller.signal;
		await assert.rejects(() => refreshSuggestion(input, second, async () => {
			if (mode === "failure") throw new Error("Provider unavailable");
			if (mode === "cancel") controller.abort();
			if (mode === "invalid") return { before: "Missing", after: "Unrelated" };
			if (mode === "conflict") return { conflict: "The instruction is already present." };
			return { before: "Two", after: "Second" };
		}));
		assert.deepEqual(listSuggestions(root), [second]);
		assert.equal(readProjectFile(root, "AGENTS.md"), "First. Two.\n");
	}
});

test("edits after refresh require another refresh rather than overwriting newer content", async () => {
	const { root, second, input } = await fixture();
	const refreshed = await refreshSuggestion(input, second, async () => ({ before: "Two", after: "Second" }));
	writeFileSync(join(root, "AGENTS.md"), "Changed again.\n");
	await assert.rejects(() => decideSuggestion(root, refreshed, "apply"), /stale/);
	assert.deepEqual(listSuggestions(root), [refreshed]);
});


test("a decision made during model refresh cannot be replaced or resurrected", async () => {
	const { root, second, input } = await fixture();
	await assert.rejects(() => refreshSuggestion(input, second, async () => {
		await decideSuggestion(root, second, "reject", "No longer needed.");
		return { before: "Two", after: "Second" };
	}), /changed/);
	assert.equal(listSuggestions(root).length, 0);
	assert.equal(listSuggestions(root, "rejected")[0].id, second.id);
});
