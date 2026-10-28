import { parse, stringify } from "smol-toml";
import { atomicProjectWrite, DATA_DIR, readProjectFile } from "./files.ts";

export const CONFIG_PATH = `${DATA_DIR}/config.toml`;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export interface Config {
	enabled: boolean;
	idle_minutes: number;
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel;
	prompt_file?: string;
	append_file?: string;
}
export type ConfigResult =
	| { status: "missing"; enabled: false }
	| { status: "invalid"; enabled: false; error: string }
	| { status: "ready"; enabled: boolean; config: Config };

const fields = new Set(["enabled", "idle_minutes", "provider", "model", "thinking", "prompt_file", "append_file"]);

export function validateConfig(value: unknown): Config {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a configuration table.");
	const input = value as Record<string, unknown>;
	for (const key of Object.keys(input)) {
		if (!fields.has(key)) throw new Error(`Unknown configuration option: ${key}.`);
	}
	if (typeof input.enabled !== "boolean") throw new Error("Set enabled to true or false.");
	const idle = input.idle_minutes ?? 10;
	if (!Number.isInteger(idle) || Number(idle) < 1 || Number(idle) > 1440) {
		throw new Error("Set idle_minutes to a whole number from 1 to 1440.");
	}
	const config: Config = { enabled: input.enabled, idle_minutes: Number(idle) };
	for (const key of ["provider", "model", "prompt_file", "append_file"] as const) {
		const item = input[key];
		if (item === undefined) continue;
		if (typeof item !== "string" || !item.trim() || item.length > 4096 || item.includes("\0")) {
			throw new Error(`Set ${key} to a nonempty string.`);
		}
		config[key] = item;
	}
	if ((config.provider === undefined) !== (config.model === undefined)) {
		throw new Error("Set provider and model together, or omit both to follow the current session.");
	}
	if (input.thinking !== undefined) {
		if (!THINKING_LEVELS.includes(input.thinking as ThinkingLevel)) throw new Error("Unsupported thinking level.");
		config.thinking = input.thinking as ThinkingLevel;
	}
	return config;
}

export function parseConfig(text: string): Config {
	return validateConfig(parse(text));
}

export function serializeConfig(config: Config): string {
	const content = stringify(validateConfig(config));
	if (Buffer.byteLength(content) > 16 * 1024) throw new Error("Configuration exceeds 16384 bytes.");
	return content;
}

export function loadConfig(root: string): ConfigResult {
	try {
		const text = readProjectFile(root, CONFIG_PATH, 16 * 1024);
		if (text === null) return { status: "missing", enabled: false };
		const config = parseConfig(text);
		return { status: "ready", enabled: config.enabled, config };
	} catch (error) {
		return { status: "invalid", enabled: false, error: `Fix ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** Call only after the user confirms opt-in. Existing configuration is never replaced. */
export function initializeConfig(root: string): Config {
	const config: Config = { enabled: true, idle_minutes: 10 };
	atomicProjectWrite(root, CONFIG_PATH, serializeConfig(config), null);
	return config;
}

export function saveConfig(root: string, config: Config, previousText: string): void {
	atomicProjectWrite(root, CONFIG_PATH, serializeConfig(config), previousText);
}

export function requireOptIn(root: string, allowPaused = false): Config {
	const result = loadConfig(root);
	if (result.status !== "ready") {
		throw new Error(result.status === "invalid" ? result.error : "Run /idle-learn init to opt in this project.");
	}
	if (!result.enabled && !allowPaused) throw new Error("Idle Learn is paused. Enable it in /idle-learn config.");
	return result.config;
}
