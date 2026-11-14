import assert from "node:assert/strict";
import { test } from "node:test";
import { formatUsage, formatUsageBalance, formatUsageReset } from "../../src/lib/usage-format.ts";
import { fakeTheme } from "../helpers/theme.ts";

test("formats shared usage status", () => {
  assert.equal(
    formatUsage({
      provider: "openai-codex",
      state: "ready",
      capturedAtMs: 1_000_000_000_000,
      windows: [{ kind: "weekly", label: "7d", usedPercent: 20, resetAtMs: 1_000_000_000_000 }],
    }),
    "20%(now)",
  );
});

test("formats reset countdowns compactly", () => {
  const now = 1_000_000_000_000;
  assert.equal(formatUsageReset(now + 30_000, now), "1m");
  assert.equal(formatUsageReset(now + 90_000, now), "1m");
  assert.equal(formatUsageReset(now + 3_600_000, now), "1h");
  assert.equal(formatUsageReset(now + 3_900_000, now), "1h5m");
  assert.equal(formatUsageReset(now + 3 * 86_400_000 + 4 * 3_600_000, now), "3d4h");
  assert.equal(formatUsageReset(now + 20 * 86_400_000 + 4 * 3_600_000, now), "20d");
});

test("orders windows and removes resets on narrow footers", () => {
  const now = 1_000_000_000_000;
  const usage = {
    provider: "openai-codex" as const,
    state: "ready" as const,
    capturedAtMs: now,
    windows: [
      { kind: "monthly" as const, label: "30d", usedPercent: 30, resetAtMs: now },
      { kind: "rolling" as const, label: "5h", usedPercent: 10, resetAtMs: now },
      { kind: "weekly" as const, label: "7d", usedPercent: 20, resetAtMs: now },
    ],
  };
  assert.equal(formatUsage(usage, now), "10%(now) 20%(now) 30%(now)");
  assert.equal(formatUsage(usage, now, 21), "10% 20% 30%");
  const narrow = formatUsage(usage, now, 12);
  assert.ok(narrow.length <= 12);
  assert.equal(formatUsage(usage, now, 0), "");
});

test("formats balances by currency", () => {
  assert.equal(formatUsageBalance({ amount: 110, currency: "USD" }, fakeTheme()), "b:$110.00");
  assert.equal(formatUsageBalance({ amount: 12.5, currency: "CNY" }, fakeTheme()), "b:¥12.50");
  assert.equal(formatUsageBalance({ amount: 1, currency: "EUR" }, fakeTheme()), "b:EUR 1.00");
});
