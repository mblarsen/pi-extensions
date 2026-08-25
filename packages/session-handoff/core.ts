export const CONTEXT_WARNING_TOKENS = 50_000;
export const CONTEXT_ERROR_TOKENS = 100_000;
export const SESSION_EXPIRY_MS = 30 * 60 * 1000;

export type HandoffStatus =
	| { label: "handoff"; tone: "warning" | "error" }
	| { label: "likely expired"; tone: "error" }
	| undefined;

type SessionEntryLike = {
	type: string;
	timestamp?: string;
	message?: { timestamp?: number };
};

export function evaluateHandoffStatus(
	contextTokens: number | null | undefined,
	lastMessageAt: number | undefined,
	now: number,
): HandoffStatus {
	if (lastMessageAt !== undefined && now - lastMessageAt > SESSION_EXPIRY_MS) {
		return { label: "likely expired", tone: "error" };
	}
	if (contextTokens !== null && contextTokens !== undefined && contextTokens > CONTEXT_ERROR_TOKENS) {
		return { label: "handoff", tone: "error" };
	}
	if (contextTokens !== null && contextTokens !== undefined && contextTokens > CONTEXT_WARNING_TOKENS) {
		return { label: "handoff", tone: "warning" };
	}
	return undefined;
}

export function getLatestMessageTimestamp(entries: readonly SessionEntryLike[]): number | undefined {
	let latest: number | undefined;

	for (const entry of entries) {
		if (entry.type !== "message" && entry.type !== "custom_message") continue;
		const timestamp = entry.message?.timestamp ?? (entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN);
		if (!Number.isFinite(timestamp)) continue;
		latest = latest === undefined ? timestamp : Math.max(latest, timestamp);
	}

	return latest;
}

type TimerHandle = ReturnType<typeof setTimeout>;

type HandoffMonitorOptions = {
	getContextTokens: () => number | null | undefined;
	renderStatus: (status: HandoffStatus) => void;
	now?: () => number;
	setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
	clearTimer?: (timer: TimerHandle) => void;
};

export class HandoffMonitor {
	private readonly getContextTokens: HandoffMonitorOptions["getContextTokens"];
	private readonly renderStatus: HandoffMonitorOptions["renderStatus"];
	private readonly now: () => number;
	private readonly setTimer: NonNullable<HandoffMonitorOptions["setTimer"]>;
	private readonly clearTimer: NonNullable<HandoffMonitorOptions["clearTimer"]>;
	private lastMessageAt: number | undefined;
	private expiryTimer: TimerHandle | undefined;

	constructor(options: HandoffMonitorOptions) {
		this.getContextTokens = options.getContextTokens;
		this.renderStatus = options.renderStatus;
		this.now = options.now ?? Date.now;
		this.setTimer = options.setTimer ?? setTimeout;
		this.clearTimer = options.clearTimer ?? clearTimeout;
	}

	reset(lastMessageAt: number | undefined): void {
		this.lastMessageAt = lastMessageAt;
		this.refresh();
	}

	recordMessage(timestamp = this.now()): void {
		if (Number.isFinite(timestamp)) {
			this.lastMessageAt = Math.max(this.lastMessageAt ?? timestamp, timestamp);
		}
		this.refresh();
	}

	refresh(): void {
		this.cancelExpiryTimer();
		const now = this.now();
		const status = evaluateHandoffStatus(this.getContextTokens(), this.lastMessageAt, now);
		this.renderStatus(status);

		if (this.lastMessageAt !== undefined && status?.label !== "likely expired") {
			const delayMs = Math.max(1, this.lastMessageAt + SESSION_EXPIRY_MS - now + 1);
			this.expiryTimer = this.setTimer(() => {
				this.expiryTimer = undefined;
				this.refresh();
			}, delayMs);
		}
	}

	dispose(): void {
		this.cancelExpiryTimer();
		this.renderStatus(undefined);
	}

	private cancelExpiryTimer(): void {
		if (this.expiryTimer === undefined) return;
		this.clearTimer(this.expiryTimer);
		this.expiryTimer = undefined;
	}
}
