import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import askUser from "../ask-user.ts";

const DISCUSS_LABEL = "Discuss this after the questions";
const question = {
	question: "Which approach?",
	options: [{ label: "First" }, { label: "Second" }],
};

function tool() {
	let registered!: Parameters<ExtensionAPI["registerTool"]>[0];
	askUser({ registerTool: (definition) => { registered = definition as typeof registered; } } as ExtensionAPI);
	return registered;
}

function tui(screens: string[][], rendered: string[][] = []): ExtensionContext {
	return {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: async (factory: (
				tui: unknown,
				theme: unknown,
				kb: unknown,
				done: (value: unknown) => void,
			) => { render(width: number): string[]; handleInput(data: string): void }) => {
				const keys = screens.shift();
				assert.ok(keys, "unexpected picker");
				let settled = false;
				let result: unknown;
				const component = factory(
					{ requestRender() {} },
					{ fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text },
					undefined,
					(value: unknown) => { settled = true; result = value; },
				);
				const lines = component.render(80);
				rendered.push(lines);
				for (const key of keys) {
					assert.equal(settled, false, "picker closed before the last key");
					component.handleInput(key);
				}
				assert.equal(settled, true, "picker did not close");
				return result;
			},
		},
	} as unknown as ExtensionContext;
}

function execute(ctx: ExtensionContext, questions: (typeof question & { multiple?: boolean; title?: string })[] = [question]) {
	const toolCtx: ExtensionToolContext = {
		...ctx,
		tools: [],
		executeTool: async () => assert.fail("unexpected nested tool call"),
	};
	return tool().execute("test", { questions }, undefined, undefined, toolCtx);
}

function assertDeferred(result: Awaited<ReturnType<typeof execute>>) {
	assert.equal(result.terminate, undefined);
	assert.deepEqual(result.details, {
		answers: [{ question: question.question, selected: { discuss: true } }],
		cancelled: false,
	});
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	assert.match(text, /Which approach\?\n   → Discuss after questions/);
	assert.match(text, /invite discussion in prose, then wait for the user's reply/);
	assert.match(text, /Do not choose answers for those questions or reopen the picker/);
}

test("ask_user is registered as model-only", () => {
	assert.equal(tool().exposure, "model-only");
});

for (const multiple of [false, true]) {
	for (const keys of [["4"], ["up", "enter"], ["up", "tab", "enter"]]) {
		test(`defers ${multiple ? "multi" : "single"}-select via ${keys.join(", ")}`, async () => {
			assertDeferred(await execute(tui([keys, ["1"]]), [{ ...question, multiple }]));
		});
	}
}

test("deferring multi-select with space replaces the current checked options", async () => {
	assertDeferred(await execute(tui([["1", "down", "down", "down", "space"], ["1"]]), [{ ...question, multiple: true }]));
});

test("deferring a question preserves other answers and includes every question in confirmation", async () => {
	const rendered: string[][] = [];
	const current = { ...question, question: "Which database?" };
	const last = { ...question, question: "When should we deploy?" };
	const result = await execute(tui([["1"], ["4"], ["2"], ["1"]], rendered), [question, current, last]);
	assert.deepEqual(result.details, {
		answers: [
			{ question: question.question, selected: { label: "First", description: undefined, index: 0, context: undefined } },
			{ question: current.question, selected: { discuss: true } },
			{ question: last.question, selected: { label: "Second", description: undefined, index: 1, context: undefined } },
		],
		cancelled: false,
	});
	assert.ok(rendered[1]!.some((line) => line.includes(DISCUSS_LABEL)));
	const confirmation = rendered[3]!.join("\n");
	assert.ok(confirmation.includes("Which approach? → First"));
	assert.ok(confirmation.includes("Which database? → Discuss after questions"));
	assert.ok(confirmation.includes("When should we deploy? → Second"));
});

for (const multiple of [false, true]) {
	test(`can defer a previously answered ${multiple ? "multi" : "single"}-select question`, async () => {
		const keys = multiple ? ["1", "5"] : ["1"];
		assertDeferred(await execute(tui([keys, ["2"], ["4"], ["1"]]), [{ ...question, multiple }]));
	});

	test(`can answer a deferred ${multiple ? "multi" : "single"}-select question`, async () => {
		const keys = multiple ? ["1", "5"] : ["1"];
		const result = await execute(tui([["4"], ["2"], keys, ["1"]]), [{ ...question, multiple }]);
		assert.deepEqual(result.details, {
			answers: [{ question: question.question, selected: multiple
				? { items: [{ label: "First", description: undefined, index: 0, context: undefined }] }
				: { label: "First", description: undefined, index: 0, context: undefined } }],
			cancelled: false,
		});
		assert.doesNotMatch(result.content[0]?.type === "text" ? result.content[0].text : "", /marked for discussion/);
	});
}

for (const stage of ["next question", "confirmation"]) {
	test(`escape at ${stage} cancels deferred questions without requesting discussion`, async () => {
		const result = await execute(tui([["4"], ["escape"]]), stage === "next question" ? [question, question] : [question]);
		assert.deepEqual(result.details, {
			answers: [{ question: question.question, selected: { discuss: true } }],
			cancelled: true,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.match(text, /answers not confirmed/);
		assert.doesNotMatch(text, /invite discussion/);
	});
}

test("question progress advances across pickers and keeps its position when re-answering", async () => {
	const rendered: string[][] = [];
	await execute(tui([["1"], ["1", "5"], ["2"], ["3"], ["5"], ["1"]], rendered), [
		{ ...question, title: "Approach" },
		{ ...question, question: "Which features?", multiple: true },
		{ ...question, question: "Which database?" },
	]);
	assert.deepEqual(rendered.map((lines) => lines.find((line) => line.includes("Question "))?.trim()), [
		"Question 1/3 · Approach",
		"Question 2/3",
		"Question 3/3",
		undefined,
		"Question 2/3",
		undefined,
	]);
});

test("simple picker filters discussion options and summarizes answers and deferrals", async () => {
	const second = { ...question, question: "Which database?" };
	const ctx = {
		hasUI: true,
		mode: "rpc",
		ui: {
			select: async (title: string, options: string[]) => {
				if (title.startsWith("Confirm answers")) {
					assert.equal(title, "Confirm answers\n\n1. Which approach? → Discuss after questions\n2. Which database? → Second");
					assert.deepEqual(options, ["Confirm answers", "Re-answer question 1", "Re-answer question 2"]);
					return "Confirm answers";
				}
				if (title === "Question 2/2 — Which database?") return "Second";
				assert.equal(title, "Question 1/2 — Which approach?");
				assert.deepEqual(options, ["First", "Second", "Other (specify)", DISCUSS_LABEL]);
				return DISCUSS_LABEL;
			},
		},
	} as unknown as ExtensionContext;
	const result = await execute(ctx, [{
		...question,
		options: [...question.options, { label: DISCUSS_LABEL }, { label: " Let’s chat about this " }],
	}, second]);
	assert.deepEqual(result.details, {
		answers: [
			{ question: question.question, selected: { discuss: true } },
			{ question: second.question, selected: { label: "Second", description: undefined, index: 1, context: undefined } },
		],
		cancelled: false,
	});
});

test("simple multi-select defers the question instead of committing other choices", async () => {
	const ctx = {
		hasUI: true,
		mode: "rpc",
		ui: {
			input: async (title: string, placeholder: string) => {
				assert.equal(title, "Question 1/1 — Which approach? (multi-select)");
				assert.ok(placeholder.includes(`4. ${DISCUSS_LABEL}`));
				return "1,3,4";
			},
			select: async () => "Confirm answers",
		},
	} as unknown as ExtensionContext;
	assertDeferred(await execute(ctx, [{ ...question, multiple: true }]));
});

test("normal answers still require confirmation and do not terminate", async () => {
	const result = await execute(tui([["1"], ["1"]]));
	assert.equal(result.terminate, undefined);
	assert.deepEqual(result.details, {
		answers: [{ question: question.question, selected: { label: "First", description: undefined, index: 0, context: undefined } }],
		cancelled: false,
	});
});

test("Other still accepts a written answer", async () => {
	const result = await execute(tui([["3", "h", "i", "enter"], ["1"]]));
	assert.equal(result.terminate, undefined);
	assert.deepEqual(result.details, {
		answers: [{ question: question.question, selected: { other: "hi" } }],
		cancelled: false,
	});
});

test("escape cancels without answering", async () => {
	const result = await execute(tui([["escape"]]));
	assert.equal(result.terminate, undefined);
	assert.deepEqual(result.details, { answers: [], cancelled: true });
});

test("non-interactive mode still rejects the picker", async () => {
	await assert.rejects(execute({ hasUI: false } as ExtensionContext), /Cannot show interactive pickers/);
});
