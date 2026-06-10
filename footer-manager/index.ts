import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Key, matchesKey, truncateToWidth, visibleWidth, type AutocompleteItem } from "@earendil-works/pi-tui";

type FooterManagerState = {
	enabled: boolean;
	hidden: string[];
	order: string[];
	renderStatusLine: boolean;
	zenEnabled: boolean;
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
	statsLeft: string;
	modelRight: string;
	visibleStatusTexts: string[];
};

const SETTINGS_KEY = "footerManager";
const BUILTIN_KEYS = ["builtin.cwd", "builtin.session", "builtin.stats", "builtin.model"] as const;
const DEFAULT_STATE: FooterManagerState = {
	enabled: true,
	hidden: [],
	order: [],
	renderStatusLine: true,
	zenEnabled: false,
};

export default function (pi: ExtensionAPI) {
	let state: FooterManagerState = { ...DEFAULT_STATE };
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
		return state.zenEnabled || isHidden(key);
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

	function migrateKeys(keys: string[]): string[] {
		return Array.from(new Set(keys.map(migrateKey)));
	}

	function normalizeState(data: Partial<FooterManagerState> | undefined): FooterManagerState {
		return {
			enabled: typeof data?.enabled === "boolean" ? data.enabled : DEFAULT_STATE.enabled,
			hidden: migrateKeys(Array.isArray(data?.hidden) ? data.hidden.filter((item): item is string => typeof item === "string") : []),
			order: migrateKeys(Array.isArray(data?.order) ? data.order.filter((item): item is string => typeof item === "string") : []).filter((key) => !isBuiltinKey(key)),
			renderStatusLine: typeof data?.renderStatusLine === "boolean" ? data.renderStatusLine : DEFAULT_STATE.renderStatusLine,
			zenEnabled: typeof data?.zenEnabled === "boolean" ? data.zenEnabled : DEFAULT_STATE.zenEnabled,
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
			renderStatusLine: state.renderStatusLine,
			zenEnabled: state.zenEnabled,
		};
		await mkdir(join(settingsPath, ".."), { recursive: true });
		await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
	}

	async function loadState(): Promise<void> {
		const settings = await readSettings();
		state = normalizeState(settings[SETTINGS_KEY] as Partial<FooterManagerState> | undefined);
	}

	function getOrderedExtensionKeys(allKeys: string[]): string[] {
		const extensions = allKeys.filter((key) => !isBuiltinKey(key));
		const known = new Set(extensions);
		const ordered = state.order.filter((key) => known.has(key));
		const rest = extensions.filter((key) => !ordered.includes(key)).sort((a, b) => a.localeCompare(b));
		return [...ordered, ...rest];
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
		const modelRight = `${providerPrefix}${modelId}`;
		const statuses = footerData.getExtensionStatuses();
		const visibleStatusTexts = getOrderedExtensionKeys(Array.from(statuses.keys()))
			.filter((key) => !isRenderedHidden(key))
			.map((key) => statuses.get(key))
			.filter((text): text is string => typeof text === "string" && text.length > 0);

		return {
			cwd,
			sessionName,
			statsLeft: statsParts.join(" "),
			modelRight,
			visibleStatusTexts,
		};
	}

	function renderStatsLine(width: number, left: string, right: string): string {
		if (!left && !right) return "";
		if (!left) return truncateToWidth(right, width, "");
		if (!right) return truncateToWidth(left, width, "");

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
					const lines: string[] = [];

					const locationParts = [
						!isRenderedHidden("builtin.cwd") ? snapshot.cwd : undefined,
						!isRenderedHidden("builtin.session") ? snapshot.sessionName : undefined,
					].filter((part): part is string => typeof part === "string" && part.length > 0);
					if (locationParts.length > 0) {
						lines.push(truncateToWidth(theme.fg("dim", locationParts.join(" • ")), width, theme.fg("dim", "...")));
					}

					const statsLeft = isRenderedHidden("builtin.stats") ? "" : snapshot.statsLeft;
					const modelRight = isRenderedHidden("builtin.model") ? "" : snapshot.modelRight;
					const statsLine = renderStatsLine(width, statsLeft, modelRight);
					if (statsLine) {
						lines.push(theme.fg("dim", statsLine));
					}

					if (!state.zenEnabled && state.renderStatusLine && snapshot.visibleStatusTexts.length > 0) {
						lines.push(truncateToWidth(snapshot.visibleStatusTexts.join(" "), width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	}

	function moveItem(list: string[], from: number, to: number): string[] {
		if (from < 0 || from >= list.length || to < 0 || to >= list.length) return list;
		const next = [...list];
		const [item] = next.splice(from, 1);
		next.splice(to, 0, item);
		return next;
	}

	function buildUiKeys(): string[] {
		const current = footerDataRef ? Array.from(footerDataRef.getExtensionStatuses().keys()) : [];
		const merged = new Set([...state.order, ...state.hidden, ...current]);
		return [...BUILTIN_KEYS, ...getOrderedExtensionKeys(Array.from(merged))];
	}

	function toggleFooterKey(key: string): boolean | undefined {
		const normalizedKey = migrateKey(key);
		const knownKeys = buildUiKeys();
		if (!knownKeys.includes(normalizedKey)) return undefined;

		const nextHidden = !isHidden(normalizedKey);
		state.hidden = nextHidden
			? Array.from(new Set([...state.hidden, normalizedKey]))
			: state.hidden.filter((item) => item !== normalizedKey);

		if (!nextHidden && !isBuiltinKey(normalizedKey)) {
			state.renderStatusLine = true;
		}

		return !nextHidden;
	}

	function getCommandCompletions(argumentPrefix: string): AutocompleteItem[] | null {
		const staticItems: AutocompleteItem[] = [
			{ value: "on", label: "on", description: "Enable the managed footer" },
			{ value: "off", label: "off", description: "Disable the managed footer" },
			{ value: "reset", label: "reset", description: "Reset footer-manager layout settings" },
			{ value: "status-line on", label: "status-line on", description: "Render visible extension status items" },
			{ value: "status-line off", label: "status-line off", description: "Hide the extension status line" },
			{ value: "zen", label: "zen", description: "Toggle hiding all built-in and extension footer items" },
			{ value: "zen on", label: "zen on", description: "Hide all footer items" },
			{ value: "zen off", label: "zen off", description: "Restore normal footer rendering" },
		];
		const keyItems: AutocompleteItem[] = buildUiKeys().map((key) => ({
			value: `ext ${key}`,
			label: `ext ${key}`,
			description: isHidden(key) ? "Show this footer item" : "Hide this footer item",
		}));
		const prefix = argumentPrefix.toLowerCase();
		const items = [...staticItems, ...keyItems].filter((item) => item.value.toLowerCase().startsWith(prefix));
		return items.length > 0 ? items : null;
	}

	async function openManager(ctx: ExtensionContext): Promise<void> {
		await ctx.ui.custom((tui, theme, _kb, done) => {
			let keys = buildUiKeys();
			let selectedIndex = 0;

			const ensureKeys = () => {
				keys = buildUiKeys();
				if (selectedIndex >= keys.length) selectedIndex = Math.max(0, keys.length - 1);
			};

			const fit = (text: string, contentWidth: number): string => {
				const truncated = truncateToWidth(text, contentWidth, theme.fg("dim", "..."));
				return truncated + " ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)));
			};

			const frameLine = (text: string, width: number): string => `│ ${fit(text, Math.max(1, width - 4))} │`;
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

			const toggleKey = async () => {
				const key = keys[selectedIndex];
				if (!key) return;
				toggleFooterKey(key);
				await persistAndRefresh();
			};

			const moveSelected = async (direction: -1 | 1) => {
				const key = keys[selectedIndex];
				if (!key || isBuiltinKey(key)) return;
				const movable = buildUiKeys().filter((item) => !isBuiltinKey(item));
				const currentIndex = movable.indexOf(key);
				const nextIndex = currentIndex + direction;
				if (currentIndex === -1 || nextIndex < 0 || nextIndex >= movable.length) return;
				state.order = moveItem(movable, currentIndex, nextIndex);
				ensureKeys();
				selectedIndex = keys.indexOf(key);
				await persistAndRefresh();
			};

			const toggleManagedStatusLine = async () => {
				state.renderStatusLine = !state.renderStatusLine;
				await persistAndRefresh();
			};

			const reset = async () => {
				state = { ...DEFAULT_STATE, enabled: state.enabled };
				ensureKeys();
				await persistAndRefresh();
			};

			return {
				render(width: number): string[] {
					ensureKeys();
					const safeWidth = width;
					const statuses = footerDataRef?.getExtensionStatuses();
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

					const lines = [
						border("┌", "─", "┐", safeWidth),
						frameLine(theme.fg("accent", theme.bold("Footer manager")), safeWidth),
						frameLine(
							state.enabled
								? `${theme.fg("success", "managed footer enabled")} ${state.zenEnabled ? theme.fg("warning", "• zen active ") : ""}${theme.fg("dim", `• ${visibleCount} visible • ${hiddenCount} hidden`)}`
								: `${theme.fg("warning", "managed footer disabled")} ${theme.fg("dim", "• /footer-manager on to enable")}`,
							safeWidth,
						),
						sectionBorder("Items", safeWidth),
					];

					if (keys.length === 0) {
						lines.push(frameLine(theme.fg("warning", "No footer items detected yet."), safeWidth));
					} else {
						for (let index = 0; index < keys.length; index++) {
							const key = keys[index];
							const isSelected = index === selectedIndex;
							const marker = isSelected ? theme.fg("accent", "›") : theme.fg("dim", " ");
							const badge = isRenderedHidden(key) ? theme.fg("warning", state.zenEnabled ? "ZEN" : "OFF") : theme.fg("success", " ON");
							const source = isBuiltinKey(key) ? theme.fg("accent", "built-in") : theme.fg("dim", "ext");
							const preview = key === "builtin.cwd"
								? snapshot?.cwd
								: key === "builtin.session"
									? snapshot?.sessionName
									: key === "builtin.stats"
										? snapshot?.statsLeft
										: key === "builtin.model"
											? snapshot?.modelRight
											: statuses?.get(key);
							const keyLabel = isSelected ? theme.fg("accent", theme.bold(key)) : key;
							lines.push(frameLine(`${marker} [${badge}] [${source}] ${keyLabel}`, safeWidth));
							lines.push(frameLine(`    ${preview ?? theme.fg("dim", "(no current text)")}`, safeWidth));
						}
					}

					lines.push(sectionBorder("Details", safeWidth));
					if (!selectedKey) {
						lines.push(frameLine(theme.fg("dim", "Select a footer item to inspect it."), safeWidth));
					} else {
						lines.push(frameLine(`Key: ${theme.bold(selectedKey)} ${theme.fg("dim", `• ${isBuiltinKey(selectedKey) ? "built-in" : "extension"}`)}`, safeWidth));
						lines.push(frameLine(`State: ${selectedState} ${theme.fg("dim", `• list position ${selectedPosition} of ${keys.length}`)}`, safeWidth));
						lines.push(frameLine(`Move: ${isBuiltinKey(selectedKey) ? theme.fg("dim", "fixed built-in position") : theme.fg("dim", "u/d reorders extension statuses")}`, safeWidth));
					}

					lines.push(sectionBorder("Controls", safeWidth));
					lines.push(frameLine(theme.fg("dim", "↑↓ select  •  space/enter toggle  •  u/d move ext item"), safeWidth));
					lines.push(frameLine(theme.fg("dim", "r reset  •  esc close"), safeWidth));
					lines.push(border("└", "─", "┘", safeWidth));

					return lines.map((line) => truncateToWidth(line, width, theme.fg("dim", "...")));
				},
				invalidate() {},
				handleInput(data: string) {
					if (matchesKey(data, Key.up) && selectedIndex > 0) {
						selectedIndex -= 1;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.down) && selectedIndex < keys.length - 1) {
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
					if (data === "s") {
						void toggleManagedStatusLine();
						return;
					}
					if (data === "r") {
						void reset();
						return;
					}
					if (matchesKey(data, Key.escape)) {
						done(undefined);
					}
				},
			};
		}, { overlay: true });
	}

	pi.registerCommand("footer-manager", {
		description: "Manage footer built-in items and extension status items. Usage: /footer-manager [on|off|reset|zen|ext <key>|status-line on|status-line off]",
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
				state = { ...DEFAULT_STATE, enabled: state.enabled };
				await saveState();
				applyFooter(ctx);
				ctx.ui.notify("footer-manager layout reset", "info");
				return;
			}

			if (command === "status-line on") {
				state.renderStatusLine = true;
				await saveState();
				applyFooter(ctx);
				ctx.ui.notify("footer-manager extension status line enabled", "info");
				return;
			}

			if (command === "status-line off") {
				state.renderStatusLine = false;
				await saveState();
				applyFooter(ctx);
				ctx.ui.notify("footer-manager extension status line disabled", "info");
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
