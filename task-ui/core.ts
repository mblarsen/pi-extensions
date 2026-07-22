export const TASK_UI_STATE_VERSION = 5 as const;

export const TASK_STATUSES = ["pending", "in_progress", "completed", "failed", "stopped"] as const;
export const MAX_TASK_OUTPUT_CHARS = 2_000;
export const MAX_TASK_OUTPUT_ENTRIES = 100;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskOutputEntry {
	text: string;
	timestamp: string;
}

export interface TaskRecord {
	id: string;
	number: number;
	subject: string;
	description?: string;
	label?: string;
	status: TaskStatus;
	progress?: number;
	owner?: string;
	parentId?: string;
	subtaskNumber?: number;
	blockedBy: string[];
	executing: boolean;
	activeForm?: string;
	startedAt?: string;
	inputTokens?: number;
	outputTokens?: number;
	createdAt: string;
	updatedAt: string;
	terminalAt?: string;
	output: TaskOutputEntry[];
}

export interface TaskUiState {
	version: typeof TASK_UI_STATE_VERSION;
	tasks: TaskRecord[];
	focusedTaskId?: string;
	nextId: number;
	nextNumber: number;
}

export interface CreateTaskInput {
	id?: string;
	number?: number;
	subject: string;
	description?: string;
	label?: string;
	status?: TaskStatus;
	progress?: number;
	owner?: string;
	parentId?: string;
	subtaskNumber?: number;
	blockedBy?: string[];
	executing?: boolean;
	activeForm?: string;
	startedAt?: string;
	inputTokens?: number;
	outputTokens?: number;
}

export interface UpdateTaskInput {
	taskId: string;
	subject?: string;
	description?: string;
	label?: string;
	status?: TaskStatus;
	progress?: number;
	owner?: string;
	parentId?: string | null;
	blockedBy?: string[];
	executing?: boolean;
	activeForm?: string;
	startedAt?: string;
	inputTokens?: number;
	outputTokens?: number;
}

export interface ExternalTaskInput {
	id: string;
	number?: number;
	subject?: string;
	title?: string;
	name?: string;
	description?: string;
	label?: string;
	status?: string;
	progress?: number;
	owner?: string;
	parentId?: string | null;
	subtaskNumber?: number;
	blockedBy?: string[];
	executing?: boolean;
	activeForm?: string;
	startedAt?: string;
	inputTokens?: number;
	outputTokens?: number;
	createdAt?: string;
	updatedAt?: string;
	terminalAt?: string;
	output?: Array<TaskOutputEntry | string>;
}

export interface TaskDashboard {
	active: TaskRecord[];
	next?: TaskRecord;
	focused?: TaskRecord;
}

export function createInitialTaskUiState(): TaskUiState {
	return { version: TASK_UI_STATE_VERSION, tasks: [], nextId: 1, nextNumber: 1 };
}

function clampProgress(progress: number | undefined): number | undefined {
	if (progress === undefined || !Number.isFinite(progress)) return undefined;
	return Math.max(0, Math.min(100, Math.round(progress)));
}

function clampTokens(tokens: number | undefined): number | undefined {
	if (tokens === undefined || !Number.isFinite(tokens)) return undefined;
	return Math.max(0, Math.round(tokens));
}

function cleanOptional(value: string | undefined): string | undefined {
	const cleaned = value?.trim();
	return cleaned ? cleaned : undefined;
}

function cleanBlockers(blockedBy: string[] | undefined): string[] {
	if (!blockedBy) return [];
	return [...new Set(blockedBy.map((id) => id.trim()).filter(Boolean))];
}

function normalizeOutput(entries: Array<TaskOutputEntry | string>, fallbackTimestamp: string): TaskOutputEntry[] {
	return entries.slice(-MAX_TASK_OUTPUT_ENTRIES).map((entry) => {
		const text = typeof entry === "string" ? entry : entry.text;
		const trimmed = text.trim();
		const displayText = trimmed.length > MAX_TASK_OUTPUT_CHARS ? `${trimmed.slice(0, MAX_TASK_OUTPUT_CHARS - 1)}…` : trimmed;
		return { text: displayText, timestamp: typeof entry === "string" ? fallbackTimestamp : entry.timestamp };
	});
}

function cloneTask(task: TaskRecord): TaskRecord {
	return {
		...task,
		blockedBy: [...task.blockedBy],
		output: task.output.map((entry) => ({ ...entry })),
	};
}

export function cloneTaskUiState(state: TaskUiState): TaskUiState {
	return { ...state, tasks: state.tasks.map(cloneTask) };
}

export function normalizeTaskStatus(status: string | undefined): TaskStatus {
	switch (status?.toLowerCase()) {
		case "working":
		case "running":
		case "active":
		case "current":
		case "in-progress":
		case "in_progress":
			return "in_progress";
		case "done":
		case "success":
		case "succeeded":
		case "complete":
		case "completed":
			return "completed";
		case "error":
		case "errored":
		case "failure":
		case "failed":
			return "failed";
		case "cancelled":
		case "canceled":
		case "stopped":
			return "stopped";
		default:
			return "pending";
	}
}

function isTerminal(status: TaskStatus): boolean {
	return status === "completed" || status === "failed" || status === "stopped";
}

function chooseFocus(tasks: TaskRecord[], current?: string): string | undefined {
	if (current && tasks.some((task) => task.id === current && !isTerminal(task.status))) return current;
	return tasks.find((task) => task.executing)?.id
		?? tasks.find((task) => task.status === "in_progress")?.id
		?? getNextTask(tasks)?.id;
}

function nextGeneratedId(state: TaskUiState): { id: string; nextId: number } {
	let sequence = state.nextId;
	let id = `task-${sequence}`;
	const existing = new Set(state.tasks.map((task) => task.id));
	while (existing.has(id)) {
		sequence += 1;
		id = `task-${sequence}`;
	}
	return { id, nextId: sequence + 1 };
}

function nextTaskNumber(state: TaskUiState, requested?: number): { number: number; nextNumber: number } {
	const used = new Set(state.tasks.map((task) => task.number));
	if (requested !== undefined && Number.isInteger(requested) && requested > 0 && !used.has(requested)) {
		return { number: requested, nextNumber: Math.max(state.nextNumber, requested + 1) };
	}
	let number = state.nextNumber;
	while (used.has(number)) number += 1;
	return { number, nextNumber: number + 1 };
}

function nextSubtaskNumber(tasks: TaskRecord[], parentId: string, requested?: number): number {
	const used = new Set(tasks.filter((task) => task.parentId === parentId).map((task) => task.subtaskNumber));
	if (requested !== undefined && Number.isInteger(requested) && requested > 0 && !used.has(requested)) return requested;
	let number = 1;
	while (used.has(number)) number += 1;
	return number;
}

function assertValidParent(tasks: TaskRecord[], taskId: string, parentId: string | undefined): void {
	if (!parentId) return;
	if (parentId === taskId) throw new Error("A task cannot be its own parent");
	const byId = new Map(tasks.map((task) => [task.id, task]));
	if (!byId.has(parentId)) throw new Error(`Parent task not found: ${parentId}`);
	const seen = new Set<string>([taskId]);
	let current: string | undefined = parentId;
	while (current) {
		if (seen.has(current)) throw new Error("Task parent relationship would create a cycle");
		seen.add(current);
		current = byId.get(current)?.parentId;
	}
}

export function getTaskDepth(task: TaskRecord, tasks: TaskRecord[]): number {
	const byId = new Map(tasks.map((item) => [item.id, item]));
	const seen = new Set<string>([task.id]);
	let depth = 0;
	let current = task.parentId;
	while (current && !seen.has(current) && byId.has(current)) {
		seen.add(current);
		depth += 1;
		current = byId.get(current)?.parentId;
	}
	return depth;
}

export function getTaskDisplayNumber(task: TaskRecord, tasks: TaskRecord[]): string {
	const byId = new Map(tasks.map((item) => [item.id, item]));
	const labels: number[] = [];
	const seen = new Set<string>();
	let current: TaskRecord | undefined = task;
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		if (!current.parentId || current.subtaskNumber === undefined) {
			labels.unshift(current.number);
			break;
		}
		labels.unshift(current.subtaskNumber);
		current = byId.get(current.parentId);
	}
	return labels.length ? labels.join(".") : String(task.number);
}

function resolveParentUpdate(
	tasks: TaskRecord[],
	current: TaskRecord,
	requested: string | null | undefined,
): { parentId: string | undefined; subtaskNumber: number | undefined } {
	if (requested === undefined) return { parentId: current.parentId, subtaskNumber: current.subtaskNumber };
	const parentId = cleanOptional(requested ?? undefined);
	assertValidParent(tasks, current.id, parentId);
	if (!parentId) return { parentId: undefined, subtaskNumber: undefined };
	if (parentId === current.parentId) {
		return { parentId, subtaskNumber: current.subtaskNumber ?? nextSubtaskNumber(tasks, parentId) };
	}
	return { parentId, subtaskNumber: nextSubtaskNumber(tasks, parentId) };
}

export function getNextTask(tasks: TaskRecord[]): TaskRecord | undefined {
	const statusById = new Map(tasks.map((task) => [task.id, task.status]));
	const next = tasks.find((task) =>
		task.status === "pending" && task.blockedBy.every((id) => statusById.get(id) === "completed")
	);
	return next ? cloneTask(next) : undefined;
}

export function getTaskDashboard(state: TaskUiState): TaskDashboard {
	const focused = state.focusedTaskId ? state.tasks.find((task) => task.id === state.focusedTaskId) : undefined;
	return {
		active: state.tasks.filter((task) => task.status === "in_progress").map(cloneTask),
		next: getNextTask(state.tasks),
		focused: focused ? cloneTask(focused) : undefined,
	};
}

export function createTask(
	state: TaskUiState,
	input: CreateTaskInput,
	now = new Date().toISOString(),
): { state: TaskUiState; task: TaskRecord } {
	const subject = input.subject.trim();
	if (!subject) throw new Error("Task subject is required");

	const generated = nextGeneratedId(state);
	const id = cleanOptional(input.id) ?? generated.id;
	if (state.tasks.some((task) => task.id === id)) throw new Error(`Task already exists: ${id}`);
	const numbering = nextTaskNumber(state, input.number);
	const parentId = cleanOptional(input.parentId);
	assertValidParent(state.tasks, id, parentId);
	const subtaskNumber = parentId ? nextSubtaskNumber(state.tasks, parentId, input.subtaskNumber) : undefined;
	const requestedStatus = input.status ?? "pending";
	const executing = input.executing === true && !isTerminal(requestedStatus);
	const status = executing ? "in_progress" : requestedStatus;

	const task: TaskRecord = {
		id,
		number: numbering.number,
		subject,
		description: cleanOptional(input.description),
		label: cleanOptional(input.label),
		status,
		progress: clampProgress(input.progress),
		owner: cleanOptional(input.owner),
		parentId,
		subtaskNumber,
		blockedBy: cleanBlockers(input.blockedBy),
		executing,
		activeForm: cleanOptional(input.activeForm),
		startedAt: executing ? cleanOptional(input.startedAt) ?? now : cleanOptional(input.startedAt),
		inputTokens: clampTokens(input.inputTokens),
		outputTokens: clampTokens(input.outputTokens),
		createdAt: now,
		updatedAt: now,
		terminalAt: isTerminal(status) ? now : undefined,
		output: [],
	};
	const tasks = [...state.tasks.map(cloneTask), task];
	const focusedTaskId = executing || status === "in_progress" || !state.focusedTaskId
		? task.id
		: chooseFocus(tasks, state.focusedTaskId);
	return {
		state: {
			version: TASK_UI_STATE_VERSION,
			tasks,
			focusedTaskId,
			nextId: input.id ? state.nextId : generated.nextId,
			nextNumber: numbering.nextNumber,
		},
		task: cloneTask(task),
	};
}

export function createTasks(
	state: TaskUiState,
	inputs: CreateTaskInput[],
	now = new Date().toISOString(),
): { state: TaskUiState; tasks: TaskRecord[] } {
	if (inputs.length === 0) throw new Error("At least one task is required");
	let next = cloneTaskUiState(state);
	const pending = inputs.map((input, index) => ({ input, index }));
	const created = new Map<number, TaskRecord>();
	while (pending.length) {
		let progressed = false;
		for (let index = 0; index < pending.length;) {
			const candidate = pending[index];
			const parentId = cleanOptional(candidate.input.parentId);
			if (parentId && !next.tasks.some((task) => task.id === parentId)) {
				index += 1;
				continue;
			}
			const result = createTask(next, candidate.input, now);
			next = result.state;
			created.set(candidate.index, result.task);
			pending.splice(index, 1);
			progressed = true;
		}
		if (!progressed) {
			const declaredIds = new Set(inputs.map((input) => cleanOptional(input.id)).filter((id): id is string => id !== undefined));
			const missingParent = pending
				.map((candidate) => cleanOptional(candidate.input.parentId))
				.find((parentId) => parentId && !declaredIds.has(parentId) && !state.tasks.some((task) => task.id === parentId));
			if (missingParent) throw new Error(`Parent task not found: ${missingParent}`);
			throw new Error("Task parent relationships contain a cycle");
		}
	}
	return { state: next, tasks: inputs.map((_input, index) => cloneTask(created.get(index)!)) };
}

export function updateTask(
	state: TaskUiState,
	input: UpdateTaskInput,
	now = new Date().toISOString(),
): { state: TaskUiState; task: TaskRecord } {
	const index = state.tasks.findIndex((task) => task.id === input.taskId);
	if (index < 0) throw new Error(`Task not found: ${input.taskId}`);

	const tasks = state.tasks.map(cloneTask);
	const current = tasks[index];
	const subject = input.subject === undefined ? current.subject : input.subject.trim();
	if (!subject) throw new Error("Task subject cannot be empty");
	const requestedStatus = input.status ?? current.status;
	const requestedExecuting = input.executing ?? current.executing;
	const status = requestedExecuting && !isTerminal(requestedStatus) ? "in_progress" : requestedStatus;
	const executing = isTerminal(status) ? false : requestedExecuting;
	const startedAt = input.startedAt !== undefined
		? cleanOptional(input.startedAt)
		: executing && !current.executing ? now : current.startedAt;
	const parent = resolveParentUpdate(tasks, current, input.parentId);
	const terminalAt = isTerminal(status)
		? isTerminal(current.status) ? current.terminalAt ?? current.updatedAt : now
		: undefined;
	const updated: TaskRecord = {
		...current,
		subject,
		description: input.description === undefined ? current.description : cleanOptional(input.description),
		label: input.label === undefined ? current.label : cleanOptional(input.label),
		status,
		progress: input.progress === undefined ? current.progress : clampProgress(input.progress),
		owner: input.owner === undefined ? current.owner : cleanOptional(input.owner),
		parentId: parent.parentId,
		subtaskNumber: parent.subtaskNumber,
		blockedBy: input.blockedBy === undefined ? current.blockedBy : cleanBlockers(input.blockedBy),
		executing,
		activeForm: input.activeForm === undefined ? current.activeForm : cleanOptional(input.activeForm),
		startedAt,
		inputTokens: input.inputTokens === undefined ? current.inputTokens : clampTokens(input.inputTokens),
		outputTokens: input.outputTokens === undefined ? current.outputTokens : clampTokens(input.outputTokens),
		updatedAt: now,
		terminalAt,
	};
	tasks[index] = updated;
	const requestedFocus = executing || status === "in_progress" ? updated.id : state.focusedTaskId;
	return {
		state: { ...state, tasks, focusedTaskId: chooseFocus(tasks, requestedFocus) },
		task: cloneTask(updated),
	};
}

export function appendTaskOutput(
	state: TaskUiState,
	taskId: string,
	text: string,
	now = new Date().toISOString(),
): { state: TaskUiState; task: TaskRecord } {
	const trimmed = text.trim();
	if (!trimmed) throw new Error("Task output text is required");
	const displayText = trimmed.length > MAX_TASK_OUTPUT_CHARS ? `${trimmed.slice(0, MAX_TASK_OUTPUT_CHARS - 1)}…` : trimmed;
	const index = state.tasks.findIndex((task) => task.id === taskId);
	if (index < 0) throw new Error(`Task not found: ${taskId}`);

	const tasks = state.tasks.map(cloneTask);
	const output = [...tasks[index].output, { text: displayText, timestamp: now }].slice(-MAX_TASK_OUTPUT_ENTRIES);
	tasks[index] = { ...tasks[index], updatedAt: now, output };
	return { state: { ...state, tasks }, task: cloneTask(tasks[index]) };
}

export function clearTaskOutput(state: TaskUiState, taskId: string, now = new Date().toISOString()): { state: TaskUiState; task: TaskRecord } {
	const index = state.tasks.findIndex((task) => task.id === taskId);
	if (index < 0) throw new Error(`Task not found: ${taskId}`);
	const tasks = state.tasks.map(cloneTask);
	tasks[index] = { ...tasks[index], updatedAt: now, output: [] };
	return { state: { ...state, tasks }, task: cloneTask(tasks[index]) };
}

export function removeTask(state: TaskUiState, taskId: string): TaskUiState {
	const tasks = state.tasks
		.filter((task) => task.id !== taskId)
		.map((task) => task.parentId === taskId ? { ...cloneTask(task), parentId: undefined, subtaskNumber: undefined } : cloneTask(task));
	if (tasks.length === state.tasks.length) throw new Error(`Task not found: ${taskId}`);
	return { ...state, tasks, focusedTaskId: chooseFocus(tasks, state.focusedTaskId) };
}

export function setFocusedTask(state: TaskUiState, taskId?: string): TaskUiState {
	if (taskId !== undefined && !state.tasks.some((task) => task.id === taskId)) throw new Error(`Task not found: ${taskId}`);
	return { ...cloneTaskUiState(state), focusedTaskId: taskId };
}

export function upsertExternalTask(
	state: TaskUiState,
	input: ExternalTaskInput,
	now = new Date().toISOString(),
): { state: TaskUiState; task: TaskRecord } {
	const existing = state.tasks.find((task) => task.id === input.id);
	if (!existing) {
		const result = createTask(state, {
			id: input.id,
			number: input.number,
			subject: input.subject ?? input.title ?? input.name ?? input.id,
			description: input.description,
			label: input.label,
			status: normalizeTaskStatus(input.status),
			progress: input.progress,
			owner: input.owner,
			parentId: cleanOptional(input.parentId ?? undefined),
			subtaskNumber: input.subtaskNumber,
			blockedBy: input.blockedBy,
			executing: input.executing,
			activeForm: input.activeForm,
			startedAt: input.startedAt,
			inputTokens: input.inputTokens,
			outputTokens: input.outputTokens,
		}, input.createdAt ?? now);
		const output = normalizeOutput(input.output ?? [], now);
		const tasks = result.state.tasks.map((task) => task.id === input.id ? {
			...task,
			updatedAt: input.updatedAt ?? task.updatedAt,
			terminalAt: isTerminal(task.status) ? input.terminalAt ?? input.updatedAt ?? task.terminalAt : undefined,
			output,
		} : task);
		return { state: { ...result.state, tasks }, task: cloneTask(tasks.find((task) => task.id === input.id)!) };
	}

	const result = updateTask(state, {
		taskId: input.id,
		subject: input.subject ?? input.title ?? input.name,
		description: input.description,
		label: input.label,
		status: input.status === undefined ? undefined : normalizeTaskStatus(input.status),
		progress: input.progress,
		owner: input.owner,
		parentId: input.parentId,
		blockedBy: input.blockedBy,
		executing: input.executing,
		activeForm: input.activeForm,
		startedAt: input.startedAt,
		inputTokens: input.inputTokens,
		outputTokens: input.outputTokens,
	}, input.updatedAt ?? now);
	if (input.output || input.terminalAt) {
		const output = input.output ? normalizeOutput(input.output, now) : result.task.output;
		const tasks = result.state.tasks.map((task) => task.id === input.id ? {
			...task,
			terminalAt: isTerminal(task.status) ? input.terminalAt ?? task.terminalAt : undefined,
			output,
		} : task);
		return { state: { ...result.state, tasks }, task: cloneTask(tasks.find((task) => task.id === input.id)!) };
	}
	return result;
}

export function replaceExternalTasks(
	inputs: ExternalTaskInput[],
	focusedTaskId?: string,
	now = new Date().toISOString(),
): TaskUiState {
	let state = createInitialTaskUiState();
	const pending = [...inputs];
	while (pending.length) {
		let progressed = false;
		for (let index = 0; index < pending.length;) {
			const input = pending[index];
			const parentId = cleanOptional(input.parentId ?? undefined);
			if (parentId && !state.tasks.some((task) => task.id === parentId)) {
				index += 1;
				continue;
			}
			state = upsertExternalTask(state, input, now).state;
			pending.splice(index, 1);
			progressed = true;
		}
		if (!progressed) throw new Error("External task parents are missing or cyclic");
	}
	return { ...state, focusedTaskId: chooseFocus(state.tasks, focusedTaskId) };
}

export function normalizeStoredTaskUiState(value: unknown): TaskUiState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<TaskUiState>;
	if (!Array.isArray(candidate.tasks)) return undefined;
	try {
		const state = replaceExternalTasks(candidate.tasks as ExternalTaskInput[], candidate.focusedTaskId);
		return {
			...state,
			nextId: typeof candidate.nextId === "number" && candidate.nextId > 0 ? Math.floor(candidate.nextId) : state.nextId,
			nextNumber: typeof candidate.nextNumber === "number" && candidate.nextNumber > 0 ? Math.floor(candidate.nextNumber) : state.nextNumber,
		};
	} catch {
		return undefined;
	}
}
