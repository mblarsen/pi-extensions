import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, chmodSync, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export const MAX_FILE_BYTES = 256 * 1024;
export const DATA_DIR = ".pi/idle-learn";

export function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function contentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export function projectRoot(cwd: string): string {
	const start = realpathSync(cwd);
	try {
		return realpathSync(execFileSync("git", ["-C", start, "rev-parse", "--show-toplevel"], {
			encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
		}).trim());
	} catch {
		return start;
	}
}

/** Reject symlinks, including links that point back into the project. */
export function projectPath(root: string, path: string): string {
	if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0")) {
		throw new Error("Use a relative project path with forward slashes.");
	}
	const parts = path.split("/");
	if (parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
		throw new Error("Invalid project path.");
	}
	const canonicalRoot = realpathSync(root);
	let current = canonicalRoot;
	for (let i = 0; i < parts.length; i++) {
		current = join(current, parts[i]);
		try {
			const stat = lstatSync(current);
			if (stat.isSymbolicLink()) throw new Error("Project paths must not contain symlinks.");
			if (i < parts.length - 1 && !stat.isDirectory()) throw new Error("Expected a project directory.");
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
	}
	const rel = relative(canonicalRoot, current);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path escapes project.");
	return current;
}

export function targetPath(root: string, path: string): string {
	if (path.split("/").at(-1) !== "AGENTS.md" || path.startsWith(`${DATA_DIR}/`)) {
		throw new Error("Suggestions must target a project AGENTS.md file.");
	}
	return projectPath(root, path);
}

export function readProjectFile(root: string, path: string, maxBytes = MAX_FILE_BYTES): string | null {
	const filename = projectPath(root, path);
	let fd: number;
	try {
		fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1) throw new Error("Expected a regular, unlinked project file.");
		if (stat.size > maxBytes) throw new Error(`Project file exceeds ${maxBytes} bytes.`);
		// A fixed-size read also bounds a file that grows after fstat.
		const buffer = Buffer.alloc(maxBytes + 1);
		let length = 0;
		while (length < buffer.length) {
			const count = readSync(fd, buffer, length, buffer.length - length, null);
			if (!count) break;
			length += count;
		}
		if (length > maxBytes) throw new Error(`Project file exceeds ${maxBytes} bytes.`);
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
	} finally {
		closeSync(fd);
	}
}

export function ensureProjectDirectory(root: string, path: string): void {
	const parts = path.split("/");
	for (let i = 1; i <= parts.length; i++) {
		const filename = projectPath(root, parts.slice(0, i).join("/"));
		try {
			mkdirSync(filename);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
		if (!lstatSync(projectPath(root, parts.slice(0, i).join("/"))).isDirectory()) {
			throw new Error("Expected a project directory.");
		}
	}
}

export function atomicProjectWrite(root: string, path: string, content: string, expected: string | null): void {
	if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("Project output exceeds the file size limit.");
	const filename = projectPath(root, path);
	if (readProjectFile(root, path) !== expected) throw new Error("File changed. Reload before saving.");
	const folder = relative(realpathSync(root), dirname(filename)).split(sep).join("/");
	if (folder) ensureProjectDirectory(root, folder);
	const temporary = `${path}.${randomUUID()}.tmp`;
	const tempPath = projectPath(root, temporary);
	let fd: number | undefined;
	try {
		fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		writeFileSync(fd, content, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		if (readProjectFile(root, path) !== expected) throw new Error("File changed. Reload before saving.");
		projectPath(root, path);
		if (expected === null) {
			// Linking publishes a new file without overwriting a concurrent creator.
			linkSync(tempPath, filename);
			unlinkSync(tempPath);
		} else {
			chmodSync(tempPath, lstatSync(filename).mode & 0o777);
			renameSync(tempPath, filename);
		}
	} finally {
		if (fd !== undefined) closeSync(fd);
		if (existsSync(tempPath)) unlinkSync(tempPath);
	}
}
