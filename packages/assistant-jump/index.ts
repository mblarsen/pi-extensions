/**
 * Assistant jump extension - move the fullscreen transcript to the previous or
 * next assistant reply.
 *
 * Pi already has `tui.altScreen.previousPrompt` / `nextPrompt`, which jump
 * between OSC 133 zone starts. Assistant blocks only emit that zone when the
 * turn made no tool calls, so every reply produced mid-work is skipped. This
 * extension does its own row maths against the live transcript component tree,
 * so it lands on every reply without re-rendering or duplicating anything.
 *
 * The transcript has no public extension API for scrolling, so this reaches for
 * the live TUI object through a zero-height widget factory and walks the
 * component tree defensively. When the internals move, the shortcut reports
 * that it cannot find the transcript instead of throwing.
 */

import { writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseReplyArgs, replyArgumentCompletions, replyUsage } from "./command.ts";
import { resolveAnchor, type AssistantComponent } from "./message-blocks.ts";
import {
	clampViewportTop,
	collectAnchors,
	DEFAULT_CONTEXT_SPEC,
	type JumpCursor,
	navigationReference,
	pickAnchor,
	resolveContextRows,
	type JumpDirection,
	type TranscriptNode,
} from "./transcript-jump.ts";

const WIDGET_KEY = "assistant-jump:tui-probe";
const PREVIOUS_SHORTCUT = "ctrl+shift+k";
const NEXT_SHORTCUT = "ctrl+shift+j";

interface ScrollViewLike {
	primary?: boolean;
	scrollTop?: number;
	/** Viewport height in rows (pi-tui ScrollView exposes it as viewportHeight). */
	viewportHeight?: number;
	/** Rendered content height in rows, when the scroll view exposes it. */
	contentHeight?: number;
	scrollTo?: (row: number, options?: { disableFollow?: boolean }) => void;
	scrollBy?: (lines: number) => number;
	getContentWidth?: (width: number) => number;
	children?: readonly unknown[];
}

interface TuiLike {
	currentLayout?: unknown;
	fullscreenLayoutRoot?: unknown;
	terminal?: { columns?: number };
	requestRender?: (force?: boolean) => void;
	children?: readonly unknown[];
}

interface WidgetTui extends TuiLike {}

let tuiRef: WidgetTui | undefined;

const DEBUG_PATH = "/tmp/pi-assistant-jump-debug.json";
const JUMP_LOG_LIMIT = 20;

interface TranscriptState {
	scrollView: ScrollViewLike;
	document: TranscriptNode;
	width: number;
	columns: number;
	anchors: ReturnType<typeof collectAnchors>;
	viewportTop: number;
	viewportHeight?: number;
	contentHeight: number;
}

interface JumpRecord {
	direction: JumpDirection;
	requested: number;
	before: number;
	after?: number;
	anchorIndex?: number;
	anchorStart?: number;
	anchorWithin?: number;
	anchorCount?: number;
	contextRows?: number;
	reference?: number;
	note?: string;
}

const jumpLog: JumpRecord[] = [];

/** Rows of the previous message to keep on screen above the jump target. */
let contextSpec: string | number = DEFAULT_CONTEXT_SPEC;

/**
 * The reply the last jump landed on, plus the viewport top that jump produced.
 *
 * Navigation measures from this row rather than the viewport top, because a
 * jump positions its target below the viewport top. The recorded viewport top
 * also detects a manual scroll, which restores viewport-relative navigation.
 */
let cursor: JumpCursor | undefined;

/** Write the debug snapshot without ever throwing into the shortcut path. */
function writeDebug(snapshot: Record<string, unknown>): void {
	try {
		writeFileSync(DEBUG_PATH, `${JSON.stringify({ snapshot, jumps: jumpLog }, null, 2)}\n`);
	} catch {
		// Debug output must never break the jump itself.
	}
}


function findScrollView(node: unknown, seen = new Set<unknown>()): ScrollViewLike | undefined {
	if (node === null || typeof node !== "object" || seen.has(node)) return undefined;
	seen.add(node);

	const candidate = node as ScrollViewLike;
	if (
		candidate.primary === true &&
		typeof candidate.scrollTo === "function" &&
		typeof candidate.scrollBy === "function"
	) {
		return candidate;
	}

	for (const child of candidate.children ?? []) {
		const found = findScrollView(child, seen);
		if (found) return found;
	}
	return undefined;
}

/** Validate a candidate at runtime: private members are only reachable by shape. */
function asScrollView(value: unknown): ScrollViewLike | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const candidate = value as ScrollViewLike;
	if (typeof candidate.scrollTo !== "function" || typeof candidate.scrollBy !== "function") {
		return undefined;
	}
	return candidate;
}

function locateScrollView(tui: TuiLike): ScrollViewLike | undefined {
	const viaGetter = (tui as { getPrimaryScrollView?: () => unknown }).getPrimaryScrollView?.();
	const direct = asScrollView(viaGetter);
	if (direct) return direct;

	const layout = tui.currentLayout as { primaryScrollView?: unknown } | undefined;
	const fromLayout = asScrollView(layout?.primaryScrollView);
	if (fromLayout) return fromLayout;

	return (
		findScrollView(tui.currentLayout) ??
		findScrollView((tui as { layoutRoot?: unknown }).layoutRoot) ??
		findScrollView(tui)
	);
}

/** The transcript document is the ScrollView's only child. */
function transcriptDocument(scrollView: ScrollViewLike): TranscriptNode | undefined {
	const first = scrollView.children?.[0];
	if (!first || typeof (first as TranscriptNode).render !== "function") return undefined;
	return first as TranscriptNode;
}

/**
 * Read the live transcript: where the viewport sits, every reply the extension
 * can see, and the rows they occupy. Returns a reason instead of throwing when
 * the internals moved.
 */
function readTranscript(
	ctx: ExtensionContext,
): { ok: true; data: TranscriptState } | { ok: false; reason: string } {
	const tui = tuiRef;
	if (!tui) return { ok: false, reason: "transcript not mounted yet, press again" };

	const scrollView = locateScrollView(tui);
	if (!scrollView) {
		return { ok: false, reason: "needs the fullscreen transcript (tuiMode: fullscreen)" };
	}

	const document = transcriptDocument(scrollView);
	if (!document) return { ok: false, reason: "transcript not found" };

	const columns = tui.terminal?.columns ?? 80;
	const width = scrollView.getContentWidth?.(columns) ?? columns;
	try {
		const anchors = collectAnchors(document, width, resolveAnchor);
		return {
			ok: true,
			data: {
				scrollView,
				document,
				width,
				columns,
				anchors,
				viewportTop: typeof scrollView.scrollTop === "number" ? scrollView.scrollTop : 0,
				viewportHeight: scrollView.viewportHeight,
				contentHeight: document.render(Math.max(1, width)).length,
			},
		};
	} catch (error) {
		return {
			ok: false,
			reason: `cannot read the transcript (${error instanceof Error ? error.message : String(error)})`,
		};
	}
}

function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}


function anchorPreviews(state: TranscriptState): Record<string, unknown>[] {
	return state.anchors.map((anchor, index) => {
		const lines = anchor.component.render(Math.max(1, state.width));
		const line = lines[anchor.within] ?? "";
		return {
			index,
			start: anchor.start,
			within: anchor.within,
			height: anchor.height,
			preview: stripAnsi(line).trim().slice(0, 80),
		};
	});
}

/** Inventory of assistant-looking components, to explain missing anchors. */
function inventoryOf(state: TranscriptState): Record<string, unknown>[] {
	const found: Record<string, unknown>[] = [];
	const visit = (node: TranscriptNode): void => {
		const candidate = node as AssistantComponent & {
			children?: readonly TranscriptNode[];
			text?: string;
			rebuild?: unknown;
		};
		if (typeof candidate.rebuild === "function" && typeof candidate.text === "string") {
			found.push({ kind: "prompt", rows: node.render(1).length });
		} else if (typeof candidate.updateContent === "function" || candidate.lastMessage?.role === "assistant") {
			const content = candidate.lastMessage?.content;
			const blocks = Array.isArray(content) ? content : [];
			const textLengths = blocks
				.filter((block) => block.type === "text")
				.map((block) => (block.text ?? "").trim().length);
			found.push({
				kind: textLengths.length > 0 && textLengths.some((length) => length > 0) ? "assistant-reply" : "assistant-tools",
				role: candidate.lastMessage?.role,
				hasUpdateContent: typeof candidate.updateContent === "function",
				contentIsArray: Array.isArray(content),
				blockCount: blocks.length,
				blockTypes: [...new Set(blocks.map((block) => String(block.type)))].join(","),
				textBlocks: textLengths.length,
				maxTextLength: textLengths.length === 0 ? 0 : Math.max(...textLengths),
				hasContentContainer: candidate.contentContainer !== undefined,
			});
		}
		for (const child of candidate.children ?? []) visit(child);
	};
	visit(state.document);
	return found;
}

function snapshotOf(state: TranscriptState): Record<string, unknown> {
	const previous = pickAnchor(state.anchors, state.viewportTop, -1);
	const next = pickAnchor(state.anchors, state.viewportTop, 1);
	const reference = navigationReference(state.viewportTop, cursor, resolveContextRows(contextSpec, state.viewportHeight ?? 0));
	return {
		columns: state.columns,
		width: state.width,
		contentHeight: state.contentHeight,
		viewportTop: state.viewportTop,
		viewportHeight: state.viewportHeight,
		maxScroll:
			state.viewportHeight === undefined
				? undefined
				: Math.max(0, state.contentHeight - state.viewportHeight),
		anchorCount: state.anchors.length,
		contextSpec,
		contextRows: resolveContextRows(contextSpec, state.viewportHeight ?? 0),
		cursorStart: cursor?.start,
		reference,
		previousStart: previous?.start,
		nextStart: next?.start,
		anchors: anchorPreviews(state),
		components: inventoryOf(state),
	};
}

function jumpToAssistantReply(ctx: ExtensionContext, direction: JumpDirection): void {
	const state = readTranscript(ctx);
	if (!state.ok) {
		ctx.ui.notify(`Assistant jump: ${state.reason}`, "warning");
		return;
	}

	const { data } = state;
	if (data.anchors.length === 0) {
		const record: JumpRecord = {
			direction,
			requested: -1,
			before: data.viewportTop,
			note: "no messages",
		};
		recordJump(record);
		writeDebug(snapshotOf(data));
		ctx.ui.notify("Assistant jump: no messages in this transcript", "info");
		return;
	}

	const contextRows = resolveContextRows(contextSpec, data.viewportHeight ?? 0);
	const reference = navigationReference(data.viewportTop, cursor, contextRows);
	const anchor = pickAnchor(data.anchors, reference, direction);
	if (!anchor) {
		const record: JumpRecord = {
			direction,
			requested: -1,
			before: data.viewportTop,
			anchorCount: data.anchors.length,
			note: direction > 0 ? "no reply below" : "no reply above",
		};
		recordJump(record);
		writeDebug(snapshotOf(data));
		ctx.ui.notify(direction > 0 ? "Already at the newest reply" : "Already at the first reply", "info");
		return;
	}

	const requested = Math.max(0, anchor.start - contextRows);
	// disableFollow keeps new output from pulling the view back to the bottom
	// while the reply you jumped to is being read.
	data.scrollView.scrollTo?.(requested, { disableFollow: true });
	tuiRef?.requestRender?.(true);

	// Read back where the viewport actually landed. pi clamps at the end of the
	// transcript using its own layout height, which can differ from the computed
	// one, and a cursor built from a wrong expectation would stop matching.
	const landed =
		typeof data.scrollView.scrollTop === "number"
			? data.scrollView.scrollTop
			: clampViewportTop(requested, data.contentHeight, data.viewportHeight);
	cursor = { start: anchor.start, expectedTop: landed };

	recordJump({
		direction,
		requested,
		before: data.viewportTop,
		after: landed,
		anchorIndex: data.anchors.indexOf(anchor),
		anchorStart: anchor.start,
		anchorWithin: anchor.within,
		anchorCount: data.anchors.length,
		contextRows,
		reference,
	});
	writeDebug(snapshotOf(data));
}

function recordJump(record: JumpRecord): void {
	jumpLog.push(record);
	if (jumpLog.length > JUMP_LOG_LIMIT) jumpLog.shift();
}

/**
 * Report what the extension can see, for troubleshooting internals drift.
 *
 * Notifications are hidden while the transcript is scrolled up, so the details
 * go to a file as well and the notification only carries the path.
 */
function reportState(ctx: ExtensionContext): void {
	const state = readTranscript(ctx);
	if (!state.ok) {
		ctx.ui.notify(`Assistant jump: ${state.reason}`, "warning");
		return;
	}

	const { data } = state;
	writeDebug(snapshotOf(data));

	const inventory = inventoryOf(data);
	const replies = inventory.filter((entry) => entry.textBlocks !== undefined && entry.kind === "assistant-reply").length;
	const prompts = inventory.filter((entry) => entry.kind === "prompt").length;

	ctx.ui.notify(
		`Assistant jump: ${data.anchors.length} stops (${replies} replies, ${prompts} prompts) · viewport top ${data.viewportTop}${
			pickAnchor(data.anchors, data.viewportTop, -1)?.start === undefined
				? " · no reply above"
				: ` · previous ${pickAnchor(data.anchors, data.viewportTop, -1)?.start}`
		} · debug ${DEBUG_PATH}`,
		"info",
	);
}

/** Invisible component: its only job is to hand us the live TUI object. */
class TuiProbe implements TranscriptNode {
	render(): string[] {
		return [];
	}

	invalidate(): void {}

	dispose(): void {}
}

function mountProbe(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(WIDGET_KEY, (tui) => {
		tuiRef = tui as WidgetTui;
		return new TuiProbe();
	});
}

export default function assistantJump(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		mountProbe(ctx);
	});

	pi.registerShortcut(PREVIOUS_SHORTCUT, {
		description: "Jump to the previous message",
		handler: (ctx) => jumpToAssistantReply(ctx, -1),
	});

	pi.registerShortcut(NEXT_SHORTCUT, {
		description: "Jump to the next message",
		handler: (ctx) => jumpToAssistantReply(ctx, 1),
	});

	pi.registerCommand("reply", {
		description: "Jump between messages, or set the context a jump keeps above its message",
		getArgumentCompletions: replyArgumentCompletions,
		handler: async (args, ctx) => {
			const invocation = parseReplyArgs(args ?? "");
			switch (invocation.command) {
				case "prev":
					await jumpToAssistantReply(ctx, -1);
					return;
				case "next":
					await jumpToAssistantReply(ctx, 1);
					return;
				case "debug":
					await reportState(ctx);
					return;
				case "context": {
					if (invocation.value === "") {
						ctx.ui.notify(`Assistant jump: context ${String(contextSpec)}`, "info");
						return;
					}
					contextSpec = invocation.value;
					cursor = undefined;
					const rows = resolveContextRows(
						contextSpec,
						locateScrollView(tuiRef ?? {})?.viewportHeight ?? 0,
					);
					ctx.ui.notify(
						`Assistant jump: context ${String(contextSpec)}${rows === 0 ? "" : ` (${rows} rows)`}`,
						"info",
					);
					return;
				}
				default: {
					const unknown = invocation.unknown === undefined ? "" : `: ${invocation.unknown}`;
					ctx.ui.notify(`Assistant jump${unknown} · ${replyUsage(contextSpec)}`, "warning");
				}
			}
		},
	});
}
