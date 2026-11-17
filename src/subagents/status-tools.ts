import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ThemeColor,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatDuration } from "../lib/format.ts";
import { OFF_PROFILE_NAME } from "./agents.ts";
import { DEFAULT_TERMINAL_COLUMNS, MIN_DISPLAY_DURATION_MS, PROFILE_ENTRY_TYPE } from "./constants.ts";
import { capOutput, formatUsageStats, normalizeTitle, shortLabel, toolCallLabel } from "./format.ts";
import { chooseProfile } from "./profile-ui.ts";
import type { ProfileCommandDeps } from "./profile-ui.ts";
import type { JobRegistry, Job } from "./registry.ts";
import { openSubagentTail, renderFallbackResult, TruncatedText } from "./render.ts";
import {
  EVENT_LABEL_WIDTH,
  eventColor,
  eventKindLabel,
  formatEventSummary,
  formatEventTiming,
  formatLocalTime,
  formatStepTiming,
} from "./tail.ts";
import type { JobEvent, ToolCallInfo } from "./types.ts";

const StatusParams = Type.Object({
  jobId: Type.Optional(Type.Integer({ minimum: 1 })),
  since: Type.Optional(
    Type.Integer({ minimum: 0, description: "With jobId: return events after this cursor (a previous nextCursor)." }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 100, description: "With jobId: maximum events to return (default 20)." }),
  ),
  maxChars: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 2000,
      description: "With jobId: maximum event text characters (default 2000).",
    }),
  ),
});
const CancelParams = Type.Object({
  jobId: Type.Optional(Type.Integer({ minimum: 1 })),
  all: Type.Optional(Type.Boolean()),
});
const SendParams = Type.Object({
  jobId: Type.Integer({ minimum: 1 }),
  message: Type.String({ minLength: 1 }),
  deliverAs: Type.Union([Type.Literal("steer"), Type.Literal("followUp")]),
});
const ResumeParams = Type.Object({
  jobId: Type.Integer({ minimum: 1 }),
  message: Type.String({ minLength: 1, description: "What the child should do next, with any context it lacked" }),
});
const ReplyParams = Type.Object({
  jobId: Type.Integer({ minimum: 1 }),
  questionId: Type.String({ minLength: 1 }),
  answer: Type.String({ minLength: 1 }),
});

const JobStatus = Type.Union([
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);
const StatusOutput = Type.Object({
  text: Type.String(),
  jobId: Type.Optional(Type.Integer({ minimum: 1 })),
  jobs: Type.Array(
    Type.Object({
      jobId: Type.Integer({ minimum: 1 }),
      agent: Type.String(),
      status: JobStatus,
      label: Type.String(),
    }),
  ),
  events: Type.Optional(
    Type.Array(
      Type.Object({
        seq: Type.Integer({ minimum: 1 }),
        timestamp: Type.Number(),
        stepId: Type.Optional(Type.String()),
        startedAt: Type.Optional(Type.Number()),
        durationMs: Type.Optional(Type.Number()),
        kind: Type.Union([
          Type.Literal("assistant"),
          Type.Literal("tool-start"),
          Type.Literal("tool-end"),
          Type.Literal("question"),
          Type.Literal("state"),
        ]),
        summary: Type.String(),
      }),
      { maxItems: 100 },
    ),
  ),
  nextCursor: Type.Optional(Type.Integer({ minimum: 0 })),
  droppedBefore: Type.Optional(Type.Integer({ minimum: 1 })),
});

const MAX_STATUS_OUTPUT_CHARS = 4000;
const DEFAULT_EVENT_LIMIT = 20;
const DEFAULT_EVENT_CHARS = 2000;
const MAX_STATUS_TOOL_CALLS = 8;
const RECENT_JOB_LIMIT = 20;
const RECENT_JOB_WINDOW_MS = 60_000;

type StatusJob = Job;
type StatusLine =
  | { kind: "heading"; text: string }
  | {
      kind: "job";
      icon: string;
      color: "accent" | "success" | "warning" | "error";
      jobId: number;
      agent: string;
      meta: string;
      label: string;
      progress?: string;
    }
  | { kind: "field"; label: string; value: string }
  | { kind: "output"; color: "toolOutput" | "error"; text: string }
  | { kind: "question"; id: string; text: string }
  | { kind: "step"; text: string }
  | { kind: "toolCall"; prefix: string; call: ToolCallInfo }
  | { kind: "plain"; text: string };
interface StatusToolDetails {
  text: string;
  jobId?: number;
  sections?: StatusLine[];
  events?: JobEvent[];
  nextCursor?: number;
  droppedBefore?: number;
}
interface CancelTarget {
  jobId: number;
  agent: string;
  label: string;
}
interface CancelToolDetails {
  count: number;
  targets: CancelTarget[];
}
interface SendToolDetails {
  jobId: number;
  agent: string;
  task?: string;
  title?: string;
  label: string;
  message: string;
  deliverAs: "steer" | "followUp";
}
interface ResumeToolDetails {
  jobId: number;
  agent: string;
  label: string;
  message: string;
}
interface ReplyToolDetails {
  jobId: number;
  agent?: string;
  task?: string;
  title?: string;
  questionId: string;
  question: string;
  answer: string;
}

function jobLabel(job: Pick<Job, "title" | "task">, max = 80): string {
  return shortLabel(normalizeTitle(job.title), normalizeTitle(job.task), max);
}

function jobTarget(job: Pick<Job, "id" | "agent" | "title" | "task">): string {
  return `#${job.id} ${job.agent} · ${shortLabel(normalizeTitle(job.title), normalizeTitle(job.task), Infinity)}`;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  const text = result.content[0];
  return text?.type === "text" ? (text.text ?? "") : "";
}

// String fields each kind needs to render; saved transcripts may hold sections from another version.
const STATUS_LINE_STRING_FIELDS: Record<StatusLine["kind"], string[]> = {
  heading: ["text"],
  job: ["icon", "color", "agent", "meta", "label"],
  field: ["label", "value"],
  output: ["color", "text"],
  question: ["id", "text"],
  step: ["text"],
  toolCall: ["prefix"],
  plain: ["text"],
};

function isStatusLine(value: unknown): value is StatusLine {
  if (!value || typeof value !== "object") return false;
  const line = value as Record<string, unknown>;
  const fields = Object.hasOwn(STATUS_LINE_STRING_FIELDS, String(line.kind))
    ? STATUS_LINE_STRING_FIELDS[line.kind as StatusLine["kind"]]
    : undefined;
  if (!fields || !fields.every((field) => typeof line[field] === "string")) return false;
  return line.kind !== "toolCall" || typeof (line.call as { name?: unknown } | undefined)?.name === "string";
}

function renderStatusLines(lines: StatusLine[]): string {
  return lines
    .map((line) => {
      switch (line.kind) {
        case "heading":
          return `**${line.text}**`;
        case "job":
          return `- ${line.icon} #${line.jobId} ${line.agent} (${line.meta}): ${line.label}${line.progress ? ` — ${line.progress}` : ""}`;
        case "field":
          return line.value ? `${line.label}: ${line.value}` : `${line.label}:`;
        case "output":
          return line.text;
        case "question":
          return `- ${line.id}: ${line.text}`;
        case "step":
          return line.text;
        case "toolCall":
          return `${line.prefix}${toolCallLabel(line.call.name, line.call.args)}`;
        case "plain":
          return line.text;
      }
    })
    .join("\n");
}

function fieldValueColor(label: string, value: string): ThemeColor {
  if (label === "State")
    return value.includes("completed")
      ? "success"
      : value.includes("cancelled")
        ? "warning"
        : value.includes("failed")
          ? "error"
          : "accent";
  if (label === "Agent") return "accent";
  if (label === "Cancellation") return "warning";
  if (label === "Error") return "error";
  if (label === "Usage" || label === "Elapsed" || label === "Task" || label === "Progress") return "dim";
  return "muted";
}

function renderStatusSections(lines: StatusLine[], theme: Theme): Component {
  return {
    render(width: number) {
      const rendered = lines.map((line) => {
        switch (line.kind) {
          case "heading":
            return theme.fg("toolTitle", theme.bold(line.text));
          case "job":
            return (
              theme.fg(line.color, `${line.icon} `) +
              theme.fg("accent", `#${line.jobId} ${line.agent}`) +
              theme.fg("muted", ` (${line.meta})`) +
              theme.fg("dim", `: ${line.label}`) +
              (line.progress === undefined ? "" : theme.fg("muted", ` — ${line.progress}`))
            );
          case "field":
            return (
              theme.fg("muted", `${line.label}:`) +
              theme.fg(fieldValueColor(line.label, line.value), line.value ? ` ${line.value}` : "")
            );
          case "output":
            return line.text
              .split("\n")
              .map((text) => theme.fg(line.color, text))
              .join("\n");
          case "question":
            return theme.fg("dim", questionDisplay(line));
          case "step":
            return theme.fg("dim", line.text);
          case "toolCall":
            return theme.fg(
              "dim",
              truncateToWidth(
                `${line.prefix}${toolCallLabel(line.call.name, line.call.args, Math.max(0, width - visibleWidth(line.prefix)))}`,
                width,
                "…",
              ),
            );
          case "plain":
            return line.text ? theme.fg("muted", line.text) : "";
        }
      });
      return new Text(rendered.join("\n"), 0, 0).render(width);
    },
    invalidate() {},
  };
}

function questionDisplay(line: Extract<StatusLine, { kind: "question" }>): string {
  return line.text ? `- ${line.text}` : `- ${line.id}:`;
}

function isIdentityLine(line: StatusLine, job: Job): boolean {
  if (line.kind === "heading") return line.text === `Subagent #${job.id}`;
  if (line.kind !== "field") return false;
  if (line.label === "Agent") return line.value === job.agent;
  return (line.label === "Task" || line.label === "Title") && line.value === jobLabel(job, Infinity);
}

function outputLines(text: string, color: "toolOutput" | "error"): StatusLine[] {
  return [{ kind: "output", color, text: capOutput(text, MAX_STATUS_OUTPUT_CHARS) }];
}

function stepLines(job: Job, now: number): StatusLine[] {
  const steps = job.status === "running" ? job.steps.filter((step) => step.endedAt === undefined) : [];
  return steps.length === 0
    ? []
    : [
        { kind: "field", label: `Active steps (${steps.length})`, value: "" },
        ...steps.map((step): StatusLine => ({
          kind: "step",
          text: `- ${formatStepTiming(step, now)} · ${step.kind}: ${formatEventSummary({ kind: "assistant", summary: step.summary })}`,
        })),
      ];
}

function statusToolCalls(job: Job, now: number): { call: ToolCallInfo; prefix: string }[] {
  const steps = job.steps.filter((step) => step.kind === "tool" && step.toolCall);
  return steps.length > 0
    ? steps.map((step) => ({ call: step.toolCall!, prefix: `- ${formatStepTiming(step, job.endTime ?? now)} · ` }))
    : job.toolCalls.map((call) => ({ call, prefix: "- --:--:-- · " }));
}

function jobLines(job: StatusJob, now: number): StatusLine[] {
  if (job.status === "running") {
    const elapsed = formatDuration(Math.max(MIN_DISPLAY_DURATION_MS, now - job.startTime));
    const progress =
      job.pendingQuestions.length > 0
        ? "waiting for parent"
        : job.steps.some((step) => step.endedAt === undefined)
          ? undefined
          : job.progress;
    const metadata = formatUsageStats(undefined, job.model, job.thinkingLevel);
    return [
      {
        kind: "job",
        icon: "⊙",
        color: "accent",
        jobId: job.id,
        agent: job.agent,
        meta: `${formatLocalTime(job.startTime)} · ${elapsed}${metadata ? ` ${metadata}` : ""}`,
        label: jobLabel(job),
        ...(progress ? { progress } : {}),
      },
      ...stepLines(job, now),
    ];
  }
  const duration = job.endTime ? formatDuration(Math.max(MIN_DISPLAY_DURATION_MS, job.endTime - job.startTime)) : "?";
  const metadata = formatUsageStats(job.usage, job.model, job.thinkingLevel);
  return [
    {
      kind: "job",
      icon: job.status === "completed" ? "✓" : job.status === "cancelled" ? "⊘" : "✗",
      color: job.status === "completed" ? "success" : job.status === "cancelled" ? "warning" : "error",
      jobId: job.id,
      agent: job.agent,
      meta: `${formatLocalTime(job.startTime)} · ${duration}${metadata ? ` ${metadata}` : ""}`,
      label: jobLabel(job),
    },
  ];
}

function toolCallLines(job: Job, now: number): StatusLine[] {
  const calls = statusToolCalls(job, now);
  return calls.length === 0
    ? []
    : [
        { kind: "field", label: `Tool calls (${calls.length})`, value: "" },
        ...calls
          .slice(-MAX_STATUS_TOOL_CALLS)
          .map(({ call, prefix }): StatusLine => ({ kind: "toolCall", prefix, call })),
      ];
}

// Incremental reads (brief) repeat only what can change between calls, so following a job stays cheap.
function detailedLines(job: Job, now: number, brief = false): StatusLine[] {
  const duration = formatDuration(Math.max(MIN_DISPLAY_DURATION_MS, (job.endTime ?? now) - job.startTime));
  const metadata = formatUsageStats(job.usage, job.model, job.thinkingLevel);
  const title = normalizeTitle(job.title);
  const lines: StatusLine[] = [
    { kind: "heading", text: `Subagent #${job.id}` },
    { kind: "field", label: "State", value: job.status },
  ];
  if (!brief) {
    lines.push({ kind: "field", label: "Agent", value: job.agent });
    lines.push({ kind: "field", label: "Task", value: normalizeTitle(job.task) ?? "..." });
    if (title) lines.push({ kind: "field", label: "Title", value: title });
  }
  lines.push({ kind: "field", label: "Elapsed", value: duration });
  if (!brief) {
    lines.push({ kind: "field", label: "Started", value: formatLocalTime(job.startTime) });
    if (job.endTime !== undefined)
      lines.push({ kind: "field", label: "Finished", value: formatLocalTime(job.endTime) });
    if (metadata) lines.push({ kind: "field", label: "Usage", value: metadata });
  }
  if (job.pendingQuestions.length > 0) {
    lines.push({ kind: "field", label: `Waiting for parent (${job.pendingQuestions.length})`, value: "" });
    for (const question of job.pendingQuestions)
      lines.push({ kind: "question", id: question.id, text: question.question });
  } else if (job.progress && !job.steps.some((step) => step.endedAt === undefined))
    lines.push({ kind: "field", label: "Progress", value: job.progress });
  lines.push(...stepLines(job, now));
  if (brief)
    return job.cancellationReason
      ? [...lines, { kind: "field", label: "Cancellation", value: job.cancellationReason }]
      : lines;
  lines.push(...toolCallLines(job, now));
  if (job.text)
    lines.push({ kind: "field", label: "Latest output", value: "" }, ...outputLines(job.text, "toolOutput"));
  if (job.cancellationReason) lines.push({ kind: "field", label: "Cancellation", value: job.cancellationReason });
  if (job.error) lines.push({ kind: "field", label: "Error", value: "" }, ...outputLines(job.error, "error"));
  return lines;
}

function statusLines(registry: JobRegistry, now: number): StatusLine[] {
  const running = registry.running();
  const recent = registry.recent(RECENT_JOB_LIMIT).filter((j) => j.endTime && now - j.endTime < RECENT_JOB_WINDOW_MS);
  const lines: StatusLine[] =
    running.length > 0
      ? [{ kind: "heading", text: `Running (${running.length}):` }, ...running.flatMap((job) => jobLines(job, now))]
      : [{ kind: "plain", text: "**Running:** none" }];
  if (recent.length > 0)
    lines.push(
      { kind: "plain", text: "" },
      { kind: "heading", text: `Recent (${recent.length}):` },
      ...recent.flatMap((job) => jobLines(job, now)),
    );
  return lines;
}

export function createStatusTool(deps: {
  registry: JobRegistry;
}): ToolDefinition<typeof StatusParams, StatusToolDetails> {
  return {
    name: "subagent_status",
    label: "Subagent Status",
    description:
      "List running and recently finished subagents, or pass jobId to inspect one job: its details plus recent events.",
    promptGuidelines: [
      "Use subagent_status with a jobId to inspect a job. Pass nextCursor as since to get only new events and a short header (state, elapsed, questions, progress, active steps). Results arrive automatically; do not poll for normal completion.",
    ],
    parameters: StatusParams,
    outputSchema: StatusOutput,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const now = Date.now();
      if (params.jobId === undefined) {
        const sections = statusLines(deps.registry, now);
        const text = renderStatusLines(sections);
        const jobs = [
          ...deps.registry.running(),
          ...deps.registry
            .recent(RECENT_JOB_LIMIT)
            .filter((item) => item.endTime && now - item.endTime < RECENT_JOB_WINDOW_MS),
        ];
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            text,
            jobs: jobs.map((item) => ({
              jobId: item.id,
              agent: item.agent,
              status: item.status,
              label: jobLabel(item, 80),
            })),
          },
          details: { text, sections },
        };
      }
      const job = deps.registry.get(params.jobId);
      const read = job
        ? deps.registry.readEvents(job.id, { since: params.since, limit: params.limit ?? DEFAULT_EVENT_LIMIT })
        : undefined;
      if (!job || !read) throw new Error(`Unknown subagent job ID: ${params.jobId}`);
      const maxChars = params.maxChars ?? DEFAULT_EVENT_CHARS;
      const events: JobEvent[] = [];
      const structuredEvents: JobEvent[] = [];
      const eventLines: string[] = [];
      const droppedNotice =
        read.droppedBefore === undefined ? undefined : `[history dropped before ${read.droppedBefore}]`;
      if (droppedNotice && droppedNotice.length <= maxChars) eventLines.push(droppedNotice);
      for (const event of read.events) {
        const summary = formatEventSummary(event);
        const timing = formatEventTiming(event, job, now);
        const line = `[${event.seq}] ${timing.timestamp} ${summary}${timing.suffix}`;
        const body = eventLines.length > 0 ? `${eventLines.join("\n")}\n${line}` : line;
        if (body.length > maxChars) break;
        events.push({ ...event });
        structuredEvents.push({ ...event, summary });
        eventLines.push(line);
      }
      const nextCursor = events.at(-1)?.seq ?? params.since ?? 0;
      const cursor = `nextCursor: ${nextCursor}`;
      const compactCursor = `cursor:${nextCursor}`;
      const eventBody = eventLines.join("\n");
      const eventText = !eventBody
        ? cursor.length <= maxChars
          ? cursor
          : compactCursor.length <= maxChars
            ? compactCursor
            : ""
        : eventBody.length + cursor.length + 1 <= maxChars
          ? `${eventBody}\n${cursor}`
          : eventBody.length + compactCursor.length + 1 <= maxChars
            ? `${eventBody}\n${compactCursor}`
            : eventBody;
      const sections = detailedLines(job, now, params.since !== undefined);
      const statusText = renderStatusLines(sections);
      const text = eventText ? `${statusText}\nEvents:\n${eventText}` : statusText;
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          text,
          jobId: job.id,
          jobs: [{ jobId: job.id, agent: job.agent, status: job.status, label: jobLabel(job, 160) }],
          events: structuredEvents.map((event) => ({ ...event })),
          nextCursor,
          ...(read.droppedBefore !== undefined ? { droppedBefore: read.droppedBefore } : {}),
        },
        details: { text, jobId: job.id, sections, events, nextCursor, droppedBefore: read.droppedBefore },
      };
    },
    renderCall(args, theme, _context) {
      const job = args.jobId === undefined ? undefined : deps.registry.get(args.jobId);
      const target = job ? jobTarget(job) : args.jobId === undefined ? "all" : `#${args.jobId}`;
      return new TruncatedText(
        theme.fg("toolTitle", theme.bold("subagent status ")) + theme.fg("accent", target),
        0,
        0,
      );
    },
    renderResult(result, _options, theme, context) {
      const details = result.details;
      const args = context.args ?? {};
      const job = args.jobId === undefined ? undefined : deps.registry.get(args.jobId);
      const target = job ? jobTarget(job) : args.jobId === undefined ? "all" : `#${args.jobId}`;
      const text = typeof details?.text === "string" ? details.text : resultText(result);
      const saved = Array.isArray(details?.sections)
        ? details.sections.filter(isStatusLine)
        : typeof details?.text === "string"
          ? // Results saved before typed sections kept only their text.
            details.text.split("\n").map((line): StatusLine => ({ kind: "plain", text: line }))
          : undefined;
      if (context.isError || !saved) {
        return renderFallbackResult("subagent status", target, text, "(no status)", !context.args, theme);
      }
      const sections =
        context.args && job && details?.jobId === job.id ? saved.filter((line) => !isIdentityLine(line, job)) : saved;
      const status = renderStatusSections(sections, theme);
      if (!Array.isArray(details?.events) || typeof details.nextCursor !== "number") return status;
      const events = details.events.filter(
        (event): event is JobEvent =>
          typeof event?.seq === "number" &&
          typeof event.timestamp === "number" &&
          typeof event.kind === "string" &&
          typeof event.summary === "string",
      );
      const { droppedBefore, nextCursor } = details;
      const jobId = details.jobId;
      return {
        render(width: number) {
          const job = jobId === undefined ? undefined : deps.registry.get(jobId);
          const now = Date.now();
          const lines: string[] = [theme.fg("muted", "Events:")];
          if (typeof droppedBefore === "number") {
            lines.push(theme.fg("warning", `history dropped before event ${droppedBefore}`));
          }
          if (events.length === 0) {
            lines.push(theme.fg("dim", "no new events"));
          } else {
            for (const event of events) {
              const label = eventKindLabel(event.kind).padEnd(EVENT_LABEL_WIDTH);
              const timing = formatEventTiming(event, job, now);
              lines.push(
                `${theme.fg("dim", `[${event.seq}] ${timing.timestamp}`)} ${theme.fg(eventColor(event.kind), label)} ${theme.fg("muted", (formatEventSummary(event) || "(empty)") + timing.suffix)}`,
              );
            }
          }
          lines.push(theme.fg("dim", `cursor: ${nextCursor}`));
          return [...status.render(width), ...new Text(lines.join("\n"), 0, 0).render(width)];
        },
        invalidate() {},
      };
    },
  };
}

export function createCancelTool(deps: {
  registry: JobRegistry;
}): ToolDefinition<typeof CancelParams, CancelToolDetails> {
  return {
    name: "subagent_cancel",
    label: "Subagent Cancel",
    description: "Cancel one subagent by jobId, or all running subagents with all: true.",
    parameters: CancelParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (params.all && params.jobId !== undefined) throw new Error("Specify either jobId or all, not both.");
      if (!params.all && params.jobId === undefined) throw new Error("Pass jobId or all: true");
      const requestedJob = params.jobId === undefined ? undefined : deps.registry.get(params.jobId);
      if (params.jobId !== undefined && !requestedJob) throw new Error(`Unknown subagent job ID: ${params.jobId}`);
      const jobs = requestedJob ? [requestedJob] : deps.registry.running();
      const targets = jobs.map((job) => ({ jobId: job.id, agent: job.agent, label: jobLabel(job, Infinity) }));
      const targetText =
        targets.length > 0
          ? targets.map((target) => `#${target.jobId} ${target.agent} · ${target.label}`).join(", ")
          : "none";
      const count = requestedJob ? (deps.registry.cancel(requestedJob.id) ? 1 : 0) : deps.registry.cancelAll();
      if (count === 0) {
        return {
          content: [
            {
              type: "text",
              text: `subagent cancel ${targetText}: ${params.jobId === undefined ? "no subagents are running" : "no running subagent"}.`,
            },
          ],
          details: { count, targets },
        };
      }
      return {
        content: [{ type: "text", text: `Cancelling ${count} subagent${count > 1 ? "s" : ""}: ${targetText}.` }],
        details: { count, targets },
      };
    },
    renderCall(args, theme, _context) {
      const job = args.jobId === undefined ? undefined : deps.registry.get(args.jobId);
      const target = args.all || args.jobId === undefined ? "all" : job ? jobTarget(job) : `#${args.jobId}`;
      return new TruncatedText(
        theme.fg("toolTitle", theme.bold("subagent cancel ")) + theme.fg("accent", target),
        0,
        0,
      );
    },
    renderResult(result, _options, theme, context) {
      const details = result.details;
      const args = context.args ?? {};
      const targetJob = args.jobId === undefined ? undefined : deps.registry.get(args.jobId);
      const target = args.all || args.jobId === undefined ? "all" : targetJob ? jobTarget(targetJob) : `#${args.jobId}`;
      if (context.isError || !details || typeof details.count !== "number" || !Array.isArray(details.targets)) {
        return renderFallbackResult(
          "subagent cancel",
          target,
          resultText(result),
          "No matching subagents.",
          !context.args,
          theme,
        );
      }
      if (details.count === 0) {
        if (context.args) {
          return new Text(
            theme.fg("muted", args.jobId === undefined ? "no subagents are running" : "no running subagent"),
            0,
            0,
          );
        }
        const box = new Container();
        box.addChild(
          new TruncatedText(theme.fg("toolTitle", theme.bold("subagent cancel ")) + theme.fg("accent", target), 0, 0),
        );
        box.addChild(
          new TruncatedText(theme.fg("muted", normalizeTitle(resultText(result)) ?? "no running subagents"), 2, 0),
        );
        return box;
      }
      const box = new Container();
      box.addChild(
        new Text(
          theme.fg("warning", "⊘ ") +
            theme.fg("muted", `cancelling ${details.count} subagent${details.count > 1 ? "s" : ""}`),
          0,
          0,
        ),
      );
      for (const item of details.targets) {
        if (
          details.count === 1 &&
          details.targets.length === 1 &&
          !args.all &&
          targetJob &&
          args.jobId === item.jobId &&
          target === `#${item.jobId} ${item.agent} · ${item.label}`
        )
          continue;
        box.addChild(
          new TruncatedText(
            theme.fg("accent", `#${item.jobId} ${item.agent}`) + theme.fg("dim", ` · ${item.label}`),
            2,
            0,
          ),
        );
      }
      return box;
    },
  };
}

export function createSendTool(deps: { registry: JobRegistry }): ToolDefinition<typeof SendParams, SendToolDetails> {
  return {
    name: "subagent_send",
    label: "Subagent Send",
    description: "Send a steering or follow-up message to a running subagent.",
    promptGuidelines: [
      'Use subagent_send only for running jobs. deliverAs must be "steer" to adjust the current run or "followUp" to queue another child turn.',
      "subagent_send does not answer ask_parent questions; use subagent_reply for those.",
    ],
    parameters: SendParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!params.message.trim()) throw new Error("Subagent message cannot be empty.");
      const job = deps.registry.get(params.jobId);
      if (!job) throw new Error(`Unknown subagent job ID: ${params.jobId}`);
      await deps.registry.send(params.jobId, params.message, params.deliverAs);
      const mode = params.deliverAs === "followUp" ? "follow-up" : "steering";
      return {
        content: [{ type: "text", text: `Sent ${mode} message to subagent ${jobTarget(job)}.` }],
        details: {
          jobId: params.jobId,
          agent: job.agent,
          task: job.task,
          title: job.title,
          label: jobLabel(job, Infinity),
          message: params.message,
          deliverAs: params.deliverAs,
        },
      };
    },
    renderCall(args, theme, _context) {
      const job = deps.registry.get(args.jobId);
      const mode = args.deliverAs === "followUp" ? "follow-up" : "steering";
      const target = job ? jobTarget(job) : `#${args.jobId ?? "…"}`;
      const box = new Container();
      box.addChild(
        new TruncatedText(
          theme.fg("toolTitle", theme.bold("subagent send ")) +
            theme.fg("accent", target) +
            theme.fg("muted", ` · ${mode}`),
          0,
          0,
        ),
      );
      box.addChild(new TruncatedText(theme.fg("dim", normalizeTitle(args.message) ?? ""), 2, 0));
      return box;
    },
    renderResult(result, _options, theme, context) {
      const details = result.details;
      const args = context.args ?? {};
      const job = args.jobId === undefined ? undefined : deps.registry.get(args.jobId);
      const targetInCall = job ? jobTarget(job) : `#${args.jobId ?? "?"}`;
      const target =
        details && typeof details.jobId === "number"
          ? `#${details.jobId} ${details.agent ?? job?.agent ?? "subagent"} · ${details.label ?? jobLabel(job ?? { title: undefined, task: "..." }, Infinity)}`
          : targetInCall;
      if (
        context.isError ||
        !details ||
        typeof details.jobId !== "number" ||
        typeof details.agent !== "string" ||
        typeof details.label !== "string" ||
        (details.deliverAs !== "steer" && details.deliverAs !== "followUp")
      ) {
        return renderFallbackResult(
          "subagent send",
          target,
          resultText(result),
          "(no result)",
          !context.args || target !== targetInCall,
          theme,
        );
      }
      return new TruncatedText(
        theme.fg("success", "✓ ") +
          theme.fg("muted", target === targetInCall ? "delivered" : "delivered to ") +
          (target === targetInCall ? "" : theme.fg("accent", target)),
        0,
        0,
      );
    },
  };
}

export function createResumeTool(deps: {
  registry: JobRegistry;
}): ToolDefinition<typeof ResumeParams, ResumeToolDetails> {
  return {
    name: "subagent_resume",
    label: "Subagent Resume",
    description:
      "Continue a finished, failed, or cancelled subagent's conversation with a new message. Returns immediately; the new result arrives later as a follow-up message.",
    promptGuidelines: [
      "Use subagent_resume when a finished subagent stopped short or got something wrong; it keeps the child's earlier context, so say only what is missing or wrong.",
    ],
    parameters: ResumeParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!params.message.trim()) throw new Error("Subagent message cannot be empty.");
      const job = deps.registry.get(params.jobId);
      if (!job) throw new Error(`Unknown subagent job ID: ${params.jobId}`);
      deps.registry.resume(params.jobId, params.message);
      return {
        content: [{ type: "text", text: `Resumed subagent ${jobTarget(job)}.` }],
        details: { jobId: params.jobId, agent: job.agent, label: jobLabel(job, Infinity), message: params.message },
      };
    },
    renderCall(args, theme, _context) {
      const job = deps.registry.get(args.jobId);
      const box = new Container();
      box.addChild(
        new TruncatedText(
          theme.fg("toolTitle", theme.bold("subagent resume ")) +
            theme.fg("accent", job ? jobTarget(job) : `#${args.jobId ?? "…"}`),
          0,
          0,
        ),
      );
      box.addChild(new TruncatedText(theme.fg("dim", normalizeTitle(args.message) ?? ""), 2, 0));
      return box;
    },
    renderResult(result, _options, theme, context) {
      const details = result.details;
      if (context.isError || !details || typeof details.jobId !== "number") {
        return renderFallbackResult(
          "subagent resume",
          `#${context.args?.jobId ?? "?"}`,
          resultText(result),
          "(no result)",
          !context.args,
          theme,
        );
      }
      return new TruncatedText(theme.fg("success", "✓ ") + theme.fg("muted", "resumed"), 0, 0);
    },
  };
}

export function createReplyTool(deps: { registry: JobRegistry }): ToolDefinition<typeof ReplyParams, ReplyToolDetails> {
  return {
    name: "subagent_reply",
    label: "Subagent Reply",
    description: "Answer one pending question from a running subagent.",
    promptGuidelines: [
      "When a subagent question arrives, answer it with subagent_reply. If user direction is needed, call ask_user first and relay the answer.",
    ],
    parameters: ReplyParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!params.answer.trim()) throw new Error("Subagent reply cannot be empty.");
      if (!deps.registry.get(params.jobId)) throw new Error(`Unknown subagent job ID: ${params.jobId}`);
      const question = deps.registry.get(params.jobId)?.pendingQuestions.find((item) => item.id === params.questionId);
      await deps.registry.reply(params.jobId, params.questionId, params.answer);
      const targetJob = deps.registry.get(params.jobId);
      const target = targetJob ? jobTarget(targetJob) : `#${params.jobId}`;
      return {
        content: [{ type: "text", text: `Answered subagent ${target}.` }],
        details: {
          jobId: params.jobId,
          agent: targetJob?.agent,
          task: targetJob?.task,
          title: targetJob?.title,
          questionId: params.questionId,
          question: question?.question ?? "(question unavailable)",
          answer: params.answer,
        },
      };
    },
    renderCall(args, theme, _context) {
      const job = deps.registry.get(args.jobId);
      const target = job ? jobTarget(job) : `#${args.jobId ?? "…"}`;
      return new TruncatedText(theme.fg("toolTitle", theme.bold("subagent reply ")) + theme.fg("accent", target), 0, 0);
    },
    renderResult(result, _options, theme, context) {
      const details = result.details;
      const args = context.args ?? {};
      const job = args.jobId === undefined ? undefined : deps.registry.get(args.jobId);
      const targetInCall = job ? jobTarget(job) : `#${args.jobId ?? "?"}`;
      const target =
        details && typeof details.jobId === "number"
          ? `#${details.jobId} ${details.agent ?? job?.agent ?? "subagent"}${details.title || details.task ? ` · ${shortLabel(normalizeTitle(details.title), normalizeTitle(details.task), Infinity)}` : ""}`
          : targetInCall;
      if (
        context.isError ||
        !details ||
        typeof details.jobId !== "number" ||
        typeof details.question !== "string" ||
        typeof details.answer !== "string"
      ) {
        return renderFallbackResult(
          "subagent reply",
          target,
          resultText(result),
          "(no result)",
          !context.args || target !== targetInCall,
          theme,
        );
      }
      const question = normalizeTitle(details.question) ?? "(question unavailable)";
      const answer = normalizeTitle(details.answer) ?? "(empty)";
      const box = new Container();
      box.addChild(
        new TruncatedText(
          theme.fg("success", "✓ ") +
            theme.fg("muted", "answered") +
            (target === targetInCall ? "" : theme.fg("muted", " · ") + theme.fg("accent", target)),
          0,
          0,
        ),
      );
      box.addChild(new TruncatedText(theme.fg("muted", "Q: ") + theme.fg("dim", question), 2, 0));
      box.addChild(new TruncatedText(theme.fg("muted", "A: ") + theme.fg("dim", answer), 2, 0));
      return box;
    },
  };
}

function pickerLabel(job: Job): string {
  const label = `#${job.id} ${job.agent} [${job.status}] · ${shortLabel(job.title, job.task, Infinity)}`;
  return shortLabel(undefined, label, Math.max(1, (process.stdout.columns ?? DEFAULT_TERMINAL_COLUMNS) - 4));
}

async function pickJob(
  ctx: ExtensionContext,
  jobs: Job[],
  prompt: string,
  emptyMessage: string,
): Promise<Job | undefined> {
  if (jobs.length === 0) {
    ctx.ui.notify(emptyMessage, "info");
    return undefined;
  }
  const options = jobs.map(pickerLabel);
  const selected = await ctx.ui.select(prompt, options);
  if (!selected) return undefined;
  return jobs[options.indexOf(selected)];
}

function parseJobId(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const jobId = Number(raw);
  return Number.isSafeInteger(jobId) && jobId >= 1 ? jobId : undefined;
}

export function registerStatusCommands(
  pi: ExtensionAPI,
  deps: { registry: JobRegistry; profiles?: ProfileCommandDeps },
): void {
  const switchProfile = async (requested: string, ctx: ExtensionContext): Promise<void> => {
    const profiles = deps.profiles;
    if (!profiles) return;
    const names = [...Object.keys(profiles.settings.profiles), OFF_PROFILE_NAME];
    const current = profiles.getActiveProfile() ?? "none";
    let name: string | undefined = requested.trim();
    if (!name) {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify(`Active subagent profile: ${current}. Available: ${names.join(", ") || "none"}`, "info");
        return;
      }
      name = await chooseProfile(pi, profiles, ctx);
      if (!name) return;
    } else {
      if (name !== OFF_PROFILE_NAME && !Object.hasOwn(profiles.settings.profiles, name)) {
        if (ctx.hasUI) ctx.ui.notify(`Unknown subagent profile "${name}". Available: ${names.join(", ")}`, "error");
        return;
      }
      profiles.setActiveProfile(name);
      pi.appendEntry(PROFILE_ENTRY_TYPE, { name });
      if (ctx.hasUI)
        ctx.ui.notify(
          name === OFF_PROFILE_NAME
            ? "Subagents turned off. New launches are blocked."
            : `Subagent profile switched to ${name}. New jobs will use it.`,
          "info",
        );
    }
    // A launch-triggered choice reaches the agent through the tool result, so only manual switches send
    // this. It joins the context without starting a turn.
    pi.sendMessage({
      customType: PROFILE_ENTRY_TYPE,
      content:
        name === OFF_PROFILE_NAME
          ? "The user turned subagents off. Do not launch subagents until the user turns them back on."
          : `The user switched the subagent profile to ${name}. Subagents are available.`,
      display: true,
    });
  };

  pi.registerCommand("subagent-profile", {
    description: "Show or switch the active subagent profile",
    handler: (args, ctx) => switchProfile(args, ctx),
  });

  if (deps.profiles) {
    pi.registerShortcut("ctrl+shift+l", {
      description: "Open the subagent profile picker",
      handler: (ctx) => switchProfile("", ctx),
    });
  }

  pi.registerCommand("subagent-tail", {
    description: "Open a live event tail for a subagent by ID",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        if (ctx.hasUI) ctx.ui.notify("/subagent-tail requires interactive mode", "error");
        return;
      }
      const value = args.trim();
      let jobId: number;
      if (!value) {
        const job = await pickJob(
          ctx,
          [...deps.registry.running(), ...deps.registry.recent(RECENT_JOB_LIMIT)],
          "Tail subagent",
          "No subagents are available.",
        );
        if (!job) return;
        jobId = job.id;
      } else {
        const parsed = parseJobId(value);
        if (parsed === undefined) {
          ctx.ui.notify("Usage: /subagent-tail <numeric-job-id>", "error");
          return;
        }
        if (!deps.registry.get(parsed)) {
          ctx.ui.notify(`Unknown subagent job ID: ${parsed}`, "error");
          return;
        }
        jobId = parsed;
      }
      await openSubagentTail(ctx.ui, deps.registry, jobId);
    },
  });

  pi.registerCommand("subagent-cancel", {
    description: "Cancel one subagent by ID, or all running subagents",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (!value) {
        if (ctx.mode !== "tui" || !ctx.hasUI) {
          if (ctx.hasUI) ctx.ui.notify("Usage: /subagent-cancel <numeric-job-id|all>", "error");
          return;
        }
        const job = await pickJob(
          ctx,
          deps.registry.running(),
          "Cancel subagent",
          "No running subagents are available.",
        );
        if (!job) return;
        const count = deps.registry.cancel(job.id) ? 1 : 0;
        ctx.ui.notify(count ? `Cancelling 1 subagent: ${jobTarget(job)}.` : "No matching running subagent", "info");
        return;
      }
      let job: Job | undefined;
      if (value !== "all") {
        const jobId = parseJobId(value);
        if (jobId === undefined) {
          ctx.ui.notify("Usage: /subagent-cancel <numeric-job-id|all>", "error");
          return;
        }
        job = deps.registry.get(jobId);
        if (!job) {
          ctx.ui.notify(`Unknown subagent job ID: ${jobId}`, "error");
          return;
        }
      }
      const targets = (job ? [job] : deps.registry.running()).map(jobTarget).join(", ");
      const count = job ? (deps.registry.cancel(job.id) ? 1 : 0) : deps.registry.cancelAll();
      ctx.ui.notify(
        count ? `Cancelling ${count} subagent${count > 1 ? "s" : ""}: ${targets}.` : "No matching running subagent",
        "info",
      );
    },
  });

  pi.registerCommand("subagent-send", {
    description: "Send a steering or follow-up message to a running subagent",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const raw = args.trim();
      let jobId: number | undefined;
      let mode: string | undefined;
      let message: string | undefined;
      if (!raw) {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("Usage: /subagent-send <numeric-job-id> <steer|followup> <message>", "error");
          return;
        }
        const job = await pickJob(
          ctx,
          deps.registry.running(),
          "Send to subagent",
          "No running subagents are available.",
        );
        if (!job) return;
        jobId = job.id;
        const selectedMode = await ctx.ui.select("Message mode", ["steering", "follow-up"]);
        if (!selectedMode) return;
        mode = selectedMode === "steering" ? "steer" : "followup";
        message = (
          await ctx.ui.input(`${selectedMode} message for #${job.id} ${job.agent}`, "Enter a message")
        )?.trim();
        if (!message) return;
      } else {
        const match = raw.match(/^(\d+)\s+(\S+)(?:\s+([\s\S]*))?$/);
        mode = match?.[2]?.toLowerCase();
        message = match?.[3]?.trim();
        jobId = match?.[1] === undefined ? undefined : parseJobId(match[1]);
        if (!match || !message || (mode !== "steer" && mode !== "followup")) {
          ctx.ui.notify("Usage: /subagent-send <numeric-job-id> <steer|followup> <message>", "error");
          return;
        }
      }
      if (jobId === undefined) {
        ctx.ui.notify("Usage: /subagent-send <numeric-job-id> <steer|followup> <message>", "error");
        return;
      }
      const job = deps.registry.get(jobId);
      if (!job) {
        ctx.ui.notify(`Unknown subagent job ID: ${jobId}`, "error");
        return;
      }
      const deliverAs = mode === "steer" ? "steer" : "followUp";
      try {
        await deps.registry.send(jobId, message, deliverAs);
        ctx.ui.notify(
          `Sent ${deliverAs === "steer" ? "steering" : "follow-up"} message to subagent ${jobTarget(job)}.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
