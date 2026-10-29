import { stripVTControlCharacters } from "node:util";
import boxen from "boxen";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Batch, DraftState, ResolvedSource } from "./batch.ts";
import { safeText } from "./panel.ts";
import { suggestionDiff } from "./store.ts";

export type BatchAction = { kind: "back" | "comment" | "integrate" | "apply" | "resume" | "discard" } | { kind: "remove"; number: number };
export interface BatchView {
	batch: Batch;
	sources: ResolvedSource[];
	state: DraftState;
	/** Current content of each draft file, used to render the combined diff. */
	current: Map<string, string | null>;
	status: string;
}

const inline = (value: string) => safeText(value).replace(/\s+/g, " ").trim();

/** Full-screen batch review: numbered proposals, comments, and the reviewer's combined draft. */
export class BatchPanel implements Component {
	private scroll = 0;
	private maxScroll = 0;
	private page = 10;
	private removing = false;
	private view: BatchView;
	private theme: Pick<Theme, "fg">;
	private height: () => number;
	private done: (action: BatchAction) => void;
	private keys?: (data: string, action: "confirm" | "cancel") => boolean;

	constructor(view: BatchView, theme: Pick<Theme, "fg">, height: () => number, done: (action: BatchAction) => void, keys?: (data: string, action: "confirm" | "cancel") => boolean) {
		this.view = view; this.theme = theme; this.height = height; this.done = done; this.keys = keys;
	}
	invalidate(): void {}
	private color(token: ThemeColor, text: string): string { return process.env.NO_COLOR !== undefined ? text : this.theme.fg(token, text); }
	private get applying(): boolean { return this.view.batch.status === "applying"; }
	private get canApply(): boolean { return this.view.batch.status === "open" && this.view.state.kind === "fresh"; }

	handleInput(data: string): void {
		if (this.removing) {
			const number = Number(data);
			this.removing = false;
			if (Number.isInteger(number) && this.view.batch.sources.some((source) => source.number === number)) this.done({ kind: "remove", number });
			return;
		}
		if (this.keys?.(data, "cancel") || matchesKey(data, "escape") || data === "q") this.done({ kind: "back" });
		else if (this.applying) { if (data === "u") this.done({ kind: "resume" }); else this.move(data); }
		else if (data === "c") this.done({ kind: "comment" });
		else if (data === "g") this.done({ kind: "integrate" });
		else if (data === "p" && this.canApply) this.done({ kind: "apply" });
		else if (data === "d") this.done({ kind: "discard" });
		else if (data === "x" && this.view.batch.sources.length > 1) {
			const numbers = this.view.batch.sources.map((source) => source.number);
			if (numbers.every((number) => number < 10)) this.removing = true;
		} else this.move(data);
	}
	private move(data: string): void {
		let direction = matchesKey(data, "down") || data === "j" ? 1 : matchesKey(data, "up") || data === "k" ? -1 : 0;
		if (matchesKey(data, "pageDown")) direction = this.page;
		if (matchesKey(data, "pageUp")) direction = -this.page;
		this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll + direction));
	}

	private body(width: number): string[] {
		const lines: string[] = [];
		const add = (text: string, token?: ThemeColor) => {
			for (const line of safeText(text).split("\n")) for (const wrapped of wrapTextWithAnsi(line || " ", Math.max(1, width))) lines.push(token ? this.color(token, wrapped) : wrapped);
		};
		const diff = (text: string) => { for (const line of text.split("\n")) add(line, line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "dim"); };
		const { batch, sources, state, current } = this.view;
		const draft = batch.draft;
		if (draft) {
			add("Integration draft", "accent");
			if (state.kind === "stale") add(state.reason, "warning");
			add(draft.summary);
			add("");
			for (const note of draft.notes) add(`#${note.number} ${note.note}`, "muted");
			add("");
			for (const file of draft.files) {
				const before = current.get(file.path) ?? (file.baseHash === null ? "" : null);
				add(`${file.path}${file.baseHash === null ? "  (new file)" : ""}`, "toolTitle");
				if (before === null) add("File no longer exists. Regenerate.", "warning");
				else diff(generateUnifiedPatch(file.path, before, file.content));
				add("");
			}
		} else {
			add("No integration draft yet", "accent");
			add("Press g to have the Idle Learn reviewer combine these proposals and your comments into one reviewable change.", "muted");
			add("");
		}
		if (batch.error) { add(`Last attempt: ${batch.error}`, "error"); add(""); }
		add("Comments", "accent");
		if (!batch.comments.length) add("None. Press c to add guidance, such as \"Merge #1 and #2 under Testing\".", "muted");
		for (const comment of batch.comments) add(`• ${comment.text}`);
		if (draft && draft.comments < batch.comments.length) add(`${batch.comments.length - draft.comments} comment(s) not yet reflected. Press g to regenerate.`, "warning");
		add("");
		add("Selected proposals", "accent");
		for (const source of sources) {
			const item = source.suggestion;
			add(`#${source.number} ${item ? item.title : source.id}${source.problem ? `  [${source.problem}]` : ""}`, source.problem ? "warning" : "toolTitle");
			if (!item) { add(""); continue; }
			add(item.target, "muted");
			add(item.rationale);
			add("Original proposal", "dim");
			diff(suggestionDiff(item));
			for (const quote of item.evidence) { add(`${quote.session}:${quote.entry}`, "dim"); add(quote.quote); }
			add("");
		}
		return lines;
	}

	render(availableWidth: number): string[] {
		if (availableWidth < 40 || this.height() < 12) return [truncateToWidth("Resize terminal to at least 40 columns x 12 rows. Esc goes back.", availableWidth)];
		const width = Math.min(132, availableWidth);
		const rows = Math.max(3, Math.min(40, this.height() - 7));
		this.page = rows;
		const content = this.body(width - 4);
		this.maxScroll = Math.max(0, content.length - rows);
		this.scroll = Math.min(this.scroll, this.maxScroll);
		const visible = content.slice(this.scroll, this.scroll + rows).map((line) => truncateToWidth(line, width - 4));
		while (visible.length < rows) visible.push("");
		const { batch } = this.view;
		const label = batch.status === "applying" ? "partially applied" : batch.draft ? this.view.state.kind === "fresh" ? "draft ready" : "draft needs regeneration" : "no draft";
		const box = boxen(visible.join("\n"), { width, borderStyle: "round", title: this.color("accent", `Batch: ${batch.sources.length} proposal${batch.sources.length === 1 ? "" : "s"}, ${label}`), titleAlignment: "left", padding: { top: 0, bottom: 0, left: 1, right: 1 }, margin: 0 }).split("\n");
		const actions = this.removing ? `Press the number of the proposal to remove (${batch.sources.map((source) => source.number).join(", ")}); any other key cancels`
			: this.applying ? "u resume Apply   Esc back"
			: `c comment   g ${batch.draft ? "regenerate" : "integrate"}${this.canApply ? "   p apply" : ""}${batch.sources.length > 1 ? "   x remove" : ""}   d discard   Esc back`;
		return [
			this.color("accent", "Idle Learn") + this.color("muted", " / Integration batch"),
			this.color(this.view.status.startsWith("Error:") ? "error" : "muted", inline(this.view.status)),
			...box,
			this.color("dim", actions),
			this.color("dim", `Up/Down/PgUp/PgDn scroll ${this.scroll + 1}/${this.maxScroll + 1}`),
		].map((line) => truncateToWidth(process.env.NO_COLOR !== undefined ? stripVTControlCharacters(line) : line, width));
	}
}
