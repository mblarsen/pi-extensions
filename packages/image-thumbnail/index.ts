import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { allocateImageId, getCapabilities, getCellDimensions, renderImage, type Component } from "@earendil-works/pi-tui";
import { addedPaths, clipboardPaths, PreviewQueue } from "./core.ts";
import { composeStrip, loadThumbnail } from "./thumbnail.ts";

const WIDGET = "image-thumbnail";
const POLL_MS = 75;

export function startPreviews(ctx: ExtensionContext): { observe(text: string): void; dispose(): void } {
	const queue = new PreviewQueue<Buffer>();
	let previous = clipboardPaths(ctx.ui.getEditorText());
	let lastText = ctx.ui.getEditorText();
	let disposed = false;
	let revision = 0;
	let expiry: ReturnType<typeof setTimeout> | undefined;
	let pending = Promise.resolve();

	function armExpiry(): void {
		if (expiry) clearTimeout(expiry);
		const next = queue.nextExpiry();
		if (next === undefined) return;
		expiry = setTimeout(() => {
			if (disposed) return;
			if (queue.expire(Date.now())) {
				// Remove expired pixels before asynchronous recomposition finishes.
				ctx.ui.setWidget(WIDGET, undefined);
				void refresh();
			}
			armExpiry();
		}, Math.max(0, next - Date.now()));
		expiry.unref();
	}

	async function refresh(): Promise<void> {
		const version = ++revision;
		const snapshot = [...queue.items];
		if (!snapshot.length) {
			ctx.ui.setWidget(WIDGET, undefined);
			return;
		}
		try {
			// One raster avoids multiple Kitty placements on a single TUI line.
			const strip = await composeStrip(snapshot.map((item) => item.value));
			if (disposed || version !== revision) return;
			ctx.ui.setWidget(WIDGET, (tui): Component => {
				const imageId = allocateImageId();
				let cacheKey = "";
				let lines: string[] = [];
				return {
					invalidate() { cacheKey = ""; },
					render(width) {
						if (disposed || version !== revision || width < 4) return [];
						const cells = getCellDimensions();
						const maxHeightCells = Math.max(1, Math.min(8, Math.floor(tui.terminal.rows / 3)));
						const key = `${width}:${maxHeightCells}:${cells.widthPx}:${cells.heightPx}`;
						if (cacheKey !== key) {
							const result = renderImage(strip.data, strip, {
								maxWidthCells: Math.min(width - 2, snapshot.length * 24 + (snapshot.length - 1) * 2),
								maxHeightCells, imageId, moveCursor: false,
							});
							if (!result) return [];
							const inset = " ".repeat(Math.max(0, width - result.columns));
							lines = Array<string>(result.rows).fill("");
							if (getCapabilities().images === "kitty") lines[0] = inset + result.sequence;
							else {
								const up = result.rows > 1 ? `\x1b[${result.rows - 1}A` : "";
								lines[result.rows - 1] = inset + up + result.sequence;
							}
							cacheKey = key;
						}
						queue.markDisplayed(snapshot.map((item) => item.id), Date.now());
						armExpiry();
						return lines;
					},
				};
			}, { placement: "aboveEditor" });
		} catch {
			// A failed preview must never interfere with the prompt or clipboard.
			if (!disposed && version === revision) ctx.ui.setWidget(WIDGET, undefined);
		}
	}

	function observe(text: string): void {
		if (disposed || text === lastText) return;
		lastText = text;
		const current = clipboardPaths(text);
		const added = addedPaths(previous, current);
		previous = current;
		if (!added.length) return;
		// Serialize batches so slower image decoding cannot reorder pastes.
		pending = pending.then(async () => {
			for (const path of added) {
				if (disposed) return;
				const thumbnail = await loadThumbnail(path);
				if (disposed) return;
				if (thumbnail) queue.add(thumbnail);
			}
			if (!disposed) await refresh();
		}).catch(() => {});
	}

	// Clipboard conversion is asynchronous and Pi has no public editor-change event.
	// Poll text only; image I/O happens once for each newly inserted path.
	const poll = setInterval(() => observe(ctx.ui.getEditorText()), POLL_MS);
	poll.unref();
	return {
		observe,
		dispose() {
			disposed = true;
			revision++;
			clearInterval(poll);
			if (expiry) clearTimeout(expiry);
			queue.items = [];
			ctx.ui.setWidget(WIDGET, undefined);
		},
	};
}

export default function imageThumbnail(pi: ExtensionAPI): void {
	let previews: ReturnType<typeof startPreviews> | undefined;
	pi.on("session_start", (_event, ctx) => {
		previews?.dispose();
		previews = undefined;
		if (ctx.mode === "tui" && ctx.hasUI && getCapabilities().images) previews = startPreviews(ctx);
	});
	pi.on("input", (event) => {
		if (event.source === "interactive") previews?.observe(event.text);
	});
	pi.on("session_shutdown", () => {
		previews?.dispose();
		previews = undefined;
	});
}
