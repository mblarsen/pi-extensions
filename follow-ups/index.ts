/**
 * Follow-ups extension - capture notes anchored to an agent message and queue them
 * for later dispatch into the chat thread or a new branch.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

const COMMAND_NAME = "follow-up";
const FOLLOW_UPS_FILE = ".pi/follow-ups.jsonl";
const SNIPPET_MAX_LEN = 240;

type Scope = "session" | "project";

interface FollowUpAnchor {
	sessionId: string;
	nodeId: string;
	worktreeRoot: string;
}

interface FollowUp {
	id: string;
	createdAt: string;
	message: string;
	anchor: FollowUpAnchor;
	contextSnippet: string;
	done: boolean;
}

function oneLineSnippet(text: string, maxLength = 96): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (!oneLine) return "(no text)";
	return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 1)}…` : oneLine;
}

function textFromEntry(entry: SessionEntry): string {
	if (entry.type !== "message") return "";
	const msg = entry.message as { role?: unknown; content?: unknown };
	const content = msg.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as { type?: unknown; text?: unknown; thinking?: unknown; toolCall?: unknown; name?: unknown; arguments?: unknown };
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "thinking" && typeof block.thinking === "string") return block.thinking;
			if (block.type === "toolCall" && typeof block.name === "string") return `[tool call: ${block.name}]`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function findProjectRoot(cwd: string): string | undefined {
	// Walk up from cwd looking for .git/.pi marker, but stop at filesystem root.
	let current = resolve(cwd);
	while (true) {
		if (existsSync(join(current, ".pi")) || existsSync(join(current, ".git"))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

function followUpsPath(ctx: ExtensionContext): string | undefined {
	const projectRoot = findProjectRoot(ctx.cwd);
	if (!projectRoot) return undefined;
	return join(projectRoot, FOLLOW_UPS_FILE);
}

async function loadFollowUps(path: string): Promise<FollowUp[]> {
	if (!existsSync(path)) return [];
	const content = await readFile(path, "utf8");
	const items: FollowUp[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			items.push(JSON.parse(line) as FollowUp);
		} catch {
			// skip corrupt lines
		}
	}
	return items;
}

async function saveFollowUps(path: string, items: FollowUp[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const lines = items.map((item) => JSON.stringify(item)).join("\n");
	await writeFile(path, lines ? `${lines}\n` : "", "utf8");
}

function activeItems(items: FollowUp[]): FollowUp[] {
	return items.filter((item) => !item.done);
}

function doneItems(items: FollowUp[]): FollowUp[] {
	return items.filter((item) => item.done);
}

function filterByScope(items: FollowUp[], scope: Scope, ctx: ExtensionContext): FollowUp[] {
	const sessionId = ctx.sessionManager.getSessionId();
	if (scope === "session") {
		return items.filter((item) => item.anchor.sessionId === sessionId);
	}
	return items;
}

function findLastAssistantEntry(ctx: ExtensionContext): SessionEntry | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const msg = entry.message as { role?: unknown };
		if (msg.role !== "assistant") continue;
		if (!textFromEntry(entry).trim()) continue;
		return entry;
	}
	return undefined;
}

function buildAnchor(ctx: ExtensionContext): FollowUpAnchor | undefined {
	const targetEntry = findLastAssistantEntry(ctx);
	if (!targetEntry) return undefined;
	const projectRoot = findProjectRoot(ctx.cwd);
	if (!projectRoot) return undefined;
	return {
		sessionId: ctx.sessionManager.getSessionId(),
		nodeId: targetEntry.id,
		worktreeRoot: projectRoot,
	};
}

function buildContextSnippet(ctx: ExtensionContext): string {
	const targetEntry = findLastAssistantEntry(ctx);
	if (!targetEntry) return "";
	const text = textFromEntry(targetEntry);
	const snippet = text.slice(0, SNIPPET_MAX_LEN);
	return text.length > SNIPPET_MAX_LEN ? `${snippet}…` : snippet;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
	}
}

class FollowUpListComponent {
	private items: FollowUp[];
	private theme: import("@earendil-works/pi-coding-agent").Theme;
	private onClose: () => void;
	private onPop: (item: FollowUp, mode: "direct" | "branch") => void;
	private onEdit: (item: FollowUp) => void;
	private onSave: (items: FollowUp[]) => void;
	private onNewFromAnchor: (anchor: FollowUpAnchor) => void;
	private scope: Scope;
	private selectedIndex = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private deleteConfirmItem?: FollowUp;

	constructor(
		items: FollowUp[],
		scope: Scope,
		theme: import("@earendil-works/pi-coding-agent").Theme,
		onClose: () => void,
		onPop: (item: FollowUp, mode: "direct" | "branch") => void,
		onEdit: (item: FollowUp) => void,
		onSave: (items: FollowUp[]) => void,
		onNewFromAnchor: (anchor: FollowUpAnchor) => void,
	) {
		this.items = items;
		this.scope = scope;
		this.theme = theme;
		this.onClose = onClose;
		this.onPop = onPop;
		this.onEdit = onEdit;
		this.onSave = onSave;
		this.onNewFromAnchor = onNewFromAnchor;
	}

	private visibleItems(): FollowUp[] {
		return [...activeItems(this.items), ...doneItems(this.items)];
	}

	private selectedItem(): FollowUp | undefined {
		return this.visibleItems()[this.selectedIndex];
	}

	handleInput(data: string): void {
		const visible = this.visibleItems();

		if (this.deleteConfirmItem) {
			if (matchesKey(data, "y")) {
				this.items = this.items.filter((i) => i.id !== this.deleteConfirmItem!.id);
				this.onSave(this.items);
				this.deleteConfirmItem = undefined;
				this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.visibleItems().length - 1));
				this.invalidate();
				return;
			}
			if (matchesKey(data, "n") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				this.deleteConfirmItem = undefined;
				this.invalidate();
				return;
			}
			return;
		}

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.onClose();
			return;
		}

		if (matchesKey(data, "j") || matchesKey(data, "down")) {
			this.selectedIndex = Math.min(this.selectedIndex + 1, Math.max(0, visible.length - 1));
			this.invalidate();
			return;
		}

		if (matchesKey(data, "k") || matchesKey(data, "up")) {
			this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
			this.invalidate();
			return;
		}


		if (matchesKey(data, "u")) {
			if (this.selectedIndex > 0) {
				const prev = this.selectedIndex - 1;
				const currentItem = visible[this.selectedIndex];
				const prevItem = visible[prev];
				const idxCurrent = this.items.findIndex((i) => i.id === currentItem.id);
				const idxPrev = this.items.findIndex((i) => i.id === prevItem.id);
				if (idxCurrent >= 0 && idxPrev >= 0) {
					[this.items[idxCurrent], this.items[idxPrev]] = [this.items[idxPrev], this.items[idxCurrent]];
					this.onSave(this.items);
					this.selectedIndex = prev;
					this.invalidate();
				}
			}
			return;
		}

		if (matchesKey(data, "d")) {
			if (this.selectedIndex < visible.length - 1) {
				const next = this.selectedIndex + 1;
				const currentItem = visible[this.selectedIndex];
				const nextItem = visible[next];
				const idxCurrent = this.items.findIndex((i) => i.id === currentItem.id);
				const idxNext = this.items.findIndex((i) => i.id === nextItem.id);
				if (idxCurrent >= 0 && idxNext >= 0) {
					[this.items[idxCurrent], this.items[idxNext]] = [this.items[idxNext], this.items[idxCurrent]];
					this.onSave(this.items);
					this.selectedIndex = next;
					this.invalidate();
				}
			}
			return;
		}

		if (matchesKey(data, "tab")) {
			this.scope = this.scope === "session" ? "project" : "session";
			this.selectedIndex = 0;
			this.invalidate();
			return;
		}

		if (matchesKey(data, "e")) {
			const item = this.selectedItem();
			if (item) this.onEdit(item);
			return;
		}

		if (matchesKey(data, "ctrl+d")) {
			const item = this.selectedItem();
			if (item) {
				this.deleteConfirmItem = item;
				this.invalidate();
			}
			return;
		}

		if (matchesKey(data, "n")) {
			const item = this.selectedItem();
			if (item) this.onNewFromAnchor(item.anchor);
			return;
		}

		if (matchesKey(data, "enter")) {
			const item = this.selectedItem();
			if (!item) return;
			// Simple direct pop for now; branch mode can be added with a follow-up prompt.
			this.onPop(item, "direct");
			return;
		}
	}

	render(termWidth: number): string[] {
		const width = Math.floor(termWidth * 0.9);
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;
		const visible = this.visibleItems();

		lines.push("");
		const title = th.fg("accent", ` Follow-ups (${this.scope}) `);
		const headerLine = th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - title.length - 6)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (visible.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No follow-ups.")}`, width));
		} else {
			for (let index = 0; index < visible.length; index++) {
				const item = visible[index];
				const isSelected = index === this.selectedIndex;
				const isDone = item.done;
				const prefix = isSelected ? th.fg("accent", "› ") : "  ";
				const firstLine = oneLineSnippet(item.message, width - 8);
				const time = new Date(item.createdAt).toLocaleString("sv-SE", {
					year: "numeric",
					month: "2-digit",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit",
				});
				const meta = `${time} · ${oneLineSnippet(item.contextSnippet, Math.max(24, width - time.length - 16))}`;
				const mainColor = isDone ? "dim" : isSelected ? "text" : "text";
				const metaColor = isDone ? "dim" : "muted";
				const line = `${prefix}${th.fg(mainColor, firstLine)}`;
				const metaLine = `    ${th.fg(metaColor, meta)}`;
				lines.push(truncateToWidth(line, width));
				lines.push(truncateToWidth(metaLine, width));
			}
		}

		lines.push("");

		if (this.deleteConfirmItem) {
			lines.push(truncateToWidth(`  ${th.fg("warning", "Delete this follow-up? (y/n)")}`, width));
		} else {
			lines.push(truncateToWidth(`  ${th.fg("dim", "enter=pop  e=edit  ctrl-d=delete  u/d=move  tab=scope  n=new  q=close")}`, width));
		}

		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	getItems(): FollowUp[] {
		return this.items;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

async function recordFollowUp(ctx: ExtensionCommandContext): Promise<void> {
	const path = followUpsPath(ctx);
	if (!path) {
		notify(ctx, "Could not determine project root for follow-ups.", "error");
		return;
	}

	if (!ctx.isIdle()) {
		notify(ctx, "Press Escape to stop the current turn, then run /follow-up again.", "warning");
		return;
	}

	const anchor = buildAnchor(ctx);
	if (!anchor) {
		notify(ctx, "No message to anchor this follow-up to.", "error");
		return;
	}

	const snippet = buildContextSnippet(ctx);
	const message = await ctx.ui.editor("New follow-up", "");
	if (message === undefined || message.trim() === "") {
		notify(ctx, "Follow-up cancelled.", "info");
		return;
	}

	const items = await loadFollowUps(path);
	const followUp: FollowUp = {
		id: randomUUID(),
		createdAt: new Date().toISOString(),
		message: message.trim(),
		anchor,
		contextSnippet: snippet,
		done: false,
	};
	items.push(followUp);
	await saveFollowUps(path, items);
	notify(ctx, "Follow-up saved.", "info");
}

async function listFollowUps(ctx: ExtensionCommandContext): Promise<void> {
	const path = followUpsPath(ctx);
	if (!path) {
		notify(ctx, "Could not determine project root for follow-ups.", "error");
		return;
	}

	if (ctx.mode !== "tui") {
		notify(ctx, "/follow-up list requires interactive mode", "error");
		return;
	}

	if (!ctx.isIdle()) {
		notify(ctx, "Press Escape to stop the current turn, then run /follow-up list again.", "warning");
		return;
	}

	let items = await loadFollowUps(path);
	let scope: Scope = "session";

	const popped = await ctx.ui.custom<{ item: FollowUp; mode: "direct" | "branch" } | undefined>(async (_tui, theme, _kb, done) => {
		const redraw = () => component.invalidate();

		const component = new FollowUpListComponent(
			filterByScope(items, scope, ctx),
			scope,
			theme,
			() => done(undefined),
			(item, mode) => done({ item, mode }),
			async (item) => {
				done(undefined);
				const updated = await ctx.ui.editor("Edit follow-up", item.message);
				if (updated !== undefined) {
					const idx = items.findIndex((i) => i.id === item.id);
					if (idx >= 0) {
						items[idx].message = updated;
						await saveFollowUps(path, items);
					}
				}
				await listFollowUps(ctx);
			},
			async (updatedItems) => {
				await saveFollowUps(path, updatedItems);
				items = updatedItems;
				redraw();
			},
			async (anchor) => {
				done(undefined);
				const message = await ctx.ui.editor("New follow-up (same anchor)", "");
				if (message !== undefined && message.trim() !== "") {
					items.push({
						id: randomUUID(),
						createdAt: new Date().toISOString(),
						message: message.trim(),
						anchor,
						contextSnippet: "(same anchor)",
						done: false,
					});
					await saveFollowUps(path, items);
				}
				await listFollowUps(ctx);
			},
		);

		return component;
	});

	if (!popped) return;

	const idx = items.findIndex((i) => i.id === popped.item.id);
	if (idx >= 0) {
		items[idx].done = true;
		await saveFollowUps(path, items);
	}

	if (popped.mode === "branch") {
		await ctx.fork(popped.item.anchor.nodeId, { position: "before" });
		return;
	}

	ctx.ui.pasteToEditor(popped.item.message);
	ctx.ui.setStatus("follow-ups", undefined);
}


export default function (pi: ExtensionAPI) {
	pi.registerCommand(COMMAND_NAME, {
		description: "Capture a follow-up note anchored to the current message. Usage: /follow-up [list]",
		getArgumentCompletions: (prefix) => {
			const choices = ["list"];
			const items = choices
				.filter((c) => c.startsWith(prefix.trim().toLowerCase()))
				.map((c) => ({ label: c, value: c }));
			return items;
		},
		handler: async (args, ctx) => {
			if (args.trim().toLowerCase() === "list") {
				await listFollowUps(ctx);
				return;
			}
			await recordFollowUp(ctx);
		},
	});
}
