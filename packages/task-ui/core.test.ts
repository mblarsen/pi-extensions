import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	MAX_FEEDBACK_INBOX_ENTRIES,
	MAX_INFO_INBOX_ENTRIES,
	MAX_INBOX_MARKDOWN_CHARS,
	MAX_TASK_OUTPUT_CHARS,
	MAX_TASK_OUTPUT_ENTRIES,
	addInboxEntry,
	appendTaskOutput,
	clearInfoInboxEntries,
	cloneTaskUiState,
	createInitialTaskUiState,
	createTask,
	createTasks,
	getInboxCounts,
	getTaskDashboard,
	getTaskDisplayNumber,
	listInboxEntries,
	normalizeStoredTaskUiState,
	normalizeTaskStatus,
	removeTask,
	resolveInboxEntry,
	replaceExternalTasks,
	updateTask,
} from "./core.ts";

const NOW = "2026-07-22T10:00:00.000Z";
const LATER = "2026-07-22T10:01:00.000Z";

describe("task-ui projection", () => {
	test("initializes and restores an empty Inbox", () => {
		const initial = createInitialTaskUiState();
		assert.deepEqual(initial.inbox, []);
		assert.equal(initial.nextInboxId, 1);

		const restored = normalizeStoredTaskUiState({
			version: 5,
			tasks: [],
			nextId: 4,
			nextNumber: 7,
		});
		assert.deepEqual(restored?.inbox, []);
		assert.equal(restored?.nextInboxId, 1);
	});

	test("adds Inbox entries and orders feedback before info newest-first", () => {
		let state = addInboxEntry(createInitialTaskUiState(), {
			kind: "info",
			markdown: "First update",
		}, NOW).state;
		state = addInboxEntry(state, {
			kind: "feedback_needed",
			markdown: "**Choose** a scope.",
		}, LATER).state;
		state = addInboxEntry(state, {
			kind: "info",
			markdown: "Latest update",
		}, "2026-07-22T10:02:00.000Z").state;

		assert.deepEqual(listInboxEntries(state).map((entry) => entry.id), ["inbox-2", "inbox-3", "inbox-1"]);
		assert.deepEqual(listInboxEntries(state, { kind: "info" }).map((entry) => entry.markdown), ["Latest update", "First update"]);
		assert.equal(state.nextInboxId, 4);
	});

	test("retains only the newest informational Inbox entries", () => {
		let state = createInitialTaskUiState();
		let evictedInfoIds: string[] = [];
		for (let index = 0; index <= MAX_INFO_INBOX_ENTRIES; index++) {
			const result = addInboxEntry(state, { kind: "info", markdown: `Update ${index}` }, `2026-07-22T10:${String(index).padStart(2, "0")}:00.000Z`);
			state = result.state;
			evictedInfoIds = result.evictedInfoIds;
		}

		assert.deepEqual(evictedInfoIds, ["inbox-1"]);
		assert.equal(state.inbox.length, MAX_INFO_INBOX_ENTRIES);
		assert.equal(state.inbox.some((entry) => entry.id === "inbox-1"), false);
		assert.equal(state.nextInboxId, MAX_INFO_INBOX_ENTRIES + 2);
	});

	test("rejects feedback above the unresolved limit without mutation", () => {
		let state = createInitialTaskUiState();
		for (let index = 0; index < MAX_FEEDBACK_INBOX_ENTRIES; index++) {
			state = addInboxEntry(state, { kind: "feedback_needed", markdown: `Question ${index}` }, NOW).state;
		}
		const before = structuredClone(state);

		assert.throws(
			() => addInboxEntry(state, { kind: "feedback_needed", markdown: "One too many" }, LATER),
			/list entries.*resolve obsolete or duplicate entries.*preserve every entry.*prioritize.*retry/is,
		);
		assert.deepEqual(state, before);
	});

	test("resolves feedback entries but rejects informational entries", () => {
		let state = addInboxEntry(createInitialTaskUiState(), { kind: "info", markdown: "FYI" }, NOW).state;
		state = addInboxEntry(state, { kind: "feedback_needed", markdown: "Choose one" }, LATER).state;

		const result = resolveInboxEntry(state, "inbox-2");
		assert.equal(result.resolvedEntry.markdown, "Choose one");
		assert.deepEqual(result.state.inbox.map((entry) => entry.id), ["inbox-1"]);
		assert.throws(() => resolveInboxEntry(result.state, "inbox-1"), /Only feedback-needed Inbox entries can be resolved/);
		assert.throws(() => resolveInboxEntry(result.state, "missing"), /Inbox entry not found: missing/);
	});

	test("clears informational entries while preserving feedback and counts", () => {
		let state = addInboxEntry(createInitialTaskUiState(), { kind: "info", markdown: "FYI" }, NOW).state;
		state = addInboxEntry(state, { kind: "feedback_needed", markdown: "Choose one" }, LATER).state;

		assert.deepEqual(getInboxCounts(state), { info: 1, feedbackNeeded: 1, total: 2 });
		const result = clearInfoInboxEntries(state);
		assert.equal(result.removedCount, 1);
		assert.deepEqual(result.state.inbox.map((entry) => entry.id), ["inbox-2"]);
		assert.deepEqual(getInboxCounts(result.state), { info: 0, feedbackNeeded: 1, total: 1 });
	});

	test("validates Inbox summaries and optional task links", () => {
		const state = createTask(createInitialTaskUiState(), { id: "linked", subject: "Linked" }, NOW).state;
		assert.throws(() => addInboxEntry(state, { kind: "info", markdown: "   " }, LATER), /Inbox summary is required/);
		assert.throws(
			() => addInboxEntry(state, { kind: "info", markdown: "x".repeat(MAX_INBOX_MARKDOWN_CHARS + 1) }, LATER),
			/400 source characters/,
		);
		assert.throws(() => addInboxEntry(state, { kind: "info", markdown: "Missing", taskId: "missing" }, LATER), /Task not found: missing/);

		const added = addInboxEntry(state, { kind: "info", markdown: "  Linked summary  ", taskId: "linked" }, LATER);
		assert.equal(added.entry.markdown, "Linked summary");
		assert.equal(added.entry.taskId, "linked");
		assert.deepEqual(removeTask(added.state, "linked").inbox, [added.entry]);
	});

	test("restores and clones persisted Inbox entries without reusing IDs", () => {
		const stored = {
			...createInitialTaskUiState(),
			inbox: [{ id: "inbox-4", kind: "feedback_needed" as const, markdown: "Choose", createdAt: NOW }],
			nextInboxId: 5,
		};
		const restored = normalizeStoredTaskUiState(stored)!;
		const cloned = cloneTaskUiState(restored);
		cloned.inbox[0].markdown = "Changed";

		assert.equal(restored.inbox[0].markdown, "Choose");
		assert.equal(restored.nextInboxId, 5);
		assert.equal(addInboxEntry(restored, { kind: "info", markdown: "Next" }, LATER).entry.id, "inbox-5");
	});

	test("creates backend-addressable tasks without starting work", () => {
		const result = createTask(createInitialTaskUiState(), {
			id: "backend-42",
			subject: "Run backend task",
			label: "research",
			status: "in_progress",
		}, NOW);

		assert.equal(result.task.id, "backend-42");
		assert.equal(result.state.focusedTaskId, "backend-42");
		assert.equal(result.task.status, "in_progress");
		assert.equal(result.task.label, "research");
		assert.deepEqual(result.task.output, []);
	});

	test("updates presentation state and advances focus after completion", () => {
		let state = createTask(createInitialTaskUiState(), { id: "one", subject: "First", status: "in_progress" }, NOW).state;
		state = createTask(state, { id: "two", subject: "Second" }, NOW).state;
		state = updateTask(state, { taskId: "one", label: "grilling", status: "completed", progress: 100 }, LATER).state;

		assert.equal(state.tasks[0].status, "completed");
		assert.equal(state.tasks[0].label, "grilling");
		assert.equal(state.tasks[0].progress, 100);
		assert.equal(state.focusedTaskId, "two");
	});

	test("supports multiple active tasks and returns the first unblocked pending task", () => {
		const result = createTasks(createInitialTaskUiState(), [
			{ id: "one", subject: "First", status: "in_progress" },
			{ id: "two", subject: "Second", status: "in_progress", executing: true, activeForm: "Running second" },
			{ id: "three", subject: "Blocked", blockedBy: ["missing"] },
			{ id: "four", subject: "Ready" },
		], NOW);
		const dashboard = getTaskDashboard(result.state);

		assert.deepEqual(result.tasks.map((task) => task.number), [1, 2, 3, 4]);
		assert.deepEqual(dashboard.active.map((task) => task.id), ["one", "two"]);
		assert.equal(dashboard.next?.id, "four");
		assert.equal(dashboard.focused?.id, "two");
		assert.equal(result.tasks[1].startedAt, NOW);
	});

	test("supports independently executable parents and nested subtasks", () => {
		const result = createTasks(createInitialTaskUiState(), [
			{ id: "child", subject: "Child", parentId: "parent", executing: true },
			{ id: "parent", subject: "Parent", executing: true },
			{ id: "grandchild", subject: "Grandchild", parentId: "child" },
		], NOW);
		const byId = new Map(result.state.tasks.map((task) => [task.id, task]));

		assert.deepEqual(result.tasks.map((task) => task.id), ["child", "parent", "grandchild"]);
		assert.deepEqual(getTaskDashboard(result.state).active.map((task) => task.id), ["parent", "child"]);
		assert.equal(byId.get("child")?.subtaskNumber, 1);
		assert.equal(getTaskDisplayNumber(byId.get("child")!, result.state.tasks), "1.1");
		assert.equal(getTaskDisplayNumber(byId.get("grandchild")!, result.state.tasks), "1.1.1");
	});

	test("rejects parent cycles and detaches children when a parent is removed", () => {
		let state = createTasks(createInitialTaskUiState(), [
			{ id: "parent", subject: "Parent" },
			{ id: "child", subject: "Child", parentId: "parent" },
		], NOW).state;

		assert.throws(() => updateTask(state, { taskId: "parent", parentId: "child" }, LATER), /cycle/);
		state = removeTask(state, "parent");
		assert.equal(state.tasks[0].id, "child");
		assert.equal(state.tasks[0].parentId, undefined);
		assert.equal(state.tasks[0].subtaskNumber, undefined);
		assert.equal(getTaskDisplayNumber(state.tasks[0], state.tasks), "2");
	});

	test("keeps batch creation atomic when a parent is missing", () => {
		const state = createInitialTaskUiState();
		assert.throws(() => createTasks(state, [
			{ id: "child", subject: "Child", parentId: "missing" },
		], NOW), /Parent task not found/);
		assert.deepEqual(state.tasks, []);
	});

	test("clears execution state and records when a task becomes terminal", () => {
		let state = createTask(createInitialTaskUiState(), {
			id: "worker",
			subject: "Worker",
			executing: true,
			inputTokens: 4_100,
			outputTokens: 1_200,
		}, NOW).state;
		state = updateTask(state, { taskId: "worker", status: "failed" }, LATER).state;

		assert.equal(state.tasks[0].status, "failed");
		assert.equal(state.tasks[0].executing, false);
		assert.equal(state.tasks[0].inputTokens, 4_100);
		assert.equal(state.tasks[0].terminalAt, LATER);

		state = updateTask(state, { taskId: "worker", subject: "Edited after failure" }, "2026-07-22T10:02:00.000Z").state;
		assert.equal(state.tasks[0].terminalAt, LATER);
		assert.equal(normalizeStoredTaskUiState(state)?.tasks[0].terminalAt, LATER);

		state = updateTask(state, { taskId: "worker", status: "pending" }, "2026-07-22T10:03:00.000Z").state;
		assert.equal(state.tasks[0].terminalAt, undefined);
	});

	test("batch creation is atomic when one task is invalid", () => {
		const state = createTask(createInitialTaskUiState(), { id: "existing", subject: "Existing" }, NOW).state;
		assert.throws(() => createTasks(state, [
			{ id: "new", subject: "New" },
			{ id: "existing", subject: "Duplicate" },
		], LATER), /already exists/);
		assert.deepEqual(state.tasks.map((task) => task.id), ["existing"]);
	});

	test("stores output only in the UI projection", () => {
		let state = createTask(createInitialTaskUiState(), { subject: "Display logs" }, NOW).state;
		state = appendTaskOutput(state, "task-1", "backend says hello", LATER).state;

		assert.deepEqual(state.tasks[0].output, [{ text: "backend says hello", timestamp: LATER }]);
	});

	test("bounds cached output for session and tool-result safety", () => {
		let state = createTask(createInitialTaskUiState(), { subject: "Bound logs" }, NOW).state;
		for (let index = 0; index <= MAX_TASK_OUTPUT_ENTRIES; index++) {
			state = appendTaskOutput(state, "task-1", `${index}:${"x".repeat(MAX_TASK_OUTPUT_CHARS + 10)}`, LATER).state;
		}

		assert.equal(state.tasks[0].output.length, MAX_TASK_OUTPUT_ENTRIES);
		assert.equal(state.tasks[0].output[0].text.startsWith("1:"), true);
		assert.equal(state.tasks[0].output.at(-1)?.text.length, MAX_TASK_OUTPUT_CHARS);
	});

	test("normalizes common backend statuses", () => {
		assert.equal(normalizeTaskStatus("running"), "in_progress");
		assert.equal(normalizeTaskStatus("done"), "completed");
		assert.equal(normalizeTaskStatus("cancelled"), "stopped");
		assert.equal(normalizeTaskStatus("error"), "failed");
		assert.equal(normalizeTaskStatus("queued"), "pending");
	});

	test("accepts nested backend-neutral snapshots and preserves output when restored", () => {
		const state = replaceExternalTasks([
			{ id: "ctx-child", title: "Nested review", parentId: "ctx-7" },
			{
				id: "ctx-7",
				title: "Delegated review",
				label: "review",
				status: "running",
				output: [{ text: "started", timestamp: NOW }],
			},
		], "ctx-7", LATER);
		const restored = normalizeStoredTaskUiState(state);
		const parent = restored?.tasks.find((task) => task.id === "ctx-7");
		const child = restored?.tasks.find((task) => task.id === "ctx-child");

		assert.equal(parent?.subject, "Delegated review");
		assert.equal(parent?.status, "in_progress");
		assert.equal(parent?.label, "review");
		assert.deepEqual(parent?.output, [{ text: "started", timestamp: NOW }]);
		assert.equal(child?.parentId, "ctx-7");
		assert.equal(getTaskDisplayNumber(child!, restored!.tasks), "1.1");
		assert.equal(restored?.focusedTaskId, "ctx-7");
	});

	test("rejects duplicate backend IDs", () => {
		const state = createTask(createInitialTaskUiState(), { id: "same", subject: "First" }, NOW).state;
		assert.throws(() => createTask(state, { id: "same", subject: "Second" }, LATER), /already exists/);
	});
});
