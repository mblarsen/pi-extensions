import { readdirSync } from "node:fs";
import { contentHash, projectPath, readProjectFile } from "./files.ts";
import type { Evidence } from "./store.ts";

export interface TranscriptEntry { id: string; text: string }
export interface BranchEntry { id: string; type: string; message?: { role: string; content?: unknown }; summary?: string }
export function transcriptEntries(branch: readonly BranchEntry[]): TranscriptEntry[] {
	return branch.flatMap((entry) => {
		if (entry.type !== "message" || !entry.message) return [];
		const message = entry.message;
		const content = typeof message.content === "string" ? message.content : Array.isArray(message.content)
			? message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n") : "";
		return content.trim() ? [{ id: entry.id, text: `[${message.role}]\n${content}` }] : [];
	});
}

const excluded = new Set([".git", ".pi", ".worktrees", "node_modules", "dist", "build", "coverage", ".next", ".wrangler"]);
export function evidencePaths(root: string): string[] {
	const files: string[] = [];
	let directories = 0;
	function visit(prefix: string, depth: number) {
		if (depth > 8 || ++directories > 500 || files.length >= 2000) return;
		const directory = prefix ? projectPath(root, prefix) : root;
		for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (files.length >= 2000) break;
			if (item.isSymbolicLink() || excluded.has(item.name) || item.name.startsWith(".")) continue;
			const path = prefix ? `${prefix}/${item.name}` : item.name;
			if (item.isDirectory()) visit(path, depth + 1);
			else if (item.isFile() && !/\.(?:pem|key|p12|pfx|sqlite|db|lock)$/i.test(item.name)) files.push(path);
		}
	}
	visit("", 0);
	return files.sort();
}

export function auditHashes(root: string, paths: string[]): Record<string, string> {
	return Object.fromEntries(paths.filter((path) => path.split("/").at(-1) === "AGENTS.md").map((path) => {
		const content = readProjectFile(root, path);
		return [path, contentHash(content ?? "")];
	}));
}

export function checkQuotes(quotes: Evidence[], entries: TranscriptEntry[], session: string, previous: Evidence[]): void {
	for (const quote of quotes) {
		const current = quote.session === session && entries.some((entry) => entry.id === quote.entry && entry.text.includes(quote.quote));
		const remembered = previous.some((old) => old.session === quote.session && old.entry === quote.entry && old.quote.includes(quote.quote));
		if (!current && !remembered) throw new Error("Reviewer evidence does not match a supplied session entry.");
	}
}
