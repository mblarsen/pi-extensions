import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import ferdExtension from "./index.ts";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

function registerFerd(): CommandHandler {
	let handler: CommandHandler | undefined;
	const pi = new Proxy({}, {
		get: (_target, property) => {
			if (property === "registerCommand") {
				return (name: string, command: { handler: CommandHandler }) => {
					if (name === "ferd") handler = command.handler;
				};
			}
			return () => undefined;
		},
	}) as ExtensionAPI;

	ferdExtension(pi);
	assert.ok(handler);
	return handler;
}

test("forks with the public SessionManager API", async () => {
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-ferd-test-"));
	const originalHerdrEnv = process.env.HERDR_ENV;
	const notices: string[] = [];

	try {
		const sessionManager = SessionManager.create(process.cwd(), sessionDir);
		sessionManager.appendMessage({ role: "user", content: "Fork this session", timestamp: Date.now() });
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Ready to fork" }],
			api: "openai-responses",
			provider: "openai",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		process.env.HERDR_ENV = "0";

		await registerFerd()("", {
			cwd: process.cwd(),
			hasUI: true,
			isIdle: () => true,
			sessionManager,
			ui: {
				notify: (message: string) => notices.push(message),
				setWidget: () => undefined,
			},
		} as unknown as ExtensionCommandContext);

		assert.match(notices.join("\n"), /Not running inside Herdr/);
		assert.doesNotMatch(notices.join("\n"), /Cannot find module|dist\/dist/);
	} finally {
		if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = originalHerdrEnv;
		rmSync(sessionDir, { recursive: true, force: true });
	}
});
