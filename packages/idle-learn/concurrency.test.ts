import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { initializeConfig } from "./config.ts";
import { DATA_DIR } from "./files.ts";
import { calibrate } from "./calibration.ts";
import { acquireProjectLock } from "./lock.ts";
import { analyze, type ReviewInput } from "./reviewer.ts";
import { readObservations, readProgress } from "./state.ts";
import { decideSuggestion, listSuggestions, saveProposals } from "./store.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "idle-concurrent-"))); roots.push(root); initializeConfig(root);
	return root;
}
function input(root: string, session: string): ReviewInput {
	return { root, session, entries: [{ id: "entry-1", text: "Use npm test." }], provider: "example", model: "test", thinking: "off", signal: AbortSignal.timeout(5000) };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

test("different sessions analyze in parallel and merge progress and observations", async () => {
	const root = fixture();
	const firstReady = deferred<void>(), secondReady = deferred<void>();
	const firstOutput = deferred<any>(), secondOutput = deferred<any>();
	const first = analyze(input(root, "first"), async () => { firstReady.resolve(); return firstOutput.promise; });
	await firstReady.promise;
	const second = analyze(input(root, "second"), async () => { secondReady.resolve(); return secondOutput.promise; });
	await Promise.race([secondReady.promise, second]);
	const output = (session: string) => ({ suggestions: [], observations: [{ lesson: `Lesson ${session}`, category: "repeated-instruction", evidence: [{ session, entry: "entry-1", quote: "Use npm test." }] }] });
	firstOutput.resolve(output("first")); await first;
	secondOutput.resolve(output("second")); await second;
	assert.deepEqual(readProgress(root).reviewed, { first: ["entry-1"], second: ["entry-1"] });
	assert.deepEqual(readObservations(root).map((item) => item.lesson).sort(), ["Lesson first", "Lesson second"]);
});

test("same-session analysis runs concurrently without a review lock and merges its checkpoint", async () => {
	const root = fixture();
	const ready = deferred<void>(), finish = deferred<any>();
	const proposal = { title: "Test command", target: "AGENTS.md", rationale: "User correction", category: "correction", evidence: [{ session: "same", entry: "entry-1", quote: "Use npm test." }], baseHash: null, before: "", after: "Run npm test.\n" };
	const first = analyze(input(root, "same"), async () => { ready.resolve(); return finish.promise; });
	await ready.promise;
	const second = await analyze(input(root, "same"), async () => ({ suggestions: [proposal], observations: [] }));
	finish.resolve({ suggestions: [proposal], observations: [] });
	const result = await first;
	assert.equal(second.suggestions.length + result.suggestions.length, 1);
	assert.equal(listSuggestions(root).length, 1);
	assert.deepEqual(readProgress(root).reviewed.same, ["entry-1"]);
});

test("generation never creates long-running lock files", async () => {
	const root = fixture();
	await analyze(input(root, "one"), async () => {
		assert.deepEqual(readdirSync(join(root, DATA_DIR)).filter((name) => name.endsWith(".lock")), []);
		return { suggestions: [], observations: [] };
	});
});

test("parallel identical proposals are deduplicated without losing either session checkpoint", async () => {
	const root = fixture();
	const ready = deferred<void>(), finish = deferred<any>();
	const first = analyze(input(root, "first"), async () => { ready.resolve(); return finish.promise; });
	await ready.promise;
	const second = await analyze(input(root, "second"), async () => output("second"));
	function output(session: string) { return { suggestions: [{ title: "Test command", target: "AGENTS.md", rationale: "User correction", category: "correction", evidence: [{ session, entry: "entry-1", quote: "Use npm test." }], baseHash: null, before: "", after: "Run npm test.\n" }], observations: [] }; }
	finish.resolve(output("first"));
	const result = await first;
	assert.equal(second.suggestions.length, 1);
	assert.equal(result.suggestions.length, 0);
	assert.equal(listSuggestions(root).length, 1);
	assert.deepEqual(Object.keys(readProgress(root).reviewed).sort(), ["first", "second"]);
});

test("short storage contention retries instead of losing a decision", async () => {
	const root = fixture();
	const lock = await acquireProjectLock(root, "storage");
	const save = saveProposals(root, []);
	await new Promise<void>((done) => setImmediate(done));
	await lock.release();
	assert.deepEqual(await save, []);
});


test("calibration and ordinary analysis overlap without overwriting each other's checkpoints", async () => {
	for (const calibrationFirst of [true, false]) {
		const root = fixture();
		const [item] = await saveProposals(root, [{ title: "Test instruction", target: "AGENTS.md", rationale: "Correction", evidence: [{ session: "s", entry: "e", quote: "Use npm test." }], baseHash: null, before: "", after: "Run npm test.\n" }]);
		await decideSuggestion(root, item, "reject");
		const ready = deferred<void>(), finish = deferred<any>();
		if (calibrationFirst) {
			const active = calibrate(input(root, "calibration"), async () => { ready.resolve(); return finish.promise; });
			await ready.promise;
			await analyze(input(root, "ordinary"), async () => ({ suggestions: [], observations: [] }));
			finish.resolve({ suggestions: [] }); await active;
		} else {
			const active = analyze(input(root, "ordinary"), async () => { ready.resolve(); return finish.promise; });
			await ready.promise;
			await calibrate(input(root, "calibration"), async () => ({ suggestions: [] }));
			finish.resolve({ suggestions: [], observations: [] }); await active;
		}
		assert.deepEqual(readProgress(root).reviewed.ordinary, ["entry-1"]);
		assert.deepEqual(readProgress(root).calibration?.rejections, [item.id]);
	}
});
