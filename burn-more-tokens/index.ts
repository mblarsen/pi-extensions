import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isQuietHours, randomMessage, tryDisplayMessage } from "./core.ts";

let manualEnabled: boolean | undefined;

function isSpeechEnabled(): boolean {
	return manualEnabled ?? !isQuietHours();
}

function speak(message: string): void {
	if (process.platform !== "darwin") return;

	try {
		const child = spawn("say", [message], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
	} catch {
		// Completion notifications must never disrupt the agent turn.
	}
}

interface AnnouncementDependencies {
	display?: (message: string) => Promise<boolean>;
	speechEnabled?: () => boolean;
	speak?: (message: string) => void;
}

export async function announce(
	message: string,
	force = false,
	dependencies: AnnouncementDependencies = {},
): Promise<void> {
	if (await (dependencies.display ?? tryDisplayMessage)(message)) return;
	if (!force && !(dependencies.speechEnabled ?? isSpeechEnabled)()) return;
	(dependencies.speak ?? speak)(message);
}

export default function burnMoreTokensExtension(pi: ExtensionAPI): void {
	pi.registerCommand("say", {
		description: "Control completion messages: /say toggle | now",
		getArgumentCompletions: (prefix) => {
			const value = prefix.trim();
			const items = ["toggle", "now"]
				.filter((command) => command.startsWith(value))
				.map((command) => ({ value: command, label: command }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const command = args.trim();

			if (command === "now") {
				await announce(randomMessage(), true);
				return;
			}

			if (command === "toggle") {
				manualEnabled = !isSpeechEnabled();
				ctx.ui.notify(
					`Speech fallback ${manualEnabled ? "enabled" : "disabled"}`,
					"info",
				);
				return;
			}

			ctx.ui.notify("Usage: /say toggle | now", "warning");
		},
	});

	pi.on("agent_end", async (event) => {
		const lastAssistant = [...event.messages]
			.reverse()
			.find((message) => message.role === "assistant");

		if (lastAssistant?.stopReason === "stop") {
			await announce(randomMessage());
		}
	});
}
