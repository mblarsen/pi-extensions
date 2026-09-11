import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type KeybindingsManager,
	type MarkdownTheme,
	type OverlayHandle,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	TASK_LIST_SCOPES,
	TASK_STATUSES,
	addInboxEntry,
	appendTaskOutput,
	clearInfoInboxEntries,
	clearTaskOutput,
	cloneTaskUiState,
	createInitialTaskUiState,
	createTask,
	createTasks,
	getInboxCounts,
	getTaskDashboard,
	getTaskDepth,
	getTaskDisplayNumber,
	listInboxEntries,
	listTasks,
	normalizeStoredTaskUiState,
	orderTasksForDisplay,
	removeTask,
	replaceExternalTasks,
	resolveInboxEntry,
	setFocusedTask,
	updateTask,
	upsertExternalTask,
	type CreateTaskInput,
	type ExternalTaskInput,
	type InboxCounts,
	type InboxEntry,
	type InboxEntryKind,
	type TaskDashboard,
	type TaskListSelector,
	type TaskRecord,
	type TaskStatus,
	type TaskUiState,
} from "./core.ts";
import { writeTaskUiMarkdown } from "./markdown.ts";

export { orderTasksForDisplay } from "./core.ts";

const STATE_ENTRY_TYPE = "task-ui-state";
const OVERLAY_MIN_TERMINAL_WIDTH = 72;
const MAX_VISIBLE_WORK_TASKS = 7;
const MAX_VISIBLE_HISTORY_TASKS = 3;
const MAX_SIDEBAR_DESCRIPTION_TASKS = 3;
const MAX_SIDEBAR_DESCRIPTION_LINES = 3;
const MAX_VISIBLE_INBOX_ENTRIES = 3;
const MAX_SIDEBAR_INBOX_PREVIEW_LINES = 2;
const MAX_BROWSER_DETAILS_RATIO = 0.4;
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

type TaskCounts = Record<TaskStatus, number> & { total: number };

type TaskToolDetails = {
	action: string;
	task?: TaskRecord;
	tasks?: TaskRecord[];
	dashboard?: TaskDashboard;
	selector?: TaskListSelector;
	counts?: TaskCounts;
	suggestedNextTask?: TaskRecord | null;
	suggestedAction?: string;
	createdIds?: string[];
	changedFields?: string[];
	newlyReady?: TaskRecord[];
	blockers?: string[];
	isBlocked?: boolean;
	outputCount?: number;
	detachedChildren?: string[];
	removedCount?: number;
	reason?: string;
	path?: string;
};

type InboxToolDetails = {
	action: "add" | "resolve" | "list" | "clear";
	entry?: InboxEntry;
	entries?: InboxEntry[];
	selector?: { kind?: InboxEntryKind };
	counts: InboxCounts;
	evictedInfoIds?: string[];
	resolvedEntry?: InboxEntry;
	nextFeedbackEntry?: InboxEntry | null;
	removedCount?: number;
	suggestedNextTask?: TaskRecord | null;
	suggestedAction?: string;
};

type SnapshotEvent = { tasks: ExternalTaskInput[]; focusedTaskId?: string };
type RemoveEvent = { taskId: string };
type OutputEvent = { taskId: string; text: string };
type FocusEvent = { taskId?: string };
type TaskUiCheckpoint = "git commit" | "link_send";
type ToolResultCheckpointInput = { toolName: string; input: unknown; isError: boolean };

const GIT_COMMIT_COMMAND = /(?:^|(?:&&|\|\||[;()\n])\s*)git(?:\s+-C\s+(?:"[^"]*"|'[^']*'|[^\s;&|()]+))?\s+commit(?=$|[\s;&|()])/;

export function checkpointForToolResult(event: ToolResultCheckpointInput): TaskUiCheckpoint | undefined {
	if (event.isError !== false) return undefined;
	if (event.toolName === "link_send") return "link_send";
	if (event.toolName !== "bash" || typeof event.input !== "object" || event.input === null) return undefined;
	const command = (event.input as { command?: unknown }).command;
	return typeof command === "string" && GIT_COMMIT_COMMAND.test(command) ? "git commit" : undefined;
}

function checkpointReminder(trigger: TaskUiCheckpoint): string {
	return `Task UI checkpoint: A successful ${trigger} just occurred.

Before continuing, reconcile task-ui with the actual work state:
- update affected task statuses, progress, and execution state;
- add newly discovered work only when it is meaningful;
- do not mark a task complete merely because this checkpoint succeeded.

If task-ui is already accurate, make no changes.

If you change task-ui, mention the update in your next natural user-facing status message. Do not interrupt, pause, or redirect the current work solely to report it; resume the ongoing work immediately.`;
}

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

function assertInboxOperationFields(params: Record<string, unknown> & { operation: "add" | "resolve" | "list" | "clear" }): void {
	const allowedByOperation = {
		add: new Set(["operation", "kind", "markdown", "task_id"]),
		resolve: new Set(["operation", "entry_id"]),
		list: new Set(["operation", "kind"]),
		clear: new Set(["operation"]),
	} as const;
	const unexpected = Object.keys(params).find((key) => params[key] !== undefined && !allowedByOperation[params.operation].has(key));
	if (unexpected) throw new Error(`task_ui_inbox ${params.operation} does not accept ${unexpected}`);
}

function taskListSelector(params: {
	scope?: (typeof TASK_LIST_SCOPES)[number];
	status?: TaskStatus;
}): TaskListSelector {
	const hasScope = params.scope !== undefined;
	const hasStatus = params.status !== undefined;
	if (hasScope === hasStatus) throw new Error("task_ui_list requires exactly one of scope or status");
	return hasScope ? { scope: params.scope! } : { status: params.status! };
}

function suggestedActionForList(selector: TaskListSelector, hasResults: boolean, projectionHasTasks: boolean): string {
	if (!hasResults) {
		return projectionHasTasks
			? 'Call task_ui_list({ scope: "all" }) to inspect tasks outside this selection.'
			: 'Call task_ui_create({ subject: "Describe the task" }) to project new work when needed.';
	}
	if ("scope" in selector && selector.scope === "ready") {
		return 'Call task_ui_update({ task_id: "<returned task id>", status: "in_progress", executing: true, active_form: "Describe current work…" }) when starting a returned task.';
	}
	if ("status" in selector && selector.status === "pending") {
		return 'Call task_ui_list({ scope: "ready" }) to exclude blocked pending tasks before starting work.';
	}
	if (("scope" in selector && selector.scope === "active") || ("status" in selector && selector.status === "in_progress")) {
		return 'Later call task_ui_update({ task_id: "<returned task id>", status: "completed", executing: false, progress: 100 }) when returned work is complete.';
	}
	return 'Call task_ui_get({ task_id: "<returned task id>" }) to inspect one returned task.';
}

function createTaskSchema() {
	return Type.Object({
		id: Type.Optional(Type.String({ description: "Backend task ID to mirror; generated when omitted" })),
		subject: Type.String({ description: "Short task title" }),
		description: Type.Optional(Type.String({ description: "Context that supplements the task title and helps users or later agent turns recall the work" })),
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

function taskCounts(tasks: TaskRecord[]): TaskCounts {
	const counts: TaskCounts = { total: tasks.length, pending: 0, in_progress: 0, completed: 0, failed: 0, stopped: 0 };
	for (const task of tasks) counts[task.status] += 1;
	return counts;
}

function unresolvedBlockers(task: TaskRecord, tasks: TaskRecord[]): string[] {
	const statusById = new Map(tasks.map((item) => [item.id, item.status]));
	return task.blockedBy.filter((id) => statusById.get(id) !== "completed");
}

function suggestedActionForTask(task: TaskRecord, tasks: TaskRecord[]): string {
	const taskId = JSON.stringify(task.id);
	if (task.status === "pending") {
		const blockers = unresolvedBlockers(task, tasks);
		if (blockers.length) {
			const knownBlocker = blockers.find((id) => tasks.some((candidate) => candidate.id === id));
			return knownBlocker
				? `Call task_ui_get({ task_id: ${JSON.stringify(knownBlocker)} }) to inspect the blocking task.`
				: 'Call task_ui_list({ scope: "all" }) to reconcile the missing blocking task.';
		}
		return `Call task_ui_update({ task_id: ${taskId}, status: "in_progress", executing: true, active_form: "Describe current work…" }) when work starts.`;
	}
	if (task.status === "in_progress") {
		return `Later call task_ui_update({ task_id: ${taskId}, status: "completed", executing: false, progress: 100 }) when the work is complete.`;
	}
	return 'Call task_ui_list({ scope: "ready" }) to find work that can start.';
}

function resultText(message: string, suggestedNextTask: TaskRecord | null | undefined, suggestedAction?: string): string {
	const lines = [message];
	if (suggestedNextTask !== undefined) {
		lines.push(`Suggested next ready task: ${suggestedNextTask ? taskSummary(suggestedNextTask) : "none"}`);
	}
	if (suggestedAction) lines.push(`Suggested action: ${suggestedAction}`);
	return lines.join("\n");
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
			case "stopped": glyph = "■"; break;
		}
	}

	const indent = showHierarchy ? "  ".repeat(getTaskDepth(task, tasks)) : "";
	const taskLabel = `#${getTaskDisplayNumber(task, tasks)} ${label}`;
	if (task.status === "completed") {
		return `${indent}${COMPLETED_ICON} ${theme.fg("dim", theme.strikethrough(taskLabel))}`;
	}
	const content = `${indent}${glyph} ${taskLabel}`;
	if (task.status === "failed") return `${indent}${theme.fg("error", "✖")} ${theme.fg("dim", taskLabel)}`;
	if (task.status === "pending") return theme.fg("muted", content);
	if (task.status === "stopped") return theme.fg("dim", content);
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

function wrapDescription(description: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	return description.split("\n").flatMap((line) => line.length ? wrapTextWithAnsi(line, safeWidth) : [""]);
}

function cropDescription(lines: string[], maxLines: number, width: number): string[] {
	if (maxLines <= 0) return [];
	const cropped = lines.slice(0, maxLines);
	if (lines.length <= maxLines) return cropped;
	const last = cropped.length - 1;
	cropped[last] = truncateToWidth(cropped[last] ?? "", Math.max(0, width - 1), "") + "…";
	return cropped;
}

function dimmedBoxRow(text: string, width: number, theme: Theme): string {
	if (width < 2) return theme.fg("dim", truncateToWidth(text, width, ""));
	return theme.fg("dim", "│") + fit(` ${theme.fg("dim", text)}`, width - 2, theme) + theme.fg("dim", "│");
}

function dimmedBoxDivider(width: number, theme: Theme): string {
	return dimmedBoxRow("─".repeat(Math.max(0, width - 4)), width, theme);
}

function markdownThemeFor(theme: Theme): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		strikethrough: (text) => theme.strikethrough(text),
		underline: (text) => theme.underline(text),
	};
}

function inboxTaskLabel(entry: InboxEntry, tasks: TaskRecord[], theme: Theme): string {
	if (!entry.taskId) return "";
	const linkedTask = tasks.find((task) => task.id === entry.taskId);
	const display = linkedTask ? getTaskDisplayNumber(linkedTask, tasks) : entry.taskId;
	return theme.fg("dim", ` #${display}`);
}

function inboxEntryRows(entry: InboxEntry, tasks: TaskRecord[], width: number, theme: Theme): string[] {
	const label = entry.kind === "feedback_needed"
		? theme.fg("warning", "Feedback needed")
		: theme.fg("accent", "Info");
	const task = inboxTaskLabel(entry, tasks, theme);
	const markdown = new Markdown(
		entry.markdown,
		0,
		0,
		markdownThemeFor(theme),
		{ color: (text) => theme.fg("dim", text) },
	);
	const preview = markdown.render(Math.max(1, width - 4)).filter((line) => visibleWidth(line) > 0);
	return [
		dimmedBoxRow(`${label}${task}`, width, theme),
		...cropDescription(preview, MAX_SIDEBAR_INBOX_PREVIEW_LINES, Math.max(1, width - 4))
			.map((line) => dimmedBoxRow(line, width, theme)),
	];
}

function renderInboxSection(entries: InboxEntry[], tasks: TaskRecord[], hiddenCount: number, width: number, theme: Theme): string[] {
	if (entries.length === 0) return [];
	const title = " Inbox ";
	const topFill = Math.max(0, width - visibleWidth(title) - 2);
	const lines = [theme.fg("borderMuted", `╭${title}${"─".repeat(topFill)}╮`)];
	for (const [index, entry] of entries.entries()) {
		if (index > 0) lines.push(dimmedBoxDivider(width, theme));
		lines.push(...inboxEntryRows(entry, tasks, width, theme));
	}
	if (hiddenCount > 0) lines.push(dimmedBoxRow(`… and ${hiddenCount} more`, width, theme));
	lines.push(theme.fg("borderMuted", `╰${"─".repeat(Math.max(0, width - 2))}╯`));
	return lines;
}

function renderDescriptionSection(descriptions: string[][], maxRows: number, width: number, theme: Theme): string[] {
	if (!descriptions.length || maxRows < 3) return [];
	const descriptionLines: string[] = [];
	let contentRows = maxRows - 2;
	for (const wrapped of descriptions) {
		const dividerRows = descriptionLines.length ? 1 : 0;
		if (contentRows <= dividerRows) break;
		const visible = cropDescription(wrapped, Math.min(MAX_SIDEBAR_DESCRIPTION_LINES, contentRows - dividerRows), Math.max(1, width - 4));
		if (!visible.length) break;
		if (dividerRows) {
			descriptionLines.push(dimmedBoxDivider(width, theme));
			contentRows -= 1;
		}
		descriptionLines.push(...visible.map((line) => dimmedBoxRow(line, width, theme)));
		contentRows -= visible.length;
	}
	if (!descriptionLines.length) return [];
	return [
		theme.fg("dim", `╭${"─".repeat(Math.max(0, width - 2))}╮`),
		...descriptionLines,
		theme.fg("dim", `╰${"─".repeat(Math.max(0, width - 2))}╯`),
	];
}

export class TaskBarComponent {
	private readonly getState: () => TaskUiState;
	private readonly getSpinnerFrame: () => string;
	private readonly theme: Theme;
	private readonly getViewportHeight: () => number;

	constructor(
		getState: () => TaskUiState,
		getSpinnerFrame: () => string,
		theme: Theme,
		getViewportHeight: () => number = () => Number.POSITIVE_INFINITY,
	) {
		this.getState = getState;
		this.getSpinnerFrame = getSpinnerFrame;
		this.theme = theme;
		this.getViewportHeight = getViewportHeight;
	}

	render(width: number): string[] {
		const state = this.getState();
		const tasks = state.tasks;
		if (!tasks.length && !state.inbox.length) return [];
		const work = orderTasksForDisplay(tasks.filter((task) => task.status === "in_progress" || task.status === "pending"));
		const visibleWork = work.slice(0, MAX_VISIBLE_WORK_TASKS);
		const history = tasks
			.filter((task) => ["completed", "failed", "stopped"].includes(task.status))
			.sort((left, right) => (right.terminalAt ?? right.updatedAt).localeCompare(left.terminalAt ?? left.updatedAt) || right.number - left.number);
		const lines: string[] = [];

		if (tasks.length > 0) {
			const topTitle = " Tasks ";
			const topFill = Math.max(0, width - visibleWidth(topTitle) - 2);
			lines.push(this.theme.fg("borderMuted", `╭${topTitle}${"─".repeat(topFill)}╮`));
			if (work.length) {
				for (const task of visibleWork) {
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
						task.status === "completed" || task.status === "failed" || task.status === "stopped",
					));
				}
			}
			lines.push(this.theme.fg("borderMuted", `╰${"─".repeat(Math.max(0, width - 2))}╯`));
		}

		const descriptions = visibleWork
			.filter((task) => task.status === "in_progress" && task.executing && task.description?.trim())
			.slice(0, MAX_SIDEBAR_DESCRIPTION_TASKS)
			.map((task) => wrapDescription(task.description!, Math.max(1, width - 4)));
		const availableRows = Math.max(0, Math.floor(this.getViewportHeight()) - lines.length);
		const orderedInbox = listInboxEntries(state);
		const selectedInbox: InboxEntry[] = [];
		const trySelectInboxEntry = (entry: InboxEntry, rowBudget: number): boolean => {
			if (selectedInbox.length >= MAX_VISIBLE_INBOX_ENTRIES) return false;
			const candidate = [...selectedInbox, entry];
			if (renderInboxSection(candidate, tasks, 0, width, this.theme).length > rowBudget) return false;
			selectedInbox.push(entry);
			return true;
		};

		for (const entry of orderedInbox.filter((item) => item.kind === "feedback_needed")) {
			if (!trySelectInboxEntry(entry, availableRows)) break;
		}
		const reservedFeedbackRows = renderInboxSection(selectedInbox, tasks, 0, width, this.theme).length;
		const descriptionLines = renderDescriptionSection(descriptions, availableRows - reservedFeedbackRows, width, this.theme);
		const inboxRowBudget = availableRows - descriptionLines.length;
		for (const entry of orderedInbox.filter((item) => item.kind === "info")) {
			if (!trySelectInboxEntry(entry, inboxRowBudget)) break;
		}

		const hiddenCount = orderedInbox.length - selectedInbox.length;
		let inboxLines = renderInboxSection(selectedInbox, tasks, hiddenCount, width, this.theme);
		if (inboxLines.length > inboxRowBudget) inboxLines = renderInboxSection(selectedInbox, tasks, 0, width, this.theme);
		lines.push(...descriptionLines, ...inboxLines);
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {}
}

export class TaskBrowserComponent {
	private activeTab: "tasks" | "inbox";
	private selectedTaskId: string | undefined;
	private selectedInboxEntryId: string | undefined;
	private scrollOffset = 0;
	private inboxScrollOffset = 0;
	private awaitingG = false;
	private detailsOpen = false;
	private descriptionScrollOffset = 0;
	private descriptionLines: string[] = [];
	private detailsCapacity = 1;
	private listCapacity = 1;
	private readonly getState: () => TaskUiState;
	private readonly getSpinnerFrame: () => string;
	private readonly getViewportHeight: () => number;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly requestRender: () => void;
	private readonly onClose: (target: "sidebar" | "off") => void;

	constructor(
		getState: () => TaskUiState,
		getSpinnerFrame: () => string,
		getViewportHeight: () => number,
		theme: Theme,
		keybindings: KeybindingsManager,
		requestRender: () => void,
		onClose: (target: "sidebar" | "off") => void,
		initialTab: "tasks" | "inbox" = "tasks",
	) {
		this.getState = getState;
		this.getSpinnerFrame = getSpinnerFrame;
		this.getViewportHeight = getViewportHeight;
		this.theme = theme;
		this.keybindings = keybindings;
		this.requestRender = requestRender;
		this.onClose = onClose;
		this.activeTab = initialTab;
		this.listCapacity = Math.max(1, Math.floor(this.getViewportHeight()) - 3);
		const state = this.getState();
		const ordered = orderTasksForDisplay(state.tasks);
		this.selectedTaskId = ordered.some((task) => task.id === state.focusedTaskId)
			? state.focusedTaskId
			: ordered[0]?.id;
		this.selectedInboxEntryId = listInboxEntries(state)[0]?.id;
	}

	getSelectedTaskId(): string | undefined {
		return this.selectedTaskId;
	}

	getSelectedInboxEntryId(): string | undefined {
		return this.selectedInboxEntryId;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "alt+u")) {
			this.onClose("off");
			return;
		}
		if (matchesKey(data, "tab")) {
			this.activeTab = this.activeTab === "tasks" ? "inbox" : "tasks";
			this.awaitingG = false;
			this.detailsOpen = false;
			this.descriptionScrollOffset = 0;
			this.requestRender();
			return;
		}
		if (this.detailsOpen) {
			if (data === "d" || this.keybindings.matches(data, "tui.select.cancel")) {
				this.detailsOpen = false;
				this.descriptionScrollOffset = 0;
				this.requestRender();
				return;
			}
			if (data === "q") {
				this.onClose("sidebar");
				return;
			}
			const halfPage = Math.max(1, Math.floor(this.detailsCapacity / 2));
			const maxOffset = Math.max(0, this.descriptionLines.length - this.detailsCapacity);
			if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
				this.descriptionScrollOffset = Math.max(0, this.descriptionScrollOffset - 1);
			} else if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
				this.descriptionScrollOffset = Math.min(maxOffset, this.descriptionScrollOffset + 1);
			} else if (matchesKey(data, "ctrl+u")) {
				this.descriptionScrollOffset = Math.max(0, this.descriptionScrollOffset - halfPage);
			} else if (matchesKey(data, "ctrl+d")) {
				this.descriptionScrollOffset = Math.min(maxOffset, this.descriptionScrollOffset + halfPage);
			} else {
				return;
			}
			this.requestRender();
			return;
		}
		if (data === "d") {
			this.awaitingG = false;
			this.detailsOpen = true;
			this.descriptionScrollOffset = 0;
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel") || data === "q") {
			this.onClose("sidebar");
			return;
		}

		if (this.activeTab === "inbox") {
			const entries = listInboxEntries(this.getState());
			if (!entries.length) return;
			const currentIndex = Math.max(0, entries.findIndex((entry) => entry.id === this.selectedInboxEntryId));
			const halfPage = Math.max(1, Math.floor(this.listCapacity / 2));
			let nextIndex = currentIndex;
			if (this.awaitingG) {
				this.awaitingG = false;
				if (data === "g") nextIndex = 0;
				else if (data === "G") nextIndex = entries.length - 1;
				else return;
			} else if (data === "g") {
				this.awaitingG = true;
				return;
			} else if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
				nextIndex = Math.max(0, currentIndex - 1);
			} else if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
				nextIndex = Math.min(entries.length - 1, currentIndex + 1);
			} else if (matchesKey(data, "ctrl+u")) {
				nextIndex = Math.max(0, currentIndex - halfPage);
			} else if (matchesKey(data, "ctrl+d")) {
				nextIndex = Math.min(entries.length - 1, currentIndex + halfPage);
			} else {
				return;
			}
			this.selectedInboxEntryId = entries[nextIndex]?.id;
			this.descriptionScrollOffset = 0;
			this.requestRender();
			return;
		}

		const tasks = orderTasksForDisplay(this.getState().tasks);
		if (!tasks.length) return;
		const currentIndex = Math.max(0, tasks.findIndex((task) => task.id === this.selectedTaskId));
		const halfPage = Math.max(1, Math.floor(this.listCapacity / 2));
		let nextIndex = currentIndex;

		if (this.awaitingG) {
			this.awaitingG = false;
			if (data === "g") nextIndex = 0;
			else if (data === "G") nextIndex = tasks.length - 1;
			else return;
		} else if (data === "g") {
			this.awaitingG = true;
			return;
		} else if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
			nextIndex = Math.max(0, currentIndex - 1);
		} else if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
			nextIndex = Math.min(tasks.length - 1, currentIndex + 1);
		} else if (matchesKey(data, "ctrl+u")) {
			nextIndex = Math.max(0, currentIndex - halfPage);
		} else if (matchesKey(data, "ctrl+d")) {
			nextIndex = Math.min(tasks.length - 1, currentIndex + halfPage);
		} else {
			return;
		}

		this.selectedTaskId = tasks[nextIndex]?.id;
		this.descriptionScrollOffset = 0;
		this.requestRender();
	}

	render(width: number): string[] {
		if (this.activeTab === "inbox") return this.renderInbox(width);
		const state = this.getState();
		const tasks = orderTasksForDisplay(state.tasks);
		let selectedIndex = tasks.findIndex((task) => task.id === this.selectedTaskId);
		if (selectedIndex < 0 && tasks.length) {
			selectedIndex = 0;
			this.selectedTaskId = tasks[0]?.id;
			this.descriptionScrollOffset = 0;
		}

		const viewportHeight = Math.max(4, Math.floor(this.getViewportHeight()));
		const showDetailsDivider = this.detailsOpen && viewportHeight >= 5;
		const showDetailsFooter = this.detailsOpen && viewportHeight >= 6;
		if (this.detailsOpen) {
			const selectedTask = selectedIndex >= 0 ? tasks[selectedIndex] : undefined;
			const description = selectedTask?.description?.trim() || "No description";
			this.descriptionLines = wrapDescription(description, Math.max(1, width - 4));
			const chromeRows = 2 + Number(showDetailsDivider) + Number(showDetailsFooter);
			const availableContentRows = Math.max(2, viewportHeight - chromeRows);
			this.detailsCapacity = Math.max(1, Math.min(
				this.descriptionLines.length,
				Math.max(1, Math.floor(viewportHeight * MAX_BROWSER_DETAILS_RATIO)),
				availableContentRows - 1,
			));
			this.listCapacity = Math.max(1, availableContentRows - this.detailsCapacity);
		} else {
			this.descriptionLines = [];
			this.detailsCapacity = 1;
			this.listCapacity = Math.max(1, viewportHeight - 3);
		}

		if (selectedIndex < this.scrollOffset) this.scrollOffset = selectedIndex;
		if (selectedIndex >= this.scrollOffset + this.listCapacity) this.scrollOffset = selectedIndex - this.listCapacity + 1;
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, tasks.length - this.listCapacity)));
		this.descriptionScrollOffset = Math.max(
			0,
			Math.min(this.descriptionScrollOffset, Math.max(0, this.descriptionLines.length - this.detailsCapacity)),
		);

		const position = selectedIndex >= 0 ? `${selectedIndex + 1}/${tasks.length}` : "0/0";
		const title = ` ${this.theme.fg("accent", "[ Tasks ]")} ${this.theme.fg("dim", `[ Inbox · ${state.inbox.length} ]`)} · ${position} `;
		const topFill = Math.max(0, width - visibleWidth(title) - 2);
		const lines = [this.theme.fg("borderAccent", `╭${title}${"─".repeat(topFill)}╮`)];

		if (!tasks.length) {
			lines.push(framedRow(this.theme.fg("muted", "No projected tasks"), width, this.theme));
		} else {
			for (const [visibleIndex, task] of tasks.slice(this.scrollOffset, this.scrollOffset + this.listCapacity).entries()) {
				const taskIndex = this.scrollOffset + visibleIndex;
				const selected = taskIndex === selectedIndex;
				const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
				lines.push(framedTaskRow(
					prefix + taskLine(task, state.tasks, selected, this.getSpinnerFrame(), this.theme),
					task.label,
					width,
					this.theme,
					task.status === "completed" || task.status === "failed" || task.status === "stopped",
				));
			}
		}

		if (this.detailsOpen) {
			const rangeStart = this.descriptionScrollOffset + 1;
			const rangeEnd = Math.min(this.descriptionLines.length, this.descriptionScrollOffset + this.detailsCapacity);
			if (showDetailsDivider) lines.push(divider(`details · ${rangeStart}–${rangeEnd}/${this.descriptionLines.length}`, width, this.theme));
			for (const line of this.descriptionLines.slice(this.descriptionScrollOffset, this.descriptionScrollOffset + this.detailsCapacity)) {
				lines.push(framedRow(this.theme.fg("dim", line), width, this.theme));
			}
			if (showDetailsFooter) {
				lines.push(framedRow(
					this.theme.fg("dim", "d/Esc close · ↑↓/jk scroll · Ctrl-U/D half-page · q sidebar · Alt-U off"),
					width,
					this.theme,
				));
			}
		} else {
			lines.push(framedRow(
				this.theme.fg("dim", "Tab switch · ↑↓/jk move · Ctrl-U/D half-page · gg/gG jump · d details · Esc/q sidebar · Alt-U off"),
				width,
				this.theme,
			));
		}
		lines.push(this.theme.fg("borderAccent", `╰${"─".repeat(Math.max(0, width - 2))}╯`));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private renderInbox(width: number): string[] {
		const state = this.getState();
		const entries = listInboxEntries(state);
		let selectedIndex = entries.findIndex((entry) => entry.id === this.selectedInboxEntryId);
		if (selectedIndex < 0 && entries.length) {
			selectedIndex = 0;
			this.selectedInboxEntryId = entries[0]?.id;
			this.descriptionScrollOffset = 0;
		}
		const viewportHeight = Math.max(4, Math.floor(this.getViewportHeight()));
		const showDetailsDivider = this.detailsOpen && viewportHeight >= 5;
		const showDetailsFooter = this.detailsOpen && viewportHeight >= 6;
		if (this.detailsOpen) {
			const selectedEntry = selectedIndex >= 0 ? entries[selectedIndex] : undefined;
			this.descriptionLines = new Markdown(
				selectedEntry?.markdown ?? "No Inbox entry",
				0,
				0,
				markdownThemeFor(this.theme),
			).render(Math.max(1, width - 4));
			const chromeRows = 2 + Number(showDetailsDivider) + Number(showDetailsFooter);
			const availableContentRows = Math.max(2, viewportHeight - chromeRows);
			this.detailsCapacity = Math.max(1, Math.min(
				this.descriptionLines.length,
				Math.max(1, Math.floor(viewportHeight * MAX_BROWSER_DETAILS_RATIO)),
				availableContentRows - 1,
			));
			this.listCapacity = Math.max(1, availableContentRows - this.detailsCapacity);
		} else {
			this.descriptionLines = [];
			this.detailsCapacity = 1;
			this.listCapacity = Math.max(1, viewportHeight - 3);
		}

		if (selectedIndex < this.inboxScrollOffset) this.inboxScrollOffset = selectedIndex;
		if (selectedIndex >= this.inboxScrollOffset + this.listCapacity) this.inboxScrollOffset = selectedIndex - this.listCapacity + 1;
		this.inboxScrollOffset = Math.max(0, Math.min(this.inboxScrollOffset, Math.max(0, entries.length - this.listCapacity)));
		this.descriptionScrollOffset = Math.max(
			0,
			Math.min(this.descriptionScrollOffset, Math.max(0, this.descriptionLines.length - this.detailsCapacity)),
		);

		const position = selectedIndex >= 0 ? `${selectedIndex + 1}/${entries.length}` : "0/0";
		const title = ` ${this.theme.fg("dim", "[ Tasks ]")} ${this.theme.fg("accent", `[ Inbox · ${entries.length} ]`)} · ${position} `;
		const topFill = Math.max(0, width - visibleWidth(title) - 2);
		const lines = [this.theme.fg("borderAccent", `╭${title}${"─".repeat(topFill)}╮`)];
		if (!entries.length) {
			lines.push(framedRow(this.theme.fg("muted", "No Inbox entries"), width, this.theme));
		} else {
			for (const [visibleIndex, entry] of entries.slice(this.inboxScrollOffset, this.inboxScrollOffset + this.listCapacity).entries()) {
				const entryIndex = this.inboxScrollOffset + visibleIndex;
				const selected = entryIndex === selectedIndex;
				const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
				const label = entry.kind === "feedback_needed"
					? this.theme.fg("warning", "Feedback needed")
					: this.theme.fg("accent", "Info");
				const task = inboxTaskLabel(entry, state.tasks, this.theme);
				const preview = new Markdown(entry.markdown, 0, 0, markdownThemeFor(this.theme))
					.render(Math.max(1, width - visibleWidth(prefix + label + task) - 5))
					.find((line) => visibleWidth(line) > 0) ?? "";
				lines.push(framedRow(`${prefix}${label}${task} ${preview}`, width, this.theme));
			}
		}
		if (this.detailsOpen) {
			const rangeStart = this.descriptionScrollOffset + 1;
			const rangeEnd = Math.min(this.descriptionLines.length, this.descriptionScrollOffset + this.detailsCapacity);
			if (showDetailsDivider) lines.push(divider(`details · ${rangeStart}–${rangeEnd}/${this.descriptionLines.length}`, width, this.theme));
			for (const line of this.descriptionLines.slice(this.descriptionScrollOffset, this.descriptionScrollOffset + this.detailsCapacity)) {
				lines.push(framedRow(line, width, this.theme));
			}
			if (showDetailsFooter) {
				lines.push(framedRow(
					this.theme.fg("dim", "d/Esc close · ↑↓/jk scroll · Ctrl-U/D half-page · q sidebar · Alt-U off"),
					width,
					this.theme,
				));
			}
		} else {
			lines.push(framedRow(
				this.theme.fg("dim", "Tab switch · ↑↓/jk move · Ctrl-U/D half-page · gg/gG jump · d details · Esc/q sidebar · Alt-U off"),
				width,
				this.theme,
			));
		}
		lines.push(this.theme.fg("borderAccent", `╰${"─".repeat(Math.max(0, width - 2))}╯`));
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
	if (details?.action === "to_md") {
		return new Text(theme.fg("muted", `Exported ${details.tasks?.length ?? 0} projected task(s) to ${details.path}`), 0, 0);
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
	let browseRequestRender: (() => void) | undefined;
	let browseOpen = false;
	let closeBrowser: ((target: "sidebar" | "off") => void) | undefined;
	let sessionActive = false;
	let spinnerFrame = 0;
	let animationTimer: ReturnType<typeof setInterval> | undefined;
	let checkpointReminderQueued = false;

	const stopAnimation = () => {
		if (animationTimer) clearInterval(animationTimer);
		animationTimer = undefined;
		spinnerFrame = 0;
	};

	const requestAllRenders = () => {
		requestRender?.();
		browseRequestRender?.();
	};

	const syncAnimation = () => {
		const shouldAnimate = sessionActive && (overlayVisible || browseOpen) && state.tasks.some((task) => task.executing);
		if (!shouldAnimate) {
			stopAnimation();
			return;
		}
		if (animationTimer) return;
		animationTimer = setInterval(() => {
			spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
			requestAllRenders();
		}, 500);
	};

	const publishState = () => {
		if (sessionActive) pi.appendEntry(STATE_ENTRY_TYPE, cloneTaskUiState(state));
		requestAllRenders();
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
			return new TaskBarComponent(
				() => state,
				() => SPINNER_FRAMES[spinnerFrame],
				theme,
				() => Math.max(0, Math.floor(tui.terminal.rows * 0.76)),
			);
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

	const showBrowser = async (ctx: ExtensionContext, initialTab: "tasks" | "inbox" = "tasks") => {
		if (browseOpen) return;
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Task browser requires interactive mode", "warning");
			return;
		}
		if (!state.tasks.length && !state.inbox.length) {
			ctx.ui.notify("No projected tasks or Inbox entries to browse", "info");
			return;
		}

		let restoreSidebar = overlayVisible;
		overlayHandle?.setHidden(true);
		browseOpen = true;
		syncAnimation();
		try {
			const target = await ctx.ui.custom<"sidebar" | "off">((tui, theme, keybindings, done) => {
				closeBrowser = done;
				browseRequestRender = () => tui.requestRender();
				return new TaskBrowserComponent(
					() => state,
					() => SPINNER_FRAMES[spinnerFrame],
					() => Math.max(4, Math.floor(tui.terminal.rows * 0.9)),
					theme,
					keybindings,
					() => tui.requestRender(),
					done,
					initialTab,
				);
			}, {
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "92%",
					maxHeight: "90%",
					margin: 1,
				},
			});
			restoreSidebar = target !== "off";
		} finally {
			browseOpen = false;
			closeBrowser = undefined;
			browseRequestRender = undefined;
			overlayVisible = restoreSidebar;
			if (restoreSidebar) showOverlay(ctx);
			else overlayHandle?.setHidden(true);
			requestRender?.();
			syncAnimation();
		}
	};

	const hideTaskUi = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Task UI requires interactive mode", "warning");
			return;
		}
		if (browseOpen) {
			closeBrowser?.("off");
			return;
		}
		overlayVisible = false;
		overlayHandle?.setHidden(true);
		syncAnimation();
	};

	const showSidebar = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Task UI requires interactive mode", "warning");
			return;
		}
		if (browseOpen) {
			closeBrowser?.("sidebar");
			return;
		}
		showOverlay(ctx);
	};

	const cycleTaskUi = async (ctx: ExtensionContext) => {
		if (browseOpen) {
			hideTaskUi(ctx);
		} else if (!overlayVisible) {
			showSidebar(ctx);
		} else {
			await showBrowser(ctx);
		}
	};

	const persistMutation = (next: TaskUiState): TaskUiState => {
		setState(next);
		return next;
	};

	pi.events.on(TASK_UI_EVENTS.snapshot, (payload) => {
		try {
			const event = payload as SnapshotEvent;
			if (!Array.isArray(event.tasks)) throw new Error("task-ui:snapshot requires tasks[]");
			const taskState = replaceExternalTasks(event.tasks, event.focusedTaskId);
			setState({ ...taskState, inbox: state.inbox.map((entry) => ({ ...entry })), nextInboxId: state.nextInboxId });
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
			const suggestedNextTask = getTaskDashboard(result.state).next ?? null;
			const suggestedAction = suggestedActionForTask(result.task, result.state.tasks);
			persistMutation(result.state);
			return {
				content: [{ type: "text", text: resultText(`Projected ${taskSummary(result.task)}. No backend work was started.`, suggestedNextTask, suggestedAction) }],
				details: { action: "create", task: result.task, suggestedNextTask, suggestedAction } as TaskToolDetails,
			};
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
			const suggestedNextTask = getTaskDashboard(result.state).next ?? null;
			const suggestedAction = 'Call task_ui_list({ scope: "ready" }) to find work that can start.';
			persistMutation(result.state);
			return {
				content: [{ type: "text", text: resultText(`Projected ${result.tasks.length} tasks atomically. No backend work was started.`, suggestedNextTask, suggestedAction) }],
				details: {
					action: "batch_create",
					tasks: result.tasks,
					createdIds: result.tasks.map((task) => task.id),
					suggestedNextTask,
					suggestedAction,
				} as TaskToolDetails,
			};
		},
		renderCall: (args, theme) => renderToolCall("task_ui_batch_create", `${args.tasks.length} tasks`, theme),
		renderResult: (result, _options, theme) => renderToolResult(result as never, theme),
	});

	pi.registerTool({
		name: "task_ui_list",
		label: "Task UI List",
		description: "List tasks in the UI projection. Provide exactly one selector: scope for workflow-oriented groups, or status for one exact stored state.",
		promptSnippet: "List task-ui by required workflow scope or exact status",
		executionMode: "sequential",
		parameters: Type.Object({
			scope: Type.Optional(StringEnum(TASK_LIST_SCOPES, { description: "Recommended workflow view: all, open, ready, active, or history" })),
			status: Type.Optional(StringEnum(TASK_STATUSES, { description: "One exact stored task state; use instead of scope when only that state is needed" })),
		}, {
			description: "Provide exactly one of scope or status. Both and neither are invalid.",
			additionalProperties: false,
			minProperties: 1,
			maxProperties: 1,
		}),
		async execute(_id, params) {
			const selector = taskListSelector(params);
			const tasks = listTasks(state, selector);
			const suggestedNextTask = getTaskDashboard(state).next ?? null;
			const suggestedAction = suggestedActionForList(selector, tasks.length > 0, state.tasks.length > 0);
			const text = tasks.length ? tasks.map(taskSummary).join("\n") : "No projected tasks matched the selector";
			return {
				content: [{ type: "text", text: resultText(text, suggestedNextTask, suggestedAction) }],
				details: { action: "list", tasks, selector, counts: taskCounts(state.tasks), suggestedNextTask, suggestedAction } as TaskToolDetails,
			};
		},
		renderCall: (args, theme) => renderToolCall("task_ui_list", args.scope ?? args.status, theme),
		renderResult: (result, _options, theme) => renderToolResult(result as never, theme),
	});

	pi.registerTool({
		name: "task_ui_to_md",
		label: "Task UI to Markdown",
		description: "Write the complete task-ui projection to a Markdown file. This does not modify state.",
		promptSnippet: "Write the complete task-ui projection to a Markdown file",
		executionMode: "sequential",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Output path; defaults to a unique file in the system temporary directory" })),
			overwrite: Type.Optional(Type.Boolean({ description: "Replace an existing file after the user confirms" })),
		}, { additionalProperties: false }),
		async execute(_id, params) {
			const tasks = orderTasksForDisplay(listTasks(state, { scope: "all" }));
			const path = await writeTaskUiMarkdown(state, { path: params.path, overwrite: params.overwrite });
			return {
				content: [{ type: "text", text: path }],
				details: { action: "to_md", path, tasks, counts: taskCounts(state.tasks) } as TaskToolDetails,
			};
		},
		renderCall: (_args, theme) => renderToolCall("task_ui_to_md", undefined, theme),
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
				const blockers = unresolvedBlockers(task, state.tasks);
				const suggestedAction = suggestedActionForTask(task, state.tasks);
				return {
					content: [{ type: "text", text: resultText(taskDetails(task), undefined, suggestedAction) }],
					details: { action: "get", task, blockers, isBlocked: blockers.length > 0, suggestedAction } as TaskToolDetails,
				};
			}
			const dashboard = getTaskDashboard(state);
			const suggestedAction = dashboard.active[0]
				? suggestedActionForTask(dashboard.active[0], state.tasks)
				: dashboard.next
					? suggestedActionForTask(dashboard.next, state.tasks)
					: 'Call task_ui_create({ subject: "Describe the task" }) to project new work when needed.';
			return {
				content: [{ type: "text", text: resultText(dashboardDetails(dashboard), undefined, suggestedAction) }],
				details: { action: "get_dashboard", dashboard, suggestedAction } as TaskToolDetails,
			};
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
			description: Type.Optional(Type.String({ description: "Context that supplements the task title and helps users or later agent turns recall the work" })),
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
			const readyBefore = new Set(listTasks(state, { scope: "ready" }).map((task) => task.id));
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
			const newlyReady = listTasks(result.state, { scope: "ready" }).filter((task) => !readyBefore.has(task.id));
			const changedFields = Object.entries(params)
				.filter(([key, value]) => key !== "task_id" && value !== undefined)
				.map(([key]) => key);
			const reachedTerminal = params.status === "completed" || params.status === "failed" || params.status === "stopped";
			const suggestedNextTask = reachedTerminal ? getTaskDashboard(result.state).next ?? null : undefined;
			const suggestedAction = suggestedActionForTask(result.task, result.state.tasks);
			persistMutation(result.state);
			return {
				content: [{ type: "text", text: resultText(`Updated UI projection: ${taskSummary(result.task)}. Backend unchanged.`, suggestedNextTask, suggestedAction) }],
				details: { action: "update", task: result.task, changedFields, newlyReady, suggestedNextTask, suggestedAction } as TaskToolDetails,
			};
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
			const suggestedAction = params.operation === "append"
				? `Call task_ui_output({ task_id: ${JSON.stringify(task.id)}, operation: "read" }) to inspect projected output.`
				: undefined;
			return {
				content: [{ type: "text", text: resultText(text, undefined, suggestedAction) }],
				details: { action: `output:${params.operation}`, task, outputCount: task.output.length, suggestedAction } as TaskToolDetails,
			};
		},
		renderCall: (args, theme) => renderToolCall("task_ui_output", `${args.operation} ${args.task_id}`, theme),
		renderResult: (result, _options, theme) => renderToolResult(result as never, theme),
	});

	pi.registerTool({
		name: "task_ui_inbox",
		label: "Task UI Inbox",
		description: "Manage task-ui's presentation-only Inbox for important items that the user must notice or answer later. The Inbox is a one-way agent-to-user attention queue, not an agent-to-agent channel or shared memory. Never add the user's own statements, context, selections, approvals, or decisions. Never add internal coordination, acknowledgments, routine progress, or completion summaries. Send the complete normal response as usual; an applicable Inbox entry only supplements it.",
		promptSnippet: "User-only attention queue. Never use it for agent messaging or to repeat user-provided information or decisions",
		executionMode: "sequential",
		parameters: Type.Object({
			operation: StringEnum(["add", "resolve", "list", "clear"] as const),
			kind: Type.Optional(StringEnum(["info", "feedback_needed"] as const)),
			markdown: Type.Optional(Type.String({ maxLength: 400 })),
			task_id: Type.Optional(Type.String()),
			entry_id: Type.Optional(Type.String()),
		}, { additionalProperties: false }),
		async execute(_id, params) {
			assertInboxOperationFields(params);
			if (params.operation === "add") {
				if (!params.kind) throw new Error("task_ui_inbox add requires kind");
				if (!params.markdown) throw new Error("task_ui_inbox add requires markdown");
				const result = addInboxEntry(state, {
					kind: params.kind,
					markdown: params.markdown,
					taskId: params.task_id,
				});
				const suggestedNextTask = getTaskDashboard(result.state).next ?? null;
				const baseSuggestion = "The Inbox entry supplements the normal user-facing response. Include the full response as usual and continue the planned work.";
				const suggestedAction = result.entry.kind === "feedback_needed"
					? `${baseSuggestion} Call task_ui_inbox({ operation: "resolve", entry_id: ${JSON.stringify(result.entry.id)} }) after the user answers.`
					: baseSuggestion;
				persistMutation(result.state);
				return {
					content: [{ type: "text", text: resultText(`Added ${result.entry.id} to the task-ui Inbox.`, suggestedNextTask, suggestedAction) }],
					details: {
						action: "add",
						entry: result.entry,
						counts: getInboxCounts(result.state),
						evictedInfoIds: result.evictedInfoIds,
						suggestedNextTask,
						suggestedAction,
					} as InboxToolDetails,
				};
			}
			if (params.operation === "list") {
				const selector = params.kind ? { kind: params.kind } : {};
				const entries = listInboxEntries(state, selector);
				const counts = getInboxCounts(state);
				const suggestedNextTask = getTaskDashboard(state).next ?? null;
				const suggestedAction = counts.feedbackNeeded >= 18
					? "The feedback Inbox is near its limit. Resolve obsolete or duplicate entries, preserve requests that still need a user response, and prioritize the remainder."
					: counts.feedbackNeeded > 0
						? "Prioritize unresolved feedback and resolve each entry after the user answers."
						: "No unresolved feedback remains. Continue the planned work.";
				const text = entries.length
					? entries.map((entry) => `${entry.id} [${entry.kind}]${entry.taskId ? ` #${entry.taskId}` : ""} ${entry.markdown}`).join("\n")
					: "No Inbox entries matched the selector.";
				return {
					content: [{ type: "text", text: resultText(text, suggestedNextTask, suggestedAction) }],
					details: { action: "list", entries, selector, counts, suggestedNextTask, suggestedAction } as InboxToolDetails,
				};
			}
			if (params.operation === "resolve") {
				if (!params.entry_id) throw new Error("task_ui_inbox resolve requires entry_id");
				const result = resolveInboxEntry(state, params.entry_id);
				const nextFeedbackEntry = listInboxEntries(result.state, { kind: "feedback_needed" })[0] ?? null;
				const counts = getInboxCounts(result.state);
				const suggestedNextTask = getTaskDashboard(result.state).next ?? null;
				const suggestedAction = nextFeedbackEntry
					? `Review the next unresolved feedback entry: ${nextFeedbackEntry.id}.`
					: "No unresolved feedback remains. Continue the planned work.";
				persistMutation(result.state);
				return {
					content: [{ type: "text", text: resultText(`Resolved and removed ${result.resolvedEntry.id} from the task-ui Inbox.`, suggestedNextTask, suggestedAction) }],
					details: {
						action: "resolve",
						resolvedEntry: result.resolvedEntry,
						nextFeedbackEntry,
						counts,
						suggestedNextTask,
						suggestedAction,
					} as InboxToolDetails,
				};
			}
			const result = clearInfoInboxEntries(state);
			const counts = getInboxCounts(result.state);
			const suggestedNextTask = getTaskDashboard(result.state).next ?? null;
			const suggestedAction = counts.feedbackNeeded > 0
				? `${counts.feedbackNeeded} unresolved feedback entr${counts.feedbackNeeded === 1 ? "y" : "ies"} remains; resolve each only after the user answers or it becomes obsolete.`
				: "No unresolved feedback remains. Continue the planned work.";
			persistMutation(result.state);
			return {
				content: [{ type: "text", text: resultText(`Cleared ${result.removedCount} informational Inbox entr${result.removedCount === 1 ? "y" : "ies"}.`, suggestedNextTask, suggestedAction) }],
				details: { action: "clear", removedCount: result.removedCount, counts, suggestedNextTask, suggestedAction } as InboxToolDetails,
			};
		},
		renderCall: (args, theme) => renderToolCall("task_ui_inbox", args.operation, theme),
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
			const detachedChildren = state.tasks.filter((task) => task.parentId === params.task_id).map((task) => task.id);
			const nextState = removeTask(state, params.task_id);
			const suggestedNextTask = getTaskDashboard(nextState).next ?? null;
			const suggestedAction = 'Call task_ui_list({ scope: "all" }) to inspect the remaining projection.';
			persistMutation(nextState);
			return {
				content: [{ type: "text", text: resultText(`Removed ${params.task_id} from the UI projection. Backend unchanged.`, suggestedNextTask, suggestedAction) }],
				details: { action: "remove", detachedChildren, suggestedNextTask, suggestedAction } as TaskToolDetails,
			};
		},
		renderCall: (args, theme) => renderToolCall("task_ui_remove", args.task_id, theme),
		renderResult: (result, _options, theme) => renderToolResult(result as never, theme),
	});

	pi.registerTool({
		name: "task_ui_clear",
		label: "Task UI Clear",
		description: "Clear every task from task-ui's presentation-only projection. Backend unchanged.",
		promptSnippet: "Clear all projected tasks in task-ui (UI only)",
		executionMode: "sequential",
		parameters: Type.Object({}),
		async execute() {
			const removedCount = state.tasks.length;
			const suggestedAction = 'Call task_ui_batch_create({ tasks: [{ subject: "Describe the task" }] }) to rebuild the projection when needed.';
			const clearedTasks = createInitialTaskUiState();
			persistMutation({ ...clearedTasks, inbox: state.inbox.map((entry) => ({ ...entry })), nextInboxId: state.nextInboxId });
			return {
				content: [{ type: "text", text: resultText(`Cleared ${removedCount} projected tasks. Backend unchanged.`, null, suggestedAction) }],
				details: { action: "clear", tasks: [], removedCount, suggestedNextTask: null, suggestedAction } as TaskToolDetails,
			};
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
			const reason = params.reason?.trim();
			if (reason) result = appendTaskOutput(result.state, params.task_id, `Stopped: ${reason}`);
			const suggestedNextTask = getTaskDashboard(result.state).next ?? null;
			const suggestedAction = 'Call task_ui_list({ scope: "ready" }) to find work that can start.';
			persistMutation(result.state);
			return {
				content: [{ type: "text", text: resultText(`Moved ${params.task_id} to stopped UI history and advanced focus. Backend unchanged.`, suggestedNextTask, suggestedAction) }],
				details: { action: "stop", task: result.task, reason, suggestedNextTask, suggestedAction } as TaskToolDetails,
			};
		},
		renderCall: (args, theme) => renderToolCall("task_ui_stop", args.task_id, theme),
		renderResult: (result, _options, theme) => renderToolResult(result as never, theme),
	});

	pi.registerShortcut("alt+u", {
		description: "Cycle tasks: sidebar, browse, off",
		handler: async (ctx) => cycleTaskUi(ctx),
	});

	pi.registerShortcut("alt+shift+u", {
		description: "Open the read-only task browser",
		handler: async (ctx) => showBrowser(ctx),
	});

	pi.registerCommand("task-ui", {
		description: "Show, hide, browse, or cycle the task UI",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "browse", label: "browse", description: "Open the full task browser" },
				{ value: "inbox", label: "inbox", description: "Open the task browser on Inbox" },
				{ value: "sidebar", label: "sidebar", description: "Show the task sidebar" },
				{ value: "hide", label: "hide", description: "Hide the task UI" },
				{ value: "cycle", label: "cycle", description: "Cycle sidebar, browse, off" },
			].filter((item) => item.value.startsWith(prefix.trim().toLowerCase()));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (!action || action === "cycle") {
				await cycleTaskUi(ctx);
				return;
			}
			if (action === "browse") {
				await showBrowser(ctx);
				return;
			}
			if (action === "inbox") {
				await showBrowser(ctx, "inbox");
				return;
			}
			if (action === "sidebar") {
				showSidebar(ctx);
				return;
			}
			if (action === "hide") {
				hideTaskUi(ctx);
				return;
			}
			ctx.ui.notify("Usage: /task-ui [browse|inbox|sidebar|hide|cycle]", "warning");
		},
	});

	pi.on("tool_result", async (event, ctx) => {
		const checkpoint = checkpointForToolResult(event);
		const hasUnfinishedTasks = state.tasks.some((task) => task.status === "pending" || task.status === "in_progress");
		if (!checkpoint || !hasUnfinishedTasks || checkpointReminderQueued) return;

		checkpointReminderQueued = true;
		try {
			pi.sendMessage({
				customType: "task-ui-checkpoint-reminder",
				content: checkpointReminder(checkpoint),
				display: false,
				details: { checkpoint, timestamp: Date.now() },
			}, { deliverAs: "steer" });
		} catch (error) {
			checkpointReminderQueued = false;
			if (ctx.hasUI) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Task UI checkpoint reminder failed: ${message}`, "warning");
			}
		}
	});

	pi.on("turn_start", async () => {
		checkpointReminderQueued = false;
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		sessionActive = true;
		checkpointReminderQueued = false;
		state = createInitialTaskUiState();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
			const restored = normalizeStoredTaskUiState(entry.data);
			if (restored) state = restored;
		}
		overlayHandle = undefined;
		requestRender = undefined;
		browseRequestRender = undefined;
		browseOpen = false;
		overlayVisible = true;
		showOverlay(ctx);
		syncAnimation();
	});

	pi.on("session_tree", async (_event, ctx) => {
		checkpointReminderQueued = false;
		state = createInitialTaskUiState();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
			const restored = normalizeStoredTaskUiState(entry.data);
			if (restored) state = restored;
		}
		requestAllRenders();
		syncAnimation();
	});

	pi.on("session_shutdown", async () => {
		sessionActive = false;
		checkpointReminderQueued = false;
		currentCtx = undefined;
		stopAnimation();
		overlayHandle?.hide();
		overlayHandle = undefined;
		requestRender = undefined;
		browseRequestRender = undefined;
		browseOpen = false;
	});
}
