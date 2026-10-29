import { randomUUID } from "node:crypto";
import { readdirSync, unlinkSync } from "node:fs";
import { requireOptIn } from "./config.ts";
import { atomicProjectWrite, contentHash, DATA_DIR, isMissing, MAX_FILE_BYTES, projectPath, readProjectFile } from "./files.ts";
import { withStorageLock } from "./lock.ts";
import { PREFERENCES_BYTES, suggestionTargetPath, type SuggestionKind } from "./preferences.ts";

export interface Evidence {
	session: string;
	entry: string;
	quote: string;
}
export interface Suggestion {
	kind?: SuggestionKind;
	id: string;
	created: string;
	title: string;
	target: string;
	rationale: string;
	evidence: Evidence[];
	baseHash: string | null;
	resultHash: string;
	before: string;
	after: string;
	status: "pending" | "applied" | "rejected";
	reason?: string;
	/** Set when a reviewed batch integration applied this proposal. */
	integration?: { batch: string; draft: string };
}
export type Proposal = Pick<Suggestion, "title" | "target" | "rationale" | "evidence" | "baseHash" | "before" | "after" | "kind">;
export type ArtifactFolder = "suggestions" | "applied" | "rejected";
const MARKER = "\n<!-- idle-learn:artifact -->\n";
const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function text(value: unknown, field: string, limit: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0")) {
		throw new Error(`Invalid suggestion ${field}.`);
	}
	return value;
}

export function validateProposal(value: unknown, kind: SuggestionKind = "instruction"): Proposal {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a suggestion object.");
	const input = value as Record<string, unknown>;
	if (input.kind !== undefined && input.kind !== kind) throw new Error("Suggestion kind does not match the review type.");
	const evidence = input.evidence;
	if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 12) throw new Error("Supply 1 to 12 evidence quotes.");
	if (input.baseHash !== null && (typeof input.baseHash !== "string" || !hashPattern.test(input.baseHash))) {
		throw new Error("Invalid suggestion base hash.");
	}
	if (typeof input.before !== "string" || input.before.length > 32_768 || input.before.includes("\0")) throw new Error("Invalid suggestion before text.");
	if (typeof input.after !== "string" || input.after.length > 32_768 || input.after.includes("\0")) throw new Error("Invalid suggestion after text.");
	if (input.before === input.after) throw new Error("The suggestion must change the target.");
	if (input.baseHash === null && input.before !== "") throw new Error("New files must have empty before text.");
	if (input.baseHash !== null && input.before === "") throw new Error("Existing files require a unique before text.");
	return {
		...(kind === "calibration" ? { kind } : input.kind === "instruction" ? { kind } : {}),
		title: text(input.title, "title", 200),
		target: text(input.target, "target", 4096),
		rationale: text(input.rationale, "rationale", 4000),
		evidence: evidence.map((item) => {
			if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid suggestion evidence.");
			return { session: text(item.session, "session", 200), entry: text(item.entry, "entry", 200), quote: text(item.quote, "quote", 4000) };
		}),
		baseHash: input.baseHash,
		before: input.before,
		after: input.after,
	};
}

export function applyEdit(content: string | null, proposal: Proposal): string {
	if ((content === null ? null : contentHash(content)) !== proposal.baseHash) {
		throw new Error("Suggestion is stale. Analyze the current target again.");
	}
	if (content === null) return proposal.after;
	const first = content.indexOf(proposal.before);
	if (first < 0 || content.indexOf(proposal.before, first + 1) >= 0) {
		throw new Error("The before text must occur exactly once in the target.");
	}
	return content.slice(0, first) + proposal.after + content.slice(first + proposal.before.length);
}

function artifactPath(folder: ArtifactFolder, id: string): string {
	if (!idPattern.test(id)) throw new Error("Invalid suggestion ID.");
	return `${DATA_DIR}/${folder}/${id}.md`;
}

export function suggestionDiff(suggestion: Proposal): string {
	return [`--- ${suggestion.target}`, `+++ ${suggestion.target}`, "@@ proposed edit @@",
		...suggestion.before.split("\n").map((line) => `-${line}`),
		...suggestion.after.split("\n").map((line) => `+${line}`),
	].join("\n");
}

export function serializeSuggestion(suggestion: Suggestion): string {
	return `# ${suggestion.title}\n\n${suggestion.kind === "calibration" ? "Type: Calibration\n\n" : ""}Target: ${suggestion.target}\n\n${suggestion.rationale}\n\n## Evidence\n\n${suggestion.evidence.map((item) => `- ${item.session}:${item.entry}\n\n${item.quote}`).join("\n\n")}\n\n## Proposed Edit\n\n\`\`\`diff\n${suggestionDiff(suggestion)}\n\`\`\`\n${MARKER}\`\`\`json\n${JSON.stringify(suggestion, null, 2)}\n\`\`\`\n`;
}

export function parseSuggestion(content: string): Suggestion {
	const index = content.lastIndexOf(MARKER);
	const match = index >= 0 ? /^```json\n([\s\S]+)\n```\n$/.exec(content.slice(index + MARKER.length)) : null;
	if (!match) throw new Error("Invalid suggestion artifact. Expected machine-readable metadata.");
	const input = JSON.parse(match[1]);
	const proposal = validateProposal(input, input.kind === "calibration" ? "calibration" : "instruction");
	if (typeof input.id !== "string" || !idPattern.test(input.id)) throw new Error("Invalid suggestion ID.");
	if (typeof input.created !== "string" || !Number.isFinite(Date.parse(input.created))) throw new Error("Invalid suggestion creation time.");
	if (typeof input.resultHash !== "string" || !hashPattern.test(input.resultHash)) throw new Error("Invalid suggestion result hash.");
	if (!["pending", "applied", "rejected"].includes(input.status)) throw new Error("Invalid suggestion status.");
	return {
		...proposal, id: input.id, created: input.created, resultHash: input.resultHash, status: input.status,
		...(input.reason === undefined ? {} : { reason: text(input.reason, "rejection reason", 4000) }),
		...(input.integration === undefined ? {} : { integration: integrationLink(input.integration, input.status) }),
	};
}

function integrationLink(value: unknown, status: unknown): { batch: string; draft: string } {
	const link = value as Record<string, unknown> | null;
	if (status !== "applied" || !link || typeof link !== "object" || typeof link.batch !== "string" || !idPattern.test(link.batch)
		|| typeof link.draft !== "string" || !hashPattern.test(link.draft)) throw new Error("Invalid suggestion integration link.");
	return { batch: link.batch, draft: link.draft };
}

/** Stable identity of a displayed pending artifact, used to detect concurrent edits. */
export function suggestionSnapshot(suggestion: Suggestion): string {
	return contentHash(serializeSuggestion(suggestion));
}

/** Archive a pending artifact after its decision is final. Repeating an interrupted archive is safe. */
export function archiveSuggestion(root: string, current: Suggestion, result: Suggestion, original: string): void {
	const source = artifactPath("suggestions", current.id);
	const destination = artifactPath(result.status === "applied" ? "applied" : "rejected", current.id);
	const archived = serializeSuggestion(result);
	const existingArchive = readProjectFile(root, destination);
	if (existingArchive !== null && existingArchive !== archived) throw new Error("Conflicting suggestion archive. Inspect the saved artifacts.");
	if (existingArchive === null) atomicProjectWrite(root, destination, archived, null);
	if (readProjectFile(root, source) !== original) throw new Error("Pending artifact changed during the decision. Inspect the saved artifacts.");
	unlinkSync(projectPath(root, source));
}

/** Read one pending artifact with its raw text. Returns undefined when it is no longer pending. */
export function readPending(root: string, id: string): { suggestion: Suggestion; original: string } | undefined {
	const original = readProjectFile(root, artifactPath("suggestions", id));
	if (original === null) return undefined;
	const suggestion = parseSuggestion(original);
	if (suggestion.id !== id || suggestion.status !== "pending") throw new Error("Suggestion ID or status does not match its folder.");
	return { suggestion, original };
}

export function readArchived(root: string, folder: "applied" | "rejected", id: string): Suggestion | undefined {
	const content = readProjectFile(root, artifactPath(folder, id));
	return content === null ? undefined : parseSuggestion(content);
}

export function listSuggestions(root: string, folder: ArtifactFolder = "suggestions"): Suggestion[] {
	requireOptIn(root, true);
	const directory = projectPath(root, `${DATA_DIR}/${folder}`);
	let names: string[];
	try { names = readdirSync(directory); } catch (error) { if (isMissing(error)) return []; throw error; }
	return names.filter((name) => name.endsWith(".md")).sort().map((name) => {
		const id = name.slice(0, -3);
		const content = readProjectFile(root, artifactPath(folder, id));
		if (content === null) throw new Error("Suggestion disappeared. Reload the review screen.");
		const suggestion = parseSuggestion(content);
		if (suggestion.id !== id) throw new Error("Suggestion ID does not match its filename.");
		suggestionTargetPath(root, suggestion);
		const expectedStatus = folder === "suggestions" ? "pending" : folder === "applied" ? "applied" : "rejected";
		if (suggestion.status !== expectedStatus) throw new Error("Suggestion status does not match its folder.");
		return suggestion;
	});
}

function duplicateKey(proposal: Proposal): string {
	return contentHash(`${proposal.target}\n${proposal.after.replace(/\s+/g, " ").trim().toLowerCase()}`);
}

export async function saveProposals(root: string, values: unknown[], guard: () => void = () => {}, commitState: () => void = () => {}, kind: SuggestionKind = "instruction", skipDuplicates = false): Promise<Suggestion[]> {
	if (!Array.isArray(values) || values.length > 3) throw new Error("A review may contain at most three suggestions.");
	requireOptIn(root);
	return withStorageLock(root, () => {
		requireOptIn(root);
		guard();
		const known = ["suggestions", "rejected", "applied"].flatMap((folder) => listSuggestions(root, folder as ArtifactFolder));
		const keys = new Set(known.map(duplicateKey));
		const suggestions = values.flatMap((value) => {
			const proposal = validateProposal(value, kind);
			suggestionTargetPath(root, proposal);
			const key = duplicateKey(proposal);
			if (keys.has(key)) {
				if (skipDuplicates) return [];
				throw new Error("Duplicate of a saved, applied, or rejected suggestion.");
			}
			const current = readProjectFile(root, proposal.target);
			const result = applyEdit(current, proposal);
			if (Buffer.byteLength(result) > (kind === "calibration" ? PREFERENCES_BYTES : MAX_FILE_BYTES)) throw new Error("Proposed target exceeds the size limit.");
			keys.add(key);
			const suggestion: Suggestion = { ...proposal, id: randomUUID(), created: new Date().toISOString(), resultHash: contentHash(result), status: "pending" };
			const content = serializeSuggestion(suggestion);
			if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("Suggestion artifact exceeds the size limit.");
			return [suggestion];
		});
		for (const suggestion of suggestions) atomicProjectWrite(root, artifactPath("suggestions", suggestion.id), serializeSuggestion(suggestion), null);
		commitState();
		return suggestions;
	});
}

export async function replacePendingEdit(root: string, displayed: Suggestion, edit: { baseHash: string | null; before: unknown; after: unknown }, guard: () => void = () => {}): Promise<Suggestion> {
	return withStorageLock(root, () => {
		guard();
		const source = artifactPath("suggestions", displayed.id);
		const original = readProjectFile(root, source);
		if (original === null || JSON.stringify(parseSuggestion(original)) !== JSON.stringify(displayed) || displayed.status !== "pending") {
			throw new Error("Suggestion changed. Review it again before refreshing.");
		}
		const proposal = validateProposal({ ...displayed, ...edit }, displayed.kind ?? "instruction");
		suggestionTargetPath(root, proposal);
		const result = applyEdit(readProjectFile(root, proposal.target), proposal);
		if (Buffer.byteLength(result) > (proposal.kind === "calibration" ? PREFERENCES_BYTES : MAX_FILE_BYTES)) throw new Error("Proposed target exceeds the size limit.");
		const refreshed: Suggestion = { ...displayed, ...proposal, resultHash: contentHash(result) };
		atomicProjectWrite(root, source, serializeSuggestion(refreshed), original);
		return refreshed;
	});
}

export async function decideSuggestion(root: string, displayed: Suggestion, decision: "apply" | "reject", reason?: string): Promise<Suggestion> {
	return withStorageLock(root, () => {
		const source = artifactPath("suggestions", displayed.id);
		const original = readProjectFile(root, source);
		if (original === null) throw new Error("Suggestion is no longer pending. Reload the review screen.");
		const current = parseSuggestion(original);
		if (JSON.stringify(current) !== JSON.stringify(displayed) || current.status !== "pending") {
			throw new Error("Suggestion changed. Review it again before deciding.");
		}
		suggestionTargetPath(root, current);
		const rejectionReason = reason === undefined || !reason.trim() ? undefined : text(reason.trim(), "rejection reason", 4000);
		const result: Suggestion = { ...current, status: decision === "apply" ? "applied" : "rejected", ...(decision === "reject" && rejectionReason ? { reason: rejectionReason } : {}) };
		const destination = artifactPath(decision === "apply" ? "applied" : "rejected", current.id);
		const existingArchive = readProjectFile(root, destination);
		if (existingArchive !== null && existingArchive !== serializeSuggestion(result)) throw new Error("Conflicting suggestion archive. Inspect the saved artifacts.");
		if (decision === "apply") {
			const content = readProjectFile(root, current.target);
			// Recover an interrupted archive step without applying the edit twice.
			if (content === null || contentHash(content) !== current.resultHash) {
				const updated = applyEdit(content, current);
				if (contentHash(updated) !== current.resultHash) throw new Error("Suggestion result hash does not match the proposed edit.");
				if (Buffer.byteLength(updated) > (current.kind === "calibration" ? PREFERENCES_BYTES : MAX_FILE_BYTES)) throw new Error("Proposed target exceeds the size limit.");
				atomicProjectWrite(root, current.target, updated, content);
			}
		}
		archiveSuggestion(root, current, result, original);
		return result;
	});
}
