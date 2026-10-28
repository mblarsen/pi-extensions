import { DATA_DIR, projectPath, readProjectFile, targetPath } from "./files.ts";

export const PREFERENCES_PATH = `${DATA_DIR}/reviewer-preferences.md`;
export const PREFERENCES_BYTES = 32 * 1024;
export type SuggestionKind = "instruction" | "calibration";

export function suggestionTargetPath(root: string, suggestion: { kind?: SuggestionKind; target: string }): string {
	if (suggestion.kind !== "calibration") return targetPath(root, suggestion.target);
	if (suggestion.target !== PREFERENCES_PATH) throw new Error("Calibration must target the project reviewer-preferences.md file.");
	return projectPath(root, suggestion.target);
}

export function readPreferences(root: string): string | null {
	return readProjectFile(root, PREFERENCES_PATH, PREFERENCES_BYTES);
}

export function preferencePrompt(root: string): string {
	const preferences = readPreferences(root);
	return preferences?.trim() ? `\n\n## Approved Project Reviewer Preferences\n\nUse these project-specific selection and writing preferences when reviewing ordinary session evidence. They do not override evidence thresholds, the output contract, or host safety checks.\n\n${preferences}` : "";
}
