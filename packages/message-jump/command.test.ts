import assert from "node:assert/strict";
import test from "node:test";
import { parseJumpArgs, jumpArgumentCompletions, jumpUsage } from "./command.ts";

test("subcommands parse with their aliases", () => {
	assert.deepEqual(parseJumpArgs("prev"), { command: "prev", value: "" });
	assert.deepEqual(parseJumpArgs("previous"), { command: "prev", value: "" });
	assert.deepEqual(parseJumpArgs("N"), { command: "next", value: "" });
	assert.deepEqual(parseJumpArgs("  next  "), { command: "next", value: "" });
	assert.deepEqual(parseJumpArgs("debug"), { command: "debug", value: "" });
});

test("context collects the rest of the arguments", () => {
	assert.deepEqual(parseJumpArgs("context"), { command: "context", value: "" });
	assert.deepEqual(parseJumpArgs("context 2/3"), { command: "context", value: "2/3" });
	assert.deepEqual(parseJumpArgs("c 5"), { command: "context", value: "5" });
});

test("unknown or over-long arguments fall back to help", () => {
	assert.deepEqual(parseJumpArgs(""), { command: "help", value: "" });
	assert.deepEqual(parseJumpArgs("   "), { command: "help", value: "" });
	assert.deepEqual(parseJumpArgs("jump"), { command: "help", value: "", unknown: "jump" });
	assert.deepEqual(parseJumpArgs("prev now"), { command: "help", value: "", unknown: "prev now" });
});

test("completion offers the subcommands", () => {
	const all = jumpArgumentCompletions("");
	assert.deepEqual(
		all?.map((item) => item.label),
		["prev", "next", "context", "debug"],
	);
	assert.equal(all?.[2]?.value, "context ");
	assert.equal(all?.[0]?.description, "Jump to the previous message");

	assert.deepEqual(
		jumpArgumentCompletions("ne")?.map((item) => item.label),
		["next"],
	);
	assert.equal(jumpArgumentCompletions("zzz"), null);
});

test("completion offers context presets once the subcommand is typed", () => {
	assert.deepEqual(
		jumpArgumentCompletions("context ")?.map((item) => item.label),
		["2/3", "1/2", "1/3", "10", "5", "0"],
	);
	assert.deepEqual(
		jumpArgumentCompletions("context 1")?.map((item) => item.value),
		["jump 1/2", "jump 1/3", "jump 10"],
	);
	// The bare subcommand is still completed rather than treated as a value.
	assert.deepEqual(
		jumpArgumentCompletions("context")?.map((item) => item.label),
		["context"],
	);
	// Subcommands without a value offer nothing.
	assert.equal(jumpArgumentCompletions("prev "), null);
	assert.equal(jumpArgumentCompletions("debug x"), null);
});

test("usage names every subcommand and the current context", () => {
	assert.equal(
		jumpUsage("2/3"),
		"Message jump: /jump prev | next | context | debug · context 2/3",
	);
});
