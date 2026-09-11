import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { addInboxEntry, createInitialTaskUiState, createTasks } from "./core.ts";
import { renderTaskUiMarkdown, writeTaskUiMarkdown } from "./markdown.ts";

const NOW = "2026-09-10T10:00:00.000Z";

describe("task-ui Markdown renderer", () => {
	test("renders an empty projection", () => {
		assert.equal(renderTaskUiMarkdown(createInitialTaskUiState()), "_No projected tasks._");
	});

	test("renders an Inbox-only projection with complete Markdown summaries", () => {
		let state = addInboxEntry(createInitialTaskUiState(), {
			kind: "info",
			markdown: "Worker finished **three checks**.",
		}, NOW).state;
		state = addInboxEntry(state, {
			kind: "feedback_needed",
			markdown: "## Choose a scope\n\n- Smaller\n- Original",
		}, "2026-09-10T10:01:00.000Z").state;

		assert.equal(renderTaskUiMarkdown(state), `_No projected tasks._

# Inbox

## Feedback needed · \`inbox-2\`

**Created:** 2026-09-10T10:01:00.000Z

## Choose a scope

- Smaller
- Original

## Info · \`inbox-1\`

**Created:** 2026-09-10T10:00:00.000Z

Worker finished **three checks**.`);
	});

	test("writes to a unique file in the system temporary directory by default", async () => {
		const outputPath = await writeTaskUiMarkdown(createInitialTaskUiState());
		try {
			assert.equal(dirname(outputPath), tmpdir());
			assert.equal(await readFile(outputPath, "utf8"), "_No projected tasks._");
		} finally {
			await rm(outputPath, { force: true });
		}
	});

	test("requires confirmation before overwriting an existing file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "task-ui-markdown-"));
		const outputPath = join(directory, "tasks.md");
		await writeFile(outputPath, "keep this", "utf8");
		try {
			await assert.rejects(
				writeTaskUiMarkdown(createInitialTaskUiState(), { path: outputPath }),
				new RegExp(`Markdown file already exists: ${outputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. Ask the user to confirm overwriting it`),
			);
			assert.equal(await readFile(outputPath, "utf8"), "keep this");

			assert.equal(
				await writeTaskUiMarkdown(createInitialTaskUiState(), { path: outputPath, overwrite: true }),
				outputPath,
			);
			assert.equal(await readFile(outputPath, "utf8"), "_No projected tasks._");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("renders hierarchy, descriptions, statuses, and multiple dependencies", () => {
		const state = createTasks(createInitialTaskUiState(), [
			{ id: "format", subject: "Define export format", description: "Document the Markdown structure.", status: "completed" },
			{ id: "helpers", subject: "Add task hierarchy helpers", description: "Expose stable numbering and ordering.", status: "completed" },
			{
				id: "renderer",
				subject: "Implement Markdown renderer",
				description: "Generate the complete task document.",
				status: "in_progress",
				blockedBy: ["format", "helpers"],
			},
			{
				id: "tests",
				subject: "Add renderer tests",
				description: "Cover **nested tasks** and multiple dependencies.",
				parentId: "renderer",
				blockedBy: ["format", "renderer"],
			},
		], NOW).state;

		assert.equal(renderTaskUiMarkdown(state), `# 1. Define export format

Document the Markdown structure.

**Status:** completed

# 2. Add task hierarchy helpers

Expose stable numbering and ordering.

**Status:** completed

# 3. Implement Markdown renderer

Generate the complete task document.

**Status:** in progress · **Dependencies:** [1. Define export format](#1-define-export-format), [2. Add task hierarchy helpers](#2-add-task-hierarchy-helpers)

## 3.1. Add renderer tests

Cover **nested tasks** and multiple dependencies.

**Status:** pending · **Dependencies:** [1. Define export format](#1-define-export-format), [3. Implement Markdown renderer](#3-implement-markdown-renderer)`);
	});

	test("renders every status and omits absent descriptions", () => {
		const state = createTasks(createInitialTaskUiState(), [
			{ subject: "Pending", status: "pending" },
			{ subject: "Active", status: "in_progress" },
			{ subject: "Complete", status: "completed" },
			{ subject: "Failure", status: "failed" },
			{ subject: "Stopped", status: "stopped" },
		], NOW).state;
		const markdown = renderTaskUiMarkdown(state);

		assert.match(markdown, /# 1\. Pending\n\n\*\*Status:\*\* pending/);
		assert.match(markdown, /# 2\. Active\n\n\*\*Status:\*\* in progress/);
		assert.match(markdown, /# 3\. Complete\n\n\*\*Status:\*\* completed/);
		assert.match(markdown, /# 4\. Failure\n\n\*\*Status:\*\* failed/);
		assert.match(markdown, /# 5\. Stopped\n\n\*\*Status:\*\* stopped/);
	});

	test("caps heading depth and normalizes multiline subjects", () => {
		const inputs = Array.from({ length: 7 }, (_, index) => ({
			id: `depth-${index + 1}`,
			subject: index === 6 ? "Deep\n  task" : `Depth ${index + 1}`,
			parentId: index === 0 ? undefined : `depth-${index}`,
		}));
		const state = createTasks(createInitialTaskUiState(), inputs, NOW).state;
		const markdown = renderTaskUiMarkdown(state);

		assert.match(markdown, /^# 1\. Depth 1/m);
		assert.match(markdown, /^###### 1\.1\.1\.1\.1\.1\.1\. Deep task/m);
		assert.doesNotMatch(markdown, /^#######/m);
	});

	test("resolves duplicate heading anchors and renders missing dependencies as code", () => {
		const state = createTasks(createInitialTaskUiState(), [
			{ id: "parent", number: 1, subject: "Parent" },
			{ id: "child", subject: "X", parentId: "parent" },
			{ id: "root", number: 11, subject: "X" },
			{ id: "dependent", number: 12, subject: "Dependent", blockedBy: ["child", "root", "missing-task"] },
		], NOW).state;
		const snapshot = structuredClone(state);
		const markdown = renderTaskUiMarkdown(state);

		assert.match(markdown, /\[1\.1\. X\]\(#11-x\), \[11\. X\]\(#11-x-1\), `missing-task`/);
		assert.deepEqual(state, snapshot);
	});
});
