export const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
export const OM_REFLECTIONS_RECORDED = "om.reflections.recorded";
export const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";

const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;
const RELEVANCE_VALUES = ["low", "medium", "high", "critical"] as const;

type Relevance = (typeof RELEVANCE_VALUES)[number];

export interface SessionEntry {
	type: string;
	id?: string;
	timestamp?: string;
	customType?: string;
	data?: unknown;
	message?: unknown;
	content?: unknown;
	summary?: unknown;
}

interface Observation {
	id: string;
	content: string;
	timestamp: string;
	relevance: Relevance;
	sourceEntryIds: string[];
}

interface Reflection {
	id: string;
	content: string;
	supportingObservationIds: string[];
}

export interface LeanCtxFact {
	category: "observational-memory-observation" | "observational-memory-reflection";
	key: string;
	value: string;
	confidence: number;
	source: string;
	timestamp?: string;
}

export interface LeanCtxImportSummary {
	added: number;
	skipped: number;
	replaced: number;
}

export interface CollectFactsOptions {
	allObservations?: boolean;
}

export interface ArchivedMemoryOccurrence {
	archiveKey: string;
	memoryId: string;
	kind: "observation" | "reflection";
	content: string;
	relevance?: Relevance;
	observationStatus?: "active" | "dropped";
	memoryTimestamp?: string;
	sessionId: string;
	ledgerEntryId: string;
	recordIndex: number;
	recordedAt?: string;
	supportingObservationIds: string[];
	sourceEntryIds: string[];
	missingSourceEntryIds: string[];
	nonSourceEntryIds: string[];
	missingSupportingObservationIds: string[];
	sourceEntries: SessionEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isRelevance(value: unknown): value is Relevance {
	return typeof value === "string" && (RELEVANCE_VALUES as readonly string[]).includes(value);
}

function parseObservation(value: unknown): Observation | undefined {
	if (!isRecord(value)) return undefined;
	if (
		!isNonEmptyString(value.id) ||
		!MEMORY_ID_PATTERN.test(value.id) ||
		!isNonEmptyString(value.content) ||
		!isNonEmptyString(value.timestamp) ||
		!isRelevance(value.relevance) ||
		!isStringArray(value.sourceEntryIds)
	) return undefined;
	return {
		id: value.id,
		content: value.content,
		timestamp: value.timestamp,
		relevance: value.relevance,
		sourceEntryIds: value.sourceEntryIds,
	};
}

function parseReflection(value: unknown): Reflection | undefined {
	if (!isRecord(value)) return undefined;
	if (
		!isNonEmptyString(value.id) ||
		!MEMORY_ID_PATTERN.test(value.id) ||
		!isNonEmptyString(value.content) ||
		!isStringArray(value.supportingObservationIds)
	) return undefined;
	return {
		id: value.id,
		content: value.content,
		supportingObservationIds: value.supportingObservationIds,
	};
}

function isoTimestamp(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function observationConfidence(relevance: Relevance): number {
	switch (relevance) {
		case "low": return 0.45;
		case "medium": return 0.6;
		case "high": return 0.8;
		case "critical": return 0.95;
	}
}

function provenance(sessionId: string, ledgerEntryId: string | undefined, supportingIds: string[]): string {
	const parts = ["pi-observational-memory", sessionId];
	if (ledgerEntryId) parts.push(ledgerEntryId);
	if (supportingIds.length > 0) parts.push(supportingIds.join(","));
	return parts.join(":");
}

function collectDroppedObservationIds(entries: readonly SessionEntry[]): Set<string> {
	const droppedObservationIds = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== OM_OBSERVATIONS_DROPPED || !isRecord(entry.data)) continue;
		const observationIds = entry.data.observationIds;
		if (!Array.isArray(observationIds)) continue;
		for (const id of observationIds) {
			if (typeof id === "string" && MEMORY_ID_PATTERN.test(id)) droppedObservationIds.add(id);
		}
	}
	return droppedObservationIds;
}

export function collectLeanCtxFacts(
	entries: readonly SessionEntry[],
	sessionId: string,
	options: CollectFactsOptions = {},
): LeanCtxFact[] {
	const facts = new Map<string, LeanCtxFact>();
	const droppedObservationIds = collectDroppedObservationIds(entries);

	for (const entry of entries) {
		if (entry.type !== "custom" || !isRecord(entry.data)) continue;
		const timestamp = isoTimestamp(entry.timestamp);

		if (entry.customType === OM_OBSERVATIONS_RECORDED) {
			const observations = entry.data.observations;
			if (!Array.isArray(observations)) continue;
			for (const value of observations) {
				const observation = parseObservation(value);
				if (!observation) continue;
				const dropped = droppedObservationIds.has(observation.id);
				if (!dropped && !options.allObservations && observation.relevance !== "high" && observation.relevance !== "critical") continue;
				const key = `om:observation:${observation.id}`;
				if (facts.has(key)) continue;
				facts.set(key, {
					category: "observational-memory-observation",
					key,
					value: `${dropped ? "[historical:dropped] " : ""}${observation.timestamp} [${observation.relevance}] ${observation.content}`,
					confidence: dropped ? 0.2 : observationConfidence(observation.relevance),
					source: provenance(sessionId, entry.id, observation.sourceEntryIds),
					...(timestamp ? { timestamp } : {}),
				});
			}
			continue;
		}

		if (entry.customType === OM_REFLECTIONS_RECORDED) {
			const reflections = entry.data.reflections;
			if (!Array.isArray(reflections)) continue;
			for (const value of reflections) {
				const reflection = parseReflection(value);
				if (!reflection) continue;
				const key = `om:reflection:${reflection.id}`;
				if (facts.has(key)) continue;
				facts.set(key, {
					category: "observational-memory-reflection",
					key,
					value: reflection.content,
					confidence: 0.9,
					source: provenance(sessionId, entry.id, reflection.supportingObservationIds),
					...(timestamp ? { timestamp } : {}),
				});
			}
		}
	}

	return Array.from(facts.values());
}

function uniqueStrings(values: readonly string[]): string[] {
	return Array.from(new Set(values));
}

function isSourceEntry(entry: SessionEntry): boolean {
	return entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";
}

function resolveSources(entriesById: ReadonlyMap<string, SessionEntry>, sourceEntryIds: readonly string[]): {
	sourceEntries: SessionEntry[];
	missingSourceEntryIds: string[];
	nonSourceEntryIds: string[];
} {
	const sourceEntries: SessionEntry[] = [];
	const missingSourceEntryIds: string[] = [];
	const nonSourceEntryIds: string[] = [];
	for (const sourceEntryId of uniqueStrings(sourceEntryIds)) {
		const sourceEntry = entriesById.get(sourceEntryId);
		if (!sourceEntry) {
			missingSourceEntryIds.push(sourceEntryId);
			continue;
		}
		if (!isSourceEntry(sourceEntry)) {
			nonSourceEntryIds.push(sourceEntryId);
			continue;
		}
		sourceEntries.push(sourceEntry);
	}
	return { sourceEntries, missingSourceEntryIds, nonSourceEntryIds };
}

export function collectArchivedMemories(
	entries: readonly SessionEntry[],
	sessionId: string,
): ArchivedMemoryOccurrence[] {
	const entriesById = new Map(
		entries.filter((entry): entry is SessionEntry & { id: string } => isNonEmptyString(entry.id)).map((entry) => [entry.id, entry]),
	);
	const indexedObservations: Array<{ observation: Observation; ledgerEntryId: string; recordIndex: number; recordedAt?: string }> = [];
	const indexedReflections: Array<{ reflection: Reflection; ledgerEntryId: string; recordIndex: number; recordedAt?: string }> = [];

	for (const entry of entries) {
		if (entry.type !== "custom" || !isNonEmptyString(entry.id) || !isRecord(entry.data)) continue;
		if (entry.customType === OM_OBSERVATIONS_RECORDED && Array.isArray(entry.data.observations)) {
			entry.data.observations.forEach((value, recordIndex) => {
				const observation = parseObservation(value);
				if (observation) indexedObservations.push({ observation, ledgerEntryId: entry.id as string, recordIndex, recordedAt: isoTimestamp(entry.timestamp) });
			});
		}
		if (entry.customType === OM_REFLECTIONS_RECORDED && Array.isArray(entry.data.reflections)) {
			entry.data.reflections.forEach((value, recordIndex) => {
				const reflection = parseReflection(value);
				if (reflection) indexedReflections.push({ reflection, ledgerEntryId: entry.id as string, recordIndex, recordedAt: isoTimestamp(entry.timestamp) });
			});
		}
	}

	const observationsById = new Map<string, (typeof indexedObservations)[number]>();
	for (const indexed of indexedObservations) {
		if (!observationsById.has(indexed.observation.id)) observationsById.set(indexed.observation.id, indexed);
	}
	const droppedObservationIds = collectDroppedObservationIds(entries);

	const archived: ArchivedMemoryOccurrence[] = [];
	for (const indexed of indexedObservations) {
		const { observation, ledgerEntryId, recordIndex, recordedAt } = indexed;
		const sourceEntryIds = uniqueStrings(observation.sourceEntryIds);
		const resolved = resolveSources(entriesById, sourceEntryIds);
		archived.push({
			archiveKey: `${sessionId}:${ledgerEntryId}:${recordIndex}:observation`,
			memoryId: observation.id,
			kind: "observation",
			content: observation.content,
			relevance: observation.relevance,
			observationStatus: droppedObservationIds.has(observation.id) ? "dropped" : "active",
			memoryTimestamp: observation.timestamp,
			sessionId,
			ledgerEntryId,
			recordIndex,
			...(recordedAt ? { recordedAt } : {}),
			supportingObservationIds: [],
			sourceEntryIds,
			missingSupportingObservationIds: [],
			...resolved,
		});
	}

	for (const indexed of indexedReflections) {
		const { reflection, ledgerEntryId, recordIndex, recordedAt } = indexed;
		const supportingObservationIds = uniqueStrings(reflection.supportingObservationIds);
		const sourceEntryIds: string[] = [];
		const missingSupportingObservationIds: string[] = [];
		for (const observationId of supportingObservationIds) {
			const supporting = observationsById.get(observationId);
			if (!supporting) {
				missingSupportingObservationIds.push(observationId);
				continue;
			}
			sourceEntryIds.push(...supporting.observation.sourceEntryIds);
		}
		const uniqueSourceEntryIds = uniqueStrings(sourceEntryIds);
		const resolved = resolveSources(entriesById, uniqueSourceEntryIds);
		archived.push({
			archiveKey: `${sessionId}:${ledgerEntryId}:${recordIndex}:reflection`,
			memoryId: reflection.id,
			kind: "reflection",
			content: reflection.content,
			sessionId,
			ledgerEntryId,
			recordIndex,
			...(recordedAt ? { recordedAt } : {}),
			supportingObservationIds,
			sourceEntryIds: uniqueSourceEntryIds,
			missingSupportingObservationIds,
			...resolved,
		});
	}

	return archived;
}

export function serializeLeanCtxFacts(facts: readonly LeanCtxFact[]): string {
	return facts.map((fact) => JSON.stringify(fact)).join("\n") + (facts.length > 0 ? "\n" : "");
}

export function parseLeanCtxImportSummary(output: string): LeanCtxImportSummary | undefined {
	const match = output.match(/Import complete:\s*(\d+) added,\s*(\d+) skipped,\s*(\d+) replaced/);
	if (!match) return undefined;
	return {
		added: Number(match[1]),
		skipped: Number(match[2]),
		replaced: Number(match[3]),
	};
}
