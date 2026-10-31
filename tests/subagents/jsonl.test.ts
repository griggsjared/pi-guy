import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accumulateEvent,
  assistantText,
  createStreamState,
  extractFinalText,
  normalizeToolArgs,
  parseJsonLine,
  parseParentQuestion,
  sanitizeToolCallArgs,
  selectEvent,
  truncateStrings,
} from "../../src/subagents/jsonl.ts";

const end = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "message_end",
  message: { role: "assistant", content, ...extra },
});

const update = (content: unknown) => ({ type: "message_update", message: { role: "assistant", content } });

const rpcDelta = (type: "text_delta" | "thinking_delta", delta: string) => ({
  type: "message_update",
  assistantMessageEvent: { type, delta },
});

test("JSON lines parse objects and ignore blank, malformed, and non-object lines", () => {
  assert.deepEqual(parseJsonLine('{"type":"turn_start"}'), { type: "turn_start" });
  assert.deepEqual(parseJsonLine('  {"id":"q1"}\n'), { id: "q1" });
  assert.equal(parseJsonLine(""), undefined);
  assert.equal(parseJsonLine("  \n"), undefined);
  assert.equal(parseJsonLine("not json"), undefined);
  assert.equal(parseJsonLine("42"), undefined);
  assert.equal(parseJsonLine("null"), undefined);
});

test("assistant messages and streaming updates are selected for the stream", () => {
  assert.ok(selectEvent(end("x")));
  assert.ok(selectEvent(rpcDelta("text_delta", "x")));
  assert.ok(selectEvent(update("x")));
  assert.equal(selectEvent({ type: "message_end", message: { role: "user" } }), undefined);
  assert.equal(selectEvent({ type: "message_end" }), undefined);
  assert.equal(selectEvent({ type: "turn_start" }), undefined);
  assert.equal(selectEvent(undefined), undefined);
});

test("parent questions require marked input requests with an ID", () => {
  assert.deepEqual(
    parseParentQuestion({
      type: "extension_ui_request",
      id: "question-1",
      method: "input",
      title: "subagents:ask-parent: Which API? ",
      placeholder: " Existing or new. ",
    }),
    {
      id: "question-1",
      question: "Which API?",
      context: "Existing or new.",
    },
  );
  assert.deepEqual(
    parseParentQuestion({
      type: "extension_ui_request",
      id: "question-2",
      method: "input",
      title: "subagents:ask-parent:Continue?",
    }),
    { id: "question-2", question: "Continue?", context: undefined },
  );
  assert.equal(parseParentQuestion(undefined), undefined);
  assert.equal(
    parseParentQuestion({
      type: "extension_ui_request",
      id: "",
      method: "input",
      title: "subagents:ask-parent:Missing ID",
    }),
    undefined,
  );
  assert.equal(
    parseParentQuestion({
      type: "extension_ui_request",
      id: "question-3",
      method: "editor",
      title: "subagents:ask-parent:Wrong method",
    }),
    undefined,
  );
  assert.equal(
    parseParentQuestion({
      type: "extension_ui_request",
      id: "question-4",
      method: "input",
      title: "Ordinary extension input",
    }),
    undefined,
  );
});

test("assistant text joins text parts and ignores other content", () => {
  assert.equal(assistantText("plain"), "plain");
  assert.equal(
    assistantText([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]),
    "a\nb",
  );
  assert.equal(assistantText([{ type: "thinking", thinking: "hmm" }]), "");
  assert.equal(assistantText([{ type: "text", text: 42 }]), "");
  assert.equal(assistantText(42), "");
});

test("completed assistant messages update final text, model, and usage", () => {
  const state = createStreamState("default-model");
  accumulateEvent(
    state,
    end("final answer", {
      usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 60, cost: 0.001 },
      model: "served-model",
    }),
  );
  assert.equal(state.finalText, "final answer");
  assert.equal(state.model, "served-model");
  assert.deepEqual(state.usage, {
    turns: 1,
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 40,
    cost: 0.001,
    contextTokens: 60,
  });
});

test("usage accepts cost as an object with a total", () => {
  const state = createStreamState("m");
  accumulateEvent(state, end("x", { usage: { cost: { total: 0.5 } } }));
  assert.equal(state.usage.cost, 0.5);
});

test("completed messages retain sanitized tool calls", () => {
  const state = createStreamState("m");
  const longContent = Array.from({ length: 10 }, () => "line").join("\n");
  accumulateEvent(
    state,
    end([
      { type: "text", text: "working" },
      { type: "toolCall", name: "write", arguments: { file_path: "/x.ts", content: longContent } },
      { type: "tool_use", name: "read", input: { path: "/y.ts" } },
    ]),
  );
  assert.equal(state.toolCalls.length, 2);
  assert.equal(state.toolCalls[0]?.name, "write");
  assert.equal(state.toolCalls[0]?.args.content, undefined);
  assert.equal(state.toolCalls[0]?.args.contentLines, 10);
  assert.deepEqual(state.toolCalls[1], { name: "read", args: { path: "/y.ts" } });
});

test("stream retains the newest 20 tool calls", () => {
  const state = createStreamState("m");
  const parts = Array.from({ length: 25 }, (_, i) => ({
    type: "toolCall",
    name: "read",
    arguments: { path: `/f${i}.ts` },
  }));
  accumulateEvent(state, end(parts));
  assert.equal(state.toolCalls.length, 20);
  assert.deepEqual(
    state.toolCalls.map((call) => call.args.path),
    Array.from({ length: 20 }, (_, i) => `/f${i + 5}.ts`),
  );
});

test("legacy streaming updates retain the longest text chunk", () => {
  const state = createStreamState("m");
  accumulateEvent(state, update("short"));
  accumulateEvent(state, update("much longer streaming chunk"));
  accumulateEvent(state, update("medium"));
  assert.equal(state.streamedText, "much longer streaming chunk");
  assert.equal(state.finalText, "");
});

test("streaming text and thinking deltas are assembled in order", () => {
  const state = createStreamState("m");
  accumulateEvent(state, rpcDelta("text_delta", "Hello"));
  accumulateEvent(state, rpcDelta("text_delta", " world"));
  accumulateEvent(state, rpcDelta("thinking_delta", "checking"));
  assert.equal(state.streamedText, "Hello world");
  assert.equal(state.finalThinking, "checking");
});

test("non-assistant and unparsed events do not update the stream", () => {
  const state = createStreamState("m");
  accumulateEvent(state, { type: "message_end", message: { role: "user", content: "hi" } });
  accumulateEvent(state, undefined);
  accumulateEvent(state, { type: "turn_start" });
  assert.equal(state.usage.turns, 0);
  assert.equal(state.finalText, "");
});

test("final text extraction handles malformed lines, thinking fallback, and an unterminated line", () => {
  const stream = [JSON.stringify(update("partial")), JSON.stringify(end("final")), "garbage"].join("\n");
  assert.equal(extractFinalText(stream), "final");
  assert.equal(extractFinalText(JSON.stringify(end(""))), "");
  assert.equal(
    extractFinalText(JSON.stringify(end([{ type: "thinking", thinking: "only thinking" }]))),
    "only thinking",
  );
  // No trailing newline: last line must still be seen.
  assert.equal(extractFinalText(`garbage\n${JSON.stringify(end("last"))}`), "last");
  assert.equal(extractFinalText(""), "");
});

test("tool arguments accept objects and JSON objects and ignore invalid values", () => {
  assert.deepEqual(normalizeToolArgs({ a: 1 }), { a: 1 });
  assert.deepEqual(normalizeToolArgs('{"a":1}'), { a: 1 });
  assert.deepEqual(normalizeToolArgs("not json"), {});
  assert.deepEqual(normalizeToolArgs(42), {});
  assert.deepEqual(normalizeToolArgs([1, 2]), {});
});

test("write and edit content is replaced by a line count", () => {
  assert.equal(sanitizeToolCallArgs("write", { content: "a\nb" }).contentLines, 2);
  assert.equal(sanitizeToolCallArgs("edit", { content: "a" }).contentLines, 1);
  assert.deepEqual(sanitizeToolCallArgs("read", { content: "a\nb" }), { content: "a\nb" });
});

test("long strings are truncated inside arrays and objects", () => {
  assert.equal(truncateStrings("x".repeat(200)), `${"x".repeat(120)}…`);
  assert.deepEqual(truncateStrings([1, "y".repeat(200)]), [1, `${"y".repeat(120)}…`]);
  assert.deepEqual(truncateStrings({ k: "z".repeat(200) }), { k: `${"z".repeat(120)}…` });
  assert.equal(truncateStrings(5), 5);
});
