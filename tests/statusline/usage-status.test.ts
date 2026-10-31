import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeUsageStatus,
  encodeUsageStatus,
  isQuotaProvider,
  isUsageProvider,
  normalizeUsagePercent,
} from "../../src/statusline/usage-status.ts";

const readyStatus = {
  provider: "openai-codex" as const,
  state: "ready" as const,
  capturedAtMs: 1_000,
  windows: [{ kind: "rolling" as const, label: "5h", usedPercent: 42.5, resetAtMs: 2_000 }],
};

test("distinguishes quota providers from balance providers", () => {
  assert.equal(isUsageProvider("deepseek"), true);
  assert.equal(isQuotaProvider("deepseek"), false);
  assert.equal(isQuotaProvider("openai-codex"), true);
  assert.equal(isQuotaProvider("opencode-go"), true);
  assert.equal(isQuotaProvider("anthropic"), true);
});

test("recognizes claude-bridge quota status and round trips Claude windows", () => {
  const status = {
    provider: "claude-bridge" as const,
    state: "ready" as const,
    capturedAtMs: 1_000,
    windows: [
      { kind: "rolling" as const, label: "5h", usedPercent: 12.5, resetAtMs: 2_000 },
      { kind: "weekly" as const, label: "7d", usedPercent: 40, resetAtMs: 3_000 },
    ],
  };
  assert.equal(isQuotaProvider("claude-bridge"), true);
  assert.deepEqual(decodeUsageStatus(encodeUsageStatus(status)), status);
});

test("accepts valid balances and rejects invalid balances in decoded status", () => {
  for (const balance of [
    { amount: 1, currency: "USD" },
    { amount: 0, currency: "CNY" },
  ]) {
    const status = { ...readyStatus, balance };
    assert.deepEqual(decodeUsageStatus(JSON.stringify(status)), status);
  }
  for (const balance of [
    { amount: 1, currency: "usd" },
    { amount: -1, currency: "USD" },
    { amount: Number.NaN, currency: "USD" },
    { amount: 1 },
  ]) {
    assert.equal(decodeUsageStatus(JSON.stringify({ ...readyStatus, balance })), undefined);
  }
});

test("round trips a usage status", () => {
  assert.deepEqual(decodeUsageStatus(encodeUsageStatus(readyStatus)), readyStatus);
});

test("rejects malformed JSON and invalid usage shapes", () => {
  assert.equal(decodeUsageStatus("not json"), undefined);
  assert.equal(decodeUsageStatus(JSON.stringify({ ...readyStatus, provider: "other" })), undefined);
  assert.equal(decodeUsageStatus(JSON.stringify({ ...readyStatus, capturedAtMs: -1 })), undefined);
  assert.equal(
    decodeUsageStatus(
      JSON.stringify({
        ...readyStatus,
        windows: [{ ...readyStatus.windows[0]!, usedPercent: Number.NaN }],
      }),
    ),
    undefined,
  );
  assert.equal(
    decodeUsageStatus(
      JSON.stringify({
        ...readyStatus,
        windows: [{ ...readyStatus.windows[0]!, resetAtMs: 0 }],
      }).replace('"resetAtMs":0', '"resetAtMs":1e400'),
    ),
    undefined,
  );
});

test("accepts optional reset timestamps and unknown status without windows", () => {
  const unknown = {
    provider: "opencode-go" as const,
    state: "unknown" as const,
    windows: [],
    capturedAtMs: 0,
  };
  const noReset = { ...readyStatus, windows: [{ kind: "weekly" as const, label: "7d", usedPercent: 0 }] };
  assert.deepEqual(decodeUsageStatus(JSON.stringify(unknown)), unknown);
  assert.deepEqual(decodeUsageStatus(JSON.stringify(noReset)), noReset);
});

test("normalizes percentages and rejects non-numbers", () => {
  assert.equal(normalizeUsagePercent(-10), 0);
  assert.equal(normalizeUsagePercent(125), 100);
  assert.equal(normalizeUsagePercent(42), 42);
  assert.equal(normalizeUsagePercent(Infinity), undefined);
  assert.equal(normalizeUsagePercent("42"), undefined);
});

test("round trips a balance status and rejects invalid balances", () => {
  assert.equal(isUsageProvider("deepseek"), true);
  const balanceStatus = {
    provider: "deepseek" as const,
    state: "ready" as const,
    capturedAtMs: 1_000,
    windows: [],
    balance: { amount: 110, currency: "USD" },
  };
  assert.deepEqual(decodeUsageStatus(encodeUsageStatus(balanceStatus)), balanceStatus);
  for (const balance of [
    { amount: -1, currency: "USD" },
    { amount: 1, currency: "usd" },
    { amount: Number.NaN, currency: "USD" },
  ]) {
    assert.equal(decodeUsageStatus(JSON.stringify({ ...balanceStatus, balance })), undefined);
  }
});
