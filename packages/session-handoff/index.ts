import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HandoffMonitor, getLatestMessageTimestamp, type HandoffStatus } from "./core.ts";

const STATUS_KEY = "session-handoff";

export default function sessionHandoffExtension(pi: ExtensionAPI): void {
	let monitor: HandoffMonitor | undefined;

	const renderStatus = (ctx: ExtensionContext, status: HandoffStatus): void => {
		ctx.ui.setStatus(STATUS_KEY, status ? ctx.ui.theme.fg(status.tone, status.label) : undefined);
	};

	const startMonitor = (ctx: ExtensionContext): void => {
		monitor?.dispose();
		if (ctx.mode !== "tui") {
			monitor = undefined;
			return;
		}
		monitor = new HandoffMonitor({
			getContextTokens: () => ctx.getContextUsage()?.tokens,
			renderStatus: (status) => renderStatus(ctx, status),
		});
		monitor.reset(getLatestMessageTimestamp(ctx.sessionManager.getBranch()));
	};

	pi.on("session_start", async (_event, ctx) => {
		startMonitor(ctx);
	});

	pi.on("input", async (_event, _ctx) => {
		monitor?.recordMessage();
	});

	pi.on("message_end", async (event, _ctx) => {
		monitor?.recordMessage(event.message.timestamp);
	});

	pi.on("agent_end", async (_event, _ctx) => {
		monitor?.refresh();
	});

	pi.on("session_compact", async (_event, _ctx) => {
		monitor?.refresh();
	});

	pi.on("session_tree", async (_event, ctx) => {
		monitor?.reset(getLatestMessageTimestamp(ctx.sessionManager.getBranch()));
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		monitor?.dispose();
		monitor = undefined;
	});
}
