import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeUsagePercent } from "../../lib/usage-status.ts";
import type { UsageStatus, UsageWindow } from "../../lib/usage-status.ts";
import { asNumber, asObject } from "../http.ts";
import { fetchClaudeCliUsage } from "./claude-cli.ts";

export const CLAUDE_CODE_PROVIDER = "claude-code";
export const CLAUDE_CODE_CACHE_TTL_MS = 300_000;
export const CLAUDE_CODE_REQUEST_INTERVAL_MS = 300_000;
export const CLAUDE_CODE_STALE_AFTER_MS = 600_000;

const RATE_LIMIT_DIAGNOSTIC = "claude-code.rate-limit";

/**
 * Reads plan usage from the rate-limit status that pi-claude-code attaches to each assistant reply.
 * Returns undefined when the message carries no status with a usable 5-hour or 7-day window.
 */
export function normalizeClaudeCodeRateLimit(message: unknown, capturedAt = Date.now()): UsageStatus | undefined {
  const diagnostics = asObject(message)?.diagnostics;
  if (!Array.isArray(diagnostics)) return undefined;
  const status = diagnostics.findLast((diagnostic) => asObject(diagnostic)?.type === RATE_LIMIT_DIAGNOSTIC);
  const unified = asObject(asObject(asObject(status)?.details)?.unifiedWindows);
  const windows: UsageWindow[] = [];
  for (const [key, kind, label] of [
    ["five_hour", "rolling", "5h"],
    ["seven_day", "weekly", "7d"],
  ] as const) {
    const window = asObject(unified?.[key]);
    const utilization = asNumber(window?.utilization);
    const usedPercent = utilization === undefined ? undefined : normalizeUsagePercent(utilization * 100);
    if (usedPercent === undefined) continue;
    const reset = asNumber(window?.resetsAt);
    windows.push({
      kind,
      label,
      usedPercent,
      ...(reset !== undefined && reset > 0 ? { resetAtMs: reset * 1000 } : {}),
    });
  }
  return windows.length
    ? { provider: CLAUDE_CODE_PROVIDER, state: "ready", windows, capturedAtMs: capturedAt }
    : undefined;
}

export function fetchClaudeCodeUsage(
  _ctx: ExtensionContext,
  signal: AbortSignal,
  savedOnly?: boolean,
): Promise<UsageStatus> {
  return fetchClaudeCliUsage(CLAUDE_CODE_PROVIDER, signal, savedOnly);
}
