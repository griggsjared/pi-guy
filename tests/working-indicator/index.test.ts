import assert from "node:assert/strict";
import { test } from "node:test";
import type { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import workingIndicator from "../../src/working-indicator/index.ts";
import { captureHandlers } from "../helpers/pi.ts";
import { fakeTheme } from "../helpers/theme.ts";

type TestContext = ReturnType<typeof createContext>["ctx"];
type Handler = (event: Record<string, unknown>, context: TestContext) => void;

interface Calls {
  messages: Array<string | undefined>;
  indicators: Array<unknown>;
  visibility: boolean[];
  editors: unknown[];
  widgets: Map<string, Widget>;
}

interface Widget {
  component: { render(width: number): string[]; dispose?: () => void };
  placement?: string;
}

function register() {
  const { handlers, on } = captureHandlers();
  workingIndicator({ on } as unknown as ExtensionAPI);
  return handlers;
}

function createContext() {
  const calls: Calls = { messages: [], indicators: [], visibility: [], editors: [], widgets: new Map() };
  return {
    calls,
    ctx: {
      mode: "tui",
      hasUI: true,
      ui: {
        theme: { ...fakeTheme(), style: (text: string) => text },
        setWorkingMessage(message?: string) {
          calls.messages.push(message);
        },
        setWorkingIndicator(indicator?: unknown) {
          calls.indicators.push(indicator);
        },
        setWorkingVisible(visible: boolean) {
          calls.visibility.push(visible);
        },
        setEditorComponent(factory: unknown) {
          calls.editors.push(factory);
        },
        getEditorComponent() {
          return calls.editors.at(-1);
        },
        setWidget(
          key: string,
          factory?: (tui: { requestRender(): void }) => Widget["component"],
          options?: { placement?: string },
        ) {
          calls.widgets.get(key)?.component.dispose?.();
          calls.widgets.delete(key);
          if (factory)
            calls.widgets.set(key, { component: factory({ requestRender() {} }), placement: options?.placement });
        },
      },
      isIdle: () => true,
    },
  };
}

function emit(
  handlers: Map<string, Handler[]>,
  name: string,
  context: TestContext,
  event: Record<string, unknown> = {},
) {
  handlers.get(name)?.[0]?.(event, context);
}

function assistantMessage(content: unknown[] = [], output = 0) {
  return { role: "assistant", content, usage: { output } };
}

function latestTokens(calls: Calls): string {
  const message = calls.messages.at(-1);
  assert.ok(message);
  const match = message.match(/↓ ([^ ]+) tokens/);
  assert.ok(match);
  return match[1]!;
}

function cleanup(handlers: Map<string, Handler[]>, ctx: TestContext) {
  emit(handlers, "agent_settled", ctx);
}

test("starts and settles the observable working indicator lifecycle", () => {
  const handlers = register();
  const { calls, ctx } = createContext();

  emit(handlers, "session_start", ctx);
  assert.equal(typeof calls.editors.at(-1), "function");
  assert.equal(calls.visibility.at(-1), false);
  emit(handlers, "agent_start", ctx);
  assert.equal(calls.visibility.at(-1), true);
  assert.equal(typeof calls.messages.at(-1), "string");
  assert.ok(calls.indicators.at(-1));

  cleanup(handlers, ctx);
  assert.equal(calls.messages.at(-1), undefined);
  assert.equal(calls.indicators.at(-1), undefined);
  assert.equal(calls.visibility.at(-1), false);
});

function createEditor(calls: Calls, requestRender = () => {}): CustomEditor {
  const factory = calls.editors.at(-1) as (...args: ConstructorParameters<typeof CustomEditor>) => CustomEditor;
  return factory(
    { terminal: { rows: 24 }, requestRender } as ConstructorParameters<typeof CustomEditor>[0],
    { borderColor: (text: string) => text, selectList: {} } as ConstructorParameters<typeof CustomEditor>[1],
    { matches: () => false } as unknown as ConstructorParameters<typeof CustomEditor>[2],
  );
}

function nativeStatus(kind: "working" | "compaction" | "branchSummary" | "retry", message: string) {
  const status = {
    kind,
    message,
    render(width: number) {
      return ["", truncateToWidth(`⠋ ${this.message}`, width, "")];
    },
    invalidate() {},
    renderInBorder(width: number) {
      return truncateToWidth(`⠋ ${this.message}`, width, "");
    },
    renderSpinnerInBorder(width: number) {
      return truncateToWidth("⠋", width, "");
    },
  };
  return status;
}

function setNativeStatus(editor: CustomEditor, status: ReturnType<typeof nativeStatus> | undefined) {
  editor.setWorkingStatusIndicator(status as unknown as Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]);
}

function renderedStatus(calls: Calls, width = 160): string {
  const lines = calls.widgets.get("working-indicator")?.component.render(width) ?? [];
  for (const line of lines) assert.ok(visibleWidth(stripTerminalSequences(line)) <= width);
  return lines.map(stripTerminalSequences).join("\n");
}

test("working and non-agent statuses appear above the intact prompt editor", (t) => {
  t.mock.method(Math, "random", () => 0);
  const handlers = register();
  const { calls, ctx } = createContext();
  emit(handlers, "session_start", ctx);
  const editor = createEditor(calls);
  editor.setText("hello");

  for (const [kind, label, displayed] of [
    ["working", "Working...", "Working..."],
    ["compaction", "Compacting context... (esc to cancel)", "Condensing…"],
  ] as const) {
    setNativeStatus(editor, nativeStatus(kind, label));
    const widget = renderedStatus(calls);
    const editorLines = editor.render(160).map(stripTerminalSequences);
    assert.equal(calls.widgets.get("working-indicator")?.placement, "aboveEditor");
    assert.ok(widget.includes(displayed));
    assert.ok(!widget.startsWith("\n"));
    assert.ok(widget.endsWith("\n") && !widget.endsWith("\n\n"));
    assert.ok(editorLines.every((line) => !line.includes(displayed)));
    assert.ok(editorLines[0]?.includes("─"));
    assert.ok(editorLines[1]?.includes("❯ hello"));
  }
});

test("status transitions and editor reinvocation stay above running agents without extra gaps", (t) => {
  t.mock.method(Math, "random", () => 0);
  const handlers = register();
  const { calls, ctx } = createContext();
  emit(handlers, "session_start", ctx);
  let editor = createEditor(calls);
  editor.setText("hello");
  ctx.ui.setWidget("agents", () => ({ render: () => ["Running agents"] }), { placement: "aboveEditor" });

  const composition = () => [
    "",
    ...[...calls.widgets.values()].flatMap(({ component }) => component.render(160).map(stripTerminalSequences)),
    ...editor.render(160).map(stripTerminalSequences),
  ];
  const assertActive = (label: string) => {
    const lines = composition();
    assert.equal(lines[0], "");
    assert.ok(lines[1]?.includes(label));
    assert.deepEqual(lines.slice(2, 4), ["", "Running agents"]);
    assert.ok(lines[4]?.includes("─"));
    assert.ok(lines[5]?.includes("❯ hello"));
  };

  for (const [kind, label, displayed] of [
    ["working", "Working", "Working"],
    ["compaction", "Compacting", "Condensing…"],
    ["retry", "Retrying", "Waiting…"],
    ["branchSummary", "Summarizing", "Summarizing…"],
  ] as const) {
    setNativeStatus(editor, nativeStatus(kind, label));
    assertActive(displayed);
  }
  setNativeStatus(editor, undefined);
  assert.deepEqual(calls.widgets.get("working-indicator")?.component.render(160), []);
  const idle = composition();
  assert.deepEqual(idle.slice(0, 2), ["", "Running agents"]);
  assert.ok(idle[2]?.includes("─"));
  setNativeStatus(editor, nativeStatus("working", "Working again"));
  assertActive("Working again");

  const oldEditor = editor;
  editor = createEditor(calls);
  editor.setText("hello");
  assert.deepEqual(calls.widgets.get("working-indicator")?.component.render(160), []);
  setNativeStatus(oldEditor, nativeStatus("working", "Stale"));
  assert.deepEqual(calls.widgets.get("working-indicator")?.component.render(160), []);
  setNativeStatus(editor, nativeStatus("working", "New working"));
  assertActive("New working");
  emit(handlers, "session_shutdown", ctx);
});

test("the status wrapper preserves native content and does not dispose the native indicator", () => {
  const handlers = register();
  const { calls, ctx } = createContext();
  emit(handlers, "session_start", ctx);
  const editor = createEditor(calls);
  let disposed = 0;
  const status = {
    ...nativeStatus("working", "Working"),
    render: () => ["content", "more"],
    dispose: () => disposed++,
  };
  setNativeStatus(editor, status);
  assert.equal(renderedStatus(calls), "content\nmore\n");
  setNativeStatus(editor, undefined);
  assert.equal(disposed, 0);
  emit(handlers, "session_shutdown", ctx);
  assert.equal(disposed, 0);
});

test("detached and stale editors cannot restore the status widget", () => {
  const handlers = register();
  const { calls, ctx } = createContext();
  const other = createContext();
  emit(handlers, "session_start", ctx);
  const editor = createEditor(calls);
  setNativeStatus(editor, nativeStatus("working", "Working"));
  ctx.ui.setWidget("working-indicator", undefined);
  setNativeStatus(editor, nativeStatus("retry", "Retrying"));
  assert.equal(calls.widgets.has("working-indicator"), false);

  emit(handlers, "session_start", other.ctx);
  const current = createEditor(other.calls);
  setNativeStatus(editor, nativeStatus("working", "Working"));
  assert.equal(calls.widgets.has("working-indicator"), false);
  setNativeStatus(current, nativeStatus("working", "Working"));
  assert.ok(renderedStatus(other.calls).includes("Working"));
  emit(handlers, "session_shutdown", other.ctx);
  setNativeStatus(current, nativeStatus("retry", "Retrying"));
  assert.equal(other.calls.widgets.has("working-indicator"), false);
});

test("a replaced editor cannot display or restore its stale status", () => {
  const handlers = register();
  const { calls, ctx } = createContext();
  emit(handlers, "session_start", ctx);
  const factory = calls.editors.at(-1);
  const oldEditor = createEditor(calls);
  setNativeStatus(oldEditor, nativeStatus("working", "Old status"));
  assert.ok(renderedStatus(calls).includes("Old status"));

  ctx.ui.setEditorComponent(() => ({ setWorkingStatusIndicator() {} }));
  const replacement = createEditor(calls);
  setNativeStatus(replacement, undefined);
  assert.equal(renderedStatus(calls), "");
  setNativeStatus(oldEditor, nativeStatus("working", "Stale status"));
  assert.equal(renderedStatus(calls), "");

  ctx.ui.setEditorComponent(factory);
  const restored = createEditor(calls);
  setNativeStatus(oldEditor, nativeStatus("working", "Stale status"));
  assert.equal(renderedStatus(calls), "");
  setNativeStatus(restored, nativeStatus("working", "Current status"));
  assert.ok(renderedStatus(calls).includes("Current status"));
  setNativeStatus(oldEditor, undefined);
  assert.ok(renderedStatus(calls).includes("Current status"));
  const reinvoked = createEditor(calls);
  assert.equal(renderedStatus(calls), "");
  setNativeStatus(restored, nativeStatus("working", "Stale status"));
  assert.equal(renderedStatus(calls), "");
  setNativeStatus(reinvoked, nativeStatus("working", "New status"));
  assert.ok(renderedStatus(calls).includes("New status"));
  emit(handlers, "session_shutdown", ctx);
});

test("backward clock changes keep agent and non-agent status at zero elapsed time", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = 50_000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(Math, "random", () => 0);
  const handlers = register();
  const { calls, ctx } = createContext();
  emit(handlers, "session_start", ctx);
  const editor = createEditor(calls);
  setNativeStatus(editor, nativeStatus("retry", "Retrying"));
  emit(handlers, "agent_start", ctx);

  now -= 10_000;
  emit(handlers, "message_update", ctx, {
    message: assistantMessage([{ type: "text", text: "1234" }]),
    assistantMessageEvent: { type: "text_delta", delta: "1234" },
  });
  assert.match(calls.messages.at(-1)!, /\(0s · ↓ 1 tokens\)/);
  assert.equal(renderedStatus(calls), " ✻ Waiting… (0s)\n");
  t.mock.timers.tick(150);
  assert.match(calls.messages.at(-1)!, /\(0s · ↓ 1 tokens\)/);
  cleanup(handlers, ctx);
});

test("non-agent compaction and branch summaries show rotating context words and elapsed time", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 50_000 });
  t.mock.method(Math, "random", () => 0);
  const handlers = register();
  const { calls, ctx } = createContext();
  emit(handlers, "session_start", ctx);
  const editor = createEditor(calls);
  assert.equal(editor.embedWorkingStatus, true);

  const labels = [
    ["compaction", "Compacting context... (esc to cancel)", "Condensing", "Distilling"],
    ["branchSummary", "Summarizing branch... (esc to cancel)", "Summarizing", "Gathering"],
  ] as const;
  for (const [kind, label, word, nextWord] of labels) {
    setNativeStatus(editor, undefined);
    setNativeStatus(editor, nativeStatus(kind, label));
    const initial = renderedStatus(calls);
    assert.equal(initial, ` ✻ ${word}… (0s)\n`);
    const spinner = initial.match(/[✻✽✾]/u)?.[0];
    assert.ok(spinner);
    t.mock.timers.tick(150);
    assert.notEqual(renderedStatus(calls).match(/[✻✽✾]/u)?.[0], spinner);
    t.mock.timers.tick(8_850);
    const later = renderedStatus(calls);
    assert.equal(later, ` ✻ ${nextWord}… (9s)\n`);
    assert.match(renderedStatus(calls, 30), /\b9s\b/);
    for (const width of [5, 12]) renderedStatus(calls, width);
  }
});

test("retry shows only a rotating word and elapsed time despite native text updates", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 50_000 });
  t.mock.method(Math, "random", () => 0);
  const handlers = register();
  const { calls, ctx } = createContext();
  emit(handlers, "session_start", ctx);
  const editor = createEditor(calls);
  const status = nativeStatus("retry", "Retrying (2/5) in 10s... (esc to cancel)");
  setNativeStatus(editor, status);
  const initial = renderedStatus(calls);
  assert.equal(initial, " ✻ Waiting… (0s)\n");
  t.mock.timers.tick(3_000);
  status.message = "Retrying (2/5) in 7s... (esc to cancel)";
  const later = renderedStatus(calls);
  assert.equal(later, " ✻ Waiting… (3s)\n");
  t.mock.timers.tick(6_000);
  assert.equal(renderedStatus(calls), " ✻ Reconnecting… (9s)\n");
});

test("clearing or switching to working starts the next non-agent status with a fresh timer", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 50_000 });
  t.mock.method(Math, "random", () => 0);
  const handlers = register();
  const { calls, ctx } = createContext();
  emit(handlers, "session_start", ctx);
  const editor = createEditor(calls);
  setNativeStatus(editor, nativeStatus("compaction", "Compacting context... (esc to cancel)"));
  t.mock.timers.tick(4_000);
  assert.match(renderedStatus(calls), /\b4s\b/);
  setNativeStatus(editor, undefined);
  assert.equal(renderedStatus(calls), "");
  setNativeStatus(editor, nativeStatus("branchSummary", "Summarizing branch... (esc to cancel)"));
  assert.match(renderedStatus(calls), /\b0s\b/);
  t.mock.timers.tick(2_000);
  assert.match(renderedStatus(calls), /\b2s\b/);
  setNativeStatus(editor, nativeStatus("working", "Working..."));
  assert.ok(!renderedStatus(calls).includes("Summarizing…"));
  setNativeStatus(editor, nativeStatus("retry", "Retrying (1/3) in 5s... (esc to cancel)"));
  const retry = renderedStatus(calls);
  assert.equal(retry, " ✻ Waiting… (0s)\n");
});

test("prompt marker stays outside submitted text and preserves wrapped input and mouse placement", () => {
  const handlers = register();
  const { calls, ctx } = createContext();
  emit(handlers, "session_start", ctx);
  const factory = calls.editors.at(-1) as (...args: ConstructorParameters<typeof CustomEditor>) => CustomEditor;
  const editor = factory(
    { terminal: { rows: 24 }, requestRender() {} } as ConstructorParameters<typeof CustomEditor>[0],
    { borderColor: (text: string) => text, selectList: {} } as ConstructorParameters<typeof CustomEditor>[1],
    { matches: () => false } as unknown as ConstructorParameters<typeof CustomEditor>[2],
  );
  setNativeStatus(editor, nativeStatus("working", "Working"));
  editor.setPaddingX(1);
  assert.ok(editor.render(12)[1]?.startsWith("❯ "));
  editor.setText("abcdefghij");
  const lines = editor.render(12).map((line) => line.replace(/\x1b\[[\d;]*m/g, ""));
  assert.ok(lines[1]?.startsWith("❯ abcdefgh"));
  assert.ok(lines[2]?.startsWith("  ij"));
  assert.equal(lines.filter((line) => line.includes("❯")).length, 1);
  editor.handleMouse({
    type: "click",
    button: "left",
    x: 4,
    y: 1,
    screenX: 4,
    screenY: 1,
    width: 12,
    height: lines.length,
    shift: false,
    alt: false,
    ctrl: false,
  });
  assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
  let submitted: string | undefined;
  editor.onSubmit = (text) => {
    submitted = text;
  };
  editor.handleInput("\r");
  assert.equal(submitted, "abcdefghij");
});

test("prompt marker does not overwrite input when the editor is too narrow for its gutter", () => {
  const handlers = register();
  const { calls, ctx } = createContext();
  emit(handlers, "session_start", ctx);
  const factory = calls.editors.at(-1) as (...args: ConstructorParameters<typeof CustomEditor>) => CustomEditor;
  const editor = factory(
    { terminal: { rows: 24 }, requestRender() {} } as ConstructorParameters<typeof CustomEditor>[0],
    { borderColor: (text: string) => text, selectList: {} } as ConstructorParameters<typeof CustomEditor>[1],
    { matches: () => false } as unknown as ConstructorParameters<typeof CustomEditor>[2],
  );
  editor.setText("a");
  const lines = editor.render(4).map((line) => line.replace(/\x1b\[[\d;]*m/g, ""));
  assert.ok(lines[1]?.includes("a"));
  assert.ok(lines.every((line) => visibleWidth(line) <= 4 && !line.includes("❯")));
  assert.equal(editor.getText(), "a");
});

for (const [patternIndex, pattern] of [
  "shimmer",
  "bounce",
  "karaoke",
  "ripple",
  "sparkle",
  "rainbow",
  "palettePulse",
].entries()) {
  for (const direction of ["brighten", "darken"]) {
    test(`${pattern} animates while keeping spinner and text colors synced (${direction})`, (t) => {
      t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 50000 });
      let draws = 0;
      t.mock.method(Math, "random", () => (draws++ === 0 ? patternIndex / 7 : direction === "brighten" ? 0.75 : 0.25));
      const handlers = register();
      const { calls, ctx } = createContext();
      ctx.ui.theme.fg = (color, text) => `<${color}>${text}</${color}>`;
      ctx.ui.theme.bold = (text) => `\x1b[1m${text}\x1b[22m`;
      t.after(() => cleanup(handlers, ctx));
      emit(handlers, "session_start", ctx);
      emit(handlers, "agent_start", ctx);

      const initialMessage = calls.messages.at(-1);
      const initialIndicator = calls.indicators.at(-1);
      t.mock.timers.tick(150);
      assert.notDeepEqual(calls.indicators.at(-1), initialIndicator);
      assert.equal(calls.messages.at(-1), initialMessage);
      t.mock.timers.tick(150);
      if (pattern === "palettePulse") {
        assert.equal(calls.messages.at(-1), initialMessage);
        t.mock.timers.tick(1200);
      }
      assert.notEqual(calls.messages.at(-1), initialMessage);

      for (let frameIndex = 0; frameIndex < 64; frameIndex++) {
        const message = calls.messages.at(-1);
        assert.ok(message);
        const indicator = calls.indicators.at(-1) as { frames: string[] };
        assert.equal(indicator.frames.length, 1);
        const frame = indicator.frames[0]!;
        const firstCharacter = message.replace(/\x1b\[[\d;]*m|<\/?[^>]+>/g, "")[0]!;
        assert.ok(message.startsWith(frame.replace(/[✻✽✾]/u, firstCharacter)));
        const wordColors = [...message.split("<dim>")[0]!.matchAll(/<([^/>]+)>/g)].map((match) => match[1]);
        assert.ok(wordColors.every((color) => color === wordColors[0]));
        t.mock.timers.tick(150);
      }
    });
  }
}

test("shutdown invalidates the local generation before cleanup", () => {
  const handlers = register();
  const { calls, ctx } = createContext();

  emit(handlers, "session_start", ctx);
  emit(handlers, "agent_start", ctx);
  emit(handlers, "session_shutdown", ctx);
  const callCount = calls.visibility.length;
  emit(handlers, "agent_start", ctx);

  assert.equal(calls.messages.at(-1), undefined);
  assert.equal(calls.indicators.at(-1), undefined);
  assert.equal(calls.visibility.at(-1), false);
  assert.equal(calls.visibility.length, callCount);
});

test("terminal content supplies fallback tokens without double-counting deltas", () => {
  const handlers = register();
  const { calls, ctx } = createContext();
  emit(handlers, "session_start", ctx);
  emit(handlers, "agent_start", ctx);

  const content = [{ type: "text", text: "12345678" }];
  emit(handlers, "message_update", ctx, {
    message: assistantMessage(content),
    assistantMessageEvent: { type: "text_delta", delta: "12345678" },
  });
  assert.equal(latestTokens(calls), "2");
  emit(handlers, "message_update", ctx, {
    message: assistantMessage(content),
    assistantMessageEvent: { type: "text_end" },
  });
  assert.equal(latestTokens(calls), "2");
  cleanup(handlers, ctx);
});

test("terminal thinking and tool-call events estimate content when no delta arrived", () => {
  const handlers = register();
  const { calls, ctx } = createContext();
  emit(handlers, "session_start", ctx);
  emit(handlers, "agent_start", ctx);

  emit(handlers, "message_update", ctx, {
    message: assistantMessage([{ type: "thinking", thinking: "12345678" }]),
    assistantMessageEvent: { type: "thinking_end" },
  });
  assert.equal(latestTokens(calls), "2");
  emit(handlers, "message_update", ctx, {
    message: assistantMessage([{ type: "toolCall", arguments: { command: "12345678" } }]),
    assistantMessageEvent: { type: "toolcall_end" },
  });
  assert.ok(Number.parseFloat(latestTokens(calls)) >= 2);
  cleanup(handlers, ctx);
});

test("message updates render at most once for identical state in an animation frame", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 50000 });
  const handlers = register();
  const { calls, ctx } = createContext();
  emit(handlers, "session_start", ctx);
  emit(handlers, "agent_start", ctx);
  const content = [{ type: "text", text: "hello" }];
  const event = { message: assistantMessage(content), assistantMessageEvent: { type: "text_end" } };
  emit(handlers, "message_update", ctx, event);
  const count = calls.messages.length;
  const indicatorCount = calls.indicators.length;
  emit(handlers, "message_update", ctx, event);
  assert.equal(calls.messages.length, count);
  assert.equal(calls.indicators.length, indicatorCount);
  cleanup(handlers, ctx);
});

test("steering and follow-ups preserve totals while normal input resets them", () => {
  const handlers = register();
  const { calls, ctx } = createContext();
  emit(handlers, "session_start", ctx);
  emit(handlers, "agent_start", ctx);
  emit(handlers, "message_update", ctx, {
    message: assistantMessage([{ type: "text", text: "12345678" }]),
    assistantMessageEvent: { type: "text_delta", delta: "12345678" },
  });
  const tokens = latestTokens(calls);
  emit(handlers, "input", ctx, { streamingBehavior: "steer" });
  assert.equal(latestTokens(calls), tokens);
  emit(handlers, "input", ctx, { streamingBehavior: "followUp" });
  assert.equal(latestTokens(calls), tokens);
  emit(handlers, "input", ctx, { streamingBehavior: "prompt" });
  assert.equal(latestTokens(calls), "0");
  cleanup(handlers, ctx);
});

test("a newer runtime makes stale callbacks harmless", () => {
  const first = register();
  const firstContext = createContext();
  emit(first, "session_start", firstContext.ctx);
  emit(first, "agent_start", firstContext.ctx);

  const second = register();
  const secondContext = createContext();
  emit(second, "session_start", secondContext.ctx);
  const firstVisibilityCount = firstContext.calls.visibility.length;
  emit(first, "agent_start", firstContext.ctx);
  emit(first, "session_shutdown", firstContext.ctx);
  assert.equal(firstContext.calls.visibility.length, firstVisibilityCount);

  emit(second, "agent_start", secondContext.ctx);
  assert.equal(secondContext.calls.visibility.at(-1), true);
  cleanup(second, secondContext.ctx);
});

test("session shutdown clears the active indicator and stops animation", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 50000 });
  const handlers = register();
  const { calls, ctx } = createContext();
  emit(handlers, "session_start", ctx);
  emit(handlers, "agent_start", ctx);
  const editor = createEditor(calls);
  setNativeStatus(editor, nativeStatus("working", "Working..."));
  assert.ok(renderedStatus(calls).includes("Working..."));
  emit(handlers, "session_shutdown", ctx);
  assert.equal(renderedStatus(calls), "");
  const messageCount = calls.messages.length;
  const indicatorCount = calls.indicators.length;
  t.mock.timers.tick(1500);
  assert.equal(calls.messages.length, messageCount);
  assert.equal(calls.indicators.length, indicatorCount);

  assert.equal(calls.messages.at(-1), undefined);
  assert.equal(calls.indicators.at(-1), undefined);
  assert.equal(calls.visibility.at(-1), false);
});
