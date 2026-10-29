import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { addComment, applyBatch, BATCH_DIR, createBatch, discardBatch, draftState, listBatches, parseBatch, readBatch, removeSource, resumeApply, type Batch } from "./batch.ts";
import { initializeConfig } from "./config.ts";
import { contentHash, DATA_DIR, readProjectFile } from "./files.ts";
import { integrateBatch, type IntegrationInput } from "./integrate.ts";
import { acquireProjectLock } from "./lock.ts";
import { markdownLinks } from "./scope.ts";
import { calibrate, ordinaryDecisions } from "./calibration.ts";
import { decideSuggestion, listSuggestions, parseSuggestion, saveProposals, serializeSuggestion, type Proposal, type Suggestion } from "./store.ts";
import type { WorkerRequest } from "./worker.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const AGENTS = "# Project\n\n## Testing\n\nRun npm test.\n\n## Notes\n\nUnrelated note.\n";
function fixture(agents: string | null = AGENTS) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "idle-batch-"))); roots.push(root); initializeConfig(root);
	if (agents !== null) writeFileSync(join(root, "AGENTS.md"), agents);
	return root;
}
function proposal(index: number, overrides: Partial<Proposal> = {}): Proposal {
	return { title: `Lesson ${index}`, target: "AGENTS.md", rationale: `Rationale ${index}`, evidence: [{ session: "s", entry: `e${index}`, quote: `Quote ${index}` }],
		baseHash: contentHash(AGENTS), before: "Run npm test.", after: `Run npm test.\nLesson ${index}.`, ...overrides };
}
async function pending(root: string, count = 2): Promise<Suggestion[]> {
	const saved: Suggestion[] = [];
	for (let index = 1; index <= count; index++) saved.push(...await saveProposals(root, [proposal(index)]));
	return saved;
}
const input = (root: string, signal = AbortSignal.timeout(5000)): IntegrationInput => ({ root, provider: "example", model: "test", thinking: "off", signal });
const combined = { summary: "Combined both testing lessons under Testing.", notes: [{ number: 1, note: "Added." }, { number: 2, note: "Merged with #1." }],
	files: [{ path: "AGENTS.md", edits: [{ before: "Run npm test.", after: "Run npm test.\nLessons 1 and 2, combined." }] }] };
const RESULT = AGENTS.replace("Run npm test.", "Run npm test.\nLessons 1 and 2, combined.");

test("selection records numbered sources and never writes targets or archives suggestions", async () => {
	const root = fixture();
	const [first, second] = await pending(root);
	const batch = await createBatch(root, [first, second]);
	assert.deepEqual(batch.sources.map((source) => [source.number, source.id]), [[1, first.id], [2, second.id]]);
	assert.equal(readProjectFile(root, "AGENTS.md"), AGENTS);
	assert.equal(listSuggestions(root).length, 2);
	assert.deepEqual(listSuggestions(root, "applied"), []);
	assert.deepEqual(listBatches(root).map((item) => item.id), [batch.id]);
	await assert.rejects(createBatch(root, []), /at least one/);
	await assert.rejects(createBatch(root, [{ ...first, title: "Edited elsewhere" }]), /changed/);
});

test("comments persist, numbers stay stable after removal, and discard leaves proposals pending", async () => {
	const root = fixture();
	const items = await pending(root, 3);
	const batch = await createBatch(root, items);
	await addComment(root, batch.id, "Merge #1 and #3.");
	await removeSource(root, batch.id, 2);
	const stored = readBatch(root, batch.id);
	assert.deepEqual(stored.sources.map((source) => source.number), [1, 3]);
	assert.deepEqual(stored.comments.map((comment) => comment.text), ["Merge #1 and #3."]);
	await assert.rejects(addComment(root, batch.id, "  "), /empty/);
	await discardBatch(root, batch.id);
	assert.deepEqual(listBatches(root), []);
	assert.equal(listSuggestions(root).length, 3);
	assert.equal(readBatch(root, batch.id).status, "discarded");
});

test("malformed or tampered batch files fail closed", async () => {
	const root = fixture();
	const batch = await createBatch(root, await pending(root, 1));
	assert.throws(() => parseBatch("{"), /Invalid batch/);
	assert.throws(() => parseBatch(JSON.stringify({ ...batch, sources: [...batch.sources, batch.sources[0]] })), /Invalid batch/);
	await integrateBatch(input(root), batch.id, async () => ({ ...combined, notes: [{ number: 1, note: "Added." }] }));
	const stored = readBatch(root, batch.id);
	const tampered: Batch = { ...stored, draft: { ...stored.draft!, files: [{ ...stored.draft!.files[0], content: "Injected.\n" }] } };
	assert.throws(() => parseBatch(JSON.stringify(tampered)), /draft hash/);
});

test("integration sends numbered original diffs and comments, then saves a reviewable draft without applying", async () => {
	const root = fixture();
	const batch = await createBatch(root, await pending(root));
	await addComment(root, batch.id, "Keep #2 short.");
	let request!: WorkerRequest;
	const result = await integrateBatch(input(root), batch.id, async (value) => { request = value; return combined; });
	const data = JSON.parse(request.evidence);
	assert.equal(request.purpose, "integrate");
	assert.match(request.systemPrompt, /Assess the existing structure/);
	assert.match(request.systemPrompt, /Do not split files merely because the document is long/);
	assert.deepEqual(data.proposals.map((item: any) => item.number), [1, 2]);
	assert.match(data.proposals[0].originalDiff, /\+Lesson 1\./);
	assert.deepEqual(data.comments, ["Keep #2 short."]);
	assert.equal(data.targets[0].content, AGENTS);
	assert.equal(result.draft!.files[0].content, RESULT);
	assert.match(result.draft!.files[0].content, /Unrelated note/);
	assert.equal(readProjectFile(root, "AGENTS.md"), AGENTS);
	assert.equal(listSuggestions(root).length, 2);
	assert.deepEqual(draftState(root, result), { kind: "fresh" });
});

test("regeneration passes the previous draft and new comments and never applies", async () => {
	const root = fixture();
	const batch = await createBatch(root, await pending(root));
	await integrateBatch(input(root), batch.id, async () => combined);
	await addComment(root, batch.id, "Use a bullet list.");
	assert.match((draftState(root, readBatch(root, batch.id)) as any).reason, /comments/);
	let data: any;
	const second = await integrateBatch(input(root), batch.id, async (request) => {
		data = JSON.parse(request.evidence);
		return { ...combined, files: [{ path: "AGENTS.md", edits: [{ before: "Run npm test.", after: "Run npm test.\n- Lesson 1\n- Lesson 2" }] }] };
	});
	assert.equal(data.previousDraft.files[0].content, RESULT);
	assert.deepEqual(data.comments, ["Use a bullet list."]);
	assert.match(second.draft!.files[0].content, /- Lesson 2/);
	assert.equal(readProjectFile(root, "AGENTS.md"), AGENTS);
});

test("invalid reviewer output, conflicts, and out-of-scope paths save no draft and keep the batch", async () => {
	const root = fixture();
	writeFileSync(join(root, "README.md"), "Readme\n");
	mkdirSync(join(root, "other")); writeFileSync(join(root, "other/AGENTS.md"), "Other\n");
	const batch = await createBatch(root, await pending(root));
	const cases: Array<[unknown, RegExp]> = [
		[{ conflict: "#1 contradicts #2." }, /conflict: #1 contradicts/],
		[{ ...combined, notes: [{ number: 1, note: "Only one." }] }, /every selected proposal/],
		[{ ...combined, files: [{ path: "AGENTS.md", edits: [{ before: "missing", after: "x" }] }] }, /exactly one location/],
		[{ ...combined, files: [{ path: "AGENTS.md", content: "Replaced.\n" }] }, /edits, not replaced/],
		[{ ...combined, files: [{ path: "other/AGENTS.md", edits: [{ before: "Other", after: "Changed" }] }] }, /only the selected/],
		[{ ...combined, files: [{ path: "README.md", edits: [{ before: "Readme", after: "Changed" }] }] }, /Markdown|already linked/],
		[{ ...combined, files: [{ path: ".pi/idle-learn/config.toml.md", content: "x" }] }, /Pi state/],
		[{ ...combined, files: [{ path: "../escape.md", content: "x" }] }, /Invalid project path/],
		[{ ...combined, files: [] }, /no file changes/],
	];
	for (const [output, pattern] of cases) await assert.rejects(integrateBatch(input(root), batch.id, async () => output), pattern);
	const stored = readBatch(root, batch.id);
	assert.equal(stored.draft, undefined);
	assert.match(stored.error!, /no file changes/);
	assert.equal(stored.status, "open");
	assert.equal(readProjectFile(root, "README.md"), "Readme\n");
});

test("reference extraction creates linked Markdown inside the AGENTS.md directory and applies all files together", async () => {
	const root = fixture();
	const batch = await createBatch(root, await pending(root));
	const output = { ...combined, summary: "Moved testing detail into docs/agents/testing.md.", files: [
		{ path: "AGENTS.md", edits: [{ before: "Run npm test.", after: "Run npm test. See [testing](docs/agents/testing.md)." }] },
		{ path: "docs/agents/testing.md", content: "# Testing\n\nLesson 1.\nLesson 2.\n" },
	] };
	const draft = await integrateBatch(input(root), batch.id, async () => output);
	assert.deepEqual(draft.draft!.files.map((file) => [file.path, file.baseHash === null]), [["AGENTS.md", false], ["docs/agents/testing.md", true]]);
	await applyBatch(root, draft);
	assert.match(readProjectFile(root, "AGENTS.md")!, /\[testing\]\(docs\/agents\/testing\.md\)/);
	assert.equal(readProjectFile(root, "docs/agents/testing.md"), "# Testing\n\nLesson 1.\nLesson 2.\n");
	const unlinked = await createBatch(root, await saveProposals(root, [proposal(3, { baseHash: contentHash(readProjectFile(root, "AGENTS.md")!), before: "# Project", after: "# Project\n\nLesson 3." })]));
	await assert.rejects(integrateBatch(input(root), unlinked.id, async () => ({ summary: "s", notes: [{ number: 1, note: "n" }], files: [{ path: "docs/agents/other.md", content: "Orphan\n" }] })), /must be linked/);
	await assert.rejects(integrateBatch(input(root), unlinked.id, async () => ({ summary: "s", notes: [{ number: 1, note: "n" }], files: [
		{ path: "AGENTS.md", edits: [{ before: "# Project", after: "# Project\n[a](a.md) [b](b.md) [c](c.md) [d](d.md)" }] },
		...["a", "b", "c", "d"].map((name) => ({ path: `${name}.md`, content: `${name}\n` })),
	] })), /at most 3/);
});

test("existing linked references may change, symlinked references may not", async () => {
	const root = fixture(AGENTS.replace("Unrelated note.", "See [guide](guide.md)."));
	writeFileSync(join(root, "guide.md"), "Guide.\n");
	const base = contentHash(readProjectFile(root, "AGENTS.md")!);
	const batch = await createBatch(root, await saveProposals(root, [proposal(1, { baseHash: base })]));
	let data: any;
	const result = await integrateBatch(input(root), batch.id, async (request) => { data = JSON.parse(request.evidence); return { summary: "Guide.", notes: [{ number: 1, note: "In guide." }], files: [{ path: "guide.md", edits: [{ before: "Guide.", after: "Guide.\nLesson 1." }] }] }; });
	assert.deepEqual(data.linkedReferences.map((item: any) => item.path), ["guide.md"]);
	assert.equal(result.draft!.files[0].path, "guide.md");
	const outside = fixture(null);
	rmSync(join(root, "guide.md")); writeFileSync(join(outside, "guide.md"), "Outside\n"); symlinkSync(join(outside, "guide.md"), join(root, "guide.md"));
	await assert.rejects(applyBatch(root, result), /symlink|changed/);
	assert.equal(readProjectFile(outside, "guide.md"), "Outside\n");
	assert.deepEqual(markdownLinks("[a](./x.md) [b](https://e.com/y.md) [c](../z.md) [d](#top) [e](sub/w.md#part) [f](../../out.md)", "dir/AGENTS.md"), ["dir/sub/w.md", "dir/x.md", "z.md"]);
});

test("Apply archives every selected proposal as applied and linked to the integration", async () => {
	const root = fixture();
	const items = await pending(root);
	const batch = await createBatch(root, items);
	const draft = await integrateBatch(input(root), batch.id, async () => ({ ...combined, notes: [{ number: 1, note: "Added." }, { number: 2, note: "Already covered by existing text." }] }));
	const applied = await applyBatch(root, draft);
	assert.equal(applied.status, "applied");
	assert.equal(readProjectFile(root, "AGENTS.md"), RESULT);
	assert.deepEqual(listSuggestions(root), []);
	const archived = listSuggestions(root, "applied");
	assert.deepEqual(archived.map((item) => item.integration), items.map(() => ({ batch: batch.id, draft: draft.draft!.hash })));
	assert.equal(ordinaryDecisions(root).filter((item) => item.status === "applied").length, 2);
	assert.deepEqual(listBatches(root), []);
	await assert.rejects(applyBatch(root, applied), /changed|applied/);
});

test("changed targets, decided sources, and changed comments block Apply until regeneration", async () => {
	const root = fixture();
	const items = await pending(root);
	const batch = await createBatch(root, items);
	const draft = await integrateBatch(input(root), batch.id, async () => combined);
	writeFileSync(join(root, "AGENTS.md"), `${AGENTS}User edit.\n`);
	await assert.rejects(applyBatch(root, draft), /AGENTS\.md changed since this draft/);
	assert.equal(readProjectFile(root, "AGENTS.md"), `${AGENTS}User edit.\n`);
	assert.equal(listSuggestions(root).length, 2);
	assert.equal(readBatch(root, batch.id).status, "open");
	const fresh = await integrateBatch(input(root), batch.id, async () => combined);
	await decideSuggestion(root, items[1], "reject", "No.");
	await assert.rejects(applyBatch(root, fresh), /#2 rejected elsewhere/);
	const commented = await addComment(root, (await createBatch(root, [items[0]])).id, "Hi");
	await assert.rejects(applyBatch(root, commented), /Integrate the batch/);
});

test("concurrent source edits or target changes during the model call reject the draft", async () => {
	const root = fixture();
	const items = await pending(root);
	const batch = await createBatch(root, items);
	await assert.rejects(integrateBatch(input(root), batch.id, async () => { writeFileSync(join(root, "AGENTS.md"), "Changed.\n"); return combined; }), /changed during integration/);
	writeFileSync(join(root, "AGENTS.md"), AGENTS);
	await assert.rejects(integrateBatch(input(root), batch.id, async () => {
		const path = join(root, DATA_DIR, "suggestions", `${items[0].id}.md`);
		writeFileSync(path, serializeSuggestion({ ...parseSuggestion(readProjectFile(root, `${DATA_DIR}/suggestions/${items[0].id}.md`)!), title: "Edited" }));
		return combined;
	}), /changed during integration/);
	assert.equal(readBatch(root, batch.id).draft, undefined);
});

test("integration locks only its own batch and holds no storage lock during the model call", async () => {
	const root = fixture();
	const items = await pending(root, 2);
	const first = await createBatch(root, [items[0]]), second = await createBatch(root, [items[1]]);
	let release!: () => void; const gate = new Promise<void>((done) => { release = done; });
	let started!: () => void; const running = new Promise<void>((done) => { started = done; });
	const output = (number: number) => ({ summary: "s", notes: [{ number: 1, note: "n" }], files: [{ path: "AGENTS.md", edits: [{ before: "Run npm test.", after: `Run npm test.\nLesson ${number}.` }] }] });
	const active = integrateBatch(input(root), first.id, async () => {
		started(); await gate;
		return output(1);
	});
	await running;
	await assert.rejects(integrateBatch(input(root), first.id, async () => output(1)), /already being integrated/);
	await integrateBatch(input(root), second.id, async () => output(2));
	const storage = await acquireProjectLock(root, "storage"); await storage.release();
	await analyzeFreely(root);
	release(); await active;
	assert.ok(readBatch(root, first.id).draft);
	assert.deepEqual(readdirSync(join(root, DATA_DIR)).filter((name) => name.endsWith(".lock")), []);
});
async function analyzeFreely(root: string) {
	await calibrate({ root, session: "c", entries: [], provider: "example", model: "test", thinking: "off", signal: AbortSignal.timeout(5000) }, async () => ({ suggestions: [] }));
}

test("cancellation keeps the batch, comments, and previous draft for retry", async () => {
	const root = fixture();
	const batch = await createBatch(root, await pending(root));
	await integrateBatch(input(root), batch.id, async () => combined);
	await addComment(root, batch.id, "Retry this.");
	const controller = new AbortController();
	await assert.rejects(integrateBatch(input(root, controller.signal), batch.id, async (_request, signal) => new Promise((_resolve, reject) => {
		signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }); controller.abort();
	})), /Cancelled/);
	const stored = readBatch(root, batch.id);
	assert.equal(stored.status, "open");
	assert.deepEqual(stored.comments.map((comment) => comment.text), ["Retry this."]);
	assert.equal(stored.draft!.files[0].content, RESULT);
	assert.equal(readProjectFile(root, "AGENTS.md"), AGENTS);
});

test("an interrupted multi-file Apply never reports success and resumes without repeating writes", async () => {
	const root = fixture();
	const batch = await createBatch(root, await pending(root));
	const draft = await integrateBatch(input(root), batch.id, async () => ({ ...combined, files: [
		{ path: "AGENTS.md", edits: [{ before: "Run npm test.", after: "Run npm test. See [testing](testing.md)." }] },
		{ path: "testing.md", content: "Lessons.\n" },
	] }));
	await assert.rejects(applyBatch(root, draft, { afterFile: (path) => { if (path === "AGENTS.md") throw new Error("Disk full"); } }), /Disk full/);
	const partial = readBatch(root, batch.id);
	assert.equal(partial.status, "applying");
	assert.match(partial.error!, /Disk full/);
	assert.equal(readProjectFile(root, "testing.md"), null);
	assert.equal(listSuggestions(root).length, 2);
	assert.deepEqual(listBatches(root).map((item) => item.status), ["applying"]);
	await assert.rejects(integrateBatch(input(root), batch.id, async () => combined), /partially applied/);
	await assert.rejects(discardBatch(root, batch.id), /partially applied/);
	const writes: string[] = [];
	const done = await resumeApply(root, batch.id, { afterFile: (path) => writes.push(path) });
	assert.deepEqual(writes, ["testing.md"]);
	assert.equal(done.status, "applied");
	assert.equal(done.error, undefined);
	assert.equal(listSuggestions(root, "applied").length, 2);
});

test("recovery stops on a file that diverged after the journal", async () => {
	const root = fixture();
	const batch = await createBatch(root, await pending(root));
	const draft = await integrateBatch(input(root), batch.id, async () => ({ ...combined, files: [
		{ path: "AGENTS.md", edits: [{ before: "Run npm test.", after: "Run npm test. See [testing](testing.md)." }] },
		{ path: "testing.md", content: "Lessons.\n" },
	] }));
	await assert.rejects(applyBatch(root, draft, { afterFile: () => { throw new Error("Interrupted"); } }));
	writeFileSync(join(root, "testing.md"), "Someone else.\n");
	await assert.rejects(resumeApply(root, batch.id), /testing\.md changed during Apply/);
	assert.equal(readBatch(root, batch.id).status, "applying");
	assert.equal(readProjectFile(root, "testing.md"), "Someone else.\n");
	assert.equal(listSuggestions(root).length, 2);
});

test("archives written before an interruption are reused on resume", async () => {
	const root = fixture();
	const batch = await createBatch(root, await pending(root));
	const draft = await integrateBatch(input(root), batch.id, async () => combined);
	const path = join(root, BATCH_DIR, `${batch.id}.json`);
	const applied = await applyBatch(root, draft);
	// Simulate a crash after archiving but before the final status write.
	writeFileSync(path, JSON.stringify({ ...applied, status: "applying" }, null, 2));
	const resumed = await resumeApply(root, batch.id);
	assert.equal(resumed.status, "applied");
	assert.equal(listSuggestions(root, "applied").length, 2);
});

test("legacy suggestion artifacts without integration links remain readable", async () => {
	const root = fixture();
	const [item] = await pending(root, 1);
	const legacy = serializeSuggestion(item);
	assert.equal(parseSuggestion(legacy).integration, undefined);
	assert.throws(() => parseSuggestion(serializeSuggestion({ ...item, integration: { batch: item.id, draft: "a".repeat(64) } })), /integration link/);
	assert.deepEqual(parseSuggestion(serializeSuggestion({ ...item, status: "applied", integration: { batch: item.id, draft: "a".repeat(64) } })).integration, { batch: item.id, draft: "a".repeat(64) });
});
