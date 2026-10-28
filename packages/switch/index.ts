import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { request } from "./control.ts";

export default function piSwitch(pi: ExtensionAPI): void {
	let switching = false;
	let prepared = false;

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!switching || !prepared) return;
		// Resume selects the last persisted entry, not an unsaved /tree cursor.
		pi.appendEntry("pi-switch.handoff", { fromLeaf: ctx.sessionManager.getLeafId() });
		await request({ action: "commit", leaf: ctx.sessionManager.getLeafId() });
	});

	pi.on("session_start", async (_event, ctx) => {
		const expected = process.env.PI_SWITCH_EXPECTED;
		if (!expected) return;
		try {
			const previous = JSON.parse(expected);
			const file = ctx.sessionManager.getSessionFile();
			if (!file || ctx.sessionManager.getSessionId() !== previous.id ||
				await realpath(file) !== await realpath(previous.file) ||
				ctx.sessionManager.getLeafId() !== previous.leaf) {
				throw new Error("The target did not resume the same session file and branch.");
			}
			await request({ action: "ready" });
			delete process.env.PI_SWITCH_EXPECTED;
		} catch (error) {
			ctx.ui.notify(`pi-switch: ${String(error)}`, "error");
			ctx.shutdown();
		}
	});

	for (const target of ["pi", "pig"] as const) {
		pi.registerCommand(target, {
			description: `Continue this session in ${target === "pi" ? "Pi" : "PiG"}`,
			handler: async (args, ctx) => {
				const fail = (message: string) => ctx.ui.notify(`pi-switch: ${message}`, "error");
				if (args.trim()) return fail(`/${target} takes no arguments.`);
				if (!process.env.PI_SWITCH_SOCKET || !process.env.PI_SWITCH_TOKEN) {
					return fail("Start through pi-switch pi or pi-switch pig to enable same-terminal switching.");
				}
				if (process.env.PI_SWITCH_HOST === target) {
					ctx.ui.notify(`Already running ${target === "pi" ? "Pi" : "PiG"}.`, "info");
					return;
				}
				if (!ctx.hasUI || (ctx.mode !== undefined && ctx.mode !== "tui")) return fail("Switching requires an interactive terminal.");
				if (switching) return fail("A switch is already in progress.");
				if (!ctx.isIdle() || ctx.hasPendingMessages()) return fail("Finish active work and queued messages before switching.");
				if (ctx.ui.getEditorText().trim()) return fail("Send or clear the editor text before switching.");
				const file = ctx.sessionManager.getSessionFile();
				if (!file) return fail("Save this session before switching.");
				switching = true;
				try {
					if (!(await stat(file)).isFile()) throw new Error("The session file is not a regular file.");
					await request({ action: "switch", target, cwd: ctx.cwd, file: resolve(file),
						id: ctx.sessionManager.getSessionId(), leaf: ctx.sessionManager.getLeafId() });
					prepared = true;
					if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Work started before shutdown. Try again when idle.");
					ctx.ui.notify(`Switching to ${target === "pi" ? "Pi" : "PiG"}...`, "info");
					ctx.shutdown();
				} catch (error) {
					await request({ action: "cancel" }).catch(() => {});
					prepared = false;
					switching = false;
					fail(error instanceof Error ? error.message : String(error));
				}
			},
		});
	}
}
