import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { join, isAbsolute } from "node:path";

let input = "";
process.stdin.setEncoding("utf8");
try {
	for await (const chunk of process.stdin) {
		input += chunk.toString("utf8");
		if (Buffer.byteLength(input) > 512 * 1024) throw new Error("Reviewer input exceeds the limit.");
	}
	const hostDir = process.argv[2];
	if (!hostDir || !isAbsolute(hostDir)) throw new Error("Reviewer requires the running Pi host package path.");
	// Pi maps host peers in-process. The isolated worker needs the same host's physical entrypoints.
	const hostLoader = createJiti(join(hostDir, "package.json"));
	const hostEntry = (name) => fileURLToPath(hostLoader.esmResolve(name));
	const alias = {
		"@earendil-works/pi-coding-agent": join(hostDir, "dist/index.js"),
		"@earendil-works/pi-ai": hostEntry("@earendil-works/pi-ai/compat"),
		"@earendil-works/pi-agent-core": hostEntry("@earendil-works/pi-agent-core"),
		"@earendil-works/pi-tui": hostEntry("@earendil-works/pi-tui"),
		typebox: hostEntry("typebox"),
	};
	const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias });
	const { runWorker } = await jiti.import("./worker.ts");
	const result = await runWorker(JSON.parse(input));
	process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
	process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Reviewer failed." }));
	process.exitCode = 1;
}
