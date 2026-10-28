import { atomicProjectWrite, DATA_DIR, readProjectFile } from "./files.ts";
import { validateProposal, type Evidence } from "./store.ts";

export const STATE_PATH = `${DATA_DIR}/state.json`;
export const OBSERVATIONS_PATH = `${DATA_DIR}/observations.md`;
export interface Progress { version: 1; reviewed: Record<string, string[]>; audits: Record<string, string> }
export interface Observation { lesson: string; category: string; evidence: Evidence[]; created: string }
export function readProgress(root: string): Progress {
	const text = readProjectFile(root, STATE_PATH);
	if (text === null) return { version: 1, reviewed: {}, audits: {} };
	const value = JSON.parse(text);
	if (value?.version !== 1 || !value.reviewed || typeof value.reviewed !== "object" || Array.isArray(value.reviewed)
		|| !value.audits || typeof value.audits !== "object" || Array.isArray(value.audits)
		|| !Object.values(value.reviewed).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string"))
		|| !Object.values(value.audits).every((hash) => typeof hash === "string")) throw new Error("Invalid Idle Learn state.json. Restore or remove the machine-local state file.");
	return { version: 1, reviewed: value.reviewed, audits: value.audits };
}

export function validateObservation(value: unknown, created = new Date().toISOString()): Observation {
	if (!value || typeof value !== "object") throw new Error("Invalid observation.");
	const item = value as Record<string, unknown>;
	if (typeof item.lesson !== "string" || !item.lesson.trim() || item.lesson.length > 1000) throw new Error("Invalid observation lesson.");
	if (!["repeated-instruction", "difficult-discovery", "broken-rule"].includes(String(item.category))) throw new Error("Invalid observation category.");
	const proposal = validateProposal({ title: "Observation", target: "AGENTS.md", rationale: "Weak evidence", baseHash: null, before: "", after: "Observation", evidence: item.evidence });
	return { lesson: item.lesson, category: String(item.category), evidence: proposal.evidence, created };
}

export function readObservations(root: string, now = Date.now()): Observation[] {
	const content = readProjectFile(root, OBSERVATIONS_PATH);
	if (content === null) return [];
	const match = /^# Idle Learn Observations\n\n```json\n([\s\S]+)\n```\n$/.exec(content);
	if (!match) throw new Error("Invalid observations.md. Restore or remove this file before analyzing.");
	const values = JSON.parse(match[1]);
	if (!Array.isArray(values) || values.length > 20) throw new Error("Invalid observation list.");
	return values.map((value) => {
		if (typeof value.created !== "string" || !Number.isFinite(Date.parse(value.created))) throw new Error("Invalid observation date.");
		return validateObservation(value, value.created);
	}).filter((item) => now - Date.parse(item.created) < 60 * 24 * 60 * 60 * 1000);
}

export function mergeObservations(previous: Observation[], incoming: Observation[], promoted: Evidence[]): Observation[] {
	const result = new Map<string, Observation>();
	for (const item of [...previous, ...incoming]) {
		if (item.evidence.some((quote) => promoted.some((used) => used.session === quote.session && used.entry === quote.entry))) continue;
		const key = `${item.category}:${item.lesson.toLowerCase().replace(/\s+/g, " ").trim()}`;
		const old = result.get(key);
		if (old) {
			const evidence = [...old.evidence];
			for (const quote of item.evidence) if (!evidence.some((q) => JSON.stringify(q) === JSON.stringify(quote))) evidence.push(quote);
			result.set(key, { ...old, evidence: evidence.slice(-12) });
		} else result.set(key, item);
	}
	return [...result.values()].slice(-20);
}

export function saveReviewState(root: string, progress: Progress, observations: Observation[], previousState: string | null, previousObservations: string | null): void {
	atomicProjectWrite(root, OBSERVATIONS_PATH, `# Idle Learn Observations\n\n\`\`\`json\n${JSON.stringify(observations, null, 2)}\n\`\`\`\n`, previousObservations);
	atomicProjectWrite(root, STATE_PATH, `${JSON.stringify(progress, null, 2)}\n`, previousState);
}
