import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	CONTEXT_ERROR_TOKENS,
	CONTEXT_WARNING_TOKENS,
	HandoffMonitor,
	SESSION_EXPIRY_MS,
	evaluateHandoffStatus,
	getLatestMessageTimestamp,
	type HandoffStatus,
} from "./core.ts";

describe("evaluateHandoffStatus", () => {
	test("uses warning and error colors above the context thresholds", () => {
		assert.equal(evaluateHandoffStatus(CONTEXT_WARNING_TOKENS, undefined, 0), undefined);
		assert.deepEqual(evaluateHandoffStatus(CONTEXT_WARNING_TOKENS + 1, undefined, 0), {
			label: "handoff",
			tone: "warning",
		});
		assert.equal(evaluateHandoffStatus(CONTEXT_ERROR_TOKENS, undefined, 0)?.tone, "warning");
		assert.deepEqual(evaluateHandoffStatus(CONTEXT_ERROR_TOKENS + 1, undefined, 0), {
			label: "handoff",
			tone: "error",
		});
	});

	test("gives an expired session precedence over context usage", () => {
		assert.equal(evaluateHandoffStatus(0, 0, SESSION_EXPIRY_MS), undefined);
		assert.deepEqual(evaluateHandoffStatus(CONTEXT_ERROR_TOKENS + 1, 0, SESSION_EXPIRY_MS + 1), {
			label: "likely expired",
			tone: "error",
		});
	});
});

describe("getLatestMessageTimestamp", () => {
	test("uses the newest message regardless of its role", () => {
		assert.equal(
			getLatestMessageTimestamp([
				{ type: "message", timestamp: "2026-01-01T10:00:00.000Z", message: { timestamp: 100 } },
				{ type: "model_change", timestamp: "2026-01-01T13:00:00.000Z" },
				{ type: "message", timestamp: "2026-01-01T11:00:00.000Z", message: { timestamp: 300 } },
				{ type: "message", timestamp: "2026-01-01T12:00:00.000Z", message: { timestamp: 200 } },
			]),
			300,
		);
	});

	test("includes custom messages and ignores non-message metadata", () => {
		assert.equal(
			getLatestMessageTimestamp([
				{ type: "label", timestamp: "2026-01-01T13:00:00.000Z" },
				{ type: "custom_message", timestamp: "2026-01-01T12:00:00.000Z" },
			]),
			Date.parse("2026-01-01T12:00:00.000Z"),
		);
	});
});

describe("HandoffMonitor", () => {
	test("shows expiry when its one-shot timer reaches the inactivity boundary", () => {
		let now = 1_000;
		let callback: (() => void) | undefined;
		let scheduledDelay: number | undefined;
		const rendered: HandoffStatus[] = [];

		const monitor = new HandoffMonitor({
			getContextTokens: () => CONTEXT_WARNING_TOKENS + 1,
			renderStatus: (status) => rendered.push(status),
			now: () => now,
			setTimer: (nextCallback, delayMs) => {
				callback = nextCallback;
				scheduledDelay = delayMs;
				return 1 as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimer: () => {},
		});

		monitor.reset(now);
		assert.deepEqual(rendered.at(-1), { label: "handoff", tone: "warning" });
		assert.equal(scheduledDelay, SESSION_EXPIRY_MS + 1);

		now += SESSION_EXPIRY_MS + 1;
		callback?.();
		assert.deepEqual(rendered.at(-1), { label: "likely expired", tone: "error" });
		monitor.dispose();
	});

	test("a new message clears expiry and reschedules the timer", () => {
		let now = SESSION_EXPIRY_MS + 1;
		let clearCount = 0;
		const delays: number[] = [];
		const rendered: HandoffStatus[] = [];

		const monitor = new HandoffMonitor({
			getContextTokens: () => 0,
			renderStatus: (status) => rendered.push(status),
			now: () => now,
			setTimer: (_callback, delayMs) => {
				delays.push(delayMs);
				return delays.length as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimer: () => {
				clearCount += 1;
			},
		});

		monitor.reset(0);
		assert.equal(rendered.at(-1)?.label, "likely expired");

		monitor.recordMessage(now);
		assert.equal(rendered.at(-1), undefined);
		assert.deepEqual(delays, [SESSION_EXPIRY_MS + 1]);

		monitor.refresh();
		assert.equal(clearCount, 1);
		monitor.dispose();
		assert.equal(clearCount, 2);
		assert.equal(rendered.at(-1), undefined);
	});
});
