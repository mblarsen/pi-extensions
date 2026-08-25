import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, realpathSync, statSync } from "node:fs";
import { copyFile, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { pathToFileURL } from "node:url";

const COMMAND_NAME = "ferd";
const FERD_CUSTOM_TYPE = "ferd";
const FERD_WIDGET_KEY = "ferd-status";
const FERD_METADATA_VERSION = 1;

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

type FerdForkMetadata = {
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

type FerdMergeMetadata = {
	kind: "merge";
	version: number;
	childSessionFile: string;
	forkedFromEntryId: string;
	mergedEntryCount: number;
	mergedLeafId: string | null;
	backupFile: string;
	mergedAt: string;
};

type FerdWidgetState = {
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
		"printf '\\n[ferd] pi exited with status %s. Pane kept open; exit this shell to close it.\\n' \"$status\"",
		"exec \"${SHELL:-/bin/sh}\" -l",
	].join("\n");
	return `sh -lc ${shellQuote(script)}`;
}

async function runHerdr(args: string[], description: string): Promise<string> {
	return new Promise<string>((resolvePromise, reject) => {
		const child = spawn("herdr", args, {
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

function herdrPaneId(output: string, description: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		throw new Error(`${description} returned invalid JSON.`);
	}

	const paneId = (parsed as { result?: { pane?: { pane_id?: unknown } } }).result?.pane?.pane_id;
	if (typeof paneId !== "string" || !paneId) {
		throw new Error(`${description} did not return a pane id.`);
	}
	return paneId;
}

async function runHerdrSplit(command: string, cwd: string): Promise<string> {
	if (process.env.HERDR_ENV !== "1") {
		throw new Error("Not running inside Herdr; cannot create a Herdr pane.");
	}

	const splitOutput = await runHerdr(
		["pane", "split", "--current", "--direction", "right", "--cwd", cwd, "--focus"],
		"herdr pane split",
	);
	const paneId = herdrPaneId(splitOutput, "herdr pane split");
	try {
		await runHerdr(["pane", "run", paneId, command], "herdr pane run");
	} catch (error) {
		await runHerdr(["pane", "close", paneId], "herdr pane close").catch(() => undefined);
		throw error;
	}
	return paneId;
}

async function getCurrentHerdrPaneId(): Promise<string | undefined> {
	if (process.env.HERDR_ENV !== "1") return undefined;
	if (process.env.HERDR_PANE_ID) return process.env.HERDR_PANE_ID;
	try {
		const output = await runHerdr(["pane", "current", "--current"], "herdr pane current");
		return herdrPaneId(output, "herdr pane current");
	} catch {
		return undefined;
	}
}

async function sendPromptToPane(paneId: string, prompt: string): Promise<void> {
	const deadline = Date.now() + 30_000;
	let agentReady = false;
	while (Date.now() < deadline) {
		try {
			await runHerdr(["agent", "get", paneId], "herdr agent get");
			agentReady = true;
			break;
		} catch {
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
		}
	}
	if (!agentReady) {
		throw new Error(`Timed out waiting for Pi to start in Herdr pane ${paneId}.`);
	}
	await runHerdr(["agent", "wait", paneId, "--timeout", "30000"], "herdr agent wait");
	await runHerdr(["agent", "prompt", paneId, prompt], "herdr agent prompt");
}

function appendForkMetadata(
	sessionManager: { appendCustomEntry(customType: string, data?: unknown): string },
	metadata: FerdForkMetadata,
): void {
	sessionManager.appendCustomEntry(FERD_CUSTOM_TYPE, metadata);
}

function parentRestartCommand(parentSessionFile: string): string {
	return `pi --resume ${parentSessionFile}`;
}

function parentForkGuidanceMessage(parentSessionFile: string): string {
	return [
		"[ferd status] A child fork has been started in another pane for side exploration.",
		"[ferd status] This message is context only; continue your work normally.",
		"[ferd status] When the child merges back, restart this parent with:",
		parentRestartCommand(parentSessionFile),
	].join("\n");
}

function childForkGuidanceMessage(parentSessionFile: string): string {
	return [
		"[ferd status] This session is a ferd fork — a side branch for focused exploration.",
		"[ferd status] This message is context only; do not act on it or discuss ferd/merging unless the user explicitly asks.",
		"[ferd status] If the user later wants to merge back, they can run /ferd merge --dry-run to preview, then /ferd merge to confirm.",
		"[ferd status] After merge, restart the parent with:",
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

function renderFerdWidgetLines(state: FerdWidgetState, width: number): string[] {
	if (state.role === "child") {
		return [
			widgetTop("ferd", "fork", width),
			widgetLine(" Use `/ferd merge` to combine with parent session again.", width),
			widgetBottom(width),
		];
	}

	const inner = Math.max(0, width - 4);
	const lines = [widgetTop("ferd", "parent", width)];
	lines.push(widgetLine(" Parent pane; child fork opened.", width));
	lines.push(widgetLine(" After merge, restart:", width));
	for (const chunk of wrapPlain(parentRestartCommand(state.parentSessionFile), inner)) {
		lines.push(widgetLine(` ${chunk}`, width));
	}
	lines.push(widgetBottom(width));
	return lines;
}

function maybeFerdForkMetadata(entry: unknown): (FerdForkMetadata & JsonObject) | undefined {
	const data = ferdData(entry);
	return isFerdForkMetadata(data) ? data : undefined;
}

function ferdWidgetVisibility(entry: unknown): boolean | undefined {
	const data = ferdData(entry);
	if (data?.kind === "widget_hidden") return false;
	if (data?.kind === "widget_visibility" && typeof data.visible === "boolean") return data.visible;
	return undefined;
}

function findFerdWidgetState(ctx: ExtensionContext, respectVisibility = true): FerdWidgetState | undefined {
	const branch = ctx.sessionManager.getBranch();
	if (respectVisibility) {
		const latestVisibilityIndex = branch.findLastIndex((entry) => ferdWidgetVisibility(entry) !== undefined);
		if (latestVisibilityIndex >= 0 && ferdWidgetVisibility(branch[latestVisibilityIndex]) === false) {
			return undefined;
		}
	}

	for (let index = branch.length - 1; index >= 0; index--) {
		const metadata = maybeFerdForkMetadata(branch[index]);
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
		const metadata = maybeFerdForkMetadata(branch[index]);
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

function setFerdWidget(ctx: ExtensionContext, state: FerdWidgetState): void {
	ctx.ui.setWidget(
		FERD_WIDGET_KEY,
		() => ({
			invalidate() {},
			render(width: number) {
				return renderFerdWidgetLines(state, width);
			},
		}),
		{ placement: "aboveEditor" },
	);
}

function updateFerdWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const state = findFerdWidgetState(ctx);
	if (!state) {
		ctx.ui.setWidget(FERD_WIDGET_KEY, undefined);
		return;
	}
	setFerdWidget(ctx, state);
}

function toggleFerdWidget(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
	const visibleState = findFerdWidgetState(ctx);
	if (visibleState) {
		pi.appendEntry(FERD_CUSTOM_TYPE, {
			kind: "widget_visibility",
			visible: false,
			updatedAt: new Date().toISOString(),
		});
		ctx.ui.setWidget(FERD_WIDGET_KEY, undefined);
		notify(ctx, "Ferd widget off.", "info");
		return;
	}

	const hiddenState = findFerdWidgetState(ctx, false);
	if (!hiddenState) {
		notify(ctx, "No ferd widget to toggle in this branch.", "warning");
		return;
	}

	pi.appendEntry(FERD_CUSTOM_TYPE, {
		kind: "widget_visibility",
		visible: true,
		updatedAt: new Date().toISOString(),
	});
	setFerdWidget(ctx, hiddenState);
	notify(ctx, "Ferd widget on.", "info");
}

function appendParentForkMetadata(pi: ExtensionAPI, metadata: FerdForkMetadata): void {
	pi.appendEntry(FERD_CUSTOM_TYPE, metadata);
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
	const forkLabel = `ferd → ${shortSessionId(childSessionFile)}${promptSuffix}`;
	if (!existingLabel) return forkLabel;
	if (existingLabel.includes(forkLabel)) return existingLabel;
	return `${existingLabel} · ${forkLabel}`;
}

function labelForkPoint(pi: ExtensionAPI, ctx: ExtensionContext, entryId: string, childSessionFile: string, prompt?: string): void {
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
		throw new Error(`Unexpected /ferd merge argument: ${part}`);
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
		throw new Error(`Unexpected /ferd delete argument: ${part}`);
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

function ferdData(entry: unknown): JsonObject | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as JsonObject;
	if (record.type !== "custom") return undefined;
	if (record.customType !== FERD_CUSTOM_TYPE) return undefined;
	const data = record.data;
	return data && typeof data === "object" ? (data as JsonObject) : undefined;
}

function isFerdForkMetadata(data: JsonObject | undefined): data is FerdForkMetadata & JsonObject {
	return (
		data?.kind === "fork" &&
		typeof data.parentSessionFile === "string" &&
		typeof data.forkedFromEntryId === "string"
	);
}

function isSkippableFerdEntry(entry: SessionEntry): boolean {
	if ((entry.type === "custom" || entry.type === "custom_message") && (entry as JsonObject).customType === FERD_CUSTOM_TYPE) {
		return true;
	}
	const data = ferdData(entry);
	return data?.kind === "fork" || data?.kind === "merge";
}

function findForkMetadata(childEntries: SessionEntry[], parentSessionFile: string): FerdForkMetadata | undefined {
	for (let index = childEntries.length - 1; index >= 0; index--) {
		const data = ferdData(childEntries[index]);
		if (!isFerdForkMetadata(data)) continue;
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
	data: FerdMergeMetadata,
): SessionEntry | undefined {
	if (!parentOldLeafId) return undefined;

	const marker: SessionEntry = {
		type: "custom",
		id: generateEntryId(usedIds),
		parentId: parentOldLeafId,
		timestamp: new Date().toISOString(),
		customType: FERD_CUSTOM_TYPE,
		data,
	};
	entries.push(marker);
	usedIds.add(marker.id);
	return marker;
}

async function planFerdMerge(childSessionFile: string): Promise<MergePlan> {
	const child = await readSession(childSessionFile);
	const parentSessionFromHeader = child.header.parentSession;
	if (!parentSessionFromHeader) {
		throw new Error("This session does not record a parentSession; it does not look like a /ferd child session.");
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
		throw new Error("Could not determine where the child forked from. New /ferd sessions record this automatically; older sessions may need manual merging.");
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

		if (isSkippableFerdEntry(childEntry) || shouldSkipLabel(childEntry, idMap)) {
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
	const backupFile = `${parentSessionFile}.before-ferd-merge-${timestamp}.bak`;

	if (entriesToAppend.length > 0) {
		const mergeMetadata = {
			kind: "merge" as const,
			version: FERD_METADATA_VERSION,
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

async function writeFerdMerge(plan: MergePlan): Promise<void> {
	const latestStat = statSync(plan.parentSessionFile);
	if (plan.parentStat.mtimeMs !== latestStat.mtimeMs || plan.parentStat.size !== latestStat.size) {
		throw new Error("Parent session changed while preparing the merge; aborting. Re-run /ferd merge when it is at rest.");
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

function scheduleDeleteAndClosePane(sessionFile: string, paneId: string): void {
	const script = [
		"sleep 0.8",
		"if command -v trash >/dev/null 2>&1; then trash \"$1\" 2>/dev/null || rm -f \"$1\"; else rm -f \"$1\"; fi",
		"herdr pane close \"$2\" >/dev/null 2>&1 || true",
	].join("; ");
	const child = spawn("sh", ["-c", script, "ferd-cleanup", sessionFile, paneId], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}

async function cleanupForkAfterMerge(plan: MergePlan, ctx: ExtensionCommandContext): Promise<string | undefined> {
	const currentSessionFile = ctx.sessionManager.getSessionFile();
	const activeChild = currentSessionFile ? samePath(currentSessionFile, plan.childSessionFile) : false;

	if (activeChild) {
		const paneId = await getCurrentHerdrPaneId();
		if (paneId) {
			scheduleDeleteAndClosePane(plan.childSessionFile, paneId);
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

function isCurrentFerdChildSession(session: ParsedSession, sessionFile: string): boolean {
	const parentSessionFile = session.header.parentSession;
	if (!parentSessionFile) return false;
	return session.sessionEntries.some((entry) => {
		const data = ferdData(entry);
		return isFerdForkMetadata(data) && samePath(data.parentSessionFile, parentSessionFile) && samePath(data.forkedSessionFile, sessionFile);
	});
}

function deleteForkWarning(sessionFile: string, parentSessionFile: string): string {
	return [
		"This will delete this /ferd fork and close this Herdr pane.",
		"Nothing will be merged into the parent.",
		"",
		`Fork: ${sessionFile}`,
		`Parent: ${parentSessionFile}`,
	].join("\n");
}

async function deleteCurrentFork(sessionFile: string, ctx: ExtensionCommandContext): Promise<string> {
	const paneId = await getCurrentHerdrPaneId();
	if (paneId) {
		scheduleDeleteAndClosePane(sessionFile, paneId);
		ctx.shutdown();
		return "Fork session will be deleted and this pane will close.";
	}

	const result = await deleteSessionFile(sessionFile);
	ctx.shutdown();
	return `Fork session ${result}; agent will shut down.`;
}

async function doDeleteFerd(args: string, ctx: ExtensionCommandContext): Promise<string> {
	const options = parseDeleteArgs(args);
	const currentSessionFile = ctx.sessionManager.getSessionFile();
	if (!currentSessionFile) {
		throw new Error("Cannot /ferd delete an in-memory session.");
	}

	const sessionFile = canonicalPath(currentSessionFile);
	const session = await readSession(sessionFile);
	if (!isCurrentFerdChildSession(session, sessionFile)) {
		throw new Error("Run /ferd delete from a /ferd child fork session. Refusing to delete this session.");
	}

	if (!options.yes) {
		if (!ctx.hasUI) {
			throw new Error("Deleting a fork requires --yes when no confirmation UI is available.");
		}
		const ok = await ctx.ui.confirm("Delete /ferd fork?", deleteForkWarning(sessionFile, session.header.parentSession!));
		if (!ok) return "Cancelled /ferd delete.";
	}

	return deleteCurrentFork(sessionFile, ctx);
}

async function deleteFerd(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.isIdle()) {
		notify(ctx, "Press Escape to stop the current turn, then run /ferd delete again.", "warning");
		return;
	}

	const message = await doDeleteFerd(args, ctx);
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
		`Merged /ferd fork into parent.${cleanupMessage ? ` ${cleanupMessage}` : ""}`,
		"",
		"Restart the parent session with:",
		parentRestartCommand(plan.parentSessionFile),
	].join("\n");
}

async function confirmMergeAction(plan: MergePlan, options: MergeOptions, ctx: ExtensionCommandContext, title: string, lead: string): Promise<boolean> {
	if (options.yes || !ctx.hasUI) return true;
	return ctx.ui.confirm(title, `${lead}\n\n${mergeConfirmSummary(plan, options)}`);
}

async function doFerd(pi: ExtensionAPI, ctx: ExtensionContext, prompt?: string): Promise<void> {
	const currentSessionFile = ctx.sessionManager.getSessionFile();
	if (!currentSessionFile) {
		ctx.ui.notify("Cannot /ferd an in-memory session. Start pi with session persistence enabled.", "warning");
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
	const forkMetadata: FerdForkMetadata = {
		kind: "fork" as const,
		version: FERD_METADATA_VERSION,
		parentSessionFile: canonicalPath(currentSessionFile),
		forkedSessionFile: canonicalPath(forkedSessionFile),
		forkedFromEntryId: leafId,
		createdAt: new Date().toISOString(),
		mergeReminder: [
			"[ferd context] This session is a ferd fork for focused exploration.",
			"[ferd context] This is status info only — do not discuss ferd/merging unless the user asks.",
			"[ferd context] To merge back later:",
			"  1. The user runs /ferd merge --dry-run to preview",
			"  2. The user runs /ferd merge to confirm and merge into parent",
			"  3. Restart the parent pi session (pi --resume <parent-path>)",
			"  4. By default the fork session is deleted and this pane closes",
			"[ferd context] Merge and delete are slash-command-only; they are not LLM tools.",
		].join("\n"),
		...(childPrompt ? { prompt: childPrompt } : {}),
	};

	const childGuidance = childForkGuidanceMessage(forkMetadata.parentSessionFile);
	const parentGuidance = parentForkGuidanceMessage(forkMetadata.parentSessionFile);
	appendForkMetadata(sourceManager, { ...forkMetadata, recordedIn: "child" });
	sourceManager.appendCustomMessageEntry(FERD_CUSTOM_TYPE, childGuidance, true, {
		kind: "fork_guidance",
		role: "child",
		version: FERD_METADATA_VERSION,
		parentSessionFile: forkMetadata.parentSessionFile,
		forkedSessionFile: forkMetadata.forkedSessionFile,
	});
	appendParentForkMetadata(pi, { ...forkMetadata, recordedIn: "parent" });
	pi.sendMessage({
		customType: FERD_CUSTOM_TYPE,
		content: parentGuidance,
		display: true,
		details: {
			kind: "fork_guidance",
			role: "parent",
			version: FERD_METADATA_VERSION,
			parentSessionFile: forkMetadata.parentSessionFile,
			forkedSessionFile: forkMetadata.forkedSessionFile,
		},
	});
	labelForkPoint(pi, ctx, leafId, forkedSessionFile, childPrompt);
	updateFerdWidget(ctx);

	const command = buildForkPaneCommand(forkedSessionFile);
	const paneId = await runHerdrSplit(command, ctx.cwd);
	if (childPrompt) {
		await sendPromptToPane(paneId, childPrompt);
	}
	ctx.ui.notify(`Fork opened in Herdr pane ${paneId}: ${forkedSessionFile}${childPrompt ? " and prompt sent" : ""}`, "info");
}

async function ferd(ctx: ExtensionCommandContext, pi: ExtensionAPI, prompt?: string): Promise<void> {
	if (!ctx.isIdle()) {
		ctx.ui.notify("Press Escape to stop the current turn, then run /ferd again.", "warning");
		return;
	}

	await doFerd(pi, ctx, prompt);
}

async function doMergeFerd(args: string, ctx: ExtensionCommandContext): Promise<string> {
	const options = parseMergeArgs(args);
	const currentSessionFile = ctx.sessionManager.getSessionFile();
	if (!currentSessionFile && !options.childSessionPath) {
		throw new Error("Cannot /ferd merge an in-memory session without an explicit child session path.");
	}

	const childSessionFile = options.childSessionPath ? resolveSessionPath(options.childSessionPath, ctx.cwd) : currentSessionFile!;
	if (!existsSync(childSessionFile)) {
		throw new Error(`Child session file does not exist: ${childSessionFile}`);
	}

	const plan = await planFerdMerge(childSessionFile);
	if (currentSessionFile && samePath(currentSessionFile, plan.parentSessionFile)) {
		throw new Error("Run /ferd merge from the child session, not from the parent session. Updating the active parent session file behind pi's back is unsafe.");
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
			"Delete /ferd child session?",
			"There are no new entries to merge. The child fork can be deleted.",
		);
		if (!ok) {
			return "Cancelled /ferd merge.";
		}

		const cleanupMessage = await cleanupForkAfterMerge(plan, ctx);
		return `Nothing new to merge. ${cleanupMessage ?? ""}`;
	}

	const ok = await confirmMergeAction(
		plan,
		options,
		ctx,
		"Merge /ferd fork?",
		"This writes the fork branch into the parent session and creates a backup first.",
	);
	if (!ok) {
		return "Cancelled /ferd merge.";
	}

	await writeFerdMerge(plan);
	const cleanupMessage = options.deleteFork ? await cleanupForkAfterMerge(plan, ctx) : undefined;
	return mergeCompleteMessage(plan, cleanupMessage);
}

async function mergeFerd(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.isIdle()) {
		notify(ctx, "Press Escape to stop the current turn, then run /ferd merge again.", "warning");
		return;
	}

	const message = await doMergeFerd(args, ctx);
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
		updateFerdWidget(ctx);
	});

	pi.on("message_end", (_event, ctx) => {
		updateFerdWidget(ctx);
	});

	pi.registerTool({
		name: "ferd_fork",
		label: "Fork Session",
		description: "Fork the current session into a new Herdr pane with an optional initial prompt. Use when exploring a tangential topic, trying an approach, or following up on a side discussion without derailing the main session.",
		promptSnippet: "Fork session for focused exploration",
		parameters: Type.Object({
			prompt: Type.Optional(Type.String({ description: "Initial prompt text to send to the forked session (no surrounding quotes needed)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				await doFerd(pi, ctx, params.prompt);
				return {
					content: [{ type: "text", text: "Fork created in a new Herdr pane." }],
					details: {},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`ferd_fork failed: ${message}`);
			}
		},
	});

	// Merge and delete intentionally remain slash-command-only.
	// They can modify session files and close Herdr panes, so exposing them as
	// LLM-callable tools lets an agent perform destructive session operations
	// without the user seeing and initiating the slash command first.

	const FERD_SUBCOMMANDS: AutocompleteItem[] = [
		{ value: "prompt", label: "prompt", description: "Fork session with an initial prompt" },
		{ value: "merge", label: "merge", description: "Merge child fork into parent session" },
		{ value: "delete", label: "delete", description: "Delete this fork and close the Herdr pane" },
		{ value: "toggle", label: "toggle", description: "Toggle the ferd guidance widget" },
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
		description: "Fork the current session with /ferd prompt [text], merge a child session with /ferd merge, or delete a child fork with /ferd delete.",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const trimmed = prefix.trim();

			// Completing the subcommand itself
			if (!trimmed || !trimmed.includes(" ")) {
				const matching = FERD_SUBCOMMANDS.filter((s) => s.value.startsWith(trimmed));
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
					await ferd(ctx, pi);
					return;
				}

				if (parsed.subcommand === "prompt") {
					await ferd(ctx, pi, parsed.rest);
					return;
				}

				if (parsed.subcommand === "merge") {
					await mergeFerd(parsed.rest, ctx);
					return;
				}

				if (parsed.subcommand === "delete") {
					await deleteFerd(parsed.rest, ctx);
					return;
				}

				if (parsed.subcommand === "toggle") {
					toggleFerdWidget(pi, ctx);
					return;
				}

				if (parsed.subcommand === "help" || parsed.subcommand === "--help" || parsed.subcommand === "-h") {
					notify(ctx, "Usage: /ferd or /ferd prompt [text] to fork; /ferd merge [--dry-run] [--yes] [--keep|--delete] [child-session-path] to merge; /ferd delete [--yes] to delete this fork and close the pane; /ferd toggle to show/hide guidance widget.", "info");
					return;
				}

				notify(ctx, `Unknown /ferd subcommand: ${parsed.subcommand}. Usage: /ferd [prompt [text]|merge ...]`, "warning");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, `/ferd failed: ${message}`, "error");
			}
		},
	});
}
