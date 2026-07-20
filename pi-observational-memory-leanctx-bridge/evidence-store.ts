import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ArchivedMemoryOccurrence, SessionEntry } from "./core.ts";

export interface ArchivedRecallOccurrence extends Omit<ArchivedMemoryOccurrence, "archiveKey"> {
	projectRoot: string;
	occurrenceId: number;
}

export interface ArchivedRecall {
	memoryId: string;
	occurrences: ArchivedRecallOccurrence[];
}

type OccurrenceRow = {
	occurrence_id: number;
	project_root: string;
	memory_id: string;
	kind: "observation" | "reflection";
	content: string;
	relevance: string | null;
	observation_status: "active" | "dropped" | null;
	memory_timestamp: string | null;
	session_id: string;
	ledger_entry_id: string;
	record_index: number;
	recorded_at: string | null;
	supporting_observation_ids: string;
	source_entry_ids: string;
	missing_source_entry_ids: string;
	non_source_entry_ids: string;
	missing_supporting_observation_ids: string;
};

type EvidenceRow = {
	entry_json: string;
};

function canonicalProjectRoot(cwd: string): string {
	let canonical: string;
	try {
		canonical = realpathSync(cwd);
	} catch {
		canonical = resolve(cwd);
	}
	let current = canonical;
	const filesystemRoot = parse(current).root;
	while (true) {
		if (existsSync(join(current, ".git"))) return current;
		if (current === filesystemRoot) return canonical;
		current = dirname(current);
	}
}

function projectId(root: string): string {
	return createHash("sha256").update(root).digest("hex").slice(0, 24);
}

function parseStringArray(value: string): string[] {
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
	} catch {
		return [];
	}
}

function parseEntry(value: string): SessionEntry | undefined {
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && typeof parsed.type === "string" ? parsed as SessionEntry : undefined;
	} catch {
		return undefined;
	}
}

export function defaultEvidenceDatabasePath(): string {
	return join(getAgentDir(), "observational-memory", "evidence.sqlite");
}

export class EvidenceStore {
	readonly databasePath: string;

	constructor(databasePath = defaultEvidenceDatabasePath()) {
		this.databasePath = databasePath;
	}

	private open(): DatabaseSync {
		mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 });
		chmodSync(dirname(this.databasePath), 0o700);
		const database = new DatabaseSync(this.databasePath);
		chmodSync(this.databasePath, 0o600);
		database.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
		database.exec(`
			CREATE TABLE IF NOT EXISTS projects (
				project_id TEXT PRIMARY KEY,
				canonical_root TEXT NOT NULL,
				last_seen_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS occurrences (
				occurrence_id INTEGER PRIMARY KEY AUTOINCREMENT,
				project_id TEXT NOT NULL,
				memory_id TEXT NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('observation', 'reflection')),
				content TEXT NOT NULL,
				relevance TEXT,
				observation_status TEXT CHECK (observation_status IN ('active', 'dropped')),
				memory_timestamp TEXT,
				session_id TEXT NOT NULL,
				ledger_entry_id TEXT NOT NULL,
				record_index INTEGER NOT NULL,
				recorded_at TEXT,
				supporting_observation_ids TEXT NOT NULL,
				source_entry_ids TEXT NOT NULL,
				missing_source_entry_ids TEXT NOT NULL,
				non_source_entry_ids TEXT NOT NULL,
				missing_supporting_observation_ids TEXT NOT NULL,
				FOREIGN KEY (project_id) REFERENCES projects(project_id),
				UNIQUE (project_id, session_id, ledger_entry_id, record_index, kind)
			);
			CREATE INDEX IF NOT EXISTS occurrences_memory_idx
				ON occurrences(project_id, memory_id, recorded_at DESC);
			CREATE TABLE IF NOT EXISTS evidence_entries (
				project_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				source_entry_id TEXT NOT NULL,
				entry_type TEXT NOT NULL,
				entry_timestamp TEXT,
				entry_json TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				PRIMARY KEY (project_id, session_id, source_entry_id),
				FOREIGN KEY (project_id) REFERENCES projects(project_id)
			);
			CREATE TABLE IF NOT EXISTS occurrence_evidence (
				occurrence_id INTEGER NOT NULL,
				project_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				source_entry_id TEXT NOT NULL,
				ordinal INTEGER NOT NULL,
				PRIMARY KEY (occurrence_id, source_entry_id),
				FOREIGN KEY (occurrence_id) REFERENCES occurrences(occurrence_id) ON DELETE CASCADE,
				FOREIGN KEY (project_id, session_id, source_entry_id)
					REFERENCES evidence_entries(project_id, session_id, source_entry_id)
			);
		`);
		const occurrenceColumns = database.prepare("PRAGMA table_info(occurrences)").all() as Array<{ name: string }>;
		if (!occurrenceColumns.some((column) => column.name === "observation_status")) {
			database.exec("ALTER TABLE occurrences ADD COLUMN observation_status TEXT CHECK (observation_status IN ('active', 'dropped'))");
		}
		return database;
	}

	archive(cwd: string, memories: readonly ArchivedMemoryOccurrence[]): number {
		if (memories.length === 0) return 0;
		const root = canonicalProjectRoot(cwd);
		const id = projectId(root);
		const database = this.open();
		try {
			const upsertProject = database.prepare(`
				INSERT INTO projects(project_id, canonical_root, last_seen_at) VALUES (?, ?, ?)
				ON CONFLICT(project_id) DO UPDATE SET canonical_root=excluded.canonical_root, last_seen_at=excluded.last_seen_at
			`);
			const upsertOccurrence = database.prepare(`
				INSERT INTO occurrences(
					project_id, memory_id, kind, content, relevance, observation_status, memory_timestamp, session_id,
					ledger_entry_id, record_index, recorded_at, supporting_observation_ids,
					source_entry_ids, missing_source_entry_ids, non_source_entry_ids,
					missing_supporting_observation_ids
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(project_id, session_id, ledger_entry_id, record_index, kind) DO UPDATE SET
					memory_id=excluded.memory_id,
					content=excluded.content,
					relevance=excluded.relevance,
					observation_status=excluded.observation_status,
					memory_timestamp=excluded.memory_timestamp,
					recorded_at=excluded.recorded_at,
					supporting_observation_ids=excluded.supporting_observation_ids,
					source_entry_ids=excluded.source_entry_ids,
					missing_source_entry_ids=excluded.missing_source_entry_ids,
					non_source_entry_ids=excluded.non_source_entry_ids,
					missing_supporting_observation_ids=excluded.missing_supporting_observation_ids
			`);
			const findOccurrence = database.prepare(`
				SELECT occurrence_id FROM occurrences
				WHERE project_id=? AND session_id=? AND ledger_entry_id=? AND record_index=? AND kind=?
			`);
			const upsertEvidence = database.prepare(`
				INSERT INTO evidence_entries(
					project_id, session_id, source_entry_id, entry_type, entry_timestamp, entry_json, content_hash
				) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(project_id, session_id, source_entry_id) DO UPDATE SET
					entry_type=excluded.entry_type,
					entry_timestamp=excluded.entry_timestamp,
					entry_json=excluded.entry_json,
					content_hash=excluded.content_hash
			`);
			const clearLinks = database.prepare("DELETE FROM occurrence_evidence WHERE occurrence_id=?");
			const insertLink = database.prepare(`
				INSERT INTO occurrence_evidence(occurrence_id, project_id, session_id, source_entry_id, ordinal)
				VALUES (?, ?, ?, ?, ?)
			`);

			database.exec("BEGIN IMMEDIATE");
			try {
				upsertProject.run(id, root, new Date().toISOString());
				for (const memory of memories) {
					upsertOccurrence.run(
						id,
						memory.memoryId,
						memory.kind,
						memory.content,
						memory.relevance ?? null,
						memory.observationStatus ?? null,
						memory.memoryTimestamp ?? null,
						memory.sessionId,
						memory.ledgerEntryId,
						memory.recordIndex,
						memory.recordedAt ?? null,
						JSON.stringify(memory.supportingObservationIds),
						JSON.stringify(memory.sourceEntryIds),
						JSON.stringify(memory.missingSourceEntryIds),
						JSON.stringify(memory.nonSourceEntryIds),
						JSON.stringify(memory.missingSupportingObservationIds),
					);
					const occurrence = findOccurrence.get(
						id,
						memory.sessionId,
						memory.ledgerEntryId,
						memory.recordIndex,
						memory.kind,
					) as { occurrence_id: number } | undefined;
					if (!occurrence) throw new Error(`Failed to persist occurrence ${memory.archiveKey}`);
					clearLinks.run(occurrence.occurrence_id);
					memory.sourceEntries.forEach((entry, ordinal) => {
						if (!entry.id) return;
						const entryJson = JSON.stringify(entry);
						upsertEvidence.run(
							id,
							memory.sessionId,
							entry.id,
							entry.type,
							entry.timestamp ?? null,
							entryJson,
							createHash("sha256").update(entryJson).digest("hex"),
						);
						insertLink.run(occurrence.occurrence_id, id, memory.sessionId, entry.id, ordinal);
					});
				}
				database.exec("COMMIT");
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
			return memories.length;
		} finally {
			database.close();
		}
	}

	recall(cwd: string, memoryId: string): ArchivedRecall | undefined {
		const root = canonicalProjectRoot(cwd);
		const id = projectId(root);
		const database = this.open();
		try {
			const rows = database.prepare(`
				SELECT o.occurrence_id, p.canonical_root AS project_root, o.memory_id, o.kind,
					o.content, o.relevance, o.observation_status, o.memory_timestamp, o.session_id, o.ledger_entry_id,
					o.record_index, o.recorded_at, o.supporting_observation_ids, o.source_entry_ids,
					o.missing_source_entry_ids, o.non_source_entry_ids, o.missing_supporting_observation_ids
				FROM occurrences o JOIN projects p ON p.project_id=o.project_id
				WHERE o.project_id=? AND o.memory_id=?
				ORDER BY COALESCE(o.recorded_at, '') DESC, o.occurrence_id DESC
				LIMIT 20
			`).all(id, memoryId) as OccurrenceRow[];
			if (rows.length === 0) return undefined;
			const evidenceStatement = database.prepare(`
				SELECT e.entry_json
				FROM occurrence_evidence oe
				JOIN evidence_entries e ON
					e.project_id=oe.project_id AND e.session_id=oe.session_id AND e.source_entry_id=oe.source_entry_id
				WHERE oe.occurrence_id=?
				ORDER BY oe.ordinal
			`);
			const occurrences = rows.map((row): ArchivedRecallOccurrence => ({
				occurrenceId: row.occurrence_id,
				projectRoot: row.project_root,
				memoryId: row.memory_id,
				kind: row.kind,
				content: row.content,
				...(row.relevance ? { relevance: row.relevance as ArchivedMemoryOccurrence["relevance"] } : {}),
				...(row.observation_status ? { observationStatus: row.observation_status } : {}),
				...(row.memory_timestamp ? { memoryTimestamp: row.memory_timestamp } : {}),
				sessionId: row.session_id,
				ledgerEntryId: row.ledger_entry_id,
				recordIndex: row.record_index,
				...(row.recorded_at ? { recordedAt: row.recorded_at } : {}),
				supportingObservationIds: parseStringArray(row.supporting_observation_ids),
				sourceEntryIds: parseStringArray(row.source_entry_ids),
				missingSourceEntryIds: parseStringArray(row.missing_source_entry_ids),
				nonSourceEntryIds: parseStringArray(row.non_source_entry_ids),
				missingSupportingObservationIds: parseStringArray(row.missing_supporting_observation_ids),
				sourceEntries: (evidenceStatement.all(row.occurrence_id) as EvidenceRow[])
					.map((evidence) => parseEntry(evidence.entry_json))
					.filter((entry): entry is SessionEntry => entry !== undefined),
			}));
			return { memoryId, occurrences };
		} finally {
			database.close();
		}
	}
}
