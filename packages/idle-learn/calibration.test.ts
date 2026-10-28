import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, readdirSync, symlinkSync, linkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { calibrate, calibrationDue } from "./calibration.ts";
import { CONFIG_PATH, initializeConfig, parseConfig, requireOptIn, saveConfig, serializeConfig } from "./config.ts";
import { atomicProjectWrite, contentHash, readProjectFile } from "./files.ts";
import { acquireProjectLock } from "./lock.ts";
import { PREFERENCES_PATH, readPreferences } from "./preferences.ts";
import { analyze, effectivePrompt, type ReviewInput } from "./reviewer.ts";
import { readProgress, STATE_PATH } from "./state.ts";
import { decideSuggestion, listSuggestions, saveProposals, serializeSuggestion, type Proposal } from "./store.ts";
import type { WorkerRequest } from "./worker.ts";

const directories: string[] = [];
function fixture(enabled = true) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "idle-calibration-")));
	directories.push(root);
	if (enabled) initializeConfig(root);
	return root;
}
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });
function input(root: string, signal = new AbortController().signal): ReviewInput {
	return { root, session: "test", entries: [], provider: "test", model: "test", thinking: "off", signal, purpose: "calibration" };
}
function configure(root: string, fields: object) {
	const before = readProjectFile(root, CONFIG_PATH)!;
	saveConfig(root, { ...requireOptIn(root, true), ...fields }, before);
}
async function decision(root: string, index: number, outcome: "apply" | "reject" = "reject", after?: string) {
	const [item] = await saveProposals(root, [{ title: `Feature lesson ${index}`, target: `scope-${index}/AGENTS.md`, rationale: "A feature correction.",
		evidence: [{ session: "test", entry: String(index), quote: "Check the rendered feature." }], baseHash: null, before: "", after: after ?? `Check feature ${index} after changes.\n` }]);
	return decideSuggestion(root, item, outcome, outcome === "reject" ? "Too specific to this feature." : undefined);
}
function response(request: WorkerRequest, overrides: Partial<Proposal> = {}) {
	const data = JSON.parse(request.evidence);
	return { suggestions: [{ kind: "calibration", title: "Prefer lasting project conventions", target: PREFERENCES_PATH,
		rationale: "Feature-specific corrections were rejected; keep reusable guidance conditional.", evidence: [{ session: "decision", entry: data.decisions[0].id, quote: "Check feature" }],
		baseHash: data.preferences.baseHash, before: data.preferences.content ?? "", after: "Prefer lasting workflow conventions. Omit one-off feature fixes unless explicitly identified as reusable guidance.\n", ...overrides }] };
}

test("calibration threshold defaults to three and strict TOML supports zero and one", () => {
	assert.equal(initializeConfig(fixture(false)).calibration!.after_rejections, 3);
	assert.equal(parseConfig("enabled = true").calibration?.after_rejections ?? 3, 3);
	for (const threshold of [0, 1, 3, 1000]) {
		const config = parseConfig(`enabled = true\n[calibration]\nafter_rejections = ${threshold}\n`);
		assert.equal(parseConfig(serializeConfig(config)).calibration!.after_rejections, threshold);
	}
	for (const value of ["-1", "1.5", "1001", "'3'", "true"]) assert.throws(() => parseConfig(`enabled = true\n[calibration]\nafter_rejections = ${value}`));
	for (const text of ["calibration = []", "calibration = 3", "[calibration]\nunknown = 1"]) assert.throws(() => parseConfig(`enabled = true\n${text}`));
});

test("missing opt-in and paused projects make no calibration calls or writes", async () => {
	const root = fixture(false);
	assert.equal(calibrationDue(root), false);
	await assert.rejects(calibrate(input(root), async () => { throw new Error("Must not call"); }), /init/);
	assert.deepEqual(readdirSync(root), []);
	initializeConfig(root); configure(root, { enabled: false });
	await assert.rejects(calibrate(input(root)), /paused/);
	assert.equal(readProjectFile(root, STATE_PATH), null);
});

test("only unprocessed ordinary rejections reach the threshold", async () => {
	const root = fixture();
	await decision(root, 1, "apply");
	for (let index = 2; index <= 4; index++) {
		await decision(root, index);
		assert.equal(calibrationDue(root), index === 4);
	}
	configure(root, { calibration: { after_rejections: 0 } });
	assert.equal(calibrationDue(root), false);
	configure(root, { calibration: { after_rejections: 1 } });
	assert.equal(calibrationDue(root), true);
});

test("calibration uses a distinct prompt and captures preferences as evidence, never as calibrator instructions", async () => {
	const root = fixture();
	await decision(root, 1);
	atomicProjectWrite(root, PREFERENCES_PATH, "EXISTING_PREFERENCE_MARKER: never change this preference.\n", null);
	configure(root, { prompt_file: "does-not-exist.md", append_file: "also-missing.md" });
	await calibrate(input(root), async (request) => {
		assert.equal(request.purpose, "calibration");
		assert.match(request.systemPrompt, /You calibrate Idle Learn/);
		assert.doesNotMatch(request.systemPrompt, /EXISTING_PREFERENCE_MARKER|You review project session evidence/);
		assert.match(request.evidence, /EXISTING_PREFERENCE_MARKER/);
		assert.deepEqual(JSON.parse(request.evidence).decisions.length, 1);
		return { suggestions: [] };
	});
	assert.throws(() => effectivePrompt(root, requireOptIn(root)), /ENOENT/);
});

test("calibration proposals do not affect ordinary reviews until explicitly applied", async () => {
	const root = fixture(); await decision(root, 1);
	const beforeConfig = readProjectFile(root, CONFIG_PATH);
	const result = await calibrate(input(root), async (request) => response(request));
	assert.equal(result.suggestions[0].kind, "calibration");
	assert.match(serializeSuggestion(result.suggestions[0]), /Type: Calibration/);
	assert.equal(readPreferences(root), null);
	assert.doesNotMatch(effectivePrompt(root, requireOptIn(root)), /Approved Project Reviewer Preferences/);
	assert.deepEqual(listSuggestions(root), result.suggestions);
	assert.equal(readProjectFile(root, CONFIG_PATH), beforeConfig);
	await decideSuggestion(root, result.suggestions[0], "apply");
	assert.match(readPreferences(root)!, /lasting workflow conventions/);
	assert.match(effectivePrompt(root, requireOptIn(root)), /Approved Project Reviewer Preferences/);
	assert.equal(readProjectFile(root, "AGENTS.md"), null);
	await analyze({ ...input(root), purpose: undefined, entries: [{ id: "new", text: "[user]\nContinue." }] }, async (request) => {
		assert.match(request.systemPrompt, /lasting workflow conventions/);
		assert.ok(JSON.parse(request.evidence).previousSuggestions.every((item: { kind?: string }) => item.kind !== "calibration"));
		return { suggestions: [], observations: [] };
	});
	assert.equal(readProgress(root).calibration!.rejections.length, 1);
});

test("pending calibration suppresses manual and automatic duplicates; calibration rejections do not feed back", async () => {
	const root = fixture(); await decision(root, 1);
	const result = await calibrate(input(root), async (request) => response(request));
	for (let index = 2; index <= 4; index++) await decision(root, index);
	assert.equal(calibrationDue(root), false);
	let calls = 0;
	await calibrate(input(root), async () => { calls++; return { suggestions: [] }; });
	assert.equal(calls, 0);
	await decideSuggestion(root, result.suggestions[0], "reject", "Too broad.");
	assert.equal(readPreferences(root), null);
	assert.equal(calibrationDue(root), true);
	await calibrate(input(root), async (request) => {
		assert.equal(JSON.parse(request.evidence).decisions.length, 4);
		assert.doesNotMatch(request.evidence, /Too broad/);
		return { suggestions: [] };
	});
	assert.equal(calibrationDue(root), false);
});

test("successful zero-result calibration checkpoints only captured rejections and preserves ordinary progress", async () => {
	const root = fixture(); configure(root, { calibration: { after_rejections: 1 } });
	const first = await decision(root, 1);
	atomicProjectWrite(root, STATE_PATH, JSON.stringify({ version: 1, reviewed: { session: ["old"] }, audits: { "AGENTS.md": "old-hash" } }), null);
	let later = "";
	await calibrate(input(root), async () => { later = (await decision(root, 2)).id; return { suggestions: [] }; });
	const progress = readProgress(root);
	assert.deepEqual(progress.reviewed, { session: ["old"] });
	assert.deepEqual(progress.audits, { "AGENTS.md": "old-hash" });
	assert.deepEqual(progress.calibration!.rejections, [first.id]);
	assert.ok(!progress.calibration!.rejections.includes(later));
	assert.equal(calibrationDue(root), true);
});

test("manual calibration bypasses the threshold, and absent history makes no model call", async () => {
	const root = fixture(); configure(root, { calibration: { after_rejections: 0 } });
	await calibrate(input(root), async () => { throw new Error("No history must not call"); });
	await decision(root, 1, "apply");
	let calls = 0;
	await calibrate(input(root), async () => { calls++; return { suggestions: [] }; });
	assert.equal(calls, 1);
});

test("invalid calibration output never advances checkpoints or saves an artifact", async () => {
	const root = fixture(); await decision(root, 1);
	const invalid = [
		() => null, () => ({ suggestions: [null] }),
		(request: WorkerRequest) => response(request, { target: "AGENTS.md" }),
		(request: WorkerRequest) => response(request, { target: ".pi/idle-learn/config.toml" }),
		(request: WorkerRequest) => response(request, { kind: "instruction" }),
		(request: WorkerRequest) => response(request, { baseHash: "a".repeat(64) }),
		(request: WorkerRequest) => response(request, { evidence: [{ session: "decision", entry: "invented", quote: "Check feature" }] }),
		(request: WorkerRequest) => response(request, { evidence: [{ session: "decision", entry: JSON.parse(request.evidence).decisions[0].id, quote: "Invented quotation" }] }),
		(request: WorkerRequest) => ({ suggestions: [...response(request).suggestions, ...response(request).suggestions] }),
	];
	for (const value of invalid) {
		await assert.rejects(calibrate(input(root), async (request) => value(request)));
		assert.deepEqual(listSuggestions(root), []);
		assert.equal(readProjectFile(root, STATE_PATH), null);
	}
});

test("normal suggestions cannot smuggle calibration kind or preference targets", async () => {
	const root = fixture(); await decision(root, 1);
	await calibrate(input(root), async (request) => {
		const proposal = response(request).suggestions[0];
		await assert.rejects(saveProposals(root, [proposal]), /kind/);
		const { kind: _kind, ...plain } = proposal;
		await assert.rejects(saveProposals(root, [plain]), /AGENTS/);
		return { suggestions: [] };
	});
});

test("cancelled and failed calibrations retain rejections for retry", async () => {
	const root = fixture(); await decision(root, 1);
	const controller = new AbortController();
	await assert.rejects(calibrate(input(root, controller.signal), async () => { controller.abort(); return { suggestions: [] }; }));
	await assert.rejects(calibrate(input(root), async () => { throw new Error("Provider offline"); }), /offline/);
	assert.equal(readProjectFile(root, STATE_PATH), null);
	await calibrate(input(root), async () => ({ suggestions: [] }));
	assert.equal(readProgress(root).calibration!.rejections.length, 1);
});

test("configuration, source decision, and preference changes discard in-flight calibration", async () => {
	for (const changed of ["config", "decision", "preferences"]) {
		const root = fixture(); const item = await decision(root, 1);
		await assert.rejects(calibrate(input(root), async (request) => {
			if (changed === "config") configure(root, { thinking: "high" });
			if (changed === "decision") writeFileSync(join(root, `.pi/idle-learn/rejected/${item.id}.md`), serializeSuggestion({ ...item, reason: "Changed reason" }));
			if (changed === "preferences") atomicProjectWrite(root, PREFERENCES_PATH, "User-edited preferences.\n", null);
			return response(request);
		}), /changed|stale/);
		assert.equal(readProjectFile(root, STATE_PATH), null);
		assert.deepEqual(listSuggestions(root), []);
	}
});

test("stale and symlink preference targets cannot be applied", async () => {
	for (const mode of ["stale", "symlink", "hardlink"]) {
		const root = fixture(); await decision(root, 1);
		const result = await calibrate(input(root), async (request) => response(request));
		if (mode === "stale") atomicProjectWrite(root, PREFERENCES_PATH, "New user preferences.\n", null);
		else { const outside = fixture(false); writeFileSync(join(outside, "preferences.md"), "Outside"); if (mode === "hardlink") linkSync(join(outside, "preferences.md"), join(root, PREFERENCES_PATH)); else symlinkSync(join(outside, "preferences.md"), join(root, PREFERENCES_PATH)); }
		await assert.rejects(decideSuggestion(root, result.suggestions[0], "apply"), /stale|symlink|unlinked/);
	}
});

test("calibration shares the project review lock with ordinary analysis", async () => {
	const root = fixture(); await decision(root, 1);
	const lock = await acquireProjectLock(root, "review");
	try { await assert.rejects(calibrate(input(root), async () => { throw new Error("Must not call"); }), /lock/i); }
	finally { await lock.release(); }
});

test("decision context is bounded and omitted rejections remain unprocessed", async () => {
	const root = fixture();
	for (let index = 0; index < 20; index++) await decision(root, index, "reject", `Check feature ${index}. ${"x".repeat(30_000)}`);
	let included: string[] = [];
	await calibrate(input(root), async (request) => {
		assert.ok(Buffer.byteLength(request.evidence) < 140 * 1024);
		const data = JSON.parse(request.evidence);
		assert.match(request.evidence, /Remaining decision text omitted/);
		included = data.newRejectionIds;
		assert.ok(included.length > 0 && included.length < 20);
		return { suggestions: [] };
	});
	assert.deepEqual(readProgress(root).calibration!.rejections, included);
	assert.equal(calibrationDue(root), true);
});

test("invalid checkpoints fail closed rather than resetting rejection progress", async () => {
	const root = fixture(); await decision(root, 1);
	for (const calibration of [null, [], {}, { rejections: "all" }, { rejections: ["not-an-id"] }, { rejections: ["-".repeat(36)] }]) {
		const before = readProjectFile(root, STATE_PATH);
		atomicProjectWrite(root, STATE_PATH, JSON.stringify({ version: 1, reviewed: {}, audits: {}, calibration }), before);
		assert.throws(() => readProgress(root), /checkpoint/);
		await assert.rejects(calibrate(input(root), async () => { throw new Error("Must not call"); }), /checkpoint/);
	}
});

test("oversized approved preferences and calibration target edits are rejected", async () => {
	const root = fixture(); await decision(root, 1);
	const old = `trigger\n${"a".repeat(32 * 1024 - 20)}`;
	atomicProjectWrite(root, PREFERENCES_PATH, old, null);
	await assert.rejects(calibrate(input(root), async (request) => response(request, { before: "trigger", after: "b".repeat(200) })), /size limit/);
	atomicProjectWrite(root, PREFERENCES_PATH, "a".repeat(32 * 1024 + 1), old);
	assert.throws(() => effectivePrompt(root, requireOptIn(root)), /exceeds/);
});

test("preference snapshots use the current file hash and apply an exact existing edit", async () => {
	const root = fixture(); await decision(root, 1);
	const old = "Prefer project conventions.\n";
	atomicProjectWrite(root, PREFERENCES_PATH, old, null);
	const result = await calibrate(input(root), async (request) => {
		assert.equal(JSON.parse(request.evidence).preferences.baseHash, contentHash(old));
		return response(request);
	});
	await decideSuggestion(root, result.suggestions[0], "apply");
	assert.match(readPreferences(root)!, /lasting workflow/);
});
