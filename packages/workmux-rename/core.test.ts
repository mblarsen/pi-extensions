import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	parseWorkmuxRenameArguments,
	resolveRenamedWorktreeCwd,
	writeSessionSnapshot,
} from "./core.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

describe("parseWorkmuxRenameArguments", () => {
	test("parses the new worktree name", () => {
		assert.deepEqual(parseWorkmuxRenameArguments("feature-new"), {
			newName: "feature-new",
			renameBranch: false,
		});
	});

	test("accepts long and short branch flags on either side of the name", () => {
		assert.deepEqual(parseWorkmuxRenameArguments("--branch feature-new"), {
			newName: "feature-new",
			renameBranch: true,
		});
		assert.deepEqual(parseWorkmuxRenameArguments("feature-new -b"), {
			newName: "feature-new",
			renameBranch: true,
		});
	});

	test("rejects missing names, unknown options, and explicit old names", () => {
		assert.throws(() => parseWorkmuxRenameArguments(""), /Usage:/);
		assert.throws(() => parseWorkmuxRenameArguments("--force feature-new"), /Unknown option/);
		assert.throws(() => parseWorkmuxRenameArguments("feature-old feature-new"), /current worktree/);
	});
});

describe("resolveRenamedWorktreeCwd", () => {
	test("resolves the moved worktree through Git metadata when process.cwd is stale", () => {
		const directory = temporaryDirectory("workmux-rename-cwd-test-");
		const worktreeAdminDir = join(directory, "repo", ".git", "worktrees", "feat-test");
		const oldWorktreeRoot = join(directory, "repo", ".worktrees", "feat-test");
		const newWorktreeRoot = join(directory, "repo", ".worktrees", "feat-fest");
		const newCwd = join(newWorktreeRoot, "packages", "app");
		mkdirSync(worktreeAdminDir, { recursive: true });
		mkdirSync(newCwd, { recursive: true });
		writeFileSync(join(worktreeAdminDir, "gitdir"), `${join(newWorktreeRoot, ".git")}\n`);

		assert.equal(resolveRenamedWorktreeCwd({ worktreeAdminDir, relativeCwd: "packages/app" }), newCwd);
		assert.equal(readFileSync(join(worktreeAdminDir, "gitdir"), "utf8").includes(oldWorktreeRoot), false);
	});
});

describe("writeSessionSnapshot", () => {
	test("materializes a fresh Pi session that has not created its source file yet", () => {
		const directory = temporaryDirectory("workmux-rename-session-test-");
		const source = SessionManager.create(join(directory, "source"), join(directory, "source-sessions"));
		source.appendCustomEntry("test-state", { value: 42 });
		const sourceFile = source.getSessionFile();
		assert.ok(sourceFile);
		assert.equal(existsSync(sourceFile), false);

		const destination = SessionManager.create(join(directory, "target"), join(directory, "target-sessions"));
		const destinationFile = destination.getSessionFile();
		assert.ok(destinationFile);
		writeSessionSnapshot(destinationFile, destination.getHeader(), source.getEntries());

		const reopened = SessionManager.open(destinationFile);
		const reopenedHeader = reopened.getHeader();
		assert.ok(reopenedHeader);
		assert.equal(reopenedHeader.cwd, join(directory, "target"));
		assert.deepEqual(reopened.getEntries(), source.getEntries());
	});

	test("removes a partial snapshot when serialization fails", () => {
		const directory = temporaryDirectory("workmux-rename-session-failure-test-");
		const sessionFile = join(directory, "session.jsonl");

		assert.throws(
			() => writeSessionSnapshot(sessionFile, { type: "session" }, [{ value: 1n }]),
			/BigInt/,
		);
		assert.equal(existsSync(sessionFile), false);
	});
});
