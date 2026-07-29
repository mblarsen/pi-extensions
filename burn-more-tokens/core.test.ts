import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	DEFAULT_AWTRIX_URL,
	isQuietHours,
	normalizeAwtrixUrl,
	randomMessage,
	tryDisplayMessage,
} from "./core.ts";

describe("normalizeAwtrixUrl", () => {
	test("uses the default display and normalizes custom hosts", () => {
		assert.equal(normalizeAwtrixUrl(undefined), DEFAULT_AWTRIX_URL);
		assert.equal(normalizeAwtrixUrl("192.168.1.20/"), "http://192.168.1.20");
		assert.equal(normalizeAwtrixUrl("https://display.local///"), "https://display.local");
	});

	test("allows the display integration to be disabled", () => {
		assert.equal(normalizeAwtrixUrl(""), undefined);
	});
});

describe("randomMessage", () => {
	test("selects deterministically from the message list", () => {
		assert.equal(randomMessage(() => 0), "michael, let's burn more tokens");
	});
});

describe("isQuietHours", () => {
	test("covers the overnight quiet-hours window", () => {
		assert.equal(isQuietHours(new Date(2026, 0, 1, 7, 59)), true);
		assert.equal(isQuietHours(new Date(2026, 0, 1, 8, 0)), false);
		assert.equal(isQuietHours(new Date(2026, 0, 1, 19, 59)), false);
		assert.equal(isQuietHours(new Date(2026, 0, 1, 20, 0)), true);
	});
});

describe("tryDisplayMessage", () => {
	test("posts a lowercase scrolling notification", async () => {
		let requestUrl = "";
		let requestInit: RequestInit | undefined;
		const fetchImpl: typeof fetch = async (input, init) => {
			requestUrl = String(input);
			requestInit = init;
			return new Response("OK", { status: 200 });
		};

		assert.equal(
			await tryDisplayMessage("SHIP IT", {
				baseUrl: "display.local/",
				fetchImpl,
			}),
			true,
		);
		assert.equal(requestUrl, "http://display.local/api/notify");
		assert.equal(requestInit?.method, "POST");
		assert.deepEqual(JSON.parse(String(requestInit?.body)), {
			text: "ship it",
			textCase: 2,
			center: false,
			repeat: 1,
			duration: 5,
			stack: false,
			scrollSpeed: 100,
		});
	});

	test("reports unavailable displays for fallback handling", async () => {
		const unavailable: typeof fetch = async () => {
			throw new Error("offline");
		};
		const rejected: typeof fetch = async () => new Response("no", { status: 503 });

		assert.equal(
			await tryDisplayMessage("done", { baseUrl: "display.local", fetchImpl: unavailable }),
			false,
		);
		assert.equal(
			await tryDisplayMessage("done", { baseUrl: "display.local", fetchImpl: rejected }),
			false,
		);
	});
});
