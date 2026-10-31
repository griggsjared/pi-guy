import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAnthropicHeaders } from "../../../src/statusline/providers/anthropic.ts";

const capturedAt = 1_700_000_000_000;

test("normalizes Anthropic unified rate-limit headers", () => {
  assert.deepEqual(normalizeAnthropicHeaders({
    "anthropic-ratelimit-unified-5h-utilization": "0.12",
    "anthropic-ratelimit-unified-5h-reset": "1700000000",
    "anthropic-ratelimit-unified-7d-utilization": "0.4",
  }, capturedAt), {
    provider: "anthropic", state: "ready", capturedAtMs: capturedAt,
    windows: [
      { kind: "rolling", label: "5h", usedPercent: 12, resetAtMs: 1_700_000_000_000 },
      { kind: "weekly", label: "7d", usedPercent: 40 },
    ],
  });
  assert.equal(normalizeAnthropicHeaders({ "anthropic-ratelimit-unified-5h-utilization": "" }, capturedAt), undefined);
  assert.equal(normalizeAnthropicHeaders({ "content-type": "text/event-stream" }, capturedAt), undefined);
});
