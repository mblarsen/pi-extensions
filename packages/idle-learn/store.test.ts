import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CONFIG_PATH, initializeConfig, saveConfig } from "./config.ts";
import { contentHash, DATA_DIR, readProjectFile } from "./files.ts";
import { acquireProjectLock } from "./lock.ts";
import { decideSuggestion, listSuggestions, parseSuggestion, saveProposals, serializeSuggestion, validateProposal, type Proposal } from "./store.ts";

const directories: string[] = [];
function fixture(optIn = true): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "idle-learn-store-")));
	directories.push(root);
	if (optIn) initializeConfig(root);
	return root;
}
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function proposal(overrides: Partial<Proposal> = {}): Proposal {
	return {
		title: "Document the test command", target: "AGENTS.md", rationale: "Future sessions need the project test command.",
		evidence: [{ session: "session-1", entry: "entry-1", quote: "Use npm test for this project." }],
		baseHash: null, before: "", after: "# Project\n\nRun npm test.\n", ...overrides,
	};
}

test("suggestion operations cannot opt in a missing project", async () => {
	const root = fixture(false);
	await assert.rejects(() => saveProposals(root, [proposal()]), /init/);
	await assert.rejects(() => acquireProjectLock(root, "review"), /init/);
	assert.throws(() => listSuggestions(root), /init/);
	assert.deepEqual(readdirSync(root), []);
});

test("validated suggestions round trip as Markdown and do not modify targets", async () => {
	const root = fixture();
	const [suggestion] = await saveProposals(root, [proposal()]);
	assert.equal(readProjectFile(root, "AGENTS.md"), null);
	assert.deepEqual(parseSuggestion(serializeSuggestion(suggestion)), suggestion);
	assert.deepEqual(listSuggestions(root), [suggestion]);
	assert.equal(listSuggestions(root, "applied").length, 0);
});

test("applying a displayed suggestion creates the file and archives the decision", async () => {
	const root = fixture();
	const [suggestion] = await saveProposals(root, [proposal({ target: "src/AGENTS.md" })]);
	const result = await decideSuggestion(root, suggestion, "apply");
	assert.equal(readProjectFile(root, "src/AGENTS.md"), suggestion.after);
	assert.equal(result.status, "applied");
	assert.deepEqual(listSuggestions(root), []);
	assert.deepEqual(listSuggestions(root, "applied"), [result]);
	await assert.rejects(() => decideSuggestion(root, suggestion, "apply"), /no longer pending/);
});

test("rejecting records the reason and never edits the target", async () => {
	const root = fixture();
	const [suggestion] = await saveProposals(root, [proposal()]);
	const result = await decideSuggestion(root, suggestion, "reject", "  This belongs in the README.  ");
	assert.equal(result.reason, "This belongs in the README.");
	assert.equal(readProjectFile(root, "AGENTS.md"), null);
	assert.deepEqual(listSuggestions(root, "rejected"), [result]);
	assert.deepEqual(listSuggestions(root), []);
});

test("paused projects can review saved suggestions but cannot save new analysis", async () => {
	const root = fixture();
	const [suggestion] = await saveProposals(root, [proposal()]);
	const previous = readProjectFile(root, CONFIG_PATH);
	assert.ok(previous);
	saveConfig(root, { enabled: false, idle_minutes: 10 }, previous);
	assert.equal(listSuggestions(root).length, 1);
	await assert.rejects(() => saveProposals(root, []), /paused/);
	await assert.rejects(() => acquireProjectLock(root, "review"), /paused/);
	await decideSuggestion(root, suggestion, "reject");
	assert.equal(listSuggestions(root, "rejected").length, 1);
});

test("stale targets preserve unrelated user edits and pending suggestions", async () => {
	const root = fixture();
	writeFileSync(join(root, "AGENTS.md"), "Original instruction.\n");
	const [suggestion] = await saveProposals(root, [proposal({
		baseHash: contentHash("Original instruction.\n"), before: "Original", after: "Improved",
	})]);
	writeFileSync(join(root, "AGENTS.md"), "User edited the instruction.\n");
	await assert.rejects(() => decideSuggestion(root, suggestion, "apply"), /stale/);
	assert.equal(readProjectFile(root, "AGENTS.md"), "User edited the instruction.\n");
	assert.equal(listSuggestions(root).length, 1);
});

test("applying one suggestion makes another suggestion against the same base stale", async () => {
	const root = fixture();
	writeFileSync(join(root, "AGENTS.md"), "One. Two.\n");
	const baseHash = contentHash("One. Two.\n");
	const [first, second] = await saveProposals(root, [
		proposal({ baseHash, before: "One", after: "First" }),
		proposal({ baseHash, before: "Two", after: "Second" }),
	]);
	await decideSuggestion(root, first, "apply");
	await assert.rejects(() => decideSuggestion(root, second, "apply"), /stale/);
	assert.equal(readProjectFile(root, "AGENTS.md"), "First. Two.\n");
});

test("artifacts changed after display require review again", async () => {
	const root = fixture();
	const [suggestion] = await saveProposals(root, [proposal()]);
	const path = join(root, DATA_DIR, "suggestions", `${suggestion.id}.md`);
	writeFileSync(path, serializeSuggestion({ ...suggestion, after: "Unreviewed change.\n" }));
	await assert.rejects(() => decideSuggestion(root, suggestion, "apply"), /changed/);
	assert.equal(readProjectFile(root, "AGENTS.md"), null);
});

test("retargeting a pending suggestion to a symlink never writes outside the project", async () => {
	const root = fixture();
	const outside = fixture(false);
	const [suggestion] = await saveProposals(root, [proposal()]);
	writeFileSync(join(outside, "AGENTS.md"), "Outside\n");
	symlinkSync(join(outside, "AGENTS.md"), join(root, "AGENTS.md"));
	await assert.rejects(() => decideSuggestion(root, suggestion, "apply"), /symlink/);
	assert.equal(readProjectFile(outside, "AGENTS.md"), "Outside\n");
});

test("invalid batches are validated before any suggestion artifacts are saved", async () => {
	const root = fixture();
	for (const values of [
		[proposal(), proposal({ target: "../AGENTS.md" })],
		[proposal(), proposal()],
		[proposal({ before: "unexpected" })],
		[proposal({ evidence: [] })],
		[proposal(), proposal(), proposal(), proposal()],
	]) {
		await assert.rejects(() => saveProposals(root, values));
		assert.deepEqual(listSuggestions(root), []);
	}
	assert.throws(() => validateProposal({ ...proposal(), baseHash: "wrong" }));
	assert.throws(() => parseSuggestion("# Not a machine artifact"));
});

test("before text must identify one unique occurrence", async () => {
	const root = fixture();
	writeFileSync(join(root, "AGENTS.md"), "Repeat. Repeat.\n");
	await assert.rejects(() => saveProposals(root, [proposal({
		baseHash: contentHash("Repeat. Repeat.\n"), before: "Repeat", after: "Once",
	})]), /exactly once/);
});

test("pending, rejected, and applied duplicates are suppressed", async () => {
	const root = fixture();
	const [first] = await saveProposals(root, [proposal()]);
	await assert.rejects(() => saveProposals(root, [proposal()]), /Duplicate/);
	await decideSuggestion(root, first, "reject", "Not useful.");
	await assert.rejects(() => saveProposals(root, [proposal({ after: "# project\n\nRun   npm test.\n" })]), /Duplicate/);
});

test("an interrupted archive operation can finish without repeating a target edit", async () => {
	const root = fixture();
	const [suggestion] = await saveProposals(root, [proposal()]);
	writeFileSync(join(root, "AGENTS.md"), suggestion.after);
	await decideSuggestion(root, suggestion, "apply");
	assert.equal(readProjectFile(root, "AGENTS.md"), suggestion.after);
	assert.equal(listSuggestions(root, "applied").length, 1);
});

test("live locks exclude peers, release is idempotent, and dead-worker locks expire", async () => {
	const root = fixture();
	const first = await acquireProjectLock(root, "review");
	try {
		first.assertHeld();
		await assert.rejects(() => acquireProjectLock(root, "review"), /already being held/);
	} finally {
		await first.release();
	}
	await first.release();
	assert.throws(() => first.assertHeld(), /released/);
	const lockPath = join(root, DATA_DIR, "review.lock");
	mkdirSync(lockPath);
	const old = new Date(Date.now() - 60_000);
	utimesSync(lockPath, old, old);
	const recovered = await acquireProjectLock(root, "review");
	await recovered.release();
});

test("review locks exclude another Node process and recover after owner termination", async () => {
	const root = fixture();
	const moduleUrl = new URL("./lock.ts", import.meta.url).href;
	const script = `
		import { acquireProjectLock } from ${JSON.stringify(moduleUrl)};
		try {
			const lock = await acquireProjectLock(process.argv[1], 'review');
			process.stdout.write('acquired');
			if (process.argv[2] === 'leave-lock') process.kill(process.pid, 'SIGKILL');
			await lock.release();
		} catch (error) { process.stdout.write(error.code ?? error.message); }
	`;
	const run = (leaveLock = false) => spawnSync(process.execPath,
		["--input-type=module", "-e", script, root, ...(leaveLock ? ["leave-lock"] : [])],
		{ encoding: "utf8", timeout: 10_000 });
	const lock = await acquireProjectLock(root, "review");
	try {
		const contender = run();
		assert.equal(contender.status, 0, contender.stderr);
		assert.equal(contender.stdout, "ELOCKED");
	} finally {
		await lock.release();
	}
	const terminated = run(true);
	assert.equal(terminated.signal, "SIGKILL", terminated.stderr);
	assert.equal(terminated.stdout, "acquired");
	const lockPath = join(root, DATA_DIR, "review.lock");
	const old = new Date(Date.now() - 60_000);
	utimesSync(lockPath, old, old);
	const recovered = await acquireProjectLock(root, "review");
	await recovered.release();
});
