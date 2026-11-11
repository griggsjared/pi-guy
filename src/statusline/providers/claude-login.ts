import childProcess from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { asNumber, asObject, REQUEST_TIMEOUT_MS } from "../http.ts";
import { normalizeUsagePercent } from "../usage-status.ts";
import type { UsageStatus, UsageWindow } from "../usage-status.ts";
import { requestAnthropicUsage } from "./anthropic.ts";

const SAVED_LOGIN_TIMEOUT_MS = 5_000;
const MAX_CLAUDE_OUTPUT_BYTES = 64 * 1024;
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_CREDENTIALS_FILE = ".credentials.json";
const MAX_YEAR_ROLLOVER_MONTHS = 6;
const MAX_TIMEZONE_ADJUST_ATTEMPTS = 3;

type ClaudeLoginProvider = "claude-code" | "claude-bridge";

function parseReset(reset: string, capturedAt: number): number | undefined {
  const match = /^(\w{3}) (\d{1,2}) at (\d{1,2}):(\d{2})(am|pm) \(([^)]+)\)$/i.exec(reset.trim());
  if (!match) return undefined;
  const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(
    match[1]!.toLowerCase(),
  );
  const day = Number(match[2]);
  const clockHour = Number(match[3]);
  const minute = Number(match[4]);
  if (month < 0 || day < 1 || day > 31 || clockHour < 1 || clockHour > 12 || minute > 59) return undefined;
  const hour = (clockHour % 12) + (match[5]!.toLowerCase() === "pm" ? 12 : 0);
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: match[6],
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const current = Object.fromEntries(
      formatter.formatToParts(capturedAt).map((part) => [part.type, Number(part.value)]),
    );
    const year =
      current.year! +
      (month + 1 - current.month! > MAX_YEAR_ROLLOVER_MONTHS
        ? -1
        : current.month! - month - 1 > MAX_YEAR_ROLLOVER_MONTHS
          ? 1
          : 0);
    const target = Date.UTC(year, month, day, hour, minute);
    if (new Date(target).getUTCMonth() !== month) return undefined;
    let instant = target;
    for (let attempt = 0; attempt < MAX_TIMEZONE_ADJUST_ATTEMPTS; attempt++) {
      const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, Number(part.value)]));
      const delta =
        target - Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
      if (delta === 0) return instant >= 0 ? instant : undefined;
      instant += delta;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function normalizeClaudeUsage(
  provider: ClaudeLoginProvider,
  payload: unknown,
  capturedAt = Date.now(),
): UsageStatus | undefined {
  if (typeof payload !== "string") return undefined;
  const text = stripVTControlCharacters(payload);
  const windows: UsageWindow[] = [];
  for (const [pattern, kind, label] of [
    [/^Current session:\s*(-?\d+(?:\.\d+)?)%\s+used\b(?:\s*[·—-]\s*resets\s+(.+))?/im, "rolling", "5h"],
    [/^Current week \(all models\):\s*(-?\d+(?:\.\d+)?)%\s+used\b(?:\s*[·—-]\s*resets\s+(.+))?/im, "weekly", "7d"],
  ] as const) {
    const match = pattern.exec(text);
    if (!match) continue;
    const usedPercent = normalizeUsagePercent(Number(match[1]));
    if (usedPercent === undefined) continue;
    const resetAtMs = match[2] === undefined ? undefined : parseReset(match[2], capturedAt);
    windows.push({ kind, label, usedPercent, ...(resetAtMs !== undefined ? { resetAtMs } : {}) });
  }
  return windows.length ? { provider, state: "ready", windows, capturedAtMs: capturedAt } : undefined;
}

async function fetchClaudeUsage(provider: ClaudeLoginProvider, signal: AbortSignal): Promise<UsageStatus> {
  signal.throwIfAborted();
  const output = await new Promise<string>((resolve, reject) => {
    // pi.exec lacks per-process env overrides, a 64 KiB output cap, and immediate SIGKILL.
    const child = childProcess.execFile(
      "claude",
      [
        "--settings",
        JSON.stringify({ remoteControlAtStartup: false, disableAllHooks: true }),
        "--strict-mcp-config",
        "--tools",
        "",
        "--setting-sources",
        "",
        "/usage",
      ],
      {
        env: {
          ...process.env,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "",
          DISABLE_TELEMETRY: "1",
          DISABLE_ERROR_REPORTING: "1",
          DISABLE_AUTOUPDATER: "1",
        },
        encoding: "utf8",
        signal,
        timeout: REQUEST_TIMEOUT_MS,
        maxBuffer: MAX_CLAUDE_OUTPUT_BYTES,
        killSignal: "SIGKILL",
      },
      (error, stdout) => {
        if (signal.aborted) reject(signal.reason);
        else if (error) reject(new Error("Claude usage CLI request failed"));
        else resolve(stdout);
      },
    );
    child.stdin?.end();
  });
  const usage = normalizeClaudeUsage(provider, output);
  if (!usage) throw new Error("Claude usage response has no rate limits");
  return usage;
}

/** Returns Claude Code's stored subscription access token while it is unexpired. */
export function parseClaudeCredentials(payload: string, now = Date.now()): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const oauth = asObject(asObject(parsed)?.claudeAiOauth);
  const token = oauth?.accessToken;
  const expiresAt = asNumber(oauth?.expiresAt);
  if (typeof token !== "string" || !token.startsWith("sk-ant-oat")) return undefined;
  return expiresAt !== undefined && expiresAt > now ? token : undefined;
}

async function readClaudeCredentials(signal: AbortSignal): Promise<string> {
  if (process.platform !== "darwin") {
    const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    return readFile(join(dir, CLAUDE_CREDENTIALS_FILE), { encoding: "utf8", signal });
  }
  // A custom config directory uses a suffixed Keychain service name, not the default account.
  if (process.env.CLAUDE_CONFIG_DIR) return "";
  return new Promise<string>((resolve, reject) => {
    // pi.exec is not reachable from usage adapters and lacks an output cap.
    const child = childProcess.execFile(
      "security",
      ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
      {
        encoding: "utf8",
        signal,
        timeout: REQUEST_TIMEOUT_MS,
        maxBuffer: MAX_CLAUDE_OUTPUT_BYTES,
        killSignal: "SIGKILL",
      },
      (error, stdout) => {
        if (signal.aborted) reject(signal.reason);
        else if (error) reject(new Error("Claude Code credentials are unavailable"));
        else resolve(stdout);
      },
    );
    child.stdin?.end();
  });
}

/**
 * Reads plan usage with Claude Code's saved login and labels it with provider.
 * Falls back to `claude /usage` when the saved login is unavailable, expired, rejected, or times out.
 * Never refreshes the token: refreshing replaces the refresh token and signs Claude Code out.
 * Rejects when the CLI fallback fails or signal aborts.
 */
export async function fetchClaudeLoginUsage(provider: ClaudeLoginProvider, signal: AbortSignal): Promise<UsageStatus> {
  signal.throwIfAborted();
  const local = new AbortController();
  // Leave time for the CLI fallback within the caller's deadline.
  const timer = setTimeout(() => local.abort(), SAVED_LOGIN_TIMEOUT_MS);
  const savedLoginSignal = AbortSignal.any([signal, local.signal]);
  try {
    const token = parseClaudeCredentials(await readClaudeCredentials(savedLoginSignal));
    savedLoginSignal.throwIfAborted();
    if (token) return { ...(await requestAnthropicUsage(token, savedLoginSignal)), provider };
  } catch {
    signal.throwIfAborted();
  } finally {
    clearTimeout(timer);
  }
  return fetchClaudeUsage(provider, signal);
}
