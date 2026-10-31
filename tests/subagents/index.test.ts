import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { OFF_PROFILE_NAME, parseSubagentSettings, SESSION_PROFILE_NAME } from "../../src/subagents/agents.ts";
import subagentsExtension from "../../src/subagents/index.ts";
import { createSubagentTool } from "../../src/subagents/tools.ts";
import { PROFILE_ENTRY_TYPE } from "../../src/subagents/constants.ts";
import {
  FakeChild,
  fakeSpawnChildren,
  endEvent,
} from "./fake-child.ts";
import { captureHandlers } from "../helpers/pi.ts";
import { waitFor } from "../helpers/wait.ts";
import { spy, customProfilePicker, renderText } from "./helpers.ts";

test("extension selects profiles explicitly and uses the headless fallback", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "subagents-test-"));
  const extensionDir = join(dir, "src", "subagents");
  const agentsDir = join(dir, "resources", "subagents");
  const settingsDir = join(dir, "agent-config");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = settingsDir;
  const dirname = Object.getOwnPropertyDescriptor(globalThis, "__dirname");
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (dirname) Object.defineProperty(globalThis, "__dirname", dirname);
    else Reflect.deleteProperty(globalThis, "__dirname");
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(agentsDir, { recursive: true });
  await mkdir(settingsDir, { recursive: true });
  await writeFile(join(agentsDir, "scout.md"), "---\nname: scout\nthinkingLevel: high\n---\nYou are a scout.");
  Object.defineProperty(globalThis, "__dirname", { configurable: true, value: extensionDir });

  const profiles = {
    primary: { defaults: { model: "primary/model" }, agents: {} },
    backup: { defaults: { model: "backup/model" }, agents: { scout: { thinkingLevel: "medium" } } },
  };
  const switchesToSession = { profile: SESSION_PROFILE_NAME, model: "p/next", thinking: "high" };
  const keepsBackup = { profile: "backup", model: "backup/model", thinking: "medium" };
  const model = (modelId: string, provider = "p") => ({ type: "model_change", provider, modelId });
  const choice = (name: string) => ({ type: "custom", customType: "subagent-profile", data: { name } });
  const cases: Array<{
    name: string; mode: "print" | "tui"; profiles: Record<string, unknown>; flag?: string;
    profile?: string; model?: string; thinking?: string; error?: RegExp;
    restored?: string; history?: unknown[]; initial?: string; live?: boolean; picker?: boolean;
    modelSwitch?: { profile: string; model: string; thinking: string; picker?: boolean };
  }> = [
    { name: "sole session", mode: "print", profiles: {}, profile: SESSION_PROFILE_NAME, model: "p/m", thinking: "high" },
    { name: "headless does not infer a custom profile alongside session", mode: "print", profiles: { primary: profiles.primary }, model: "p/m", thinking: "high" },
    { name: "headless ignores a restored choice among multiple profiles", mode: "print", profiles, model: "p/m", thinking: "high" },
    { name: "headless flag selects a profile and keeps it after a model change", mode: "print", profiles, flag: "backup", profile: "backup", model: "backup/model", thinking: "medium", modelSwitch: keepsBackup },
    { name: "headless flag selects session", mode: "print", profiles, flag: SESSION_PROFILE_NAME, profile: SESSION_PROFILE_NAME, model: "p/m", thinking: "high" },
    { name: "unknown flag rejects the launch", mode: "print", profiles, flag: "missing", error: /Unknown subagent profile "missing"/ },
    { name: "inherited object properties are not profiles", mode: "print", profiles, flag: "constructor", error: /Unknown subagent profile "constructor"/ },
    { name: "disabled flag rejects the launch", mode: "print", profiles: { ...profiles, backup: { ...profiles.backup, enabled: false } }, flag: "backup", error: /Unknown subagent profile "backup"/ },
    { name: "interactive sole session is inferred", mode: "tui", profiles: {}, profile: SESSION_PROFILE_NAME, model: "p/m", thinking: "high", modelSwitch: switchesToSession },
    { name: "interactive custom profile requires a choice alongside session", mode: "tui", profiles: { primary: profiles.primary }, profile: SESSION_PROFILE_NAME, model: "p/m", thinking: "high", picker: true, modelSwitch: { ...switchesToSession, picker: true } },
    { name: "interactive resume keeps the restored profile until the model changes", mode: "tui", profiles, restored: "backup", profile: "backup", model: "backup/model", thinking: "medium", modelSwitch: { ...switchesToSession, picker: true } },
    { name: "restored session ignores configured defaults", mode: "tui", profiles, history: [choice("session")], initial: "session", profile: "session", model: "p/m", thinking: "high" },
    { name: "inherited restored name requires a new choice", mode: "tui", profiles, history: [choice("constructor")], profile: "session", model: "p/m", thinking: "high", picker: true },
    { name: "latest invalid choice does not restore an older valid choice", mode: "tui", profiles, history: [choice("backup"), choice("removed")], profile: "session", model: "p/m", thinking: "high", picker: true },
    { name: "same model history keeps the restored profile", mode: "tui", profiles, history: [model("b"), model("a"), choice("backup"), model("a")], initial: "backup", profile: "backup", model: "backup/model", thinking: "medium" },
    { name: "model switch and return clears the restored profile", mode: "tui", profiles, history: [model("a"), choice("backup"), model("b"), model("a")], profile: "session", model: "p/m", thinking: "high", picker: true },
    { name: "provider and model boundaries remain distinct", mode: "tui", profiles, history: [model("team/m", "custom"), choice("backup"), model("m", "custom/team")], profile: "session", model: "p/m", thinking: "high", picker: true },
    { name: "restored off survives model history and blocks launch", mode: "tui", profiles, history: [model("a"), choice("off"), model("b")], initial: "off", profile: "off" },
    { name: "interactive launch requires a choice", mode: "tui", profiles, profile: SESSION_PROFILE_NAME, model: "p/m", thinking: "high", live: true, picker: true },
    { name: "interactive flag keeps its profile after a model change", mode: "tui", profiles, flag: "backup", profile: "backup", model: "backup/model", thinking: "medium", modelSwitch: keepsBackup },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (t) => {
      await writeFile(join(settingsDir, "subagents.json"), JSON.stringify({ profiles: entry.profiles }));
      const children = [new FakeChild(), new FakeChild()];
      const { spawnFn, calls } = fakeSpawnChildren(children);
      t.mock.method(childProcess, "spawn", spawnFn);
      syncBuiltinESMExports();
      const tools = new Map<string, ReturnType<typeof createSubagentTool>>();
      const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
      const { handlers, on } = captureHandlers();
      const shortcuts = new Map<string, { handler: (ctx: unknown) => Promise<void> | void }>();
      const flags: Array<[string, string]> = [];
      const entries = spy();
      const statuses = spy();
      let latestStatuses = statuses;
      const titles: string[] = [];
      const notices: string[] = [];
      const profileNotes: string[] = [];
      let completions = 0;
      const pi = {
        registerFlag: (name: string, options: { type: string }) => flags.push([name, options.type]),
        getFlag: (name: string) => name === "subagent-profile" ? entry.flag : undefined,
        registerTool: (tool: ReturnType<typeof createSubagentTool>) => tools.set(tool.name, tool),
        registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
        registerShortcut: (key: string, shortcut: { handler: (ctx: unknown) => Promise<void> | void }) => shortcuts.set(key, shortcut),
        registerEntryRenderer: () => {},
        registerMessageRenderer: () => {},
        on,
        appendEntry: entries.fn,
        sendMessage: (message: { customType: string; content: string }) => {
          if (message.customType === PROFILE_ENTRY_TYPE) profileNotes.push(message.content);
          if (message.customType === "subagents") completions += 1;
        },
      } as unknown as ExtensionAPI;
      const ctx = {
        cwd: dir,
        tools: [],
        executeTool: async () => assert.fail("unexpected nested tool call"),
        mode: entry.mode,
        model: { provider: "p", id: "m" },
        thinkingLevel: "minimal",
        hasUI: entry.mode === "tui",
        isIdle: () => true,
        sessionManager: {
          getEntries: () => entry.history ?? (entry.mode === "tui" && entry.flag === undefined && !entry.restored ? [] : [
            { type: "custom", customType: PROFILE_ENTRY_TYPE, data: { name: entry.restored ?? "primary" } },
          ]),
        },
        ui: {
          notify: (text: string) => notices.push(text),
          custom: customProfilePicker((component) => {
            titles.push(renderText(component).split("\n")[0]!.trimEnd());
            if (/→ backup/.test(renderText(component))) component.handleInput!("\u001b[A");
            component.handleInput!("\r");
          }),
          setWidget: () => {},
          setStatus: statuses.fn,
        },
      } as unknown as ExtensionToolContext;
      try {
        await subagentsExtension(pi);
        assert.deepEqual(flags, [["subagent-profile", "string"]]);
        assert.deepEqual(statuses.calls, []);
        await handlers.get("session_start")!({}, ctx);
        const names = Object.keys(parseSubagentSettings({ profiles: entry.profiles }).profiles);
        const initialProfile = entry.flag ?? entry.initial ?? entry.restored ?? (names.length === 1 ? names[0]! : undefined);
        assert.deepEqual(statuses.calls, entry.mode === "tui" ? [[PROFILE_ENTRY_TYPE, initialProfile]] : []);
        const tool = tools.get("subagent")!;
        if (entry.error) {
          await assert.rejects(tool.execute("launch", { agent: "scout", task: "t" }, undefined, undefined, ctx), entry.error);
          assert.equal(calls.length, 0);
          const status = await tools.get("subagent_status")!.execute("status", {}, undefined, undefined, ctx);
          assert.match((status.content[0] as { text: string }).text, /Running:\*\* none/);
          return;
        }
        if (entry.mode === "print" && names.length === 1) {
          await commands.get("subagent-profile")!.handler("", { ...ctx, hasUI: true });
          assert.deepEqual(notices, ["Active subagent profile: session. Available: session, off"]);
        }
        const result = await tool.execute("launch", { agent: "scout", task: "t" }, undefined, undefined, ctx);
        if (entry.profile === "off") {
          assert.equal(result.details.status, "failed");
          assert.match((result.content[0] as { text: string }).text, /turned subagents off/);
          await handlers.get("model_select")!({ source: "set" }, ctx);
          assert.deepEqual(statuses.calls.at(-1), ["subagent-profile", "off"]);
          assert.equal(calls.length, 0);
          return;
        }
        assert.equal(result.details.profile, entry.profile);
        assert.deepEqual(titles, entry.picker ? [`Subagent profile (active: ${initialProfile ?? "none"})`] : []);
        assert.deepEqual(profileNotes, []);
        assert.deepEqual(statuses.calls.at(-1), entry.mode === "tui" ? [PROFILE_ENTRY_TYPE, entry.profile] : undefined);
        await waitFor(() => calls.length > 0);
        assert.equal(calls.length, 1);
        const args = calls[0]!.args;
        assert.equal(args[args.indexOf("--model") + 1], entry.model);
        assert.equal(args[args.indexOf("--thinking") + 1], entry.thinking);
        children[0]!.stdout.emit("data", Buffer.from(endEvent("done")));
        children[0]!.finish(0);
        await waitFor(() => completions === 1);
        const after = entry.modelSwitch;
        if (after) {
          const beforeTitles = [...titles];
          const beforeModelSelect = [...statuses.calls];
          await handlers.get("model_select")!({ source: "set" }, ctx);
          await handlers.get("model_select")!({ source: "set" }, ctx);
          assert.deepEqual(statuses.calls, after.picker
            ? [...beforeModelSelect, [PROFILE_ENTRY_TYPE, undefined]]
            : beforeModelSelect);
          const next = await tool.execute("next", { agent: "scout", task: "t" }, undefined, undefined, {
            ...ctx, model: { provider: "p", id: "next" }, thinkingLevel: "xhigh",
          } as ExtensionToolContext);
          assert.equal(next.details.profile, after.profile);
          assert.deepEqual(profileNotes, after.picker
            ? ["The main model changed, so the subagent profile was cleared. The next subagent launch asks the user to choose one."]
            : []);
          assert.deepEqual(statuses.calls.at(-1), entry.mode === "tui" ? [PROFILE_ENTRY_TYPE, after.profile] : undefined);
          assert.deepEqual(titles, after.picker ? [...beforeTitles, "Subagent profile (active: none)"] : beforeTitles);
          if (after.picker) {
            assert.deepEqual(entries.calls.filter((call) => call[0] === PROFILE_ENTRY_TYPE).at(-1), [PROFILE_ENTRY_TYPE, { name: after.profile }]);
          }
          await waitFor(() => calls.length === 2);
          assert.equal(calls.length, 2);
          const nextArgs = calls[1]!.args;
          assert.equal(nextArgs[nextArgs.indexOf("--model") + 1], after.model);
          assert.equal(nextArgs[nextArgs.indexOf("--thinking") + 1], after.thinking);
          children[1]!.stdout.emit("data", Buffer.from(endEvent("done")));
          children[1]!.finish(0);
          await waitFor(() => completions === 2);
        }
        if (entry.mode === "tui" && names.length === 1) {
          let pickerOpens = 0;
          const manualCtx = {
            ...ctx,
            model: { provider: "parent", id: "changed" },
            ui: {
              ...ctx.ui,
              custom: customProfilePicker((component) => {
                pickerOpens += 1;
                const preview = renderText(component);
                assert.match(preview, /→ session \(built-in\) \(active\)/);
                assert.match(preview, /Resolved settings: session/);
                assert.match(preview, /scout +parent\/changed +high/);
                component.handleInput!("\r");
              }),
            },
          };
          await commands.get("subagent-profile")!.handler("", manualCtx);
          await shortcuts.get("ctrl+shift+l")!.handler(manualCtx);
          assert.equal(pickerOpens, 2);
          assert.deepEqual(entries.calls.filter((call) => call[0] === PROFILE_ENTRY_TYPE), [
            [PROFILE_ENTRY_TYPE, { name: SESSION_PROFILE_NAME }],
            [PROFILE_ENTRY_TYPE, { name: SESSION_PROFILE_NAME }],
          ]);
        }
        if (entry.live) {
          const command = commands.get("subagent-profile")!;
          await command.handler("backup", ctx);
          assert.deepEqual(statuses.calls.at(-1), [PROFILE_ENTRY_TYPE, "backup"]);
          assert.deepEqual(profileNotes, ["The user switched the subagent profile to backup. Subagents are available."]);
          const beforeInvalid = [...statuses.calls];
          await command.handler("missing", ctx);
          assert.deepEqual(statuses.calls, beforeInvalid);
          await command.handler("", ctx);
          assert.deepEqual(statuses.calls.at(-1), [PROFILE_ENTRY_TYPE, "primary"]);
          await shortcuts.get("ctrl+shift+l")!.handler({
            ...ctx,
            ui: {
              ...ctx.ui,
              custom: customProfilePicker((component) => {
                component.handleInput!("\u001b[B");
                component.handleInput!("\r");
              }),
            },
          });
          assert.deepEqual(statuses.calls.at(-1), [PROFILE_ENTRY_TYPE, "backup"]);

          const resetStatuses = spy();
          const resetCtx = { ...ctx, ui: { ...ctx.ui, setStatus: resetStatuses.fn } };
          await handlers.get("session_start")!({}, resetCtx);
          latestStatuses = resetStatuses;
          assert.deepEqual(resetStatuses.calls, [[PROFILE_ENTRY_TYPE, undefined]]);
          const beforeReset = [...statuses.calls];
          for (const key of ["hasUI", "ui"]) {
            Object.defineProperty(ctx, key, { get: () => { throw new Error("stale context"); } });
          }
          await command.handler("backup", resetCtx);
          assert.deepEqual(resetStatuses.calls.at(-1), [PROFILE_ENTRY_TYPE, "backup"]);
          assert.deepEqual(statuses.calls, beforeReset);

          await handlers.get("model_select")!({ source: "set" }, resetCtx);
          const launchesBeforeOff = calls.length;
          const notesBeforeOff = profileNotes.length;
          const offCtx = {
            ...resetCtx,
            ui: {
              ...resetCtx.ui,
              custom: customProfilePicker((component) => {
                for (let step = 0; step < 3; step += 1) component.handleInput!("\u001b[B");
                assert.match(renderText(component), /\u2192 off \(no subagents\)/);
                assert.match(renderText(component), /Subagents are off/);
                component.handleInput!("\r");
              }),
            },
          } as unknown as ExtensionToolContext;
          const blocked = await tool.execute("off", { agent: "scout", task: "t" }, undefined, undefined, offCtx);
          assert.equal(blocked.details.status, "failed");
          assert.match((blocked.content[0] as { text: string }).text, /turned subagents off/);
          assert.deepEqual(entries.calls.at(-1), [PROFILE_ENTRY_TYPE, { name: OFF_PROFILE_NAME }]);
          assert.deepEqual(resetStatuses.calls.at(-1), [PROFILE_ENTRY_TYPE, OFF_PROFILE_NAME]);
          await handlers.get("model_select")!({ source: "set" }, resetCtx);
          assert.deepEqual(resetStatuses.calls.at(-1), [PROFILE_ENTRY_TYPE, OFF_PROFILE_NAME]);
          const stillBlocked = await tool.execute("off-again", { agent: "scout", task: "t" }, undefined, undefined, resetCtx as unknown as ExtensionToolContext);
          assert.equal(stillBlocked.details.status, "failed");
          assert.equal(calls.length, launchesBeforeOff);
          assert.equal(profileNotes.length, notesBeforeOff);
        }
      } finally {
        await handlers.get("session_shutdown")?.({}, ctx);
        assert.deepEqual(latestStatuses.calls.slice(-1), entry.mode === "tui" ? [
          [PROFILE_ENTRY_TYPE, undefined],
        ] : []);
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  }
});
