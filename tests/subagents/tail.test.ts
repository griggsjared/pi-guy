import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createJobRegistry } from "../../src/subagents/registry.ts";
import { registerStatusCommands } from "../../src/subagents/status-tools.ts";
import { captureCommands } from "../helpers/pi.ts";
import { fakeTheme } from "../helpers/theme.ts";
import { renderText } from "./helpers.ts";

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
  const custom = (
    factory: (
      tui: { requestRender: () => void },
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
      anchor: "center",
      width: "100%",
      minWidth: 60,
      maxHeight: "100%",
      margin: 1,
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
