import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokens, roundTokens } from "../lib/format.ts";
import { formatUsage, formatUsageBalance } from "../lib/usage-format.ts";
import { decodeUsageStatus, USAGE_STATUS_KEY } from "../lib/usage-status.ts";
import type { UsageStatus } from "../lib/usage-status.ts";

const MODES_STATUS_KEY = "modes";
// Must match PROFILE_ENTRY_TYPE in src/subagents/constants.ts, which sets this status.
const SUBAGENT_PROFILE_STATUS_KEY = "subagent-profile";
const REDRAW_INTERVAL_MS = 60_000;
const CONTEXT_USAGE_ERROR_TOKENS = 200_000;
const CONTEXT_USAGE_MILLIONS_FROM_TOKENS = 1_000_000;
const CONTEXT_USAGE_THOUSANDS_DECIMALS = 0;
const CONTEXT_USAGE_MILLIONS_DECIMALS = 1;

export function decodeFooterUsageStatus(value: string | undefined): UsageStatus | undefined {
  return value ? decodeUsageStatus(value) : undefined;
}

function calculateFooterCacheHit(entries: ReadonlyArray<{ type: string; message?: unknown }>): number | undefined {
  let cacheRead = 0;
  let cacheInput = 0;
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as { role?: unknown; usage?: unknown };
    if (message.role !== "assistant" || !message.usage || typeof message.usage !== "object") continue;
    const usage = message.usage as { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
    if (
      typeof usage.input !== "number" ||
      !Number.isFinite(usage.input) ||
      typeof usage.cacheRead !== "number" ||
      !Number.isFinite(usage.cacheRead) ||
      typeof usage.cacheWrite !== "number" ||
      !Number.isFinite(usage.cacheWrite)
    )
      continue;
    cacheRead += usage.cacheRead;
    cacheInput += usage.input + usage.cacheRead + usage.cacheWrite;
  }
  return cacheInput > 0 ? (cacheRead / cacheInput) * 100 : undefined;
}

// Closely follows Claude Code's statusline: one main line with terse markers
// such as c: and b:, and provider usage on the right.
export default function (pi: ExtensionAPI) {
  let cacheHitVersion = 0;
  let cacheHitCache: { version: number; leafId: string | null; cacheHit?: number } | undefined;
  const invalidateCacheHit = (): void => {
    cacheHitVersion++;
  };

  pi.on("session_start", (_event, ctx) => {
    invalidateCacheHit();
    ctx.ui.setFooter((tui, theme, footerData) => {
      const redrawTimer = setInterval(() => tui.invalidate(), REDRAW_INTERVAL_MS);
      return {
        dispose() {
          clearInterval(redrawTimer);
        },
        invalidate() {},
        render(width: number): string[] {
          const margin = width >= 3 ? 1 : 0;
          width -= margin * 2;
          // Extension statuses
          const statuses = footerData.getExtensionStatuses();
          const rawMode = statuses.get(MODES_STATUS_KEY) ?? "";
          const modeStatus = rawMode
            ? theme.fg(
                rawMode === "build" ? "error" : rawMode === "plan" ? "borderAccent" : "accent",
                `[${rawMode[0]}]`,
              )
            : "";

          // Model name
          const model = ctx.model;
          const modelName = model?.name || model?.id || "no-model";
          let line = theme.fg("customMessageLabel", modelName);
          if (modeStatus) {
            line = `${modeStatus} ${line}`;
          }

          // Thinking level / effort
          if (ctx.thinkingLevel && ctx.thinkingLevel !== "off") {
            line += theme.fg("success", ` ${ctx.thinkingLevel}`);
          }

          const profile = statuses.get(SUBAGENT_PROFILE_STATUS_KEY);
          if (profile) {
            line += theme.fg("accent", ` s:${profile}`);
          }

          // Context usage
          const contextUsage = ctx.getContextUsage();
          if (contextUsage && contextUsage.tokens !== null && contextUsage.contextWindow > 0) {
            const decimals = (count: number) =>
              count < CONTEXT_USAGE_MILLIONS_FROM_TOKENS
                ? CONTEXT_USAGE_THOUSANDS_DECIMALS
                : CONTEXT_USAGE_MILLIONS_DECIMALS;
            const usedDecimals = decimals(contextUsage.tokens);
            const used = formatTokens(contextUsage.tokens, usedDecimals);
            const total = formatTokens(contextUsage.contextWindow, decimals(contextUsage.contextWindow));
            // Compare the rounded count so the label turns red as soon as it reads the threshold.
            const shownTokens = roundTokens(contextUsage.tokens, usedDecimals);
            line += ` ${theme.fg(shownTokens >= CONTEXT_USAGE_ERROR_TOKENS ? "error" : "borderAccent", `${used}/${total}`)}`;
          }

          const leafId = ctx.sessionManager.getLeafId();
          if (!cacheHitCache || cacheHitCache.version !== cacheHitVersion || cacheHitCache.leafId !== leafId) {
            const branch = ctx.sessionManager.getBranch();
            cacheHitCache = {
              version: cacheHitVersion,
              leafId,
              cacheHit: calculateFooterCacheHit(branch),
            };
          }
          if (cacheHitCache.cacheHit !== undefined) {
            line += ` ${theme.fg("warning", `c:${Math.round(cacheHitCache.cacheHit)}%`)}`;
          }

          const usage = decodeFooterUsageStatus(statuses.get(USAGE_STATUS_KEY));
          const usageReady = usage?.state === "ready" && usage.provider === model?.provider;
          const providerText = model?.provider ?? "";
          const reserved = providerText ? visibleWidth(providerText) + 3 : 0;

          let right = "";
          if (usageReady && usage.windows.length > 0) {
            const usageWidth = Math.max(0, width - visibleWidth(line) - reserved);
            const text = formatUsage(usage, Date.now(), usageWidth, theme);
            if (text) right = text;
          }
          if (usageReady && usage.balance) {
            const text = formatUsageBalance(usage.balance, theme);
            if (visibleWidth(line) + visibleWidth(right) + (right ? 1 : 0) + visibleWidth(text) + reserved <= width) {
              right += `${right ? " " : ""}${text}`;
            }
          }
          const provider = providerText ? theme.fg("muted", providerText) : "";
          right += `${right && provider ? " " : ""}${provider}`;
          const gap = width - visibleWidth(line) - visibleWidth(right);

          const result =
            gap >= 2
              ? line + " ".repeat(gap) + right
              : truncateToWidth(line, Math.max(0, width - visibleWidth("...")), "...");

          const rest = Array.from(statuses.entries())
            .filter(
              ([key]) => key !== MODES_STATUS_KEY && key !== SUBAGENT_PROFILE_STATUS_KEY && key !== USAGE_STATUS_KEY,
            )
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => text);
          return [result, ...rest.map((s) => truncateToWidth(s, width, theme.fg("dim", "...")))].map((line) =>
            margin > 0 ? ` ${line} ` : line,
          );
        },
      };
    });
  });

  pi.on("turn_end", invalidateCacheHit);
  pi.on("session_tree", invalidateCacheHit);
  pi.on("session_compact", invalidateCacheHit);
}
