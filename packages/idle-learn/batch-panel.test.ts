import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BatchPanel, type BatchAction, type BatchView } from "./batch-panel.ts";
import type { Batch } from "./batch.ts";
import type { Suggestion } from "./store.ts";

const theme = { fg: (_color: string, text: string) => text };
const item = (number: number): Suggestion => ({ id: `${number}1111111-1111-4111-8111-111111111111`, created: "2026-10-29T00:00:00.000Z", status: "pending", title: `Lesson ${number}`, target: "AGENTS.md",
	rationale: "Because.", evidence: [{ session: "s", entry: "e", quote: "Quote" }], baseHash: null, resultHash: "a".repeat(64), before: "", after: `Lesson ${number}.\n` });
function view(overrides: Partial<Batch> = {}, state: BatchView["state"] = { kind: "fresh" }): BatchView {
	const batch: Batch = { version: 1, id: "11111111-1111-4111-8111-111111111111", created: "2026-10-29T00:00:00.000Z", updated: "2026-10-29T00:00:00.000Z", status: "open",
		sources: [1, 2].map((number) => ({ number, id: item(number).id, snapshot: "b".repeat(64) })), comments: [{ created: "2026-10-29T00:00:00.000Z", text: "Merge #1 and #2." }],
		draft: { created: "2026-10-29T00:00:00.000Z", hash: "c".repeat(64), sources: "d".repeat(64), comments: 1, summary: "Combined lessons and moved detail to testing.md.",
			notes: [{ number: 1, note: "Added." }, { number: 2, note: "Already covered." }],
			files: [{ path: "AGENTS.md", baseHash: "e".repeat(64), content: "# P\nSee [t](testing.md).\n" }, { path: "testing.md", baseHash: null, content: "Lessons.\n" }] }, ...overrides };
	return { batch, sources: batch.sources.map((source) => ({ ...source, suggestion: item(source.number) })), state, current: new Map([["AGENTS.md", "# P\n"], ["testing.md", null]]), status: "Ready" };
}

test("batch view renders numbered sources, comments, notes, and per-file diffs within bounds", () => {
	for (const [width, height] of [[80, 24], [120, 40], [200, 60]]) {
		const panel = new BatchPanel(view(), theme, () => height, () => {});
		const lines = panel.render(width);
		assert.ok(lines.length <= height);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(lines.join("\n"), /p apply/);
	}
	const panel = new BatchPanel(view(), theme, () => 200, () => {});
	const screen = panel.render(120).join("\n");
	for (const pattern of [/Combined lessons/, /#2 Already covered/, /\+See \[t\]\(testing\.md\)/, /testing\.md  \(new file\)/, /\+Lessons\./, /Merge #1 and #2/, /#1 Lesson 1/, /Original proposal/]) assert.match(screen, pattern);
	assert.doesNotMatch(screen, /\x1b/);
});

test("stale drafts disable Apply; actions and number-based removal map to batch actions", () => {
	const actions: BatchAction[] = [];
	const panel = new BatchPanel(view({}, { kind: "stale", reason: "AGENTS.md changed since this draft." }), theme, () => 40, (action) => actions.push(action));
	const screen = panel.render(100).join("\n");
	assert.match(screen, /changed since this draft/);
	assert.doesNotMatch(screen, /p apply/);
	for (const key of ["p", "c", "g", "d", "x", "2", "x", "z", "q"]) panel.handleInput(key);
	assert.deepEqual(actions, [{ kind: "comment" }, { kind: "integrate" }, { kind: "discard" }, { kind: "remove", number: 2 }, { kind: "back" }]);
});

test("a partially applied batch only offers resume and back", () => {
	const actions: BatchAction[] = [];
	const base = view();
	const panel = new BatchPanel(view({ status: "applying", apply: { draft: base.batch.draft!.hash, files: [] } }), theme, () => 30, (action) => actions.push(action));
	assert.match(panel.render(100).join("\n"), /u resume Apply/);
	for (const key of ["p", "g", "c", "d", "u", "\x1b"]) panel.handleInput(key);
	assert.deepEqual(actions, [{ kind: "resume" }, { kind: "back" }]);
	assert.match(new BatchPanel(view(), theme, () => 30, () => {}).render(30).join("\n"), /Resize/);
});
