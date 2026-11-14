import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { decodeUsageStatus, encodeUsageStatus, normalizeUsagePercent } from "../../lib/usage-status.ts";
import type { UsageStatus, UsageWindow } from "../../lib/usage-status.ts";
import { asNumber, asObject, REQUEST_TIMEOUT_MS } from "../http.ts";

const MAX_CLAUDE_OUTPUT_BYTES = 64 * 1024;
const CLAUDE_STATE_FILE = ".claude.json";
const SAVED_USAGE_FILE = "pi-guy-claude-usage.json";
const MAX_READING_AGE_MS = 300_000;
const MAX_YEAR_ROLLOVER_MONTHS = 6;
const MAX_TIMEZONE_ADJUST_ATTEMPTS = 3;

type ClaudeCliProvider = "claude-code" | "claude-bridge";

function parseReset(reset: string, capturedAt: number): number | undefined {
  const match = /^(\w{3}) (\d{1,2}) at (\d{1,2})(?::(\d{2}))?(am|pm) \(([^)]+)\)$/i.exec(reset.trim());
  if (!match) return undefined;
  const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(
    match[1]!.toLowerCase(),
  );
  const day = Number(match[2]);
  const clockHour = Number(match[3]);
  // The CLI leaves the minutes off times on the hour, such as "4am".
  const minute = Number(match[4] ?? 0);
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
  provider: ClaudeCliProvider,
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

/** Returns when the CLI last fetched the usage it prints, or undefined when its state file does not say. */
async function readCliUsageFetchedAt(signal: AbortSignal): Promise<number | undefined> {
  try {
    // The default state file sits beside ~/.claude, not inside it.
    const dir = process.env.CLAUDE_CONFIG_DIR || homedir();
    const state: unknown = JSON.parse(await fs.readFile(join(dir, CLAUDE_STATE_FILE), { encoding: "utf8", signal }));
    return asNumber(asObject(asObject(state)?.cachedUsageUtilization)?.fetchedAtMs);
  } catch {
    return undefined;
  }
}

/**
 * Saves a reading for other pi sessions on the same Claude login to reuse instead of running the CLI.
 * Skips a reading without both the 5-hour and 7-day windows, so other sessions never show half of one.
 * Never rejects: a reading that cannot be saved is only a missed shortcut.
 */
export async function saveClaudeUsage(usage: UsageStatus): Promise<void> {
  if (!(["rolling", "weekly"] as const).every((kind) => usage.windows.some((window) => window.kind === kind))) return;
  try {
    await fs.writeFile(join(getAgentDir(), SAVED_USAGE_FILE), encodeUsageStatus(usage));
  } catch {
    // Another session's next reading will replace it.
  }
}

async function readSavedClaudeUsage(
  provider: ClaudeCliProvider,
  signal: AbortSignal,
): Promise<UsageStatus | undefined> {
  try {
    const path = join(getAgentDir(), SAVED_USAGE_FILE);
    const usage = decodeUsageStatus(await fs.readFile(path, { encoding: "utf8", signal }));
    if (usage?.state !== "ready" || usage.windows.length === 0) return undefined;
    const age = Date.now() - usage.capturedAtMs;
    return age >= 0 && age <= MAX_READING_AGE_MS ? { ...usage, provider } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads plan usage for the Claude login and labels it with provider.
 * Returns a reading that any pi session saved in the last five minutes, and otherwise runs `claude /usage`.
 * With savedOnly, never runs the CLI and rejects when no such saved reading exists.
 * When its own usage request fails, the CLI prints its last saved reading without marking it,
 * so capturedAtMs is the time the CLI fetched the reading whenever its state file records one.
 * Rejects when the CLI fails, prints no quotas, prints a reading more than five minutes old, or signal aborts.
 */
export async function fetchClaudeCliUsage(
  provider: ClaudeCliProvider,
  signal: AbortSignal,
  savedOnly = false,
): Promise<UsageStatus> {
  signal.throwIfAborted();
  const saved = await readSavedClaudeUsage(provider, signal);
  signal.throwIfAborted();
  if (saved) return saved;
  if (savedOnly) throw new Error("No saved Claude usage reading");
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
  const fetchedAt = await readCliUsageFetchedAt(signal);
  signal.throwIfAborted();
  if (fetchedAt !== undefined && Date.now() - fetchedAt > MAX_READING_AGE_MS)
    throw new Error("Claude usage CLI reading is out of date");
  const usage = normalizeClaudeUsage(provider, output, fetchedAt);
  if (!usage) throw new Error("Claude usage response has no rate limits");
  await saveClaudeUsage(usage);
  return usage;
}
