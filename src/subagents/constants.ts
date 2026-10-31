import type { SubagentUsage } from "./types.ts";

export const ASK_PARENT_TITLE_PREFIX = "subagents:ask-parent:";
export const ENTRY_TYPE = "subagents";
export const QUESTION_ENTRY_TYPE = "subagent-question";
export const PROFILE_ENTRY_TYPE = "subagent-profile";
export const EMPTY_USAGE: SubagentUsage = {
  turns: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
};
