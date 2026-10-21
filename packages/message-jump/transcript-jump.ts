/**
 * Transcript offset maths for the message-jump extension.
 *
 * Pi renders the fullscreen transcript as one component tree inside a
 * ScrollView. The ScrollView scrolls by terminal row, so jumping to "the
 * previous message" needs the row each message starts at. That is what this
 * module computes, and it is deliberately free of Pi imports so the arithmetic
 * can be tested on its own.
 *
 * Row model: every component's height is its own `render(width).length`. That
 * is authoritative even for components that draw chrome around their children,
 * which Pi's tool blocks do. A child's start row is the sum of the heights of
 * the siblings before it, so offsets are exact while the containers between the
 * transcript root and the messages stay plain concatenating containers.
 */

export interface TranscriptNode {
	render(width: number): string[];
	children?: readonly TranscriptNode[];
}

export interface BlockAnchor<T extends TranscriptNode = TranscriptNode> {
	/** Matched component. */
	component: T;
	/** Transcript row this anchor points at (component start plus `within`). */
	start: number;
	/** Rows into the component that the anchor points at. */
	within: number;
	/** Rows this component occupies. */
	height: number;
}

export type JumpDirection = -1 | 1;

/** Row inside a component to anchor on, or undefined when it is not an anchor. */
export type AnchorResolver = (node: TranscriptNode, width: number) => number | undefined;

/** Rendered row count, cached for the duration of one walk. */
function rowHeight(node: TranscriptNode, width: number, cache: Map<TranscriptNode, number>): number {
	const cached = cache.get(node);
	if (cached !== undefined) return cached;
	const height = node.render(Math.max(1, width)).length;
	cache.set(node, height);
	return height;
}

/**
 * Collect an anchor for every component the resolver accepts, in document
 * order. The resolver returns the row inside the component to land on, which is
 * how a reply anchors on its text rather than on the thinking above it.
 */
export function collectAnchors(
	root: TranscriptNode,
	width: number,
	resolve: AnchorResolver,
): BlockAnchor[] {
	const anchors: BlockAnchor[] = [];
	const cache = new Map<TranscriptNode, number>();

	const visit = (node: TranscriptNode, offset: number): void => {
		const resolved = resolve(node, Math.max(1, width));
		if (resolved !== undefined) {
			const height = rowHeight(node, width, cache);
			const within = Math.min(Math.max(0, resolved), Math.max(0, height - 1));
			anchors.push({ component: node, start: offset + within, within, height });
		}

		let cursor = offset;
		for (const child of node.children ?? []) {
			visit(child, cursor);
			cursor += rowHeight(child, width, cache);
		}
	};

	visit(root, 0);
	return anchors;
}

/** Rows of the message above the target to keep on screen. */
export const DEFAULT_CONTEXT_SPEC = "2/3";

/**
 * How many rows of context to leave above a jumped-to message.
 *
 * Accepts a row count (`5`), a fraction of the viewport (`"2/3"`, `"0.5"`), or
 * `"0"` for the message's first row at the very top. Anything unusable falls
 * back to two thirds of the viewport.
 */
export function resolveContextRows(spec: string | number | undefined, viewportHeight: number): number {
	const height = Math.max(0, Math.floor(viewportHeight));
	if (height === 0) return 0;

	const fallback = Math.round((height * 2) / 3);
	if (typeof spec === "number") return Number.isFinite(spec) ? Math.max(0, Math.min(height, Math.round(spec))) : fallback;
	if (spec === undefined) return fallback;

	const text = spec.trim();
	const fraction = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(text);
	let rows: number;
	if (fraction) {
		const numerator = Number(fraction[1]);
		const denominator = Number(fraction[2]);
		rows = denominator === 0 ? fallback : Math.round((height * numerator) / denominator);
	} else if (/^\d+(?:\.\d+)?$/.test(text)) {
		const value = Number(text);
		// Values below 1 are a viewport fraction; larger values are row counts.
		rows = value < 1 ? Math.round(height * value) : Math.round(value);
	} else {
		return fallback;
	}

	return Math.max(0, Math.min(height, rows));
}

/** The reply a jump landed on, and the viewport top that jump produced. */
export interface JumpCursor {
	start: number;
	expectedTop: number;
}

/** How far the viewport may drift from where a jump left it and still count as resting. */
const CURSOR_TOLERANCE = 2;

/**
 * The row navigation measures from.
 *
 * A jump positions its target below the viewport top, so navigation continues
 * from the message it landed on. That holds while the view rests where the jump
 * left it. A jump that runs into the end of the transcript is clamped, so the
 * message sits inside the context band above the viewport top instead of at the
 * expected row; that counts as resting too. Once the view has moved further
 * away (the user scrolled), the viewport top takes over again.
 */
export function navigationReference(
	viewportTop: number,
	cursor: JumpCursor | undefined,
	contextRows: number,
): number {
	if (!cursor) return viewportTop;
	if (Math.abs(cursor.expectedTop - viewportTop) <= CURSOR_TOLERANCE) return cursor.start;
	if (cursor.start >= viewportTop && cursor.start <= viewportTop + contextRows + CURSOR_TOLERANCE) {
		return cursor.start;
	}
	return viewportTop;
}

/** Where `scrollTo` actually lands, so cursor detection survives clamping. */
export function clampViewportTop(requested: number, contentHeight: number, viewportHeight: number | undefined): number {
	if (viewportHeight === undefined) return Math.max(0, requested);
	return Math.max(0, Math.min(requested, Math.max(0, contentHeight - viewportHeight)));
}

/**
 * Pick the anchor to jump to.
 *
 * `reference` is the row navigation is measured from: the viewport top when the
 * view has not moved, or the message last jumped to. A jump places its target
 * below the viewport top, so measuring from the viewport top would pick the
 * target itself again, and would skip a message that sits within the context
 * band above it.
 *
 * `direction > 0` returns the first anchor below the viewport top, so pressing
 * the key again after a jump moves on. `direction < 0` returns the last anchor
 * above the viewport top: from inside a long message that is the message
 * itself, which scrolls to its beginning before a further press moves to the
 * previous one.
 */
export function pickAnchor<T extends TranscriptNode>(
	anchors: readonly BlockAnchor<T>[],
	reference: number,
	direction: JumpDirection,
): BlockAnchor<T> | undefined {
	return direction > 0
		? anchors.find((anchor) => anchor.start > reference)
		: lastBelow(anchors, reference);
}

function lastBelow<T extends TranscriptNode>(
	anchors: readonly BlockAnchor<T>[],
	viewportTop: number,
): BlockAnchor<T> | undefined {
	let previous: BlockAnchor<T> | undefined;
	for (const anchor of anchors) {
		if (anchor.start >= viewportTop) break;
		previous = anchor;
	}
	return previous;
}
