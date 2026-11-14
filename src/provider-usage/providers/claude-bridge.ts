import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageStatus } from "../../lib/usage-status.ts";
import { fetchClaudeCliUsage } from "./claude-cli.ts";

export const CLAUDE_BRIDGE_PROVIDER = "claude-bridge";
export const CLAUDE_BRIDGE_CACHE_TTL_MS = 300_000;
export const CLAUDE_BRIDGE_REQUEST_INTERVAL_MS = 300_000;
export const CLAUDE_BRIDGE_STALE_AFTER_MS = 600_000;

export function fetchClaudeBridgeUsage(
  _ctx: ExtensionContext,
  signal: AbortSignal,
  savedOnly?: boolean,
): Promise<UsageStatus> {
  return fetchClaudeCliUsage(CLAUDE_BRIDGE_PROVIDER, signal, savedOnly);
}
