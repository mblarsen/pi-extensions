import { createAgentSession, defineTool, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { validateConfig } from "./config.ts";
import { evidencePaths } from "./evidence.ts";
import { contentHash, readProjectFile, targetPath } from "./files.ts";
import { reviewerSessionOptions } from "./isolation.ts";

export interface WorkerRequest {
	root: string;
	provider: string;
	model: string;
	thinking: string;
	systemPrompt: string;
	evidence: string;
	purpose?: "calibration";
}

export async function runWorker(input: WorkerRequest): Promise<unknown> {
	validateConfig({ enabled: true, provider: input.provider, model: input.model, thinking: input.thinking });
	if (typeof input.systemPrompt !== "string" || !input.systemPrompt.trim() || Buffer.byteLength(input.systemPrompt) > 64 * 1024) throw new Error("Invalid reviewer system prompt.");
	if (typeof input.evidence !== "string" || Buffer.byteLength(input.evidence) > 384 * 1024) throw new Error("Reviewer evidence exceeds the input limit.");
	if (input.purpose !== undefined && input.purpose !== "calibration") throw new Error("Invalid worker purpose.");
	const paths = input.purpose === "calibration" ? [] : evidencePaths(input.root);
	const allowed = new Set(paths);
	let calls = 0;
	let remaining = 128 * 1024;
	function response(value: unknown) {
		if (++calls > 32) throw new Error("Reviewer evidence tool call limit reached.");
		const encoded = JSON.stringify(value);
		remaining -= Buffer.byteLength(encoded);
		if (remaining < 0) throw new Error("Reviewer evidence budget exhausted.");
		return { content: [{ type: "text" as const, text: encoded }], details: {} };
	}
	const list = defineTool({
		name: "evidence_list", label: "List project evidence",
		description: "List up to 100 project paths per call. Hidden, generated, dependency, and sensitive key files are excluded. Listing is bounded to 2000 paths and 8 directory levels.",
		parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 2000 })) }),
		execute: async (_id, args) => response({ paths: paths.slice(args.offset ?? 0, (args.offset ?? 0) + 100), total: paths.length }),
	});
	const read = defineTool({
		name: "evidence_read", label: "Read project evidence",
		description: "Read a listed project file or a project AGENTS.md target. Returns content, existence, and baseHash. Up to 100 lines / 16000 characters per call, 256 KiB per file. Paths cannot escape the project or contain symlinks.",
		parameters: Type.Object({ path: Type.String({ maxLength: 4096 }), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 262144 })) }),
		execute: async (_id, args) => {
			if (!allowed.has(args.path)) targetPath(input.root, args.path);
			const content = readProjectFile(input.root, args.path);
			const offset = args.offset ?? 0;
			const lines = content?.split("\n") ?? [];
			const selected = lines.slice(offset, offset + 100).join("\n");
			return response({ path: args.path, exists: content !== null, baseHash: content === null ? null : contentHash(content), content: selected.slice(0, 16000), offset, nextOffset: offset + 100 < lines.length ? offset + 100 : null, truncatedLine: selected.length > 16000 });
		},
	});
	const runtime = await ModelRuntime.create({ allowModelNetwork: false, signal: AbortSignal.timeout(20_000) });
	const model = runtime.getModel(input.provider, input.model);
	if (!model) throw new Error(`Reviewer model unavailable: ${input.provider}/${input.model}. Choose another model in /idle-learn config. Extension-only providers may not exist in an isolated worker.`);
	if (!getSupportedThinkingLevels(model).includes(input.thinking as never)) throw new Error("Reviewer thinking level is unsupported for this model. Reset thinking in /idle-learn config.");
	const auth = await runtime.getAuth(model, { signal: AbortSignal.timeout(20_000) });
	if (!auth) throw new Error("Reviewer credentials unavailable. Use /login for the selected provider.");
	const options = reviewerSessionOptions(input.root, input.systemPrompt, model, runtime, input.purpose === "calibration" ? [] : [list, read]);
	options.thinkingLevel = input.thinking as NonNullable<typeof options.thinkingLevel>;
	const { session } = await createAgentSession(options);
	let turns = 0;
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "turn_start" && ++turns > 16) void session.abort();
	});
	try {
		await session.prompt(input.evidence, { expandPromptTemplates: false });
		const last = session.messages.findLast((message) => message.role === "assistant");
		if (!last || last.role !== "assistant") throw new Error("Reviewer returned no response.");
		if (last.stopReason === "error" || last.stopReason === "aborted" || last.stopReason === "length") throw new Error(last.errorMessage || `Reviewer stopped: ${last.stopReason}.`);
		const output = last.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
		if (Buffer.byteLength(output) > 128 * 1024) throw new Error("Reviewer output exceeds the limit.");
		return JSON.parse(output);
	} finally {
		unsubscribe();
		session.dispose();
	}
}
