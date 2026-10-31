import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCodexUsage } from "../../../src/statusline/providers/codex.ts";

const capturedAt = 1_700_000_000_000;

test("normalizes Codex field variants and classifies windows", () => {
  const usage = normalizeCodexUsage({ rate_limit: {
    primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: 1_700_000_123 },
    secondary_window: { usedPercent: 50, window_minutes: 10_080, resetAt: 1_700_001_234_000 },
  } }, capturedAt);
  assert.deepEqual(usage, {
    provider: "openai-codex", state: "ready", capturedAtMs: capturedAt,
    windows: [
      { kind: "rolling", label: "5h", usedPercent: 25, resetAtMs: 1_700_000_123_000 },
      { kind: "weekly", label: "7d", usedPercent: 50, resetAtMs: 1_700_001_234_000 },
    ],
  });
});

test("does not invent a Codex reset time", () => {
  const usage = normalizeCodexUsage({ rate_limit: { primary_window: { used_percent: 10 } } }, capturedAt);
  assert.equal(usage?.windows[0]?.resetAtMs, undefined);
});
