import type { Theme } from "@earendil-works/pi-coding-agent";

export const CONTEXT_FILES_EVENT = "context:files";

export type ContextFilesEvent = {
	source: string;
	paths: string[];
};

export const PROVIDER_USAGE_REQUEST_EVENT = "provider-usage:request";

export type ProviderUsageRequest = {
	provider: string;
	theme: Pick<Theme, "fg">;
	// Receives themed display text, or undefined when the provider is unsupported or no session is active.
	reply: (text: string | undefined) => void;
};
