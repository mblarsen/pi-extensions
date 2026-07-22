import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createInitialTaskUiState, createTasks, updateTask } from "./core.ts";
import taskUiExtension, { blockerText, orderTasksForDisplay, TASK_UI_EVENTS } from "./index.ts";

type RegisteredTool = {
	name: string;
	execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

function extensionHarness(): { pi: ExtensionAPI; tools: RegisteredTool[] } {
	const tools: RegisteredTool[] = [];
	const pi = {
		registerTool(tool: RegisteredTool) { tools.push(tool); },
		registerCommand() {},
		on() {},
		events: { on() {} },
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

test("registers only presentation tools, adapter events, and lifecycle UI hooks", () => {
	const tools: Array<{ name: string; description: string }> = [];
	const commands: string[] = [];
	const lifecycleEvents: string[] = [];
	const adapterEvents: string[] = [];
	const pi = {
		registerTool(tool: { name: string; description: string }) {
			tools.push(tool);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		on(name: string) {
			lifecycleEvents.push(name);
		},
		events: {
			on(name: string) {
				adapterEvents.push(name);
			},
		},
	} as unknown as ExtensionAPI;

	taskUiExtension(pi);

	assert.deepEqual(tools.map((tool) => tool.name), [
		"task_ui_create",
		"task_ui_batch_create",
		"task_ui_list",
		"task_ui_get",
		"task_ui_update",
		"task_ui_output",
		"task_ui_stop",
	]);
	assert.ok(tools.every((tool) => /projection|UI/i.test(tool.description)));
	assert.deepEqual(commands, ["task-ui"]);
	assert.deepEqual(lifecycleEvents, ["session_start", "session_tree", "session_shutdown"]);
	assert.deepEqual(adapterEvents, Object.values(TASK_UI_EVENTS));
	assert.equal(lifecycleEvents.includes("before_agent_start"), false);
	assert.equal(lifecycleEvents.includes("tool_call"), false);
	assert.equal(lifecycleEvents.includes("agent_start"), false);
});

test("renders descendants immediately after their parent", () => {
	const state = createTasks(createInitialTaskUiState(), [
		{ id: "parent", subject: "Parent" },
		{ id: "other", subject: "Other root" },
		{ id: "child-one", subject: "First child", parentId: "parent" },
		{ id: "child-two", subject: "Second child", parentId: "parent" },
		{ id: "grandchild", subject: "Grandchild", parentId: "child-one" },
	]).state;
	const byId = new Map(state.tasks.map((task) => [task.id, task]));
	const scrambled = ["parent", "other", "child-two", "grandchild", "child-one"].map((id) => byId.get(id)!);

	assert.deepEqual(orderTasksForDisplay(scrambled).map((task) => task.id), [
		"parent",
		"child-one",
		"grandchild",
		"child-two",
		"other",
	]);
});

test("hides completed dependencies from blocker metadata", () => {
	let state = createTasks(createInitialTaskUiState(), [
		{ id: "done", subject: "Done", status: "completed" },
		{ id: "active", subject: "Active", status: "in_progress" },
		{ id: "target", subject: "Target", blockedBy: ["done", "active"] },
	]).state;
	let target = state.tasks.find((task) => task.id === "target")!;
	assert.equal(blockerText(target, state.tasks), "› blocked by #2");

	state = updateTask(state, { taskId: "active", status: "completed" }).state;
	target = state.tasks.find((task) => task.id === "target")!;
	assert.equal(blockerText(target, state.tasks), undefined);
});

test("batch creation, dashboard reads, and stopping stay within the UI projection", async () => {
	const { pi, tools } = extensionHarness();
	taskUiExtension(pi);
	const tool = (name: string) => tools.find((item) => item.name === name)!;

	await tool("task_ui_batch_create").execute("batch", {
		tasks: [
			{ id: "one", subject: "One", status: "in_progress", executing: true },
			{ id: "two", subject: "Two", status: "in_progress" },
			{ id: "three", subject: "Three" },
		],
	});
	const dashboard = await tool("task_ui_get").execute("get", {});
	assert.match(dashboard.content[0].text, /Active \(2\)/);
	assert.match(dashboard.content[0].text, /Next: #3/);

	const stopped = await tool("task_ui_stop").execute("stop", { task_id: "one", reason: "User stopped display" });
	assert.match(stopped.content[0].text, /stopped UI history/);
	const stoppedTask = await tool("task_ui_get").execute("get-one", { task_id: "one" });
	assert.match(stoppedTask.content[0].text, /\[stopped\]/);
});
