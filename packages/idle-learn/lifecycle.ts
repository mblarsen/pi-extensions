import { analyze, type ReviewInput, type ReviewResult } from "./reviewer.ts";

export class IdleReviewer {
	status = "Ready";
	remaining = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private controller?: AbortController;
	private active?: Promise<ReviewResult>;
	private mode?: "idle" | "manual";
	private cancellationReason?: string;
	private changed: () => void;
	private review: typeof analyze;
	constructor(changed: () => void, review: typeof analyze = analyze) { this.changed = changed; this.review = review; }
	get running(): boolean { return this.active !== undefined; }
	clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
	async resumeWork(): Promise<void> {
		this.clearTimer();
		if (this.mode !== "manual") await this.cancel("work resumed");
	}
	async cancel(reason = "stopped by user"): Promise<void> {
		this.clearTimer();
		if (this.controller && !this.controller.signal.aborted) {
			this.cancellationReason = reason;
			this.controller.abort();
		}
		if (this.active) await this.active.catch(() => {});
	}
	schedule(milliseconds: number, snapshot: () => Omit<ReviewInput, "signal"> | undefined, shouldContinue: () => boolean = () => false): void {
		this.clearTimer();
		if (this.running) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			const input = snapshot();
			if (input) void this.start(input).then((result) => {
				if (result.remaining || input.purpose === "calibration" || shouldContinue()) this.schedule(milliseconds, snapshot, shouldContinue);
			}).catch(() => {});
		}, milliseconds);
		this.timer.unref();
	}
	start(input: Omit<ReviewInput, "signal">, mode: "idle" | "manual" = "idle"): Promise<ReviewResult> {
		if (this.active) return Promise.reject(new Error("A review is already running for this session."));
		this.clearTimer();
		const controller = new AbortController();
		this.controller = controller;
		this.cancellationReason = undefined;
		this.mode = mode;
		this.status = input.purpose === "calibration" ? "Calibrating project reviewer" : mode === "manual" ? "Analyzing snapshot in background" : "Analyzing (resume work to cancel)";
		const promise = Promise.resolve().then(async () => {
			const suggestions: ReviewResult["suggestions"] = [];
			let reviewed = 0;
			let remaining = 0;
			for (let chunk = 1; chunk <= 3; chunk++) {
				controller.signal.throwIfAborted();
				this.status = input.purpose === "calibration" ? "Calibrating project reviewer" : input.guidance ? "Analyzing recent conversation with guidance" : `Analyzing chunk ${chunk}/3${chunk > 1 ? `; ${remaining} entries remain` : ""}`;
				this.changed();
				const result = await this.review({ ...input, signal: controller.signal, suggestionLimit: 3 - suggestions.length });
				if (input.purpose === "calibration") return result;
				if (input.guidance) return { ...result, remaining: 0, message: `${result.reviewed} recent entries reviewed with guidance; ${result.suggestions.length} suggestions. Normal analysis progress unchanged.` };
				suggestions.push(...result.suggestions);
				reviewed += result.reviewed;
				remaining = result.remaining ?? 0;
				this.remaining = remaining;
				if (!remaining || !result.reviewed || suggestions.length >= 3) break;
			}
			return { suggestions, reviewed, remaining, message: `${reviewed} entries reviewed; ${suggestions.length} suggestions. ${remaining ? `${remaining} entries remain; run Analyze now or wait for the next idle period.` : mode === "manual" ? "Captured snapshot reviewed." : "Caught up with this branch."}` };
		});
		this.active = promise.then((result) => {
			this.status = result.message;
			return result;
		}, (error) => {
			this.status = controller.signal.aborted
				? input.purpose === "calibration"
					? `Cancelled calibration: ${this.cancellationReason}. Run /idle-learn calibrate to retry.`
					: `Cancelled review: ${this.cancellationReason}. Completed chunks saved; unfinished work remains unreviewed.`
				: `Error: ${error instanceof Error ? error.message : String(error)}`;
			throw error;
		}).finally(() => {
			this.active = undefined;
			this.controller = undefined;
			this.mode = undefined;
			this.changed();
		});
		this.changed();
		return this.active;
	}
}
