import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageStatus } from "../usage-status.ts";
import { fetchClaudeLoginUsage } from "./claude-login.ts";

export const CLAUDE_CODE_PROVIDER = "claude-code";
export const CLAUDE_CODE_CACHE_TTL_MS = 300_000;
export const CLAUDE_CODE_TURN_CACHE_TTL_MS = 60_000;

export function fetchClaudeCodeUsage(_ctx: ExtensionContext, signal: AbortSignal): Promise<UsageStatus> {
  return fetchClaudeLoginUsage(CLAUDE_CODE_PROVIDER, signal);
}
