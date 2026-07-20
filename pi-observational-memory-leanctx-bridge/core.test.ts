import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	collectArchivedMemories,
	collectLeanCtxFacts,
	parseLeanCtxImportSummary,
	serializeLeanCtxFacts,
	type SessionEntry,
} from "./core.ts";

const entries: SessionEntry[] = [
	{
		type: "custom",
		id: "ledger001",
		timestamp: "2026-07-20T10:00:00.000Z",
		customType: "om.observations.recorded",
		data: {
			coversUpToId: "source01",
			observations: [
				{
					id: "abcdef123456",
					content: "User chose GraphQL for the public API.",
					timestamp: "2026-07-20 12:00",
					relevance: "high",
					sourceEntryIds: ["source01"],
					tokenCount: 10,
				},
			],
		},
	},
	{
		type: "custom",
		id: "ledger002",
		timestamp: "2026-07-20T10:05:00.000Z",
		customType: "om.reflections.recorded",
		data: {
			coversUpToId: "source01",
			reflections: [
				{
					id: "123456abcdef",
					content: "The project uses GraphQL for its public API.",
					supportingObservationIds: ["abcdef123456"],
					tokenCount: 9,
				},
			],
		},
	},
];

describe("collectLeanCtxFacts", () => {
	test("maps observations and reflections to idempotent Lean Context facts", () => {
		const facts = collectLeanCtxFacts(entries, "session-123");

		assert.deepEqual(facts, [
			{
				category: "observational-memory-observation",
				key: "om:observation:abcdef123456",
				value: "2026-07-20 12:00 [high] User chose GraphQL for the public API.",
				confidence: 0.8,
				source: "pi-observational-memory:session-123:ledger001:source01",
				timestamp: "2026-07-20T10:00:00.000Z",
			},
			{
				category: "observational-memory-reflection",
				key: "om:reflection:123456abcdef",
				value: "The project uses GraphQL for its public API.",
				confidence: 0.9,
				source: "pi-observational-memory:session-123:ledger002:abcdef123456",
				timestamp: "2026-07-20T10:05:00.000Z",
			},
		]);
	});

	test("filters low/medium observations unless allObservations is requested", () => {
		const lowObservation: SessionEntry = {
			type: "custom",
			id: "ledger003",
			customType: "om.observations.recorded",
			data: {
				observations: [{
					id: "fedcba654321",
					content: "A tentative implementation detail.",
					timestamp: "2026-07-20 12:10",
					relevance: "low",
					sourceEntryIds: ["source02"],
				}],
			},
		};

		assert.deepEqual(
			collectLeanCtxFacts([...entries, lowObservation], "session-123").map((fact) => fact.key),
			["om:observation:abcdef123456", "om:reflection:123456abcdef"],
		);
		assert.deepEqual(
			collectLeanCtxFacts([...entries, lowObservation], "session-123", { allObservations: true }).map((fact) => fact.key),
			["om:observation:abcdef123456", "om:reflection:123456abcdef", "om:observation:fedcba654321"],
		);
	});

	test("labels dropped observations as historical with low confidence", () => {
		const dropped: SessionEntry = {
			type: "custom",
			id: "ledger003",
			customType: "om.observations.dropped",
			data: { observationIds: ["abcdef123456"], coversUpToId: "source01" },
		};

		const facts = collectLeanCtxFacts([...entries, dropped], "session-123");
		assert.equal(facts[0].confidence, 0.2);
		assert.equal(facts[0].value, "[historical:dropped] 2026-07-20 12:00 [high] User chose GraphQL for the public API.");
	});

	test("includes dropped low observations without enabling all active observations", () => {
		const lowObservation: SessionEntry = {
			type: "custom",
			id: "ledger003",
			customType: "om.observations.recorded",
			data: { observations: [{
				id: "fedcba654321",
				content: "A superseded implementation detail.",
				timestamp: "2026-07-20 12:10",
				relevance: "low",
				sourceEntryIds: ["source02"],
			}] },
		};
		const dropped: SessionEntry = {
			type: "custom",
			id: "ledger004",
			customType: "om.observations.dropped",
			data: { observationIds: ["fedcba654321"], coversUpToId: "source02" },
		};

		const facts = collectLeanCtxFacts([...entries, lowObservation, dropped], "session-123");
		assert.deepEqual(facts.map((fact) => fact.key), [
			"om:observation:abcdef123456",
			"om:reflection:123456abcdef",
			"om:observation:fedcba654321",
		]);
		assert.equal(facts[2].confidence, 0.2);
	});

	test("ignores malformed records and deduplicates memory ids", () => {
		const duplicate = structuredClone(entries[0]);
		const malformed: SessionEntry = {
			type: "custom",
			customType: "om.observations.recorded",
			data: { observations: [{ id: "not-an-id", content: "bad" }] },
		};

		const facts = collectLeanCtxFacts([entries[0], duplicate, malformed], "session-123");
		assert.equal(facts.length, 1);
	});
});

test("archives exact evidence and resolves reflection support", () => {
	const source: SessionEntry = {
		type: "message",
		id: "source01",
		timestamp: "2026-07-20T09:59:00.000Z",
		message: { role: "user", content: "Use GraphQL.", timestamp: 1_753_002_000_000 },
	};
	const dropped: SessionEntry = {
		type: "custom",
		id: "ledger003",
		customType: "om.observations.dropped",
		data: { observationIds: ["abcdef123456"], coversUpToId: "source01" },
	};
	const archived = collectArchivedMemories([source, ...entries, dropped], "session-123");

	assert.equal(archived.length, 2);
	assert.equal(archived[0].observationStatus, "dropped");
	assert.deepEqual(archived[0].sourceEntries, [source]);
	assert.deepEqual(archived[1].supportingObservationIds, ["abcdef123456"]);
	assert.deepEqual(archived[1].sourceEntryIds, ["source01"]);
	assert.deepEqual(archived[1].sourceEntries, [source]);
	assert.equal(archived[1].archiveKey, "session-123:ledger002:0:reflection");
});

test("serializes import-compatible JSONL", () => {
	const facts = collectLeanCtxFacts(entries, "session-123");
	const lines = serializeLeanCtxFacts(facts).trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(lines.length, 2);
	assert.equal(lines[0].key, "om:observation:abcdef123456");
});

test("parses Lean Context import counts", () => {
	assert.deepEqual(
		parseLeanCtxImportSummary("Import complete: 3 added, 2 skipped, 0 replaced (merge=skip-existing)"),
		{ added: 3, skipped: 2, replaced: 0 },
	);
	assert.equal(parseLeanCtxImportSummary("unexpected output"), undefined);
});
