import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createJobRegistry } from "../../src/subagents/registry.ts";
import { resolveMode } from "../../src/subagents/tools.ts";
import { createPeekTool, createReplyTool } from "../../src/subagents/status-tools.ts";
import { QUESTION_ENTRY_TYPE } from "../../src/subagents/types.ts";
import {
  FakeChild,
  fakeSpawnChildren,
  endEvent,
  questionEvent,
  responseEvent,
} from "./fake-child.ts";
import type { SpawnCall } from "./fake-child.ts";
import { fakeTheme } from "../helpers/theme.ts";
import { flush, sleep, waitFor } from "../helpers/wait.ts";
import { makeTool, renderable, renderText } from "./helpers.ts";

test("resolveMode: single, batch, and validation", () => {
  assert.deepEqual(resolveMode({ agent: "a", task: "t", title: "x" }), {
    single: { agent: "a", task: "t", title: "x" },
  });
  assert.deepEqual(resolveMode({ tasks: [{ agent: "a", task: "t" }] }), {
    tasks: [{ agent: "a", task: "t" }],
  });
  assert.throws(() => resolveMode({}), /exactly one mode/);
  assert.throws(() => resolveMode({ agent: "a" }), /exactly one mode/); // agent without task is not a single
  assert.throws(
    () => resolveMode({ agent: "a", task: "t", tasks: [{ agent: "a", task: "t" }] }),
    /exactly one mode/,
  );
  assert.throws(() => resolveMode({ tasks: [] }), /at least one task/);
});

test("overlapping tool launches deliver independently and clear only their own jobs", async (t) => {
  const children = [new FakeChild(), new FakeChild(), new FakeChild()];
  const { spawnFn } = fakeSpawnChildren(children);
  const { tool, registry, sendMessage, activeTickers, ctx } = makeTool({ spawnFn });
  t.after(() => { children.forEach((child) => child.finish(0)); for (const ticker of activeTickers) clearInterval(ticker); });
  await tool.execute("first", { tasks: [{ agent: "scout", task: "one" }, { agent: "scout", task: "two" }] }, undefined, undefined, ctx);
  await tool.execute("second", { agent: "scout", task: "three" }, undefined, undefined, ctx);
  await waitFor(() => children.every((child) => child.stdin.writes.length > 0));
  const first = children.find((child) => child.stdin.commands()[0]!.message === "Task: one")!;
  const second = children.find((child) => child.stdin.commands()[0]!.message === "Task: two")!;
  const third = children.find((child) => child.stdin.commands()[0]!.message === "Task: three")!;
  first.stdout.emit("data", Buffer.from(endEvent("one")));
  first.finish(0);
  await waitFor(() => sendMessage.calls.length === 1);
  assert.deepEqual(registry.pendingCompleted().map((job) => job.id), [1]);
  third.stdout.emit("data", Buffer.from(endEvent("three")));
  third.finish(0);
  await waitFor(() => sendMessage.calls.length === 2);
  assert.deepEqual(registry.pendingCompleted().map((job) => job.id), [1]);
  assert.equal(registry.get(2)!.status, "running");
  second.stdout.emit("data", Buffer.from(endEvent("two")));
  second.finish(0);
  await waitFor(() => activeTickers.size === 0);
  assert.deepEqual(registry.pendingCompleted(), []);
  assert.deepEqual(sendMessage.calls.map((call) => (call[0] as { details: { jobId: number } }).details.jobId), [1, 3, 2]);
});

test("failed inactivity delivery leaves the child running", async (t) => {
  const { tool, pi, registry, activeTickers, child, ctx } = makeTool();
  t.after(() => { child.finish(0); for (const ticker of activeTickers) clearInterval(ticker); });
  const errors = t.mock.method(console, "error", () => {});
  const delivery = t.mock.method(pi, "sendMessage", () => { throw new Error("parent unavailable"); });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  await tool.execute("launch", { agent: "scout", task: "Keep working" }, undefined, undefined, ctx);
  while (child.stdin.commands().length === 0) await flush();
  assert.doesNotThrow(() => t.mock.timers.tick(300000));
  assert.equal(delivery.mock.callCount(), 1);
  assert.equal(errors.mock.callCount(), 1);
  assert.equal(registry.get(1)!.status, "running");
  assert.equal(registry.get(1)!.cancellationReason, undefined);
  assert.deepEqual(registry.get(1)!.pendingQuestions, []);
  assert.equal(child.killed, null);
  child.stdout.emit("data", Buffer.from(endEvent("still working")));
  assert.equal(registry.get(1)!.text, "still working");
});

test("inactivity does not deliver for completed or removed registry jobs", async (t) => {
  const children = [new FakeChild(), new FakeChild()];
  const { spawnFn } = fakeSpawnChildren(children);
  const { tool, registry, sendMessage, appendEntry, activeTickers, ctx } = makeTool({ spawnFn });
  t.after(() => { children.forEach((child) => child.finish(0)); for (const ticker of activeTickers) clearInterval(ticker); });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  await tool.execute("launch", { tasks: [{ agent: "scout", task: "one" }, { agent: "scout", task: "two" }] }, undefined, undefined, ctx);
  while (children.some((child) => child.stdin.commands().length === 0)) await flush();
  registry.complete(1, { agent: "scout", task: "one", text: "done", exitCode: 0, error: "" });
  registry.jobs.delete(2);
  t.mock.timers.tick(300000);
  assert.equal(sendMessage.calls.length, 0);
  assert.equal(appendEntry.calls.length, 0);
});

test("launch failures and cancellations keep status while avoiding a repeated target", () => {
  const { tool } = makeTool();
  const theme = fakeTheme() as never;
  const args = { agent: "scout", task: "launch task", title: "Launch title" };
  const call = renderText(tool.renderCall!(args, theme, {} as never));
  const failed = renderText(tool.renderResult!(
    {
      content: [{ type: "text", text: "subagent launch scout · Launch title: Error: spawn failed" }],
      details: { status: "failed", jobId: 1, agent: "scout", task: "launch task", title: "Launch title" },
    } as never,
    { expanded: false, isPartial: false },
    theme,
    { args } as never,
  ));
  const combinedLaunch = `${call}\n${failed}`;
  assert.equal(combinedLaunch.match(/Launch title/g)?.length, 1);
  assert.doesNotMatch(failed, /subagent launch/);
  assert.match(failed, /✗/);
  assert.match(failed, /Error: spawn failed/);

  const cancelled = renderText(tool.renderResult!(
    {
      content: [{ type: "text", text: "subagent launch scout · Launch title: Cancelled (manual)." }],
      details: { status: "cancelled", jobId: 1, agent: "scout", task: "launch task", title: "Launch title" },
    } as never,
    { expanded: false, isPartial: false },
    theme,
    { args } as never,
  ));
  assert.doesNotMatch(cancelled, /subagent launch scout · Launch title/);
  assert.match(cancelled, /⊘/);
  assert.match(cancelled, /Cancelled \(manual\)/);

  const mismatched = renderText(tool.renderResult!(
    {
      content: [{ type: "text", text: "subagent launch scout · Other title: Error: mismatch" }],
      details: { status: "failed", jobId: 1, agent: "scout", task: "launch task", title: "Other title" },
    } as never,
    { expanded: false, isPartial: false },
    theme,
    { args } as never,
  ));
  assert.match(mismatched, /subagent launch scout · Other title/);
  assert.match(mismatched, /Error: mismatch/);

  const legacy = renderText(tool.renderResult!(
    {
      content: [{ type: "text", text: "subagent launch scout · Launch title: Error: legacy" }],
      details: { status: "failed", jobId: 1, agent: "scout", task: "launch task", title: "Launch title" },
    } as never,
    { expanded: false, isPartial: false },
    theme,
    {} as never,
  ));
  assert.match(legacy, /subagent launch scout · Launch title/);
  assert.match(legacy, /Error: legacy/);

  const launched = renderText(tool.renderResult!(
    { content: [{ type: "text", text: "Launched **scout** subagent #1: \\\"launch task\\\"" }], details: { status: "launched", jobIds: [1] } } as never,
    { expanded: false, isPartial: false },
    theme,
    { args } as never,
  ));
  assert.equal(launched.trim(), "");
});

test("execute: profile confirmation surfaces a paused progress update", async (t) => {
  const updates: Array<{ content: unknown; details: unknown }> = [];
  const { tool, activeTickers, child, ctx } = makeTool(undefined, undefined, undefined, async (_ctx, onPause) => {
    onPause?.("Paused: waiting for subagent profile selection");
    return true;
  });
  t.after(() => { child.finish(0); for (const ticker of activeTickers) clearInterval(ticker); });
  await tool.execute(
    "call1",
    { agent: "scout", task: "t" },
    undefined,
    (partial) => updates.push(partial),
    ctx,
  );
  assert.deepEqual(updates, [{
    content: [{ type: "text", text: "subagent launch scout · t: Paused: waiting for subagent profile selection" }],
    details: { status: "running", targets: [{ agent: "scout", task: "t" }] },
  }]);
});

test("execute: cancelling profile confirmation returns a cancelled result", async () => {
  const child = new FakeChild();
  const calls: SpawnCall[] = [];
  const spawnFn = ((cmd: string, args: string[], options?: Record<string, unknown>) => {
    calls.push({ cmd, args, options: options ?? {} });
    return child;
  }) as unknown as typeof spawn;
  let confirmations = 0;
  const { tool, ctx } = makeTool({ spawnFn }, undefined, undefined, async () => {
    confirmations += 1;
    return false;
  });
  const result = await tool.execute("call1", { agent: "scout", task: "t" }, undefined, undefined, ctx);
  assert.equal(result.details?.status, "cancelled");
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /no profile selected/i);
  assert.equal(confirmations, 1);
  assert.equal(calls.length, 0);
});

test("execute: local settings set child model and thinking level", async () => {
  const child = new FakeChild();
  const calls: SpawnCall[] = [];
  const spawnFn = ((cmd: string, args: string[], options?: Record<string, unknown>) => {
    calls.push({ cmd, args, options: options ?? {} });
    return child;
  }) as unknown as typeof spawn;
  const { tool, ctx } = makeTool(
    { spawnFn },
    {
      profiles: {
        default: {
          defaults: { model: "default-model", thinkingLevel: "low" },
          agents: { scout: { model: "local-model", thinkingLevel: "high" } },
        },
      },
      extensions: [],
    },
    "default",
  );
  await tool.execute("call1", { agent: "scout", task: "t" }, undefined, undefined, ctx);

  await waitFor(() => child.stdin.writes.length > 0);
  child.stdout.emit("data", Buffer.from(endEvent("done")));
  child.finish(0);
  await sleep(20);

  const args = calls[0]?.args ?? [];
  assert.equal(args[args.indexOf("--model") + 1], "local-model");
  assert.equal(args[args.indexOf("--thinking") + 1], "high");
});

test("execute: selected profile defaults set child model and thinking level", async () => {
  const child = new FakeChild();
  const calls: SpawnCall[] = [];
  const spawnFn = ((cmd: string, args: string[], options?: Record<string, unknown>) => {
    calls.push({ cmd, args, options: options ?? {} });
    return child;
  }) as unknown as typeof spawn;
  const { tool, ctx } = makeTool(
    { spawnFn },
    {
      profiles: { default: { defaults: { model: "default-model", thinkingLevel: "low" }, agents: {} } },
      extensions: [],
    },
    "default",
  );
  await tool.execute("call1", { agent: "scout", task: "t" }, undefined, undefined, ctx);

  await waitFor(() => child.stdin.writes.length > 0);
  child.stdout.emit("data", Buffer.from(endEvent("done")));
  child.finish(0);
  await sleep(20);

  const args = calls[0]?.args ?? [];
  assert.equal(args[args.indexOf("--model") + 1], "default-model");
  assert.equal(args[args.indexOf("--thinking") + 1], "low");
});

test("execute: selected profile controls new jobs and completion metadata", async () => {
  const settings = {
    profiles: {
      primary: { defaults: { model: "primary/model", thinkingLevel: "low" }, agents: {} },
      backup: { defaults: { model: "backup/model", thinkingLevel: "high" }, agents: {} },
    },
    extensions: [],
  };
  const child = new FakeChild();
  const calls: SpawnCall[] = [];
  const spawnFn = ((cmd: string, args: string[], options?: Record<string, unknown>) => {
    calls.push({ cmd, args, options: options ?? {} });
    return child;
  }) as unknown as typeof spawn;
  const { tool, registry, sendMessage, ctx } = makeTool({ spawnFn }, settings, "backup");
  const launch = await tool.execute("call1", { agent: "scout", task: "t" }, undefined, undefined, ctx);

  assert.equal(launch.details.profile, "backup");
  assert.doesNotMatch((launch.content[0] as { text: string }).text, /profile/i);
  assert.equal(registry.get(1)?.profile, "backup");
  await waitFor(() => child.stdin.writes.length > 0);
  const args = calls[0]?.args ?? [];
  assert.equal(args[args.indexOf("--model") + 1], "backup/model");
  assert.equal(args[args.indexOf("--thinking") + 1], "high");

  child.stdout.emit("data", Buffer.from(endEvent("done")));
  child.finish(0);
  await sleep(20);
  const completion = sendMessage.calls[0]?.[0] as { details: { profile?: string } };
  assert.equal(completion.details.profile, "backup");
});

test("execute: setup failures preserve inherited model and effort", async () => {
  const spawnFn = (() => {
    throw new Error("spawn failed");
  }) as typeof spawn;
  const { tool, registry, sendMessage, ctx } = makeTool({ spawnFn });
  const notices: string[] = [];
  (ctx as unknown as { thinkingLevel?: string }).thinkingLevel = "medium";
  (ctx as unknown as { hasUI: boolean; ui: { notify: (text: string) => void } }).hasUI = true;
  (ctx as unknown as { ui: { notify: (text: string) => void } }).ui = { notify: (text) => notices.push(text) };

  const result = await tool.execute("call1", { agent: "scout", task: "t" }, undefined, undefined, ctx);
  assert.equal(result.details.status, "launched");
  await waitFor(() => sendMessage.calls.length > 0);
  assert.equal(registry.get(1)?.status, "failed");
  const [message] = sendMessage.calls[0] as [{ details: { model?: string; thinkingLevel?: string } }];
  assert.equal(message.details.model, "p/m");
  assert.equal(message.details.thinkingLevel, "medium");
  assert.deepEqual(notices, ["subagent #1 scout — failed: Error: spawn failed · t"]);
});

test("subagent schema has no execution mode", () => {
  const { tool } = makeTool();
  const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
  assert.equal("execution" in properties, false);
});

test("subagent tool runs sequentially so parallel calls cannot double-open the picker", () => {
  const { tool } = makeTool();
  assert.equal(tool.executionMode, "sequential");
  assert.equal(tool.exposure, "model-only");
});

test("execute: legacy sync input cannot make a single job block", async () => {
  const { tool, registry, sendMessage, activeTickers, activeProcs, child, ctx } = makeTool();
  const result = await tool.execute(
    "call1",
    { agent: "scout", task: "t", execution: "sync" } as never,
    undefined,
    undefined,
    ctx,
  );

  assert.equal(result.details.status, "launched");
  assert.equal(registry.running().length, 1);
  assert.deepEqual(result.details, {
    agent: "scout",
    task: "t",
    title: undefined,
    status: "launched",
    jobIds: [1],
    targets: [{ agent: "scout", task: "t", jobId: 1 }],
    jobScope: registry.scope,
    profile: undefined,
  });

  await waitFor(() => child.stdin.writes.length > 0);
  child.stdout.emit("data", Buffer.from(endEvent("scouted")));
  child.finish(0);
  await sleep(20);

  assert.equal(sendMessage.calls.length, 1, "completion sends one hidden parent message");
  assert.equal(registry.running().length, 0);
  assert.equal(activeTickers.size, 0);
  assert.equal(activeProcs.size, 0);
});

test("execute: single returns launched, then displays and delivers its result", async () => {
  const { tool, registry, sendMessage, appendEntry, child, ctx } = makeTool();
  (ctx as unknown as { thinkingLevel: string }).thinkingLevel = "high";
  const result = await tool.execute("call1", { agent: "scout", task: "t" }, undefined, undefined, ctx);
  assert.equal(result.details.status, "launched");
  assert.equal(result.details.jobScope, registry.scope);
  assert.deepEqual(result.details.jobIds, [1]);
  assert.equal((result.content[0] as { text: string }).text, 'Launched **scout** subagent #1: "t"');

  await waitFor(() => child.stdin.writes.length > 0);
  child.stdout.emit("data", Buffer.from(endEvent("x".repeat(25000), { model: "served/model" })));
  child.finish(0);
  await waitFor(() => sendMessage.calls.length === 1);

  const [message, options] = sendMessage.calls[0]! as [
    { customType: string; content: string; display: boolean; details: { status: string; icon: string; jobId: number; agent: string; model: string; thinkingLevel?: string } },
    { triggerTurn: boolean; deliverAs: string },
  ];
  assert.equal(message.customType, "subagents");
  assert.equal(message.content, `${"x".repeat(20000)}\n…`);
  assert.equal(message.details.status, "completed");
  assert.equal(message.details.icon, "✓");
  assert.equal(message.details.jobId, 1);
  assert.equal(message.details.agent, "scout");
  assert.equal(message.details.model, "served/model");
  assert.equal(message.details.thinkingLevel, "high");
  assert.equal(message.display, false);
  assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
  assert.deepEqual(appendEntry.calls, [["subagents", { content: message.content, details: message.details }]]);
});

test("execute: active parent holds results until agent_settled", async () => {
  const { tool, sendMessage, appendEntry, handlers, child, ctx } = makeTool();
  (ctx as unknown as { isIdle: () => boolean }).isIdle = () => false;
  await tool.execute("call1", { agent: "scout", task: "t" }, undefined, undefined, ctx);

  await waitFor(() => child.stdin.writes.length > 0);
  child.stdout.emit("data", Buffer.from(endEvent("scouted")));
  child.finish(0);
  await waitFor(() => appendEntry.calls.length === 1);

  assert.equal(appendEntry.calls.length, 1);
  assert.equal(sendMessage.calls.length, 0);
  handlers.get("agent_settled")!({}, { isIdle: () => false });
  assert.equal(sendMessage.calls.length, 0);
  handlers.get("agent_settled")!({}, { isIdle: () => true });
  assert.equal(sendMessage.calls.length, 1);
  assert.deepEqual(sendMessage.calls[0]![1], { triggerTurn: true, deliverAs: "steer" });
});

test("execute: inactivity steers a busy parent once per idle stretch without stopping the child", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const { tool, registry, sendMessage, appendEntry, activeTickers, child, ctx } = makeTool();
  t.after(() => { child.finish(0); for (const ticker of activeTickers) clearInterval(ticker); });
  (ctx as unknown as { isIdle: () => boolean }).isIdle = () => false;
  await tool.execute("launch", { agent: "scout", task: "Inspect the slow tool" }, undefined, undefined, ctx);
  while (child.stdin.commands().length === 0) await flush();
  child.stdout.emit("data", Buffer.from(`${JSON.stringify({
    type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "src/auth.ts" },
  })}\n`));
  assert.equal(registry.get(1)?.steps.filter((step) => step.endedAt === undefined).length, 1);

  t.mock.timers.tick(300000);
  assert.equal(sendMessage.calls.length, 1);
  const [message, options] = sendMessage.calls[0] as [
    { customType: string; content: string; display: boolean; details: Record<string, unknown> },
    { deliverAs: string; triggerTurn: boolean },
  ];
  assert.equal(message.customType, "subagent-check-in");
  assert.equal(message.display, true);
  assert.deepEqual(message.details, { jobId: 1, agent: "scout", lastActivityAt: now, detectedAt: now + 300000, inactivityTimeoutMs: 300000 });
  assert.deepEqual(options, { deliverAs: "steer", triggerTurn: true });
  assert.match(message.content, /#1 scout/);
  assert.match(message.content, /Task: Inspect the slow tool/);
  assert.match(message.content, /No activity for 5m/);
  assert.match(message.content, /Active: .*read src\/auth\.ts/);
  assert.match(message.content, /still running/);
  assert.match(message.content, /subagent_peek.*wait.*subagent_send.*subagent_cancel/);
  assert.equal(appendEntry.calls.length, 0);
  assert.equal(registry.get(1)?.status, "running");
  assert.deepEqual(registry.get(1)?.pendingQuestions, []);
  assert.equal(child.killed, null);
  assert.equal(child.stdin.ended, false);

  t.mock.timers.tick(600000);
  assert.equal(sendMessage.calls.length, 1);
  child.stdout.emit("data", Buffer.from(`${JSON.stringify({
    type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false, result: "ok",
  })}\n`));
  assert.equal(registry.get(1)?.steps.find((step) => step.kind === "tool")?.endedAt, now + 900000);
  t.mock.timers.tick(300000);
  assert.equal(sendMessage.calls.length, 2);
  assert.match((sendMessage.calls[1]?.[0] as { content: string }).content, /Last event: read success: ok/);
  assert.equal(child.killed, null);
});

test("execute: child semantic events are available through peek", async () => {
  const { tool, registry, child, ctx } = makeTool();
  await tool.execute("call1", { agent: "scout", task: "t" }, undefined, undefined, ctx);
  await waitFor(() => child.stdin.writes.length > 0);
  const emit = (event: Record<string, unknown>) => {
    child.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
  };
  emit({ type: "agent_start" });
  emit({ type: "tool_execution_start", toolName: "read", args: { path: "src/auth.ts" } });
  emit({ type: "tool_execution_end", toolName: "read", isError: false, result: "ok" });
  child.stdout.emit("data", Buffer.from(endEvent("scouted")));
  child.finish(0);
  await sleep(20);

  const peek = await createPeekTool({ registry }).execute(
    "peek",
    { jobId: 1 },
    undefined,
    undefined,
    {} as never,
  );
  assert.deepEqual(peek.details.events.map((event) => `${event.kind}:${event.summary}`), [
    "state:started",
    "tool-start:read src/auth.ts",
    "tool-end:read success: ok",
    "assistant:scouted",
  ]);
});

test("child questions trigger a parent turn and subagent_reply resolves them", async () => {
  const { tool, registry, sendMessage, child, ctx } = makeTool();
  await tool.execute("call1", { agent: "scout", task: "t" }, undefined, undefined, ctx);
  await waitFor(() => child.stdin.writes.length > 0);
  const initial = child.stdin.commands()[0];
  assert.ok(initial);
  child.stdout.emit("data", Buffer.from(responseEvent(initial)));
  child.stdout.emit("data", Buffer.from(questionEvent("question-1", "Which API?", "Two choices")));

  assert.deepEqual(registry.get(1)?.pendingQuestions.map((question) => question.id), ["question-1"]);
  assert.deepEqual(registry.readEvents(1)?.events.map((event) => `${event.kind}:${event.summary}`), [
    "question:question: Which API?",
  ]);
  const [message, options] = sendMessage.calls[0] as [
    { customType: string; content: string; display: boolean; details: { jobId: number; questionId: string } },
    { deliverAs: string; triggerTurn: boolean },
  ];
  assert.equal(message.customType, QUESTION_ENTRY_TYPE);
  assert.equal(message.display, true);
  assert.equal(message.details.jobId, 1);
  assert.equal(message.details.questionId, "question-1");
  assert.match(message.content, /call ask_user first/);
  assert.deepEqual(options, { deliverAs: "steer", triggerTurn: true });

  const replyTool = createReplyTool({ registry });
  const replied = await replyTool.execute(
    "call2",
    { jobId: 1, questionId: "question-1", answer: "Use the existing API." },
    undefined,
    undefined,
    ctx,
  );
  assert.equal((replied.content[0] as { text: string }).text, "Answered subagent #1 scout · t.");
  assert.deepEqual(child.stdin.commands()[1], {
    type: "extension_ui_response",
    id: "question-1",
    value: "Use the existing API.",
  });
  assert.deepEqual(registry.get(1)?.pendingQuestions, []);

  child.stdout.emit("data", Buffer.from(endEvent("done")));
  child.finish(0);
  await sleep(20);
  assert.equal(sendMessage.calls.length, 2, "question and result sent once each");
});

test("stale UI context does not duplicate cancellation completion", async () => {
  const { tool, registry, sendMessage, child, ctx } = makeTool();
  await tool.execute("call1", { agent: "scout", task: "t" }, undefined, undefined, ctx);
  await waitFor(() => child.stdin.writes.length > 0);
  Object.defineProperty(ctx, "hasUI", {
    configurable: true,
    get: () => { throw new Error("stale context"); },
  });

  assert.equal(registry.cancel(1, "manual"), true);
  await sleep(30);

  assert.equal(registry.get(1)?.status, "cancelled");
  const deliveries = sendMessage.calls.filter((call) => (call[0] as { display?: boolean }).display === false);
  assert.equal(deliveries.length, 1);
  assert.equal((deliveries[0]?.[0] as { details: { jobId?: number } }).details.jobId, 1);
  assert.equal(child.killed, "SIGTERM");
});

test("cancelling a child waiting on the parent invalidates its question and suppresses check-ins", async (t) => {
  const { tool, registry, sendMessage, activeTickers, child, ctx } = makeTool();
  t.after(() => { child.finish(0); for (const ticker of activeTickers) clearInterval(ticker); });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  await tool.execute("call1", { agent: "scout", task: "t" }, undefined, undefined, ctx);
  while (child.stdin.commands().length === 0) await flush();
  const initial = child.stdin.commands()[0];
  assert.ok(initial);
  child.stdout.emit("data", Buffer.from(responseEvent(initial)));
  child.stdout.emit("data", Buffer.from(questionEvent("question-1", "Continue?")));
  assert.deepEqual(registry.get(1)?.pendingQuestions.map((question) => question.id), ["question-1"]);
  t.mock.timers.tick(600000);
  assert.equal(sendMessage.calls.length, 1, "a pending question suppresses inactivity check-ins");

  assert.equal(registry.cancel(1, "manual"), true);
  assert.deepEqual(registry.get(1)?.pendingQuestions, []);
  t.mock.timers.tick(600000);
  assert.equal(sendMessage.calls.length, 1, "cancellation must not rearm inactivity delivery");
  t.mock.timers.reset();
  await sleep(20);
  assert.equal(registry.get(1)?.status, "cancelled");
  const resultMessage = sendMessage.calls.find((call) =>
    (call[0] as { details?: { status?: string } }).details?.status === "cancelled");
  assert.ok(resultMessage, "cancelled result delivered after the child closes");
});

test("execute: all-unknown batch throws", async () => {
  const { tool, ctx } = makeTool();
  await assert.rejects(
    tool.execute(
      "call1",
      { tasks: [{ agent: "ghost", task: "t" }] },
      undefined,
      undefined,
      ctx,
    ),
    /Unknown agent\(s\): ghost/,
  );
});

test("execute: partial-unknown batch launches known jobs and reports skipped count", async () => {
  const { tool, registry, sendMessage, child, ctx } = makeTool();
  const result = await tool.execute(
    "call1",
    { tasks: [{ agent: "ghost", task: "t" }, { agent: "scout", task: "t2" }] },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(result.details.status, "launched");
  assert.equal(result.details.skipped, 1);
  assert.equal(result.details.count, 1);
  assert.deepEqual(result.details.jobIds, [1, 2]);
  assert.equal(result.details.jobScope, registry.scope);

  await waitFor(() => child.stdin.writes.length > 0);
  child.stdout.emit("data", Buffer.from(endEvent("scouted")));
  child.finish(0);
  await sleep(20);

  assert.equal(registry.get(1)?.status, "failed");
  assert.equal(registry.get(2)?.status, "completed");
  const text = sendMessage.calls.map((call) => (call[0] as { content: string }).content).join("\n");
  assert.match(text, /Unknown agent "ghost"/);
  assert.match(text, /scouted/);
});

test("execute: queued cancellation does not spawn and reports its reason", async () => {
  const children = [new FakeChild(), new FakeChild()];
  const { spawnFn, calls } = fakeSpawnChildren(children);
  const { tool, registry, sendMessage, ctx } = makeTool({ spawnFn });
  const notices: string[] = [];
  (ctx as unknown as { hasUI: boolean; ui: { notify: (text: string) => void } }).hasUI = true;
  (ctx as unknown as { ui: { notify: (text: string) => void } }).ui = { notify: (text) => notices.push(text) };
  await tool.execute("call1", {
    tasks: [{ agent: "scout", task: "one" }, { agent: "scout", task: "two" }],
    concurrency: 1,
  }, undefined, undefined, ctx);
  assert.equal(registry.cancel(2, "timeout"), true);
  // Let the first launch finish setup and attach its close listener.
  await waitFor(() => children[0]!.stdin.writes.length > 0);
  children[0]!.finish(0);
  await sleep(30);
  assert.equal(calls.length, 1, "the queued cancelled job must not spawn");
  const resultMessage = sendMessage.calls.find((call) => (call[0] as { details?: { jobId?: number } }).details?.jobId === 2);
  assert.equal((resultMessage?.[0] as { details: { status: string; cancellationReason?: string } }).details.status, "cancelled");
  assert.equal((resultMessage?.[0] as { details: { cancellationReason?: string } }).details.cancellationReason, "timeout");
  assert.deepEqual(notices, ["subagent #2 scout — cancelled (timeout) · two"]);
  assert.match((sendMessage.calls.at(-1)?.[0] as { content: string }).content, /Cancelled \(timeout\)/);
});

test("execute: parent abort does not cancel running or queued jobs", async () => {
  const children = [new FakeChild(), new FakeChild()];
  const { spawnFn, calls } = fakeSpawnChildren(children);
  const { tool, registry, ctx } = makeTool({ spawnFn });
  const controller = new AbortController();
  const result = await tool.execute("call1", {
    tasks: [{ agent: "scout", task: "one" }, { agent: "scout", task: "two" }],
    concurrency: 1,
  }, controller.signal, undefined, ctx);
  assert.equal(result.details.status, "launched");

  await waitFor(() => calls.length > 0);
  controller.abort();
  assert.equal(calls.length, 1);
  assert.equal(registry.get(1)?.cancellationReason, undefined);
  assert.equal(registry.get(2)?.cancellationReason, undefined);

  children[0]!.finish(0);
  await waitFor(() => calls.length === 2);
  assert.equal(calls.length, 2);
  children[1]!.finish(0);
  await waitFor(() => registry.get(2)?.status === "completed");
  assert.equal(registry.get(1)?.status, "completed");
  assert.equal(registry.get(2)?.status, "completed");
});

test("execute: registry cancellation reason wins over child completion", async () => {
  const { tool, registry, sendMessage, appendEntry, child, ctx } = makeTool();
  const result = await tool.execute("call1", { agent: "scout", task: "t" }, undefined, undefined, ctx);
  assert.equal(result.details.status, "launched");
  await waitFor(() => child.stdin.writes.length > 0);
  assert.equal(registry.cancel(1, "manual"), true);
  child.finish(143);
  await waitFor(() => sendMessage.calls.length === 1);

  assert.equal(registry.get(1)?.cancellationReason, "manual");
  const message = sendMessage.calls[0]![0] as { content: string; details: { status: string; icon: string; cancellationReason?: string } };
  assert.equal(message.details.status, "cancelled");
  assert.equal(message.details.icon, "⊘");
  assert.equal(message.details.cancellationReason, "manual");
  assert.match(message.content, /Cancelled \(manual\)/);
  assert.deepEqual(appendEntry.calls, [["subagents", { content: message.content, details: message.details }]]);
});

test("execute: setup cancellation reports cancellation instead of failure", async () => {
  let registry: ReturnType<typeof createJobRegistry> | undefined;
  const spawnFn = (() => {
    assert.ok(registry);
    registry.cancel(1, "session-shutdown");
    throw new Error("setup failed");
  }) as typeof spawn;
  const made = makeTool({ spawnFn });
  registry = made.registry;
  const result = await made.tool.execute("call1", { agent: "scout", task: "t" }, undefined, undefined, made.ctx);
  assert.equal(result.details.status, "launched");
  await waitFor(() => made.sendMessage.calls.length > 0);
  const details = (made.sendMessage.calls[0]?.[0] as { details: { status: string; cancellationReason?: string } }).details;
  assert.equal(details.status, "cancelled");
  assert.equal(details.cancellationReason, "session-shutdown");
});

test("execute: jobs outlive the tool-call abort signal", async () => {
  const controller = new AbortController();
  const { tool, child, ctx } = makeTool();
  const result = await tool.execute("call1", { agent: "scout", task: "t" }, controller.signal, undefined, ctx);
  assert.equal(result.details.status, "launched");

  controller.abort();
  await waitFor(() => child.stdin.writes.length > 0);
  assert.equal(child.killed, null, "the caller's abort signal must not cancel the job");

  child.stdout.emit("data", Buffer.from(endEvent("scouted")));
  child.finish(0);
  await sleep(20);
});

test("execute: parallel batch displays and delivers each result", async () => {
  const children = [new FakeChild(), new FakeChild()];
  const { spawnFn, calls } = fakeSpawnChildren(children);
  const { tool, registry, sendMessage, sendUserMessage, activeTickers, activeProcs, ctx } = makeTool({ spawnFn });
  const result = await tool.execute(
    "call1",
    { tasks: [{ agent: "scout", task: "t1" }, { agent: "scout", task: "t2" }] },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(result.details.status, "launched");
  assert.equal(result.details.count, 2);
  assert.equal(
    (result.content[0] as { text: string }).text,
    'Launched 2 subagents in parallel:\n- #1 scout: "t1"\n- #2 scout: "t2"',
  );

  await waitFor(() => children.every((child) => child.stdin.writes.length > 0));
  assert.equal(calls.length, 2, "one child spawned per task");
  const first = children.find((child) => child.stdin.commands()[0]!.message === "Task: t1")!;
  const second = children.find((child) => child.stdin.commands()[0]!.message === "Task: t2")!;
  first.stdout.emit("data", Buffer.from(endEvent("one")));
  first.finish(0);
  await waitFor(() => sendMessage.calls.length === 1);
  assert.deepEqual(registry.pendingCompleted().map((job) => job.id), [1]);
  assert.equal(registry.get(2)!.status, "running");
  second.stdout.emit("data", Buffer.from(endEvent("two")));
  second.finish(1);
  await waitFor(() => activeTickers.size === 0);
  assert.deepEqual(registry.pendingCompleted(), []);
  assert.equal(registry.get(2)!.status, "failed");

  assert.equal(sendMessage.calls.length, 2, "one hidden parent message per result");
  assert.equal(sendUserMessage.calls.length, 0);
  assert.equal((sendMessage.calls[1]?.[0] as { display: boolean }).display, false);
  assert.equal(activeTickers.size, 0, "ticker stopped via finally");
  assert.equal(activeProcs.size, 0);
});

test("execute: validation errors reject", async () => {
  const { tool, ctx } = makeTool();
  await assert.rejects(
    tool.execute("call1", { tasks: [] }, undefined, undefined, ctx),
    /at least one task/,
  );
  await assert.rejects(
    tool.execute("call1", { agent: "scout" }, undefined, undefined, ctx),
    /exactly one mode/,
  );
});

test("renderResult: tolerates missing details (error results omit it)", () => {
  const { tool } = makeTool();
  const theme = fakeTheme() as never;
  // SDK runtime omits `details` on validation-failure/abort results.
  const out = tool.renderResult!(
    { content: [{ type: "text", text: "boom" }], details: undefined } as never,
    {} as never,
    theme,
    {} as never,
  );
  assert.ok(renderable(out), "renderer must not throw on missing details");
});

test("renderResult: renders launched/failed/completed summaries", () => {
  const { tool } = makeTool();
  const theme = fakeTheme() as never;
  const render = (details: { status: string }) =>
    tool.renderResult!(
      { content: [{ type: "text", text: "s" }], details } as never,
      {} as never,
      theme,
      {} as never,
    );
  const launched = render({ status: "launched" });
  assert.ok(renderable(launched));
  assert.equal(renderText(launched).trim(), "");
  assert.ok(renderable(render({ status: "failed" })));
  assert.ok(renderable(render({ status: "completed" })));
  const runningText = renderText(render({ status: "running" })).trim();
  assert.match(runningText, /subagent launch/);
  assert.match(runningText, /⊙ s/);
  assert.match(renderText(render({ status: "cancelled" })).trim(), /⊘ s/);
  const completedWithJob = tool.renderResult!(
    { content: [{ type: "text", text: "done" }], details: { status: "completed", jobIds: [1] } } as never,
    {} as never,
    theme,
    {} as never,
  );
  assert.equal(renderText(completedWithJob).trim(), "");
});

test("renderCall: shows concurrency and every agent title", () => {
  const { tool } = makeTool();
  const theme = fakeTheme() as never;
  const rendered = tool.renderCall!(
    {
      tasks: [
        { agent: "scout", task: "task one", title: "First task" },
        { agent: "worker", task: "task two", title: "Second task" },
      ],
    } as never,
    theme,
    {} as never,
  );
  assert.ok(renderable(rendered));
  const text = renderText(rendered);
  assert.match(text, /parallel \(2 tasks\)/);
  assert.match(text, /\[concurrency 3\]/);
  assert.match(text, /scout.*First task/);
  assert.match(text, /worker.*Second task/);
});
