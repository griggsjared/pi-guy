import type { SubagentUsage } from "./types.ts";

export const ASK_PARENT_TITLE_PREFIX = "subagents:ask-parent:";
export const ASK_PARENT_TOOL_NAME = "ask_parent";
export const ENTRY_TYPE = "subagents";
export const QUESTION_ENTRY_TYPE = "subagent-question";
export const PROFILE_ENTRY_TYPE = "subagent-profile";
export const DEFAULT_TERMINAL_COLUMNS = 80;
// Cancelled jobs report the shell's SIGINT status (128 + 2), matching an interrupted run.
export const CANCELLED_EXIT_CODE = 130;
// Durations under a second still display as 1s.
export const MIN_DISPLAY_DURATION_MS = 1000;
export const EMPTY_USAGE: SubagentUsage = {
  turns: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
};
