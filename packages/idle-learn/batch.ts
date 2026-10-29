import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { requireOptIn } from "./config.ts";
import { atomicProjectWrite, contentHash, DATA_DIR, ensureProjectDirectory, isMissing, MAX_FILE_BYTES, projectPath, readProjectFile } from "./files.ts";
import { withStorageLock } from "./lock.ts";
import { checkScope } from "./scope.ts";
import { archiveSuggestion, readArchived, readPending, suggestionSnapshot, type Suggestion } from "./store.ts";

export const BATCH_DIR = `${DATA_DIR}/batches`;
export const MAX_BATCH_SOURCES = 12;
export const MAX_COMMENTS = 20;
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hashPattern = /^[a-f0-9]{64}$/;

export interface BatchSource { number: number; id: string; snapshot: string }
export interface BatchComment { created: string; text: string }
export interface DraftFile { path: string; baseHash: string | null; content: string }
export interface Draft {
	created: string;
	/** Hash of the draft body below, checked again before Apply. */
	hash: string;
	/** Hash of the batch sources the draft was generated from. */
	sources: string;
	/** Number of batch comments the reviewer saw. */
	comments: number;
	summary: string;
	notes: Array<{ number: number; note: string }>;
	files: DraftFile[];
}
export interface ApplyJournal { draft: string; files: Array<{ path: string; beforeHash: string | null; afterHash: string }> }
export interface Batch {
	version: 1;
	id: string;
	created: string;
	updated: string;
	status: "open" | "applying" | "applied" | "discarded";
	sources: BatchSource[];
	comments: BatchComment[];
	draft?: Draft;
	apply?: ApplyJournal;
	error?: string;
}

function batchPath(id: string): string {
	if (!idPattern.test(id)) throw new Error("Invalid batch ID.");
	return `${BATCH_DIR}/${id}.json`;
}
function fail(field: string): never { throw new Error(`Invalid batch ${field}. Inspect or remove the batch file.`); }
function str(value: unknown, field: string, limit: number, empty = false): string {
	if (typeof value !== "string" || (!empty && !value.trim()) || value.length > limit || value.includes("\0")) fail(field);
	return value;
}
function date(value: unknown, field: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail(field);
	return value;
}
const hashOrNull = (value: unknown, field: string) => value === null ? null : hashPattern.test(String(value)) && typeof value === "string" ? value : fail(field);

export function sourcesHash(sources: readonly BatchSource[]): string { return contentHash(JSON.stringify(sources)); }
export function draftHash(draft: Omit<Draft, "hash" | "created">): string {
	return contentHash(JSON.stringify({ sources: draft.sources, comments: draft.comments, summary: draft.summary, notes: draft.notes, files: draft.files }));
}

export function parseBatch(text: string): Batch {
	let value: any;
	try { value = JSON.parse(text); } catch { fail("JSON"); }
	if (!value || typeof value !== "object" || value.version !== 1) fail("version");
	if (typeof value.id !== "string" || !idPattern.test(value.id)) fail("ID");
	if (!["open", "applying", "applied", "discarded"].includes(value.status)) fail("status");
	if (!Array.isArray(value.sources) || value.sources.length > MAX_BATCH_SOURCES) fail("sources");
	const numbers = new Set<number>(); const ids = new Set<string>();
	const sources = value.sources.map((item: any) => {
		if (!item || !Number.isInteger(item.number) || item.number < 1 || item.number > MAX_BATCH_SOURCES || numbers.has(item.number)
			|| typeof item.id !== "string" || !idPattern.test(item.id) || ids.has(item.id) || typeof item.snapshot !== "string" || !hashPattern.test(item.snapshot)) fail("source");
		numbers.add(item.number); ids.add(item.id);
		return { number: item.number, id: item.id, snapshot: item.snapshot };
	});
	if (!Array.isArray(value.comments) || value.comments.length > MAX_COMMENTS) fail("comments");
	const comments = value.comments.map((item: any) => ({ created: date(item?.created, "comment date"), text: str(item?.text, "comment", 4000) }));
	const batch: Batch = { version: 1, id: value.id, created: date(value.created, "creation time"), updated: date(value.updated, "update time"), status: value.status, sources, comments };
	if (value.draft !== undefined) {
		const draft = value.draft;
		if (!draft || typeof draft !== "object" || !Array.isArray(draft.notes) || !Array.isArray(draft.files) || draft.files.length > 16
			|| !Number.isInteger(draft.comments) || draft.comments < 0 || draft.comments > MAX_COMMENTS) fail("draft");
		const parsed: Draft = {
			created: date(draft.created, "draft time"), hash: hashOrNull(draft.hash, "draft hash") ?? fail("draft hash"),
			sources: hashOrNull(draft.sources, "draft sources") ?? fail("draft sources"), comments: draft.comments,
			summary: str(draft.summary, "draft summary", 8000),
			notes: draft.notes.map((note: any) => ({ number: Number.isInteger(note?.number) ? note.number : fail("draft note"), note: str(note?.note, "draft note", 2000) })),
			files: draft.files.map((file: any) => ({ path: str(file?.path, "draft path", 4096), baseHash: hashOrNull(file?.baseHash, "draft base hash"), content: str(file?.content, "draft content", MAX_FILE_BYTES, true) })),
		};
		if (draftHash(parsed) !== parsed.hash) fail("draft hash");
		batch.draft = parsed;
	}
	if (value.apply !== undefined) {
		const apply = value.apply;
		if (!apply || !hashPattern.test(String(apply.draft)) || !Array.isArray(apply.files) || apply.files.length > 16) fail("apply journal");
		batch.apply = { draft: apply.draft, files: apply.files.map((file: any) => ({ path: str(file?.path, "journal path", 4096), beforeHash: hashOrNull(file?.beforeHash, "journal hash"), afterHash: hashOrNull(file?.afterHash, "journal hash") ?? fail("journal hash") })) };
	}
	if (value.error !== undefined) batch.error = str(value.error, "error", 4000);
	if ((batch.status === "applying" || batch.status === "applied") && (!batch.apply || !batch.draft || batch.apply.draft !== batch.draft.hash)) fail("apply journal");
	return batch;
}

function serialize(batch: Batch): string { return `${JSON.stringify(batch, null, 2)}\n`; }

function write(root: string, batch: Batch, previous: string | null): Batch {
	const next = { ...batch, updated: new Date().toISOString() };
	const content = serialize(next);
	if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("Batch exceeds the size limit. Remove comments or proposals.");
	ensureProjectDirectory(root, BATCH_DIR);
	atomicProjectWrite(root, batchPath(batch.id), content, previous);
	return next;
}

function load(root: string, id: string): { batch: Batch; original: string } {
	const original = readProjectFile(root, batchPath(id));
	if (original === null) throw new Error("Batch no longer exists. Reopen the review screen.");
	const batch = parseBatch(original);
	if (batch.id !== id) fail("ID");
	return { batch, original };
}

export function readBatch(root: string, id: string): Batch { requireOptIn(root, true); return load(root, id).batch; }

/** Unfinished batches, newest first. Applied and discarded batches remain on disk as history. */
export function listBatches(root: string, all = false): Batch[] {
	requireOptIn(root, true);
	let names: string[];
	try { names = readdirSync(projectPath(root, BATCH_DIR)); } catch (error) { if (isMissing(error)) return []; throw error; }
	return names.filter((name) => name.endsWith(".json")).map((name) => load(root, name.slice(0, -5)).batch)
		.filter((batch) => all || batch.status === "open" || batch.status === "applying")
		.sort((a, b) => b.updated.localeCompare(a.updated));
}

/** Selection only records source IDs. It never writes targets or archives suggestions. */
export async function createBatch(root: string, selected: readonly Suggestion[]): Promise<Batch> {
	if (!selected.length) throw new Error("Select at least one suggestion with Space.");
	if (selected.length > MAX_BATCH_SOURCES) throw new Error(`Select at most ${MAX_BATCH_SOURCES} suggestions per batch.`);
	requireOptIn(root, true);
	return withStorageLock(root, () => {
		const sources = selected.map((displayed, index) => {
			if (displayed.kind === "calibration") throw new Error("Calibration items are applied individually, not integrated.");
			const pending = readPending(root, displayed.id);
			if (!pending || JSON.stringify(pending.suggestion) !== JSON.stringify(displayed)) throw new Error(`"${displayed.title}" changed or is no longer pending. Reload the review screen.`);
			return { number: index + 1, id: displayed.id, snapshot: suggestionSnapshot(pending.suggestion) };
		});
		const now = new Date().toISOString();
		return write(root, { version: 1, id: randomUUID(), created: now, updated: now, status: "open", sources, comments: [] }, null);
	});
}

/** Apply a change to the latest stored batch. Concurrent comments are merged because each update rereads the file. */
export async function updateBatch(root: string, id: string, change: (batch: Batch) => Batch): Promise<Batch> {
	requireOptIn(root, true);
	return withStorageLock(root, () => {
		const { batch, original } = load(root, id);
		return write(root, change(batch), original);
	});
}

function requireOpen(batch: Batch): void {
	if (batch.status === "applying") throw new Error("This batch was partially applied. Resume Apply to finish it.");
	if (batch.status !== "open") throw new Error(`This batch is ${batch.status}.`);
}

export async function addComment(root: string, id: string, text: string): Promise<Batch> {
	const comment = text.trim();
	if (!comment) throw new Error("Comment is empty.");
	if (comment.length > 4000 || comment.includes("\0")) throw new Error("Comments are limited to 4000 characters.");
	return updateBatch(root, id, (batch) => {
		requireOpen(batch);
		if (batch.comments.length >= MAX_COMMENTS) throw new Error(`A batch may hold at most ${MAX_COMMENTS} comments.`);
		return { ...batch, comments: [...batch.comments, { created: new Date().toISOString(), text: comment }] };
	});
}

/** Numbers are never reused, so earlier comments keep referring to the same proposals. */
export function removeSource(root: string, id: string, number: number): Promise<Batch> {
	return updateBatch(root, id, (batch) => {
		requireOpen(batch);
		if (!batch.sources.some((source) => source.number === number)) throw new Error(`Proposal #${number} is not in this batch.`);
		if (batch.sources.length === 1) throw new Error("A batch needs at least one proposal. Discard the batch instead.");
		return { ...batch, sources: batch.sources.filter((source) => source.number !== number) };
	});
}

/** Discarding leaves every source pending. */
export function discardBatch(root: string, id: string): Promise<Batch> {
	return updateBatch(root, id, (batch) => { requireOpen(batch); return { ...batch, status: "discarded" }; });
}

export function recordBatchError(root: string, id: string, message: string): Promise<Batch> {
	return updateBatch(root, id, (batch) => ({ ...batch, error: message.slice(0, 4000) }));
}

export interface ResolvedSource { number: number; id: string; suggestion?: Suggestion; problem?: string }
/** Resolve sources to their current pending artifacts, reporting any that changed or were decided elsewhere. */
export function resolveSources(root: string, batch: Batch): ResolvedSource[] {
	return batch.sources.map((source) => {
		const pending = readPending(root, source.id);
		if (pending) return suggestionSnapshot(pending.suggestion) === source.snapshot
			? { ...source, suggestion: pending.suggestion }
			: { ...source, suggestion: pending.suggestion, problem: "changed since selection" };
		const applied = readArchived(root, "applied", source.id);
		if (applied) return { ...source, suggestion: applied, problem: applied.integration?.batch === batch.id ? undefined : "applied elsewhere" };
		const rejected = readArchived(root, "rejected", source.id);
		return { ...source, ...(rejected ? { suggestion: rejected } : {}), problem: rejected ? "rejected elsewhere" : "missing" };
	});
}

export type DraftState = { kind: "none" } | { kind: "fresh" } | { kind: "stale"; reason: string };
/** Whether the stored draft can still be applied as reviewed. */
export function draftState(root: string, batch: Batch): DraftState {
	const draft = batch.draft;
	if (!draft) return { kind: "none" };
	if (batch.status !== "open") return { kind: "fresh" };
	if (draft.sources !== sourcesHash(batch.sources)) return { kind: "stale", reason: "Proposals changed since this draft. Regenerate." };
	const problem = resolveSources(root, batch).find((source) => source.problem);
	if (problem) return { kind: "stale", reason: `Proposal #${problem.number} ${problem.problem}. Remove it or discard the batch, then regenerate.` };
	if (draft.comments !== batch.comments.length) return { kind: "stale", reason: "New comments are not reflected yet. Regenerate." };
	for (const file of draft.files) {
		const current = readProjectFile(root, file.path);
		if ((current === null ? null : contentHash(current)) !== file.baseHash) return { kind: "stale", reason: `${file.path} changed since this draft. Regenerate against the current file.` };
	}
	return { kind: "fresh" };
}

export interface ApplyHooks { afterFile?: (path: string) => void }

function finishApply(root: string, batch: Batch, original: string, hooks: ApplyHooks): Batch {
	const draft = batch.draft!, journal = batch.apply!;
	const contents = new Map(draft.files.map((file) => [file.path, file.content]));
	for (const file of journal.files) {
		const current = readProjectFile(root, file.path);
		const hash = current === null ? null : contentHash(current);
		if (hash === file.afterHash) continue;
		if (hash !== file.beforeHash) throw new Error(`${file.path} changed during Apply. The batch remains partially applied; inspect the file, then resume or restore it.`);
		atomicProjectWrite(root, file.path, contents.get(file.path)!, current);
		hooks.afterFile?.(file.path);
	}
	for (const source of batch.sources) {
		const pending = readPending(root, source.id);
		if (!pending) {
			if (readArchived(root, "applied", source.id)?.integration?.batch === batch.id) continue;
			throw new Error(`Proposal #${source.number} was decided elsewhere during Apply. The batch remains partially applied.`);
		}
		const result: Suggestion = { ...pending.suggestion, status: "applied", integration: { batch: batch.id, draft: draft.hash } };
		archiveSuggestion(root, pending.suggestion, result, pending.original);
	}
	const { error: _error, ...rest } = batch;
	return write(root, { ...rest, status: "applied" }, original);
}

async function guarded(root: string, id: string, action: () => Batch): Promise<Batch> {
	try { return await withStorageLock(root, action); }
	catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		try { const current = readBatch(root, id); if (current.status === "applying") await recordBatchError(root, id, message); } catch {}
		throw error;
	}
}

/**
 * Write the reviewed draft and archive every selected proposal as applied.
 * A journal is recorded before the first write, so an interruption leaves an `applying` batch that `resumeApply` finishes.
 */
export async function applyBatch(root: string, displayed: Batch, hooks: ApplyHooks = {}): Promise<Batch> {
	requireOptIn(root, true);
	return guarded(root, displayed.id, () => {
		const { batch, original } = load(root, displayed.id);
		if (JSON.stringify(batch.sources) !== JSON.stringify(displayed.sources) || batch.draft?.hash !== displayed.draft?.hash || batch.comments.length !== displayed.comments.length) throw new Error("Batch changed. Review it again before applying.");
		requireOpen(batch);
		const draft = batch.draft;
		if (!draft) throw new Error("Integrate the batch before applying.");
		const state = draftState(root, batch);
		if (state.kind !== "fresh") throw new Error(state.kind === "stale" ? state.reason : "Integrate the batch before applying.");
		const targets = new Set(resolveSources(root, batch).map((source) => source.suggestion!.target));
		const captured = new Map<string, string | null>();
		for (const target of targets) captured.set(target, readProjectFile(root, target));
		for (const file of draft.files) if (!captured.has(file.path)) captured.set(file.path, readProjectFile(root, file.path));
		checkScope(root, targets, captured, draft.files.map((file) => ({ path: file.path, existed: file.baseHash !== null, content: file.content })));
		const journal: ApplyJournal = { draft: draft.hash, files: draft.files.map((file) => ({ path: file.path, beforeHash: file.baseHash, afterHash: contentHash(file.content) })) };
		const applying = write(root, { ...batch, status: "applying", apply: journal }, original);
		return finishApply(root, applying, serialize(applying), hooks);
	});
}

/** Finish a partially applied batch. Files already at their reviewed content are left alone; diverged files stop recovery. */
export async function resumeApply(root: string, id: string, hooks: ApplyHooks = {}): Promise<Batch> {
	requireOptIn(root, true);
	return guarded(root, id, () => {
		const { batch, original } = load(root, id);
		if (batch.status !== "applying") throw new Error("This batch has no interrupted Apply.");
		return finishApply(root, batch, original, hooks);
	});
}
