import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectArchivedMemories,
	collectLeanCtxFacts,
	parseLeanCtxImportSummary,
	serializeLeanCtxFacts,
	type LeanCtxFact,
	type LeanCtxImportSummary,
	type SessionEntry,
} from "./core.ts";
import { renderArchivedRecall } from "./archived-recall.ts";
import { EvidenceStore } from "./evidence-store.ts";

const COMMAND_NAME = "om:leanctx-sync";
const IMPORT_TIMEOUT_MS = 30_000;

type SyncResult = {
	candidates: number;
	archived: number;
	summary?: LeanCtxImportSummary;
};

export type BridgeOptions = {
	databasePath?: string;
};

type SyncOptions = {
	rescan?: boolean;
	allObservations?: boolean;
};

type MergeMode = "replace" | "skip-existing";

const SYNC_COMPLETIONS = [
	{ value: "off", label: "off", description: "Disable new memory persistence for the current session" },
	{ value: "--all", label: "--all", description: "Include low- and medium-relevance observations" },
	{ value: "--rescan", label: "--rescan", description: "Archive again and replace matching Lean Context facts" },
] as const;

function syncArgumentCompletions(prefix: string): Array<{ value: string; label: string; description: string }> | null {
	const boundary = prefix.lastIndexOf(" ");
	const base = boundary >= 0 ? prefix.slice(0, boundary + 1) : "";
	const current = boundary >= 0 ? prefix.slice(boundary + 1) : prefix;
	const used = new Set(base.trim() ? base.trim().split(/\s+/) : []);
	if (used.has("off")) return null;

	const completions = SYNC_COMPLETIONS
		.filter((item) => !used.has(item.value))
		.filter((item) => item.value !== "off" || used.size === 0)
		.filter((item) => item.value.startsWith(current))
		.map((item) => ({ ...item, value: `${base}${item.value}` }));
	return completions.length > 0 ? completions : null;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function commandError(stdout: string, stderr: string, code: number | null): string {
	return stderr.trim() || stdout.trim() || `lean-ctx knowledge import failed with code ${code ?? "unknown"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isKnowledgeTool(toolName: string): boolean {
	return toolName === "ctx_knowledge" || toolName.endsWith("_ctx_knowledge");
}

function isKnowledgeLookup(toolName: string, input: unknown): boolean {
	if (!isKnowledgeTool(toolName) || !isRecord(input)) return false;
	return input.action === "recall" || input.action === "search" || input.action === "wakeup";
}

function textFromContent(content: readonly unknown[]): string {
	return content
		.filter((item): item is { type: "text"; text: string } => isRecord(item) && item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}

function combineImportSummaries(
	left: LeanCtxImportSummary | undefined,
	right: LeanCtxImportSummary | undefined,
): LeanCtxImportSummary | undefined {
	if (!left) return right;
	if (!right) return left;
	return {
		added: left.added + right.added,
		skipped: left.skipped + right.skipped,
		replaced: left.replaced + right.replaced,
	};
}

function fingerprint(value: unknown): string {
	return JSON.stringify(value);
}

async function importFacts(
	pi: ExtensionAPI,
	cwd: string,
	facts: readonly LeanCtxFact[],
	mergeMode: MergeMode,
): Promise<LeanCtxImportSummary | undefined> {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-om-leanctx-bridge-"));
	const importPath = join(temporaryDirectory, "knowledge.jsonl");

	try {
		await writeFile(importPath, serializeLeanCtxFacts(facts), { encoding: "utf8", mode: 0o600 });
		const result = await pi.exec(
			"lean-ctx",
			["knowledge", "import", importPath, "--merge", mergeMode],
			{ cwd, timeout: IMPORT_TIMEOUT_MS },
		);
		if (result.code !== 0) throw new Error(commandError(result.stdout, result.stderr, result.code));
		return parseLeanCtxImportSummary(`${result.stdout}\n${result.stderr}`);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

export default function observationalMemoryLeanCtxBridge(pi: ExtensionAPI, options: BridgeOptions = {}): void {
	const evidenceStore = new EvidenceStore(options.databasePath);
	const syncedFacts = new Map<string, string>();
	const archivedMemories = new Map<string, string>();
	const disabledSessionIds = new Set<string>();
	let syncTail: Promise<void> = Promise.resolve();
	let lastReportedError: string | undefined;

	const syncCurrentBranch = async (ctx: ExtensionContext, syncOptions: SyncOptions = {}): Promise<SyncResult> => {
		const sessionId = ctx.sessionManager.getSessionId();
		const entries = ctx.sessionManager.getBranch() as SessionEntry[];
		const allArchivedMemories = collectArchivedMemories(entries, sessionId);
		const archiveCandidates = syncOptions.rescan
			? allArchivedMemories
			: allArchivedMemories.filter((memory) => archivedMemories.get(memory.archiveKey) !== fingerprint(memory));
		const archived = evidenceStore.archive(ctx.cwd, archiveCandidates);
		for (const memory of archiveCandidates) archivedMemories.set(memory.archiveKey, fingerprint(memory));

		const allFacts = collectLeanCtxFacts(entries, sessionId, { allObservations: syncOptions.allObservations });
		const candidates = syncOptions.rescan
			? allFacts
			: allFacts.filter((fact) => syncedFacts.get(fact.key) !== fingerprint(fact));
		if (candidates.length === 0) return { candidates: 0, archived };

		let summary: LeanCtxImportSummary | undefined;
		if (syncOptions.rescan) {
			summary = await importFacts(pi, ctx.cwd, candidates, "replace");
		} else {
			const activeFacts = candidates.filter((fact) => !fact.value.startsWith("[historical:dropped]"));
			const droppedFacts = candidates.filter((fact) => fact.value.startsWith("[historical:dropped]"));
			if (activeFacts.length > 0) {
				summary = combineImportSummaries(summary, await importFacts(pi, ctx.cwd, activeFacts, "skip-existing"));
			}
			if (droppedFacts.length > 0) {
				summary = combineImportSummaries(summary, await importFacts(pi, ctx.cwd, droppedFacts, "replace"));
			}
		}
		for (const fact of candidates) syncedFacts.set(fact.key, fingerprint(fact));
		return { candidates: candidates.length, archived, summary };
	};

	const scheduleSync = (ctx: ExtensionContext, options: SyncOptions = {}): Promise<SyncResult> => {
		const task = syncTail.then(() => syncCurrentBranch(ctx, options));
		syncTail = task.then(() => undefined, () => undefined);
		return task;
	};

	const isDisabled = (ctx: ExtensionContext): boolean => disabledSessionIds.has(ctx.sessionManager.getSessionId());

	const automaticSync = async (ctx: ExtensionContext): Promise<void> => {
		if (isDisabled(ctx)) return;
		try {
			await scheduleSync(ctx);
			lastReportedError = undefined;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message !== lastReportedError) {
				notify(ctx, `Observational-memory Lean Context sync failed: ${message}`, "warning");
				lastReportedError = message;
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => automaticSync(ctx));
	pi.on("before_agent_start", async (_event, ctx) => automaticSync(ctx));
	pi.on("session_before_compact", async (_event, ctx) => automaticSync(ctx));
	pi.on("session_compact", async (_event, ctx) => automaticSync(ctx));
	pi.on("session_before_tree", async (_event, ctx) => automaticSync(ctx));
	pi.on("session_tree", async (_event, ctx) => automaticSync(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (disabledSessionIds.delete(sessionId)) return;
		await automaticSync(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (isDisabled(ctx)) return;
		if (event.toolName === "recall" || isKnowledgeLookup(event.toolName, event.input)) {
			await automaticSync(ctx);
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "recall" && isRecord(event.input) && typeof event.input.id === "string" && /^[a-f0-9]{12}$/.test(event.input.id)) {
			try {
				const archivedRecall = evidenceStore.recall(ctx.cwd, event.input.id);
				if (!archivedRecall) return;
				const rendered = renderArchivedRecall(archivedRecall);
				return {
					content: [{ type: "text" as const, text: rendered.text }],
					details: rendered.details,
					isError: false,
				};
			} catch (error) {
				notify(ctx, `Persistent observational-memory recall failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
				return;
			}
		}

		if (!isKnowledgeLookup(event.toolName, event.input)) return;
		const text = textFromContent(event.content);
		const memoryIds = Array.from(text.matchAll(/om:(?:observation|reflection):([a-f0-9]{12})/g), (match) => match[1]);
		let guidance: string | undefined;
		if (memoryIds.length > 0) {
			guidance = "Exact source evidence for these observational-memory facts is available through recall(<12-character id>). Inspect the ranked results first, select the single most relevant current-looking memory, and recall only that ID initially; recall another ID only if the first result is incomplete, conflicting, or insufficient. recall checks both the current branch and the persistent archive.";
		} else if (/no facts matching|no matching facts|0 matching facts/i.test(text)) {
			guidance = "Lean Context found no persistent match. A newly created memory may still exist only in the current observational-memory context; if its 12-character id is visible, use recall(id).";
		}
		if (!guidance) return;
		return { content: [...event.content, { type: "text" as const, text: guidance }] };
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Persist OM evidence and index reflections plus high/critical observations in Lean Context. Usage: /om:leanctx-sync [off|--all|--rescan]",
		getArgumentCompletions: syncArgumentCompletions,
		handler: async (rawArgs, ctx) => {
			await ctx.waitForIdle();
			const args = rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
			const sessionId = ctx.sessionManager.getSessionId();
			if (args.length === 1 && args[0] === "off") {
				disabledSessionIds.add(sessionId);
				notify(ctx, "New observational-memory persistence disabled for this session. Existing Lean Context discovery and archived recall remain available.");
				return;
			}
			if (args.some((argument) => argument !== "--all" && argument !== "--rescan")) {
				notify(ctx, `Usage: /${COMMAND_NAME} [off|--all|--rescan]`, "error");
				return;
			}
			if (isDisabled(ctx)) {
				notify(ctx, "Observational-memory Lean Context bridge is disabled for this session.", "warning");
				return;
			}

			try {
				const result = await scheduleSync(ctx, {
					allObservations: args.includes("--all"),
					rescan: args.includes("--rescan"),
				});
				if (result.candidates === 0) {
					notify(
						ctx,
						result.archived > 0
							? `Observational-memory sync: archived ${result.archived} evidence occurrence(s); no new Lean Context facts.`
							: "Observational-memory Lean Context sync: no new memories.",
					);
					return;
				}
				if (result.summary) {
					notify(
						ctx,
						`Observational-memory sync: ${result.summary.added} Lean Context fact(s) added, ${result.summary.skipped} already present, ${result.summary.replaced} replaced; ${result.archived} evidence occurrence(s) archived.`,
					);
					return;
				}
				notify(ctx, `Observational-memory Lean Context sync: submitted ${result.candidates} memories.`);
			} catch (error) {
				notify(
					ctx,
					`Observational-memory Lean Context sync failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
