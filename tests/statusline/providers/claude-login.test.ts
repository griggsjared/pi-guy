import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchClaudeCodeUsage } from "../../../src/statusline/providers/claude-code.ts";
import {
  fetchClaudeLoginUsage,
  normalizeClaudeUsage,
  parseClaudeCredentials,
} from "../../../src/statusline/providers/claude-login.ts";
import { claudeCapturedAt, claudeOutput, mockCli } from "../../helpers/claude-cli.ts";

const context = {} as ExtensionContext;

function credentials(accessToken: string, expiresAt: number): string {
  return JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: "sk-ant-ort-secret", expiresAt } });
}

test("uses only unexpired Claude subscription tokens from stored credentials", () => {
  const now = 1_000;
  assert.equal(parseClaudeCredentials(credentials("sk-ant-oat-token", now + 1), now), "sk-ant-oat-token");
  assert.equal(parseClaudeCredentials(credentials("sk-ant-oat-token", now), now), undefined);
  assert.equal(
    parseClaudeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-token" } }), now),
    undefined,
  );
  assert.equal(
    parseClaudeCredentials(
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-token", expiresAt: "2000" } }),
      now,
    ),
    undefined,
  );
  assert.equal(
    parseClaudeCredentials('{"claudeAiOauth":{"accessToken":"sk-ant-oat-token","expiresAt":1e400}}', now),
    undefined,
  );
  assert.equal(parseClaudeCredentials(credentials("sk-ant-api-key", now + 1), now), undefined);
  assert.equal(parseClaudeCredentials("not json", now), undefined);
  assert.equal(parseClaudeCredentials("{}", now), undefined);
});

test("reads claude-code usage with Claude Code's stored login instead of the CLI", async (t) => {
  const calls = mockCli(t, (call) =>
    call.complete(null, call.file === "security" ? credentials("sk-ant-oat-token", Date.now() + 60_000) : ""),
  );
  const requests: Array<[string, RequestInit | undefined]> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    requests.push([url, init]);
    return Response.json({
      five_hour: { utilization: 9, resets_at: "2026-11-11T09:00:00Z" },
      seven_day: { utilization: 2 },
    });
  });
  const usage = await fetchClaudeCodeUsage(context, new AbortController().signal);
  assert.equal(usage.provider, "claude-code");
  assert.deepEqual(usage.windows, [
    { kind: "rolling", label: "5h", usedPercent: 9, resetAtMs: Date.parse("2026-11-11T09:00:00Z") },
    { kind: "weekly", label: "7d", usedPercent: 2 },
  ]);
  assert.deepEqual(
    calls.map((call) => [call.file, call.args]),
    [["security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]]],
  );
  assert.equal(requests[0]?.[0], "https://api.anthropic.com/api/oauth/usage");
  assert.equal((requests[0]?.[1]?.headers as Record<string, string>).Authorization, "Bearer sk-ant-oat-token");
});

test("skips the default Keychain login when Claude Code uses a custom config directory", async (t) => {
  const calls = mockCli(t, (call) => call.complete(null, claudeOutput));
  process.env.CLAUDE_CONFIG_DIR = "/custom/claude";
  const usage = await fetchClaudeCodeUsage(context, new AbortController().signal);
  assert.equal(usage.windows[0]?.usedPercent, 10);
  assert.deepEqual(
    calls.map((call) => call.file),
    ["claude"],
  );
});

test("falls back to the Claude CLI when the stored login is expired or rejected", async (t) => {
  for (const [name, expiresAt, status] of [
    ["expired token", -1, 200],
    ["rejected token", Number.MAX_SAFE_INTEGER, 401],
  ] as const) {
    await t.test(name, async (t) => {
      const calls = mockCli(t, (call) =>
        call.complete(null, call.file === "security" ? credentials("sk-ant-oat-token", expiresAt) : claudeOutput),
      );
      t.mock.method(globalThis, "fetch", async () => new Response("{}", { status }));
      const usage = await fetchClaudeCodeUsage(context, new AbortController().signal);
      assert.equal(usage.provider, "claude-code");
      assert.equal(usage.windows[0]?.usedPercent, 10);
      assert.deepEqual(
        calls.map((call) => call.file),
        ["security", "claude"],
      );
    });
  }
});

test("falls back to the Claude CLI when the saved-login usage request times out", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = mockCli(t, (call) =>
    call.complete(null, call.file === "security" ? credentials("sk-ant-oat-token", Date.now() + 60_000) : claudeOutput),
  );
  let fetchStarted!: () => void;
  const started = new Promise<void>((resolve) => (fetchStarted = resolve));
  t.mock.method(globalThis, "fetch", (_url: string, init?: RequestInit) => {
    fetchStarted();
    return new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const request = fetchClaudeCodeUsage(context, new AbortController().signal);
  await started;
  t.mock.timers.tick(5_000);
  const usage = await request;
  assert.equal(usage.windows[0]?.usedPercent, 10);
  assert.deepEqual(
    calls.map((call) => call.file),
    ["security", "claude"],
  );
});

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

test("interprets Claude reset dates across daylight saving and year boundaries", () => {
  for (const [now, reset, expected] of [
    ["2026-03-08T07:00:00Z", "Mar 8 at 3:30am (America/Boise)", "2026-03-08T09:30:00Z"],
    ["2026-12-31T23:00:00Z", "Jan 1 at 12:30am (America/Boise)", "2027-01-01T07:30:00Z"],
    ["2027-01-01T03:00:00Z", "Dec 31 at 6:00pm (America/Boise)", "2027-01-01T01:00:00Z"],
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
  const calls = mockCli(t, (call) => call.complete(null, call.file === "security" ? "{}" : claudeOutput));
  const controller = new AbortController();
  const usage = await fetchClaudeLoginUsage("claude-bridge", controller.signal);
  const cli = calls[1];
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
      const calls = mockCli(t, (call) =>
        call.complete(call.file === "security" ? null : error, call.file === "security" ? "{}" : stdout),
      );
      await assert.rejects(fetchClaudeLoginUsage("claude-bridge", new AbortController().signal), (error: Error) => {
        assert.doesNotMatch(error.message, /secret|credentials/);
        return true;
      });
      assert.equal(calls[1]?.stdinClosed, true);
    });
  }
});

test("does not start the Claude CLI for an already aborted request", async (t) => {
  const calls = mockCli(t, (call) => call.complete(null, claudeOutput));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchClaudeLoginUsage("claude-bridge", controller.signal), { name: "AbortError" });
  assert.equal(calls.length, 0);
});

test("cancels an in-flight Claude CLI request through its abort signal", async (t) => {
  const calls = mockCli(t, (call) => {
    if (call.file === "security") call.complete(null, "{}");
  });
  const controller = new AbortController();
  const request = fetchClaudeLoginUsage("claude-bridge", controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  assert.equal(calls[1]?.options.signal.aborted, true);
  assert.equal(calls[1]?.stdinClosed, true);
});
