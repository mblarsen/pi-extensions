import lockfile from "proper-lockfile";
import { requireOptIn } from "./config.ts";
import { contentHash, DATA_DIR, ensureProjectDirectory, projectPath } from "./files.ts";

export interface ProjectLock {
	assertHeld(): void;
	release(): Promise<void>;
}

/**
 * Storage locks are short and protect shared-state commits. Integration locks are scoped to one batch
 * and only prevent duplicate runs of that batch. Suggestion generation holds no long-running lock.
 * Heartbeats retain live locks. After termination, stale locks expire after 30 seconds.
 */
export async function acquireProjectLock(root: string, kind: "storage"): Promise<ProjectLock>;
export async function acquireProjectLock(root: string, kind: "integration", task: string): Promise<ProjectLock>;
export async function acquireProjectLock(root: string, kind: "storage" | "integration", task?: string): Promise<ProjectLock> {
	requireOptIn(root, true);
	if (kind === "integration" && !task) throw new Error("Integration locks require a task ID.");
	ensureProjectDirectory(root, DATA_DIR);
	const name = kind === "integration" ? `integration-${contentHash(task!)}` : kind;
	const path = projectPath(root, `${DATA_DIR}/${name}.lock`);
	let compromised: Error | undefined;
	let released = false;
	const unlock = await lockfile.lock(path, {
		lockfilePath: path,
		realpath: false,
		retries: kind === "storage" ? { retries: 8, minTimeout: 10, maxTimeout: 100, factor: 2 } : 0,
		stale: 30_000,
		update: 10_000,
		onCompromised: (error) => { compromised = error; },
	});
	return {
		assertHeld() {
			if (released) throw new Error("The project lock was released.");
			if (compromised) throw new Error(`The project lock was lost: ${compromised.message}`);
		},
		async release() {
			if (released) return;
			released = true;
			if (!compromised) await unlock();
		},
	};
}

export async function withStorageLock<T>(root: string, action: (lease: ProjectLock) => T | Promise<T>): Promise<T> {
	const lease = await acquireProjectLock(root, "storage");
	try {
		lease.assertHeld();
		return await action(lease);
	} finally {
		await lease.release();
	}
}
