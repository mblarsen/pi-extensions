import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createInitialTaskUiState, createTasks, updateTask } from "./core.ts";
import taskUiExtension, {
	blockerText,
	checkpointForToolResult,
	orderTasksForDisplay,
	TaskBarComponent,
	TaskBrowserComponent,
	TASK_UI_EVENTS,
	taskLabelColor,
} from "./index.ts";

type RegisteredToolResult = {
	content: Array<{ type: string; text: string }>;
	details?: Record<string, unknown>;
};

type RegisteredTool = {
	name: string;
	parameters?: { properties?: Record<string, unknown> };
	execute: (id: string, params: Record<string, unknown>) => Promise<RegisteredToolResult>;
	renderResult?: (result: RegisteredToolResult, options: unknown, theme: unknown) => { render(width: number): string[] };
};

function extensionHarness(): { pi: ExtensionAPI; tools: RegisteredTool[] } {
	const tools: RegisteredTool[] = [];
	const pi = {
		registerTool(tool: RegisteredTool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on() {},
		events: { on() {} },
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

test("registers only presentation tools, adapter events, and lifecycle UI hooks", () => {
	const tools: Array<{ name: string; description: string }> = [];
	const commands: string[] = [];
	let getArgumentCompletions: ((prefix: string) => Array<{ value: string }> | null) | undefined;
	const shortcuts: string[] = [];
	const lifecycleEvents: string[] = [];
	const adapterEvents: string[] = [];
	const pi = {
		registerTool(tool: { name: string; description: string }) {
			tools.push(tool);
		},
		registerCommand(name: string, options: { getArgumentCompletions?: typeof getArgumentCompletions }) {
			commands.push(name);
			getArgumentCompletions = options.getArgumentCompletions;
		},
		registerShortcut(shortcut: string) {
			shortcuts.push(shortcut);
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
		"task_ui_to_md",
		"task_ui_get",
		"task_ui_update",
		"task_ui_output",
		"task_ui_remove",
		"task_ui_clear",
		"task_ui_stop",
	]);
	assert.ok(tools.every((tool) => /projection|UI/i.test(tool.description)));
	assert.deepEqual(commands, ["task-ui"]);
	assert.deepEqual(getArgumentCompletions?.("b")?.map((item) => item.value), ["browse"]);
	assert.deepEqual(getArgumentCompletions?.("")?.map((item) => item.value), ["browse", "sidebar", "hide", "cycle"]);
	assert.deepEqual(shortcuts, ["alt+u", "alt+shift+u"]);
	assert.deepEqual(lifecycleEvents, ["tool_result", "turn_start", "session_start", "session_tree", "session_shutdown"]);
	assert.deepEqual(adapterEvents, Object.values(TASK_UI_EVENTS));
	assert.equal(lifecycleEvents.includes("before_agent_start"), false);
	assert.equal(lifecycleEvents.includes("tool_call"), false);
	assert.equal(lifecycleEvents.includes("agent_start"), false);
});

test("writes the complete projection as Markdown without changing state", async () => {
	const { pi, tools } = extensionHarness();
	taskUiExtension(pi);
	const tool = (name: string) => tools.find((item) => item.name === name)!;
	await tool("task_ui_batch_create").execute("create", {
		tasks: [
			{ id: "parent", subject: "Parent", description: "Parent details.", status: "completed" },
			{ id: "child", subject: "Child", parent_id: "parent", blocked_by: ["parent"] },
		],
	});

	const directory = await mkdtemp(join(tmpdir(), "task-ui-tool-"));
	const outputPath = join(directory, "tasks.md");
	try {
		const markdownTool = tool("task_ui_to_md");
		assert.deepEqual(Object.keys(markdownTool.parameters?.properties ?? {}), ["path", "overwrite"]);
		const first = await markdownTool.execute("dump", { path: outputPath });
		const expectedMarkdown = `# 1. Parent

Parent details.

**Status:** completed

## 1.1. Child

**Status:** pending · **Dependencies:** [1. Parent](#1-parent)`;

		assert.equal(first.content[0].text, outputPath);
		assert.equal(await readFile(outputPath, "utf8"), expectedMarkdown);
		await assert.rejects(
			markdownTool.execute("dump-again", { path: outputPath }),
			/Ask the user to confirm overwriting it.*overwrite: true/,
		);
		const second = await markdownTool.execute("dump-confirmed", { path: outputPath, overwrite: true });
		assert.equal(second.content[0].text, outputPath);
		assert.equal(await readFile(outputPath, "utf8"), expectedMarkdown);
		assert.equal(first.details?.action, "to_md");
		assert.equal(first.details?.path, outputPath);
		assert.deepEqual((first.details?.tasks as Array<{ id: string }>).map((task) => task.id), ["parent", "child"]);
		assert.deepEqual(first.details?.counts, {
			total: 2,
			pending: 1,
			in_progress: 0,
			completed: 1,
			failed: 0,
			stopped: 0,
		});

		const theme = { fg: (_color: string, text: string) => text };
		const rendered = markdownTool.renderResult?.(first, {}, theme)?.render(200).map((line) => stripVTControlCharacters(line).trimEnd());
		assert.deepEqual(rendered, [`Exported 2 projected task(s) to ${outputPath}`]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("cycles sidebar → browse → off and supports named view commands", async () => {
	const { pi, tools } = extensionHarness();
	type ShortcutHandler = (ctx: never) => Promise<void>;
	type CommandHandler = (args: string, ctx: never) => Promise<void>;
	const shortcuts = new Map<string, ShortcutHandler>();
	const lifecycle = new Map<string, (event: never, ctx: never) => Promise<void>>();
	let taskUiCommand: CommandHandler | undefined;
	pi.registerShortcut = ((key: string, options: { handler: ShortcutHandler }) => shortcuts.set(key, options.handler)) as never;
	pi.registerCommand = ((_name: string, options: { handler: CommandHandler }) => { taskUiCommand = options.handler; }) as never;
	pi.on = ((event: string, handler: (event: never, ctx: never) => Promise<void>) => lifecycle.set(event, handler)) as never;
	taskUiExtension(pi);
	let sidebarHidden = false;
	let browser: TaskBrowserComponent | undefined;
	let browserCount = 0;
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};
	const ctx = {
		mode: "tui",
		sessionManager: { getBranch: () => [] },
		ui: {
			notify() {},
			custom(factory: (...args: never[]) => TaskBarComponent | TaskBrowserComponent, options: {
				onHandle?: (handle: unknown) => void;
				overlayOptions: { nonCapturing?: boolean };
			}) {
				return new Promise((resolve) => {
					const component = factory(
						{ requestRender() {}, terminal: { rows: 24 } } as never,
						theme as never,
						{ matches: (data: string, binding: string) => binding === "tui.select.cancel" && data === "\x1b" } as never,
						resolve as never,
					);
					if (options.overlayOptions.nonCapturing) {
						options.onHandle?.({
							setHidden: (hidden: boolean) => { sidebarHidden = hidden; },
							isHidden: () => sidebarHidden,
							hide() {},
						});
					} else {
						browser = component as TaskBrowserComponent;
						browserCount += 1;
					}
				});
			},
		},
	};
	pi.appendEntry = () => {};
	await lifecycle.get("session_start")!({} as never, ctx as never);
	await tools.find((tool) => tool.name === "task_ui_create")!.execute("test", { subject: "Task" });
	const cycle = () => shortcuts.get("alt+u")!(ctx as never);
	assert.equal(sidebarHidden, false);
	let browsing = cycle();
	assert.equal(sidebarHidden, true);
	browser!.handleInput("\x1bu");
	await browsing;
	assert.equal(sidebarHidden, true);
	await cycle();
	assert.equal(sidebarHidden, false);
	assert.equal(browserCount, 1);

	for (const key of ["q", "\x1b"]) {
		browsing = cycle();
		assert.equal(sidebarHidden, true);
		browser!.handleInput(key);
		await browsing;
		assert.equal(sidebarHidden, false);
	}

	// The registered shortcut also closes browse if Pi dispatches it globally.
	browsing = cycle();
	await cycle();
	await browsing;
	assert.equal(sidebarHidden, true);
	browsing = shortcuts.get("alt+shift+u")!(ctx as never);
	browser!.handleInput("q");
	await browsing;
	assert.equal(sidebarHidden, false);

	await taskUiCommand!("hide", ctx as never);
	assert.equal(sidebarHidden, true);
	await taskUiCommand!("sidebar", ctx as never);
	assert.equal(sidebarHidden, false);

	browsing = taskUiCommand!("browse", ctx as never);
	assert.equal(sidebarHidden, true);
	await taskUiCommand!("sidebar", ctx as never);
	await browsing;
	assert.equal(sidebarHidden, false);

	browsing = taskUiCommand!("cycle", ctx as never);
	assert.equal(sidebarHidden, true);
	await taskUiCommand!("cycle", ctx as never);
	await browsing;
	assert.equal(sidebarHidden, true);
	await taskUiCommand!("cycle", ctx as never);
	assert.equal(sidebarHidden, false);
	await lifecycle.get("session_shutdown")!({} as never, ctx as never);
});

test("classifies only successful checkpoint tool results", () => {
	const checkpoint = (toolName: string, input: unknown, isError = false) =>
		checkpointForToolResult({ toolName, input, isError });

	assert.equal(checkpoint("bash", { command: "git commit -m 'save work'" }), "git commit");
	assert.equal(checkpoint("bash", { command: "cd repo && git commit" }), "git commit");
	assert.equal(checkpoint("bash", { command: "git -C repo commit --amend" }), "git commit");
	assert.equal(checkpoint("bash", { command: "npm test; git commit -am done" }), "git commit");
	assert.equal(checkpoint("bash", { command: "echo 'git commit'" }), undefined);
	assert.equal(checkpoint("bash", { command: "git commitment" }), undefined);
	assert.equal(checkpoint("bash", { command: "git commit -m failed" }, true), undefined);
	assert.equal(checkpoint("bash", {}, false), undefined);
	assert.equal(checkpoint("link_send", { to: "worker", message: "status" }), "link_send");
	assert.equal(checkpoint("link_send", { to: "worker", message: "status" }, true), undefined);
	assert.equal(checkpoint("read", { path: "README.md" }), undefined);
});

test("queues one hidden task reminder per turn when unfinished tasks exist", async () => {
	const tools: RegisteredTool[] = [];
	const handlers = new Map<string, (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>>();
	const messages: Array<{ message: { customType: string; content: string; display: boolean }; options: { deliverAs: string } }> = [];
	const pi = {
		registerTool(tool: RegisteredTool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on(name: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>) {
			handlers.set(name, handler);
		},
		sendMessage(message: { customType: string; content: string; display: boolean }, options: { deliverAs: string }) {
			messages.push({ message, options });
		},
		appendEntry() {},
		events: { on() {} },
	} as unknown as ExtensionAPI;
	const ctx = { hasUI: false, mode: "json", ui: { notify() {} } } as unknown as Record<string, unknown>;
	taskUiExtension(pi);
	const tool = (name: string) => tools.find((item) => item.name === name)!;
	await tool("task_ui_create").execute("create", { id: "work", subject: "Work" });

	await handlers.get("tool_result")?.({ toolName: "bash", input: { command: "git commit -m done" }, isError: false }, ctx);
	await handlers.get("tool_result")?.({ toolName: "link_send", input: {}, isError: false }, ctx);

	assert.equal(messages.length, 1);
	assert.equal(messages[0].message.customType, "task-ui-checkpoint-reminder");
	assert.equal(messages[0].message.display, false);
	assert.match(messages[0].message.content, /successful git commit/);
	assert.match(messages[0].message.content, /mention the update in your next natural user-facing status message/);
	assert.deepEqual(messages[0].options, { deliverAs: "steer" });

	await handlers.get("turn_start")?.({}, ctx);
	await handlers.get("tool_result")?.({ toolName: "link_send", input: {}, isError: false }, ctx);
	assert.equal(messages.length, 2);
	assert.match(messages[1].message.content, /successful link_send/);
});

test("does not queue checkpoint reminders without unfinished projected tasks", async () => {
	const tools: RegisteredTool[] = [];
	const handlers = new Map<string, (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>>();
	const messages: unknown[] = [];
	const pi = {
		registerTool(tool: RegisteredTool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on(name: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>) {
			handlers.set(name, handler);
		},
		sendMessage(message: unknown) { messages.push(message); },
		events: { on() {} },
	} as unknown as ExtensionAPI;
	const ctx = { hasUI: false, mode: "json", ui: { notify() {} } } as unknown as Record<string, unknown>;
	taskUiExtension(pi);

	await handlers.get("tool_result")?.({ toolName: "link_send", input: {}, isError: false }, ctx);
	assert.equal(messages.length, 0);

	const tool = (name: string) => tools.find((item) => item.name === name)!;
	await tool("task_ui_create").execute("create", { id: "done", subject: "Done", status: "completed" });
	await handlers.get("tool_result")?.({ toolName: "bash", input: { command: "git commit --allow-empty -m done" }, isError: false }, ctx);
	assert.equal(messages.length, 0);
});

test("reports checkpoint reminder injection failures without interrupting tool results", async () => {
	const tools: RegisteredTool[] = [];
	const handlers = new Map<string, (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>>();
	const notifications: Array<[string, string]> = [];
	const pi = {
		registerTool(tool: RegisteredTool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on(name: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>) {
			handlers.set(name, handler);
		},
		sendMessage() { throw new Error("send failed"); },
		events: { on() {} },
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: { notify(message: string, level: string) { notifications.push([message, level]); } },
	} as unknown as Record<string, unknown>;
	taskUiExtension(pi);
	await tools.find((item) => item.name === "task_ui_create")?.execute("create", { id: "work", subject: "Work" });

	await assert.doesNotReject(() => handlers.get("tool_result")!({ toolName: "link_send", input: {}, isError: false }, ctx));
	assert.deepEqual(notifications, [["Task UI checkpoint reminder failed: send failed", "warning"]]);
});

test("renders no window when there are no tasks or history", () => {
	const state = createInitialTaskUiState();
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};

	assert.deepEqual(new TaskBarComponent(() => state, () => "✳", theme as never).render(60), []);
});

test("sidebar shows descriptions for executing tasks in depth-first order", () => {
	const state = createTasks(createInitialTaskUiState(), [
		{ id: "parent", subject: "Parent", description: "Parent context", executing: true },
		{ id: "other", subject: "Other", description: "Fourth context", executing: true },
		{ id: "child", subject: "Child", description: "Child context", parentId: "parent", executing: true },
		{ id: "grandchild", subject: "Grandchild", description: "Grandchild context", parentId: "child", executing: true },
		{ id: "paused", subject: "Paused", description: "Paused context", status: "in_progress" },
		{ id: "missing", subject: "Missing", executing: true },
	]).state;
	const styled: Array<[string, string]> = [];
	const theme = {
		fg: (color: string, text: string) => {
			styled.push([color, text]);
			return text;
		},
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};
	const lines = new TaskBarComponent(() => state, () => "✳", theme as never, () => 40)
		.render(60)
		.map(stripVTControlCharacters);
	const separator = lines.indexOf("");
	const descriptions = lines.slice(separator + 1);

	assert.ok(separator > 0);
	assert.ok(descriptions.some((line) => line.includes("Parent context")));
	assert.ok(descriptions.some((line) => line.includes("Child context")));
	assert.ok(descriptions.some((line) => line.includes("Grandchild context")));
	assert.equal(descriptions.some((line) => line.includes("Fourth context")), false);
	assert.equal(descriptions.some((line) => line.includes("Paused context")), false);
	assert.equal(descriptions.some((line) => /Parent|Child|Grandchild/.test(line) && !line.includes("context")), false);
	assert.equal(descriptions.filter((line) => line.startsWith("├")).length, 2);
	assert.equal(descriptions[0], `╭${"─".repeat(58)}╮`);
	assert.ok(styled.some(([color, text]) => color === "dim" && text === "Parent context"));
});

test("sidebar crops descriptions to three lines and respects its height budget", () => {
	const state = createTasks(createInitialTaskUiState(), [{
		id: "work",
		subject: "Work",
		description: "First explicit line\nSecond explicit line\nThird explicit line\nFourth explicit line",
		executing: true,
	}]).state;
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};
	const roomy = new TaskBarComponent(() => state, () => "✳", theme as never, () => 20)
		.render(30)
		.map(stripVTControlCharacters);
	const roomyDetails = roomy.slice(roomy.indexOf("") + 2, -1);
	assert.equal(roomyDetails.length, 3);
	assert.match(roomyDetails[0], /First explicit line/);
	assert.match(roomyDetails[1], /Second explicit line/);
	assert.match(roomyDetails[2], /Third explicit line…/);

	const constrained = new TaskBarComponent(() => state, () => "✳", theme as never, () => 7)
		.render(30)
		.map(stripVTControlCharacters);
	assert.equal(constrained.includes(""), false);
	assert.equal(constrained.some((line) => line.includes("First explicit line")), false);
});

test("browser shows every task in hierarchical number order", () => {
	const state = createTasks(createInitialTaskUiState(), [
		{ id: "parent", subject: "Completed parent", status: "completed" },
		{ id: "other", subject: "Active root", status: "in_progress" },
		{ id: "child", subject: "Pending child", parentId: "parent" },
	]).state;
	state.focusedTaskId = "child";
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};
	const keybindings = { matches: () => false };
	const browser = new TaskBrowserComponent(
		() => state,
		() => "✳",
		() => 10,
		theme as never,
		keybindings as never,
		() => {},
		() => {},
	);
	const lines = browser.render(60).map(stripVTControlCharacters);

	assert.equal(browser.getSelectedTaskId(), "child");
	assert.ok(lines.findIndex((line) => line.includes("#1 Completed parent")) < lines.findIndex((line) => line.includes("#1.1 Pending child")));
	assert.ok(lines.findIndex((line) => line.includes("#1.1 Pending child")) < lines.findIndex((line) => line.includes("#2 Active root")));
	assert.match(lines.find((line) => line.includes("Pending child")) ?? "", /›/);
});

test("browser toggles a details pane for the selected task", () => {
	const state = createTasks(createInitialTaskUiState(), [
		{ id: "task", subject: "Task" },
	]).state;
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};
	const keybindings = { matches: (data: string, binding: string) => binding === "tui.select.cancel" && data === "escape" };
	let closes = 0;
	const browser = new TaskBrowserComponent(
		() => state,
		() => "✳",
		() => 10,
		theme as never,
		keybindings as never,
		() => {},
		() => { closes += 1; },
	);

	assert.equal(browser.render(50).some((line) => line.includes("No description")), false);
	browser.handleInput("d");
	const open = browser.render(50).map(stripVTControlCharacters);
	assert.ok(open.some((line) => line.includes("No description")));
	assert.ok(open.some((line) => line.includes("d/Esc close")));
	assert.ok(open.some((line) => line.includes("#1 Task")));
	assert.ok(open.length <= 10);

	browser.handleInput("escape");
	assert.equal(browser.render(50).some((line) => line.includes("No description")), false);
	assert.equal(closes, 0);
	browser.handleInput("q");
	assert.equal(closes, 1);
});

test("browser scrolls complete descriptions without hiding the selected task", () => {
	const description = Array.from({ length: 12 }, (_, index) => `Detail line ${index + 1}`).join("\n");
	const state = createTasks(
		createInitialTaskUiState(),
		Array.from({ length: 12 }, (_, index) => ({
			id: `task-${index + 1}`,
			subject: `Task ${index + 1}`,
			description: index === 9 ? description : undefined,
		})),
	).state;
	state.focusedTaskId = "task-10";
	const bindingKeys: Record<string, string[]> = {
		"tui.select.cancel": ["escape"],
		"tui.select.up": ["up"],
		"tui.select.down": ["down"],
	};
	const keybindings = { matches: (data: string, binding: string) => bindingKeys[binding]?.includes(data) ?? false };
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};
	let viewportHeight = 10;
	const browser = new TaskBrowserComponent(
		() => state,
		() => "✳",
		() => viewportHeight,
		theme as never,
		keybindings as never,
		() => {},
		() => {},
	);

	browser.handleInput("d");
	let lines = browser.render(50).map(stripVTControlCharacters);
	assert.ok(lines.some((line) => line.includes("#10 Task 10")));
	assert.ok(lines.some((line) => line.includes("details · 1–4/12")));
	assert.ok(lines.some((line) => line.includes("Detail line 4")));
	assert.equal(lines.some((line) => line.includes("Detail line 5")), false);

	browser.handleInput("j");
	browser.handleInput("\x04");
	lines = browser.render(50).map(stripVTControlCharacters);
	assert.ok(lines.some((line) => line.includes("details · 4–7/12")));
	assert.equal(browser.getSelectedTaskId(), "task-10");

	for (let index = 0; index < 20; index += 1) browser.handleInput("down");
	lines = browser.render(50).map(stripVTControlCharacters);
	assert.ok(lines.some((line) => line.includes("details · 9–12/12")));
	viewportHeight = 7;
	lines = browser.render(50).map(stripVTControlCharacters);
	assert.ok(lines.some((line) => line.includes("#10 Task 10")));
	assert.ok(lines.some((line) => line.includes("details · 9–10/12")));

	browser.handleInput("d");
	browser.handleInput("j");
	assert.equal(browser.getSelectedTaskId(), "task-11");
});

test("browser resets details when the selected task disappears", () => {
	let state = createTasks(createInitialTaskUiState(), [
		{ id: "first", subject: "First", description: "First context" },
		{ id: "second", subject: "Second", description: "Old line one\nOld line two\nOld line three" },
	]).state;
	state.focusedTaskId = "second";
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};
	const keybindings = { matches: () => false };
	const targets: string[] = [];
	const browser = new TaskBrowserComponent(
		() => state,
		() => "✳",
		() => 8,
		theme as never,
		keybindings as never,
		() => {},
		(target) => { targets.push(target); },
	);

	browser.handleInput("d");
	browser.render(40);
	browser.handleInput("j");
	state = { ...state, tasks: state.tasks.filter((task) => task.id !== "second") };
	const lines = browser.render(40).map(stripVTControlCharacters);
	assert.equal(browser.getSelectedTaskId(), "first");
	assert.ok(lines.some((line) => line.includes("First context")));
	assert.ok(lines.some((line) => line.includes("details · 1–1/1")));
	assert.equal(lines.some((line) => line.includes("Old line")), false);

	browser.handleInput("\x1bu");
	assert.deepEqual(targets, ["off"]);
});

test("browser navigates and scrolls through the complete task list", () => {
	const state = createTasks(
		createInitialTaskUiState(),
		Array.from({ length: 10 }, (_, index) => ({ id: `task-${index + 1}`, subject: `Task ${index + 1}` })),
	).state;
	const bindingKeys: Record<string, string[]> = {
		"tui.select.cancel": ["escape"],
		"tui.select.up": ["up"],
		"tui.select.down": ["down"],
	};
	const keybindings = { matches: (data: string, binding: string) => bindingKeys[binding]?.includes(data) ?? false };
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};
	let renders = 0;
	let closes = 0;
	const browser = new TaskBrowserComponent(
		() => state,
		() => "✳",
		() => 9,
		theme as never,
		keybindings as never,
		() => { renders += 1; },
		() => { closes += 1; },
	);

	browser.handleInput("down");
	browser.handleInput("j");
	browser.handleInput("\x04");
	assert.equal(browser.getSelectedTaskId(), "task-6");
	browser.handleInput("\x15");
	assert.equal(browser.getSelectedTaskId(), "task-3");
	browser.handleInput("\x04");
	assert.equal(browser.getSelectedTaskId(), "task-6");
	browser.handleInput("g");
	browser.handleInput("G");
	assert.equal(browser.getSelectedTaskId(), "task-10");
	const lines = browser.render(50).map(stripVTControlCharacters);
	assert.equal(lines.length, 9);
	assert.match(lines[0], /10\/10/);
	assert.equal(lines.some((line) => line.includes("#1 Task 1")), false);
	assert.equal(lines.some((line) => line.includes("Task 10")), true);
	browser.handleInput("g");
	browser.handleInput("g");
	assert.equal(browser.getSelectedTaskId(), "task-1");
	browser.handleInput("q");
	assert.equal(renders, 7);
	assert.equal(closes, 1);
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

test("renders newest history tasks first at the same indentation level", () => {
	let state = createTasks(createInitialTaskUiState(), [
		{ id: "parent", subject: "Parent" },
		{ id: "root", subject: "Root" },
		{ id: "child", subject: "Child", parentId: "parent" },
	], "2026-01-01T10:00:00.000Z").state;
	state = updateTask(state, { taskId: "parent", status: "completed" }, "2026-01-01T10:01:00.000Z").state;
	state = updateTask(state, { taskId: "child", status: "completed" }, "2026-01-01T10:02:00.000Z").state;
	state = updateTask(state, { taskId: "root", status: "completed" }, "2026-01-01T10:03:00.000Z").state;
	state = updateTask(state, { taskId: "child", subject: "Edited child" }, "2026-01-01T10:04:00.000Z").state;
	const styled: Array<[string, string]> = [];
	const theme = {
		fg: (color: string, text: string) => {
			styled.push([color, text]);
			return text;
		},
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};
	const lines = new TaskBarComponent(() => state, () => "✳", theme as never)
		.render(60)
		.map(stripVTControlCharacters);

	assert.match(lines[1], /^│ All done!/);
	assert.ok(styled.some(([color, text]) => color === "muted" && text === "All done!"));
	assert.match(lines[3], /^│ ✔ #2 Root/);
	assert.match(lines[4], /^│ ✔ #1\.1 Edited child/);
	assert.match(lines[5], /^│ ✔ #1 Parent/);
});

test("right-aligns labels and assigns stable distinct theme colors", () => {
	const state = createTasks(createInitialTaskUiState(), [
		{ id: "grill", subject: "Stress-test the plan", label: "grilling" },
		{ id: "research", subject: "Gather primary sources", label: "research" },
	]).state;
	const styled: Array<[string, string]> = [];
	const theme = {
		fg: (color: string, text: string) => {
			styled.push([color, text]);
			return text;
		},
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};
	const width = 60;
	const lines = new TaskBarComponent(() => state, () => "✳", theme as never).render(width);

	assert.equal(lines[1].length, width);
	assert.equal(lines[2].length, width);
	assert.equal(lines[1].indexOf("]"), width - 3);
	assert.equal(lines[2].indexOf("]"), width - 3);
	assert.match(lines[1], /\[grilling\] │$/);
	assert.match(lines[2], /\[research\] │$/);
	assert.equal(taskLabelColor("grilling"), taskLabelColor("GRILLING"));
	assert.notEqual(taskLabelColor("grilling"), taskLabelColor("research"));
	assert.ok(styled.some(([color, text]) => color === taskLabelColor("grilling") && text === "[grilling]"));
	assert.ok(styled.some(([color, text]) => color === taskLabelColor("research") && text === "[research]"));
});

test("renders every terminal task with dim text and labels", () => {
	const state = createTasks(createInitialTaskUiState(), [
		{ id: "done", subject: "Finished work", label: "task", status: "completed" },
		{ id: "failed", subject: "Failed work", label: "task", status: "failed" },
		{ id: "abandoned", subject: "Abandoned work", label: "task", status: "stopped" },
	]).state;
	const styled: Array<[string, string]> = [];
	const theme = {
		fg: (color: string, text: string) => {
			styled.push([color, text]);
			return text;
		},
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};

	new TaskBarComponent(() => state, () => "✳", theme as never).render(60);

	assert.ok(styled.some(([color, text]) => color === "dim" && text.includes("#2 Failed work")));
	assert.ok(styled.some(([color, text]) => color === "dim" && text.includes("■ #3 Abandoned work")));
	assert.ok(!styled.some(([color, text]) => color === "dim" && text === "■"));
	assert.equal(styled.filter(([color, text]) => color === "dim" && text === "[task]").length, 3);
	assert.ok(!styled.some(([color, text]) => color === taskLabelColor("task") && text === "[task]"));
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

test("batch creation, dashboard reads, stopping, and deletion stay within the UI projection", async () => {
	const { pi, tools } = extensionHarness();
	taskUiExtension(pi);
	const tool = (name: string) => tools.find((item) => item.name === name)!;

	await tool("task_ui_batch_create").execute("batch", {
		tasks: [
			{ id: "one", subject: "One", label: "grilling", status: "in_progress", executing: true },
			{ id: "two", subject: "Two", status: "in_progress" },
			{ id: "three", subject: "Three" },
		],
	});
	const dashboard = await tool("task_ui_get").execute("get", {});
	assert.match(dashboard.content[0].text, /Active \(2\)/);
	assert.match(dashboard.content[0].text, /Next: #3/);

	const labeled = await tool("task_ui_get").execute("get-labeled", { task_id: "one" });
	assert.match(labeled.content[0].text, /Label: grilling/);
	await tool("task_ui_update").execute("label-two", { task_id: "two", label: "research" });
	const relabeled = await tool("task_ui_get").execute("get-relabeled", { task_id: "two" });
	assert.match(relabeled.content[0].text, /Label: research/);

	const stopped = await tool("task_ui_stop").execute("stop", { task_id: "one", reason: "User stopped display" });
	assert.match(stopped.content[0].text, /stopped UI history/);
	const stoppedTask = await tool("task_ui_get").execute("get-one", { task_id: "one" });
	assert.match(stoppedTask.content[0].text, /\[stopped\]/);

	const removed = await tool("task_ui_remove").execute("remove", { task_id: "two" });
	assert.match(removed.content[0].text, /Removed two/);
	const cleared = await tool("task_ui_clear").execute("clear", {});
	assert.match(cleared.content[0].text, /Cleared 2 projected tasks/);
	const empty = await tool("task_ui_list").execute("list-empty", { scope: "all" });
	assert.match(empty.content[0].text, /^No projected tasks matched the selector/);
	assert.match(empty.content[0].text, /Suggested next ready task: none/);
});

test("list requires exactly one workflow scope or exact status", async () => {
	const { pi, tools } = extensionHarness();
	taskUiExtension(pi);
	const tool = (name: string) => tools.find((item) => item.name === name)!;

	await tool("task_ui_batch_create").execute("batch", {
		tasks: [
			{ id: "blocker", subject: "Blocker", status: "in_progress" },
			{ id: "blocked", subject: "Blocked", blocked_by: ["blocker"] },
			{ id: "ready", subject: "Ready" },
			{ id: "done", subject: "Done", status: "completed" },
			{ id: "failed", subject: "Failed", status: "failed" },
		],
	});

	await assert.rejects(() => tool("task_ui_list").execute("missing", {}), /exactly one of scope or status/);
	await assert.rejects(
		() => tool("task_ui_list").execute("both", { scope: "all", status: "pending" }),
		/exactly one of scope or status/,
	);

	const open = await tool("task_ui_list").execute("open", { scope: "open" });
	assert.deepEqual((open.details?.tasks as Array<{ id: string }>).map((task) => task.id), ["blocker", "blocked", "ready"]);
	assert.deepEqual(open.details?.selector, { scope: "open" });
	assert.equal((open.details?.counts as { total: number }).total, 5);

	const ready = await tool("task_ui_list").execute("ready", { scope: "ready" });
	assert.deepEqual((ready.details?.tasks as Array<{ id: string }>).map((task) => task.id), ["ready"]);
	assert.equal((ready.details?.suggestedNextTask as { id: string }).id, "ready");
	assert.match(ready.content[0].text, /task_ui_update\(\{ task_id:/);

	const history = await tool("task_ui_list").execute("history", { scope: "history" });
	assert.deepEqual((history.details?.tasks as Array<{ id: string }>).map((task) => task.id), ["done", "failed"]);

	const pending = await tool("task_ui_list").execute("pending", { status: "pending" });
	assert.deepEqual((pending.details?.tasks as Array<{ id: string }>).map((task) => task.id), ["blocked", "ready"]);
	assert.deepEqual(pending.details?.selector, { status: "pending" });
	assert.match(pending.details?.suggestedAction as string, /task_ui_list\(\{ scope: "ready" \}\)/);

	const blocked = await tool("task_ui_get").execute("blocked", { task_id: "blocked" });
	assert.match(blocked.details?.suggestedAction as string, /task_ui_get\(\{ task_id: "blocker" \}\)/);
});

test("tool results keep next-task data separate from API usage guidance", async () => {
	const { pi, tools } = extensionHarness();
	taskUiExtension(pi);
	const tool = (name: string) => tools.find((item) => item.name === name)!;

	const created = await tool("task_ui_create").execute("create", { id: "one", subject: "One" });
	assert.equal((created.details?.suggestedNextTask as { id: string }).id, "one");
	assert.match(created.details?.suggestedAction as string, /task_ui_update\(\{ task_id: "one"/);

	const started = await tool("task_ui_update").execute("start", {
		task_id: "one",
		status: "in_progress",
		executing: true,
	});
	assert.equal(started.details?.suggestedNextTask, undefined);
	assert.match(started.details?.suggestedAction as string, /Later call task_ui_update/);

	await tool("task_ui_create").execute("create-two", { id: "two", subject: "Two" });
	const completed = await tool("task_ui_update").execute("complete", {
		task_id: "one",
		status: "completed",
		executing: false,
		progress: 100,
	});
	assert.equal((completed.details?.suggestedNextTask as { id: string }).id, "two");
	assert.match(completed.details?.suggestedAction as string, /task_ui_list\(\{ scope: "ready" \}\)/);
	assert.deepEqual(completed.details?.changedFields, ["status", "executing", "progress"]);
	assert.deepEqual((completed.details?.newlyReady as Array<{ id: string }>).map((task) => task.id), []);
});
