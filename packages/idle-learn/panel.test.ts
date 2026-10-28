import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ReviewPanel, safeText, type ReviewAction } from "./panel.ts";
import type { Suggestion } from "./store.ts";

const suggestion: Suggestion = {
	id: "11111111-1111-4111-8111-111111111111", created: "2026-10-28T12:00:00.000Z", status: "pending",
	title: "Use the project test command instead of a guessed command", target: "src/AGENTS.md", rationale: "Future work needs the right command.",
	evidence: [{ session: "session-1", entry: "entry-1", quote: "Use npm test.\n".repeat(30) }],
	baseHash: null, resultHash: "a".repeat(64), before: "", after: "Run npm test.\n",
};
const theme = { fg: (_color: string, text: string) => text };

test("review renders within bounds at 80x24, 120x40, and 200x60", () => {
	for (const [width, height] of [[80, 24], [120, 40], [200, 60]]) {
		const panel = new ReviewPanel([suggestion], "Ready", theme, () => height, () => {});
		panel.render(width); panel.handleInput("\r");
		const lines = panel.render(width);
		assert.ok(lines.length <= height);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(lines.join("\n"), /p apply/);
		assert.match(lines.join("\n"), /r reject/);
		assert.match(lines.join("\n"), /Esc/);
		assert.match(lines.join("\n"), /scroll/);
	}
});

test("narrow review requires opening details before apply and Escape unwinds safely", () => {
	const actions: ReviewAction[] = [];
	const panel = new ReviewPanel([suggestion], "Ready", theme, () => 24, (action) => actions.push(action));
	panel.render(80);
	panel.handleInput("p"); assert.equal(actions.length, 0);
	panel.handleInput("\r"); panel.render(80);
	panel.handleInput("p"); assert.equal(actions[0].kind, "apply");
	panel.handleInput("\x1b"); assert.equal(actions.length, 1);
	panel.handleInput("\x1b"); assert.equal(actions[1].kind, "close");
});

test("populated review screens never offer or trigger session analysis", () => {
	for (const kind of ["instruction", "calibration"] as const) {
		for (const width of [80, 120]) {
			const actions: ReviewAction[] = [];
			const panel = new ReviewPanel([{ ...suggestion, kind }], "Ready", theme, () => 30, (action) => actions.push(action));
			for (const details of [false, true]) {
				if (details) panel.handleInput("\r");
				assert.doesNotMatch(panel.render(width).join("\n"), /a analyze/);
				panel.handleInput("a");
				assert.deepEqual(actions, []);
			}
		}
	}
});

test("details scroll and adapt on resize without hiding actions", () => {
	let height = 40;
	const panel = new ReviewPanel([suggestion], "Ready", theme, () => height, () => {});
	panel.render(120); panel.handleInput("\t");
	for (let i = 0; i < 20; i++) panel.handleInput("j");
	const scrolled = panel.render(120).join("\n");
	assert.ok(Number(/scroll (\d+)\//.exec(scrolled)?.[1]) > 1);
	height = 24;
	const resized = panel.render(80);
	assert.ok(resized.length <= 24);
	assert.ok(resized.every((line) => visibleWidth(line) <= 80));
	assert.match(resized.join("\n"), /p apply/);
	assert.doesNotMatch(resized.join("\n"), /Tab focus/);
});

test("empty review is compact, unsplit, and shows only usable actions", () => {
	const panel = new ReviewPanel([], "Rejected. The next reviewer will see this decision.", theme, () => 60, () => {});
	const lines = panel.render(200);
	assert.ok(lines.length <= 12);
	assert.ok(lines.every((line) => visibleWidth(line) === 84));
	assert.match(lines[0], /^╭ Idle Learn/);
	assert.match(lines.at(-1)!, /^╰─+╯$/);
	assert.match(lines.join("\n"), /a analyze now/);
	assert.doesNotMatch(lines.join("\n"), /p apply|r reject|Tab focus|Focus:|\|/);
});

test("wide review uses aligned library borders and previews the edit before long evidence", () => {
	const panel = new ReviewPanel([suggestion], "Ready", theme, () => 40, () => {});
	const lines = panel.render(200).map(stripVTControlCharacters);
	const top = lines.find((line) => line.startsWith("╭"))!;
	assert.equal((top.match(/╭/g) ?? []).length, 2);
	assert.ok(lines.every((line) => visibleWidth(line) <= 132));
	const content = lines.join("\n");
	assert.ok(content.indexOf("Proposed edit") < content.indexOf("Evidence"));
	assert.match(content, /Run npm test/);
	assert.doesNotMatch(content, /^[-|]{5,}/m);
});

test("wide monochrome view strips layout control sequences and retains focus labels", () => {
	const previous = process.env.NO_COLOR;
	process.env.NO_COLOR = "1";
	try {
		const panel = new ReviewPanel([suggestion], "Ready", theme, () => 24, () => {});
		assert.doesNotMatch(panel.render(120).join("\n"), /\x1b/);
		panel.handleInput("\t");
		assert.match(panel.render(120).join("\n"), /› Proposed change/);
		panel.handleInput("\x1b[Z");
		assert.match(panel.render(120).join("\n"), /› Suggestions/);
	} finally { if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous; }
});

test("calibration shares the review layout but labels both list and detail", () => {
	const item = { ...suggestion, kind: "calibration" as const, target: ".pi/idle-learn/reviewer-preferences.md" };
	const panel = new ReviewPanel([item], "Ready", theme, () => 30, () => {});
	const wide = stripVTControlCharacters(panel.render(120).join("\n"));
	assert.match(wide, /\[Calibration\]/);
	assert.match(wide, /Calibration \/ Reviewer preferences/);
	assert.match(wide, /reviewer-preferences\.md/);
	panel.render(80); panel.handleInput("\r");
	assert.match(panel.render(80).join("\n"), /Calibration \/ Reviewer preferences/);
});

test("empty, error, small-terminal, and monochrome states stay usable", () => {
	let action: ReviewAction | undefined;
	const panel = new ReviewPanel([], "Error: choose a model in configuration, then Analyze now.", theme, () => 24, (value) => { action = value; });
	assert.match(panel.render(80).join("\n"), /No pending suggestions/);
	panel.handleInput("a"); assert.equal(action?.kind, "analyze");
	assert.match(panel.render(20).join("\n"), /Resize/);
	assert.equal(safeText("Hello\x1b[31m\x07\nworld"), "Hello[31m\nworld");
	const previous = process.env.NO_COLOR; process.env.NO_COLOR = "1";
	try { assert.doesNotMatch(panel.render(80).join("\n"), /\x1b/); }
	finally { if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous; }
});
