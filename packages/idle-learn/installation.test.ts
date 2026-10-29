import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

const exec = promisify(execFile);

test("installed tarball runs every worker purpose using host SDK peers without local SDK copies", { timeout: 120_000 }, async () => {
	const temporary = mkdtempSync(join(tmpdir(), "idle-learn-install-"));
	const project = join(temporary, "project");
	const agent = join(temporary, "agent");
	mkdirSync(project); mkdirSync(agent);
	writeFileSync(join(project, "AGENTS.md"), "AMBIENT_PROJECT_INSTRUCTIONS");
	writeFileSync(join(agent, "AGENTS.md"), "AMBIENT_GLOBAL_INSTRUCTIONS");
	const requests: any[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8"); request.on("data", (part) => { body += part; });
		request.on("end", () => {
			requests.push(JSON.parse(body));
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content: '{"verified":true}' }, finish_reason: null }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
			response.end("data: [DONE]\n\n");
		});
	});
	try {
		const repository = fileURLToPath(new URL("../../", import.meta.url));
		const packed = await exec("npm", ["pack", "--workspace", "@mblarsen/pi-idle-learn", "--ignore-scripts", "--json", "--pack-destination", temporary], { cwd: repository });
		const [{ filename, files }] = JSON.parse(packed.stdout);
		assert.ok(files.some((file: { path: string }) => file.path === "worker-launcher.mjs"));
		assert.ok(files.some((file: { path: string }) => file.path === "integration-prompt.md"));
		assert.ok(files.every((file: { path: string }) => !file.path.endsWith(".test.ts")));
		// Pi deliberately suppresses peer installation. Reproduce that dependency layout.
		await exec("npm", ["install", "--prefix", temporary, "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund", join(temporary, filename)], { timeout: 60_000 });
		const installed = join(temporary, "node_modules/@mblarsen/pi-idle-learn");
		assert.equal(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).name, "@mblarsen/pi-idle-learn");
		assert.equal(existsSync(join(temporary, "node_modules/@earendil-works/pi-coding-agent")), false);
		assert.equal(existsSync(join(installed, "node_modules/@earendil-works/pi-coding-agent")), false);
		assert.ok(!dirname(installed).startsWith(repository));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address(); assert.ok(address && typeof address === "object");
		writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { "idle-test": { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local-test-key", models: [{ id: "test-model", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
		for (const purpose of [undefined, "calibration", "refresh", "integrate"]) {
			const result = await new Promise<{ code: number | null; output: string; error: string }>((resolve, reject) => {
				const child = spawn(process.execPath, [join(installed, "worker-launcher.mjs"), process.env.PI_IDLE_LEARN_TEST_HOST ?? getPackageDir()], {
					cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agent, NODE_PATH: "" }, stdio: ["pipe", "pipe", "pipe"], timeout: 20_000,
				});
				let output = "", error = "";
				child.stdout.on("data", (part) => { output += part; }); child.stderr.on("data", (part) => { error += part; });
				child.on("error", reject); child.on("close", (code) => resolve({ code, output, error }));
				child.stdin.end(JSON.stringify({ root: project, provider: "idle-test", model: "test-model", thinking: "off", purpose, systemPrompt: "Use only the supplied test evidence. Return JSON.", evidence: "Return {\"verified\":true}." }));
			});
			assert.equal(result.code, 0, `${purpose ?? "analyze"}: ${result.output}\n${result.error}`);
			assert.deepEqual(JSON.parse(result.output), { ok: true, result: { verified: true } });
			const request = requests.at(-1);
			assert.deepEqual((request.tools ?? []).map((tool: any) => tool.function.name).sort(), purpose ? [] : ["evidence_list", "evidence_read"]);
			assert.doesNotMatch(JSON.stringify(request), /AMBIENT_PROJECT_INSTRUCTIONS|AMBIENT_GLOBAL_INSTRUCTIONS/);
		}
		assert.equal(requests.length, 4);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(temporary, { recursive: true, force: true });
	}
});
