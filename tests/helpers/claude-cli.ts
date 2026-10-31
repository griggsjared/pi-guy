import childProcess from "node:child_process";
import type { TestContext } from "node:test";

export const claudeCapturedAt = Date.parse("2026-10-07T16:00:00Z");
export const claudeOutput = [
  "You are currently using your subscription to power your Claude Code usage",
  "Current session: 10% used · resets Oct 7 at 12:59pm (America/Boise)",
  "Current week (all models): 12% used · resets Oct 13 at 4:59am (America/Boise)",
].join("\n");

export type CliCall = {
  file: string;
  args: string[];
  options: { signal: AbortSignal };
  stdinClosed: boolean;
  complete(error: Error | null, stdout: string): void;
};

export function mockCli(t: TestContext, load: (call: CliCall) => void): CliCall[] {
  const calls: CliCall[] = [];
  t.mock.method(childProcess, "execFile", (file: string, args: string[], options: any, callback: any) => {
    const call: CliCall = { file, args, options, stdinClosed: false, complete: (error, stdout) => callback(error, stdout, "secret stderr") };
    calls.push(call);
    options.signal.addEventListener("abort", () => call.complete(options.signal.reason, ""), { once: true });
    queueMicrotask(() => load(call));
    return { stdin: { end() { call.stdinClosed = true; } } } as any;
  });
  return calls;
}
