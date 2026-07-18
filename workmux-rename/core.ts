import {
	closeSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

export interface WorkmuxRenameArguments {
	newName: string;
	renameBranch: boolean;
}

export interface RenamedCwdContext {
	worktreeAdminDir: string;
	relativeCwd: string;
}

/** Resolve the moved worktree through Git's stable linked-worktree metadata. */
export function resolveRenamedWorktreeCwd(context: RenamedCwdContext): string {
	const gitdirPointer = readFileSync(resolve(context.worktreeAdminDir, "gitdir"), "utf8").trim();
	if (!gitdirPointer) throw new Error("Git worktree metadata contains an empty gitdir pointer");

	const worktreeGitFile = resolve(context.worktreeAdminDir, gitdirPointer);
	if (basename(worktreeGitFile) !== ".git") {
		throw new Error(`Unexpected Git worktree pointer: ${worktreeGitFile}`);
	}

	const targetCwd = resolve(dirname(worktreeGitFile), context.relativeCwd);
	if (!statSync(targetCwd).isDirectory()) throw new Error(`Not a directory: ${targetCwd}`);
	return targetCwd;
}

export function parseWorkmuxRenameArguments(rawArgs: string): WorkmuxRenameArguments {
	const tokens = rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
	const names: string[] = [];
	let renameBranch = false;

	for (const token of tokens) {
		if (token === "--branch" || token === "-b") {
			renameBranch = true;
			continue;
		}

		if (token.startsWith("-")) {
			throw new Error(`Unknown option: ${token}`);
		}

		names.push(token);
	}

	if (names.length === 0) {
		throw new Error("Usage: /workmux-rename [--branch|-b] <new-name>");
	}

	if (names.length > 1) {
		throw new Error("Expected one new name. /workmux-rename only renames the current worktree.");
	}

	return { newName: names[0], renameBranch };
}

/** Persist a complete live session snapshot, including sessions Pi has not flushed yet. */
export function writeSessionSnapshot(
	sessionFile: string,
	header: unknown,
	entries: readonly unknown[],
): void {
	let fd: number | undefined;
	let created = false;
	let completed = false;

	try {
		fd = openSync(sessionFile, "wx");
		created = true;
		for (const entry of [header, ...entries]) {
			const json = JSON.stringify(entry);
			if (json === undefined) throw new Error("Session snapshot contains a non-serializable entry");
			writeSync(fd, `${json}\n`);
		}
		completed = true;
	} finally {
		let closeError: unknown;
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch (error) {
				closeError = error;
				completed = false;
			}
		}
		if (created && !completed) {
			try {
				unlinkSync(sessionFile);
			} catch {
				// Best-effort cleanup of an incomplete snapshot.
			}
		}
		if (closeError) throw closeError;
	}
}
