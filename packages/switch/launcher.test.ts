import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";

const launcher = new URL("./launcher.mjs", import.meta.url);

async function run(scenario: string) {
	const dir = await mkdtemp(join(tmpdir(), "switch-test-"));
	const session = join(dir, "session ' $;.jsonl");
	const log = join(dir, "log");
	const host = join(dir, "fake host.mjs");
	await writeFile(session, '{"type":"session","version":3,"id":"test-id"}\n');
	await writeFile(host, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createConnection } from 'node:net';
const env = process.env;
const ask = (message) => new Promise((resolve, reject) => {
 const socket = createConnection(env.PI_SWITCH_SOCKET);
 let data = '';
 socket.on('error', reject);
 socket.on('connect', () => socket.write(JSON.stringify({...message, token: env.PI_SWITCH_TOKEN}) + '\\n'));
 socket.on('data', chunk => {data += chunk; if(data.includes('\\n')) { socket.destroy(); resolve(JSON.parse(data)); }});
});
appendFileSync(env.TEST_LOG, JSON.stringify({host:env.PI_SWITCH_HOST,args:process.argv.slice(2),cwd:process.cwd(),transport:env.PIG_EXT_SOCKET})+'\\n');
if (env.PI_SWITCH_HOST === 'pi') {
 if (env.TEST_SCENARIO === 'ordinary') process.exit(0);
 const reply = await ask({action:'switch',target:'pig',id:'test-id',file:env.TEST_SESSION,cwd:process.cwd(),leaf:null});
 appendFileSync(env.TEST_LOG, JSON.stringify(reply)+'\\n');
 if (reply.ok && env.TEST_SCENARIO !== 'uncommitted') await ask({action:'commit',leaf:'handoff-leaf'});
 if (env.TEST_SCENARIO === 'cancel') await ask({action:'cancel'});
 if (env.TEST_SCENARIO === 'crash') process.exit(7);
 if (env.TEST_SCENARIO === 'signal') process.kill(process.pid, 'SIGTERM');
} else if (env.TEST_SCENARIO !== 'unconfirmed') {
 await ask({action:'ready'});
}
`, { mode: 0o755 });
	try {
		const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
			const child = spawn(process.execPath, [launcher.pathname, "pi", "initial prompt"], {
				cwd: dir,
				env: { ...process.env, PI_SWITCH_PI_BIN: host, PI_SWITCH_PIG_BIN: scenario === "missing" ? join(dir, "missing") : host,
					PIG_EXT_SOCKET: "stale", TEST_LOG: log, TEST_SESSION: session, TEST_SCENARIO: scenario },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderr = "";
			child.stderr.on("data", (chunk) => { stderr += chunk; });
			child.once("error", reject);
			child.once("exit", (code) => resolve({ code, stderr }));
		});
		return { ...result, entries: (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)) };
	} finally { await rm(dir, { recursive: true, force: true }); }
}

test("launcher hands off only after exit, with ID only and no replayed prompt", async () => {
	const { code, entries } = await run("switch");
	assert.equal(code, 0);
	assert.deepEqual(entries.map((entry) => entry.host).filter(Boolean), ["pi", "pig"]);
	assert.deepEqual(entries[2].args.slice(2), ["--session", "test-id"]);
	assert.equal(entries[2].cwd, entries[0].cwd);
	assert.equal(entries[2].transport, undefined);
	assert.equal(entries[1].ok, true);
});
for (const scenario of ["ordinary", "cancel", "crash", "signal", "missing", "uncommitted"]) {
	test(`launcher does not switch after ${scenario}`, async () => {
		const { entries, code } = await run(scenario);
		assert.equal(entries.filter((entry) => entry.host).length, 1);
		if (scenario === "crash") assert.equal(code, 7);
		if (scenario === "missing") assert.equal(entries[1].ok, false);
	});
}
test("unconfirmed target reports recovery rather than claiming success", async () => {
	const result = await run("unconfirmed");
	assert.equal(result.code, 1);
	assert.match(result.stderr, /Recover: cd .* --session 'test-id'/);
});
