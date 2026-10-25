import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import providerUsage from "../../src/statusline/index.ts";
import { CLAUDE_CACHE_TTL_MS } from "../../src/statusline/providers/claude.ts";

const capturedAt = Date.parse("2026-10-07T16:00:00Z");
const output = [
	"You are currently using your subscription to power your Claude Code usage",
	"Current session: 10% used · resets Oct 7 at 12:59pm (America/Boise)",
	"Current week (all models): 12% used · resets Oct 13 at 4:59am (America/Boise)",
].join("\n");

test("entry wiring registers the footer and publishes provider status", async () => {
	const handlers = new Map<string, Array<(event: any, context: any) => void>>();
	providerUsage({ events: { on() { return () => {}; }, emit() {} }, on(event: string, handler: (event: any, context: any) => void) {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
	} } as unknown as ExtensionAPI);
	let footerSet = false;
	const statuses: Array<string | undefined> = [];
	const context = {
		hasUI: true,
		model: { provider: "deepseek" },
		modelRegistry: { getProvider: () => undefined, getProviderAuth: async () => undefined },
		getContextUsage: () => undefined,
		sessionManager: { getLeafId: () => null, getBranch: () => [] },
		ui: { setFooter() { footerSet = true; }, setStatus(_key: string, value: string | undefined) { statuses.push(value); } },
	};
	try {
		for (const handler of handlers.get("session_start") ?? []) handler({}, context);
		assert.equal(footerSet, true);
		const decoded = statuses.map((value) => value === undefined ? undefined : JSON.parse(value) as { provider?: string; state?: string });
		assert.equal(decoded.some((value) => value?.provider === "deepseek" && value.state === "unknown"), true);
		await new Promise<void>((resolve) => setImmediate(resolve));
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler({}, context);
	}
});

test("fetches DeepSeek balance from the fixed endpoint with an auth header", async () => {
	const handlers = new Map<string, (event: any, context: any) => void>();
	providerUsage({ events: { on() { return () => {}; }, emit() {} }, on(event: string, handler: (event: any, context: any) => void) { handlers.set(event, handler); } } as unknown as ExtensionAPI);
	const originalFetch = globalThis.fetch;
	let url: string | undefined;
	let request: RequestInit | undefined;
	globalThis.fetch = async (target, init) => {
		url = String(target);
		request = init;
		return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "42.50" }] }));
	};
	const statuses: Array<string | undefined> = [];
	const context = {
		hasUI: true, model: { provider: "deepseek" },
		modelRegistry: {
			getProvider: () => ({ baseUrl: "https://api.deepseek.com/v1" }),
			getProviderAuth: async () => ({ auth: { apiKey: "sk-test" } }),
		},
		ui: { setStatus(_key: string, value: string | undefined) { statuses.push(value); } },
	};
	try {
		handlers.get("session_start")?.({}, context);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(url, "https://api.deepseek.com/user/balance");
		assert.equal(request?.redirect, "error");
		assert.equal((request?.headers as Record<string, string>).Authorization, "Bearer sk-test");
		const published = JSON.parse(statuses.at(-1)!);
		assert.deepEqual(published, {
			provider: "deepseek", state: "ready", capturedAtMs: published.capturedAtMs, windows: [], balance: { amount: 42.5, currency: "USD" },
		});
	} finally {
		handlers.get("session_shutdown")?.({}, context);
		globalThis.fetch = originalFetch;
	}
});

test("answers provider usage requests for non-active providers without touching the footer", async () => {
	const handlers = new Map<string, (event: any, context: any) => void>();
	let request: ((data: unknown) => void) | undefined;
	providerUsage({
		events: { on(channel: string, handler: (data: unknown) => void) { if (channel === "provider-usage:request") request = handler; return () => {}; }, emit() {} },
		on(event: string, handler: (event: any, context: any) => void) { handlers.set(event, handler); },
	} as unknown as ExtensionAPI);
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => ++calls === 1
		? new Response(JSON.stringify({ balance_infos: [{ currency: "USD", total_balance: "42.50" }] }))
		: new Response("nope", { status: 503 });
	const statuses: Array<string | undefined> = [];
	const context = {
		hasUI: true, model: { provider: "anthropic" },
		modelRegistry: { getProvider: () => ({ baseUrl: "https://api.deepseek.com" }), getProviderAuth: async () => ({ auth: { apiKey: "sk-test" } }) },
		ui: { setStatus(_key: string, value: string | undefined) { statuses.push(value); } },
	};
	const ask = (provider: string) => new Promise<string | undefined>((resolve) => {
		request?.({ provider, theme: { fg: (_color: string, text: string) => text }, reply: resolve });
	});
	try {
		handlers.get("session_start")?.({}, context);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const footerUpdates = statuses.length;
		assert.equal(await ask("google"), undefined);
		assert.equal(await ask("deepseek"), "b:$42.50");
		assert.equal(await ask("deepseek"), "b:$42.50");
		assert.equal(calls, 1);
		assert.equal(statuses.length, footerUpdates);

		// A new session drops the cache, so the next request refetches and the failure has no stale value.
		handlers.get("session_start")?.({}, context);
		assert.equal(await ask("deepseek"), "quota:?");
		assert.equal(calls, 2);
	} finally {
		handlers.get("session_shutdown")?.({}, context);
		globalThis.fetch = originalFetch;
	}
});

test("rejects DeepSeek balance fetches to non-official endpoints", async () => {
	const originalFetch = globalThis.fetch;
	for (const baseUrl of ["https://api.deepseek.com.evil.tld/v1", "http://api.deepseek.com", "https://api.deepseek.com:8443/v1", "not a url"]) {
		const handlers = new Map<string, (event: any, context: any) => void>();
		providerUsage({ events: { on() { return () => {}; }, emit() {} }, on(event: string, handler: (event: any, context: any) => void) { handlers.set(event, handler); } } as unknown as ExtensionAPI);
		let fetched = false;
		globalThis.fetch = async () => { fetched = true; return new Response("{}"); };
		const statuses: Array<string | undefined> = [];
		const context = {
			hasUI: true, model: { provider: "deepseek" },
			modelRegistry: { getProvider: () => ({ baseUrl }), getProviderAuth: async () => ({ auth: { apiKey: "sk-test" } }) },
			ui: { setStatus(_key: string, value: string | undefined) { statuses.push(value); } },
		};
		try {
			handlers.get("session_start")?.({}, context);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(fetched, false, baseUrl);
			assert.equal(JSON.parse(statuses.at(-1)!).state, "unknown", baseUrl);
		} finally {
			handlers.get("session_shutdown")?.({}, context);
		}
	}
	globalThis.fetch = originalFetch;
});

test("does not fetch DeepSeek balance without an API key", async () => {
	const originalFetch = globalThis.fetch;
	for (const auth of [undefined, { auth: {} }]) {
		const handlers = new Map<string, (event: any, context: any) => void>();
		providerUsage({ events: { on() { return () => {}; }, emit() {} }, on(event: string, handler: (event: any, context: any) => void) { handlers.set(event, handler); } } as unknown as ExtensionAPI);
		let fetched = false;
		globalThis.fetch = async () => { fetched = true; return new Response("{}"); };
		const statuses: Array<string | undefined> = [];
		const context = {
			hasUI: true, model: { provider: "deepseek" },
			modelRegistry: { getProvider: () => ({ baseUrl: "https://api.deepseek.com" }), getProviderAuth: async () => auth },
			ui: { setStatus(_key: string, value: string | undefined) { statuses.push(value); } },
		};
		try {
			handlers.get("session_start")?.({}, context);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(fetched, false);
			assert.equal(JSON.parse(statuses.at(-1)!).state, "unknown");
		} finally {
			handlers.get("session_shutdown")?.({}, context);
		}
	}
	globalThis.fetch = originalFetch;
});

test("bounds DeepSeek auth resolution so a later refresh can still run", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const handlers = new Map<string, (event: any, context: any) => void>();
	providerUsage({ events: { on() { return () => {}; }, emit() {} }, on(event: string, handler: (event: any, context: any) => void) { handlers.set(event, handler); } } as unknown as ExtensionAPI);
	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;
	let authCalls = 0;
	globalThis.fetch = async () => { fetchCalls++; return new Response(JSON.stringify({ balance_infos: [{ currency: "USD", total_balance: "5.00" }] })); };
	const context = {
		hasUI: true, model: { provider: "deepseek" },
		modelRegistry: {
			getProvider: () => ({ baseUrl: "https://api.deepseek.com" }),
			getProviderAuth: () => { authCalls++; return authCalls === 1 ? new Promise(() => {}) : Promise.resolve({ auth: { apiKey: "sk-test" } }); },
		},
		ui: { setStatus() {} },
	};
	try {
		handlers.get("session_start")?.({}, context);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(fetchCalls, 0);
		t.mock.timers.tick(10_000);
		await new Promise<void>((resolve) => setImmediate(resolve));
		handlers.get("turn_end")?.({}, context);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(fetchCalls, 1);
	} finally {
		handlers.get("session_shutdown")?.({}, context);
		globalThis.fetch = originalFetch;
		t.mock.timers.reset();
	}
});

test("preserves a cached DeepSeek balance when a refresh fails", async () => {
	const handlers = new Map<string, (event: any, context: any) => void>();
	providerUsage({ events: { on() { return () => {}; }, emit() {} }, on(event: string, handler: (event: any, context: any) => void) { handlers.set(event, handler); } } as unknown as ExtensionAPI);
	const originalFetch = globalThis.fetch;
	const originalNow = Date.now;
	let now = originalNow();
	let calls = 0;
	globalThis.fetch = async () => ++calls === 1
		? new Response(JSON.stringify({ balance_infos: [{ currency: "USD", total_balance: "42.50" }] }))
		: new Response("nope", { status: 503 });
	const statuses: Array<string | undefined> = [];
	const context = {
		hasUI: true, model: { provider: "deepseek" },
		modelRegistry: { getProvider: () => ({ baseUrl: "https://api.deepseek.com" }), getProviderAuth: async () => ({ auth: { apiKey: "sk-test" } }) },
		ui: { setStatus(_key: string, value: string | undefined) { statuses.push(value); } },
	};
	try {
		Date.now = () => now;
		handlers.get("session_start")?.({}, context);
		await new Promise<void>((resolve) => setImmediate(resolve));
		now += 10 * 60_000;
		handlers.get("turn_end")?.({}, context);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(calls, 2);
		const last = JSON.parse(statuses.at(-1)!);
		assert.equal(last.state, "ready");
		assert.equal(last.balance.amount, 42.5);
	} finally {
		handlers.get("session_shutdown")?.({}, context);
		Date.now = originalNow;
		globalThis.fetch = originalFetch;
	}
});

test("fetches Anthropic plan usage from the OAuth usage endpoint", async () => {
	const handlers = new Map<string, (event: any, context: any) => void>();
	providerUsage({ events: { on() { return () => {}; }, emit() {} }, on(event: string, handler: (event: any, context: any) => void) { handlers.set(event, handler); } } as unknown as ExtensionAPI);
	const originalFetch = globalThis.fetch;
	const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
	globalThis.fetch = async (target, init) => {
		requests.push({ url: String(target), init });
		return new Response(JSON.stringify({
			five_hour: { utilization: 13.0, resets_at: "2026-10-17T20:40:00.085011+00:00" },
			seven_day: { utilization: 19.0, resets_at: "2026-10-18T04:00:00.085037+00:00" },
			seven_day_opus: null,
		}));
	};
	let apiKey = "sk-ant-oat01-test";
	const statuses: Array<string | undefined> = [];
	const context = {
		hasUI: true, model: { provider: "anthropic" },
		modelRegistry: { getProvider: () => undefined, getProviderAuth: async () => ({ auth: { apiKey } }) },
		ui: { setStatus(_key: string, value: string | undefined) { statuses.push(value); } },
	};
	const start = async () => {
		handlers.get("session_start")?.({}, context);
		await new Promise<void>((resolve) => setImmediate(resolve));
		return JSON.parse(statuses.at(-1)!) as { state: string; windows: unknown[] };
	};
	try {
		const usage = await start();
		assert.equal(requests.length, 1);
		assert.equal(requests[0]!.url, "https://api.anthropic.com/api/oauth/usage");
		const headers = requests[0]!.init?.headers as Record<string, string>;
		assert.equal(headers.Authorization, "Bearer sk-ant-oat01-test");
		assert.equal(headers["anthropic-beta"], "oauth-2025-04-20");
		assert.deepEqual(usage.windows, [
			{ kind: "rolling", label: "5h", usedPercent: 13, resetAtMs: Date.parse("2026-10-17T20:40:00.085Z") },
			{ kind: "weekly", label: "7d", usedPercent: 19, resetAtMs: Date.parse("2026-10-18T04:00:00.085Z") },
		]);

		// API keys have no plan quota, so nothing is fetched.
		apiKey = "sk-ant-api03-test";
		const keyUsage = await start();
		assert.equal(requests.length, 1);
		assert.equal(keyUsage.state, "ready");
		assert.deepEqual(keyUsage.windows, []);
	} finally {
		handlers.get("session_shutdown")?.({}, context);
		globalThis.fetch = originalFetch;
	}
});

test("publishes Anthropic usage from response headers", async () => {
	const handlers = new Map<string, (event: any, context: any) => void>();
	providerUsage({ events: { on() { return () => {}; }, emit() {} }, on(event: string, handler: (event: any, context: any) => void) {
		handlers.set(event, handler);
	} } as unknown as ExtensionAPI);
	const statuses: Array<string | undefined> = [];
	let loads = 0;
	const context = {
		hasUI: true,
		model: { provider: "anthropic" },
		modelRegistry: { getProvider: () => { loads++; return undefined; }, getProviderAuth: async () => undefined },
		ui: { setStatus(_key: string, value: string | undefined) { statuses.push(value); } },
	};
	const last = () => JSON.parse(statuses.at(-1)!) as { state: string; windows: Array<{ usedPercent: number }> };
	try {
		handlers.get("session_start")?.({}, context);
		handlers.get("turn_end")?.({}, context);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(last().state, "unknown");

		// API-key replies carry no plan headers, so the footer shows no quota placeholder.
		handlers.get("after_provider_response")?.({ status: 200, headers: {} }, context);
		assert.equal(last().state, "ready");
		assert.deepEqual(last().windows, []);

		handlers.get("after_provider_response")?.({ status: 200, headers: { "anthropic-ratelimit-unified-5h-utilization": "0.25" } }, context);
		assert.equal(last().windows[0]?.usedPercent, 25);
		handlers.get("after_provider_response")?.({ status: 500, headers: {} }, context);
		assert.equal(last().windows[0]?.usedPercent, 25);

		// Header data counts as a fresh fetch, so the next turn does not hit the usage endpoint.
		const loadsBefore = loads;
		handlers.get("turn_end")?.({}, context);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(loads, loadsBefore);
		assert.equal(last().windows[0]?.usedPercent, 25);
	} finally {
		handlers.get("session_shutdown")?.({}, context);
	}
});

test("does not expose OpenCode credentials through status or errors", async () => {
	const handlers = new Map<string, (event: any, context: any) => void>();
	providerUsage({ events: { on() { return () => {}; }, emit() {} }, on(event: string, handler: (event: any, context: any) => void) {
		handlers.set(event, handler);
	} } as unknown as ExtensionAPI);
	const originalFetch = globalThis.fetch;
	const originalWorkspace = process.env.OPENCODE_GO_WORKSPACE_ID;
	const originalCookie = process.env.OPENCODE_GO_AUTH_COOKIE;
	const secret = "cookie-that-must-not-leak";
	process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_test";
	process.env.OPENCODE_GO_AUTH_COOKIE = secret;
	globalThis.fetch = async () => new Response("nope", { status: 503 });
	const statuses: Array<string | undefined> = [];
	const context = {
		hasUI: true, model: { provider: "opencode-go" },
		ui: { setStatus(_key: string, value: string | undefined) { statuses.push(value); } },
	};
	try {
		handlers.get("session_start")?.({ type: "session_start" }, context);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(statuses.some((status) => status?.includes(secret)), false);
	} finally {
		handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context);
		globalThis.fetch = originalFetch;
		if (originalWorkspace === undefined) delete process.env.OPENCODE_GO_WORKSPACE_ID;
		else process.env.OPENCODE_GO_WORKSPACE_ID = originalWorkspace;
		if (originalCookie === undefined) delete process.env.OPENCODE_GO_AUTH_COOKIE;
		else process.env.OPENCODE_GO_AUTH_COOKIE = originalCookie;
	}
});

test("preserves cached usage when a refresh fails", async () => {
	const handlers = new Map<string, (event: any, context: any) => void>();
	providerUsage({ events: { on() { return () => {}; }, emit() {} }, on(event: string, handler: (event: any, context: any) => void) { handlers.set(event, handler); } } as unknown as ExtensionAPI);
	const originalFetch = globalThis.fetch;
	const originalWorkspace = process.env.OPENCODE_GO_WORKSPACE_ID;
	const originalCookie = process.env.OPENCODE_GO_AUTH_COOKIE;
	process.env.OPENCODE_GO_WORKSPACE_ID = "workspace";
	process.env.OPENCODE_GO_AUTH_COOKIE = "secret";
	let calls = 0;
	globalThis.fetch = async () => ++calls === 1
		? new Response(`rollingUsage:{usagePercent:10,resetInSec:30}`)
		: new Response("nope", { status: 503 });
	const statuses: Array<string | undefined> = [];
	const context = { hasUI: true, model: { provider: "opencode-go" }, ui: { setStatus(_key: string, value: string | undefined) { statuses.push(value); } } };
	const originalNow = Date.now;
	let now = originalNow();
	try {
		Date.now = () => now;
		handlers.get("session_start")?.({}, context);
		await new Promise<void>((resolve) => setImmediate(resolve));
		now += 10 * 60_000;
		handlers.get("turn_end")?.({}, context);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(calls, 2);
		assert.equal(JSON.parse(statuses.at(-1)!).state, "ready");
	} finally {
		handlers.get("session_shutdown")?.({}, context);
		Date.now = originalNow;
		globalThis.fetch = originalFetch;
		if (originalWorkspace === undefined) delete process.env.OPENCODE_GO_WORKSPACE_ID; else process.env.OPENCODE_GO_WORKSPACE_ID = originalWorkspace;
		if (originalCookie === undefined) delete process.env.OPENCODE_GO_AUTH_COOKIE; else process.env.OPENCODE_GO_AUTH_COOKIE = originalCookie;
	}
});

test("Codex requests use the fixed endpoint, redirect policy, and auth headers", async () => {
	const handlers = new Map<string, (event: any, context: any) => void>();
	providerUsage({ events: { on() { return () => {}; }, emit() {} }, on(event: string, handler: (event: any, context: any) => void) { handlers.set(event, handler); } } as unknown as ExtensionAPI);
	const originalFetch = globalThis.fetch;
	const account = "acct_test";
	const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.x`;
	let request: RequestInit | undefined;
	globalThis.fetch = async (url, init) => { assert.equal(url, "https://chatgpt.com/backend-api/wham/usage"); request = init; return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 10 } } })); };
	const context = { hasUI: true, model: { provider: "openai-codex" }, modelRegistry: { getProvider: () => ({ baseUrl: "https://chatgpt.com/backend-api" }), getProviderAuth: async () => ({ auth: { baseUrl: "https://chatgpt.com/backend-api", apiKey: token } }) }, ui: { setStatus() {} } };
	try {
		handlers.get("session_start")?.({}, context);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(request?.redirect, "error");
		assert.equal((request?.headers as Record<string, string>)["ChatGPT-Account-Id"], account);
		assert.equal((request?.headers as Record<string, string>).Authorization, `Bearer ${token}`);
	} finally {
		handlers.get("session_shutdown")?.({}, context);
		globalThis.fetch = originalFetch;
	}
});

test("same-provider selection aborts the old request", async () => {
	const handlers = new Map<string, (event: any, context: any) => void>();
	providerUsage({ events: { on() { return () => {}; }, emit() {} }, on(event: string, handler: (event: any, context: any) => void) { handlers.set(event, handler); } } as unknown as ExtensionAPI);
	const originalFetch = globalThis.fetch;
	let aborted = false;
	globalThis.fetch = (_url, init) => new Promise<Response>((_, reject) => {
		init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
	});
	const context = { hasUI: true, model: { provider: "opencode-go" }, ui: { setStatus() {} } };
	process.env.OPENCODE_GO_WORKSPACE_ID = "workspace"; process.env.OPENCODE_GO_AUTH_COOKIE = "secret";
	try {
		handlers.get("session_start")?.({}, context);
		handlers.get("model_select")?.({ model: context.model }, context);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(aborted, true);
	} finally {
		handlers.get("session_shutdown")?.({}, context);
		globalThis.fetch = originalFetch;
		delete process.env.OPENCODE_GO_WORKSPACE_ID; delete process.env.OPENCODE_GO_AUTH_COOKIE;
	}
});

test("ignores a stale OpenCode response after switching providers", async () => {
	const handlers = new Map<string, (event: any, context: any) => void>();
	providerUsage({
		events: { on() { return () => {}; }, emit() {} },
		on(event: string, handler: (event: any, context: any) => void) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI);

	let resolveFetch: ((response: Response) => void) | undefined;
	const originalFetch = globalThis.fetch;
	const originalWorkspace = process.env.OPENCODE_GO_WORKSPACE_ID;
	const originalCookie = process.env.OPENCODE_GO_AUTH_COOKIE;
	process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_test";
	process.env.OPENCODE_GO_AUTH_COOKIE = "secret";
	globalThis.fetch = () => new Promise<Response>((resolve) => { resolveFetch = resolve; });

	const statuses: Array<string | undefined> = [];
	const context = {
		hasUI: true,
		model: { provider: "opencode-go" },
		ui: { setStatus(_key: string, value: string | undefined) { statuses.push(value); } },
	};
	try {
		handlers.get("session_start")?.({ type: "session_start" }, context);
		context.model = { provider: "google" };
		handlers.get("model_select")?.({ model: context.model }, context);
		resolveFetch?.(new Response(`rollingUsage:{usagePercent:10,resetInSec:30}`));
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(statuses.at(-1), undefined);
	} finally {
		handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context);
		globalThis.fetch = originalFetch;
		if (originalWorkspace === undefined) delete process.env.OPENCODE_GO_WORKSPACE_ID;
		else process.env.OPENCODE_GO_WORKSPACE_ID = originalWorkspace;
		if (originalCookie === undefined) delete process.env.OPENCODE_GO_AUTH_COOKIE;
		else process.env.OPENCODE_GO_AUTH_COOKIE = originalCookie;
	}
});

test("Claude wiring caches quotas for five minutes and retries failed refreshes until fresh quotas replace them", async (t) => {
	let reads = 0;
	mockCli(t, (call) => {
		reads++;
		if (reads === 1) call.complete(null, output);
		else if (reads <= 3) call.complete(new Error("secret CLI failure"), "");
		else call.complete(null, output.replace("10% used", "20% used"));
	});
	const originalNow = Date.now;
	let now = capturedAt;
	const { handlers, context, statuses } = entryContext();
	try {
		Date.now = () => now;
		handlers.get("session_start")?.({}, context);
		assert.equal(JSON.parse(statuses.at(-1)!).state, "unknown");
		await settle();
		const ready = JSON.parse(statuses.at(-1)!);
		assert.equal(ready.provider, "claude-bridge");
		assert.equal(ready.state, "ready");
		now += CLAUDE_CACHE_TTL_MS - 1;
		handlers.get("turn_end")?.({}, context);
		await settle();
		assert.equal(reads, 1);
		now++;
		handlers.get("turn_end")?.({}, context);
		await settle();
		assert.equal(reads, 2);
		assert.deepEqual(JSON.parse(statuses.at(-1)!), ready);
		handlers.get("turn_end")?.({}, context);
		await settle();
		assert.equal(reads, 3);
		assert.deepEqual(JSON.parse(statuses.at(-1)!), ready);
		handlers.get("turn_end")?.({}, context);
		await settle();
		assert.equal(reads, 4);
		assert.equal(JSON.parse(statuses.at(-1)!).windows[0].usedPercent, 20);
		assert.equal(statuses.some((value) => value?.includes("secret")), false);
	} finally {
		handlers.get("session_shutdown")?.({}, context);
		Date.now = originalNow;
	}
});

test("index timeout cancels a hung Claude CLI request and permits a later refresh", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let reads = 0;
	const calls = mockCli(t, (call) => { if (++reads > 1) call.complete(null, output); });
	const { handlers, context, statuses } = entryContext();
	try {
		handlers.get("session_start")?.({}, context);
		await settle();
		assert.equal(reads, 1);
		t.mock.timers.tick(10_000);
		await settle();
		assert.equal(calls[0]?.options.signal.aborted, true);
		assert.equal(JSON.parse(statuses.at(-1)!).state, "unknown");
		handlers.get("turn_end")?.({}, context);
		await settle();
		assert.equal(reads, 2);
		assert.equal(JSON.parse(statuses.at(-1)!).state, "ready");
	} finally {
		handlers.get("session_shutdown")?.({}, context);
		t.mock.timers.reset();
	}
});

test("does not publish stale Claude results after selection, reload, or shutdown", async (t) => {
	for (const event of ["model_select", "session_start", "session_shutdown"]) {
		await t.test(event, async (t) => {
			const calls = mockCli(t, () => {});
			const { handlers, context, statuses } = entryContext();
			try {
				handlers.get("session_start")?.({}, context);
				await settle();
				handlers.get(event)?.({ model: context.model }, context);
				await settle();
				assert.equal(calls[0]?.options.signal.aborted, true);
				calls[0]?.complete(null, output);
				await settle();
				assert.equal(statuses.some((value) => value && JSON.parse(value).state === "ready"), false);
				if (event !== "session_shutdown") {
					calls[1]?.complete(null, output);
					await settle();
					assert.equal(JSON.parse(statuses.at(-1)!).state, "ready");
				} else assert.equal(statuses.at(-1), undefined);
			} finally {
				handlers.get("session_shutdown")?.({}, context);
			}
		});
	}
});

type CliCall = {
	file: string;
	args: string[];
	options: { signal: AbortSignal };
	stdinClosed: boolean;
	complete(error: Error | null, stdout: string): void;
};

function mockCli(t: TestContext, load: (call: CliCall) => void): CliCall[] {
	const calls: CliCall[] = [];
	t.mock.method(childProcess, "execFile", (file: string, args: string[], options: any, callback: any) => {
		const call: CliCall = { file, args, options, stdinClosed: false, complete: (error, stdout) => callback(error, stdout, "secret stderr") };
		calls.push(call);
		options.signal.addEventListener("abort", () => call.complete(options.signal.reason, ""), { once: true });
		queueMicrotask(() => load(call));
		return { stdin: { end() { call.stdinClosed = true; } } } as any;
	});
	return calls;
}

function settle(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function entryContext() {
	const handlers = new Map<string, (event: any, context: any) => void>();
	providerUsage({ events: { on() { return () => {}; }, emit() {} }, on(event: string, handler: (event: any, context: any) => void) { handlers.set(event, handler); } } as unknown as ExtensionAPI);
	const statuses: Array<string | undefined> = [];
	const context = {
		hasUI: true, model: { provider: "claude-bridge" },
		ui: { setStatus(_key: string, value: string | undefined) { statuses.push(value); } },
	};
	return { handlers, context, statuses };
}
