export const DEFAULT_AWTRIX_URL = "http://192.168.100.159";
export const DEFAULT_AWTRIX_TIMEOUT_MS = 750;

export const MESSAGES = [
	"michael, let's burn more tokens",
	"burn, burn, burn",
	"umm, yummy tokens",
	"tokens fuel the thinking",
	"another turn, another token",
	"agent at work",
	"the context must grow",
	"keep the models humming",
	"fresh tokens, hot context",
	"prompt. think. repeat.",
	"more tokens for the machine",
	"an agent never rests",
	"work, work, workflow",
	"feed the language model",
	"context window says yum",
	"let the agent cook",
	"one more inference",
	"reasoning complete",
	"tokens go brrr",
	"summon the subagents",
	"the model demands context",
	"delegate and conquer",
	"ship it, little agent",
	"autocomplete destiny",
	"prompt harder",
	"deep work, deeper context",
	"inference tastes delicious",
	"agent mode complete",
	"crunch those tokens",
	"the worktree is calling",
	"commit, push, repeat",
	"just one more prompt",
	"llm, take the wheel",
	"thinking costs tokens",
	"busy agents, happy humans",
	"context is everything",
	"a token for your thoughts",
	"the agent had a plan",
	"tools out, tokens in",
	"productivity generated",
	"synthetic thoughts delivered",
	"the work is done",
	"no task too token-heavy",
	"model says: shipped",
	"tiny prompts, big dreams",
	"another job well prompted",
	"agents assemble",
	"burn tokens, ship software",
	"work smarter, prompt harder",
	"may the context be with you",
] as const;

export interface DisplayMessageOptions {
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

export function randomMessage(random = Math.random): string {
	return MESSAGES[Math.floor(random() * MESSAGES.length)] ?? MESSAGES[0];
}

export function normalizeAwtrixUrl(value: string | undefined): string | undefined {
	if (value === "") return undefined;
	const url = value ?? DEFAULT_AWTRIX_URL;
	const withProtocol = /^https?:\/\//i.test(url) ? url : `http://${url}`;
	return withProtocol.replace(/\/+$/, "");
}

export function isQuietHours(date = new Date(), start = 20, end = 8): boolean {
	const hour = date.getHours();
	return hour >= start || hour < end;
}

export async function tryDisplayMessage(
	message: string,
	options: DisplayMessageOptions = {},
): Promise<boolean> {
	const baseUrl = normalizeAwtrixUrl(options.baseUrl ?? process.env.AWTRIX_URL);
	if (!baseUrl) return false;

	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		options.timeoutMs ?? DEFAULT_AWTRIX_TIMEOUT_MS,
	);

	try {
		const response = await (options.fetchImpl ?? fetch)(`${baseUrl}/api/notify`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				text: message.toLowerCase(),
				textCase: 2,
				center: false,
				repeat: 1,
				duration: 5,
				stack: false,
				scrollSpeed: 100,
			}),
			signal: controller.signal,
		});
		return response.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}
