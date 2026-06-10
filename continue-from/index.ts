import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

const CUSTOM_TYPE = "continue-from";
const HIDDEN_CONTINUE_PROMPT = [
	"Continue from your previous assistant response.",
	"Do not mention this hidden control message.",
	"Resume naturally from exactly where the conversation left off.",
].join(" ");

type MessageEntry = Extract<SessionEntry, { type: "message" }>;

type ContinueChoice = "nudge-only" | "agent" | "user";

interface Candidate {
	choice: ContinueChoice;
	entry?: MessageEntry;
	targetId?: string;
	label: string;
	description: string;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}

	if (!Array.isArray(content)) {
		return "";
	}

	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as { type?: unknown; text?: unknown; thinking?: unknown; name?: unknown };
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "thinking" && typeof block.thinking === "string") return block.thinking;
			if (block.type === "toolCall" && typeof block.name === "string") return `[tool call: ${block.name}]`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function oneLineSnippet(text: string, maxLength = 96): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (!oneLine) return "(no text)";
	return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 1)}…` : oneLine;
}

function hasToolCall(entry: MessageEntry): boolean {
	const content = entry.message.content;
	return Array.isArray(content) && content.some((part) => !!part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall");
}

function findLastUserMessage(branch: SessionEntry[]): MessageEntry | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "user") {
			return entry as MessageEntry;
		}
	}
	return undefined;
}

function findLastAssistantMessage(branch: SessionEntry[]): { entry: MessageEntry; targetId: string; unsafeToolCall: boolean } | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") {
			continue;
		}

		const assistant = entry as MessageEntry;
		const assistantHasToolCall = hasToolCall(assistant);
		if (!assistantHasToolCall) {
			return { entry: assistant, targetId: assistant.id, unsafeToolCall: false };
		}

		// If the assistant message requested tools, continue from the latest following
		// tool result on the active branch. Continuing directly after an assistant
		// tool-call message without corresponding tool results can produce invalid
		// provider message sequences.
		let latestFollowingToolResult: SessionEntry | undefined;
		for (let forward = index + 1; forward < branch.length; forward++) {
			const next = branch[forward];
			if (next.type === "message" && next.message.role === "user") {
				break;
			}
			if (next.type === "message" && next.message.role === "toolResult") {
				latestFollowingToolResult = next;
			}
		}

		return {
			entry: assistant,
			targetId: latestFollowingToolResult?.id ?? assistant.id,
			unsafeToolCall: latestFollowingToolResult === undefined,
		};
	}
	return undefined;
}

function buildCandidates(ctx: ExtensionContext): Candidate[] {
	const branch = ctx.sessionManager.getBranch();
	const candidates: Candidate[] = [
		{
			choice: "nudge-only",
			label: "Nudge only",
			description: "Send a hidden continue message without rewinding history",
		},
	];

	const lastAssistant = findLastAssistantMessage(branch);
	if (lastAssistant) {
		const suffix = lastAssistant.targetId === lastAssistant.entry.id ? "" : " (after its tool results)";
		candidates.push({
			choice: "agent",
			entry: lastAssistant.entry,
			targetId: lastAssistant.targetId,
			label: `Agent${suffix}`,
			description: lastAssistant.unsafeToolCall
				? `${oneLineSnippet(textFromContent(lastAssistant.entry.message.content))} — cannot safely auto-continue until tool results exist`
				: oneLineSnippet(textFromContent(lastAssistant.entry.message.content)),
		});
	}

	const lastUser = findLastUserMessage(branch);
	if (lastUser) {
		candidates.push({
			choice: "user",
			entry: lastUser,
			targetId: lastUser.id,
			label: "User",
			description: oneLineSnippet(textFromContent(lastUser.message.content)),
		});
	}

	return candidates;
}

function parseChoice(args: string): ContinueChoice | undefined {
	const normalized = args.trim().toLowerCase();
	if (["n", "nudge", "nudge-only", "nudgeonly", "only"].includes(normalized)) return "nudge-only";
	if (["a", "agent", "assistant", "last-agent", "last-assistant"].includes(normalized)) return "agent";
	if (["u", "user", "last-user"].includes(normalized)) return "user";
	return undefined;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
	}
}

function getPiPackageRoot(): string {
	const argvPath = process.argv[1];
	if (!argvPath) {
		throw new Error("Unable to locate the running pi package path.");
	}

	const realPath = realpathSync(argvPath);
	return dirname(dirname(realPath));
}

async function loadEditorRuntime(): Promise<{
	CustomEditor: new (tui: unknown, theme: unknown, keybindings: unknown, options?: unknown) => { handleInput(data: string): void; onSubmit?: (text: string) => void };
	matchesKey: (data: string, key: string) => boolean;
}> {
	const packageRoot = getPiPackageRoot();
	const customEditorPath = pathToFileURL(join(packageRoot, "dist/modes/interactive/components/custom-editor.js")).href;
	const tuiPath = pathToFileURL(join(packageRoot, "node_modules/@earendil-works/pi-tui/dist/index.js")).href;
	const [{ CustomEditor }, { matchesKey }] = await Promise.all([import(customEditorPath), import(tuiPath)]);
	return { CustomEditor, matchesKey };
}

async function chooseCandidate(args: string, ctx: ExtensionCommandContext, candidates: Candidate[]): Promise<Candidate | undefined> {
	const argChoice = parseChoice(args);
	if (argChoice) {
		return candidates.find((candidate) => candidate.choice === argChoice);
	}

	if (!ctx.hasUI) {
		return candidates[0];
	}

	const labels = candidates.map((candidate) => `${candidate.label}: ${candidate.description}`);
	const selected = await ctx.ui.select("Continue from:", labels);
	if (!selected) return undefined;

	const selectedIndex = labels.indexOf(selected);
	return selectedIndex >= 0 ? candidates[selectedIndex] : undefined;
}

function sendHiddenNudge(pi: ExtensionAPI, details: Record<string, unknown> = {}): void {
	pi.sendMessage(
		{
			customType: CUSTOM_TYPE,
			content: HIDDEN_CONTINUE_PROMPT,
			display: false,
			details: { ...details, timestamp: Date.now() },
		},
		{ triggerTurn: true },
	);
}

async function continueFrom(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	if (!ctx.isIdle()) {
		notify(ctx, "Press Escape to stop the current turn, then run /continue-from again.", "warning");
		return;
	}

	const candidates = buildCandidates(ctx);
	const candidate = await chooseCandidate(args, ctx, candidates);
	if (!candidate) {
		return;
	}

	if (candidate.choice === "nudge-only") {
		sendHiddenNudge(pi, { mode: "nudge-only", leafId: ctx.sessionManager.getLeafId() });
		notify(ctx, "Sent hidden continue nudge without rewinding.", "info");
		return;
	}

	if (!candidate.entry || !candidate.targetId) {
		notify(ctx, `No ${candidate.choice} message found in the active branch.`, "warning");
		return;
	}

	if (candidate.choice === "agent" && hasToolCall(candidate.entry) && candidate.targetId === candidate.entry.id) {
		notify(ctx, "The last agent message only contains a pending tool call, so it cannot be safely continued from. Choose the last user message instead.", "warning");
		return;
	}

	const result = await ctx.navigateTree(candidate.targetId, { summarize: false });
	if (result.cancelled) {
		notify(ctx, "Continue-from navigation was cancelled.", "warning");
		return;
	}

	if (candidate.choice === "agent") {
		sendHiddenNudge(pi, { mode: "agent", targetId: candidate.targetId, sourceEntryId: candidate.entry.id });
		notify(ctx, "Continuing from the last agent message.", "info");
		return;
	}

	notify(ctx, "Rewound to the last user message. Press Enter to send it again.", "info");
}

export default async function (pi: ExtensionAPI) {
	const { CustomEditor, matchesKey } = await loadEditorRuntime();

	class ContinueFromEditor extends CustomEditor {
		constructor(
			tui: unknown,
			theme: unknown,
			keybindings: unknown,
			private readonly isIdle: () => boolean,
			private readonly warnNotIdle: () => void,
		) {
			super(tui, theme, keybindings);
		}

		override handleInput(data: string): void {
			if (matchesKey(data, "alt+c")) {
				if (!this.isIdle()) {
					this.warnNotIdle();
					return;
				}

				void this.onSubmit?.("/continue-from");
				return;
			}

			super.handleInput(data);
		}
	}

	pi.registerCommand("continue-from", {
		description: "Pick how to continue: nudge-only, agent, or user. Usage: /continue-from [nudge-only|agent|user]",
		handler: async (args, ctx) => {
			await continueFrom(args, ctx, pi);
		},
	});

	pi.registerCommand("nudge", {
		description: "Alias for /continue-from nudge-only. Send a hidden continue message without rewinding.",
		handler: async (_args, ctx) => {
			await continueFrom("nudge-only", ctx, pi);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new ContinueFromEditor(
				tui,
				theme,
				keybindings,
				() => ctx.isIdle(),
				() => notify(ctx, "Press Escape to stop the current turn, then press Alt+C again.", "warning"),
			),
		);
	});
}
