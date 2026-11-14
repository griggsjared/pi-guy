import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createJobRegistry } from "../../src/subagents/registry.ts";
import { registerStatusCommands } from "../../src/subagents/status-tools.ts";
import { captureCommands } from "../helpers/pi.ts";
import { fakeTheme } from "../helpers/theme.ts";
import { renderText } from "./helpers.ts";

test("paused tail keeps its event in view as steps and retained history change", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const { registry, id, component, terminal } = openTail();
  t.after(() => component.dispose());
  for (let index = 1; index <= 10; index++) registry.appendEvent(id, { kind: "state", summary: `event ${index}` });
  t.mock.timers.tick(250);
  component.render(100);
  component.handleInput("\x1b[H");
  for (let index = 0; index < 2; index++) component.handleInput("\x1b[B");
  assert.match(renderText(component), /\[3\].*event 3/);

  registry.recordStep(id, { phase: "start", id: "step", kind: "tool", summary: "reading" });
  t.mock.timers.tick(250);
  assert.match(renderText(component), /\[3\].*event 3/);
  assert.doesNotMatch(renderText(component), /\[1\].*event 1/);
  registry.appendEvent(id, { kind: "state", summary: "event 11" });
  t.mock.timers.tick(250);
  assert.match(renderText(component), /\[3\].*event 3/);
  assert.doesNotMatch(renderText(component), /event 11/);
  registry.recordStep(id, { phase: "end", id: "step" });
  t.mock.timers.tick(250);
  assert.match(renderText(component), /\[3\].*event 3/);

  for (let index = 12; index <= 111; index++) registry.appendEvent(id, { kind: "state", summary: `event ${index}` });
  t.mock.timers.tick(250);
  assert.match(renderText(component), /\[12\].*event 12/);
  terminal.rows = 20;
  assert.match(renderText(component), /History dropped before event 12/);
  assert.match(renderText(component), /\[12\].*event 12/);
});

test("the tail remains visible in a one-cell terminal", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const { component, terminal } = openTail();
  t.after(() => component.dispose());
  terminal.rows = 1;
  assert.deepEqual(component.render(1).map(visibleWidth), [1]);
  terminal.rows = 2;
  assert.equal(component.render(1).length, 2);
});

test("a paused tail stays paused when its header shrinks and resumes when a taller terminal reaches the bottom", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const { registry, id, component, terminal } = openTail();
  t.after(() => component.dispose());
  terminal.rows = 30;
  registry.recordStep(id, { phase: "start", id: "step", kind: "tool", summary: "reading" });
  for (let index = 1; index <= 30; index++) registry.appendEvent(id, { kind: "state", summary: `event ${index}` });
  t.mock.timers.tick(250);
  component.render(100);
  component.handleInput("\x1b[A");
  assert.match(renderText(component), /paused/);
  registry.recordStep(id, { phase: "end", id: "step" });
  t.mock.timers.tick(250);
  assert.match(renderText(component), /paused/);
  terminal.rows = 40;
  assert.match(renderText(component), /following/);
  registry.appendEvent(id, { kind: "state", summary: "newest event" });
  t.mock.timers.tick(250);
  assert.match(renderText(component), /newest event/);
  assert.match(renderText(component), /following/);
});

function openTail() {
  const registry = createJobRegistry();
  const id = registry.add("scout", "task");
  const { commands, registerCommand } = captureCommands();
  registerStatusCommands({ registerCommand } as unknown as ExtensionAPI, { registry });
  const terminal = { rows: 8, columns: 100 };
  let component: { render(width: number): string[]; handleInput(data: string): void; dispose(): void } | undefined;
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => typeof component) => {
        component = factory({ terminal, requestRender: () => {} }, fakeTheme(), {}, () => {});
        return new Promise<void>(() => {});
      },
    },
  } as unknown as ExtensionCommandContext;
  void commands.get("subagent-tail")!.handler(String(id), ctx);
  assert.ok(component);
  return { registry, id, component, terminal };
}

test("/subagent-tail opens a live overlay and follows new events", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date(2026, 0, 2, 12, 34, 53).getTime() });
  const registry = createJobRegistry();
  const id = registry.add("scout", "running task", "Tail title");
  registry.recordStep(id, { phase: "start", id: "read-1", kind: "tool", summary: "read" });
  t.mock.timers.tick(3000);
  registry.recordStep(id, { phase: "end", id: "read-1" });
  registry.appendEvent(id, { kind: "state", summary: "started" });
  registry.appendEvent(id, {
    kind: "tool-end",
    stepId: "read-1",
    summary: 'read success: {"content":[{"type":"text","text":"one\\ntwo"}]}',
  });
  registry.recordStep(id, { phase: "start", id: "assistant-1", kind: "assistant", summary: "Thinking" });
  registry.recordStep(id, { phase: "start", id: "tool-1", kind: "tool", summary: "read src/auth.ts" });
  registry.recordStep(id, { phase: "start", id: "retry-1", kind: "retry", summary: "Retrying" });
  const notices: Array<{ text: string; level: string }> = [];
  const { commands, registerCommand } = captureCommands();
  const pi = {
    registerCommand,
  } as unknown as ExtensionAPI;
  registerStatusCommands(pi, { registry });
  const command = commands.get("subagent-tail");
  assert.ok(command);

  interface TailComponent {
    render(width: number): string[];
    handleInput?(data: string): void;
    dispose(): void;
  }
  let component: TailComponent | undefined;
  t.after(() => component?.dispose());
  let overlayOptions: unknown;
  let renderRequests = 0;
  const terminal = { rows: 40, columns: 100 };
  const custom = (
    factory: (
      tui: { requestRender: () => void; terminal: { rows: number } },
      theme: ReturnType<typeof fakeTheme>,
      keybindings: unknown,
      done: (result: void) => void,
    ) => TailComponent,
    options: unknown,
  ) =>
    new Promise<void>((resolve) => {
      overlayOptions = options;
      component = factory(
        {
          terminal,
          requestRender: () => {
            renderRequests += 1;
          },
        },
        fakeTheme(),
        {},
        () => resolve(),
      );
    });
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: { custom, notify: (text: string, level: string) => notices.push({ text, level }) },
  } as unknown as ExtensionCommandContext;

  const pending = command.handler(String(id), ctx);
  assert.ok(component);
  assert.deepEqual(overlayOptions, {
    overlay: true,
    overlayOptions: {
      anchor: "top-center",
      width: "100%",
      maxHeight: "100%",
    },
  });
  assert.match(renderText(component), /Subagent #1 scout/);
  assert.match(renderText(component), /Task: running task/);
  assert.match(renderText(component), /Title: Tail title/);
  assert.match(renderText(component), /started/);
  assert.match(renderText(component), /\[2\] 12:34:56 result\s+read success: one · 2 lines · 3s/);
  assert.doesNotMatch(renderText(component), /content/);
  assert.match(renderText(component), /Active steps \(3\):/);
  t.mock.timers.tick(3000);
  assert.match(renderText(component), /12:34:56 · 3s elapsed · assistant: Thinking/);
  assert.match(renderText(component), /12:34:56 · 3s elapsed · tool: read src\/auth\.ts/);
  assert.match(renderText(component), /12:34:56 · 3s elapsed · retry: Retrying/);
  const beforeIdle = renderRequests;
  t.mock.timers.tick(1000);
  assert.ok(renderRequests > beforeIdle, "elapsed time refreshes without new events");
  assert.match(renderText(component), /12:34:56 · 4s elapsed · tool: read src\/auth\.ts/);
  assert.match(renderText(component), /cursor 2/);

  registry.appendEvent(id, { kind: "assistant", summary: "new event" });
  t.mock.timers.tick(250);
  assert.match(renderText(component), /new event/);
  assert.ok(renderRequests > 0);

  for (let index = 0; index < 20; index += 1) {
    registry.appendEvent(id, { kind: "assistant", summary: `event ${index}` });
  }
  t.mock.timers.tick(250);
  let lines = component.render(100);
  assert.equal(lines.length, 30, "the drawer leaves a quarter of a 40-row terminal free");
  assert.equal(lines.filter((line) => /\[\d+\] \d\d:\d\d:\d\d/.test(line)).length, 20);
  assert.match(lines.join("\n"), /event 19/);
  assert.match(lines[0]!, /Subagent #1 scout · running/);
  assert.match(lines.join("\n"), /Active steps \(3\)/);
  assert.match(lines.join("\n"), /Events 4-23\/23 · cursor 23 · following/);

  terminal.rows = 8;
  lines = component.render(100);
  assert.ok(lines.length <= 6);
  assert.match(lines[0]!, /Subagent #1 scout · running/);
  assert.match(lines.join("\n"), /event 19/);
  component.handleInput!("\x1b[H");
  assert.match(renderText(component), /Subagent #1 scout · running/);
  assert.match(renderText(component), /started/);
  component.handleInput!("\x1b[6~");
  assert.match(renderText(component), /\[4\].*event 0/);
  component.handleInput!("\x1b[A");
  assert.match(renderText(component), /\[3\].*new event/);
  component.handleInput!("\x1b[5~");
  assert.match(renderText(component), /started/);
  registry.appendEvent(id, { kind: "assistant", summary: "while paused" });
  t.mock.timers.tick(250);
  assert.doesNotMatch(renderText(component), /while paused/);
  assert.match(renderText(component), /started/);
  component.handleInput!("\x1b[F");
  assert.match(renderText(component), /while paused/);
  registry.appendEvent(id, { kind: "assistant", summary: "following again" });
  t.mock.timers.tick(250);
  assert.match(renderText(component), /following again/);

  terminal.rows = 4;
  assert.ok(component.render(100).length <= 3);
  assert.match(renderText(component), /following again/);

  terminal.rows = 40;
  component.render(100);
  component.handleInput!("\x1b[H");
  registry.recordStep(id, { phase: "end", id: "assistant-1" });
  registry.recordStep(id, { phase: "end", id: "tool-1" });
  registry.recordStep(id, { phase: "end", id: "retry-1" });
  for (let index = 0; index < 105; index += 1) {
    registry.appendEvent(id, { kind: "state", summary: `replacement ${index}` });
  }
  t.mock.timers.tick(250);
  assert.match(renderText(component), /History dropped before event/);
  component.handleInput!("\x1b[F");
  assert.match(renderText(component), /replacement 104/);

  component.handleInput!("q");
  await pending;
  const afterClose = renderRequests;
  t.mock.timers.tick(1000);
  assert.equal(renderRequests, afterClose);
  await command.handler("bad", ctx);
  assert.match(notices.at(-1)?.text ?? "", /Usage: \/subagent-tail/);
  await command.handler("999", ctx);
  assert.match(notices.at(-1)?.text ?? "", /Unknown subagent job ID: 999/);
});
