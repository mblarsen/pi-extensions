import assert from "node:assert/strict";
import test from "node:test";
import { parseReplyArgs, replyArgumentCompletions, replyUsage } from "./command.ts";

test("subcommands parse with their aliases", () => {
	assert.deepEqual(parseReplyArgs("prev"), { command: "prev", value: "" });
	assert.deepEqual(parseReplyArgs("previous"), { command: "prev", value: "" });
	assert.deepEqual(parseReplyArgs("N"), { command: "next", value: "" });
	assert.deepEqual(parseReplyArgs("  next  "), { command: "next", value: "" });
	assert.deepEqual(parseReplyArgs("debug"), { command: "debug", value: "" });
});

test("context collects the rest of the arguments", () => {
	assert.deepEqual(parseReplyArgs("context"), { command: "context", value: "" });
	assert.deepEqual(parseReplyArgs("context 2/3"), { command: "context", value: "2/3" });
	assert.deepEqual(parseReplyArgs("c 5"), { command: "context", value: "5" });
});

test("unknown or over-long arguments fall back to help", () => {
	assert.deepEqual(parseReplyArgs(""), { command: "help", value: "" });
	assert.deepEqual(parseReplyArgs("   "), { command: "help", value: "" });
	assert.deepEqual(parseReplyArgs("jump"), { command: "help", value: "", unknown: "jump" });
	assert.deepEqual(parseReplyArgs("prev now"), { command: "help", value: "", unknown: "prev now" });
});

test("completion offers the subcommands", () => {
	const all = replyArgumentCompletions("");
	assert.deepEqual(
		all?.map((item) => item.label),
		["prev", "next", "context", "debug"],
	);
	assert.equal(all?.[2]?.value, "context ");
	assert.equal(all?.[0]?.description, "Jump to the previous message");

	assert.deepEqual(
		replyArgumentCompletions("ne")?.map((item) => item.label),
		["next"],
	);
	assert.equal(replyArgumentCompletions("zzz"), null);
});

test("completion offers context presets once the subcommand is typed", () => {
	assert.deepEqual(
		replyArgumentCompletions("context ")?.map((item) => item.label),
		["2/3", "1/2", "1/3", "10", "5", "0"],
	);
	assert.deepEqual(
		replyArgumentCompletions("context 1")?.map((item) => item.value),
		["context 1/2", "context 1/3", "context 10"],
	);
	// The bare subcommand is still completed rather than treated as a value.
	assert.deepEqual(
		replyArgumentCompletions("context")?.map((item) => item.label),
		["context"],
	);
	// Subcommands without a value offer nothing.
	assert.equal(replyArgumentCompletions("prev "), null);
	assert.equal(replyArgumentCompletions("debug x"), null);
});

test("usage names every subcommand and the current context", () => {
	assert.equal(
		replyUsage("2/3"),
		"Assistant jump: /reply prev | next | context | debug · context 2/3",
	);
});
