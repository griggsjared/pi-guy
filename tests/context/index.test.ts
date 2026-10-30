import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextUsage, ExtensionAPI, ExtensionCommandContext, Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import context from "../../src/context/index.ts";
import { fakeTheme } from "../helpers/theme.ts";

function harness({
	prompt = "instructions",
	messages = [],
	tools = [],
	active = tools.map((tool) => tool.name),
	hidden = [],
	keybindings = new KeybindingsManager(TUI_KEYBINDINGS),
}: {
	prompt?: string;
	messages?: AgentMessage[];
	tools?: ToolInfo[];
	active?: string[];
	hidden?: string[];
	keybindings?: KeybindingsManager;
} = {}) {
	let handler!: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
	let modal!: Component;
	let options: { overlay?: boolean; overlayOptions?: OverlayOptions } | undefined;
	let completions = 0;
	const notifications: { text: string; level: string }[] = [];
	const styles: { color: string; text: string }[] = [];
	context({
		registerCommand: (name: string, command: { handler: typeof handler }) => {
			if (name === "context") handler = command.handler;
		},
		getAllTools: () => tools,
		getActiveTools: () => active,
	} as unknown as ExtensionAPI);
	const ctx = {
		mode: "tui",
		model: { id: "test-model", name: "Test model", contextWindow: 200 },
		getContextUsage: (): ContextUsage | undefined => ({ tokens: 101, contextWindow: 200, percent: 50.5 }),
		getSystemPrompt: () => prompt,
		getSystemPromptOptions: () => ({ hiddenTools: hidden }),
		sessionManager: {
			buildSessionProjection: () => ({ messages }),
			getEntries: () => assert.fail("context must use the projection, not full history"),
		},
		ui: {
			notify: (text: string, level: string) => { notifications.push({ text, level }); },
			custom: (
				factory: (tui: TUI, theme: Theme, kb: KeybindingsManager, done: () => void) => Component,
				customOptions: typeof options,
			) => {
				options = customOptions;
				const pending = Promise.withResolvers<void>();
				modal = factory({ terminal: { rows: 40 } } as TUI, {
					...fakeTheme(),
					fg: (color: string, text: string) => { styles.push({ color, text }); return text; },
				} as Theme, keybindings, () => { completions++; pending.resolve(); });
				return pending.promise;
			},
		},
	} as unknown as ExtensionCommandContext;
	return {
		ctx, notifications, styles,
		start: () => handler("", ctx),
		input: (key: string) => modal.handleInput!(key),
		render: (width: number) => modal.render(width),
		get options() { return options; },
		get completions() { return completions; },
		async show() {
			const running = handler("", ctx);
			const lines = modal.render(76);
			modal.handleInput!("\r");
			await running;
			return lines.join("\n");
		},
	};
}

function tool(name: string, exposure: ToolInfo["exposure"] = "direct"): ToolInfo {
	return {
		name, exposure, description: "Run",
		parameters: Type.Object({ path: Type.String({ description: "schema ".repeat(40) }) }),
		sourceInfo: { path: "inline:test", source: "inline", scope: "temporary", origin: "top-level" },
	};
}

function allocations(text: string): number[] {
	return [...text.matchAll(/(?:System instructions|Tool definitions|Conversation|Tool results): ~([\d,]+) tokens/g)]
		.map((match) => Number(match[1]!.replaceAll(",", "")));
}

test("attributes only current instructions, active visible declarations, and projected conversation or results", async () => {
	const messages = [
		{ role: "user", content: "u".repeat(8) },
		{ role: "custom", content: "c".repeat(8), customType: "context" },
		{ role: "assistant", content: [{ type: "text", text: "aaaa" }, { type: "thinking", thinking: "tttt" }] },
		{ role: "toolResult", content: [{ type: "text", text: "r".repeat(24) }] },
	] as AgentMessage[];
	const baseline = harness({ prompt: "s".repeat(24), messages, tools: [tool("visible")] });
	const clean = await baseline.show();
	const counts = allocations(clean);
	assert.equal(counts.length, 4);
	assert.equal(counts.reduce((sum, count) => sum + count, 0), 101);
	assert.ok(counts[1]! > counts[0]! + counts[2]! + counts[3]!, "schema contributes to tool definitions");
	assert.ok(Math.max(counts[0]!, counts[2]!, counts[3]!) - Math.min(counts[0]!, counts[2]!, counts[3]!) <= 1);
	assert.ok(counts[0]! > 0);
	assert.match(clean, /Model: Test model/);
	assert.match(clean, /Window: 200 tokens/);
	assert.match(clean, /Used: 101 tokens \(50\.5%\) · Pi estimate/);
	assert.match(clean, /Free: 99 tokens/);
	assert.match(clean, /Estimated breakdown/);
	const prose = clean.replace(/[│\n]/g, " ").replace(/\s+/g, " ");
	assert.match(prose, /Relative text\/schema estimates, not measured category counts/);
	assert.match(prose, /Images and provider serialization are not measured/);
	assert.ok(clean.indexOf("■") < clean.indexOf("Estimated breakdown"));
	for (const color of ["accent", "warning", "success", "toolTitle"]) {
		assert.ok(baseline.styles.some((style) => style.color === color && style.text === "■"));
	}
	assert.ok(baseline.styles.some((style) => style.color === "dim" && style.text === "·"));

	const polluted = harness({
		prompt: "s".repeat(24),
		messages: [
			{ role: "system", content: "old prompt".repeat(1000) },
			...structuredClone(messages),
			{ role: "system", content: "prompt delta".repeat(1000), toolsAdded: [{ name: "obsolete" }] },
		] as AgentMessage[],
		tools: [tool("visible"), tool("inactive"), tool("loadout-hidden"), tool("withdrawn", "hidden")],
		active: ["visible", "loadout-hidden", "withdrawn"],
		hidden: ["loadout-hidden"],
	});
	const result = polluted.ctx.sessionManager.buildSessionProjection().messages.at(-2)!;
	if (result.role === "toolResult") result.content.push({ type: "image", data: "x".repeat(10000), mimeType: "image/png" });
	assert.equal(await polluted.show(), clean);
	assert.deepEqual(polluted.notifications, []);
});

test("estimates startup instructions and tools only for an empty projection with known zero usage", async () => {
	const messages: AgentMessage[] = [];
	const h = harness({ prompt: "s".repeat(80), messages, tools: [tool("visible")] });
	h.ctx.getContextUsage = () => ({ tokens: 0, contextWindow: 200, percent: 0 });
	const text = await h.show();
	const total = text.match(/Used: ([\d,]+) tokens \([\d.]+%\) · Startup estimate \(chars\/4\)/);
	assert.ok(total);
	const used = Number(total[1]!.replaceAll(",", ""));
	const counts = allocations(text);
	assert.ok(counts[0]! > 0);
	assert.ok(counts[1]! > 0);
	assert.deepEqual(counts.slice(2), [0, 0]);
	assert.equal(counts.reduce((sum, count) => sum + count, 0), used);
	assert.match(text, new RegExp(`Free: ${200 - used} tokens`));
	assert.ok(h.styles.some((style) => style.color === "dim" && style.text === "·"));

	for (const usage of [{ tokens: null, contextWindow: 200, percent: null }, undefined]) {
		h.ctx.getContextUsage = () => usage;
		const unknown = await h.show();
		assert.match(unknown, /Used: unknown tokens/);
		assert.equal(allocations(unknown).length, 0);
	}

	messages.push({ role: "user", content: "prior request" } as AgentMessage);
	h.ctx.getContextUsage = () => ({ tokens: 0, contextWindow: 200, percent: 0 });
	const existing = await h.show();
	assert.match(existing, /Used: 0 tokens \(0\.0%\) · Pi estimate/);
	assert.deepEqual(allocations(existing), [0, 0, 0, 0]);
});

test("rounded allocations reconcile with used tokens and free space at capacity boundaries", async () => {
	const h = harness({
		prompt: "s",
		messages: [{ role: "user", content: "c" }, { role: "toolResult", content: [{ type: "text", text: "r" }] }] as AgentMessage[],
	});
	for (const [tokens, free, expected] of [
		[2, 198, [1, 0, 1, 0]],
		[199, 1, [67, 0, 66, 66]],
		[201, 0, [67, 0, 67, 67]],
	] as const) {
		h.ctx.getContextUsage = () => ({ tokens, contextWindow: 200, percent: tokens / 2 });
		const text = await h.show();
		assert.deepEqual(allocations(text), expected);
		assert.equal(allocations(text).reduce((sum, count) => sum + count, 0), tokens);
		assert.match(text, new RegExp(`Free: ${free} tokens`));
		if (tokens >= 199) {
			assert.ok(h.styles.some((style) => style.color === (tokens > 200 ? "error" : "warning") && style.text.startsWith(`Used: ${tokens}`)));
		}
	}
});

test("unknown aggregate stays unknown after compaction rather than reusing history or text estimates", async () => {
	const messages = [{ role: "user", content: "before compaction" }] as AgentMessage[];
	const h = harness({ messages });
	assert.match(await h.show(), /Used: 101 tokens/);
	messages.splice(0, messages.length, {
		role: "compactionSummary", summary: "retained summary", tokensBefore: 50000, timestamp: 1,
	});
	for (const usage of [{ tokens: null, contextWindow: 200, percent: null }, undefined]) {
		h.ctx.getContextUsage = () => usage;
		const text = await h.show();
		assert.match(text, /Used: unknown tokens/);
		assert.match(text, /Free: unknown tokens/);
		assert.equal(allocations(text).length, 0);
		for (const label of ["System instructions", "Tool definitions", "Conversation", "Tool results"]) {
			assert.ok(text.includes(`${label}: unknown tokens`));
		}
		assert.match(text, /\? \? \?/);
	}
});

test("nonzero usage with no text or schemas remains unattributed", async () => {
	const h = harness({
		prompt: "",
		messages: [{ role: "user", content: [{ type: "image", data: "image", mimeType: "image/png" }] }] as AgentMessage[],
	});
	const text = await h.show();
	assert.match(text, /Used: 101 tokens/);
	assert.match(text, /Free: 99 tokens/);
	assert.match(text, /Unattributed: 101 tokens/);
	assert.equal(allocations(text).length, 0);
	h.ctx.getContextUsage = () => ({ tokens: 0, contextWindow: 200, percent: 0 });
	const empty = await h.show();
	assert.deepEqual(allocations(empty), [0, 0, 0, 0]);
	assert.match(empty, /Free: 200 tokens/);
	assert.doesNotMatch(empty, /Unattributed/);
});

test("centered overlay handles minimal width and dismisses with configured keys", async () => {
	const h = harness();
	const running = h.start();
	assert.equal(h.options?.overlay, true);
	assert.equal(h.options?.overlayOptions?.anchor, "center");
	assert.doesNotThrow(() => h.render(1));
	h.input("x");
	assert.equal(h.completions, 0);
	h.input("\x1b");
	await running;
	assert.equal(h.completions, 1);

	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.cancel": "ctrl+x", "tui.select.confirm": "ctrl+y",
	});
	const remapped = harness({ keybindings });
	for (const key of ["\x18", "\x19"]) {
		const pending = remapped.start();
		const completed = remapped.completions;
		remapped.input("\r");
		assert.equal(remapped.completions, completed);
		remapped.input(key);
		await pending;
		assert.equal(remapped.completions, completed + 1);
	}
});

test("non-TUI commands report the limitation without opening a terminal component", async () => {
	const h = harness();
	h.ctx.mode = "rpc";
	h.ctx.ui.custom = () => assert.fail("RPC cannot display a terminal overlay");
	h.ctx.getContextUsage = () => assert.fail("non-TUI mode must not inspect context");
	await h.start();
	assert.deepEqual(h.notifications, [{ text: "context requires interactive mode", level: "error" }]);
});
