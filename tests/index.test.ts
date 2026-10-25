import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentsLocal from "../src/agents-local/index.ts";
import askUser from "../src/ask-user/index.ts";
import btw from "../src/btw/index.ts";
import githubPr from "../src/github-pr/index.ts";
import header from "../src/header/index.ts";
import entry from "../src/index.ts";
import statusline from "../src/statusline/index.ts";
import subagents from "../src/subagents/index.ts";
import webSearch from "../src/web-search/index.ts";
import workingIndicator from "../src/working-indicator/index.ts";

test("the package entry registers everything each factory registers", async (t) => {
	const home = await mkdtemp(join(os.tmpdir(), "pi-guy-entry-"));
	const dirname = Object.getOwnPropertyDescriptor(globalThis, "__dirname");
	t.after(async () => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		if (dirname) Object.defineProperty(globalThis, "__dirname", dirname);
		else Reflect.deleteProperty(globalThis, "__dirname");
		await rm(home, { recursive: true, force: true });
	});
	Object.defineProperty(globalThis, "__dirname", { configurable: true, value: join(import.meta.dirname, "..", "src", "subagents") });
	t.mock.method(os, "homedir", () => home);
	syncBuiltinESMExports();

	const fromEntry = recorder();
	await entry(fromEntry.pi);
	const fromFactories = recorder();
	for (const factory of [agentsLocal, askUser, btw, githubPr, header, statusline, subagents, webSearch, workingIndicator]) {
		await factory(fromFactories.pi);
	}

	assert.ok(fromFactories.calls.length > 0);
	assert.deepEqual(fromEntry.calls.sort(), fromFactories.calls.sort());
});

function recorder() {
	const calls: string[] = [];
	const target: Record<PropertyKey, unknown> = { events: createEventBus() };
	const pi = new Proxy(target, {
		get: (target, method) => target[method] ?? ((first: unknown) => {
			const name = typeof first === "string" ? first : (first as { name?: string }).name;
			calls.push(`${String(method)} ${name}`);
		}),
	}) as unknown as ExtensionAPI;
	return { pi, calls };
}
