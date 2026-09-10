import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import GithubSlugger from "github-slugger";
import {
	getTaskDepth,
	getTaskDisplayNumber,
	orderTasksForDisplay,
	type TaskRecord,
	type TaskStatus,
	type TaskUiState,
} from "./core.ts";

const STATUS_LABELS: Record<TaskStatus, string> = {
	pending: "pending",
	in_progress: "in progress",
	completed: "completed",
	failed: "failed",
	stopped: "stopped",
};

type PreparedTask = {
	task: TaskRecord;
	title: string;
	anchor: string;
};

function normalizeSubject(subject: string): string {
	return subject.replace(/\s+/g, " ").trim();
}

function escapeLinkLabel(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function inlineCode(value: string): string {
	let fence = "`";
	while (value.includes(fence)) fence += "`";
	const needsPadding = value.startsWith("`") || value.endsWith("`") || value.startsWith(" ") || value.endsWith(" ");
	return `${fence}${needsPadding ? ` ${value} ` : value}${fence}`;
}

function prepareTasks(state: TaskUiState): PreparedTask[] {
	const slugger = new GithubSlugger();
	return orderTasksForDisplay(state.tasks).map((task) => {
		const title = `${getTaskDisplayNumber(task, state.tasks)}. ${normalizeSubject(task.subject)}`;
		return { task, title, anchor: slugger.slug(title) };
	});
}

export function renderTaskUiMarkdown(state: TaskUiState): string {
	const prepared = prepareTasks(state);
	if (prepared.length === 0) return "_No projected tasks._";

	const preparedById = new Map(prepared.map((item) => [item.task.id, item]));
	return prepared.map(({ task, title }) => {
		const headingLevel = Math.min(6, getTaskDepth(task, state.tasks) + 1);
		const dependencies = task.blockedBy.map((dependencyId) => {
			const dependency = preparedById.get(dependencyId);
			if (!dependency) return inlineCode(dependencyId);
			return `[${escapeLinkLabel(dependency.title)}](#${dependency.anchor})`;
		});
		const metadata = [`**Status:** ${STATUS_LABELS[task.status]}`];
		if (dependencies.length > 0) metadata.push(`**Dependencies:** ${dependencies.join(", ")}`);
		return [
			`${"#".repeat(headingLevel)} ${title}`,
			task.description,
			metadata.join(" · "),
		].filter((part): part is string => part !== undefined).join("\n\n");
	}).join("\n\n");
}

export interface WriteTaskUiMarkdownOptions {
	path?: string;
	overwrite?: boolean;
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

export async function writeTaskUiMarkdown(
	state: TaskUiState,
	options: WriteTaskUiMarkdownOptions = {},
): Promise<string> {
	if (options.path === "") throw new Error("Markdown output path cannot be empty");
	const outputPath = options.path === undefined
		? join(tmpdir(), `task-ui-${randomUUID()}.md`)
		: resolve(options.path);
	try {
		await writeFile(outputPath, renderTaskUiMarkdown(state), {
			encoding: "utf8",
			flag: options.overwrite === true ? "w" : "wx",
		});
	} catch (error) {
		if (isFileExistsError(error)) {
			throw new Error(`Markdown file already exists: ${outputPath}. Ask the user to confirm overwriting it, then call task_ui_to_md({ path: ${JSON.stringify(outputPath)}, overwrite: true }).`);
		}
		throw error;
	}
	return outputPath;
}
