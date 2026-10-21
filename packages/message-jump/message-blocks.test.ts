import assert from "node:assert/strict";
import test from "node:test";
import {
	findReplyRow,
	findUserRow,
	isAssistantReply,
	isUserMessage,
	resolveAnchor,
	type AssistantComponent,
} from "./message-blocks.ts";
import type { TranscriptNode } from "./transcript-jump.ts";

class Spacer implements TranscriptNode {
	render(): string[] {
		return [""];
	}
}

class Rows implements TranscriptNode {
	readonly count: number;

	constructor(count: number) {
		this.count = count;
	}

	render(): string[] {
		return Array.from({ length: this.count }, (_, index) => `row ${index}`);
	}
}

/** Pi wraps a rendered thinking block in a mouse region that passes lines through. */
class MouseRegion implements TranscriptNode {
	readonly inner: TranscriptNode;

	constructor(inner: TranscriptNode) {
		this.inner = inner;
	}

	get children(): readonly TranscriptNode[] {
		return [this.inner];
	}

	render(width: number): string[] {
		return this.inner.render(width);
	}
}

class Assistant implements AssistantComponent {
	readonly updateContent = (): void => {};
	readonly lastMessage: { role?: string; content?: { type?: string; text?: string; thinking?: string }[] };
	readonly contentContainer?: TranscriptNode;

	constructor(
		content: { type?: string; text?: string; thinking?: string }[],
		...children: TranscriptNode[]
	) {
		this.lastMessage = { role: "assistant", content };
		this.contentContainer = { children, render: (width) => children.flatMap((c) => c.render(width)) };
	}

	render(width: number): string[] {
		return this.contentContainer?.render(width) ?? [];
	}
}

test("a text-only reply anchors one row in, past the leading spacer", () => {
	const component = new Assistant([{ type: "text", text: "Here is the answer." }], new Spacer(), new Rows(3));

	assert.equal(isAssistantReply(component), true);
	assert.equal(findReplyRow(component, 80), 1);
});

test("a reply after a hidden thinking block anchors on the text, not the thinking label", () => {
	// Pi: leading spacer, thinking child, spacer because visible content follows, text
	const component = new Assistant(
		[{ type: "thinking", thinking: "weighing options" }, { type: "text", text: "Answer." }],
		new Spacer(),
		new MouseRegion(new Rows(3)),
		new Spacer(),
		new Rows(2),
	);

	assert.equal(findReplyRow(component, 80), 5);
});

test("a run of thinking blocks counts as one child, as Pi renders it", () => {
	const component = new Assistant(
		[
			{ type: "thinking", thinking: "first" },
			{ type: "thinking", thinking: "second" },
			{ type: "text", text: "Answer." },
		],
		new Spacer(),
		new MouseRegion(new Rows(4)),
		new Spacer(),
		new Rows(1),
	);

	assert.equal(findReplyRow(component, 80), 6);
});

test("empty thinking blocks add no child, so the offset does not drift", () => {
	const component = new Assistant(
		[{ type: "thinking", thinking: "   " }, { type: "text", text: "Answer." }],
		new Spacer(),
		new Rows(2),
	);

	assert.equal(findReplyRow(component, 80), 1);
});

test("tool-call-only and thinking-only turns are not replies", () => {
	const toolOnly = new Assistant([{ type: "toolCall" }], new Spacer());
	const thinkingOnly = new Assistant([{ type: "thinking", thinking: "lots of pondering" }], new Spacer());

	assert.equal(isAssistantReply(toolOnly), false);
	assert.equal(isAssistantReply(thinkingOnly), false);
});

test("whitespace-only text does not count as a reply", () => {
	const blank = new Assistant([{ type: "text", text: "   \n " }], new Spacer());
	assert.equal(isAssistantReply(blank), false);
});

test("a component with no content container falls back to the component start", () => {
	const component: AssistantComponent = {
		updateContent: () => {},
		lastMessage: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
		render: () => ["Hi"],
	};

	assert.equal(isAssistantReply(component), true);
	assert.equal(findReplyRow(component, 80), undefined);
});

class Prompt implements TranscriptNode {
	readonly text: string;
	readonly rebuild = (): void => {};
	readonly setOutputPad = (): void => {};
	readonly rowCount: number;

	constructor(text: string, rowCount = 3) {
		this.text = text;
		this.rowCount = rowCount;
	}

	render(): string[] {
		return ["", `\x1b[48;5;236m ${this.text} \x1b[0m`, ""].slice(0, this.rowCount);
	}
}

test("a prompt is recognised and anchors on its first non-blank row", () => {
	const prompt = new Prompt("do the thing");
	assert.equal(isUserMessage(prompt), true);
	assert.equal(findUserRow(prompt, 80), 1);
	assert.equal(resolveAnchor(prompt, 80), 1);
});

test("assistant blocks without text are not anchors", () => {
	const toolOnly = new Assistant([{ type: "thinking", thinking: "hmm" }, { type: "toolCall" }], new Spacer());
	assert.equal(resolveAnchor(toolOnly, 80), undefined);
});

test("a reply resolves through the combined resolver", () => {
	const reply = new Assistant([{ type: "text", text: "Answer." }], new Spacer(), new Rows(2));
	assert.equal(resolveAnchor(reply, 80), 1);
});
