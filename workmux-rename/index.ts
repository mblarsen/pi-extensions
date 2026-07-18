import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import {
	parseWorkmuxRenameArguments,
	resolveRenamedWorktreeCwd,
	writeSessionSnapshot,
	type RenamedCwdContext,
} from "./core.ts";

const TRASH_TIMEOUT_MS = 5000;

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function getBranchSelectionWarning(sourceSessionFile: string, currentLeafId: string | null): string | undefined {
	try {
		const persistedSession = SessionManager.open(sourceSessionFile);
		if (persistedSession.getEntries().length === 0) return undefined;

		const persistedLeafId = persistedSession.getLeafId() as string | null;
		if (currentLeafId === null || currentLeafId !== persistedLeafId) {
			return "/workmux-rename will reopen at the session file's default branch tip, not the current /tree selection. Consider /fork first or continue from the branch tip before renaming.";
		}
	} catch {
		// Warning detection is best-effort.
	}

	return undefined;
}

function commandError(stdout: string, stderr: string, code: number | null): string {
	return stderr.trim() || stdout.trim() || `workmux rename failed with code ${code ?? "unknown"}`;
}

interface CapturedWorktreeContext extends RenamedCwdContext {
	sourceCwd: string;
}

async function captureWorktreeContext(pi: ExtensionAPI, cwd: string): Promise<CapturedWorktreeContext> {
	const result = await pi.exec(
		"git",
		["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir"],
		{ cwd },
	);
	if (result.code !== 0) throw new Error(commandError(result.stdout, result.stderr, result.code));

	const [worktreeRootOutput, worktreeAdminDir] = result.stdout.trim().split("\n");
	if (!worktreeRootOutput || !worktreeAdminDir) {
		throw new Error("Could not determine the current Git worktree metadata");
	}

	const sourceCwd = realpathSync(cwd);
	const worktreeRoot = realpathSync(worktreeRootOutput);
	const relativeCwd = relative(worktreeRoot, sourceCwd);
	if (relativeCwd === ".." || relativeCwd.startsWith(`..${sep}`)) {
		throw new Error(`Pi's cwd is outside the current worktree: ${sourceCwd}`);
	}

	return { sourceCwd, worktreeAdminDir, relativeCwd };
}

export default function workmuxRenameExtension(pi: ExtensionAPI): void {
	const trashFileBestEffort = async (filePath: string, cwd: string): Promise<void> => {
		try {
			const result = await pi.exec("trash", [filePath], { cwd, timeout: TRASH_TIMEOUT_MS });
			if (result.code === 0) return;
		} catch {
			// Never permanently delete a session when trash is unavailable.
		}
	};

	pi.registerCommand("workmux-rename", {
		description: "Rename the current workmux worktree and move this Pi session with it. Usage: /workmux-rename [--branch|-b] <new-name>",
		getArgumentCompletions: (prefix) => {
			const value = prefix.trimStart();
			if ("--branch".startsWith(value)) {
				return [{ value: "--branch", label: "--branch", description: "Also rename the underlying git branch" }];
			}
			return null;
		},
		handler: async (rawArgs, ctx) => {
			await ctx.waitForIdle();

			let args: ReturnType<typeof parseWorkmuxRenameArguments>;
			try {
				args = parseWorkmuxRenameArguments(rawArgs);
			} catch (error) {
				notify(ctx, error instanceof Error ? error.message : String(error), "error");
				return;
			}

			const sourceSessionFile = ctx.sessionManager.getSessionFile();
			if (!sourceSessionFile) {
				notify(ctx, "No persistent session file (Pi may have started with --no-session).", "error");
				return;
			}

			const branchWarning = getBranchSelectionWarning(
				sourceSessionFile,
				ctx.sessionManager.getLeafId() as string | null,
			);
			if (branchWarning) notify(ctx, branchWarning, "warning");

			let worktreeContext: CapturedWorktreeContext;
			try {
				worktreeContext = await captureWorktreeContext(pi, ctx.cwd);
			} catch (error) {
				notify(ctx, `Cannot inspect the current worktree: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			const workmuxArgs = ["rename", ...(args.renameBranch ? ["--branch"] : []), args.newName];
			let renameResult;
			try {
				renameResult = await pi.exec("workmux", workmuxArgs, { cwd: ctx.cwd });
			} catch (error) {
				notify(ctx, `Failed to run workmux: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			if (renameResult.code !== 0) {
				notify(ctx, commandError(renameResult.stdout, renameResult.stderr, renameResult.code), "error");
				return;
			}

			let targetCwd: string;
			try {
				targetCwd = resolveRenamedWorktreeCwd(worktreeContext);
			} catch (error) {
				notify(
					ctx,
					`workmux rename succeeded, but Pi could not resolve the renamed directory: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}

			if (targetCwd === worktreeContext.sourceCwd) {
				notify(ctx, renameResult.stdout.trim() || "workmux rename completed.", "info");
				return;
			}

			try {
				const destinationSession = SessionManager.create(targetCwd);
				const destinationSessionFile = destinationSession.getSessionFile();
				const destinationHeader = destinationSession.getHeader();
				if (!destinationSessionFile || !destinationHeader) {
					throw new Error("SessionManager.create() produced an incomplete session");
				}
				writeSessionSnapshot(
					destinationSessionFile,
					destinationHeader,
					ctx.sessionManager.getEntries(),
				);

				process.stdout.write("\x1b[<u");
				process.stdout.write("\x1b[?2004l");
				process.stdout.write("\x1b[?25h");
				process.stdout.write("\r\n");
				if (process.stdin.isTTY) process.stdin.setRawMode(false);

				const child = spawn("pi", ["--session", destinationSessionFile], {
					cwd: targetCwd,
					env: { ...process.env, PWD: targetCwd },
					stdio: "inherit",
				});

				child.once("spawn", () => {
					void trashFileBestEffort(sourceSessionFile, targetCwd);
					process.stdin.removeAllListeners();
					process.stdin.destroy();
					process.removeAllListeners("SIGINT");
					process.removeAllListeners("SIGTERM");
					process.on("SIGINT", () => {});
					process.on("SIGTERM", () => {});
				});

				child.on("exit", (code) => process.exit(code ?? 0));
				child.on("error", (error) => {
					process.stderr.write(`Failed to launch Pi in the renamed worktree: ${error.message}\n`);
					process.exit(1);
				});
			} catch (error) {
				notify(
					ctx,
					`workmux rename succeeded, but moving the Pi session failed: ${error instanceof Error ? error.message : String(error)}. Restart Pi in ${targetCwd}; the original session was not deleted.`,
					"error",
				);
			}
		},
	});
}
