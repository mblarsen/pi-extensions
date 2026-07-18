import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workmuxRenameExtension from "./index.ts";

test("registers /workmux-rename with branch completion", () => {
	let commandName: string | undefined;
	let commandOptions: {
		description?: string;
		getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null;
	} | undefined;

	const pi = {
		registerCommand(name: string, options: typeof commandOptions) {
			commandName = name;
			commandOptions = options;
		},
	} as unknown as ExtensionAPI;

	workmuxRenameExtension(pi);

	assert.equal(commandName, "workmux-rename");
	assert.match(commandOptions?.description ?? "", /move this Pi session/);
	assert.deepEqual(commandOptions?.getArgumentCompletions?.("--br")?.map((item) => item.value), ["--branch"]);
});
