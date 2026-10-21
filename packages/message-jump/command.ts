/**
 * Argument handling for the single `/jump` command.
 *
 * The command carries four subcommands, so the parsing and the completion
 * suggestions live here as pure functions and stay testable without a live TUI.
 */

import type { AutocompleteItem } from "@earendil-works/pi-tui";

export const SUBCOMMANDS = ["prev", "next", "context", "debug"] as const;

export type Subcommand = (typeof SUBCOMMANDS)[number];

const DESCRIPTIONS: Record<Subcommand, string> = {
	prev: "Jump to the previous message",
	next: "Jump to the next message",
	context: "Rows of context kept above a jumped-to message",
	debug: "Write the transcript state the jumps can see",
};

/** Common context settings, offered when completing `context`. */
export const CONTEXT_PRESETS = ["2/3", "1/2", "1/3", "10", "5", "0"];

const ALIASES: Record<string, Subcommand> = {
	p: "prev",
	previous: "prev",
	prev: "prev",
	n: "next",
	next: "next",
	c: "context",
	context: "context",
	d: "debug",
	debug: "debug",
};

export interface JumpInvocation {
	/** `help` means the arguments named no known subcommand. */
	command: Subcommand | "help";
	/** Subcommand argument, for `context` the rows or fraction. */
	value: string;
	/** The word that was not recognised, when `command` is `help`. */
	unknown?: string;
}

export function parseJumpArgs(args: string): JumpInvocation {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { command: "help", value: "" };

	const [head, ...rest] = tokens;
	const command = ALIASES[head.toLowerCase()];
	if (command === undefined) return { command: "help", value: "", unknown: head };
	if (command !== "context" && rest.length > 0) {
		return { command: "help", value: "", unknown: tokens.join(" ") };
	}

	return { command, value: rest.join(" ") };
}

/**
 * Complete the subcommand, or the value of `context`.
 *
 * The value replaces the whole argument string, the way the built-in commands
 * do, so `<command> <value>` is returned rather than the bare value.
 */
export function jumpArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const text = prefix.trimStart();
	const tokens = text.split(/\s+/);
	const head = tokens[0] ?? "";

	if (tokens.length === 1 && !text.endsWith(" ")) {
		const items = SUBCOMMANDS.filter((name) => name.startsWith(head)).map((name) => ({
			value: `${name} `,
			label: name,
			description: DESCRIPTIONS[name],
		}));
		return items.length > 0 ? items : null;
	}

	if (head !== "context") return null;

	const partial = tokens.slice(1).join(" ");
	const presetItems = CONTEXT_PRESETS.filter((preset) => preset.startsWith(partial)).map((preset) => ({
		value: `jump ${preset}`,
		label: preset,
	}));
	return presetItems.length > 0 ? presetItems : null;
}

export function jumpUsage(contextSpec: string | number): string {
	return `Message jump: /jump ${SUBCOMMANDS.join(" | ")} · context ${String(contextSpec)}`;
}
