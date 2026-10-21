import assert from "node:assert/strict";
import test from "node:test";
import {
	clampViewportTop,
	collectAnchors,
	DEFAULT_CONTEXT_SPEC,
	navigationReference,
	pickAnchor,
	resolveContextRows,
	type TranscriptNode,
} from "./transcript-jump.ts";

class Leaf implements TranscriptNode {
	readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(_width: number): string[] {
		return this.lines;
	}
}

/** Wraps its content at `width` characters per row. */
class Wrapping implements TranscriptNode {
	readonly text: string;

	constructor(text: string) {
		this.text = text;
	}

	render(width: number): string[] {
		const rows: string[] = [];
		for (let offset = 0; offset < this.text.length; offset += width) {
			rows.push(this.text.slice(offset, offset + width));
		}
		return rows;
	}
}

class Group implements TranscriptNode {
	readonly children: TranscriptNode[];

	constructor(...children: TranscriptNode[]) {
		this.children = children;
	}

	render(width: number): string[] {
		return this.children.flatMap((child) => child.render(width));
	}
}

class Assistant extends Group {
	readonly lastMessage = { role: "assistant" };
	readonly updateContent = (): void => {};
}

class User extends Group {
	readonly lastMessage = { role: "user" };
	readonly updateContent = (): void => {};
}

function lines(count: number): string[] {
	return Array.from({ length: count }, (_, index) => `row ${index}`);
}

test("anchors carry the start row and height of every match in document order", () => {
	const root = new Group(
		new Leaf(lines(3)),
		new Assistant(new Leaf(lines(2))),
		new Leaf(lines(1)),
		new Assistant(new Leaf(lines(4))),
	);

	const anchors = collectAnchors(root, 80, (node) => (node instanceof Assistant ? 0 : undefined));

	assert.deepEqual(
		anchors.map((anchor) => [anchor.start, anchor.height]),
		[
			[3, 2],
			[6, 4],
		],
	);
});

test("heights follow the render width, so wrapped replies report their real extent", () => {
	const root = new Group(new Leaf(lines(2)), new Assistant(new Wrapping("x".repeat(20))));

	const narrow = collectAnchors(root, 5, (node) => (node instanceof Assistant ? 0 : undefined));
	const wide = collectAnchors(root, 80, (node) => (node instanceof Assistant ? 0 : undefined));

	assert.deepEqual(
		narrow.map((anchor) => [anchor.start, anchor.height]),
		[[2, 4]],
	);
	assert.deepEqual(
		wide.map((anchor) => [anchor.start, anchor.height]),
		[[2, 1]],
	);
});

test("non-matching siblings still advance the row counter", () => {
	const root = new Group(
		new Leaf(lines(5)),
		new User(new Leaf(lines(1))),
		new Assistant(new Leaf(lines(1))),
	);

	const anchors = collectAnchors(root, 80, (node) => (node instanceof Assistant ? 0 : undefined));

	assert.equal(anchors.length, 1);
	assert.equal(anchors[0].start, 6);
});

test("an empty transcript has no anchors", () => {
	const anchors = collectAnchors(new Group(), 80, (node) => (node instanceof Assistant ? 0 : undefined));
	assert.deepEqual(anchors, []);
});

test("next picks the first reply below the viewport top, then advances", () => {
	const root = new Group(
		new Assistant(new Leaf(lines(2))),
		new Assistant(new Leaf(lines(2))),
		new Assistant(new Leaf(lines(2))),
	);
	const anchors = collectAnchors(root, 80, (node) => (node instanceof Assistant ? 0 : undefined));

	assert.equal(pickAnchor(anchors, 0, 1)?.start, 2);
	assert.equal(pickAnchor(anchors, 2, 1)?.start, 4);
	assert.equal(pickAnchor(anchors, 4, 1)?.start, undefined);
});

test("previous from inside a long reply returns that reply, then the one before it", () => {
	const root = new Group(
		new Assistant(new Leaf(lines(2))),
		new Assistant(new Leaf(lines(10))),
	);
	const anchors = collectAnchors(root, 80, (node) => (node instanceof Assistant ? 0 : undefined));

	// viewport top sits three rows into the second reply
	assert.equal(pickAnchor(anchors, 5, -1)?.start, 2);
	assert.equal(pickAnchor(anchors, 2, -1)?.start, 0);
	assert.equal(pickAnchor(anchors, 0, -1), undefined);
});

test("next and previous are no-ops at the transcript edges", () => {
	const anchors = collectAnchors(
		new Group(new Leaf(lines(1))),
		80,
		() => undefined,
	);

	assert.equal(pickAnchor(anchors, 0, 1), undefined);
	assert.equal(pickAnchor(anchors, 0, -1), undefined);
});

test("a container that draws chrome still advances siblings by its rendered height", () => {
	class Boxed implements TranscriptNode {
		readonly children: TranscriptNode[];

		constructor(...children: TranscriptNode[]) {
			this.children = children;
		}

		// one border row above and below the children
		render(width: number): string[] {
			return ["top", ...this.children.flatMap((child) => child.render(width)), "bottom"];
		}
	}

	const root = new Group(
		new Boxed(new Leaf(lines(3))),
		new Assistant(new Leaf(lines(2))),
	);

	const anchors = collectAnchors(root, 80, (node) => (node instanceof Assistant ? 0 : undefined));

	// the box occupies 5 rows, so the reply starts at row 5, not row 3
	assert.deepEqual(
		anchors.map((anchor) => anchor.start),
		[5],
	);
});

test("context defaults to two thirds of the viewport", () => {
	assert.equal(DEFAULT_CONTEXT_SPEC, "2/3");
	assert.equal(resolveContextRows(undefined, 60), 40);
});

test("context accepts row counts, fractions, and zero", () => {
	assert.equal(resolveContextRows("5", 60), 5);
	assert.equal(resolveContextRows(5, 60), 5);
	assert.equal(resolveContextRows("0", 60), 0);
	assert.equal(resolveContextRows("0.5", 60), 30);
	assert.equal(resolveContextRows("1/3", 60), 20);
	assert.equal(resolveContextRows("2/3", 51), 34);
});

test("context falls back and clamps instead of trusting input", () => {
	assert.equal(resolveContextRows("half", 60), 40);
	assert.equal(resolveContextRows("3/0", 60), 40);
	assert.equal(resolveContextRows("999", 60), 60);
	assert.equal(resolveContextRows(-5, 60), 0);
	assert.equal(resolveContextRows("2/3", 0), 0);
});

test("measuring from the message you are on keeps close stops reachable", () => {
	const root = new Group(
		new Leaf(lines(50)),
		new Assistant(new Leaf(lines(5))),
		new Leaf(lines(15)),
		new Assistant(new Leaf(lines(5))),
		new Leaf(lines(50)),
		new Assistant(new Leaf(lines(5))),
	);
	const anchors = collectAnchors(root, 80, (node) => (node instanceof Assistant ? 0 : undefined));
	const [first, second, third] = anchors;

	assert.deepEqual(
		anchors.map((anchor) => anchor.start),
		[50, 70, 125],
	);

	// Two thirds of a 60 row viewport is 40 rows, deeper than the gap of 20 rows
	// between the first two stops. The viewport top alone would skip `first`.
	assert.equal(pickAnchor(anchors, second.start - 40, -1)?.start, undefined);
	assert.equal(pickAnchor(anchors, second.start, -1)?.start, first.start);
	assert.equal(pickAnchor(anchors, second.start, 1)?.start, third.start);
});

test("navigation continues from the message a jump landed on", () => {
	const contextRows = 33;
	const cursor = { start: 400, expectedTop: 400 - contextRows };

	assert.equal(navigationReference(367, cursor, contextRows), 400);
	// A row of drift while pi settles the layout still counts as resting.
	assert.equal(navigationReference(368, cursor, contextRows), 400);
	assert.equal(navigationReference(366, cursor, contextRows), 400);
	// A manual scroll invalidates the cursor.
	assert.equal(navigationReference(200, cursor, contextRows), 200);
	assert.equal(navigationReference(0, undefined, contextRows), 0);
});

test("a jump clamped at the end of the transcript still holds the cursor", () => {
	// The newest message sits 10 rows above the clamped viewport top, so the
	// expected top is unreachable and only the context band can hold the cursor.
	const contextRows = 33;
	const cursor = { start: 990, expectedTop: 957 };
	assert.equal(navigationReference(980, cursor, contextRows), 990);
	// Past the band the viewport decides again.
	assert.equal(navigationReference(900, cursor, contextRows), 900);
});

test("cursor expectations survive scrollTo clamping", () => {
	assert.equal(clampViewportTop(-10, 1000, 50), 0);
	assert.equal(clampViewportTop(33, 1000, 50), 33);
	assert.equal(clampViewportTop(990, 1000, 50), 950);
	assert.equal(clampViewportTop(900, 40, 50), 0);
	assert.equal(clampViewportTop(120, 1000, undefined), 120);
});
