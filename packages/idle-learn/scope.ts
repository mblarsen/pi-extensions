import { posix } from "node:path";
import { DATA_DIR, MAX_FILE_BYTES, projectPath, targetPath } from "./files.ts";

export const MAX_NEW_REFERENCE_FILES = 3;
const isAgents = (path: string) => path.split("/").at(-1) === "AGENTS.md";
const directoryOf = (path: string) => posix.dirname(path) === "." ? "" : posix.dirname(path);

/** Project-relative Markdown files linked from a document. External, absolute, anchor-only, and escaping links are ignored. */
export function markdownLinks(content: string, from: string): string[] {
	const links = new Set<string>();
	for (const match of content.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)) {
		let link = match[1].split("#")[0].split("?")[0];
		if (!link || /^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("/")) continue;
		try { link = decodeURIComponent(link); } catch { continue; }
		const resolved = posix.normalize(posix.join(directoryOf(from), link));
		if (resolved === "." || resolved.startsWith("../") || resolved === ".." || !resolved.endsWith(".md")) continue;
		links.add(resolved);
	}
	return [...links].sort();
}

function inside(directory: string, path: string): boolean {
	return directory === "" || path.startsWith(`${directory}/`);
}

/** Basic path checks shared by integration and Apply. Rejects symlinks, `.git`, escapes, and Idle Learn state. */
export function checkDraftPath(root: string, path: string, targets: ReadonlySet<string>): void {
	if (typeof path !== "string" || path.length > 4096) throw new Error("Invalid draft path.");
	if (isAgents(path)) {
		if (!targets.has(path)) throw new Error(`Draft may not change ${path}; only the selected proposals' AGENTS.md targets are in scope.`);
		targetPath(root, path);
		return;
	}
	if (!path.endsWith(".md")) throw new Error(`Reference files must be Markdown: ${path}.`);
	if (path === DATA_DIR || path.startsWith(".pi/") || path === ".pi") throw new Error(`Draft may not write Pi state: ${path}.`);
	projectPath(root, path);
}

export interface ScopeFile { path: string; existed: boolean; content: string }

/**
 * Write scope for one integration draft:
 * - the selected AGENTS.md targets;
 * - existing Markdown files a captured target already links to;
 * - at most three new Markdown files, each inside the directory of a drafted AGENTS.md that links to it.
 */
export function checkScope(root: string, targets: ReadonlySet<string>, captured: ReadonlyMap<string, string | null>, files: readonly ScopeFile[]): void {
	const drafted = new Map(files.map((file) => [file.path, file.content]));
	if (drafted.size !== files.length) throw new Error("Draft lists a file more than once.");
	const linkedBefore = new Set([...targets].flatMap((target) => markdownLinks(captured.get(target) ?? "", target)));
	let created = 0;
	for (const file of files) {
		checkDraftPath(root, file.path, targets);
		if (file.content.includes("\0") || Buffer.byteLength(file.content) > MAX_FILE_BYTES) throw new Error(`Drafted ${file.path} exceeds the size limit or is not text.`);
		if (isAgents(file.path)) continue;
		if (file.existed) {
			if (!linkedBefore.has(file.path) || !captured.has(file.path)) throw new Error(`Draft may only change existing files already linked from a selected AGENTS.md: ${file.path}.`);
			continue;
		}
		if (++created > MAX_NEW_REFERENCE_FILES) throw new Error(`Draft may create at most ${MAX_NEW_REFERENCE_FILES} new reference files.`);
		const linking = [...targets].filter((target) => inside(directoryOf(target), file.path)
			&& markdownLinks(drafted.get(target) ?? captured.get(target) ?? "", target).includes(file.path));
		if (!linking.length) throw new Error(`New reference file ${file.path} must be linked from a drafted AGENTS.md in a parent directory.`);
	}
}
