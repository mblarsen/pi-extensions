import type { TranscriptEntry } from "./evidence.ts";

export const CHUNK_BYTES = 48 * 1024;
const OVERLAP_BYTES = 8 * 1024;
const TOOL_BYTES = 4 * 1024;

function prefix(text: string, bytes: number): string {
	return new TextDecoder().decode(Buffer.from(text).subarray(0, bytes), { stream: true });
}

function bounded(entry: TranscriptEntry): TranscriptEntry {
	if (!entry.text.startsWith("[toolResult]\n") || Buffer.byteLength(entry.text) <= TOOL_BYTES) return entry;
	const buffer = Buffer.from(entry.text);
	// Decode the tail from a code-point boundary so retained quotes remain exact.
	let start = buffer.length - 1024;
	while ((buffer[start] & 0xc0) === 0x80) start++;
	return { ...entry, text: `${prefix(entry.text, 2800)}\n[Tool output omitted for review size limits]\n${buffer.subarray(start).toString("utf8")}` };
}

export interface ReviewChunk { entries: TranscriptEntry[]; overlap: TranscriptEntry[]; remaining: number }

export function selectChunk(entries: TranscriptEntry[], reviewed: string[], maxBytes = CHUNK_BYTES): ReviewChunk {
	const seen = new Set(reviewed);
	const boundedEntries = entries.map(bounded);
	const unseen = boundedEntries.filter((entry) => !seen.has(entry.id));
	const selected: TranscriptEntry[] = [];
	let bytes = 0;
	let turnBoundary = 0;
	for (const entry of unseen) {
		const size = Buffer.byteLength(JSON.stringify(entry));
		if (size > maxBytes - OVERLAP_BYTES && selected.length === 0) throw new Error(`Entry ${entry.id} exceeds the evidence limit. Split large conversational messages before retrying.`);
		if (bytes + size > maxBytes - OVERLAP_BYTES) {
			if (entry.text.startsWith("[user]\n")) turnBoundary = selected.length;
			if (turnBoundary > 0) selected.splice(turnBoundary);
			break;
		}
		if (entry.text.startsWith("[user]\n") && selected.length) turnBoundary = selected.length;
		selected.push(entry);
		bytes += size;
	}
	const overlap: TranscriptEntry[] = [];
	const first = selected.length ? boundedEntries.findIndex((entry) => entry.id === selected[0].id) : boundedEntries.length;
	let overlapBytes = 0;
	let turns = 0;
	for (let i = first - 1; i >= 0; i--) {
		const entry = boundedEntries[i];
		if (!seen.has(entry.id)) break;
		const size = Buffer.byteLength(JSON.stringify(entry));
		if (overlapBytes + size > OVERLAP_BYTES) break;
		overlap.unshift(entry);
		overlapBytes += size;
		if (entry.text.startsWith("[user]\n") && ++turns === 2) break;
	}
	return { entries: selected, overlap, remaining: unseen.length - selected.length };
}
