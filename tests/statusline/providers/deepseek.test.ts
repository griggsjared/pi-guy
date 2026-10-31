import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDeepseekUsage } from "../../../src/statusline/providers/deepseek.ts";

const capturedAt = 1_700_000_000_000;

test("normalizes DeepSeek balance responses", () => {
  assert.deepEqual(
    normalizeDeepseekUsage(
      {
        is_available: true,
        balance_infos: [
          { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
        ],
      },
      capturedAt,
    ),
    {
      provider: "deepseek",
      state: "ready",
      capturedAtMs: capturedAt,
      windows: [],
      balance: { amount: 110, currency: "CNY" },
    },
  );
  assert.deepEqual(
    normalizeDeepseekUsage({ balance_infos: [{ currency: "usd", total_balance: "7" }] }, capturedAt)?.balance,
    { amount: 7, currency: "USD" },
  );
  assert.deepEqual(
    normalizeDeepseekUsage(
      {
        balance_infos: [
          { currency: "CNY", total_balance: "0" },
          { currency: "USD", total_balance: "9.50" },
        ],
      },
      capturedAt,
    )?.balance,
    { amount: 9.5, currency: "USD" },
  );
  assert.deepEqual(
    normalizeDeepseekUsage(
      {
        balance_infos: [
          { currency: "USD", total_balance: "-1" },
          { currency: "CNY", total_balance: "3" },
        ],
      },
      capturedAt,
    )?.balance,
    { amount: 3, currency: "CNY" },
  );
  for (const totalBalance of ["", "  ", "0x10", "1,234.56", "oops"]) {
    assert.equal(
      normalizeDeepseekUsage({ balance_infos: [{ currency: "USD", total_balance: totalBalance }] }, capturedAt),
      undefined,
      totalBalance,
    );
  }
  assert.equal(
    normalizeDeepseekUsage({ balance_infos: [{ currency: "usd", total_balance: "oops" }] }, capturedAt),
    undefined,
  );
  assert.equal(normalizeDeepseekUsage({ balance_infos: [] }, capturedAt), undefined);
  assert.equal(normalizeDeepseekUsage({}, capturedAt), undefined);
});
