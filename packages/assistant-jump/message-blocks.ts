/**
 * Which transcript components count as messages, and which row each one's
 * content starts on.
 *
 * Pi renders an assistant message as a container of content children in message
 * order: an optional leading spacer, one child per text block, and one child per
 * run of thinking blocks. In a tool-heavy session most assistant blocks hold
 * only thinking and tool calls, so "the reply" has to be the text rows when they
 * exist, and the prompts in between are what give the jumps a readable cadence.
 *
 * These helpers read that structure without importing Pi, so the mapping can be
 * tested against fake components.
 */

import type { TranscriptNode } from "./transcript-jump.ts";

export interface AssistantContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
}

export interface AssistantComponent extends TranscriptNode {
	updateContent?: unknown;
	lastMessage?: { role?: string; content?: AssistantContentBlock[] };
	/** Container holding the thinking and text blocks, in content order. */
	contentContainer?: TranscriptNode;
}

export interface UserComponent extends TranscriptNode {
	text?: string;
	rebuild?: unknown;
	setOutputPad?: unknown;
}

/** SGR colours, and the OSC 133 prompt marks a user block wraps around its text. */
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function stripped(line: string): string {
	return line.replace(ANSI, "").trim();
}

/** Spacers have no meaningful content: one blank row between blocks. */
export function isSpacer(node: TranscriptNode): boolean {
	if ((node as { constructor?: { name?: string } }).constructor?.name === "Spacer") return true;
	const lines = node.render(1);
	return lines.length === 1 && stripped(lines[0]) === "";
}

/**
 * Assistant message components are recognised by behaviour, not by class name:
 * Pi ships a bundled build whose identifiers vary between releases.
 *
 * A reply is a turn that carried text. Turns that only thought or only called
 * tools have nothing to read, and landing on one looks like the jump failed.
 */
export function isAssistantReply(node: TranscriptNode): node is AssistantComponent {
	const candidate = node as AssistantComponent;
	if (typeof candidate.updateContent !== "function") return false;
	if (candidate.lastMessage?.role !== "assistant") return false;
	return (candidate.lastMessage.content ?? []).some(
		(block) => block.type === "text" && (block.text ?? "").trim() !== "",
	);
}

/** User prompts are recognised by behaviour too: Pi's component owns its text. */
export function isUserMessage(node: TranscriptNode): node is UserComponent {
	const candidate = node as UserComponent;
	return (
		typeof candidate.rebuild === "function" &&
		typeof candidate.setOutputPad === "function" &&
		typeof candidate.text === "string"
	);
}

/**
 * Row of the first reply text inside an assistant block.
 *
 * Pi builds `contentContainer` in content order: an optional leading spacer, one
 * child per text block, one child per run of thinking blocks (wrapped in a mouse
 * region), and a spacer after a thinking run when visible content follows.
 * Mirroring that order is what turns "the reply" into a row instead of "the top
 * of the message, wherever the thinking ended".
 */
export function findReplyRow(component: AssistantComponent, width: number): number | undefined {
	const content = component.lastMessage?.content ?? [];
	const children = component.contentContainer?.children ?? [];
	if (children.length === 0) return undefined;

	const heightOf = (node: TranscriptNode): number => node.render(Math.max(1, width)).length;
	let childIndex = 0;
	let row = 0;

	const spacerNext = (): boolean => {
		const next = children[childIndex];
		return next !== undefined && isSpacer(next);
	};
	const consumeSpacer = (): void => {
		if (!spacerNext()) return;
		row += heightOf(children[childIndex]);
		childIndex += 1;
	};

	consumeSpacer();

	for (let index = 0; index < content.length; index += 1) {
		const block = content[index];

		if (block.type === "text") {
			if ((block.text ?? "").trim() === "") continue;
			return childIndex < children.length ? row : undefined;
		}

		if (block.type !== "thinking") continue;

		// Pi renders a whole run of thinking blocks as one child.
		let runHasText = false;
		while (index < content.length && content[index].type === "thinking") {
			if ((content[index].thinking ?? "").trim() !== "") runHasText = true;
			index += 1;
		}
		index -= 1;
		if (!runHasText) continue;
		if (childIndex >= children.length) return undefined;
		row += heightOf(children[childIndex]);
		childIndex += 1;
		consumeSpacer();
	}

	return undefined;
}

/** Row of the first non-blank line of a prompt, past its padding. */
export function findUserRow(component: TranscriptNode, width: number): number {
	const lines = component.render(Math.max(1, width));
	const index = lines.findIndex((line) => stripped(line) !== "");
	return index === -1 ? 0 : index;
}

/**
 * Turn a transcript component into an anchor row, or undefined when the
 * component is not a message worth stopping at.
 */
export function resolveAnchor(node: TranscriptNode, width: number): number | undefined {
	if (isAssistantReply(node)) return findReplyRow(node, width) ?? 0;
	if (isUserMessage(node)) return findUserRow(node, width);
	return undefined;
}
