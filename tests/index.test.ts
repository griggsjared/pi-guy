import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentsLocal from "../src/agents-local/index.ts";
import askUser from "../src/ask-user/index.ts";
import btw from "../src/btw/index.ts";
import context from "../src/context/index.ts";
import githubPr from "../src/github-pr/index.ts";
import header from "../src/header/index.ts";
import entry from "../src/index.ts";
import providerUsage from "../src/provider-usage/index.ts";
import statusline from "../src/statusline/index.ts";
import subagents from "../src/subagents/index.ts";
import webSearch from "../src/web-search/index.ts";
import workingIndicator from "../src/working-indicator/index.ts";
import { tempDir } from "./helpers/fs.ts";

const FACTORIES = [
  agentsLocal,
  askUser,
  btw,
  context,
  githubPr,
  header,
  statusline,
  providerUsage,
  subagents,
  webSearch,
  workingIndicator,
];

test("the package entry registers everything each factory registers", async (t) => {
  await setUpEntry(t);

  const fromEntry = recorder();
  await entry(fromEntry.pi);
  const fromFactories = recorder();
  for (const factory of FACTORIES) await factory(fromFactories.pi);

  assert.ok(fromFactories.calls.length > 0);
  assert.deepEqual(fromEntry.calls.sort(), fromFactories.calls.sort());
});

test("a feature whose pi-guy.json section sets enabled to false registers nothing", async (t) => {
  const home = await setUpEntry(t);
  const agentDir = join(home, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "pi-guy.json"), JSON.stringify({ btw: { enabled: false } }));

  const fromEntry = recorder();
  await entry(fromEntry.pi);
  const fromOthers = recorder();
  for (const factory of FACTORIES) if (factory !== btw) await factory(fromOthers.pi);

  assert.ok(fromOthers.calls.length > 0);
  assert.deepEqual(fromEntry.calls.sort(), fromOthers.calls.sort());
});

async function setUpEntry(t: TestContext): Promise<string> {
  const dirname = Object.getOwnPropertyDescriptor(globalThis, "__dirname");
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (dirname) Object.defineProperty(globalThis, "__dirname", dirname);
    else Reflect.deleteProperty(globalThis, "__dirname");
  });
  const home = await tempDir(t, "pi-guy-entry-");
  Object.defineProperty(globalThis, "__dirname", {
    configurable: true,
    value: join(import.meta.dirname, "..", "src", "subagents"),
  });
  t.mock.method(os, "homedir", () => home);
  syncBuiltinESMExports();
  return home;
}

function recorder() {
  const calls: string[] = [];
  const target: Record<PropertyKey, unknown> = { events: createEventBus() };
  const pi = new Proxy(target, {
    get: (target, method) =>
      target[method] ??
      ((first: unknown) => {
        const name = typeof first === "string" ? first : (first as { name?: string }).name;
        calls.push(`${String(method)} ${name}`);
      }),
  }) as unknown as ExtensionAPI;
  return { pi, calls };
}
