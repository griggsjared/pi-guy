import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeOpencodeGoUsage } from "../../../src/statusline/providers/opencode.ts";

const capturedAt = 1_700_000_000_000;

test("parses nested OpenCode Go hydration data", () => {
  const html = `<script>self.__next_f.push([1,"{\\"props\\":{\\"rollingUsage\\":{\\"usagePercent\\":12.5,\\"resetInSec\\":30},\\"nested\\":{\\"weeklyUsage\\":{\\"usagePercent\\":40,\\"resetInSec\\":3600}},\\"monthlyUsage\\":{\\"usagePercent\\":101,\\"resetInSec\\":7200}}}"]);</script>`;
  const usage = normalizeOpencodeGoUsage(html, capturedAt);
  assert.deepEqual(usage?.windows, [
    { kind: "rolling", label: "5h", usedPercent: 12.5, resetAtMs: capturedAt + 30_000 },
    { kind: "weekly", label: "7d", usedPercent: 40, resetAtMs: capturedAt + 3_600_000 },
    { kind: "monthly", label: "30d", usedPercent: 100, resetAtMs: capturedAt + 7_200_000 },
  ]);
});

test("parses data-slot usage item HTML fallback", () => {
  const html = `<section data-slot="usage-item"><h2>Rolling Usage</h2><span>12.5%</span><p>resets in 30 minutes</p></section><div data-slot="usage-item"><b>Weekly Usage</b> 40% resets in 2 hours</div>`;
  assert.deepEqual(normalizeOpencodeGoUsage(html, capturedAt)?.windows, [
    { kind: "rolling", label: "5h", usedPercent: 12.5, resetAtMs: capturedAt + 1_800_000 },
    { kind: "weekly", label: "7d", usedPercent: 40, resetAtMs: capturedAt + 7_200_000 },
  ]);
});

test("parses nested data-slot usage item HTML", () => {
  const html = `<div data-slot="usage-item"><div><strong>Monthly Usage</strong></div><div><span>55%</span><p>resets in 2 days 3 hours</p></div></div>`;
  assert.deepEqual(normalizeOpencodeGoUsage(html, capturedAt)?.windows, [
    { kind: "monthly", label: "30d", usedPercent: 55, resetAtMs: capturedAt + 183_600_000 },
  ]);
});

test("merges fallback windows only when hydration is partial", () => {
  const html = `<script>rollingUsage:{usagePercent:10,resetInSec:30}</script><section data-slot="usage-item"><b>Rolling Usage</b> 99% resets in 1 hour</section><div data-slot="usage-item"><b>Weekly Usage</b> 40% resets in 2 hours</div>`;
  assert.deepEqual(normalizeOpencodeGoUsage(html, capturedAt)?.windows, [
    { kind: "rolling", label: "5h", usedPercent: 10, resetAtMs: capturedAt + 30_000 },
    { kind: "weekly", label: "7d", usedPercent: 40, resetAtMs: capturedAt + 7_200_000 },
  ]);
});

test("parses Solid Seroval hydration with references and unquoted keys", () => {
  const html = `<script>_$HY.r["lite.subscription.get"]=$R[1]={rollingUsage:$R[2]={status:"ok",resetInSec:30,usagePercent:12.5},weeklyUsage:$R[3]={status:"ok",resetInSec:3600,usagePercent:40},monthlyUsage:$R[4]={status:"rate-limited",resetInSec:7200,usagePercent:50}};</script>`;
  const usage = normalizeOpencodeGoUsage(html, capturedAt);
  assert.deepEqual(usage?.windows, [
    { kind: "rolling", label: "5h", usedPercent: 12.5, resetAtMs: capturedAt + 30_000 },
    { kind: "weekly", label: "7d", usedPercent: 40, resetAtMs: capturedAt + 3_600_000 },
    { kind: "monthly", label: "30d", usedPercent: 50, resetAtMs: capturedAt + 7_200_000 },
  ]);
});

test("validates OpenCode reset values", () => {
  assert.equal(normalizeOpencodeGoUsage(`rollingUsage:{usagePercent:10,resetInSec:-1}`, capturedAt), undefined);
  assert.equal(normalizeOpencodeGoUsage(`rollingUsage:{usagePercent:10,resetInSec:1e308}`, capturedAt), undefined);
  assert.equal(
    normalizeOpencodeGoUsage(`rollingUsage:{usagePercent:10,resetInSec:0}`, capturedAt)?.windows[0]?.resetAtMs,
    capturedAt,
  );
  assert.equal(
    normalizeOpencodeGoUsage(`rollingUsage:{usagePercent:10,resetInSec:.5}`, capturedAt)?.windows[0]?.resetAtMs,
    capturedAt + 500,
  );
});

test("bounds malformed hydration scanning", () => {
  const fragments = Array.from({ length: 300 }, () => `rollingUsage:{${"x".repeat(16_000)}`).join(";");
  const started = performance.now();
  assert.equal(normalizeOpencodeGoUsage(fragments, capturedAt), undefined);
  assert.ok(performance.now() - started < 500, "malformed hydration should be bounded");
});

test("rejects invalid OpenCode fields and omits unrelated secrets", () => {
  assert.equal(
    normalizeOpencodeGoUsage(`<div>rollingUsage: {"usagePercent":"secret","resetInSec":1}</div>`),
    undefined,
  );
  const usage = normalizeOpencodeGoUsage(
    `<div>rollingUsage: {"usagePercent":10,"resetInSec":1,"authCookie":"secret"}</div>`,
  );
  assert.equal(JSON.stringify(usage).includes("secret"), false);
});
