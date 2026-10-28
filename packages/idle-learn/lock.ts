import lockfile from "proper-lockfile";
import { requireOptIn } from "./config.ts";
import { DATA_DIR, ensureProjectDirectory, projectPath } from "./files.ts";

export interface ProjectLock {
	assertHeld(): void;
	release(): Promise<void>;
}

/** Heartbeats retain live locks. After termination, stale locks expire after 30 seconds. */
export async function acquireProjectLock(root: string, kind: "review" | "storage"): Promise<ProjectLock> {
	requireOptIn(root, kind === "storage");
	ensureProjectDirectory(root, DATA_DIR);
	const path = projectPath(root, `${DATA_DIR}/${kind}.lock`);
	let compromised: Error | undefined;
	let released = false;
	const unlock = await lockfile.lock(path, {
		lockfilePath: path,
		realpath: false,
		retries: 0,
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

export async function withStorageLock<T>(root: string, action: (lease: ProjectLock) => T): Promise<T> {
	const lease = await acquireProjectLock(root, "storage");
	try {
		lease.assertHeld();
		return action(lease);
	} finally {
		await lease.release();
	}
}
