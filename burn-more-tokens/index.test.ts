import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { announce } from "./index.ts";

describe("announce", () => {
	test("sends to AWTRIX even when speech is disabled", async () => {
		const displayed: string[] = [];
		const spoken: string[] = [];

		await announce("done", false, {
			display: async (message) => {
				displayed.push(message);
				return true;
			},
			speechEnabled: () => false,
			speak: (message) => spoken.push(message),
		});

		assert.deepEqual(displayed, ["done"]);
		assert.deepEqual(spoken, []);
	});

	test("quiet hours suppress only the speech fallback", async () => {
		let displayAttempts = 0;
		const spoken: string[] = [];

		await announce("done", false, {
			display: async () => {
				displayAttempts += 1;
				return false;
			},
			speechEnabled: () => false,
			speak: (message) => spoken.push(message),
		});

		assert.equal(displayAttempts, 1);
		assert.deepEqual(spoken, []);
	});

	test("a forced announcement can use speech during quiet hours", async () => {
		const spoken: string[] = [];

		await announce("done", true, {
			display: async () => false,
			speechEnabled: () => false,
			speak: (message) => spoken.push(message),
		});

		assert.deepEqual(spoken, ["done"]);
	});
});
