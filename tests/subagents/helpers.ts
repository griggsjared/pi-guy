import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, SubagentSettings } from "../../src/subagents/agents.ts";
import { restoreActiveProfile } from "../../src/subagents/index.ts";
import { createJobRegistry } from "../../src/subagents/registry.ts";
import { createSubagentTool } from "../../src/subagents/tools.ts";
import { captureHandlers } from "../helpers/pi.ts";
import { fakeTheme } from "../helpers/theme.ts";
import { FakeChild, fakeSpawn } from "./fake-child.ts";

export const AGENT: AgentConfig = {
  name: "scout",
  description: "test scout",
  systemPrompt: "You are a scout.",
};

export function spy() {
  const calls: unknown[][] = [];
  const fn = (...args: unknown[]) => {
    calls.push(args);
  };
  return { calls, fn };
}

export function complete(registry: ReturnType<typeof createJobRegistry>, id: number, exitCode = 0) {
  registry.complete(id, {
    agent: `agent-${id}`,
    task: `task-${id}`,
    title: `title-${id}`,
    text: "done",
    exitCode,
    error: exitCode === 0 ? "" : "boom",
  });
}

export function makeTool(
  spawnOverride?: { spawnFn: typeof spawn },
  settings: SubagentSettings = { profiles: {}, extensions: [] },
  activeProfile: string | undefined = restoreActiveProfile([], settings),
  confirmProfile: (ctx: ExtensionContext, onPause?: (message: string) => void) => Promise<boolean> = async () => true,
) {
  const registry = createJobRegistry({ now: () => Date.now() });
  const sendMessage = spy();
  const sendUserMessage = spy();
  const appendEntry = spy();
  const { handlers, on } = captureHandlers();
  const pi = {
    sendMessage: sendMessage.fn,
    sendUserMessage: sendUserMessage.fn,
    appendEntry: appendEntry.fn,
    on,
  } as unknown as ExtensionAPI;
  const activeTickers = new Set<ReturnType<typeof setInterval>>();
  const activeProcs = new Set<ChildProcess>();
  const child = new FakeChild();
  const tool = createSubagentTool({
    pi,
    agents: [AGENT],
    settings,
    getActiveProfile: () => activeProfile,
    confirmProfile,
    discover: async () => [AGENT],
    registry,
    activeProcs,
    activeTickers,
    extensionPaths: [],
    bridgeExtensionPath: "/extensions/child-bridge.ts",
    onUiContext: () => {},
    refresh: () => {},
    spawnFn: spawnOverride?.spawnFn ?? fakeSpawn(child),
  });
  const ctx = {
    cwd: "/tmp",
    tools: [],
    executeTool: async () => assert.fail("unexpected nested tool call"),
    model: { provider: "p", id: "m" },
    thinkingLevel: undefined,
    hasUI: false,
    isIdle: () => true,
  } as unknown as ExtensionToolContext;
  return { tool, registry, sendMessage, sendUserMessage, appendEntry, handlers, activeTickers, activeProcs, child, ctx };
}

export function customProfilePicker(interact: (component: Component) => void | Promise<void>, requestRender = () => {}) {
  return (factory: (
    tui: { requestRender: () => void },
    theme: ReturnType<typeof fakeTheme>,
    keybindings: unknown,
    done: (result: string | undefined) => void,
  ) => Component) => new Promise<string | undefined>((resolve, reject) => {
    const component = factory({ requestRender }, fakeTheme(), {}, resolve);
    Promise.resolve(interact(component)).catch(reject);
  });
}

export function renderable(value: unknown): boolean {
  return !!value && typeof (value as { render?: unknown }).render === "function";
}

export function renderAtWidth(value: unknown, width: number): string {
  return (value as { render: (width: number) => string[] }).render(width).join("\n");
}

export function renderText(value: unknown): string {
  return renderAtWidth(value, 120);
}
