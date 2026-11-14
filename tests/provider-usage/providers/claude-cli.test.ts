import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fetchClaudeCliUsage, normalizeClaudeUsage } from "../../../src/provider-usage/providers/claude-cli.ts";
import { claudeCapturedAt, claudeOutput, mockCli } from "../../helpers/claude-cli.ts";

test("publishes only aggregate Claude CLI quotas and timezone-aware resets", () => {
  assert.deepEqual(
    normalizeClaudeUsage(
      "claude-bridge",
      `${claudeOutput}\nCurrent week (Sonnet): 20% used\nTop skills: secret\n50% of your usage was at >150k context`,
      claudeCapturedAt,
    ),
    {
      provider: "claude-bridge",
      state: "ready",
      capturedAtMs: claudeCapturedAt,
      windows: [
        { kind: "rolling", label: "5h", usedPercent: 10, resetAtMs: Date.parse("2026-10-07T18:59:00Z") },
        { kind: "weekly", label: "7d", usedPercent: 12, resetAtMs: Date.parse("2026-10-13T10:59:00Z") },
      ],
    },
  );
});

test("handles Claude CLI color, zero usage, and partial quotas without requiring reset text", () => {
  assert.deepEqual(
    normalizeClaudeUsage("claude-bridge", "\u001b[32mCurrent session: 0% used\u001b[0m", claudeCapturedAt)?.windows,
    [{ kind: "rolling", label: "5h", usedPercent: 0 }],
  );
  assert.deepEqual(
    normalizeClaudeUsage("claude-bridge", "Current week (all models): 12.5% used", claudeCapturedAt)?.windows,
    [{ kind: "weekly", label: "7d", usedPercent: 12.5 }],
  );
  assert.deepEqual(
    normalizeClaudeUsage(
      "claude-bridge",
      "Current session: -5% used\nCurrent week (all models): 105% used",
      claudeCapturedAt,
    )?.windows,
    [
      { kind: "rolling", label: "5h", usedPercent: 0 },
      { kind: "weekly", label: "7d", usedPercent: 100 },
    ],
  );
});

test("does not mistake Claude local usage insights or unsupported quota output for account limits", () => {
  for (const value of [
    null,
    {},
    [],
    "",
    "You are currently using your subscription",
    "50% of your usage was at >150k context",
    "Current week (Sonnet): 10% used",
    "Current session: NaN% used",
    "Current session: Infinity% used",
    "Current session: lots% used",
  ]) {
    assert.equal(normalizeClaudeUsage("claude-bridge", value, claudeCapturedAt), undefined);
  }
});

test("omits invalid Claude CLI resets without losing quota percentages", () => {
  for (const reset of [
    "not a date",
    "Oct 7 at 12:59pm (Invalid/Zone)",
    "Feb 30 at 12:59pm (UTC)",
    "Oct 0 at 12:59pm (UTC)",
    "Oct 7 at 13:59pm (UTC)",
    "Oct 7 at 12:60pm (UTC)",
    "Oct 7 at 0:59am (UTC)",
  ]) {
    assert.deepEqual(
      normalizeClaudeUsage("claude-bridge", `Current session: 10% used · resets ${reset}`, claudeCapturedAt)?.windows,
      [{ kind: "rolling", label: "5h", usedPercent: 10 }],
    );
  }
  const spring = Date.parse("2026-03-08T07:00:00Z");
  assert.equal(
    normalizeClaudeUsage("claude-bridge", "Current session: 10% used · resets Mar 8 at 2:30am (America/Boise)", spring)
      ?.windows[0]?.resetAtMs,
    undefined,
  );
});

test("interprets Claude reset dates across daylight saving, year boundaries, and times without minutes", () => {
  for (const [now, reset, expected] of [
    ["2026-03-08T07:00:00Z", "Mar 8 at 3:30am (America/Boise)", "2026-03-08T09:30:00Z"],
    ["2026-12-31T23:00:00Z", "Jan 1 at 12:30am (America/Boise)", "2027-01-01T07:30:00Z"],
    ["2027-01-01T03:00:00Z", "Dec 31 at 6:00pm (America/Boise)", "2027-01-01T01:00:00Z"],
    ["2026-11-13T14:00:00Z", "Nov 17 at 4am (America/Boise)", "2026-11-17T11:00:00Z"],
  ] as const) {
    assert.equal(
      normalizeClaudeUsage("claude-bridge", `Current session: 10% used · resets ${reset}`, Date.parse(now))?.windows[0]
        ?.resetAtMs,
      Date.parse(expected),
    );
  }
});

test("fetches Claude CLI usage despite inherited traffic restrictions with bounded execution", async (t) => {
  const previous = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    else process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = previous;
  });
  const calls = mockCli(t, (call) => call.complete(null, claudeOutput));
  const controller = new AbortController();
  const usage = await fetchClaudeCliUsage("claude-bridge", controller.signal);
  const cli = calls[0];
  assert.deepEqual(
    usage.windows.map((window) => [window.label, window.usedPercent]),
    [
      ["5h", 10],
      ["7d", 12],
    ],
  );
  assert.equal(cli?.file, "claude");
  assert.deepEqual(cli?.args, [
    "--settings",
    '{"remoteControlAtStartup":false,"disableAllHooks":true}',
    "--strict-mcp-config",
    "--tools",
    "",
    "--setting-sources",
    "",
    "/usage",
  ]);
  assert.deepEqual(cli?.options, {
    env: {
      ...process.env,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_AUTOUPDATER: "1",
    },
    encoding: "utf8",
    signal: controller.signal,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    killSignal: "SIGKILL",
  });
  assert.equal(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(cli?.stdinClosed, true);
});

test("rejects failed Claude CLI probes and output without quotas without exposing stderr", async (t) => {
  for (const [name, error, stdout] of [
    ["nonzero exit", new Error("secret credentials in stderr"), claudeOutput],
    ["missing executable", Object.assign(new Error("missing executable"), { code: "ENOENT" }), ""],
    [
      "output buffer exceeded",
      Object.assign(new Error("secret output"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
      "",
    ],
    ["no account quota", null, "50% of your usage was at >150k context"],
  ] as const) {
    await t.test(name, async (t) => {
      const calls = mockCli(t, (call) => call.complete(error, stdout));
      await assert.rejects(fetchClaudeCliUsage("claude-bridge", new AbortController().signal), (error: Error) => {
        assert.doesNotMatch(error.message, /secret|credentials/);
        return true;
      });
      assert.equal(calls[0]?.stdinClosed, true);
    });
  }
});

test("dates Claude CLI usage by when the CLI fetched it", async (t) => {
  const now = claudeCapturedAt;
  for (const [name, state, capturedAtMs] of [
    ["fetched five minutes ago", { cachedUsageUtilization: { fetchedAtMs: now - 300_000 } }, now - 300_000],
    ["no fetch time recorded", {}, now],
  ] as const) {
    await t.test(name, async (t) => {
      mockCli(t, (call) => call.complete(null, claudeOutput));
      t.mock.method(Date, "now", () => now);
      t.mock.method(fs, "readFile", async () => JSON.stringify(state));
      const usage = await fetchClaudeCliUsage("claude-code", new AbortController().signal);
      assert.equal(usage.capturedAtMs, capturedAtMs);
    });
  }
});

test("rejects Claude CLI usage that the CLI fetched more than five minutes ago", async (t) => {
  const now = claudeCapturedAt;
  mockCli(t, (call) => call.complete(null, claudeOutput));
  t.mock.method(Date, "now", () => now);
  t.mock.method(fs, "readFile", async () => JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: now - 300_001 } }));
  await assert.rejects(fetchClaudeCliUsage("claude-code", new AbortController().signal), /out of date/);
});

function mockSavedUsage(t: TestContext, capturedAtMs: number): string[] {
  const saved = {
    provider: "claude-bridge",
    state: "ready",
    capturedAtMs,
    windows: [{ kind: "rolling", label: "5h", usedPercent: 50 }],
  };
  t.mock.method(fs, "readFile", async (path: string) => {
    if (!path.endsWith("pi-guy-claude-usage.json")) throw new Error("no Claude Code file");
    return JSON.stringify(saved);
  });
  const writes: string[] = [];
  t.mock.method(fs, "writeFile", async (_path: string, data: string) => {
    writes.push(data);
  });
  return writes;
}

test("reuses a reading saved in the last five minutes without running the Claude CLI", async (t) => {
  const now = claudeCapturedAt;
  const calls = mockCli(t, (call) => call.complete(null, claudeOutput));
  t.mock.method(Date, "now", () => now);
  const writes = mockSavedUsage(t, now - 300_000);
  const usage = await fetchClaudeCliUsage("claude-code", new AbortController().signal);
  assert.equal(usage.provider, "claude-code");
  assert.equal(usage.windows[0]?.usedPercent, 50);
  assert.equal(calls.length, 0);
  assert.deepEqual(writes, []);
});

test("runs the Claude CLI when the saved reading is over five minutes old and saves only complete readings", async (t) => {
  const now = claudeCapturedAt;
  for (const [name, output, saves] of [
    ["both windows", claudeOutput, true],
    ["one window", "Current session: 10% used", false],
  ] as const) {
    await t.test(name, async (t) => {
      const calls = mockCli(t, (call) => call.complete(null, output));
      t.mock.method(Date, "now", () => now);
      const writes = mockSavedUsage(t, now - 300_001);
      const usage = await fetchClaudeCliUsage("claude-code", new AbortController().signal);
      assert.equal(usage.windows[0]?.usedPercent, 10);
      assert.equal(calls.length, 1);
      assert.deepEqual(writes, saves ? [JSON.stringify(usage)] : []);
    });
  }
});

test("does not start the Claude CLI for an already aborted request", async (t) => {
  const calls = mockCli(t, (call) => call.complete(null, claudeOutput));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchClaudeCliUsage("claude-bridge", controller.signal), { name: "AbortError" });
  assert.equal(calls.length, 0);
});

test("cancels an in-flight Claude CLI request through its abort signal", async (t) => {
  const calls = mockCli(t, () => {});
  const controller = new AbortController();
  const request = fetchClaudeCliUsage("claude-bridge", controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  assert.equal(calls[0]?.options.signal.aborted, true);
  assert.equal(calls[0]?.stdinClosed, true);
});
