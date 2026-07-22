import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type OverlayHandle } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	TASK_STATUSES,
	appendTaskOutput,
	clearTaskOutput,
	cloneTaskUiState,
	createInitialTaskUiState,
	createTask,
	createTasks,
	getTaskDashboard,
	getTaskDepth,
	getTaskDisplayNumber,
	normalizeStoredTaskUiState,
	removeTask,
	replaceExternalTasks,
	setFocusedTask,
	updateTask,
	upsertExternalTask,
	type CreateTaskInput,
	type ExternalTaskInput,
	type TaskDashboard,
	type TaskRecord,
	type TaskUiState,
} from "./core.ts";

const STATE_ENTRY_TYPE = "task-ui-state";
const OVERLAY_MIN_TERMINAL_WIDTH = 72;
const MAX_VISIBLE_WORK_TASKS = 7;
const MAX_VISIBLE_HISTORY_TASKS = 3;
const SPINNER_FRAMES = ["✳", "✽", "•"] as const;
const COMPLETED_ICON = "\x1b[38;2;34;197;94m✔\x1b[39m";
const LABEL_COLORS = ["accent", "mdLink", "syntaxType", "syntaxFunction", "syntaxString", "syntaxNumber", "syntaxKeyword", "syntaxVariable"] as const;

export const TASK_UI_EVENTS = {
	snapshot: "task-ui:snapshot",
	upsert: "task-ui:upsert",
	remove: "task-ui:remove",
	output: "task-ui:output",
	focus: "task-ui:focus",
} as const;

type TaskToolDetails = {
	action: string;
	task?: TaskRecord;
	tasks?: TaskRecord[];
	dashboard?: TaskDashboard;
};

type SnapshotEvent = { tasks: ExternalTaskInput[]; focusedTaskId?: string };
type RemoveEvent = { taskId: string };
type OutputEvent = { taskId: string; text: string };
type FocusEvent = { taskId?: string };

type AgentTaskInput = {
	id?: string;
	subject: string;
	description?: string;
	label?: string;
	status?: (typeof TASK_STATUSES)[number];
	progress?: number;
	owner?: string;
	parent_id?: string;
	blocked_by?: string[];
	executing?: boolean;
	active_form?: string;
	started_at?: string;
	input_tokens?: number;
	output_tokens?: number;
};

function toCreateTaskInput(input: AgentTaskInput): CreateTaskInput {
	return {
		id: input.id,
		subject: input.subject,
		description: input.description,
		label: input.label,
		status: input.status,
		progress: input.progress,
		owner: input.owner,
		parentId: input.parent_id,
		blockedBy: input.blocked_by,
		executing: input.executing,
		activeForm: input.active_form,
		startedAt: input.started_at,
		inputTokens: input.input_tokens,
		outputTokens: input.output_tokens,
	};
}

function createTaskSchema() {
	return Type.Object({
		id: Type.Optional(Type.String({ description: "Backend task ID to mirror; generated when omitted" })),
		subject: Type.String({ description: "Short task title" }),
		description: Type.Optional(Type.String()),
		label: Type.Optional(Type.String({ description: "Short right-aligned label, without brackets" })),
		status: Type.Optional(StringEnum(TASK_STATUSES)),
		progress: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
		owner: Type.Optional(Type.String()),
		parent_id: Type.Optional(Type.String({ description: "Parent task ID; the parent remains independently executable" })),
		blocked_by: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that must complete first" })),
		executing: Type.Optional(Type.Boolean({ description: "Show the animated execution state" })),
		active_form: Type.Optional(Type.String({ description: "Present-progress text shown while executing" })),
		started_at: Type.Optional(Type.String({ description: "ISO timestamp used for elapsed time" })),
		input_tokens: Type.Optional(Type.Number({ minimum: 0 })),
		output_tokens: Type.Optional(Type.Number({ minimum: 0 })),
	});
}

function taskSummary(task: TaskRecord): string {
	const execution = task.executing ? ", executing" : "";
	const label = task.label ? ` [${task.label}]` : "";
	return `#${task.number} [${task.status}${execution}] ${task.id} — ${task.subject}${label}`;
}

function taskDetails(task: TaskRecord): string {
	const lines = [taskSummary(task)];
	if (task.description) lines.push(task.description);
	if (task.label) lines.push(`Label: ${task.label}`);
	if (task.progress !== undefined) lines.push(`Progress: ${task.progress}%`);
	if (task.owner) lines.push(`Owner: ${task.owner}`);
	if (task.parentId) lines.push(`Parent: ${task.parentId}`);
	if (task.blockedBy.length) lines.push(`Blocked by: ${task.blockedBy.join(", ")}`);
	if (task.activeForm) lines.push(`Active form: ${task.activeForm}`);
	if (task.startedAt) lines.push(`Started: ${task.startedAt}`);
	if (task.inputTokens !== undefined || task.outputTokens !== undefined) {
		lines.push(`Tokens: ↑ ${task.inputTokens ?? 0} ↓ ${task.outputTokens ?? 0}`);
	}
	return lines.join("\n");
}

function dashboardDetails(dashboard: TaskDashboard): string {
	const active = dashboard.active.length ? dashboard.active.map(taskSummary).join("\n") : "none";
	return [
		`Active (${dashboard.active.length}):`,
		active,
		`Next: ${dashboard.next ? taskSummary(dashboard.next) : "none"}`,
		`Focused: ${dashboard.focused ? taskSummary(dashboard.focused) : "none"}`,
	].join("\n");
}

function fit(text: string, width: number, theme: Theme): string {
	const safeWidth = Math.max(0, width);
	const truncated = truncateToWidth(text, safeWidth, theme.fg("dim", "…"));
	return truncated + " ".repeat(Math.max(0, safeWidth - visibleWidth(truncated)));
}

function framedRow(text: string, width: number, theme: Theme): string {
	if (width < 2) return truncateToWidth(text, width, "");
	return theme.fg("borderMuted", "│") + fit(` ${text}`, width - 2, theme) + theme.fg("borderMuted", "│");
}

export function taskLabelColor(label: string): (typeof LABEL_COLORS)[number] {
	let hash = 2_166_136_261;
	for (const character of label.toLowerCase()) {
		hash ^= character.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16_777_619);
	}
	return LABEL_COLORS[(hash >>> 0) % LABEL_COLORS.length];
}

function framedTaskRow(text: string, label: string | undefined, width: number, theme: Theme, dimLabel = false): string {
	if (!label || width < 10) return framedRow(text, width, theme);
	const innerWidth = width - 2;
	const maxBadgeWidth = Math.min(Math.floor(innerWidth * 0.4), innerWidth - 6);
	if (maxBadgeWidth < 3) return framedRow(text, width, theme);
	const labelText = truncateToWidth(label, maxBadgeWidth - 2, "…");
	const badge = `[${labelText}]`;
	const leftWidth = innerWidth - visibleWidth(badge) - 3;
	if (leftWidth < 1) return framedRow(text, width, theme);
	const labelColor = dimLabel ? "dim" : taskLabelColor(label);
	return theme.fg("borderMuted", "│")
		+ ` ${fit(text, leftWidth, theme)} ${theme.fg(labelColor, badge)} `
		+ theme.fg("borderMuted", "│");
}

function divider(label: string, width: number, theme: Theme): string {
	const innerWidth = Math.max(1, width - 4);
	const labelText = ` ${label} `;
	const left = Math.max(1, Math.floor((innerWidth - labelText.length) / 2));
	const right = Math.max(1, innerWidth - labelText.length - left);
	return framedRow(theme.fg("dim", `${"─".repeat(left)}${labelText}${"─".repeat(right)}`), width, theme);
}

function formatTokens(tokens: number): string {
	if (tokens < 1_000) return String(tokens);
	if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0)}m`;
}

function formatElapsed(startedAt: string | undefined, now: number): string | undefined {
	if (!startedAt) return undefined;
	const started = Date.parse(startedAt);
	if (!Number.isFinite(started)) return undefined;
	const totalSeconds = Math.max(0, Math.floor((now - started) / 1_000));
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	return hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function orderTasksForDisplay(tasks: TaskRecord[]): TaskRecord[] {
	const includedIds = new Set(tasks.map((task) => task.id));
	const children = new Map<string, TaskRecord[]>();
	const roots: TaskRecord[] = [];

	for (const task of tasks) {
		if (task.parentId && includedIds.has(task.parentId)) {
			const siblings = children.get(task.parentId) ?? [];
			siblings.push(task);
			children.set(task.parentId, siblings);
		} else {
			roots.push(task);
		}
	}

	const byNumber = (left: TaskRecord, right: TaskRecord) =>
		(left.subtaskNumber ?? left.number) - (right.subtaskNumber ?? right.number) || left.number - right.number;
	roots.sort((left, right) => left.number - right.number);
	for (const siblings of children.values()) siblings.sort(byNumber);

	const ordered: TaskRecord[] = [];
	const visit = (task: TaskRecord) => {
		ordered.push(task);
		for (const child of children.get(task.id) ?? []) visit(child);
	};
	for (const root of roots) visit(root);
	return ordered;
}

export function blockerText(task: TaskRecord, tasks: TaskRecord[]): string | undefined {
	if (!task.blockedBy.length) return undefined;
	const taskById = new Map(tasks.map((item) => [item.id, item]));
	const blockers = task.blockedBy.flatMap((id) => {
		const blocker = taskById.get(id);
		if (blocker?.status === "completed") return [];
		return [blocker ? `#${getTaskDisplayNumber(blocker, tasks)}` : id];
	});
	return blockers.length ? `› blocked by ${blockers.join(", ")}` : undefined;
}

function taskLine(
	task: TaskRecord,
	tasks: TaskRecord[],
	focused: boolean,
	spinnerFrame: string,
	theme: Theme,
	showHierarchy = true,
): string {
	let glyph: string;
	let label = task.subject;
	if (task.executing) {
		glyph = theme.fg("warning", spinnerFrame);
		label = task.activeForm ?? task.subject;
	} else {
		switch (task.status) {
			case "completed": glyph = "✔"; break;
			case "in_progress": glyph = theme.fg("accent", "◼"); break;
			case "pending": glyph = theme.fg("dim", "◻"); break;
			case "failed": glyph = theme.fg("error", "✖"); break;
			case "stopped": glyph = theme.fg("dim", "■"); break;
		}
	}

	const indent = showHierarchy ? "  ".repeat(getTaskDepth(task, tasks)) : "";
	const taskLabel = `#${getTaskDisplayNumber(task, tasks)} ${label}`;
	if (task.status === "completed") {
		return `${indent}${COMPLETED_ICON} ${theme.fg("dim", theme.strikethrough(taskLabel))}`;
	}
	const content = `${indent}${glyph} ${taskLabel}`;
	if (task.status === "failed") return theme.fg("error", content);
	if (task.status === "pending") return theme.fg("muted", content);
	return focused ? theme.bold(content) : content;
}

function taskMetadata(task: TaskRecord, tasks: TaskRecord[], theme: Theme): string | undefined {
	const indent = "  ".repeat(getTaskDepth(task, tasks) + 1);
	if (task.executing) {
		const telemetry: string[] = [];
		const elapsed = formatElapsed(task.startedAt, Date.now());
		if (elapsed) telemetry.push(elapsed);
		if (task.inputTokens !== undefined || task.outputTokens !== undefined) {
			telemetry.push(`↑ ${formatTokens(task.inputTokens ?? 0)} ↓ ${formatTokens(task.outputTokens ?? 0)}`);
		}
		if (telemetry.length) return theme.fg("dim", `${indent}${telemetry.join(" · ")}`);
	}
	const blocked = blockerText(task, tasks);
	return blocked ? theme.fg("dim", `${indent}${blocked}`) : undefined;
}

export class TaskBarComponent {
	private readonly getState: () => TaskUiState;
	private readonly getSpinnerFrame: () => string;
	private readonly theme: Theme;

	constructor(getState: () => TaskUiState, getSpinnerFrame: () => string, theme: Theme) {
		this.getState = getState;
		this.getSpinnerFrame = getSpinnerFrame;
		this.theme = theme;
	}

	render(width: number): string[] {
		const state = this.getState();
		const tasks = state.tasks;
		const work = orderTasksForDisplay(tasks.filter((task) => task.status === "in_progress" || task.status === "pending"));
		const history = tasks
			.filter((task) => ["completed", "failed", "stopped"].includes(task.status))
			.sort((left, right) => (right.terminalAt ?? right.updatedAt).localeCompare(left.terminalAt ?? left.updatedAt) || right.number - left.number);
		const topTitle = " Tasks ";
		const topFill = Math.max(0, width - visibleWidth(topTitle) - 2);
		const lines = [this.theme.fg("borderMuted", `╭${topTitle}${"─".repeat(topFill)}╮`)];

		if (tasks.length > 0) {
			if (work.length) {
				for (const task of work.slice(0, MAX_VISIBLE_WORK_TASKS)) {
					lines.push(framedTaskRow(taskLine(task, tasks, task.id === state.focusedTaskId, this.getSpinnerFrame(), this.theme), task.label, width, this.theme));
					const metadata = taskMetadata(task, tasks, this.theme);
					if (metadata) lines.push(framedRow(metadata, width, this.theme));
				}
				if (work.length > MAX_VISIBLE_WORK_TASKS) {
					lines.push(framedRow(this.theme.fg("dim", `… and ${work.length - MAX_VISIBLE_WORK_TASKS} more`), width, this.theme));
				}
			}
			if (history.length) {
				if (!work.length) lines.push(framedRow(this.theme.fg("muted", "All done!"), width, this.theme));
				lines.push(divider("history", width, this.theme));
				for (const task of history.slice(0, MAX_VISIBLE_HISTORY_TASKS)) {
					lines.push(framedTaskRow(
						taskLine(task, tasks, false, this.getSpinnerFrame(), this.theme, false),
						task.label,
						width,
						this.theme,
						task.status === "completed",
					));
				}
			}
		}

		lines.push(this.theme.fg("borderMuted", `╰${"─".repeat(Math.max(0, width - 2))}╯`));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {}
}

function renderToolCall(name: string, detail: string | undefined, theme: Theme): Text {
	const suffix = detail ? ` ${theme.fg("dim", detail)}` : "";
	return new Text(theme.fg("toolTitle", theme.bold(name)) + suffix, 0, 0);
}

function renderToolResult(result: { content: Array<{ type: string; text?: string }>; details?: TaskToolDetails }, theme: Theme): Text {
	const details = result.details;
	if (details?.task) return new Text(theme.fg("success", "✓ ") + theme.fg("muted", taskSummary(details.task)), 0, 0);
	if (details?.dashboard) {
		return new Text(theme.fg("muted", `${details.dashboard.active.length} active · next ${details.dashboard.next ? `#${details.dashboard.next.number}` : "none"}`), 0, 0);
	}
	if (details?.tasks) return new Text(theme.fg("muted", `${details.tasks.length} projected task(s)`), 0, 0);
	const first = result.content[0];
	return new Text(first?.type === "text" ? first.text ?? "" : "", 0, 0);
}

export default function taskUiExtension(pi: ExtensionAPI): void {
	let state = createInitialTaskUiState();
	let currentCtx: ExtensionContext | undefined;
	let overlayHandle: OverlayHandle | undefined;
	let overlayVisible = true;
	let requestRender: (() => void) | undefined;
	let sessionActive = false;
	let spinnerFrame = 0;
	let animationTimer: ReturnType<typeof setInterval> | undefined;

	const stopAnimation = () => {
		if (animationTimer) clearInterval(animationTimer);
		animationTimer = undefined;
		spinnerFrame = 0;
	};

	const syncAnimation = () => {
		const shouldAnimate = sessionActive && overlayVisible && state.tasks.some((task) => task.executing);
		if (!shouldAnimate) {
			stopAnimation();
			return;
		}
		if (animationTimer) return;
		animationTimer = setInterval(() => {
			spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
			requestRender?.();
		}, 500);
	};

	const publishState = () => {
		if (sessionActive) pi.appendEntry(STATE_ENTRY_TYPE, cloneTaskUiState(state));
		requestRender?.();
		syncAnimation();
	};

	const setState = (next: TaskUiState) => {
		state = next;
		publishState();
	};

	const reportEventError = (error: unknown) => {
		if (currentCtx?.hasUI) currentCtx.ui.notify(error instanceof Error ? error.message : "Invalid task-ui event", "warning");
	};

	const showOverlay = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		overlayVisible = true;
		if (overlayHandle) {
			overlayHandle.setHidden(false);
			requestRender?.();
			syncAnimation();
			return;
		}
		void ctx.ui.custom<void>((tui, theme) => {
			requestRender = () => tui.requestRender();
			return new TaskBarComponent(() => state, () => SPINNER_FRAMES[spinnerFrame], theme);
		}, {
			overlay: true,
			overlayOptions: {
				anchor: "top-right",
				width: "38%",
				minWidth: 48,
				maxHeight: "76%",
				margin: { top: 1, right: 1 },
				nonCapturing: true,
				visible: (termWidth) => termWidth >= OVERLAY_MIN_TERMINAL_WIDTH,
			},
			onHandle: (handle) => {
				overlayHandle = handle;
				syncAnimation();
			},
		}).finally(() => {
			overlayHandle = undefined;
			requestRender = undefined;
			stopAnimation();
		});
	};

	const persistMutation = (next: TaskUiState): TaskUiState => {
		setState(next);
		return next;
	};

	pi.events.on(TASK_UI_EVENTS.snapshot, (payload) => {
		try {
			const event = payload as SnapshotEvent;
			if (!Array.isArray(event.tasks)) throw new Error("task-ui:snapshot requires tasks[]");
			setState(replaceExternalTasks(event.tasks, event.focusedTaskId));
		} catch (error) { reportEventError(error); }
	});
	pi.events.on(TASK_UI_EVENTS.upsert, (payload) => {
		try { setState(upsertExternalTask(state, payload as ExternalTaskInput).state); } catch (error) { reportEventError(error); }
	});
	pi.events.on(TASK_UI_EVENTS.remove, (payload) => {
		try { setState(removeTask(state, (payload as RemoveEvent).taskId)); } catch (error) { reportEventError(error); }
	});
	pi.events.on(TASK_UI_EVENTS.output, (payload) => {
		try {
			const event = payload as OutputEvent;
			setState(appendTaskOutput(state, event.taskId, event.text).state);
		} catch (error) { reportEventError(error); }
	});
	pi.events.on(TASK_UI_EVENTS.focus, (payload) => {
		try { setState(setFocusedTask(state, (payload as FocusEvent).taskId)); } catch (error) { reportEventError(error); }
	});

	pi.registerTool({
		name: "task_ui_create",
		label: "Task UI Create",
		description: "Create or mirror one task in task-ui's presentation-only projection. This does not start backend work.",
		promptSnippet: "Create or mirror one task in task-ui (UI only)",
		executionMode: "sequential",
		parameters: createTaskSchema(),
		async execute(_id, params) {
			const result = createTask(state, toCreateTaskInput(params));
			persistMutation(result.state);
			return { content: [{ type: "text", text: `Projected ${taskSummary(result.task)}. No backend work was started.` }], details: { action: "create", task: result.task } as TaskToolDetails };
		},
		renderCall: (args, theme) => renderToolCall("task_ui_create", args.subject, theme),
		renderResult: (result, _options, theme) => renderToolResult(result as never, theme),
	});

	pi.registerTool({
		name: "task_ui_batch_create",
		label: "Task UI Batch Create",
		description: "Atomically create or mirror several tasks in task-ui's presentation-only projection. This does not start backend work.",
		promptSnippet: "Create several tasks in task-ui atomically (UI only)",
		executionMode: "sequential",
		parameters: Type.Object({ tasks: Type.Array(createTaskSchema(), { minItems: 1, maxItems: 100 }) }),
		async execute(_id, params) {
			const result = createTasks(state, params.tasks.map(toCreateTaskInput));
			persistMutation(result.state);
			return { content: [{ type: "text", text: `Projected ${result.tasks.length} tasks atomically. No backend work was started.` }], details: { action: "batch_create", tasks: result.tasks } as TaskToolDetails };
		},
		renderCall: (args, theme) => renderToolCall("task_ui_batch_create", `${args.tasks.length} tasks`, theme),
		renderResult: (result, _options, theme) => renderToolResult(result as never, theme),
	});

	pi.registerTool({
		name: "task_ui_list",
		label: "Task UI List",
		description: "List tasks currently shown by task-ui. This reads only the UI projection.",
		promptSnippet: "List task-ui's current presentation projection",
		executionMode: "sequential",
		parameters: Type.Object({ status: Type.Optional(StringEnum(TASK_STATUSES)) }),
		async execute(_id, params) {
			const tasks = state.tasks.filter((task) => !params.status || task.status === params.status).map((task) => ({ ...task, blockedBy: [...task.blockedBy], output: [...task.output] }));
			return { content: [{ type: "text", text: tasks.length ? tasks.map(taskSummary).join("\n") : "No projected tasks" }], details: { action: "list", tasks } as TaskToolDetails };
		},
		renderCall: (args, theme) => renderToolCall("task_ui_list", args.status, theme),
		renderResult: (result, _options, theme) => renderToolResult(result as never, theme),
	});

	pi.registerTool({
		name: "task_ui_get",
		label: "Task UI Get",
		description: "Get one task from the UI projection by task_id, or omit task_id to get all active tasks plus next and focused tasks.",
		promptSnippet: "Read a task or the active/next task-ui dashboard state",
		executionMode: "sequential",
		parameters: Type.Object({ task_id: Type.Optional(Type.String()) }),
		async execute(_id, params) {
			if (params.task_id) {
				const task = state.tasks.find((item) => item.id === params.task_id);
				if (!task) throw new Error(`Task not found: ${params.task_id}`);
				return { content: [{ type: "text", text: taskDetails(task) }], details: { action: "get", task } as TaskToolDetails };
			}
			const dashboard = getTaskDashboard(state);
			return { content: [{ type: "text", text: dashboardDetails(dashboard) }], details: { action: "get_dashboard", dashboard } as TaskToolDetails };
		},
		renderCall: (args, theme) => renderToolCall("task_ui_get", args.task_id ?? "active + next", theme),
		renderResult: (result, _options, theme) => renderToolResult(result as never, theme),
	});

	pi.registerTool({
		name: "task_ui_update",
		label: "Task UI Update",
		description: "Update task state and execution telemetry in task-ui's presentation-only projection. Backend unchanged.",
		promptSnippet: "Update a task and its telemetry in task-ui (UI only)",
		executionMode: "sequential",
		parameters: Type.Object({
			task_id: Type.String(),
			subject: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			label: Type.Optional(Type.String({ description: "Short right-aligned label, without brackets; empty string clears it" })),
			status: Type.Optional(StringEnum(TASK_STATUSES)),
			progress: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
			owner: Type.Optional(Type.String()),
			parent_id: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Set a parent task ID, or null to make this a root task" })),
			blocked_by: Type.Optional(Type.Array(Type.String())),
			executing: Type.Optional(Type.Boolean()),
			active_form: Type.Optional(Type.String()),
			started_at: Type.Optional(Type.String()),
			input_tokens: Type.Optional(Type.Number({ minimum: 0 })),
			output_tokens: Type.Optional(Type.Number({ minimum: 0 })),
		}),
		async execute(_id, params) {
			const result = updateTask(state, {
				taskId: params.task_id,
				subject: params.subject,
				description: params.description,
				label: params.label,
				status: params.status,
				progress: params.progress,
				owner: params.owner,
				parentId: params.parent_id,
				blockedBy: params.blocked_by,
				executing: params.executing,
				activeForm: params.active_form,
				startedAt: params.started_at,
				inputTokens: params.input_tokens,
				outputTokens: params.output_tokens,
			});
			persistMutation(result.state);
			return { content: [{ type: "text", text: `Updated UI projection: ${taskSummary(result.task)}. Backend unchanged.` }], details: { action: "update", task: result.task } as TaskToolDetails };
		},
		renderCall: (args, theme) => renderToolCall("task_ui_update", args.task_id, theme),
		renderResult: (result, _options, theme) => renderToolResult(result as never, theme),
	});

	pi.registerTool({
		name: "task_ui_output",
		label: "Task UI Output",
		description: "Append, read, or clear output cached in task-ui. This never reads backend process output automatically.",
		promptSnippet: "Manage displayed output in task-ui (UI only)",
		executionMode: "sequential",
		parameters: Type.Object({
			task_id: Type.String(),
			operation: StringEnum(["append", "read", "clear"] as const),
			text: Type.Optional(Type.String({ description: "Required for append" })),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
		}),
		async execute(_id, params) {
			let task = state.tasks.find((item) => item.id === params.task_id);
			if (!task) throw new Error(`Task not found: ${params.task_id}`);
			if (params.operation === "append") {
				if (!params.text) throw new Error("task_ui_output append requires text");
				const result = appendTaskOutput(state, params.task_id, params.text);
				task = result.task;
				persistMutation(result.state);
			} else if (params.operation === "clear") {
				const result = clearTaskOutput(state, params.task_id);
				task = result.task;
				persistMutation(result.state);
			}
			const output = task.output.slice(-(params.limit ?? 10));
			const text = output.length ? output.map((entry) => `${entry.timestamp} ${entry.text}`).join("\n") : "No projected output";
			return { content: [{ type: "text", text }], details: { action: `output:${params.operation}`, task } as TaskToolDetails };
		},
		renderCall: (args, theme) => renderToolCall("task_ui_output", `${args.operation} ${args.task_id}`, theme),
		renderResult: (result, _options, theme) => renderToolResult(result as never, theme),
	});

	pi.registerTool({
		name: "task_ui_remove",
		label: "Task UI Remove",
		description: "Remove one task from task-ui's presentation-only projection. Child tasks become root tasks. Backend unchanged.",
		promptSnippet: "Remove one task from task-ui (UI only)",
		executionMode: "sequential",
		parameters: Type.Object({ task_id: Type.String() }),
		async execute(_id, params) {
			persistMutation(removeTask(state, params.task_id));
			return { content: [{ type: "text", text: `Removed ${params.task_id} from the UI projection. Backend unchanged.` }], details: { action: "remove" } as TaskToolDetails };
		},
		renderCall: (args, theme) => renderToolCall("task_ui_remove", args.task_id, theme),
		renderResult: (result, _options, theme) => renderToolResult(result as never, theme),
	});

	pi.registerTool({
		name: "task_ui_clear",
		label: "Task UI Clear",
		description: "Clear every task from task-ui's presentation-only projection. Backend unchanged.",
		promptSnippet: "Clear the entire task-ui projection (UI only)",
		executionMode: "sequential",
		parameters: Type.Object({}),
		async execute() {
			const count = state.tasks.length;
			persistMutation(createInitialTaskUiState());
			return { content: [{ type: "text", text: `Cleared ${count} projected tasks. Backend unchanged.` }], details: { action: "clear", tasks: [] } as TaskToolDetails };
		},
		renderCall: (_args, theme) => renderToolCall("task_ui_clear", undefined, theme),
		renderResult: (result, _options, theme) => renderToolResult(result as never, theme),
	});

	pi.registerTool({
		name: "task_ui_stop",
		label: "Task UI Stop",
		description: "Mark a projected task stopped, retain it in history, and advance UI focus. This never stops backend work.",
		promptSnippet: "Move a task to stopped history in task-ui (UI only)",
		executionMode: "sequential",
		parameters: Type.Object({ task_id: Type.String(), reason: Type.Optional(Type.String()) }),
		async execute(_id, params) {
			let result = updateTask(state, { taskId: params.task_id, status: "stopped", executing: false });
			if (params.reason?.trim()) result = appendTaskOutput(result.state, params.task_id, `Stopped: ${params.reason.trim()}`);
			persistMutation(result.state);
			return { content: [{ type: "text", text: `Moved ${params.task_id} to stopped UI history and advanced focus. Backend unchanged.` }], details: { action: "stop", task: result.task } as TaskToolDetails };
		},
		renderCall: (args, theme) => renderToolCall("task_ui_stop", args.task_id, theme),
		renderResult: (result, _options, theme) => renderToolResult(result as never, theme),
	});

	pi.registerCommand("task-ui", {
		description: "Toggle the non-capturing task sidebar",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/task-ui requires interactive mode", "warning");
				return;
			}
			if (!overlayHandle) {
				showOverlay(ctx);
				ctx.ui.notify("Task UI shown", "info");
				return;
			}
			overlayVisible = !overlayVisible;
			overlayHandle.setHidden(!overlayVisible);
			syncAnimation();
			ctx.ui.notify(`Task UI ${overlayVisible ? "shown" : "hidden"}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		sessionActive = true;
		state = createInitialTaskUiState();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
			const restored = normalizeStoredTaskUiState(entry.data);
			if (restored) state = restored;
		}
		overlayHandle = undefined;
		requestRender = undefined;
		overlayVisible = true;
		showOverlay(ctx);
		syncAnimation();
	});

	pi.on("session_tree", async (_event, ctx) => {
		state = createInitialTaskUiState();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
			const restored = normalizeStoredTaskUiState(entry.data);
			if (restored) state = restored;
		}
		requestRender?.();
		syncAnimation();
	});

	pi.on("session_shutdown", async () => {
		sessionActive = false;
		currentCtx = undefined;
		stopAnimation();
		overlayHandle?.hide();
		overlayHandle = undefined;
		requestRender = undefined;
	});
}
