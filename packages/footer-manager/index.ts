import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Key, matchesKey, truncateToWidth, visibleWidth, type AutocompleteItem } from "@earendil-works/pi-tui";

type FooterLayoutSide = "left" | "right";

type FooterLayoutLine = {
	left: boolean;
	right: boolean;
};

type FooterOrderItem = string | null;

type FooterManagerState = {
	enabled: boolean;
	hidden: string[];
	order: FooterOrderItem[];
	orderMode?: "slot-groups";
	layout: FooterLayoutLine[];
	unplaced: string[];
	renderStatusLine: boolean;
	zenEnabled: boolean;
};

type StoredFooterManagerState = Partial<FooterManagerState> & {
	order?: unknown;
};

type FooterDataRef = {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
	onBranchChange(callback: () => void): () => void;
};

type FooterSnapshot = {
	cwd: string;
	sessionName: string;
	stats: string;
	model: string;
};

type FooterTheme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

type LayoutSlotRef = {
	lineIndex: number;
	side: FooterLayoutSide;
};

type LayoutItemRef = LayoutSlotRef & {
	key: FooterOrderItem;
};

const SETTINGS_KEY = "footerManager";
const BUILTIN_KEYS = ["builtin.cwd", "builtin.session", "builtin.stats", "builtin.model"] as const;
const DEFAULT_ORDER: FooterOrderItem[] = ["builtin.cwd", "builtin.model", "builtin.session", "builtin.stats"];
const DEFAULT_LAYOUT: FooterLayoutLine[] = [
	{ left: true, right: true },
	{ left: true, right: false },
	{ left: true, right: false },
];
const DEFAULT_STATE: FooterManagerState = {
	enabled: true,
	hidden: [],
	order: [...DEFAULT_ORDER],
	layout: cloneLayout(DEFAULT_LAYOUT),
	unplaced: [],
	renderStatusLine: true,
	zenEnabled: false,
};
function cloneLayout(layout: FooterLayoutLine[]): FooterLayoutLine[] {
	return layout.map((line) => ({ left: line.left, right: line.right }));
}

export default function (pi: ExtensionAPI) {
	let state: FooterManagerState = { ...DEFAULT_STATE, order: [...DEFAULT_ORDER], layout: cloneLayout(DEFAULT_LAYOUT), unplaced: [] };
	let footerDataRef: FooterDataRef | undefined;
	let footerApplied = false;
	let requestFooterRender: (() => void) | undefined;

	function formatTokens(value: number): string {
		if (value < 1000) return `${value}`;
		if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
		return `${(value / 1_000_000).toFixed(1)}M`;
	}

	function formatCwd(value: string): string {
		const home = process.env.HOME || process.env.USERPROFILE;
		return home && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
	}

	function isBuiltinKey(key: string): boolean {
		return BUILTIN_KEYS.includes(key as (typeof BUILTIN_KEYS)[number]);
	}

	function isHidden(key: string): boolean {
		return state.hidden.includes(key);
	}

	function isRenderedHidden(key: string): boolean {
		return state.zenEnabled || isHidden(key) || (!state.renderStatusLine && !isBuiltinKey(key));
	}

	function migrateKey(key: string): string {
		switch (key) {
			case "core.cwd":
				return "builtin.cwd";
			case "core.stats":
				return "builtin.stats";
			case "core.model":
				return "builtin.model";
			default:
				return key;
		}
	}

	function uniqueKeys(keys: string[]): string[] {
		return Array.from(new Set(keys.map(migrateKey).filter((item) => item.length > 0)));
	}

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	function readStringArray(value: unknown): string[] | undefined {
		return Array.isArray(value) && value.every((item) => typeof item === "string") ? uniqueKeys(value) : undefined;
	}

	function readOrderArray(value: unknown): FooterOrderItem[] | undefined {
		if (!Array.isArray(value) || !value.every((item) => item === null || typeof item === "string")) return undefined;
		const seen = new Set<string>();
		return value.map((item) => {
			if (item === null || item.length === 0) return null;
			const key = migrateKey(item);
			if (key.length === 0 || seen.has(key)) return null;
			seen.add(key);
			return key;
		});
	}

	function compactOrder(order: FooterOrderItem[]): string[] {
		return uniqueKeys(order.filter((item): item is string => typeof item === "string" && item.length > 0));
	}

	function getLayoutSlots(layout: FooterLayoutLine[]): LayoutSlotRef[] {
		const refs: LayoutSlotRef[] = [];
		for (let lineIndex = 0; lineIndex < layout.length; lineIndex++) {
			for (const side of ["left", "right"] as const) {
				if (layout[lineIndex][side]) refs.push({ lineIndex, side });
			}
		}
		return refs;
	}

	function getSlotPosition(slot: LayoutSlotRef): number {
		return slot.lineIndex * 2 + (slot.side === "right" ? 1 : 0);
	}

	function getLayoutPositionCount(layout: FooterLayoutLine[]): number {
		return layout.length * 2;
	}

	function getActivePositionIndexes(layout: FooterLayoutLine[]): number[] {
		return getLayoutSlots(layout).map(getSlotPosition);
	}

	function normalizeLayout(layout: unknown): { layout: FooterLayoutLine[]; order?: string[] } | undefined {
		if (!Array.isArray(layout)) return undefined;
		const normalized: FooterLayoutLine[] = [];
		const exactLines: { left: string[]; right: string[] }[] = [];
		let exactOrder: string[] | undefined;

		for (const line of layout) {
			if (!isRecord(line)) return undefined;
			if (typeof line.left === "boolean" && typeof line.right === "boolean") {
				normalized.push({ left: line.left, right: line.right });
				continue;
			}
			const left = readStringArray(line.left);
			const right = readStringArray(line.right);
			if (!left || !right) return undefined;
			exactLines.push({ left, right });
		}

		if (exactLines.length > 0) {
			exactOrder = compactOrder(getExactLayoutItems(exactLines).map((item) => item.key));
			return { layout: ensureLayoutPositions(cloneLayout(DEFAULT_LAYOUT), exactOrder.length), order: exactOrder };
		}

		return { layout: normalized };
	}

	function getExactLayoutItems(layout: { left: string[]; right: string[] }[]): LayoutItemRef[] {
		const refs: LayoutItemRef[] = [];
		for (let lineIndex = 0; lineIndex < layout.length; lineIndex++) {
			for (const side of ["left", "right"] as const) {
				for (const key of layout[lineIndex][side]) refs.push({ key, lineIndex, side });
			}
		}
		return refs;
	}

	function ensureLayoutPositions(layout: FooterLayoutLine[], count: number): FooterLayoutLine[] {
		const next = cloneLayout(layout);
		while (getLayoutPositionCount(next) < count) next.push({ left: true, right: false });
		return next;
	}

	function encodeSlotGroups(groups: string[][]): FooterOrderItem[] {
		return groups.flatMap((group, index) => index === 0 ? group : [null, ...group]);
	}

	function decodeGroupedOrder(layout: FooterLayoutLine[], order: FooterOrderItem[]): string[][] {
		const groups = getLayoutSlots(layout).map(() => [] as string[]);
		let slotIndex = 0;
		const seen = new Set<string>();
		for (const item of order) {
			if (item === null) {
				slotIndex += 1;
				continue;
			}
			if (slotIndex >= groups.length || seen.has(item)) continue;
			groups[slotIndex].push(item);
			seen.add(item);
		}
		return groups;
	}

	function orderToSlotGroups(layout: FooterLayoutLine[], order: FooterOrderItem[]): string[][] {
		const slots = getLayoutSlots(layout);
		const activePositions = slots.map(getSlotPosition);
		const groups = slots.map(() => [] as string[]);
		const seen = new Set<string>();
		const add = (slotIndex: number, item: FooterOrderItem | undefined) => {
			if (!item || seen.has(item) || slotIndex >= groups.length) return;
			groups[slotIndex].push(item);
			seen.add(item);
		};
		if (order.some((item) => item === null)) {
			activePositions.forEach((position, slotIndex) => add(slotIndex, order[position]));
			return groups;
		}
		order.forEach((item, index) => add(index, item));
		return groups;
	}

	function getSlotGroups(layout: FooterLayoutLine[], order: FooterOrderItem[], grouped = state.orderMode === "slot-groups"): string[][] {
		return grouped ? decodeGroupedOrder(layout, order) : orderToSlotGroups(layout, order);
	}

	function setSlotGroups(groups: string[][]): void {
		state.order = encodeSlotGroups(groups);
		state.orderMode = "slot-groups";
	}

	function normalizeState(raw: unknown): { state: FooterManagerState; repaired: boolean } {
		const defaultState = { ...DEFAULT_STATE, order: [...DEFAULT_ORDER], layout: cloneLayout(DEFAULT_LAYOUT), unplaced: [] };
		if (raw === undefined) return { state: defaultState, repaired: false };
		if (!isRecord(raw)) return { state: defaultState, repaired: true };

		const data = raw as StoredFooterManagerState;
		let repaired = false;
		const hidden = readStringArray(data.hidden) ?? (data.hidden === undefined ? [] : (repaired = true, []));
		const legacyUnplaced = readStringArray(data.unplaced) ?? (data.unplaced === undefined ? [] : (repaired = true, []));
		const storedOrder = readOrderArray(data.order) ?? (data.order === undefined ? [] : (repaired = true, []));
		const normalizedLayout = normalizeLayout(data.layout);
		const order = normalizedLayout?.order ?? (storedOrder.length > 0 ? storedOrder : [...DEFAULT_ORDER]);
		const migratedOrder = [...order, ...legacyUnplaced.filter((key) => !compactOrder(order).includes(key))];
		const layout = normalizedLayout?.layout ?? ensureLayoutPositions(cloneLayout(DEFAULT_LAYOUT), migratedOrder.length);
		if (!normalizedLayout && data.layout !== undefined) repaired = true;
		if (normalizedLayout?.order || legacyUnplaced.length > 0) repaired = true;

		const hiddenKeys = new Set(hidden);
		const groupedOrder = data.orderMode === "slot-groups";
		const groups = getSlotGroups(layout, migratedOrder, groupedOrder).map((group) => group.filter((item) => !hiddenKeys.has(item)));
		if (!groupedOrder || groups.flat().length !== compactOrder(migratedOrder).filter((item) => !hiddenKeys.has(item)).length) repaired = true;

		return {
			state: {
				enabled: typeof data.enabled === "boolean" ? data.enabled : DEFAULT_STATE.enabled,
				hidden,
				order: encodeSlotGroups(groups),
				orderMode: "slot-groups",
				layout,
				unplaced: [],
				renderStatusLine: typeof data.renderStatusLine === "boolean" ? data.renderStatusLine : DEFAULT_STATE.renderStatusLine,
				zenEnabled: typeof data.zenEnabled === "boolean" ? data.zenEnabled : DEFAULT_STATE.zenEnabled,
			},
			repaired,
		};
	}

	function getSettingsPath(): string {
		const home = process.env.HOME || process.env.USERPROFILE;
		if (!home) throw new Error("Cannot locate home directory for Pi settings");
		return join(home, ".pi", "agent", "settings.json");
	}

	async function readSettings(): Promise<Record<string, unknown>> {
		try {
			return JSON.parse(await readFile(getSettingsPath(), "utf8")) as Record<string, unknown>;
		} catch {
			return {};
		}
	}

	async function saveState(): Promise<void> {
		const settingsPath = getSettingsPath();
		const settings = await readSettings();
		settings[SETTINGS_KEY] = {
			enabled: state.enabled,
			hidden: [...state.hidden],
			order: [...state.order],
			orderMode: state.orderMode,
			layout: cloneLayout(state.layout),
			unplaced: [...state.unplaced],
			renderStatusLine: state.renderStatusLine,
			zenEnabled: state.zenEnabled,
		};
		await mkdir(join(settingsPath, ".."), { recursive: true });
		await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
	}

	async function loadState(): Promise<void> {
		const settings = await readSettings();
		const result = normalizeState(settings[SETTINGS_KEY]);
		state = result.state;
		if (result.repaired) await saveState();
	}

	function buildKnownKeys(statuses?: ReadonlyMap<string, string>): string[] {
		const current = statuses ? Array.from(statuses.keys()) : footerDataRef ? Array.from(footerDataRef.getExtensionStatuses().keys()) : [];
		return uniqueKeys([...BUILTIN_KEYS, ...compactOrder(state.order), ...state.hidden, ...state.unplaced, ...current]);
	}

	function getEffectiveOrder(statuses: ReadonlyMap<string, string>): FooterOrderItem[] {
		const known = new Set([...compactOrder(state.order), ...state.hidden, ...state.unplaced]);
		const newExtensionKeys = Array.from(statuses.keys()).map(migrateKey).filter((key) => !known.has(key));
		const groups = getSlotGroups(state.layout, state.order);
		for (const key of newExtensionKeys) {
			const emptyGroup = groups.find((group) => group.length === 0);
			if (emptyGroup) emptyGroup.push(key);
		}
		return encodeSlotGroups(groups);
	}

	function getEffectiveLayout(_statuses: ReadonlyMap<string, string>): FooterLayoutLine[] {
		return cloneLayout(state.layout);
	}

	function placeKeyAtEnd(key: string): void {
		if (getLayoutSlots(state.layout).length === 0) state.layout = [{ left: true, right: false }];
		const groups = getSlotGroups(state.layout, state.order).map((group) => group.filter((item) => item !== key));
		const targetGroup = groups.at(-1);
		if (!targetGroup) return;
		targetGroup.push(key);
		setSlotGroups(groups);
	}

	function buildFooterSnapshot(ctx: ExtensionContext, footerData: FooterDataRef): FooterSnapshot {
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				const message = entry.message as AssistantMessage;
				totalInput += message.usage.input;
				totalOutput += message.usage.output;
				totalCacheRead += message.usage.cacheRead;
				totalCacheWrite += message.usage.cacheWrite;
				totalCost += message.usage.cost.total;
			}
		}

		let cwd = formatCwd(ctx.sessionManager.getCwd());
		const branch = footerData.getGitBranch();
		if (branch) cwd += ` (${branch})`;
		const sessionName = ctx.sessionManager.getSessionName() ?? "";

		const statsParts: string[] = [];
		if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
		if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
		if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
		if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
		if (totalCost) statsParts.push(`$${totalCost.toFixed(3)}`);

		const contextUsage = ctx.getContextUsage();
		if (contextUsage) {
			statsParts.push(`${contextUsage.percent?.toFixed(1) ?? "?"}%/${formatTokens(contextUsage.contextWindow)}`);
		}

		const modelId = ctx.model?.id || "no-model";
		const providerPrefix = footerData.getAvailableProviderCount() > 1 && ctx.model ? `(${ctx.model.provider}) ` : "";
		return {
			cwd,
			sessionName,
			stats: statsParts.join(" "),
			model: `${providerPrefix}${modelId}`,
		};
	}

	function renderAlignedLine(width: number, left: string, right: string): string {
		if (!left && !right) return "";
		if (!right) return truncateToWidth(left, width, "");
		if (!left) {
			const rightText = truncateToWidth(right, width, "");
			return " ".repeat(Math.max(0, width - visibleWidth(rightText))) + rightText;
		}

		const leftWidth = visibleWidth(left);
		const rightWidth = visibleWidth(right);
		const spacing = Math.max(1, width - leftWidth - rightWidth);
		return leftWidth + rightWidth + 1 <= width ? left + " ".repeat(spacing) + right : truncateToWidth(left, width, "");
	}

	function applyFooter(ctx: ExtensionContext): void {
		if (!state.enabled) {
			ctx.ui.setFooter(undefined);
			footerApplied = false;
			requestFooterRender = undefined;
			return;
		}

		if (footerApplied) {
			requestFooterRender?.();
			return;
		}

		footerApplied = true;
		ctx.ui.setFooter((tui, theme, footerData) => {
			footerDataRef = footerData;
			requestFooterRender = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					unsubscribe();
					footerApplied = false;
					requestFooterRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const snapshot = buildFooterSnapshot(ctx, footerData);
					return renderFooterLines(width, snapshot, footerData.getExtensionStatuses(), theme);
				},
			};
		});
	}

	function getItemText(key: string, snapshot: FooterSnapshot, statuses: ReadonlyMap<string, string>): string | undefined {
		switch (key) {
			case "builtin.cwd":
				return snapshot.cwd;
			case "builtin.session":
				return snapshot.sessionName;
			case "builtin.stats":
				return snapshot.stats;
			case "builtin.model":
				return snapshot.model;
			default:
				return statuses.get(key);
		}
	}

	function getVisibleItemText(key: FooterOrderItem | undefined, snapshot: FooterSnapshot, statuses: ReadonlyMap<string, string>): string {
		if (!key || isRenderedHidden(key)) return "";
		return getItemText(key, snapshot, statuses) ?? "";
	}

	function getVisibleItemTexts(keys: FooterOrderItem[], snapshot: FooterSnapshot, statuses: ReadonlyMap<string, string>): string {
		return keys.map((key) => getVisibleItemText(key, snapshot, statuses)).filter(Boolean).join(" • ");
	}

	function getLayoutItems(layout: FooterLayoutLine[], order: FooterOrderItem[]): LayoutItemRef[] {
		const slots = getLayoutSlots(layout);
		const groups = getSlotGroups(layout, order, true);
		return slots.flatMap((slot, slotIndex) => groups[slotIndex].map((key) => ({ ...slot, key })));
	}

	function renderFooterLines(width: number, snapshot: FooterSnapshot, statuses: ReadonlyMap<string, string>, theme: FooterTheme): string[] {
		const layout = getEffectiveLayout(statuses);
		const items = getLayoutItems(layout, getEffectiveOrder(statuses));
		return layout
			.map((line, lineIndex) => {
				const leftKeys = items.filter((item) => item.lineIndex === lineIndex && item.side === "left").map((item) => item.key);
				const rightKeys = items.filter((item) => item.lineIndex === lineIndex && item.side === "right").map((item) => item.key);
				return renderAlignedLine(width, getVisibleItemTexts(leftKeys, snapshot, statuses), getVisibleItemTexts(rightKeys, snapshot, statuses));
			})
			.filter((line) => line.length > 0)
			.map((line) => theme.fg("dim", truncateToWidth(line, width, theme.fg("dim", "..."))));
	}

	function buildUiKeys(): string[] {
		const statuses = footerDataRef?.getExtensionStatuses() ?? new Map<string, string>();
		const ordered = compactOrder(getEffectiveOrder(statuses));
		const visible = ordered.filter((key) => !isHidden(key));
		const hidden = uniqueKeys([...ordered.filter((key) => isHidden(key)), ...state.hidden]);
		return uniqueKeys([...visible, ...hidden]);
	}

	function toggleFooterKey(key: string): boolean | undefined {
		const normalizedKey = migrateKey(key);
		const knownKeys = buildKnownKeys();
		if (!knownKeys.includes(normalizedKey)) return undefined;

		const nextHidden = !isHidden(normalizedKey);
		state.hidden = nextHidden
			? uniqueKeys([...state.hidden, normalizedKey])
			: state.hidden.filter((item) => item !== normalizedKey);

		if (nextHidden) setSlotGroups(getSlotGroups(state.layout, state.order).map((group) => group.filter((item) => item !== normalizedKey)));
		if (!nextHidden) {
			if (!compactOrder(state.order).includes(normalizedKey)) placeKeyAtEnd(normalizedKey);
			if (!isBuiltinKey(normalizedKey)) state.renderStatusLine = true;
		}

		return !nextHidden;
	}

	function getCommandCompletions(argumentPrefix: string): AutocompleteItem[] | null {
		const staticItems: AutocompleteItem[] = [
			{ value: "on", label: "on", description: "Enable the managed footer" },
			{ value: "off", label: "off", description: "Disable the managed footer" },
			{ value: "reset", label: "reset", description: "Reset footer-manager layout settings" },
			{ value: "layout", label: "layout", description: "Edit footer layout as text" },
			{ value: "edit", label: "edit", description: "Edit footer layout as text" },
			{ value: "status-line on", label: "status-line on", description: "Render visible extension status items" },
			{ value: "status-line off", label: "status-line off", description: "Hide extension status items" },
			{ value: "zen", label: "zen", description: "Toggle hiding all built-in and extension footer items" },
			{ value: "zen on", label: "zen on", description: "Hide all footer items" },
			{ value: "zen off", label: "zen off", description: "Restore normal footer rendering" },
		];
		const keyItems: AutocompleteItem[] = buildKnownKeys().map((key) => ({
			value: `ext ${key}`,
			label: `ext ${key}`,
			description: isHidden(key) ? "Show this footer item" : "Hide this footer item",
		}));
		const prefix = argumentPrefix.toLowerCase();
		const items = [...staticItems, ...keyItems].filter((item) => item.value.toLowerCase().startsWith(prefix));
		return items.length > 0 ? items : null;
	}

	function serializeLayout(layout: FooterLayoutLine[]): string {
		return layout.map((line) => line.left && line.right ? "x x" : line.left ? "x" : line.right ? "  x" : "").join("\n");
	}

	function parseLayoutText(text: string): FooterLayoutLine[] {
		return text.split(/\r?\n/).map((rawLine, lineIndex) => {
			if (!/^[\sxX]*$/.test(rawLine)) throw new Error(`Line ${lineIndex + 1}: use only x placeholders and spaces`);
			const xPositions = [...rawLine.matchAll(/[xX]/g)].map((match) => match.index ?? 0);
			if (xPositions.length > 2) throw new Error(`Line ${lineIndex + 1}: use at most two x placeholders`);
			const first = xPositions[0];
			const second = xPositions[1];
			return {
				left: first === 0,
				right: (first !== undefined && first > 0) || second !== undefined,
			};
		});
	}

	function applyLayout(nextLayout: FooterLayoutLine[], currentOrder: FooterOrderItem[]): void {
		const currentGroups = getSlotGroups(state.layout, currentOrder, true);
		const nextSlotCount = getLayoutSlots(nextLayout).length;
		const nextGroups = currentGroups.slice(0, nextSlotCount);
		while (nextGroups.length < nextSlotCount) nextGroups.push([]);
		const removed = currentGroups.slice(nextSlotCount).flat();
		state.layout = cloneLayout(nextLayout);
		setSlotGroups(nextGroups);
		state.hidden = uniqueKeys([...state.hidden, ...removed]);
		state.unplaced = [];
	}

	async function openLayoutEditor(ctx: ExtensionContext): Promise<void> {
		const statuses = footerDataRef?.getExtensionStatuses() ?? new Map<string, string>();
		const currentLayout = getEffectiveLayout(statuses);
		const currentOrder = getEffectiveOrder(statuses);
		let draft = serializeLayout(currentLayout);
		while (true) {
			const edited = await ctx.ui.editor("Edit footer layout shape (x x / x /   x)", draft);
			if (edited === undefined) return;
			try {
				applyLayout(parseLayoutText(edited), currentOrder);
				await saveState();
				requestFooterRender?.();
				ctx.ui.notify("footer-manager layout updated", "info");
				return;
			} catch (error) {
				draft = edited;
				ctx.ui.notify(error instanceof Error ? error.message : "Invalid footer layout", "error");
			}
		}
	}

	async function openManager(ctx: ExtensionContext): Promise<void> {
		await ctx.ui.custom((tui, theme, _kb, done) => {
			const FLASH_INTERVAL_MS = 110;
			const FLASH_FRAME_COUNT = 4;
			let keys = buildUiKeys();
			let selectedIndex = 0;
			let flashKey: string | undefined;
			let flashFrame = 0;
			let flashTimer: ReturnType<typeof setTimeout> | undefined;

			const ensureKeys = () => {
				keys = buildUiKeys();
				if (selectedIndex >= keys.length) selectedIndex = Math.max(0, keys.length - 1);
			};

			const fit = (text: string, contentWidth: number): string => {
				const truncated = truncateToWidth(text, contentWidth, theme.fg("dim", "..."));
				return truncated + " ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)));
			};

			const frameLine = (text: string, width: number): string => `│ ${fit(text, Math.max(1, width - 4))} │`;
			const frameSplitLine = (left: string, right: string, width: number): string => {
				const contentWidth = Math.max(1, width - 4);
				const rightText = truncateToWidth(right, contentWidth, theme.fg("dim", "..."));
				const rightWidth = visibleWidth(rightText);
				const maxLeftWidth = Math.max(1, contentWidth - rightWidth - 1);
				const leftText = truncateToWidth(left, maxLeftWidth, theme.fg("dim", "..."));
				const gap = " ".repeat(Math.max(1, contentWidth - visibleWidth(leftText) - rightWidth));
				return `│ ${leftText}${gap}${rightText} │`;
			};
			const border = (left: string, fill: string, right: string, width: number): string =>
				left + fill.repeat(Math.max(0, width - 2)) + right;
			const sectionBorder = (title: string, width: number): string => {
				const plainTitle = ` ${title} `;
				const fill = Math.max(0, width - 2 - plainTitle.length);
				return `├${plainTitle}${"─".repeat(fill)}┤`;
			};

			const persistAndRefresh = async () => {
				await saveState();
				requestFooterRender?.();
				tui.requestRender();
			};

			const clearFlashTimer = () => {
				if (flashTimer) clearTimeout(flashTimer);
				flashTimer = undefined;
			};

			const scheduleFlashTick = () => {
				clearFlashTimer();
				flashTimer = setTimeout(() => {
					flashFrame += 1;
					if (flashFrame >= FLASH_FRAME_COUNT) flashKey = undefined;
					tui.requestRender();
					if (flashKey) scheduleFlashTick();
				}, FLASH_INTERVAL_MS);
			};

			const flashLocation = (key: string) => {
				flashKey = key;
				flashFrame = 0;
				tui.requestRender();
				scheduleFlashTick();
			};

			const toggleKey = async () => {
				const key = keys[selectedIndex];
				if (!key) return;
				const wasHidden = isHidden(key);
				const enabled = toggleFooterKey(key);
				ensureKeys();
				selectedIndex = keys.indexOf(key);
				if (enabled && wasHidden) flashLocation(key);
				await persistAndRefresh();
			};

			const moveSelected = async (direction: -1 | 1) => {
				const key = keys[selectedIndex];
				if (!key) return;
				const statuses = footerDataRef?.getExtensionStatuses() ?? new Map<string, string>();
				const layout = getEffectiveLayout(statuses);
				const groups = getSlotGroups(layout, getEffectiveOrder(statuses), true);
				const slotIndex = groups.findIndex((group) => group.includes(key));
				const itemIndex = slotIndex === -1 ? -1 : groups[slotIndex].indexOf(key);
				if (slotIndex === -1 || itemIndex === -1) {
					placeKeyAtEnd(key);
					ensureKeys();
					selectedIndex = keys.indexOf(key);
					flashLocation(key);
					await persistAndRefresh();
					return;
				}
				if (direction < 0) {
					if (itemIndex > 0) {
						[groups[slotIndex][itemIndex - 1], groups[slotIndex][itemIndex]] = [groups[slotIndex][itemIndex], groups[slotIndex][itemIndex - 1]];
					} else if (slotIndex > 0) {
						groups[slotIndex].splice(itemIndex, 1);
						groups[slotIndex - 1].push(key);
					} else return;
				} else {
					if (itemIndex < groups[slotIndex].length - 1) {
						[groups[slotIndex][itemIndex], groups[slotIndex][itemIndex + 1]] = [groups[slotIndex][itemIndex + 1], groups[slotIndex][itemIndex]];
					} else if (slotIndex < groups.length - 1) {
						groups[slotIndex].splice(itemIndex, 1);
						groups[slotIndex + 1].unshift(key);
					} else return;
				}
				state.layout = layout;
				setSlotGroups(groups);
				ensureKeys();
				selectedIndex = keys.indexOf(key);
				flashLocation(key);
				await persistAndRefresh();
			};

			const toggleManagedStatusLine = async () => {
				state.renderStatusLine = !state.renderStatusLine;
				await persistAndRefresh();
			};

			const reset = async () => {
				state = { ...DEFAULT_STATE, enabled: state.enabled, order: [...DEFAULT_ORDER], layout: cloneLayout(DEFAULT_LAYOUT), unplaced: [] };
				setSlotGroups(orderToSlotGroups(state.layout, state.order));
				ensureKeys();
				await persistAndRefresh();
			};

			return {
				render(width: number): string[] {
					ensureKeys();
					const safeWidth = width;
					const statuses = footerDataRef?.getExtensionStatuses() ?? new Map<string, string>();
					const selectedKey = keys[selectedIndex];
					const selectedPosition = selectedKey ? keys.indexOf(selectedKey) + 1 : 0;
					const selectedHidden = selectedKey ? isRenderedHidden(selectedKey) : false;
					const selectedState = state.zenEnabled
						? theme.fg("warning", "hidden by zen")
						: selectedHidden
							? theme.fg("warning", "hidden")
							: theme.fg("success", "visible");
					const snapshot = footerDataRef ? buildFooterSnapshot(ctx, footerDataRef) : undefined;
					const visibleCount = keys.filter((key) => !isRenderedHidden(key)).length;
					const hiddenCount = keys.length - visibleCount;
					const unplacedCount = state.unplaced.length;

					const lines = [
						border("┌", "─", "┐", safeWidth),
						frameLine(theme.fg("accent", theme.bold("Footer manager")), safeWidth),
						frameLine(
							state.enabled
								? `${theme.fg("success", "managed footer enabled")} ${state.zenEnabled ? theme.fg("warning", "• zen active ") : ""}${theme.fg("dim", `• ${visibleCount} visible • ${hiddenCount} hidden • ${unplacedCount} unplaced`)}`
								: `${theme.fg("warning", "managed footer disabled")} ${theme.fg("dim", "• /footer-manager on to enable")}`,
							safeWidth,
						),
						sectionBorder("Layout items", safeWidth),
					];

					if (keys.length === 0) {
						lines.push(frameLine(theme.fg("warning", "No placed footer items. Press e to edit layout."), safeWidth));
					} else {
						const refs = getLayoutItems(getEffectiveLayout(statuses), getEffectiveOrder(statuses));
						for (let index = 0; index < keys.length; index++) {
							const key = keys[index];
							const ref = refs.find((item) => item.key === key);
							const isSelected = index === selectedIndex;
							const marker = isSelected ? theme.fg("accent", "›") : theme.fg("dim", " ");
							const badge = isRenderedHidden(key) ? theme.fg("warning", state.zenEnabled ? "ZEN" : "OFF") : theme.fg("success", " ON");
							const source = isBuiltinKey(key) ? theme.fg("accent", "built-in") : theme.fg("dim", "ext");
							const layoutInfo = isHidden(key) ? "unknown" : ref ? `line ${ref.lineIndex + 1} ${ref.side}` : "unplaced";
							const isFlashing = flashKey === key && flashFrame % 2 === 0;
							const side = isFlashing ? theme.fg("warning", theme.bold(layoutInfo)) : isSelected ? layoutInfo : theme.fg("dim", layoutInfo);
							const preview = snapshot ? getItemText(key, snapshot, statuses) : undefined;
							const keyLabel = isSelected ? theme.fg("accent", theme.bold(key)) : key;
							lines.push(frameSplitLine(`${marker} [${badge}] [${source}] ${keyLabel}`, side, safeWidth));
							lines.push(frameLine(`    ${preview ?? theme.fg("dim", "(no current text)")}`, safeWidth));
						}
					}

					lines.push(sectionBorder("Details", safeWidth));
					if (!selectedKey) {
						lines.push(frameLine(theme.fg("dim", "Select a footer item to inspect it."), safeWidth));
					} else {
						lines.push(frameLine(`Key: ${theme.bold(selectedKey)} ${theme.fg("dim", `• ${isBuiltinKey(selectedKey) ? "built-in" : "extension"}`)}`, safeWidth));
						lines.push(frameLine(`State: ${selectedState} ${theme.fg("dim", `• reading position ${selectedPosition} of ${keys.length}`)}`, safeWidth));
						lines.push(frameLine(`Move: ${theme.fg("dim", "u/d moves through reading order")}`, safeWidth));
					}

					lines.push(sectionBorder("Controls", safeWidth));
					lines.push(frameLine(theme.fg("dim", "↑↓/j/k select  •  space/enter toggle  •  u/d move item"), safeWidth));
					lines.push(frameLine(theme.fg("dim", "e edit layout  •  s status items  •  r reset  •  esc close"), safeWidth));
					lines.push(border("└", "─", "┘", safeWidth));

					return lines.map((line) => truncateToWidth(line, width, theme.fg("dim", "...")));
				},
				invalidate() {},
				handleInput(data: string) {
					if ((matchesKey(data, Key.up) || data === "k") && selectedIndex > 0) {
						selectedIndex -= 1;
						tui.requestRender();
						return;
					}
					if ((matchesKey(data, Key.down) || data === "j") && selectedIndex < keys.length - 1) {
						selectedIndex += 1;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.space) || matchesKey(data, Key.enter)) {
						void toggleKey();
						return;
					}
					if (data === "u") {
						void moveSelected(-1);
						return;
					}
					if (data === "d") {
						void moveSelected(1);
						return;
					}
					if (data === "e") {
						clearFlashTimer();
						done(undefined);
						void (async () => {
							await openLayoutEditor(ctx);
							await openManager(ctx);
						})();
						return;
					}
					if (data === "s") {
						void toggleManagedStatusLine();
						return;
					}
					if (data === "r") {
						void reset();
						return;
					}
					if (matchesKey(data, Key.escape)) {
						clearFlashTimer();
						done(undefined);
					}
				},
			};
		}, { overlay: true });
	}

	pi.registerCommand("footer-manager", {
		description: "Manage footer built-in items and extension status items. Usage: /footer-manager [on|off|reset|layout|zen|ext <key>|status-line on|status-line off]",
		getArgumentCompletions: getCommandCompletions,
		handler: async (args, ctx) => {
			const raw = args.trim();
			const command = raw.toLowerCase();

			if (command === "on") {
				state.enabled = true;
				await saveState();
				applyFooter(ctx);
				ctx.ui.notify("footer-manager enabled", "info");
				return;
			}

			if (command === "off") {
				state.enabled = false;
				await saveState();
				applyFooter(ctx);
				ctx.ui.notify("footer-manager disabled", "info");
				return;
			}

			if (command === "reset") {
				state = { ...DEFAULT_STATE, enabled: state.enabled, order: [...DEFAULT_ORDER], layout: cloneLayout(DEFAULT_LAYOUT), unplaced: [] };
				setSlotGroups(orderToSlotGroups(state.layout, state.order));
				await saveState();
				applyFooter(ctx);
				ctx.ui.notify("footer-manager layout reset", "info");
				return;
			}

			if (command === "layout" || command === "edit" || command === "layout edit") {
				applyFooter(ctx);
				await openLayoutEditor(ctx);
				return;
			}

			if (command === "status-line on") {
				state.renderStatusLine = true;
				await saveState();
				applyFooter(ctx);
				ctx.ui.notify("footer-manager extension status items enabled", "info");
				return;
			}

			if (command === "status-line off") {
				state.renderStatusLine = false;
				await saveState();
				applyFooter(ctx);
				ctx.ui.notify("footer-manager extension status items hidden", "info");
				return;
			}

			if (command === "zen" || command === "zen toggle") {
				state.zenEnabled = !state.zenEnabled;
				await saveState();
				applyFooter(ctx);
				ctx.ui.notify(`footer-manager zen ${state.zenEnabled ? "enabled" : "disabled"}`, "info");
				return;
			}

			if (command === "zen on" || command === "zen off") {
				state.zenEnabled = command === "zen on";
				await saveState();
				applyFooter(ctx);
				ctx.ui.notify(`footer-manager zen ${state.zenEnabled ? "enabled" : "disabled"}`, "info");
				return;
			}

			const extMatch = raw.match(/^ext\s+(\S+)$/i);
			if (extMatch) {
				const key = migrateKey(extMatch[1]);
				const visible = toggleFooterKey(key);
				if (visible === undefined) {
					ctx.ui.notify(`footer-manager does not know key: ${key}`, "warning");
					return;
				}
				await saveState();
				applyFooter(ctx);
				ctx.ui.notify(`footer-manager ${key} ${visible ? "visible" : "hidden"}`, "info");
				return;
			}

			applyFooter(ctx);
			await openManager(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		footerDataRef = undefined;
		footerApplied = false;
		requestFooterRender = undefined;
		await loadState();
		applyFooter(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await loadState();
		applyFooter(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		footerDataRef = undefined;
		footerApplied = false;
		requestFooterRender = undefined;
		if (!state.enabled) {
			ctx.ui.setFooter(undefined);
		}
	});
}
