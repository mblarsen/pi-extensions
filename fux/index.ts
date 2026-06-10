import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, realpathSync, statSync } from "node:fs";
import { copyFile, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { pathToFileURL } from "node:url";

const COMMAND_NAME = "fux";
const FUX_CUSTOM_TYPE = "fux";
const FUX_WIDGET_KEY = "fux-status";
const FUX_METADATA_VERSION = 1;

type JsonObject = Record<string, unknown>;

type SessionHeader = JsonObject & {
	type: "session";
	parentSession?: string;
};

type SessionEntry = JsonObject & {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
};

type FileEntry = SessionHeader | SessionEntry;

type FuxForkMetadata = {
	kind: "fork";
	version: number;
	parentSessionFile: string;
	forkedSessionFile: string;
	forkedFromEntryId: string;
	createdAt: string;
	prompt?: string;
	mergeReminder?: string;
	recordedIn?: "parent" | "child";
};

type FuxMergeMetadata = {
	kind: "merge";
	version: number;
	childSessionFile: string;
	forkedFromEntryId: string;
	mergedEntryCount: number;
	mergedLeafId: string | null;
	backupFile: string;
	mergedAt: string;
};

type FuxWidgetState = {
	role: "parent" | "child";
	parentSessionFile: string;
	forkedSessionFile: string;
	prompt?: string;
};

type ParsedSession = {
	header: SessionHeader;
	fileEntries: FileEntry[];
	sessionEntries: SessionEntry[];
};

type MergeOptions = {
	yes: boolean;
	dryRun: boolean;
	deleteFork: boolean;
	childSessionPath?: string;
};

type DeleteOptions = {
	yes: boolean;
};

type MergePlan = {
	parentSessionFile: string;
	childSessionFile: string;
	forkedFromEntryId: string;
	childLeafId: string | null;
	mergedLeafId: string | null;
	entriesToAppend: SessionEntry[];
	parentFileEntries: FileEntry[];
	parentStat: {
		size: number;
		mtimeMs: number;
	};
	backupFile: string;
	duplicateCount: number;
};

function getPiPackageRoot(): string {
	const argvPath = process.argv[1];
	if (!argvPath) {
		throw new Error("Unable to locate the running pi command path.");
	}

	return dirname(dirname(realpathSync(argvPath)));
}

async function loadSessionManager(): Promise<{
	SessionManager: {
		open(path: string, sessionDir?: string): {
			createBranchedSession(leafId: string): string | undefined;
			appendCustomEntry(customType: string, data?: unknown): string;
			appendCustomMessageEntry(customType: string, content: string, display: boolean, details?: unknown): string;
		};
	};
}> {
	const packageRoot = getPiPackageRoot();
	const sessionManagerPath = pathToFileURL(join(packageRoot, "dist/core/session-manager.js")).href;
	return import(sessionManagerPath);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function consumesValue(flag: string): boolean {
	return new Set([
		"--mode",
		"--provider",
		"--model",
		"--api-key",
		"--system-prompt",
		"--append-system-prompt",
		"--session-dir",
		"--models",
		"--tools",
		"-t",
		"--thinking",
		"--extension",
		"-e",
		"--link-name",
		"--skill",
		"--prompt-template",
		"--theme",
	]).has(flag);
}

function isSessionSelectionFlag(flag: string): boolean {
	return new Set([
		"--session",
		"--fork",
		"--continue",
		"-c",
		"--resume",
		"-r",
		"--no-session",
	]).has(flag);
}

function isOneShotFlag(flag: string): boolean {
	return new Set([
		"--help",
		"-h",
		"--version",
		"-v",
		"--print",
		"-p",
		"--export",
		"--list-models",
	]).has(flag);
}

function sanitizedParentArgs(args: string[]): string[] {
	const kept: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--session" || arg === "--fork" || arg === "--export") {
			i++;
			continue;
		}

		if (arg.startsWith("--session=") || arg.startsWith("--fork=") || arg.startsWith("--export=")) {
			continue;
		}

		if (isSessionSelectionFlag(arg) || isOneShotFlag(arg)) {
			continue;
		}

		if (arg.startsWith("@")) {
			continue;
		}

		if (arg.startsWith("--")) {
			kept.push(arg);
			if (!arg.includes("=") && consumesValue(arg) && i + 1 < args.length) {
				kept.push(args[++i]);
			}
			continue;
		}

		if (arg.startsWith("-") && consumesValue(arg)) {
			kept.push(arg);
			if (i + 1 < args.length) {
				kept.push(args[++i]);
			}
			continue;
		}

		if (arg.startsWith("-")) {
			kept.push(arg);
		}
		// Positional startup messages are intentionally not replayed in the fork.
	}

	return kept;
}

function buildPiCommand(sessionFile: string): string {
	const argv0 = process.argv[1] ?? "pi";
	const args = [...sanitizedParentArgs(process.argv.slice(2)), "--session", sessionFile];
	return [shellQuote(argv0), ...args.map(shellQuote)].join(" ");
}

function buildForkPaneCommand(sessionFile: string): string {
	const piCommand = buildPiCommand(sessionFile);
	const script = [
		piCommand,
		"status=$?",
		"printf '\\n[fux] pi exited with status %s. Pane kept open; exit this shell to close it.\\n' \"$status\"",
		"exec \"${SHELL:-/bin/sh}\" -l",
	].join("\n");
	return `sh -lc ${shellQuote(script)}`;
}

async function runTmux(args: string[], description: string): Promise<string> {
	return new Promise<string>((resolvePromise, reject) => {
		const child = spawn("tmux", args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];

		child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
		child.once("error", reject);
		child.once("exit", (code) => {
			const stdout = Buffer.concat(stdoutChunks).toString("utf8");
			const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
			if (code === 0) {
				resolvePromise(stdout.trim());
				return;
			}
			reject(new Error(`${description} exited with code ${code ?? "unknown"}${stderr ? `: ${stderr}` : ""}`));
		});
	});
}

async function runTmuxSplit(command: string, cwd: string): Promise<string> {
	if (!process.env.TMUX) {
		throw new Error("Not running inside tmux; cannot create a tmux pane.");
	}

	const paneId = await runTmux(["split-window", "-h", "-P", "-F", "#{pane_id}", "-c", cwd, command], "tmux split-window");
	if (!paneId) {
		throw new Error("tmux split-window did not return a pane id.");
	}
	return paneId;
}

async function getCurrentTmuxPaneId(): Promise<string | undefined> {
	if (!process.env.TMUX) return undefined;
	// TMUX_PANE is set by tmux for processes started inside a pane and points to
	// the exact pane running this pi process. Using display-message without -t can
	// resolve to the client's active pane instead, which is wrong for merge cleanup.
	if (process.env.TMUX_PANE) return process.env.TMUX_PANE;
	try {
		return await runTmux(["display-message", "-p", "#{pane_id}"], "tmux display-message");
	} catch {
		return undefined;
	}
}

async function sendPromptToPane(paneId: string, prompt: string): Promise<void> {
	// Give the new pane a brief moment to exec pi before sending terminal input.
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
	await runTmux(["send-keys", "-t", paneId, "-l", prompt], "tmux send-keys prompt");
	await runTmux(["send-keys", "-t", paneId, "Enter"], "tmux send-keys enter");
}

function appendForkMetadata(
	sessionManager: { appendCustomEntry(customType: string, data?: unknown): string },
	metadata: FuxForkMetadata,
): void {
	sessionManager.appendCustomEntry(FUX_CUSTOM_TYPE, metadata);
}

function parentRestartCommand(parentSessionFile: string): string {
	return `pi --resume ${parentSessionFile}`;
}

function parentForkGuidanceMessage(parentSessionFile: string): string {
	return [
		"[fux status] A child fork has been started in another pane for side exploration.",
		"[fux status] This message is context only; continue your work normally.",
		"[fux status] When the child merges back, restart this parent with:",
		parentRestartCommand(parentSessionFile),
	].join("\n");
}

function childForkGuidanceMessage(parentSessionFile: string): string {
	return [
		"[fux status] This session is a fux fork — a side branch for focused exploration.",
		"[fux status] This message is context only; do not act on it or discuss fux/merging unless the user explicitly asks.",
		"[fux status] If the user later wants to merge back, they can run /fux merge --dry-run to preview, then /fux merge to confirm.",
		"[fux status] After merge, restart the parent with:",
		parentRestartCommand(parentSessionFile),
	].join("\n");
}

const WIDGET_ACCENT = "\x1b[38;2;77;163;255m";
const WIDGET_RESET = "\x1b[0m";

function visibleLength(text: string): number {
	return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function truncatePlain(text: string, width: number): string {
	if (width <= 0) return "";
	const chars = Array.from(text);
	if (chars.length <= width) return text;
	if (width === 1) return "…";
	return `${chars.slice(0, width - 1).join("")}…`;
}

function widgetTop(title: string, info: string, width: number): string {
	if (width <= 1) return `${WIDGET_ACCENT}╭${WIDGET_RESET}`;
	const inner = Math.max(0, width - 2);
	const left = `─ ${title} `;
	const right = info ? ` ${info} ─` : "";
	const fill = "─".repeat(Math.max(0, inner - visibleLength(left) - visibleLength(right)));
	return `${WIDGET_ACCENT}╭${truncatePlain(`${left}${fill}${right}`, inner).padEnd(inner, "─")}╮${WIDGET_RESET}`;
}

function widgetLine(text: string, width: number): string {
	if (width <= 1) return `${WIDGET_ACCENT}│${WIDGET_RESET}`;
	const inner = Math.max(0, width - 2);
	const content = truncatePlain(text, inner);
	return `${WIDGET_ACCENT}│${WIDGET_RESET}${content}${" ".repeat(Math.max(0, inner - visibleLength(content)))}${WIDGET_ACCENT}│${WIDGET_RESET}`;
}

function widgetBottom(width: number): string {
	if (width <= 1) return `${WIDGET_ACCENT}╰${WIDGET_RESET}`;
	return `${WIDGET_ACCENT}╰${"─".repeat(Math.max(0, width - 2))}╯${WIDGET_RESET}`;
}

function wrapPlain(text: string, width: number): string[] {
	if (width <= 0) return [""];
	const chunks: string[] = [];
	let rest = text;
	while (visibleLength(rest) > width) {
		chunks.push(rest.slice(0, width));
		rest = rest.slice(width);
	}
	chunks.push(rest);
	return chunks;
}

function renderFuxWidgetLines(state: FuxWidgetState, width: number): string[] {
	if (state.role === "child") {
		return [
			widgetTop("fux", "fork", width),
			widgetLine(" Use `/fux merge` to combine with parent session again.", width),
			widgetBottom(width),
		];
	}

	const inner = Math.max(0, width - 4);
	const lines = [widgetTop("fux", "parent", width)];
	lines.push(widgetLine(" Parent pane; child fork opened.", width));
	lines.push(widgetLine(" After merge, restart:", width));
	for (const chunk of wrapPlain(parentRestartCommand(state.parentSessionFile), inner)) {
		lines.push(widgetLine(` ${chunk}`, width));
	}
	lines.push(widgetBottom(width));
	return lines;
}

function maybeFuxForkMetadata(entry: SessionEntry): (FuxForkMetadata & JsonObject) | undefined {
	const data = fuxData(entry);
	return isFuxForkMetadata(data) ? data : undefined;
}

function fuxWidgetVisibility(entry: SessionEntry): boolean | undefined {
	const data = fuxData(entry);
	if (data?.kind === "widget_hidden") return false;
	if (data?.kind === "widget_visibility" && typeof data.visible === "boolean") return data.visible;
	return undefined;
}

function findFuxWidgetState(ctx: ExtensionContext, respectVisibility = true): FuxWidgetState | undefined {
	const branch = ctx.sessionManager.getBranch();
	if (respectVisibility) {
		const latestVisibilityIndex = branch.findLastIndex((entry) => fuxWidgetVisibility(entry) !== undefined);
		if (latestVisibilityIndex >= 0 && fuxWidgetVisibility(branch[latestVisibilityIndex]) === false) {
			return undefined;
		}
	}

	for (let index = branch.length - 1; index >= 0; index--) {
		const metadata = maybeFuxForkMetadata(branch[index]);
		if (metadata?.recordedIn === "child") {
			return {
				role: "child",
				parentSessionFile: metadata.parentSessionFile,
				forkedSessionFile: metadata.forkedSessionFile,
				prompt: metadata.prompt,
			};
		}
	}

	const parentSearchStart = respectVisibility ? Math.max(0, branch.length - 5) : 0;
	for (let index = branch.length - 1; index >= parentSearchStart; index--) {
		const metadata = maybeFuxForkMetadata(branch[index]);
		if (metadata?.recordedIn === "parent") {
			return {
				role: "parent",
				parentSessionFile: metadata.parentSessionFile,
				forkedSessionFile: metadata.forkedSessionFile,
				prompt: metadata.prompt,
			};
		}
	}

	return undefined;
}

function setFuxWidget(ctx: ExtensionContext, state: FuxWidgetState): void {
	ctx.ui.setWidget(
		FUX_WIDGET_KEY,
		() => ({
			invalidate() {},
			render(width: number) {
				return renderFuxWidgetLines(state, width);
			},
		}),
		{ placement: "aboveEditor" },
	);
}

function updateFuxWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const state = findFuxWidgetState(ctx);
	if (!state) {
		ctx.ui.setWidget(FUX_WIDGET_KEY, undefined);
		return;
	}
	setFuxWidget(ctx, state);
}

function toggleFuxWidget(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
	const visibleState = findFuxWidgetState(ctx);
	if (visibleState) {
		pi.appendEntry(FUX_CUSTOM_TYPE, {
			kind: "widget_visibility",
			visible: false,
			updatedAt: new Date().toISOString(),
		});
		ctx.ui.setWidget(FUX_WIDGET_KEY, undefined);
		notify(ctx, "Fux widget off.", "info");
		return;
	}

	const hiddenState = findFuxWidgetState(ctx, false);
	if (!hiddenState) {
		notify(ctx, "No fux widget to toggle in this branch.", "warning");
		return;
	}

	pi.appendEntry(FUX_CUSTOM_TYPE, {
		kind: "widget_visibility",
		visible: true,
		updatedAt: new Date().toISOString(),
	});
	setFuxWidget(ctx, hiddenState);
	notify(ctx, "Fux widget on.", "info");
}

function appendParentForkMetadata(pi: ExtensionAPI, metadata: FuxForkMetadata): void {
	pi.appendEntry(FUX_CUSTOM_TYPE, metadata);
}

function shortSessionId(sessionFile: string): string {
	const filename = basename(sessionFile).replace(/\.jsonl$/, "");
	const suffix = filename.split("_").at(-1) ?? filename;
	return suffix.length > 8 ? suffix.slice(0, 8) : suffix;
}

function oneLineSnippet(text: string, maxLength = 72): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= maxLength) return oneLine;
	return `${oneLine.slice(0, maxLength - 1)}…`;
}

function normalizePromptInput(prompt: string | undefined): string | undefined {
	const trimmed = prompt?.trim();
	if (!trimmed) return undefined;

	const quotePairs = [
		["\"", "\""],
		["'", "'"],
		["“", "”"],
		["‘", "’"],
	] as const;

	for (const [open, close] of quotePairs) {
		if (trimmed.length >= open.length + close.length && trimmed.startsWith(open) && trimmed.endsWith(close)) {
			return trimmed.slice(open.length, trimmed.length - close.length);
		}
	}

	return trimmed;
}

function buildForkLabel(existingLabel: string | undefined, childSessionFile: string, prompt?: string): string {
	const promptSuffix = prompt ? `: ${oneLineSnippet(prompt)}` : "";
	const forkLabel = `fux → ${shortSessionId(childSessionFile)}${promptSuffix}`;
	if (!existingLabel) return forkLabel;
	if (existingLabel.includes(forkLabel)) return existingLabel;
	return `${existingLabel} · ${forkLabel}`;
}

function labelForkPoint(pi: ExtensionAPI, ctx: ExtensionCommandContext, entryId: string, childSessionFile: string, prompt?: string): void {
	const label = buildForkLabel(ctx.sessionManager.getLabel(entryId), childSessionFile, prompt);
	pi.setLabel(entryId, label);
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
	}
}

function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function samePath(a: string, b: string): boolean {
	return canonicalPath(a) === canonicalPath(b);
}

function expandHome(path: string): string {
	if (path === "~") {
		return process.env.HOME ?? path;
	}
	if (path.startsWith("~/")) {
		return join(process.env.HOME ?? "~", path.slice(2));
	}
	return path;
}

function resolveSessionPath(path: string, cwd: string): string {
	const expanded = expandHome(path);
	return resolve(cwd, expanded);
}

function parseMergeArgs(args: string): MergeOptions {
	const options: MergeOptions = { yes: false, dryRun: false, deleteFork: true };
	const parts = args.trim().split(/\s+/).filter(Boolean);

	for (const part of parts) {
		if (part === "--yes" || part === "-y") {
			options.yes = true;
			continue;
		}
		if (part === "--dry-run" || part === "-n") {
			options.dryRun = true;
			continue;
		}
		if (part === "--delete") {
			options.deleteFork = true;
			continue;
		}
		if (part === "--keep" || part === "--no-delete") {
			options.deleteFork = false;
			continue;
		}
		if (!options.childSessionPath) {
			options.childSessionPath = part;
			continue;
		}
		throw new Error(`Unexpected /fux merge argument: ${part}`);
	}

	return options;
}

function parseDeleteArgs(args: string): DeleteOptions {
	const options: DeleteOptions = { yes: false };
	const parts = args.trim().split(/\s+/).filter(Boolean);

	for (const part of parts) {
		if (part === "--yes" || part === "-y") {
			options.yes = true;
			continue;
		}
		throw new Error(`Unexpected /fux delete argument: ${part}`);
	}

	return options;
}

async function readSession(path: string): Promise<ParsedSession> {
	const content = await readFile(path, "utf8");
	const fileEntries: FileEntry[] = [];

	for (const [index, line] of content.split("\n").entries()) {
		if (!line.trim()) continue;
		try {
			fileEntries.push(JSON.parse(line) as FileEntry);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Invalid JSON in ${path}:${index + 1}: ${message}`);
		}
	}

	const header = fileEntries[0];
	if (!header || header.type !== "session") {
		throw new Error(`Session file has no session header: ${path}`);
	}

	const sessionEntries = fileEntries.slice(1).filter(isSessionEntry);
	return { header: header as SessionHeader, fileEntries, sessionEntries };
}

function isSessionEntry(entry: FileEntry): entry is SessionEntry {
	return (
		entry.type !== "session" &&
		typeof (entry as JsonObject).id === "string" &&
		((entry as JsonObject).parentId === null || typeof (entry as JsonObject).parentId === "string")
	);
}

function stringifySession(entries: FileEntry[]): string {
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function getLeafId(entries: SessionEntry[]): string | null {
	return entries.at(-1)?.id ?? null;
}

function indexEntries(entries: SessionEntry[]): Map<string, SessionEntry> {
	return new Map(entries.map((entry) => [entry.id, entry]));
}

function getBranch(entries: SessionEntry[], leafId: string | null): SessionEntry[] {
	if (!leafId) return [];

	const byId = indexEntries(entries);
	const branch: SessionEntry[] = [];
	let current = byId.get(leafId);
	const seen = new Set<string>();

	while (current) {
		if (seen.has(current.id)) {
			throw new Error(`Session tree contains a cycle at entry ${current.id}`);
		}
		seen.add(current.id);
		branch.unshift(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}

	return branch;
}

function fuxData(entry: SessionEntry): JsonObject | undefined {
	if (entry.type !== "custom") return undefined;
	if ((entry as JsonObject).customType !== FUX_CUSTOM_TYPE) return undefined;
	const data = (entry as JsonObject).data;
	return data && typeof data === "object" ? (data as JsonObject) : undefined;
}

function isFuxForkMetadata(data: JsonObject | undefined): data is FuxForkMetadata & JsonObject {
	return (
		data?.kind === "fork" &&
		typeof data.parentSessionFile === "string" &&
		typeof data.forkedFromEntryId === "string"
	);
}

function isSkippableFuxEntry(entry: SessionEntry): boolean {
	if ((entry.type === "custom" || entry.type === "custom_message") && (entry as JsonObject).customType === FUX_CUSTOM_TYPE) {
		return true;
	}
	const data = fuxData(entry);
	return data?.kind === "fork" || data?.kind === "merge";
}

function findForkMetadata(childEntries: SessionEntry[], parentSessionFile: string): FuxForkMetadata | undefined {
	for (let index = childEntries.length - 1; index >= 0; index--) {
		const data = fuxData(childEntries[index]);
		if (!isFuxForkMetadata(data)) continue;
		if (samePath(data.parentSessionFile, parentSessionFile)) {
			return data;
		}
	}
	return undefined;
}

function inferForkSourceEntryId(childBranch: SessionEntry[], parentById: Map<string, SessionEntry>): string | undefined {
	let lastMatchingEntryId: string | undefined;

	for (const childEntry of childBranch) {
		const parentEntry = parentById.get(childEntry.id);
		if (!parentEntry) {
			break;
		}
		if (JSON.stringify(parentEntry) !== JSON.stringify(childEntry)) {
			break;
		}
		lastMatchingEntryId = childEntry.id;
	}

	return lastMatchingEntryId;
}

function deepCloneEntry(entry: SessionEntry): SessionEntry {
	return JSON.parse(JSON.stringify(entry)) as SessionEntry;
}

function generateEntryId(usedIds: Set<string>): string {
	for (let attempt = 0; attempt < 100; attempt++) {
		const id = randomUUID().slice(0, 8);
		if (!usedIds.has(id)) return id;
	}

	let id = randomUUID();
	while (usedIds.has(id)) {
		id = randomUUID();
	}
	return id;
}

function remapReference(value: unknown, idMap: Map<string, string>): unknown {
	return typeof value === "string" ? idMap.get(value) ?? value : value;
}

function remapEntryReferences(entry: SessionEntry, idMap: Map<string, string>): void {
	if (entry.type === "compaction") {
		(entry as JsonObject).firstKeptEntryId = remapReference((entry as JsonObject).firstKeptEntryId, idMap);
	}

	if (entry.type === "branch_summary") {
		(entry as JsonObject).fromId = remapReference((entry as JsonObject).fromId, idMap);
	}

	if (entry.type === "label") {
		(entry as JsonObject).targetId = remapReference((entry as JsonObject).targetId, idMap);
	}
}

function shouldSkipLabel(entry: SessionEntry, idMap: Map<string, string>): boolean {
	if (entry.type !== "label") return false;
	const targetId = (entry as JsonObject).targetId;
	return typeof targetId !== "string" || !idMap.has(targetId);
}

function appendPreserveLeafMarker(
	entries: FileEntry[],
	usedIds: Set<string>,
	parentOldLeafId: string | null,
	data: FuxMergeMetadata,
): SessionEntry | undefined {
	if (!parentOldLeafId) return undefined;

	const marker: SessionEntry = {
		type: "custom",
		id: generateEntryId(usedIds),
		parentId: parentOldLeafId,
		timestamp: new Date().toISOString(),
		customType: FUX_CUSTOM_TYPE,
		data,
	};
	entries.push(marker);
	usedIds.add(marker.id);
	return marker;
}

async function planFuxMerge(childSessionFile: string): Promise<MergePlan> {
	const child = await readSession(childSessionFile);
	const parentSessionFromHeader = child.header.parentSession;
	if (!parentSessionFromHeader) {
		throw new Error("This session does not record a parentSession; it does not look like a /fux child session.");
	}

	const parentSessionFile = canonicalPath(parentSessionFromHeader);
	if (!existsSync(parentSessionFile)) {
		throw new Error(`Parent session file does not exist: ${parentSessionFile}`);
	}
	if (samePath(parentSessionFile, childSessionFile)) {
		throw new Error("Child session and parent session resolve to the same file; refusing to merge.");
	}

	const parent = await readSession(parentSessionFile);
	const parentStat = statSync(parentSessionFile);
	const parentById = indexEntries(parent.sessionEntries);
	const childLeafId = getLeafId(child.sessionEntries);
	const childBranch = getBranch(child.sessionEntries, childLeafId);
	const forkMetadata = findForkMetadata(child.sessionEntries, parentSessionFile);
	const forkedFromEntryId = forkMetadata?.forkedFromEntryId ?? inferForkSourceEntryId(childBranch, parentById);

	if (!forkedFromEntryId) {
		throw new Error("Could not determine where the child forked from. New /fux sessions record this automatically; older sessions may need manual merging.");
	}
	if (!parentById.has(forkedFromEntryId)) {
		throw new Error(`Parent session does not contain fork source entry ${forkedFromEntryId}.`);
	}

	const sourceIndex = childBranch.findIndex((entry) => entry.id === forkedFromEntryId);
	if (sourceIndex < 0) {
		throw new Error(`Child active branch does not descend from fork source ${forkedFromEntryId}.`);
	}

	const parentFileEntries = [...parent.fileEntries];
	const parentOldLeafId = getLeafId(parent.sessionEntries);
	const usedIds = new Set(parent.sessionEntries.map((entry) => entry.id));
	const idMap = new Map<string, string>([[forkedFromEntryId, forkedFromEntryId]]);
	const entriesToAppend: SessionEntry[] = [];
	let duplicateCount = 0;

	for (const childEntry of childBranch.slice(sourceIndex + 1)) {
		const mappedParentId = childEntry.parentId ? idMap.get(childEntry.parentId) ?? childEntry.parentId : null;

		if (isSkippableFuxEntry(childEntry) || shouldSkipLabel(childEntry, idMap)) {
			if (mappedParentId) {
				idMap.set(childEntry.id, mappedParentId);
			}
			continue;
		}

		const mergedEntry = deepCloneEntry(childEntry);
		mergedEntry.parentId = mappedParentId;
		remapEntryReferences(mergedEntry, idMap);

		if (mergedEntry.parentId && !usedIds.has(mergedEntry.parentId)) {
			throw new Error(`Cannot merge ${childEntry.id}: mapped parent ${mergedEntry.parentId} is not present in the parent session.`);
		}

		const existingEntry = parentById.get(mergedEntry.id);
		if (existingEntry) {
			if (JSON.stringify(existingEntry) === JSON.stringify(mergedEntry)) {
				idMap.set(childEntry.id, mergedEntry.id);
				duplicateCount++;
				continue;
			}

			mergedEntry.id = generateEntryId(usedIds);
		}

		usedIds.add(mergedEntry.id);
		idMap.set(childEntry.id, mergedEntry.id);
		entriesToAppend.push(mergedEntry);
		parentFileEntries.push(mergedEntry);
	}

	const mergedLeafId = childLeafId ? idMap.get(childLeafId) ?? null : null;
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupFile = `${parentSessionFile}.before-fux-merge-${timestamp}.bak`;

	if (entriesToAppend.length > 0) {
		const mergeMetadata = {
			kind: "merge" as const,
			version: FUX_METADATA_VERSION,
			childSessionFile: canonicalPath(childSessionFile),
			forkedFromEntryId,
			mergedEntryCount: entriesToAppend.length,
			mergedLeafId,
			backupFile,
			mergedAt: new Date().toISOString(),
		};
		appendPreserveLeafMarker(parentFileEntries, usedIds, parentOldLeafId, mergeMetadata);
	}

	return {
		parentSessionFile,
		childSessionFile: canonicalPath(childSessionFile),
		forkedFromEntryId,
		childLeafId,
		mergedLeafId,
		entriesToAppend,
		parentFileEntries,
		parentStat: {
			size: parentStat.size,
			mtimeMs: parentStat.mtimeMs,
		},
		backupFile,
		duplicateCount,
	};
}

async function writeFuxMerge(plan: MergePlan): Promise<void> {
	const latestStat = statSync(plan.parentSessionFile);
	if (plan.parentStat.mtimeMs !== latestStat.mtimeMs || plan.parentStat.size !== latestStat.size) {
		throw new Error("Parent session changed while preparing the merge; aborting. Re-run /fux merge when it is at rest.");
	}

	await copyFile(plan.parentSessionFile, plan.backupFile);
	await writeFile(plan.parentSessionFile, stringifySession(plan.parentFileEntries), "utf8");
}

async function tryRun(command: string, args: string[]): Promise<boolean> {
	return new Promise<boolean>((resolvePromise) => {
		const child = spawn(command, args, { stdio: "ignore" });
		child.once("error", () => resolvePromise(false));
		child.once("exit", (code) => resolvePromise(code === 0));
	});
}

async function deleteSessionFile(sessionFile: string): Promise<string> {
	if (!existsSync(sessionFile)) return "already deleted";
	if (await tryRun("trash", [sessionFile])) return "moved to Trash";
	await unlink(sessionFile);
	return "deleted";
}

function scheduleDeleteAndKillPane(sessionFile: string, paneId: string): void {
	const script = [
		"sleep 0.8",
		"if command -v trash >/dev/null 2>&1; then trash \"$1\" 2>/dev/null || rm -f \"$1\"; else rm -f \"$1\"; fi",
		"tmux kill-pane -t \"$2\" 2>/dev/null || true",
	].join("; ");
	const child = spawn("sh", ["-c", script, "fux-cleanup", sessionFile, paneId], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}

async function cleanupForkAfterMerge(plan: MergePlan, ctx: ExtensionCommandContext): Promise<string | undefined> {
	const currentSessionFile = ctx.sessionManager.getSessionFile();
	const activeChild = currentSessionFile ? samePath(currentSessionFile, plan.childSessionFile) : false;

	if (activeChild) {
		const paneId = await getCurrentTmuxPaneId();
		if (paneId) {
			scheduleDeleteAndKillPane(plan.childSessionFile, paneId);
			ctx.shutdown();
			return "Fork session will be deleted and this pane will close.";
		}

		const result = await deleteSessionFile(plan.childSessionFile);
		ctx.shutdown();
		return `Fork session ${result}; agent will shut down.`;
	}

	const result = await deleteSessionFile(plan.childSessionFile);
	return `Fork session ${result}.`;
}

function isCurrentFuxChildSession(session: ParsedSession, sessionFile: string): boolean {
	const parentSessionFile = session.header.parentSession;
	if (!parentSessionFile) return false;
	return session.sessionEntries.some((entry) => {
		const data = fuxData(entry);
		return isFuxForkMetadata(data) && samePath(data.parentSessionFile, parentSessionFile) && samePath(data.forkedSessionFile, sessionFile);
	});
}

function deleteForkWarning(sessionFile: string, parentSessionFile: string): string {
	return [
		"This will delete this /fux fork and close this tmux pane.",
		"Nothing will be merged into the parent.",
		"",
		`Fork: ${sessionFile}`,
		`Parent: ${parentSessionFile}`,
	].join("\n");
}

async function deleteCurrentFork(sessionFile: string, ctx: ExtensionCommandContext): Promise<string> {
	const paneId = await getCurrentTmuxPaneId();
	if (paneId) {
		scheduleDeleteAndKillPane(sessionFile, paneId);
		ctx.shutdown();
		return "Fork session will be deleted and this pane will close.";
	}

	const result = await deleteSessionFile(sessionFile);
	ctx.shutdown();
	return `Fork session ${result}; agent will shut down.`;
}

async function doDeleteFux(args: string, ctx: ExtensionCommandContext): Promise<string> {
	const options = parseDeleteArgs(args);
	const currentSessionFile = ctx.sessionManager.getSessionFile();
	if (!currentSessionFile) {
		throw new Error("Cannot /fux delete an in-memory session.");
	}

	const sessionFile = canonicalPath(currentSessionFile);
	const session = await readSession(sessionFile);
	if (!isCurrentFuxChildSession(session, sessionFile)) {
		throw new Error("Run /fux delete from a /fux child fork session. Refusing to delete this session.");
	}

	if (!options.yes) {
		if (!ctx.hasUI) {
			throw new Error("Deleting a fork requires --yes when no confirmation UI is available.");
		}
		const ok = await ctx.ui.confirm("Delete /fux fork?", deleteForkWarning(sessionFile, session.header.parentSession!));
		if (!ok) return "Cancelled /fux delete.";
	}

	return deleteCurrentFork(sessionFile, ctx);
}

async function deleteFux(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.isIdle()) {
		notify(ctx, "Press Escape to stop the current turn, then run /fux delete again.", "warning");
		return;
	}

	const message = await doDeleteFux(args, ctx);
	notify(ctx, message, message.startsWith("Cancelled") ? "warning" : "info");
}

function mergeConfirmSummary(plan: MergePlan, options: Pick<MergeOptions, "deleteFork">): string {
	return [
		`Entries to merge: ${plan.entriesToAppend.length}`,
		`Already present: ${plan.duplicateCount}`,
		`After merge: ${options.deleteFork ? "delete fork and close this pane" : "keep fork"}`,
		"",
		"After merging, restart the parent with:",
		parentRestartCommand(plan.parentSessionFile),
	].join("\n");
}

function mergeCompleteMessage(plan: MergePlan, cleanupMessage?: string): string {
	return [
		`Merged /fux fork into parent.${cleanupMessage ? ` ${cleanupMessage}` : ""}`,
		"",
		"Restart the parent session with:",
		parentRestartCommand(plan.parentSessionFile),
	].join("\n");
}

async function confirmMergeAction(plan: MergePlan, options: MergeOptions, ctx: ExtensionCommandContext, title: string, lead: string): Promise<boolean> {
	if (options.yes || !ctx.hasUI) return true;
	return ctx.ui.confirm(title, `${lead}\n\n${mergeConfirmSummary(plan, options)}`);
}

async function doFux(pi: ExtensionAPI, ctx: ExtensionCommandContext, prompt?: string): Promise<void> {
	const currentSessionFile = ctx.sessionManager.getSessionFile();
	if (!currentSessionFile) {
		ctx.ui.notify("Cannot /fux an in-memory session. Start pi with session persistence enabled.", "warning");
		throw new Error("No persisted session");
	}

	if (!existsSync(currentSessionFile)) {
		ctx.ui.notify("Current session has not been written to disk yet, so there is nothing to fork.", "warning");
		throw new Error("Session not written to disk");
	}

	const leafId = ctx.sessionManager.getLeafId();
	if (!leafId) {
		ctx.ui.notify("Current session has no messages to fork yet.", "warning");
		throw new Error("No leaf id");
	}

	const { SessionManager } = await loadSessionManager();
	const sourceManager = SessionManager.open(currentSessionFile, ctx.sessionManager.getSessionDir());
	const forkedSessionFile = sourceManager.createBranchedSession(leafId);
	if (!forkedSessionFile) {
		ctx.ui.notify("Failed to create a persisted fork for this session.", "error");
		throw new Error("Failed to create branched session");
	}

	const childPrompt = normalizePromptInput(prompt);
	const forkMetadata: FuxForkMetadata = {
		kind: "fork" as const,
		version: FUX_METADATA_VERSION,
		parentSessionFile: canonicalPath(currentSessionFile),
		forkedSessionFile: canonicalPath(forkedSessionFile),
		forkedFromEntryId: leafId,
		createdAt: new Date().toISOString(),
		mergeReminder: [
			"[fux context] This session is a fux fork for focused exploration.",
			"[fux context] This is status info only — do not discuss fux/merging unless the user asks.",
			"[fux context] To merge back later:",
			"  1. The user runs /fux merge --dry-run to preview",
			"  2. The user runs /fux merge to confirm and merge into parent",
			"  3. Restart the parent pi session (pi --resume <parent-path>)",
			"  4. By default the fork session is deleted and this pane closes",
			"[fux context] Merge and delete are slash-command-only; they are not LLM tools.",
		].join("\n"),
		...(childPrompt ? { prompt: childPrompt } : {}),
	};

	const childGuidance = childForkGuidanceMessage(forkMetadata.parentSessionFile);
	const parentGuidance = parentForkGuidanceMessage(forkMetadata.parentSessionFile);
	appendForkMetadata(sourceManager, { ...forkMetadata, recordedIn: "child" });
	sourceManager.appendCustomMessageEntry(FUX_CUSTOM_TYPE, childGuidance, true, {
		kind: "fork_guidance",
		role: "child",
		version: FUX_METADATA_VERSION,
		parentSessionFile: forkMetadata.parentSessionFile,
		forkedSessionFile: forkMetadata.forkedSessionFile,
	});
	appendParentForkMetadata(pi, { ...forkMetadata, recordedIn: "parent" });
	pi.sendMessage({
		customType: FUX_CUSTOM_TYPE,
		content: parentGuidance,
		display: true,
		details: {
			kind: "fork_guidance",
			role: "parent",
			version: FUX_METADATA_VERSION,
			parentSessionFile: forkMetadata.parentSessionFile,
			forkedSessionFile: forkMetadata.forkedSessionFile,
		},
	});
	labelForkPoint(pi, ctx, leafId, forkedSessionFile, childPrompt);
	updateFuxWidget(ctx);

	const command = buildForkPaneCommand(forkedSessionFile);
	const paneId = await runTmuxSplit(command, ctx.cwd);
	if (childPrompt) {
		await sendPromptToPane(paneId, childPrompt);
	}
	ctx.ui.notify(`Fork opened in a new tmux pane: ${forkedSessionFile}${childPrompt ? " and prompt sent" : ""}`, "info");
}

async function fux(ctx: ExtensionCommandContext, pi: ExtensionAPI, prompt?: string): Promise<void> {
	if (!ctx.isIdle()) {
		ctx.ui.notify("Press Escape to stop the current turn, then run /fux again.", "warning");
		return;
	}

	await doFux(pi, ctx, prompt);
}

async function doMergeFux(args: string, ctx: ExtensionCommandContext): Promise<string> {
	const options = parseMergeArgs(args);
	const currentSessionFile = ctx.sessionManager.getSessionFile();
	if (!currentSessionFile && !options.childSessionPath) {
		throw new Error("Cannot /fux merge an in-memory session without an explicit child session path.");
	}

	const childSessionFile = options.childSessionPath ? resolveSessionPath(options.childSessionPath, ctx.cwd) : currentSessionFile!;
	if (!existsSync(childSessionFile)) {
		throw new Error(`Child session file does not exist: ${childSessionFile}`);
	}

	const plan = await planFuxMerge(childSessionFile);
	if (currentSessionFile && samePath(currentSessionFile, plan.parentSessionFile)) {
		throw new Error("Run /fux merge from the child session, not from the parent session. Updating the active parent session file behind pi's back is unsafe.");
	}

	if (options.dryRun) {
		return `Dry run only; no files changed.\n${mergeConfirmSummary(plan, options)}`;
	}

	if (plan.entriesToAppend.length === 0) {
		if (!options.deleteFork) {
			return `Nothing new to merge.\n${mergeConfirmSummary(plan, options)}`;
		}

		const ok = await confirmMergeAction(
			plan,
			options,
			ctx,
			"Delete /fux child session?",
			"There are no new entries to merge. The child fork can be deleted.",
		);
		if (!ok) {
			return "Cancelled /fux merge.";
		}

		const cleanupMessage = await cleanupForkAfterMerge(plan, ctx);
		return `Nothing new to merge. ${cleanupMessage ?? ""}`;
	}

	const ok = await confirmMergeAction(
		plan,
		options,
		ctx,
		"Merge /fux fork?",
		"This writes the fork branch into the parent session and creates a backup first.",
	);
	if (!ok) {
		return "Cancelled /fux merge.";
	}

	await writeFuxMerge(plan);
	const cleanupMessage = options.deleteFork ? await cleanupForkAfterMerge(plan, ctx) : undefined;
	return mergeCompleteMessage(plan, cleanupMessage);
}

async function mergeFux(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.isIdle()) {
		notify(ctx, "Press Escape to stop the current turn, then run /fux merge again.", "warning");
		return;
	}

	const message = await doMergeFux(args, ctx);
	notify(ctx, message, message.startsWith("Cancelled") ? "warning" : "info");
}

function splitSubcommand(args: string): { subcommand: string; rest: string } | undefined {
	const trimmed = args.trim();
	if (!trimmed) return undefined;
	const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
	if (!match) return undefined;
	return { subcommand: match[1].toLowerCase(), rest: match[2] ?? "" };
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		updateFuxWidget(ctx);
	});

	pi.on("message_end", (_event, ctx) => {
		updateFuxWidget(ctx);
	});

	pi.registerTool({
		name: "fux_fork",
		label: "Fork Session",
		description: "Fork the current session into a new tmux pane with an optional initial prompt. Use when exploring a tangential topic, trying an approach, or following up on a side discussion without derailing the main session.",
		promptSnippet: "Fork session for focused exploration",
		parameters: Type.Object({
			prompt: Type.Optional(Type.String({ description: "Initial prompt text to send to the forked session (no surrounding quotes needed)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				await doFux(pi, ctx, params.prompt);
				return {
					content: [{ type: "text", text: "Fork created in a new tmux pane." }],
					details: {},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`fux_fork failed: ${message}`);
			}
		},
	});

	// Merge and delete intentionally remain slash-command-only.
	// They can modify session files and close tmux panes, so exposing them as
	// LLM-callable tools lets an agent perform destructive session operations
	// without the user seeing and initiating the slash command first.

	const FUX_SUBCOMMANDS: AutocompleteItem[] = [
		{ value: "prompt", label: "prompt", description: "Fork session with an initial prompt" },
		{ value: "merge", label: "merge", description: "Merge child fork into parent session" },
		{ value: "delete", label: "delete", description: "Delete this fork and close the tmux pane" },
		{ value: "toggle", label: "toggle", description: "Toggle the fux guidance widget" },
		{ value: "help", label: "help", description: "Show usage information" },
	];

	const MERGE_FLAGS: AutocompleteItem[] = [
		{ value: "--yes", label: "--yes", description: "Skip confirmation prompt" },
		{ value: "--dry-run", label: "--dry-run", description: "Show what would happen without making changes" },
		{ value: "--keep", label: "--keep", description: "Keep fork session file after merge" },
		{ value: "--delete", label: "--delete", description: "Delete fork after merge (default)" },
	];

	const DELETE_FLAGS: AutocompleteItem[] = [
		{ value: "--yes", label: "--yes", description: "Skip confirmation prompt" },
	];

	pi.registerCommand(COMMAND_NAME, {
		description: "Fork the current session with /fux prompt [text], merge a child session with /fux merge, or delete a child fork with /fux delete.",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const trimmed = prefix.trim();

			// Completing the subcommand itself
			if (!trimmed || !trimmed.includes(" ")) {
				const matching = FUX_SUBCOMMANDS.filter((s) => s.value.startsWith(trimmed));
				return matching.length > 0 ? matching : null;
			}

			// Parse "subcommand rest"
			const spaceIdx = trimmed.indexOf(" ");
			const subcommand = trimmed.slice(0, spaceIdx).toLowerCase();
			const rest = trimmed.slice(spaceIdx + 1);

			if (subcommand === "merge" || subcommand === "delete") {
				const flags = subcommand === "merge" ? MERGE_FLAGS : DELETE_FLAGS;
				const tokens = rest.split(/\s+/).filter(Boolean);
				const usedFlags = new Set(tokens.filter((p) => p.startsWith("--")));
				const available = flags.filter((f) => !usedFlags.has(f.value));
				const currentWord = tokens.at(-1) ?? "";

				// Build the prefix that precedes the current word so completions
				// replace the full argument string rather than just the flag.
				// e.g. typing "merge --y" should complete to "merge --yes", not "--yes".
				const preceding = currentWord.startsWith("-")
					? tokens.slice(0, -1)
					: tokens;
				const prefixBase = preceding.length > 0
					? `${subcommand} ${preceding.join(" ")} `
					: `${subcommand} `;

				if (currentWord.startsWith("-")) {
					const matching = available.filter((f) => f.value.startsWith(currentWord));
					if (matching.length === 0) return null;
					return matching.map((f) => ({
						value: `${prefixBase}${f.value}`,
						label: f.label,
						description: f.description,
					}));
				}

				return available.map((f) => ({
					value: `${prefixBase}${f.value}`,
					label: f.label,
					description: f.description,
				}));
			}

			// prompt subcommand — free text, no completions
			return null;
		},
		handler: async (args, ctx) => {
			try {
				const parsed = splitSubcommand(args);
				if (!parsed) {
					await fux(ctx, pi);
					return;
				}

				if (parsed.subcommand === "prompt") {
					await fux(ctx, pi, parsed.rest);
					return;
				}

				if (parsed.subcommand === "merge") {
					await mergeFux(parsed.rest, ctx);
					return;
				}

				if (parsed.subcommand === "delete") {
					await deleteFux(parsed.rest, ctx);
					return;
				}

				if (parsed.subcommand === "toggle") {
					toggleFuxWidget(pi, ctx);
					return;
				}

				if (parsed.subcommand === "help" || parsed.subcommand === "--help" || parsed.subcommand === "-h") {
					notify(ctx, "Usage: /fux or /fux prompt [text] to fork; /fux merge [--dry-run] [--yes] [--keep|--delete] [child-session-path] to merge; /fux delete [--yes] to delete this fork and close the pane; /fux toggle to show/hide guidance widget.", "info");
					return;
				}

				notify(ctx, `Unknown /fux subcommand: ${parsed.subcommand}. Usage: /fux [prompt [text]|merge ...]`, "warning");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, `/fux failed: ${message}`, "error");
			}
		},
	});
}
