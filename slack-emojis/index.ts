import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { gemoji } from "gemoji";

const SHORTCODE_RE = /:([a-zA-Z0-9_+-]+):/g;
const SHORTCODE_TOKEN_RE = /(^|[\s([{])(:[a-zA-Z0-9_+-]*)$/;
const MAX_SUGGESTIONS = 20;

type GemojiEntry = (typeof gemoji)[number];

interface EmojiEntry {
	name: string;
	emoji: string;
	description: string;
	category: string;
	tags: string[];
	searchText: string;
}

const emojiEntries = buildEmojiEntries(gemoji);
const emojiByName = new Map(emojiEntries.map((entry) => [entry.name, entry.emoji]));

function buildEmojiEntries(items: readonly GemojiEntry[]): EmojiEntry[] {
	const entries: EmojiEntry[] = [];
	const seen = new Set<string>();

	for (const item of items) {
		for (const rawName of item.names) {
			const name = rawName.toLowerCase();
			if (seen.has(name)) continue;
			seen.add(name);
			entries.push({
				name,
				emoji: item.emoji,
				description: item.description,
				category: item.category,
				tags: item.tags,
				searchText: [name, item.description, item.category, ...item.tags].join(" ").toLowerCase(),
			});
		}
	}

	return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function lookupEmoji(shortcodeName: string): string | undefined {
	return emojiByName.get(shortcodeName.toLowerCase());
}

function replaceShortcodesInPlainText(text: string): string {
	return text.replace(SHORTCODE_RE, (match, name, offset, input) => {
		if (offset > 0 && input[offset - 1] === "\\") return match;
		return lookupEmoji(name) ?? match;
	});
}

function replaceShortcodesOutsideInlineCode(line: string): string {
	let output = "";
	let plain = "";
	let index = 0;
	let inInlineCode = false;
	let inlineFence = "";

	const flushPlain = () => {
		output += replaceShortcodesInPlainText(plain);
		plain = "";
	};

	while (index < line.length) {
		if (line[index] !== "`") {
			if (inInlineCode) output += line[index];
			else plain += line[index];
			index += 1;
			continue;
		}

		let end = index + 1;
		while (end < line.length && line[end] === "`") end += 1;
		const fence = line.slice(index, end);

		if (inInlineCode && fence === inlineFence) {
			output += fence;
			inInlineCode = false;
			inlineFence = "";
		} else if (!inInlineCode) {
			flushPlain();
			output += fence;
			inInlineCode = true;
			inlineFence = fence;
		} else {
			output += fence;
		}

		index = end;
	}

	flushPlain();
	return output;
}

export function emojifySlackShortcodes(text: string): string {
	const lines = text.split("\n");
	let inFencedCode = false;
	let fenceMarker: "```" | "~~~" | undefined;

	return lines
		.map((line) => {
			const fenceMatch = line.match(/^\s*(```|~~~)/);
			if (fenceMatch) {
				const marker = fenceMatch[1] as "```" | "~~~";
				if (!inFencedCode) {
					inFencedCode = true;
					fenceMarker = marker;
				} else if (marker === fenceMarker) {
					inFencedCode = false;
					fenceMarker = undefined;
				}
				return line;
			}

			return inFencedCode ? line : replaceShortcodesOutsideInlineCode(line);
		})
		.join("\n");
}

function extractShortcodeToken(textBeforeCursor: string): string | undefined {
	const match = textBeforeCursor.match(SHORTCODE_TOKEN_RE);
	return match?.[2];
}

function scoreEntry(entry: EmojiEntry, query: string): number | undefined {
	if (!query) return 100;
	if (entry.name === query) return 0;
	if (entry.name.startsWith(query)) return 10 + entry.name.length;
	if (entry.tags.some((tag) => tag.startsWith(query))) return 100 + entry.name.length;
	if (entry.name.includes(query)) return 200 + entry.name.indexOf(query);
	if (entry.searchText.includes(query)) return 300 + entry.searchText.indexOf(query);
	return undefined;
}

function findEmojiSuggestions(query: string): AutocompleteItem[] {
	const normalized = query.toLowerCase();
	return emojiEntries
		.map((entry) => ({ entry, score: scoreEntry(entry, normalized) }))
		.filter((item): item is { entry: EmojiEntry; score: number } => item.score !== undefined)
		.sort((left, right) => left.score - right.score || left.entry.name.localeCompare(right.entry.name))
		.slice(0, MAX_SUGGESTIONS)
		.map(({ entry }) => ({
			value: entry.emoji,
			label: `${entry.emoji} :${entry.name}:`,
			description: entry.description,
		}));
}

function applyEmojiCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: AutocompleteItem,
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const nextLines = [...lines];
	const line = nextLines[cursorLine] ?? "";
	const startCol = Math.max(0, cursorCol - prefix.length);
	nextLines[cursorLine] = `${line.slice(0, startCol)}${item.value}${line.slice(cursorCol)}`;
	return { lines: nextLines, cursorLine, cursorCol: startCol + item.value.length };
}

function createSlackEmojiAutocompleteProvider(current: AutocompleteProvider): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			const token = extractShortcodeToken(textBeforeCursor);
			if (token === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			if (options.signal.aborted) return null;
			const query = token.slice(1);
			const items = findEmojiSuggestions(query);
			if (items.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			return { prefix: token, items };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (prefix.startsWith(":")) {
				return applyEmojiCompletion(lines, cursorLine, cursorCol, item, prefix);
			}
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function (pi: ExtensionAPI): void {
	pi.on("input", (event) => {
		if (event.source === "extension") return { action: "continue" };

		const text = emojifySlackShortcodes(event.text);
		return text === event.text ? { action: "continue" } : { action: "transform", text };
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider((current) => createSlackEmojiAutocompleteProvider(current));
	});

	pi.registerCommand("slack-emojis", {
		description: "Look up a Slack/GitHub emoji shortcode. Usage: /slack-emojis moon",
		handler: async (args, ctx) => {
			const name = args.trim().replace(/^:/, "").replace(/:$/, "");
			if (!name) {
				ctx.ui.notify("Type :moon: and press Tab to insert 🌔, or send :moon: to auto-convert it.", "info");
				return;
			}

			const emoji = lookupEmoji(name);
			ctx.ui.notify(emoji ? `:${name}: → ${emoji}` : `Unknown emoji shortcode: :${name}:`, emoji ? "info" : "warning");
		},
	});
}
