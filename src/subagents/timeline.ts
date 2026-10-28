import { toolCallLabel } from "./format.ts";
import {
  assistantText,
  normalizeToolArgs,
  sanitizeToolCallArgs,
  truncateStrings,
} from "./jsonl.ts";
import type { JobEventInput, JobStepInput } from "./types.ts";

const MAX_EVENT_SUMMARY = 500;

function flattenSummary(value: string): string {
  const flattened = value.replace(/\s+/g, " ").trim();
  return flattened.length > MAX_EVENT_SUMMARY
    ? `${flattened.slice(0, MAX_EVENT_SUMMARY - 1)}…`
    : flattened;
}

function valueSummary(value: unknown): string {
  if (typeof value === "string") return flattenSummary(String(truncateStrings(value)));
  let serialized: string;
  try {
    serialized = JSON.stringify(truncateStrings(value)) ?? String(value);
  } catch {
    serialized = String(value);
  }
  return flattenSummary(serialized);
}

function toolName(event: Record<string, unknown>): string {
  const nested = event.toolCall;
  const call = nested && typeof nested === "object" ? nested as Record<string, unknown> : undefined;
  return String(event.toolName ?? event.name ?? call?.toolName ?? call?.name ?? "tool");
}

function toolArgs(event: Record<string, unknown>): Record<string, unknown> {
  const nested = event.toolCall;
  const call = nested && typeof nested === "object" ? nested as Record<string, unknown> : undefined;
  return normalizeToolArgs(event.args ?? event.arguments ?? event.input ?? call?.args ?? call?.arguments);
}

function toolStartSummary(event: Record<string, unknown>): string {
  const name = toolName(event);
  const args = truncateStrings(sanitizeToolCallArgs(name, toolArgs(event))) as Record<string, unknown>;
  return flattenSummary(toolCallLabel(name, args));
}

function toolEndSummary(event: Record<string, unknown>): string {
  const name = toolName(event);
  const isError = event.isError === true || event.success === false || event.error !== undefined;
  const status = isError ? "error" : "success";
  const detail = isError ? event.error ?? event.result : event.result;
  if ((name === "write" || name === "edit") && !isError) return flattenSummary(`${name} success`);
  return flattenSummary(detail === undefined
    ? `${name} ${status}`
    : `${name} ${status}: ${valueSummary(detail)}`);
}

interface TimelineCallbacks {
  onEvent?: (event: JobEventInput) => void;
  onStep?: (step: JobStepInput) => void;
}

/**
 * Record one child agent's timeline: its assistant, tool, and retry steps plus
 * the summarized events each step emits. Create one per child run: step
 * numbering and the open assistant and retry steps are per-timeline state, so a
 * shared timeline would attach one run's steps to another.
 */
export function createTimeline(callbacks: TimelineCallbacks) {
  // The runner calls these from its child-process stdout and close handlers, so
  // a callback exception must not escape: it would crash this pi process and
  // strand the child run.
  const safeEvent = (event: JobEventInput) => {
    try {
      callbacks.onEvent?.(event);
    } catch (err) {
      console.error("subagents: event callback failed", err);
    }
  };
  const safeStep = (step: JobStepInput) => {
    try {
      callbacks.onStep?.(step);
    } catch (err) {
      console.error("subagents: step callback failed", err);
    }
  };
  let nextStepId = 1;
  let assistantStepId: string | undefined;
  let retryStepId: string | undefined;
  const toolSteps = new Map<string, string>();
  const startAssistant = () => {
    if (assistantStepId) return;
    const retryId = retryStepId;
    retryStepId = undefined;
    if (retryId) safeStep({ phase: "end", id: retryId });
    assistantStepId = `assistant-${nextStepId++}`;
    safeStep({ phase: "start", id: assistantStepId, kind: "assistant", summary: "Assistant response" });
  };
  const endAssistant = () => {
    const id = assistantStepId;
    assistantStepId = undefined;
    if (id) safeStep({ phase: "end", id });
    return id;
  };
  const toolExecutionStart = (event: Record<string, unknown>) => {
    const summary = toolStartSummary(event);
    const callId = typeof event.toolCallId === "string" && event.toolCallId ? event.toolCallId : undefined;
    let stepId = callId ? toolSteps.get(callId) : undefined;
    if (callId && !stepId) {
      stepId = `tool-${nextStepId++}`;
      toolSteps.set(callId, stepId);
      const name = toolName(event);
      const args = truncateStrings(sanitizeToolCallArgs(name, toolArgs(event))) as Record<string, unknown>;
      safeStep({ phase: "start", id: stepId, kind: "tool", summary, toolCall: { name, args } });
    }
    safeEvent({ kind: "tool-start", summary, ...(stepId ? { stepId } : {}) });
  };
  const toolExecutionEnd = (event: Record<string, unknown>) => {
    const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
    const stepId = toolSteps.get(callId);
    if (stepId) {
      toolSteps.delete(callId);
      safeStep({ phase: "end", id: stepId });
    }
    safeEvent({ kind: "tool-end", summary: toolEndSummary(event), ...(stepId ? { stepId } : {}) });
  };
  const autoRetryStart = () => {
    endAssistant();
    if (retryStepId) safeStep({ phase: "end", id: retryStepId });
    retryStepId = `retry-${nextStepId++}`;
    safeStep({ phase: "start", id: retryStepId, kind: "retry", summary: "Retry wait" });
    safeEvent({ kind: "state", summary: "retrying", stepId: retryStepId });
  };
  const autoRetryEnd = () => {
    const stepId = retryStepId;
    retryStepId = undefined;
    if (stepId) safeStep({ phase: "end", id: stepId });
    safeEvent({ kind: "state", summary: "retry ended", ...(stepId ? { stepId } : {}) });
  };
  const assistantMessageEnd = (message: unknown) => {
    if (message && typeof message === "object" && (message as { role?: unknown }).role === "assistant") {
      const stepId = endAssistant();
      const text = assistantText((message as { content?: unknown }).content);
      if (text) safeEvent({ kind: "assistant", summary: flattenSummary(text), ...(stepId ? { stepId } : {}) });
    }
  };
  return {
    safeEvent,
    startAssistant,
    toolExecutionStart,
    toolExecutionEnd,
    autoRetryStart,
    autoRetryEnd,
    assistantMessageEnd,
  };
}
