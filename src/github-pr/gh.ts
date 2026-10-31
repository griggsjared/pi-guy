import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Capability, PullRequest } from "./types.ts";

const COMMAND_TIMEOUT = 15_000;

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  killed?: boolean;
}

export function resultText(result: CommandResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
}

export async function runCommand(
  pi: ExtensionAPI,
  cwd: string,
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<CommandResult> {
  try {
    const result = await pi.exec(command, args, {
      cwd,
      timeout: COMMAND_TIMEOUT,
      signal,
    });
    return {
      code: result.killed ? -1 : result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      killed: result.killed,
    };
  } catch (error) {
    return {
      code: -1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

export function runGh(pi: ExtensionAPI, cwd: string, args: string[], signal?: AbortSignal): Promise<CommandResult> {
  return runCommand(pi, cwd, "gh", args, signal);
}

export function pullRequestSummary(pullRequest: PullRequest, capability: Extract<Capability, { available: true }>) {
  return {
    repository: capability.repo,
    number: pullRequest.number,
    title: pullRequest.title ?? "",
    body: pullRequest.body ?? "",
    url: pullRequest.url ?? "",
    state: pullRequest.state ?? "",
    draft: pullRequest.isDraft ?? false,
    author: pullRequest.author?.login ?? "unknown",
    baseBranch: pullRequest.baseRefName ?? "",
    headBranch: pullRequest.headRefName ?? "",
    reviewDecision: pullRequest.reviewDecision ?? null,
    createdAt: pullRequest.createdAt ?? "",
    updatedAt: pullRequest.updatedAt ?? "",
    changes: {
      additions: pullRequest.additions ?? 0,
      deletions: pullRequest.deletions ?? 0,
      changedFiles: pullRequest.changedFiles ?? 0,
    },
    mergeable: pullRequest.mergeable ?? "",
    mergeStateStatus: pullRequest.mergeStateStatus ?? "",
  };
}
