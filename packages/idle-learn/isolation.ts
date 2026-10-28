import {
	createExtensionRuntime,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionOptions,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

/** No resource discovery occurs, including SYSTEM.md and APPEND_SYSTEM.md. */
export function reviewerResources(systemPrompt: string): ResourceLoader {
	if (!systemPrompt.trim()) throw new Error("The reviewer system prompt must not be empty.");
	const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	return {
		getExtensions: () => extensions,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => { throw new Error("Reviewer resources cannot be extended."); },
		reload: async () => {},
	};
}

export function reviewerSessionOptions(
	cwd: string,
	systemPrompt: string,
	model: NonNullable<CreateAgentSessionOptions["model"]>,
	modelRuntime: NonNullable<CreateAgentSessionOptions["modelRuntime"]>,
	customTools: NonNullable<CreateAgentSessionOptions["customTools"]> = [],
): CreateAgentSessionOptions {
	return {
		cwd,
		model,
		modelRuntime,
		resourceLoader: reviewerResources(systemPrompt),
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
		tools: customTools.map((tool) => tool.name),
		customTools,
	};
}
