import { test } from "node:test";
import assert from "node:assert/strict";
import { Box, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createJobRegistry } from "../../src/subagents/registry.ts";
import { refreshUi, registerRenderers, renderFullWidget } from "../../src/subagents/render.ts";
import { createSendTool } from "../../src/subagents/status-tools.ts";
import { EMPTY_USAGE, ENTRY_TYPE, QUESTION_ENTRY_TYPE } from "../../src/subagents/types.ts";
import { complete, makeTool, fakeTheme, renderable, renderAtWidth, renderText } from "./helpers.ts";

test("refreshUi: keeps one widget component and requests in-place renders", () => {
  const registry = createJobRegistry();
  registry.add("reviewer", "review safety fixes", "Review safety fixes");
  let factoryCalls = 0;
  let renderRequests = 0;
  let widgetContent: unknown;
  const tui = { requestRender: () => { renderRequests += 1; } };
  const ui = {
    setWidget: (_key: string, content: unknown) => {
      widgetContent = content;
      if (typeof content === "function") {
        factoryCalls += 1;
        content(tui, fakeTheme());
      }
    },
  };
  const ctx = { hasUI: true, ui } as never;

  refreshUi(ctx, registry);
  refreshUi(ctx, registry);
  refreshUi(ctx, registry);

  assert.equal(factoryCalls, 1);
  assert.equal(renderRequests, 2);

  registry.markCleared(registry.jobs.keys());
  for (const job of registry.running()) {
    registry.complete(job.id, { agent: job.agent, task: job.task, text: "done", exitCode: 0, error: "" });
  }
  refreshUi(ctx, registry);
  assert.equal(widgetContent, undefined);
});

test("refreshUi: clicks open the rendered job's tail and leave other mouse gestures alone", async (t) => {
  const registry = createJobRegistry();
  const completedId = registry.add("scout", "finished task");
  const runningId = registry.add("worker", "running task");
  complete(registry, completedId);
  type Widget = {
    render(width: number): string[];
    handleMouse(event: { type: string; button: string; y: number }): unknown;
    dispose(): void;
  };
  type Tail = { render(width: number): string[]; handleInput(data: string): void; dispose(): void };
  let widget: Widget | undefined;
  const tails: Tail[] = [];
  const options: unknown[] = [];
  const tui = { requestRender: () => {} };
  const ui = {
    setWidget: (_key: string, factory: unknown) => {
      if (typeof factory === "function") widget = factory(tui, fakeTheme());
    },
    custom: (
      factory: (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => Tail,
      overlayOptions: unknown,
    ) => new Promise<void>((resolve) => {
      options.push(overlayOptions);
      tails.push(factory(tui, fakeTheme(), {}, resolve));
    }),
  };
  t.after(() => { widget?.dispose(); for (const tail of tails) tail.dispose(); });
  refreshUi({ hasUI: true, ui } as never, registry);
  assert.ok(widget);
  const lines = widget.render(80);
  assert.match(lines[0]!, new RegExp(`#${runningId} worker`));
  assert.match(lines[1]!, new RegExp(`#${completedId}`));

  for (const type of ["press", "release", "move", "drag", "wheel"]) {
    assert.equal(widget.handleMouse({ type, button: "left", y: 0 }), undefined);
  }
  for (const button of ["middle", "right", "none"]) {
    assert.equal(widget.handleMouse({ type: "click", button, y: 0 }), undefined);
  }
  for (const y of [-1, 0.5, 2, NaN]) {
    assert.equal(widget.handleMouse({ type: "click", button: "left", y }), undefined);
  }
  assert.equal(tails.length, 0);

  const addedId = registry.add("worker", "new task");
  assert.deepEqual(widget.handleMouse({ type: "click", button: "left", y: 0 }), { handled: true });
  assert.match(renderText(tails[0]), new RegExp(`Subagent #${runningId}`));
  assert.deepEqual(options[0], {
    overlay: true,
    overlayOptions: { anchor: "center", width: "100%", minWidth: 60, maxHeight: "100%", margin: 1 },
  });
  assert.deepEqual(widget.handleMouse({ type: "click", button: "left", y: 1 }), { handled: true });
  assert.equal(tails.length, 1);
  tails[0]!.handleInput("q");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(widget.handleMouse({ type: "click", button: "left", y: 1 }), { handled: true });
  assert.match(renderText(tails[1]), new RegExp(`Subagent #${completedId}`));
  tails[1]!.handleInput("\x1b");
  await new Promise<void>((resolve) => setImmediate(resolve));

  widget.render(30);
  assert.deepEqual(widget.handleMouse({ type: "click", button: "left", y: 1 }), { handled: true });
  assert.match(renderText(tails[2]), new RegExp(`Subagent #${addedId}`));
  tails[2]!.handleInput("q");
});

test("refreshUi: failed tail opens recover and disposed widgets cannot open tails", async () => {
  const registry = createJobRegistry();
  registry.add("scout", "task");
  type Widget = {
    render(width: number): string[];
    handleMouse(event: { type: string; button: string; y: number }): unknown;
    dispose(): void;
  };
  const widgets: Widget[] = [];
  let opens = 0;
  const ui = {
    setWidget: (_key: string, factory: unknown) => {
      if (typeof factory === "function") widgets.push(factory({ requestRender: () => {} }, fakeTheme()));
    },
    custom: () => {
      opens += 1;
      if (opens === 1) throw new Error("synchronous open failure");
      if (opens === 2) return Promise.reject(new Error("asynchronous open failure"));
      return new Promise<void>(() => {});
    },
  };
  const ctx = { hasUI: true, ui } as never;
  refreshUi(ctx, registry);
  const widget = widgets[0]!;
  widget.render(80);
  const click = { type: "click", button: "left", y: 0 };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.doesNotThrow(() => widget.handleMouse(click));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(opens, attempt + 1);
  }
  widget.dispose();
  assert.equal(widget.handleMouse(click), undefined);
  assert.deepEqual(widget.render(80), []);
  refreshUi(ctx, registry);
  assert.equal(widgets.length, 2);
  const replacement = widgets[1]!;
  replacement.render(80);
  assert.deepEqual(replacement.handleMouse(click), { handled: true });
  assert.equal(opens, 4);
  replacement.dispose();
});

test("refreshUi: truncation rows and vanished jobs are not clickable", () => {
  const registry = createJobRegistry();
  for (let index = 0; index < 11; index += 1) registry.add("scout", `task ${index}`);
  let widget: {
    render(width: number): string[];
    handleMouse(event: { type: string; button: string; y: number }): unknown;
    dispose(): void;
  } | undefined;
  let opens = 0;
  const ui = {
    setWidget: (_key: string, factory: unknown) => {
      if (typeof factory === "function") widget = factory({ requestRender: () => {} }, fakeTheme());
    },
    custom: () => { opens += 1; return Promise.resolve(); },
  };
  refreshUi({ hasUI: true, ui } as never, registry);
  assert.ok(widget);
  const lines = widget.render(20);
  assert.equal(lines.length, 10);
  assert.ok(lines.every((line) => visibleWidth(line) <= 20));
  assert.ok(lines[0]?.startsWith(" "));
  assert.match(lines[9]!, /widget trunca/);
  assert.equal(widget.handleMouse({ type: "click", button: "left", y: 9 }), undefined);
  registry.jobs.delete(1);
  assert.equal(widget.handleMouse({ type: "click", button: "left", y: 0 }), undefined);
  assert.equal(opens, 0);
  widget.dispose();
});

test("renderFullWidget: shows one line per active agent", () => {
  const registry = createJobRegistry();
  const id = registry.add("scout", "task", "a".repeat(60), {
    model: "openai-codex/gpt-5.6-luna",
    thinkingLevel: "high",
    profile: "primary",
  });
  registry.updateLive(id, { progress: "reading files", text: "live agent output" });
  const lines = renderFullWidget(registry, (_color, text) => text, 80);
  const output = lines.join("\n");
  assert.equal(lines.length, 1);
  assert.ok(lines.every((line) => visibleWidth(line) <= 80));
  assert.match(output, new RegExp(`⊙ #${id} scout`));
  assert.doesNotMatch(output, /profile/i);
  assert.doesNotMatch(output, /reading files/);
  assert.doesNotMatch(output, /openai-codex\/gpt-5\.6-luna:high/);
  assert.doesNotMatch(output, /live agent output/);

  registry.recordQuestion(id, { id: "question-1", question: "Which API?" });
  registry.recordQuestion(id, { id: "question-2", question: "Which format?" });
  const waitingLines = renderFullWidget(registry, (_color, text) => text, 80);
  assert.equal(waitingLines.length, 1);
  assert.doesNotMatch(waitingLines.join("\n"), /waiting for parent \(2\)/);

  const completedId = registry.add("worker", "finished task", "Finished task");
  registry.complete(completedId, {
    agent: "worker",
    task: "finished task",
    title: "Finished task",
    text: "done",
    exitCode: 0,
    error: "",
  });
  const tagged = renderFullWidget(
    registry,
    (color, text) => `[${color}]${text}[/${color}]`,
    200,
  ).join("\n");
  assert.match(tagged, /\[success\]✓ /);
  assert.match(tagged, /\[accent\]#2 worker/);
  assert.match(tagged, /\[muted\] \([^)]*\)/);
  assert.match(tagged, /\[dim\]: Finished task/);
});

test("message and entry renderers render results and parent questions", () => {
  const renderers = new Map<string, (message: unknown, options: unknown, theme: unknown) => unknown>();
  const entryRenderers = new Map<string, (entry: unknown, options: unknown, theme: unknown) => unknown>();
  const pi = {
    registerMessageRenderer: (type: string, fn: unknown) => {
      renderers.set(type, fn as never);
    },
    registerEntryRenderer: (type: string, fn: unknown) => {
      entryRenderers.set(type, fn as never);
    },
  } as unknown as ExtensionAPI;
  registerRenderers(pi);
  const captured = renderers.get(ENTRY_TYPE);
  const entryRenderer = entryRenderers.get(ENTRY_TYPE);
  const questionRenderer = renderers.get(QUESTION_ENTRY_TYPE);
  assert.ok(captured, "result message renderer registered");
  assert.ok(entryRenderer, "result entry renderer registered");
  assert.ok(questionRenderer, "question renderer registered");

  const theme = fakeTheme() as never;
  const options = { expanded: false, outputPad: 2 };
  const withDetails = captured!(
    {
      content: "out",
      details: {
        jobId: 7,
        agent: "a",
        task: "t",
        status: "completed",
        duration: "1s",
        icon: "✓",
        usage: { ...EMPTY_USAGE, turns: 1 },
        model: "openai-codex/gpt-5.6-luna",
        thinkingLevel: "high",
        profile: "primary",
      },
    },
    options,
    theme,
  );
  assert.ok(renderable(withDetails));
  const compactText = renderText(withDetails);
  assert.match(compactText, /✓ #7 a/);
  assert.doesNotMatch(compactText, /profile/i);
  assert.match(compactText, /openai-codex\/gpt-5\.6-luna:high/);
  assert.doesNotMatch(compactText, /\bout\b/);
  assert.match(compactText, /Ctrl\+O to expand/);
  assert.equal(compactText.split("\n").filter((line) => line.trim()).length, 3);

  const entryCard = entryRenderer!(
    {
      data: {
        content: "out",
        details: {
          jobId: 7,
          agent: "a",
          task: "t",
          status: "completed",
          duration: "1s",
          icon: "✓",
        },
      },
    },
    { expanded: false },
    theme,
  );
  assert.match(renderText(entryCard), /✓ #7 a/);
  assert.match(renderText(entryCard), /Ctrl\+O to expand/);

  const failedMessage = {
    content: "subagent launch scout · LaunchFailureTitle: Error: spawn failed",
    details: { jobId: 7, agent: "scout", task: "launch task", title: "LaunchFailureTitle", status: "failed", duration: "?", icon: "✗" },
  };
  for (const failedCard of [
    captured!(failedMessage, { ...options, expanded: true }, theme),
    entryRenderer!({ data: failedMessage }, { expanded: true }, theme),
  ]) {
    const failedText = renderText(failedCard);
    assert.equal(failedText.split("LaunchFailureTitle").length - 1, 1);
    assert.match(failedText, /subagent launch: Error: spawn failed/);
  }
  assert.equal(failedMessage.content, "subagent launch scout · LaunchFailureTitle: Error: spawn failed");

  const longTask = `${"long task ".repeat(16)}WIDE_TASK_END`;
  const longCard = captured!(
    { content: "out", details: { jobId: 7, agent: "a", task: longTask, status: "completed", duration: "1s", icon: "✓" } },
    options,
    theme,
  );
  const narrowHeadline = renderAtWidth(longCard, 120).split("\n").find((line) => line.includes("✓ #7 a"));
  const wideHeadline = renderAtWidth(longCard, 220).split("\n").find((line) => line.includes("✓ #7 a"));
  assert.ok(narrowHeadline);
  assert.ok(wideHeadline);
  assert.equal(renderAtWidth(longCard, 120).split("\n").filter((line) => line.includes("✓ #7 a")).length, 1);
  assert.equal(renderAtWidth(longCard, 220).split("\n").filter((line) => line.includes("✓ #7 a")).length, 1);
  assert.equal(renderAtWidth(longCard, 120).split("\n").length, renderAtWidth(longCard, 220).split("\n").length);
  assert.doesNotMatch(narrowHeadline, /WIDE_TASK_END/);
  assert.match(wideHeadline, /WIDE_TASK_END/);

  const fallbackColors: string[] = [];
  const fallbackTheme = {
    ...fakeTheme(),
    fg: (color: string, text: string) => { fallbackColors.push(color); return text; },
  } as never;
  const withoutDetails = captured!({ content: "plain", details: undefined }, options, fallbackTheme);
  assert.ok(renderable(withoutDetails));
  assert.equal(renderText(withoutDetails).trim(), "plain");
  assert.deepEqual(fallbackColors, ["toolOutput"]);

  const backgroundCalls: string[] = [];
  const expandedTheme = {
    ...fakeTheme(),
    bg: (color: string, text: string) => {
      backgroundCalls.push(color);
      return text;
    },
  } as never;
  const expanded = captured!(
    {
      content: "out",
      details: {
        agent: "a",
        task: "t",
        status: "failed",
        duration: "1s",
        icon: "✗",
        usage: { ...EMPTY_USAGE, turns: 1 },
        model: "openai-codex/gpt-5.6-luna",
        thinkingLevel: "high",
        toolCalls: [
          { name: "read", args: { path: "src/index.ts", offset: 1, limit: 2 } },
          { name: "read", args: { path: "/tmp/project/packages/subagents/extensions/subagents/retained-filename.ts" } },
          { name: "bash", args: { command: "npm test" } },
        ],
      },
    },
    { ...options, expanded: true },
    expandedTheme,
  );
  assert.ok(renderable(expanded));
  assert.match(renderText(expanded), /Tool calls/);
  assert.match(renderText(expanded), /read src\/index\.ts:1-2/);
  assert.match(renderText(expanded), /\$ npm test/);
  const compactStats = compactText.split("\n").find((line) => line.includes("openai-codex/gpt-5.6-luna:high"));
  const expandedStats = renderText(expanded).split("\n").find((line) => line.includes("openai-codex/gpt-5.6-luna:high"));
  assert.ok(compactStats, "compact stats line should be rendered");
  assert.ok(expandedStats, "expanded stats line should be rendered");
  assert.equal(compactStats.match(/^\s*/)?.[0].length, expandedStats.match(/^\s*/)?.[0].length);
  assert.match(renderAtWidth(expanded, 220), /retained-filename\.ts/);
  assert.ok(backgroundCalls.includes("customMessageBg"));

  const questionMessage = {
    content: "model-facing instructions",
    details: {
      jobId: 12,
      agent: "worker",
      questionId: "question-1",
      question: "Which API should I use?",
      context: "The code has two patterns.",
    },
  };
  const question = questionRenderer!(questionMessage, { ...options, expanded: true }, theme);
  const questionText = renderText(question);
  assert.match(questionText, /\? #12 worker: Which API should I use\?/);
  assert.match(questionText, /Context:.*The code has two patterns/);
  assert.match(questionText, /Waiting for parent reply/);
  assert.doesNotMatch(questionText, /question-1/);
  assert.doesNotMatch(questionText, /model-facing instructions/);

  const taggedTheme = {
    ...fakeTheme(),
    fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
  } as never;
  const taggedResult = renderText(captured!(
    {
      content: "out",
      details: {
        jobId: 7,
        agent: "a",
        task: "t",
        status: "completed",
        duration: "1s",
        icon: "✓",
      },
    },
    options,
    taggedTheme,
  ));
  assert.match(taggedResult, /\[success\]✓ /);
  assert.match(taggedResult, /\[accent\]#7 a/);
  assert.match(taggedResult, /\[muted\] \(1s\)/);
  assert.match(taggedResult, /\[dim\]: t/);

  const taggedQuestion = renderText(questionRenderer!(
    questionMessage,
    { ...options, expanded: true },
    taggedTheme,
  ));
  assert.match(taggedQuestion, /\[warning\]\? /);
  assert.match(taggedQuestion, /\[accent\]#12 worker/);
  assert.match(taggedQuestion, /\[dim\]: Which API should I use\?/);
  assert.match(taggedQuestion, /\[muted\]Context: /);
  assert.match(taggedQuestion, /\[dim\]The code has two patterns\./);
  assert.doesNotMatch(taggedQuestion, /question-1/);

  const questionFallbackColors: string[] = [];
  const questionFallbackTheme = {
    ...fakeTheme(),
    fg: (color: string, text: string) => { questionFallbackColors.push(color); return text; },
  } as never;
  const questionFallback = questionRenderer!(
    { content: "legacy question", details: undefined },
    options,
    questionFallbackTheme,
  );
  assert.equal(renderText(questionFallback).trim(), "legacy question");
  assert.deepEqual(questionFallbackColors, ["muted"]);
});

test("renderers preserve card backgrounds through ellipsis and padding", () => {
  const renderers = new Map<string, (message: unknown, options: unknown, theme: unknown) => unknown>();
  const entryRenderers = new Map<string, (entry: unknown, options: unknown, theme: unknown) => unknown>();
  const pi = {
    registerMessageRenderer: (type: string, fn: unknown) => renderers.set(type, fn as never),
    registerEntryRenderer: (type: string, fn: unknown) => entryRenderers.set(type, fn as never),
  } as unknown as ExtensionAPI;
  registerRenderers(pi);

  const ansiTheme = {
    fg: (color: string, text: string) => {
      const codes: Record<string, number> = {
        toolTitle: 252,
        accent: 81,
        muted: 245,
        dim: 242,
        success: 78,
        warning: 214,
        error: 203,
      };
      const prefix = color === "dim"
        ? `\x1b[2;38;5;${codes[color] ?? 250}m`
        : `\x1b[38;5;${codes[color] ?? 250}m`;
      return `${prefix}${text}${color === "dim" ? "\x1b[22;39m" : "\x1b[39m"}`;
    },
    bg: (_color: string, text: string) => `\x1b[48;5;236m${text}\x1b[49m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  };

  const completionMessage = renderers.get(ENTRY_TYPE)!({
    content: "completion output",
    details: {
      jobId: 7,
      agent: "scout",
      task: `${"completion-task ".repeat(18)}COMPLETION_END`,
      status: "completed",
      duration: "1s",
      icon: "✓",
    },
  }, { expanded: false, outputPad: 1 }, ansiTheme);
  const completionCard = entryRenderers.get(ENTRY_TYPE)!({
    data: {
      content: "completion output",
      details: {
        jobId: 7,
        agent: "scout",
        task: `${"completion-card ".repeat(18)}CARD_END`,
        status: "completed",
        duration: "1s",
        icon: "✓",
      },
    },
  }, { expanded: false }, ansiTheme);
  const question = renderers.get(QUESTION_ENTRY_TYPE)!({
    content: "model-facing question",
    details: {
      jobId: 12,
      agent: "worker",
      question: `${"parent-question ".repeat(18)}QUESTION_END`,
    },
  }, { expanded: false, outputPad: 1 }, ansiTheme);

  const { tool: launchTool } = makeTool();
  const sendRegistry = createJobRegistry();
  const sendJobId = sendRegistry.add("scout", "send task");
  const sendTool = createSendTool({ registry: sendRegistry });
  const launchCall = launchTool.renderCall!({
    agent: "scout",
    task: `${"launch-task ".repeat(18)}LAUNCH_END`,
  }, ansiTheme as never, {} as never);
  const sendCall = sendTool.renderCall!({
    jobId: sendJobId,
    deliverAs: "steer",
    message: `${"send-message ".repeat(18)}SEND_END`,
  }, ansiTheme as never, {} as never);

  const cases: Array<[string, unknown]> = [
    ["completion message", completionMessage],
    ["completion card", completionCard],
    ["parent question", question],
    ["launch call", launchCall],
    ["send call", sendCall],
  ];
  const width = 52;
  for (const [label, component] of cases) {
    const card = new Box(0, 0, (text) => ansiTheme.bg("customMessageBg", text));
    card.addChild(component as never);
    const lines = card.render(width);
    assert.ok(lines.length > 0, `${label}: should render`);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `${label}: width overflow`);
    const ellipsisLines = lines.filter((line) => line.includes("..."));
    assert.equal(ellipsisLines.length, 1, `${label}: expected one single-line preview`);
    const line = ellipsisLines[0]!;
    const dots = line.indexOf("...");
    const sgrs = [...line.matchAll(/\x1b\[([0-9;]*)m/g)];
    let backgroundDepth = 0;
    let lastBackgroundChange: number | undefined;
    let bold = false;
    let dim = false;
    let foreground = false;
    for (const match of sgrs) {
      if ((match.index ?? 0) >= dots) break;
      const params = (match[1] ?? "0").split(";").map(Number);
      for (const code of params) {
        if (code === 0) {
          backgroundDepth = 0;
          lastBackgroundChange = 0;
          bold = false;
          dim = false;
          foreground = false;
        } else if (code === 48) {
          backgroundDepth += 1;
          lastBackgroundChange = 48;
        } else if (code === 49) {
          backgroundDepth = Math.max(0, backgroundDepth - 1);
          lastBackgroundChange = 49;
        } else if (code === 1) {
          bold = true;
        } else if (code === 2) {
          dim = true;
        } else if (code === 22) {
          bold = false;
          dim = false;
        } else if (code === 39 || (code >= 30 && code <= 37) || (code >= 90 && code <= 97) || code === 38) {
          foreground = code !== 39;
        }
      }
    }
    assert.equal(lastBackgroundChange, 48, `${label}: ellipsis lost its enclosing background`);
    assert.ok(backgroundDepth > 0, `${label}: no background active at ellipsis`);
    assert.equal(bold, false, `${label}: bold leaked onto ellipsis`);
    assert.equal(dim, false, `${label}: dim leaked onto ellipsis`);
    assert.equal(foreground, false, `${label}: foreground leaked onto ellipsis`);

    const paddingMatch = [...line.matchAll(/ +(?=\x1b\[49m)/g)].filter((match) => (match.index ?? 0) > dots).at(-1);
    assert.ok(paddingMatch, `${label}: missing trailing padding`);
    const paddingStart = paddingMatch!.index ?? 0;
    let paddingBackgroundDepth = 0;
    for (const match of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
      if ((match.index ?? 0) >= paddingStart) break;
      const first = Number((match[1] ?? "0").split(";", 1)[0]);
      if (first === 0) paddingBackgroundDepth = 0;
      else if (first === 48) paddingBackgroundDepth += 1;
      else if (first === 49) paddingBackgroundDepth = Math.max(0, paddingBackgroundDepth - 1);
    }
    assert.ok(paddingBackgroundDepth > 0, `${label}: trailing padding lost its enclosing background`);
  }
});
