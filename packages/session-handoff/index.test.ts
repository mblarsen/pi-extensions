import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import sessionHandoffExtension from "./index.ts";
import { CONTEXT_WARNING_TOKENS, SESSION_EXPIRY_MS } from "./core.ts";

type Handler = (event: { message?: { timestamp: number } }, ctx: ExtensionContext) => Promise<unknown> | unknown;

function registerExtension(): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	sessionHandoffExtension(pi);
	return handlers;
}

function createContext(options: {
	mode?: "tui" | "print";
	contextTokens?: number;
	lastMessageAt?: number;
	statuses: Array<string | undefined>;
}): ExtensionContext {
	return {
		mode: options.mode ?? "tui",
		ui: {
			theme: {
				fg: (tone: string, text: string) => `<${tone}>${text}</${tone}>`,
			},
			setStatus: (_key: string, text: string | undefined) => options.statuses.push(text),
		},
		getContextUsage: () => ({
			tokens: options.contextTokens ?? 0,
			contextWindow: 200_000,
			percent: 0,
		}),
		sessionManager: {
			getBranch: () =>
				options.lastMessageAt === undefined
					? []
					: [
							{
								type: "message",
								id: "message",
								parentId: null,
								timestamp: new Date(options.lastMessageAt).toISOString(),
								message: { timestamp: options.lastMessageAt },
							},
						],
		},
	} as unknown as ExtensionContext;
}

test("renders only the themed status label and refreshes after any message", async () => {
	const statuses: Array<string | undefined> = [];
	const handlers = registerExtension();
	const ctx = createContext({
		contextTokens: CONTEXT_WARNING_TOKENS + 1,
		lastMessageAt: Date.now() - SESSION_EXPIRY_MS - 1_000,
		statuses,
	});

	await handlers.get("session_start")?.({}, ctx);
	assert.equal(statuses.at(-1), "<error>likely expired</error>");

	await handlers.get("message_end")?.({ message: { timestamp: Date.now() } }, ctx);
	assert.equal(statuses.at(-1), "<warning>handoff</warning>");

	await handlers.get("session_shutdown")?.({}, ctx);
	assert.equal(statuses.at(-1), undefined);
});

test("does not start footer monitoring outside TUI mode", async () => {
	const statuses: Array<string | undefined> = [];
	const handlers = registerExtension();
	const ctx = createContext({ mode: "print", statuses });

	await handlers.get("session_start")?.({}, ctx);
	assert.deepEqual(statuses, []);
});
