import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderArchivedRecall } from "./archived-recall.ts";
import type { ArchivedMemoryOccurrence, SessionEntry } from "./core.ts";
import { EvidenceStore } from "./evidence-store.ts";

function occurrence(sessionId: string, ledgerEntryId: string, source: SessionEntry): ArchivedMemoryOccurrence {
	return {
		archiveKey: `${sessionId}:${ledgerEntryId}:0:reflection`,
		memoryId: "123456abcdef",
		kind: "reflection",
		content: "The project uses GraphQL.",
		sessionId,
		ledgerEntryId,
		recordIndex: 0,
		recordedAt: "2026-07-20T10:05:00.000Z",
		supportingObservationIds: ["abcdef123456"],
		sourceEntryIds: [source.id!],
		missingSourceEntryIds: [],
		nonSourceEntryIds: [],
		missingSupportingObservationIds: [],
		sourceEntries: [source],
	};
}

test("stores project-scoped occurrences and exact session evidence", async () => {
	const directory = await mkdtemp(join(tmpdir(), "om-evidence-store-test-"));
	const project = join(directory, "project");
	const otherProject = join(directory, "other-project");
	const databasePath = join(directory, "agent", "observational-memory", "evidence.sqlite");
	await mkdir(project);
	await mkdir(otherProject);

	try {
		const store = new EvidenceStore(databasePath);
		const firstSource: SessionEntry = {
			type: "message",
			id: "source01",
			timestamp: "2026-07-20T10:00:00.000Z",
			message: { role: "user", content: "Use GraphQL.", timestamp: 1_753_002_000_000 },
		};
		const secondSource: SessionEntry = {
			type: "message",
			id: "source02",
			timestamp: "2026-07-21T10:00:00.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "GraphQL is configured." }], timestamp: 1_753_088_400_000 },
		};

		assert.equal(store.archive(project, [occurrence("session-1", "ledger01", firstSource)]), 1);
		assert.equal(store.archive(project, [occurrence("session-2", "ledger02", secondSource)]), 1);
		const recalled = store.recall(project, "123456abcdef");
		assert.ok(recalled);
		assert.equal(recalled.occurrences.length, 2);
		assert.deepEqual(new Set(recalled.occurrences.map((item) => item.sessionId)), new Set(["session-1", "session-2"]));
		assert.equal(recalled.occurrences[0].sourceEntries.length, 1);
		assert.equal(store.recall(otherProject, "123456abcdef"), undefined);
		assert.equal((await stat(databasePath)).mode & 0o777, 0o600);

		const rendered = renderArchivedRecall(recalled);
		assert.match(rendered.text, /Persistent observational-memory archive/);
		assert.match(rendered.text, /Use GraphQL/);
		assert.match(rendered.text, /GraphQL is configured/);
		assert.equal(rendered.details.status, "ok");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
