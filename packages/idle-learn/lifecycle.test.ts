import assert from "node:assert/strict";
import { test } from "node:test";
import { IdleReviewer } from "./lifecycle.ts";
import type { ReviewInput, ReviewResult } from "./reviewer.ts";

const snapshot = { root: "/project", session: "test", entries: [{ id: "old", text: "[user]\nUse docs/." }], provider: "test", model: "test", thinking: "off" };
const result: ReviewResult = { suggestions: [], reviewed: 1, remaining: 0, message: "done" };
function controlledReviewer() {
	let input: ReviewInput | undefined;
	let finish!: (value: ReviewResult) => void;
	const reviewer = new IdleReviewer(() => {}, (value) => {
		input = value;
		return new Promise<ReviewResult>((resolve, reject) => {
			finish = resolve;
			value.signal.throwIfAborted();
			value.signal.addEventListener("abort", () => reject(value.signal.reason), { once: true });
		});
	});
	return { reviewer, get input() { return input!; }, finish: () => finish(result) };
}

test("manual snapshots continue during resumed work and still support explicit cancellation", async () => {
	const run = controlledReviewer();
	const pending = run.reviewer.start(snapshot, "manual");
	await Promise.resolve();
	await run.reviewer.resumeWork();
	assert.equal(run.reviewer.running, true);
	assert.equal(run.input.signal.aborted, false);
	assert.deepEqual(run.input.entries, snapshot.entries);
	await assert.rejects(run.reviewer.start(snapshot, "manual"), /already running/);
	const cancelled = assert.rejects(pending, /abort/i);
	await run.reviewer.cancel();
	await cancelled;
	assert.equal(run.reviewer.running, false);
	assert.match(run.reviewer.status, /Cancelled/);
});

test("resumed work cancels automatic reviews", async () => {
	const run = controlledReviewer();
	const pending = run.reviewer.start(snapshot);
	const cancelled = assert.rejects(pending, /abort/i);
	await Promise.resolve();
	await run.reviewer.resumeWork();
	await cancelled;
	assert.equal(run.input.signal.aborted, true);
	assert.equal(run.reviewer.running, false);
});

test("agent settling cannot schedule competing reviews while a manual snapshot is active", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const run = controlledReviewer();
	const pending = run.reviewer.start(snapshot, "manual");
	await Promise.resolve();
	let snapshots = 0;
	run.reviewer.schedule(1000, () => { snapshots++; return snapshot; });
	t.mock.timers.tick(1000);
	assert.equal(snapshots, 0);
	run.finish();
	await pending;
	run.reviewer.schedule(1000, () => { snapshots++; return undefined; });
	await run.reviewer.resumeWork();
	t.mock.timers.tick(1000);
	assert.equal(snapshots, 0);
});

test("status observers see running true at manual start and false at completion", async () => {
	const states: boolean[] = [];
	const reviewer = new IdleReviewer(() => states.push(reviewer.running), async () => result);
	const reviewed = await reviewer.start(snapshot, "manual");
	assert.match(reviewed.message, /Captured snapshot reviewed/);
	assert.equal(states[0], true);
	assert.equal(states.at(-1), false);
});
