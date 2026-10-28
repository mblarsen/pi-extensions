import { createJiti } from "jiti";

let input = "";
process.stdin.setEncoding("utf8");
try {
	for await (const chunk of process.stdin) {
		input += chunk.toString("utf8");
		if (Buffer.byteLength(input) > 512 * 1024) throw new Error("Reviewer input exceeds the limit.");
	}
	const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
	const { runWorker } = await jiti.import("./worker.ts");
	const result = await runWorker(JSON.parse(input));
	process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
	process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Reviewer failed." }));
	process.exitCode = 1;
}
