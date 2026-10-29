import { watch, type FSWatcher } from "node:fs";
import { type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { matchesKey, wrapTextWithAnsi, truncateToWidth } from "@earendil-works/pi-tui";
import { CONFIG_PATH, initializeConfig, loadConfig, parseConfig, requireOptIn, saveConfig, type Config } from "./config.ts";
import { transcriptEntries } from "./evidence.ts";
import { projectPath, projectRoot, readProjectFile } from "./files.ts";
import { IdleReviewer } from "./lifecycle.ts";
import { ReviewPanel, safeText, type ReviewAction } from "./panel.ts";
import { analyze, effectivePrompt } from "./reviewer.ts";
import { decideSuggestion, listSuggestions, type Suggestion } from "./store.ts";
import { refreshSuggestion, suggestionIsStale } from "./refresh.ts";
import { calibrate, calibrationDue } from "./calibration.ts";
import { addComment, applyBatch, createBatch, discardBatch, draftState, listBatches, readBatch, removeSource, resolveSources, resumeApply, type Batch } from "./batch.ts";
import { BatchPanel, type BatchAction } from "./batch-panel.ts";
import { integrateBatch } from "./integrate.ts";

export default function idleLearn(pi: ExtensionAPI, reviewEvidence: typeof analyze = analyze, calibrateEvidence: typeof calibrate = calibrate, refreshEvidence: typeof refreshSuggestion = refreshSuggestion, integrateEvidence: typeof integrateBatch = integrateBatch): void {
	let context: ExtensionContext | undefined;
	let root: string | undefined;
	let watcher: FSWatcher | undefined;
	let configSnapshot = "";
	/** Foreground model work started from the review screen: diff refresh or batch integration. */
	let modalController: AbortController | undefined;
	async function cancelReviews(reason?: string) {
		modalController?.abort(new Error(reason ?? "Cancelled."));
		await reviewer.cancel(reason);
	}
	const reviewer = new IdleReviewer(refresh, (input) => input.purpose === "calibration" ? calibrateEvidence(input) : reviewEvidence(input));
	function refresh() {
		if (!context || !root || !context.hasUI) return;
		const config = loadConfig(root);
		if (config.status === "missing") { context.ui.setStatus("idle-learn", undefined); return; }
		let pending = 0;
		try { pending = listSuggestions(root).length; } catch {}
		const label = config.status === "invalid" ? "config error" : !config.enabled ? "paused" : reviewer.running ? reviewer.status : `${pending} pending${reviewer.remaining ? `; ${reviewer.remaining} entries left` : ""}`;
		context.ui.setStatus("idle-learn", safeText(`Idle Learn: ${label}${reviewer.status.startsWith("Error:") ? " (error; /idle-learn)" : ""}`));
	}
	function observeConfig() {
		watcher?.close(); watcher = undefined;
		if (!root || loadConfig(root).status === "missing") return;
		try {
			configSnapshot = JSON.stringify(loadConfig(root));
			watcher = watch(projectPath(root, ".pi/idle-learn"), (_event, filename) => {
				if (filename?.toString() !== "config.toml" || !root) return;
				const next = JSON.stringify(loadConfig(root));
				if (next !== configSnapshot) {
					configSnapshot = next;
					void cancelReviews("project configuration changed").then(() => { refresh(); if (context) scheduleCalibration(context); });
				}
			});
			watcher.unref();
			watcher.on("error", () => { watcher?.close(); watcher = undefined; });
		} catch {}
	}
	function snapshot(ctx: ExtensionContext, purpose?: "calibration", allowPaused = false) {
		if (!root || !ctx.model) throw new Error("Select a model before analyzing.");
		const config = requireOptIn(root, allowPaused);
		if (!ctx.isIdle()) throw new Error("Wait for Pi to finish before analyzing.");
		// Ignore queued watcher events for settings this job already captured.
		configSnapshot = JSON.stringify({ status: "ready", enabled: config.enabled, config });
		return { root, session: ctx.sessionManager.getSessionId(), entries: purpose === "calibration" ? [] : transcriptEntries(ctx.sessionManager.getBranch()), ...(purpose ? { purpose } : {}),
			provider: ctx.model.provider, model: ctx.model.id, thinking: pi.getThinkingLevel() };
	}
	function schedule(ctx: ExtensionContext) {
		if (!root) return;
		const config = loadConfig(root);
		if (!config.enabled || config.status !== "ready") return;
		reviewer.schedule(config.config.idle_minutes * 60_000, () => {
			try { return snapshot(ctx, root && calibrationDue(root) ? "calibration" : undefined); } catch { return undefined; }
		}, () => Boolean(root && calibrationDue(root)));
	}
	function scheduleCalibration(ctx: ExtensionContext) {
		try { if (root && ctx.isIdle() && calibrationDue(root)) schedule(ctx); }
		catch (error) { ctx.ui.notify(`Idle Learn: ${error instanceof Error ? error.message : String(error)}`, "error"); }
	}
	pi.on("session_start", (_event, ctx) => {
		context = ctx; root = projectRoot(ctx.cwd); refresh(); observeConfig(); scheduleCalibration(ctx);
	});
	pi.on("input", () => { void reviewer.resumeWork(); });
	pi.on("user_bash", () => { void reviewer.resumeWork(); });
	pi.on("agent_start", () => { void reviewer.resumeWork(); });
	pi.on("agent_settled", (_event, ctx) => { schedule(ctx); });
	pi.on("session_before_tree", async () => { await cancelReviews("session navigation"); });
	pi.on("session_before_switch", async () => { await cancelReviews("session switch"); });
	pi.on("session_before_fork", async () => { await cancelReviews("session fork"); });
	pi.on("session_shutdown", async () => { watcher?.close(); watcher = undefined; await cancelReviews("session ended or extensions reloaded"); context = undefined; root = undefined; });

	async function view(ctx: ExtensionCommandContext, title: string, body: string) {
		await ctx.ui.custom<void>((tui, theme, keys, done) => {
			let scroll = 0;
			let maximum = 0;
			return {
				invalidate() {},
				handleInput(data) {
					if (keys.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) done();
					else if (matchesKey(data, "down") || data === "j") scroll = Math.min(maximum, scroll + 1);
					else if (matchesKey(data, "up") || data === "k") scroll = Math.max(0, scroll - 1);
					else if (matchesKey(data, "pageDown")) scroll = Math.min(maximum, scroll + 10);
					else if (matchesKey(data, "pageUp")) scroll = Math.max(0, scroll - 10);
					tui.requestRender();
				},
				render(width) {
					const lines = safeText(body).split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", Math.max(1, width)));
					const height = Math.max(3, tui.terminal.rows - 9);
					maximum = Math.max(0, lines.length - height); scroll = Math.min(scroll, maximum);
					return [theme.fg("accent", title), ...lines.slice(scroll, scroll + height), `Up/Down/PgUp/PgDn scroll ${scroll + 1}/${maximum + 1} | Esc back`].map((line) => truncateToWidth(line, width));
				},
			};
		});
	}
	async function init(ctx: ExtensionCommandContext) {
		if (!root) return;
		if (loadConfig(root).status !== "missing") throw new Error(`Configuration already exists. Use /idle-learn config. Init never overwrites ${CONFIG_PATH}.`);
		if (!await ctx.ui.confirm("Enable Idle Learn for this project?", `Project: ${root}\nReviews send session and repository evidence to the selected model and consume model usage. Suggestions require approval before changing AGENTS.md.\nCreate ${CONFIG_PATH}? A committed enabled config also enables this checkout for other sessions.`)) return;
		initializeConfig(root); observeConfig(); refresh();
		ctx.ui.notify("Idle Learn enabled. Use /idle-learn review to analyze now. Machine-local state can be ignored in Git; .gitignore was not changed.", "info");
	}
	async function configure(ctx: ExtensionCommandContext) {
		if (!root) return;
		if (loadConfig(root).status === "missing") throw new Error("Run /idle-learn init first.");
		while (true) {
			const loaded = loadConfig(root);
			const previous = readProjectFile(root, CONFIG_PATH, 16 * 1024);
			if (previous === null) throw new Error("Configuration disappeared. Run /idle-learn init.");
			if (loaded.status === "invalid") {
				const edited = await ctx.ui.editor(`${loaded.error}\nCorrect the TOML configuration, or Escape to cancel.`, previous);
				if (edited === undefined) return;
				saveConfig(root, parseConfig(edited), previous); continue;
			}
			if (loaded.status !== "ready") return;
			const config = loaded.config;
			const label = config.model ? `${config.provider}/${config.model} (explicit)` : `${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "No model selected"} (follow session)`;
			const thinking = config.thinking ? `${config.thinking} (explicit)` : `${pi.getThinkingLevel()} (follow session)`;
			const modelChoice = `Reviewer model: ${label}`;
			const thinkingChoice = `Thinking level: ${thinking}`;
			const choice = await ctx.ui.select(`Idle Learn / Configuration\n${label}\nThinking: ${thinking}`, [
				`${config.enabled ? "Pause" : "Enable"} analysis`, `Idle delay: ${config.idle_minutes} minutes`, `Calibration: ${config.calibration?.after_rejections === 0 ? "manual only" : `after ${config.calibration?.after_rejections ?? 3} rejections`}`, modelChoice, thinkingChoice, "Reviewer prompt", "Edit TOML", "Back",
			]);
			if (!choice || choice === "Back") return;
			const next: Config = { ...config };
			if (choice.endsWith("analysis")) next.enabled = !config.enabled;
			else if (choice.startsWith("Idle delay")) {
				const value = await ctx.ui.input("Idle delay in minutes (1-1440)", String(config.idle_minutes));
				if (value === undefined) continue;
				next.idle_minutes = Number(value);
			} else if (choice.startsWith("Calibration:")) {
				const value = await ctx.ui.input("Calibrate after new rejections (0 = manual only, 1-1000 = threshold)", String(config.calibration?.after_rejections ?? 3));
				if (value === undefined) continue;
				next.calibration = { after_rejections: Number(value) };
			} else if (choice === modelChoice) {
				const models = ctx.modelRegistry.getAvailable();
				const options = ["Follow current session", ...models.map((model) => `${model.provider}/${model.id}`)];
				const selected = await ctx.ui.select("Reviewer provider and model", options);
				if (!selected) continue;
				if (selected === options[0]) { delete next.provider; delete next.model; delete next.thinking; }
				else {
					const model = models[options.indexOf(selected) - 1];
					next.provider = model.provider; next.model = model.id; delete next.thinking;
					const levels = getSupportedThinkingLevels(model);
					if (!levels.includes(pi.getThinkingLevel())) {
						const thinking = await ctx.ui.select("Current thinking level is unsupported by this model. Choose a supported level.", levels);
						if (!thinking) continue;
						next.thinking = thinking as Config["thinking"];
					}
				}
			} else if (choice === thinkingChoice) {
				const model = config.model ? ctx.modelRegistry.find(config.provider!, config.model) : ctx.model;
				if (!model) throw new Error("Reviewer model unavailable. Choose a new reviewer model.");
				const selected = await ctx.ui.select("Reviewer thinking", ["Follow current session", ...getSupportedThinkingLevels(model)]);
				if (!selected) continue;
				if (selected === "Follow current session") delete next.thinking;
				else next.thinking = selected as Config["thinking"];
			} else if (choice === "Reviewer prompt") {
				const selected = await ctx.ui.select(`Base: ${config.prompt_file ?? "bundled"}\nAppend: ${config.append_file ?? "none"}`, ["View bundled prompt", "View effective prompt", "Replace base prompt", "Append prompt file", "Reset prompt", "Back"]);
				if (selected === "View bundled prompt") { await view(ctx, "Bundled reviewer prompt", effectivePrompt(root, { ...config, prompt_file: undefined, append_file: undefined })); continue; }
				if (selected === "View effective prompt") { await view(ctx, "Effective reviewer prompt", effectivePrompt(root, config)); continue; }
				if (selected === "Reset prompt") { delete next.prompt_file; delete next.append_file; }
				else if (selected === "Replace base prompt" || selected === "Append prompt file") {
					const value = await ctx.ui.input("UTF-8 prompt file (relative to project, or absolute path)");
					if (!value) continue;
					if (selected === "Replace base prompt") next.prompt_file = value; else next.append_file = value;
				} else continue;
			} else if (choice === "Edit TOML") {
				const edited = await ctx.ui.editor("Idle Learn configuration (Escape cancels)", previous);
				if (edited === undefined) continue;
				Object.assign(next, parseConfig(edited));
				for (const key of ["provider", "model", "thinking", "prompt_file", "append_file", "calibration"] as const) if (!(key in parseConfig(edited))) delete next[key];
			}
			effectivePrompt(root, next);
			saveConfig(root, next, previous); refresh();
		}
	}
	async function promptAnalysis(ctx: ExtensionCommandContext): Promise<void> {
		const guidance = await ctx.ui.input("Analysis guidance (optional; Enter reviews unseen entries, Escape cancels)");
		if (guidance !== undefined) analyzeNow(ctx, undefined, guidance.trim() || undefined);
	}
	function analyzeNow(ctx: ExtensionCommandContext, purpose?: "calibration", guidance?: string): void {
		if (reviewer.running) { ctx.ui.notify("Idle Learn: a review is already running. Use /idle-learn cancel to stop it.", "info"); return; }
		const input = { ...snapshot(ctx, purpose), guidance };
		const current = () => root === input.root && context?.sessionManager.getSessionId() === input.session;
		void reviewer.start(input, "manual").then((result) => {
			if (!current()) return;
			ctx.ui.notify(`Idle Learn: ${result.message} Use /idle-learn review to inspect suggestions.`, "info");
			// Work may have finished while this snapshot was still under review.
			if (ctx.isIdle()) schedule(ctx);
		}).catch((error) => {
			if (current() && !reviewer.status.startsWith("Cancelled")) ctx.ui.notify(`Idle Learn: ${error instanceof Error ? error.message : String(error)}`, "error");
		});
		ctx.ui.notify(`Idle Learn: ${purpose === "calibration" ? "calibration" : "review"} started in the background. You can continue chatting. Use /idle-learn cancel to stop it.`, "info");
	}
	/** Run model work in a cancellable foreground modal. No target changes are applied by the work itself. */
	async function runModal(ctx: ExtensionCommandContext, title: string, subject: string, detail: string, cancelled: string, work: (input: ReturnType<typeof snapshot>, signal: AbortSignal) => Promise<unknown>) {
		const input = snapshot(ctx, undefined, true);
		if (modalController) throw new Error("Another refresh or integration is already running.");
		const controller = new AbortController();
		modalController = controller;
		try {
			const error = await ctx.ui.custom<Error | undefined>((_tui, _theme, keys, done) => {
				let finished = false;
				const finish = (error?: Error) => { if (!finished) { finished = true; done(error); } };
				void work(input, controller.signal).then(() => finish(), (cause) => finish(controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : cause instanceof Error ? cause : new Error(String(cause))));
				return {
					invalidate() {},
					render: (width) => [title, safeText(subject), detail].map((line) => truncateToWidth(line, width)),
					handleInput(data) { if (keys.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) { controller.abort(new Error(cancelled)); finish(new Error(cancelled)); } },
				};
			});
			if (error) throw error;
			if (root !== input.root || context?.sessionManager.getSessionId() !== input.session) throw new Error("Session changed. Reopen the review screen.");
		} finally { controller.abort(); if (modalController === controller) modalController = undefined; }
	}
	async function refreshDisplayed(ctx: ExtensionCommandContext, suggestion: Suggestion) {
		await runModal(ctx, "Idle Learn / Refresh diff", suggestion.title, "Reconciling with the current file. Esc cancels; no target changes are applied.",
			"Refresh cancelled. Suggestion remains pending.", (input, signal) => refreshEvidence({ ...input, signal }, suggestion));
	}
	async function chooseBatch(ctx: ExtensionCommandContext, reviewRoot: string): Promise<string | undefined> {
		const batches = listBatches(reviewRoot);
		if (batches.length <= 1) return batches[0]?.id;
		const labels = batches.map((batch, index) => `${index + 1}. ${batch.status === "applying" ? "[partially applied] " : batch.draft ? "[draft] " : ""}${batch.sources.length} proposal${batch.sources.length === 1 ? "" : "s"}, updated ${batch.updated.slice(0, 16).replace("T", " ")}`);
		const choice = await ctx.ui.select("Idle Learn / Integration batches", [...labels, "Back"]);
		const index = choice ? labels.indexOf(choice) : -1;
		return index >= 0 ? batches[index].id : undefined;
	}
	/** Batch review loop. Returns a status line for the suggestion screen. */
	async function reviewBatch(ctx: ExtensionCommandContext, reviewRoot: string, id: string, initial: string): Promise<string | undefined> {
		let status = initial;
		while (root === reviewRoot) {
			let batch: Batch;
			try { batch = readBatch(reviewRoot, id); } catch (error) { return `Error: ${error instanceof Error ? error.message : String(error)}`; }
			if (batch.status === "applied" || batch.status === "discarded") return undefined;
			const sources = resolveSources(reviewRoot, batch);
			const state = draftState(reviewRoot, batch);
			const current = new Map((batch.draft?.files ?? []).map((file) => {
				try { return [file.path, readProjectFile(reviewRoot, file.path)] as const; } catch { return [file.path, null] as const; }
			}));
			const action = await ctx.ui.custom<BatchAction>((tui, theme, keys, done) => {
				const panel = new BatchPanel({ batch, sources, state, current, status }, theme, () => tui.terminal.rows, done,
					(data, key) => keys.matches(data, key === "cancel" ? "tui.select.cancel" : "tui.select.confirm"));
				return { render: (width) => panel.render(width), invalidate: () => panel.invalidate(), handleInput(data) { panel.handleInput(data); tui.requestRender(); } };
			});
			if (!action || action.kind === "back") return undefined;
			try {
				if (action.kind === "comment") {
					const text = await ctx.ui.editor("Comment for the reviewer. Refer to proposals by number, such as #1. Escape cancels.", "");
					if (text === undefined || !text.trim()) continue;
					await addComment(reviewRoot, id, text);
					status = "Comment saved. Press g to regenerate the draft.";
				} else if (action.kind === "remove") {
					if (!await ctx.ui.confirm(`Remove proposal #${action.number} from this batch?`, "It stays pending in the review list. Other proposal numbers do not change. Regenerate the draft afterwards.")) continue;
					await removeSource(reviewRoot, id, action.number);
					status = `Removed #${action.number}. It remains pending. Regenerate the draft.`;
				} else if (action.kind === "discard") {
					if (!await ctx.ui.confirm("Discard this batch?", "Its proposals stay pending. The draft and comments are kept in the batch history but no longer shown.")) continue;
					await discardBatch(reviewRoot, id);
					return "Batch discarded. Its proposals remain pending.";
				} else if (action.kind === "integrate") {
					if (!await ctx.ui.confirm(batch.draft ? "Regenerate the integration draft?" : "Integrate these proposals?", `The Idle Learn reviewer combines ${batch.sources.length} proposal${batch.sources.length === 1 ? "" : "s"} and ${batch.comments.length} comment${batch.comments.length === 1 ? "" : "s"} with the current files. This uses provider usage. You review the combined diff and apply it separately.`)) continue;
					await runModal(ctx, "Idle Learn / Integrate", `${batch.sources.length} proposal${batch.sources.length === 1 ? "" : "s"}`, "The reviewer is drafting a combined change. Esc cancels; the batch, comments, and previous draft are kept.",
						"Integration cancelled. The batch is saved for retry.", (input, signal) => integrateEvidence({ ...input, signal }, id));
					status = "Draft ready. Review the combined diff, then press p to apply, or comment and regenerate. No target changes were made.";
				} else if (action.kind === "apply" || action.kind === "resume") {
					const files = (batch.draft?.files ?? []).map((file) => `${file.path}${file.baseHash === null ? " (new)" : ""}`).join("\n");
					if (action.kind === "apply" && !await ctx.ui.confirm("Apply this integration draft?", `Writes:\n${safeText(files)}\nAll ${batch.sources.length} selected proposal${batch.sources.length === 1 ? "" : "s"} will be recorded as accepted. Files are checked for changes first.`)) continue;
					if (action.kind === "resume" && !await ctx.ui.confirm("Resume the interrupted Apply?", `Finishes writing:\n${safeText(files)}\nFiles already at the reviewed content are left alone. A file changed by someone else stops recovery.`)) continue;
					await (action.kind === "apply" ? applyBatch(reviewRoot, batch) : resumeApply(reviewRoot, id));
					refresh(); scheduleCalibration(ctx);
					return `Applied the integration to ${batch.draft?.files.length ?? 0} file${batch.draft?.files.length === 1 ? "" : "s"}; ${batch.sources.length} proposal${batch.sources.length === 1 ? "" : "s"} recorded as accepted.`;
				}
			} catch (error) { status = `Error: ${error instanceof Error ? error.message : String(error)}`; ctx.ui.notify(status, "error"); }
		}
		return undefined;
	}
	async function review(ctx: ExtensionCommandContext) {
		if (!root) return;
		requireOptIn(root, true);
		let status = reviewer.status;
		let selectedId: string | undefined;
		let showDetails = false;
		const selection = new Set<string>();
		const reviewRoot = root;
		while (root === reviewRoot) {
			const suggestions = listSuggestions(root);
			let counts = { open: 0, applying: 0 };
			try { const batches = listBatches(root); counts = { open: batches.filter((item) => item.status === "open").length, applying: batches.filter((item) => item.status === "applying").length }; }
			catch (error) { status = `Error: ${error instanceof Error ? error.message : String(error)}`; }
			const action = await ctx.ui.custom<ReviewAction>((tui, theme, keys, done) => {
				const panel = new ReviewPanel(suggestions, status, theme, () => tui.terminal.rows, done,
					(data, key) => keys.matches(data, key === "cancel" ? "tui.select.cancel" : "tui.select.confirm"), selectedId, showDetails, { selection, batches: counts });
				return { render: (width) => panel.render(width), invalidate: () => panel.invalidate(), handleInput(data) { panel.handleInput(data); tui.requestRender(); } };
			});
			if (!action || action.kind === "close") return;
			try {
				if (action.kind === "analyze") { await promptAnalysis(ctx); return; }
				else if (action.kind === "batches") {
					const id = await chooseBatch(ctx, reviewRoot);
					if (id) status = await reviewBatch(ctx, reviewRoot, id, "Saved batch. Comment, regenerate, or apply.") ?? status;
				} else if (action.kind === "integrate") {
					selectedId = action.current.id; showDetails = false;
					const batch = await createBatch(reviewRoot, action.suggestions);
					selection.clear();
					status = await reviewBatch(ctx, reviewRoot, batch.id, "Selection saved. Add comments with c, then press g to integrate. Nothing has been applied.") ?? "Batch saved. Press b to reopen it.";
					refresh();
				} else if ("suggestion" in action) {
					selectedId = action.suggestion.id; showDetails = true;
					if (action.kind !== "reject" && action.suggestion.kind !== "calibration") throw new Error("Instruction suggestions are integrated in batches. Select with Space, then press i.");
					if (action.kind === "refresh" || (action.kind === "apply" && suggestionIsStale(root, action.suggestion))) {
						if (!await ctx.ui.confirm("Refresh this diff with the reviewer model?", "The target may have changed. The model will reconcile the proposed edit with the current file. This uses provider usage. You must review the new diff and apply it separately.")) continue;
						await refreshDisplayed(ctx, action.suggestion);
						status = "Refreshed diff ready. Review it, then press p to apply. No target changes were made.";
						continue;
					}
					if (action.kind === "apply" && !await ctx.ui.confirm(action.suggestion.kind === "calibration" ? "Apply this calibration?" : "Apply this suggestion?", `${safeText(action.suggestion.title)}\nTarget: ${safeText(action.suggestion.target)}\n${action.suggestion.kind === "calibration" ? "Changes future Idle Learn reviews for this project, not AGENTS.md.\n" : ""}The target will be checked for changes before applying.`)) continue;
					const reason = action.kind === "reject" ? await ctx.ui.input("Rejection reason (optional; Escape cancels rejection)") : undefined;
					if (action.kind === "reject" && reason === undefined) continue;
					await decideSuggestion(root, action.suggestion, action.kind, reason);
					status = action.suggestion.kind === "calibration"
						? action.kind === "apply" ? "Calibration applied. Future project reviews use the approved preferences." : "Calibration rejected. Reviewer preferences are unchanged."
						: "Rejected. The next reviewer will see this decision.";
					refresh();
					scheduleCalibration(ctx);
				}
			} catch (error) { status = `Error: ${error instanceof Error ? error.message : String(error)}`; ctx.ui.notify(status, "error"); }
		}
	}
	pi.registerCommand("idle-learn", {
		description: "Opt in, review project instruction suggestions, or configure idle learning",
		getArgumentCompletions: (prefix) => ["init", "analyze", "calibrate", "review", "config", "cancel"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") { ctx.ui.notify("Idle Learn commands require interactive terminal mode.", "error"); return; }
			context = ctx; root ??= projectRoot(ctx.cwd);
			try {
				let choice = args.trim();
				let fromMenu = false;
				if (!choice) {
					fromMenu = true;
					const config = loadConfig(root);
					const selected = await ctx.ui.select(`Idle Learn\nProject: ${root}\n${reviewer.status}\n${config.status === "missing" ? "Not enabled" : config.enabled ? "Enabled" : "Paused or invalid configuration"}\n${config.status === "ready" ? listSuggestions(root).length : 0} pending suggestions`, ["Analyze now", "Calibrate reviewer", "Review suggestions", ...(reviewer.running ? ["Cancel review"] : []), "Configuration", "Initialize project", "Close"]);
					choice = selected === "Analyze now" ? "analyze" : selected === "Calibrate reviewer" ? "calibrate" : selected === "Review suggestions" ? "review" : selected === "Cancel review" ? "cancel" : selected === "Configuration" ? "config" : selected === "Initialize project" ? "init" : "";
				}
				if (choice === "init") await init(ctx);
				else if (choice === "config") { await cancelReviews("configuration opened"); await configure(ctx); }
				else if (/^analyze(?:\s|$)/.test(choice)) {
					if (fromMenu) await promptAnalysis(ctx);
					else analyzeNow(ctx, undefined, choice.slice("analyze".length).trim() || undefined);
				}
				else if (choice === "calibrate") analyzeNow(ctx, "calibration");
				else if (choice === "cancel") {
					const running = reviewer.running || Boolean(modalController);
					await cancelReviews();
					ctx.ui.notify(running ? `Idle Learn: ${reviewer.running ? reviewer.status : "Cancelled. Saved batches and suggestions remain."}` : "Idle Learn: no review is running.", "info");
				}
				else if (choice === "review") await review(ctx);
				else if (choice) throw new Error("Use /idle-learn [init|analyze|calibrate|review|config|cancel].");
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
			finally { refresh(); }
		},
	});
}
