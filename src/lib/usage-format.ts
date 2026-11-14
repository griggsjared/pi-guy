import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { UsageBalance, UsageStatus } from "./usage-status.ts";

const WINDOW_ORDER = ["rolling", "weekly", "monthly"] as const;
const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", CNY: "¥" };
const USAGE_ERROR_PERCENT = 95;
const USAGE_WARNING_PERCENT = 90;
const LOW_BALANCE_ERROR_USD = 0.5;
const LOW_BALANCE_WARNING_USD = 1;

export function formatUsageReset(resetAtMs: number | undefined, now = Date.now()): string | undefined {
  if (resetAtMs === undefined || !Number.isFinite(resetAtMs) || resetAtMs <= 0) return undefined;
  const seconds = Math.max(0, Math.round(resetAtMs / 1000 - now / 1000));
  if (seconds === 0) return "now";
  if (seconds < 60) return "1m";
  const days = Math.floor(seconds / (24 * 60 * 60));
  const hours = Math.floor((seconds % (24 * 60 * 60)) / (60 * 60));
  const minutes = Math.floor((seconds % (60 * 60)) / 60);
  if (days >= 7) return `${days}d`;
  if (days > 0) return `${days}d${hours > 0 ? `${hours}h` : ""}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
  return `${minutes}m`;
}

export function formatUsage(
  status: UsageStatus,
  now = Date.now(),
  maxWidth = Infinity,
  theme?: Pick<Theme, "fg">,
): string {
  const windows = [...status.windows].sort((a, b) => WINDOW_ORDER.indexOf(a.kind) - WINDOW_ORDER.indexOf(b.kind));
  const formatWindow = (window: UsageStatus["windows"][number], withReset: boolean): string => {
    const reset = withReset ? formatUsageReset(window.resetAtMs, now) : undefined;
    const text = `${Math.round(window.usedPercent)}%${reset ? `(${reset})` : ""}`;
    const color =
      window.usedPercent >= USAGE_ERROR_PERCENT
        ? "error"
        : window.usedPercent >= USAGE_WARNING_PERCENT
          ? "warning"
          : "dim";
    return theme ? theme.fg(color, text) : text;
  };
  const full = windows.map((window) => formatWindow(window, true)).join(" ");
  if (maxWidth === Infinity) return full;

  const width = Number.isFinite(maxWidth) ? Math.max(0, Math.floor(maxWidth)) : 0;
  if (visibleWidth(full) <= width) return full;
  const compact = windows.map((window) => formatWindow(window, false)).join(" ");
  if (visibleWidth(compact) <= width) return compact;
  const truncated = truncateToWidth(compact, width, "");
  return visibleWidth(truncated) <= width ? truncated : "";
}

export function formatUsageBalance(balance: UsageBalance, theme: Pick<Theme, "fg">): string {
  const symbol = CURRENCY_SYMBOLS[balance.currency] ?? `${balance.currency} `;
  const color =
    balance.currency === "USD" && balance.amount < LOW_BALANCE_ERROR_USD
      ? "error"
      : balance.currency === "USD" && balance.amount < LOW_BALANCE_WARNING_USD
        ? "warning"
        : "dim";
  return theme.fg(color, `b:${symbol}${balance.amount.toFixed(2)}`);
}
