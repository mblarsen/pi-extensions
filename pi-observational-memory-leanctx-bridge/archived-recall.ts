import type { ArchivedRecall, ArchivedRecallOccurrence } from "./evidence-store.ts";
import type { SessionEntry } from "./core.ts";

const MAX_ARCHIVE_RESULT_CHARS = 40_000;
const MAX_ARCHIVE_RESULT_LINES = 1_500;

export interface ArchivedRecallRendered {
	text: string;
	details: Record<string, unknown>;
}

function formatTimestamp(...values: Array<string | number | undefined>): string {
	for (const value of values) {
		if (value === undefined) continue;
		const date = new Date(value);
		if (!Number.isNaN(date.getTime())) {
			const pad = (part: number) => String(part).padStart(2, "0");
			return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
		}
	}
	return "Unknown time";
}

function textAndPlaceholders(content: unknown, includeThinking = false): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "[non-text content omitted]";
	const parts: string[] = [];
	for (const value of content) {
		if (!value || typeof value !== "object") {
			parts.push("[non-text content omitted]");
			continue;
		}
		const block = value as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
			continue;
		}
		if (block.type === "thinking") {
			if (block.redacted === true) continue;
			if (includeThinking && typeof block.thinking === "string") parts.push(`[thinking: ${block.thinking}]`);
			continue;
		}
		if (block.type === "toolCall" && typeof block.name === "string") {
			parts.push(`[${block.name}(${JSON.stringify(block.arguments ?? {})})]`);
			continue;
		}
		parts.push("[non-text content omitted]");
	}
	return parts.join("\n");
}

function messageRecord(entry: SessionEntry): Record<string, unknown> | undefined {
	return entry.message && typeof entry.message === "object" ? entry.message as Record<string, unknown> : undefined;
}

export function renderArchivedSourceEntry(entry: SessionEntry): string | undefined {
	if (entry.type === "message") {
		const message = messageRecord(entry);
		if (!message) return undefined;
		const time = formatTimestamp(message.timestamp as string | number | undefined, entry.timestamp);
		if (message.role === "user") return `[User @ ${time}]: ${textAndPlaceholders(message.content)}`;
		if (message.role === "assistant") return `[Assistant @ ${time}]: ${textAndPlaceholders(message.content, true)}`;
		const toolName = typeof message.toolName === "string" ? message.toolName : "unknown";
		return `[Tool result: ${toolName} @ ${time}]: ${textAndPlaceholders(message.content)}`;
	}
	if (entry.type === "custom_message") {
		const time = formatTimestamp(entry.timestamp);
		const origin = entry.customType ? `Custom message (${entry.customType})` : "Custom message";
		return `[${origin} @ ${time}]: ${textAndPlaceholders(entry.content)}`;
	}
	if (entry.type === "branch_summary" && typeof entry.summary === "string") {
		return `[Branch summary @ ${formatTimestamp(entry.timestamp)}]: ${entry.summary}`;
	}
	return undefined;
}

function sourceOrigin(entry: SessionEntry): { origin: string; qualifiers: string[]; timestamp: string } {
	if (entry.type === "message") {
		const message = messageRecord(entry);
		const timestamp = formatTimestamp(message?.timestamp as string | number | undefined, entry.timestamp);
		if (message?.role === "user") return { origin: "User", qualifiers: [], timestamp };
		if (message?.role === "assistant") return { origin: "Assistant", qualifiers: [], timestamp };
		return { origin: `Tool result: ${typeof message?.toolName === "string" ? message.toolName : "unknown"}`, qualifiers: [], timestamp };
	}
	if (entry.type === "custom_message") {
		return {
			origin: "Custom message",
			qualifiers: entry.customType ? [`custom: ${entry.customType}`] : [],
			timestamp: formatTimestamp(entry.timestamp),
		};
	}
	if (entry.type === "branch_summary") return { origin: "Branch summary", qualifiers: [], timestamp: formatTimestamp(entry.timestamp) };
	return { origin: entry.type, qualifiers: [], timestamp: formatTimestamp(entry.timestamp) };
}

function sourceDetail(entry: SessionEntry, sessionId?: string): Record<string, unknown> {
	const rendered = renderArchivedSourceEntry(entry) ?? "";
	const { origin, qualifiers, timestamp } = sourceOrigin(entry);
	const content = rendered.replace(/^\[[^\]]+\]:\s?/, "");
	return {
		id: sessionId ? `${sessionId}:${entry.id ?? "unknown"}` : entry.id ?? "unknown",
		origin,
		timestamp,
		tokens: Math.ceil(rendered.length / 4),
		qualifiers: sessionId ? [`session: ${sessionId}`, ...qualifiers] : qualifiers,
		...(content ? { content } : {}),
	};
}

type ArchivedSource = { sessionId: string; entry: SessionEntry };

function uniqueSourceEntries(occurrences: readonly ArchivedRecallOccurrence[]): ArchivedSource[] {
	const seen = new Set<string>();
	const entries: ArchivedSource[] = [];
	for (const occurrence of occurrences) {
		for (const entry of occurrence.sourceEntries) {
			const key = `${occurrence.sessionId}:${entry.id ?? JSON.stringify(entry)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			entries.push({ sessionId: occurrence.sessionId, entry });
		}
	}
	return entries;
}

function observationMatch(occurrence: ArchivedRecallOccurrence): Record<string, unknown> {
	const unavailable = occurrence.missingSourceEntryIds.length > 0 || occurrence.nonSourceEntryIds.length > 0;
	const sources = occurrence.sourceEntries.map((entry) => sourceDetail(entry, occurrence.sessionId));
	return {
		status: unavailable ? "source_unavailable" : sources.length > 0 ? occurrence.observationStatus ?? "active" : "no_source",
		observationEntryId: occurrence.ledgerEntryId,
		observationRecordIndex: occurrence.recordIndex,
		observation: {
			id: occurrence.memoryId,
			content: occurrence.content,
			timestamp: occurrence.memoryTimestamp ?? formatTimestamp(occurrence.recordedAt),
			relevance: occurrence.relevance ?? "medium",
			status: occurrence.observationStatus ?? "active",
		},
		sourceEntryIds: occurrence.sourceEntryIds,
		sourceEntries: sources,
		missingSourceEntryIds: occurrence.missingSourceEntryIds,
		nonSourceEntryIds: occurrence.nonSourceEntryIds,
		sourceCharacterCount: occurrence.sourceEntries.reduce((sum, entry) => sum + (renderArchivedSourceEntry(entry)?.length ?? 0), 0),
	};
}

function truncate(text: string): string {
	const lines = text.split("\n");
	let result = lines.slice(0, MAX_ARCHIVE_RESULT_LINES).join("\n");
	let truncated = lines.length > MAX_ARCHIVE_RESULT_LINES;
	if (result.length > MAX_ARCHIVE_RESULT_CHARS) {
		result = result.slice(0, MAX_ARCHIVE_RESULT_CHARS);
		truncated = true;
	}
	return truncated ? `${result}\n\n[Archived evidence truncated by pi-observational-memory-leanctx-bridge.]` : result;
}

export function renderArchivedRecall(recall: ArchivedRecall): ArchivedRecallRendered {
	const sections: string[] = ["Persistent observational-memory archive:"];
	for (const occurrence of recall.occurrences) {
		const label = occurrence.kind === "reflection" ? "Reflection" : "Observation";
		const relevance = occurrence.relevance ? ` [${occurrence.relevance}]` : "";
		const status = occurrence.observationStatus === "dropped" ? " [dropped]" : "";
		sections.push(
			`${label} [${occurrence.memoryId}]${relevance}${status}: ${occurrence.content}\n` +
			`Occurrence: session ${occurrence.sessionId}, ledger ${occurrence.ledgerEntryId}, recorded ${formatTimestamp(occurrence.recordedAt)}`,
		);
	}
	const sourceEntries = uniqueSourceEntries(recall.occurrences);
	if (sourceEntries.length > 0) {
		sections.push(`Sources:\n${sourceEntries.map(({ sessionId, entry }) => {
			const rendered = renderArchivedSourceEntry(entry);
			return rendered ? `[Archived session ${sessionId}, entry ${entry.id ?? "unknown"}]\n${rendered}` : undefined;
		}).filter(Boolean).join("\n\n")}`);
	}
	const missingSources = Array.from(new Set(recall.occurrences.flatMap((occurrence) => occurrence.missingSourceEntryIds)));
	const missingSupport = Array.from(new Set(recall.occurrences.flatMap((occurrence) => occurrence.missingSupportingObservationIds)));
	if (missingSources.length > 0) sections.push(`Unavailable archived source entries: ${missingSources.join(", ")}`);
	if (missingSupport.length > 0) sections.push(`Unavailable supporting observations: ${missingSupport.join(", ")}`);

	const observationMatches = recall.occurrences.filter((occurrence) => occurrence.kind === "observation").map(observationMatch);
	const reflections = recall.occurrences.filter((occurrence) => occurrence.kind === "reflection").map((occurrence) => ({
		id: occurrence.memoryId,
		content: occurrence.content,
		supportingObservationIds: occurrence.supportingObservationIds,
		reflectionIndex: occurrence.recordIndex,
	}));
	const sourceDetails = sourceEntries.map(({ sessionId, entry }) => sourceDetail(entry, sessionId));
	const partial = missingSources.length > 0 || missingSupport.length > 0 || recall.occurrences.some((occurrence) => occurrence.nonSourceEntryIds.length > 0);
	const collision = new Set(recall.occurrences.map((occurrence) => `${occurrence.kind}:${occurrence.content}`)).size > 1;
	return {
		text: truncate(sections.join("\n\n")),
		details: {
			status: partial ? "partial" : sourceDetails.length > 0 ? "ok" : "no_source",
			memoryId: recall.memoryId,
			observationId: recall.memoryId,
			collision,
			partial,
			reflections,
			directObservationMatches: observationMatches,
			observations: observationMatches,
			matches: observationMatches,
			sourceEntries: sourceDetails,
			unavailableSupportingObservations: missingSupport.map((observationId) => ({ observationId })),
			missingSourceEntryIds: missingSources,
			nonSourceEntryIds: Array.from(new Set(recall.occurrences.flatMap((occurrence) => occurrence.nonSourceEntryIds))),
			sourceCharacterCount: sourceEntries.reduce((sum, { entry }) => sum + (renderArchivedSourceEntry(entry)?.length ?? 0), 0),
			message: `Recovered ${recall.occurrences.length} occurrence(s) from the persistent archive.`,
		},
	};
}
