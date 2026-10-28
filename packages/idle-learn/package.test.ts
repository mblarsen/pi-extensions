import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("host-provided packages use wildcard peers, not runtime dependencies", () => {
	const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
	for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
		assert.equal(manifest.dependencies?.[name], undefined, `${name} must not be a runtime dependency`);
		assert.equal(manifest.peerDependencies?.[name], "*", `${name} must use a wildcard peer range`);
	}
});
