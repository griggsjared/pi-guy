import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageStatus } from "../usage-status.ts";
import { fetchClaudeLoginUsage } from "./claude-login.ts";

export const CLAUDE_BRIDGE_PROVIDER = "claude-bridge";
export const CLAUDE_BRIDGE_CACHE_TTL_MS = 300_000;

export function fetchClaudeBridgeUsage(_ctx: ExtensionContext, signal: AbortSignal): Promise<UsageStatus> {
  return fetchClaudeLoginUsage(CLAUDE_BRIDGE_PROVIDER, signal);
}
