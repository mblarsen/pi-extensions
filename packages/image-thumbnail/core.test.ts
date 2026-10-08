import assert from "node:assert/strict";
import test from "node:test";
import { addedPaths, clipboardPaths, PREVIEW_MS, PreviewQueue } from "./core.ts";

const first = "/tmp/pi-clipboard-12345678-abcd-4321-abcd-123456789abc.png";
const second = "/tmp/pi-clipboard-87654321-abcd-4321-abcd-123456789abc.jpg";

test("finds clipboard paths without treating other images as pastes", () => {
	assert.deepEqual(clipboardPaths(`Look ${first}\n${second} /tmp/photo.png pi-clipboard-not-a-uuid.png`), [first, second]);
	assert.deepEqual(clipboardPaths(`"/tmp/with spaces${first}"`), [`/tmp/with spaces${first}`]);
	const windows = "C:\\Temp\\pi-clipboard-12345678-abcd-4321-abcd-123456789abc.webp";
	assert.deepEqual(clipboardPaths(windows), [windows]);
});

test("detects newly added occurrences, not edits around existing paths", () => {
	assert.deepEqual(addedPaths([first], [first, second]), [second]);
	assert.deepEqual(addedPaths([first, second], [second, first]), []);
	assert.deepEqual(addedPaths([first], [first, first]), [first]);
	assert.deepEqual(addedPaths([first], []), []);
	assert.deepEqual(addedPaths([], [first]), [first]);
});

test("each thumbnail expires three seconds after its first render", () => {
	const queue = new PreviewQueue<string>();
	queue.add("older");
	assert.equal(queue.nextExpiry(), undefined);
	assert.equal(queue.expire(90_000), false);
	queue.markDisplayed([0], 100_000);
	queue.add("newer");
	queue.markDisplayed([0, 1], 101_000);
	assert.deepEqual(queue.items.map((item) => item.value), ["older", "newer"]);
	assert.equal(queue.nextExpiry(), 100_000 + PREVIEW_MS);
	assert.equal(queue.expire(102_999), false);
	assert.equal(queue.expire(103_000), true);
	assert.deepEqual(queue.items.map((item) => item.value), ["newer"]);
	assert.equal(queue.nextExpiry(), 104_000);
	assert.equal(queue.expire(104_000), true);
	assert.deepEqual(queue.items, []);
});
