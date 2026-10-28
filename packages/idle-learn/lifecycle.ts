import { analyze, type ReviewInput, type ReviewResult } from "./reviewer.ts";

export class IdleReviewer {
	status = "Ready";
	remaining = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private controller?: AbortController;
	private active?: Promise<ReviewResult>;
	private changed: () => void;
	private review: typeof analyze;
	constructor(changed: () => void, review: typeof analyze = analyze) { this.changed = changed; this.review = review; }
	get running(): boolean { return this.active !== undefined; }
	clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
	async cancel(): Promise<void> {
		this.clearTimer();
		this.controller?.abort();
		if (this.active) await this.active.catch(() => {});
	}
	schedule(milliseconds: number, snapshot: () => Omit<ReviewInput, "signal"> | undefined): void {
		this.clearTimer();
		this.timer = setTimeout(() => {
			this.timer = undefined;
			const input = snapshot();
			if (input) void this.start(input).then((result) => {
				if (result.remaining) this.schedule(milliseconds, snapshot);
			}).catch(() => {});
		}, milliseconds);
		this.timer.unref();
	}
	start(input: Omit<ReviewInput, "signal">): Promise<ReviewResult> {
		if (this.active) return Promise.reject(new Error("A review is already running for this session."));
		this.clearTimer();
		const controller = new AbortController();
		this.controller = controller;
		this.status = "Analyzing (resume work to cancel)";
		this.changed();
		const promise = Promise.resolve().then(async () => {
			const suggestions: ReviewResult["suggestions"] = [];
			let reviewed = 0;
			let remaining = 0;
			for (let chunk = 1; chunk <= 3; chunk++) {
				controller.signal.throwIfAborted();
				this.status = `Analyzing chunk ${chunk}/3${chunk > 1 ? `; ${remaining} entries remain` : ""}`;
				this.changed();
				const result = await this.review({ ...input, signal: controller.signal, suggestionLimit: 3 - suggestions.length });
				suggestions.push(...result.suggestions);
				reviewed += result.reviewed;
				remaining = result.remaining ?? 0;
				this.remaining = remaining;
				if (!remaining || !result.reviewed || suggestions.length >= 3) break;
			}
			return { suggestions, reviewed, remaining, message: `${reviewed} entries reviewed; ${suggestions.length} suggestions. ${remaining ? `${remaining} entries remain; run Analyze now or wait for the next idle period.` : "Caught up with this branch."}` };
		});
		this.active = promise.then((result) => {
			this.status = result.message;
			return result;
		}, (error) => {
			this.status = controller.signal.aborted ? "Cancelled. Completed chunks saved; unfinished chunk will retry." : `Error: ${error instanceof Error ? error.message : String(error)}`;
			throw error;
		}).finally(() => {
			this.active = undefined;
			this.controller = undefined;
			this.changed();
		});
		return this.active;
	}
}
