export const USAGE_STATUS_KEY = "provider-usage";

const USAGE_PROVIDERS = [
  "anthropic",
  "claude-bridge",
  "claude-code",
  "openai-codex",
  "opencode-go",
  "deepseek",
] as const;

export type UsageProvider = (typeof USAGE_PROVIDERS)[number];
export type UsageWindowKind = "rolling" | "weekly" | "monthly";

export interface UsageWindow {
  kind: UsageWindowKind;
  label: string;
  usedPercent: number;
  resetAtMs?: number;
  usedAmount?: number;
  limitAmount?: number;
  unit?: "usd";
}

export interface UsageBalance {
  amount: number;
  currency: string;
}

export interface UsageStatus {
  provider: UsageProvider;
  state: "ready" | "unknown";
  windows: UsageWindow[];
  capturedAtMs: number;
  balance?: UsageBalance;
}

const providers = new Set<string>(USAGE_PROVIDERS);
const kinds = new Set<UsageWindowKind>(["rolling", "weekly", "monthly"]);

export function isUsageProvider(value: unknown): value is UsageProvider {
  return typeof value === "string" && providers.has(value as UsageProvider);
}

function isUsageStatus(value: unknown): value is UsageStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Record<string, unknown>;
  return (
    isUsageProvider(status.provider) &&
    (status.state === "ready" || status.state === "unknown") &&
    Array.isArray(status.windows) &&
    typeof status.capturedAtMs === "number" &&
    Number.isFinite(status.capturedAtMs) &&
    status.capturedAtMs >= 0 &&
    status.windows.every(isUsageWindow) &&
    (status.balance === undefined || isUsageBalance(status.balance))
  );
}

function isUsageBalance(value: unknown): value is UsageBalance {
  if (!value || typeof value !== "object") return false;
  const balance = value as Record<string, unknown>;
  return (
    typeof balance.amount === "number" &&
    Number.isFinite(balance.amount) &&
    balance.amount >= 0 &&
    typeof balance.currency === "string" &&
    /^[A-Z]{3}$/.test(balance.currency)
  );
}

function isUsageWindow(value: unknown): value is UsageWindow {
  if (!value || typeof value !== "object") return false;
  const window = value as Record<string, unknown>;
  const resetAtMs = window.resetAtMs;
  return (
    kinds.has(window.kind as UsageWindowKind) &&
    typeof window.label === "string" &&
    typeof window.usedPercent === "number" &&
    Number.isFinite(window.usedPercent) &&
    window.usedPercent >= 0 &&
    window.usedPercent <= 100 &&
    (resetAtMs === undefined || (typeof resetAtMs === "number" && Number.isFinite(resetAtMs) && resetAtMs >= 0)) &&
    (window.usedAmount === undefined ||
      (typeof window.usedAmount === "number" && Number.isFinite(window.usedAmount))) &&
    (window.limitAmount === undefined ||
      (typeof window.limitAmount === "number" && Number.isFinite(window.limitAmount))) &&
    (window.unit === undefined || window.unit === "usd")
  );
}

export function encodeUsageStatus(status: UsageStatus): string {
  return JSON.stringify(status);
}

export function decodeUsageStatus(value: string): UsageStatus | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isUsageStatus(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeUsagePercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;
}
