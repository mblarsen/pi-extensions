import { stripVTControlCharacters } from "node:util";
import boxen from "boxen";
import { HStack, SelectList, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { suggestionDiff, type Suggestion } from "./store.ts";

export type ReviewAction = { kind: "close" | "analyze" } | { kind: "apply" | "reject"; suggestion: Suggestion };
export function safeText(value: string): string { return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""); }
const inline = (value: string) => safeText(value).replace(/\s+/g, " ").trim();

export class ReviewPanel implements Component {
	private selected = 0;
	private detail = false;
	private scroll = 0;
	private maxScroll = 0;
	private wide = false;
	private page = 10;
	private suggestions: Suggestion[];
	private status: string;
	private theme: Pick<Theme, "fg">;
	private height: () => number;
	private done: (action: ReviewAction) => void;
	private keys?: (data: string, action: "confirm" | "cancel") => boolean;
	private list: SelectList;

	constructor(suggestions: Suggestion[], status: string, theme: Pick<Theme, "fg">, height: () => number,
		done: (action: ReviewAction) => void, keys?: (data: string, action: "confirm" | "cancel") => boolean) {
		this.suggestions = suggestions; this.status = status; this.theme = theme; this.height = height; this.done = done; this.keys = keys;
		this.list = new SelectList(suggestions.map((item) => ({ value: item.id, label: `${item.kind === "calibration" ? "[Calibration] " : ""}${inline(item.title)}` })), 8, {
			selectedPrefix: (text) => this.color("accent", text), selectedText: (text) => this.color("accent", text),
			description: (text) => this.color("muted", text), scrollInfo: (text) => this.color("dim", text), noMatch: (text) => text,
		});
	}
	invalidate(): void { this.list.invalidate(); }
	private color(token: ThemeColor, text: string): string { return process.env.NO_COLOR !== undefined ? text : this.theme.fg(token, text); }
	handleInput(data: string): void {
		if (this.keys?.(data, "cancel") || matchesKey(data, "escape") || data === "q") {
			if (this.detail) { this.detail = false; this.scroll = 0; } else this.done({ kind: "close" });
		} else if (data === "a" && !this.suggestions.length) this.done({ kind: "analyze" });
		else if (data === "p" && this.suggestions[this.selected] && (this.detail || this.wide)) this.done({ kind: "apply", suggestion: this.suggestions[this.selected] });
		else if (data === "r" && this.suggestions[this.selected] && (this.detail || this.wide)) this.done({ kind: "reject", suggestion: this.suggestions[this.selected] });
		else if ((matchesKey(data, "enter") || this.keys?.(data, "confirm")) && this.suggestions.length) this.detail = true;
		else if ((matchesKey(data, "tab") || matchesKey(data, "shift+tab")) && this.wide) this.detail = !this.detail;
		else if (this.detail) {
			let direction = matchesKey(data, "down") || data === "j" ? 1 : matchesKey(data, "up") || data === "k" ? -1 : 0;
			if (matchesKey(data, "pageDown")) direction = this.page;
			if (matchesKey(data, "pageUp")) direction = -this.page;
			this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll + direction));
		} else {
			this.list.handleInput(data === "j" ? "\x1b[B" : data === "k" ? "\x1b[A" : data);
			const index = this.suggestions.findIndex((item) => item.id === this.list.getSelectedItem()?.value);
			if (index >= 0 && index !== this.selected) { this.selected = index; this.scroll = 0; }
		}
	}
	private frame(title: string, lines: string[], width: number, rows?: number): string[] {
		const inner = Math.max(1, width - 4);
		const content = lines.map((line) => truncateToWidth(line, inner));
		if (rows !== undefined) {
			content.splice(rows);
			while (content.length < rows) content.push("");
		}
		return boxen(content.join("\n"), { width, borderStyle: "round", title, titleAlignment: "left", padding: { top: 0, bottom: 0, left: 1, right: 1 }, margin: 0 }).split("\n");
	}
	private details(width: number): string[] {
		const suggestion = this.suggestions[this.selected];
		if (!suggestion) return [];
		const lines: string[] = [];
		const add = (text: string, token?: ThemeColor) => {
			for (const line of safeText(text).split("\n")) {
				for (const wrapped of wrapTextWithAnsi(line || " ", Math.max(1, width))) lines.push(token ? this.color(token, wrapped) : wrapped);
			}
		};
		if (suggestion.kind === "calibration") add("Calibration / Reviewer preferences", "accent");
		add(suggestion.title, "toolTitle");
		add(suggestion.target, "muted");
		add("");
		add(suggestion.rationale);
		add("");
		add("Proposed edit", "accent");
		for (const line of suggestionDiff(suggestion).split("\n")) add(line, line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "dim");
		add("");
		add("Evidence", "accent");
		for (const quote of suggestion.evidence) {
			add(`${quote.session}:${quote.entry}`, "dim");
			add(quote.quote);
			add("");
		}
		return lines;
	}
	render(availableWidth: number): string[] {
		if (availableWidth < 40 || this.height() < 12) return [truncateToWidth("Resize terminal to at least 40 columns x 12 rows. Esc closes.", availableWidth)];
		const width = Math.min(132, availableWidth);
		this.wide = width >= 110 && this.suggestions.length > 0;
		if (!this.suggestions.length) {
			const emptyWidth = Math.min(width, 84);
			const lines = ["", this.color("toolTitle", "No pending suggestions"), "", "Analyze this session to look for useful project instructions.", ""];
			if (this.status && this.status !== "Ready") {
				lines.push(...wrapTextWithAnsi(safeText(this.status), emptyWidth - 4).slice(0, 3).map((line) => this.color(this.status.startsWith("Error:") ? "error" : "muted", line)), "");
			}
			lines.push(this.color("accent", "a analyze now") + this.color("dim", "     Esc close"), "");
			return this.frame(this.color("accent", "Idle Learn / Review"), lines.slice(0, this.height() - 2), emptyWidth);
		}
		const rows = Math.max(3, Math.min(28, this.height() - 9));
		this.page = rows;
		const leftWidth = Math.min(40, Math.floor(width * 0.32));
		const detailWidth = this.wide ? width - leftWidth - 1 : width;
		const detailLines = this.details(detailWidth - 4);
		this.maxScroll = Math.max(0, detailLines.length - rows);
		this.scroll = Math.min(this.scroll, this.maxScroll);
		const listing = (columns: number) => this.frame(this.color(this.detail ? "muted" : "accent", `${this.detail ? "" : "› "}Suggestions`), [
			...this.list.render(columns - 4), "", this.color("dim", `${this.selected + 1} of ${this.suggestions.length}`),
		], columns, rows);
		const detail = (columns: number) => this.frame(this.color(this.detail ? "accent" : "muted", `${this.detail ? "› " : ""}${this.suggestions[this.selected]?.kind === "calibration" ? "Calibration" : "Proposed change"}`), detailLines.slice(this.scroll, this.scroll + rows), columns, rows);
		let body: string[];
		if (this.wide) {
			body = new HStack([
				{ component: { render: listing, invalidate() {} }, basis: leftWidth, grow: 0, shrink: 0 },
				{ component: { render: detail, invalidate() {} }, grow: 1 },
			], { gap: 1 }).render(width);
		} else body = this.detail ? detail(width) : listing(width);
		const actions = this.wide ? "p apply   r reject   Tab focus   Esc back/close"
			: this.detail ? "p apply   r reject   Esc back" : "Up/Down select   Enter details   Esc close";
		return [
			this.color("accent", "Idle Learn") + this.color("muted", ` / Review    ${this.suggestions.length} pending`),
			this.color(this.status.startsWith("Error:") ? "error" : "muted", inline(this.status)), "",
			...body,
			this.color("dim", actions),
			...(this.detail || this.wide ? [this.color("dim", `Up/Down/PgUp/PgDn scroll ${this.scroll + 1}/${this.maxScroll + 1}${this.wide ? `  ·  Focus: ${this.detail ? "details" : "suggestions"}` : ""}`)] : []),
		].map((line) => truncateToWidth(process.env.NO_COLOR !== undefined ? stripVTControlCharacters(line) : line, width));
	}
}
