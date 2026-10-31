import { uuidv7 } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  buildSessionContext,
  convertToLlm,
  CustomEditor,
  getMarkdownTheme,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { boxed } from "../lib/box.ts";

const SYSTEM_PROMPT =
  "You are answering a side question about the current conversation. Answer the question directly and concisely. Do not continue the main task, call tools, or propose changes unless the question explicitly asks for them.";
const OVERLAY_MARGIN = 1;
const OVERLAY_BORDER_ROWS = 2;
// Provider error bodies can run to several KB; the notice keeps one readable line.
const MAX_ERROR_NOTICE_COLUMNS = 200;

interface Operation {
  controller: AbortController;
  generation: number;
  close?: () => void;
}

interface Turn {
  question: string;
  answer: AssistantMessage;
}

function answerLines(turns: Turn[], width: number, pendingQuestion?: string): string[] {
  const lines: string[] = [];
  const markdownTheme = getMarkdownTheme();
  for (const turn of turns) {
    // Reuse Pi's native message components: user rows use userMessageBg and
    // outputPad=1, while assistant rows retain the normal unboxed stream style.
    lines.push("");
    lines.push(...new UserMessageComponent(turn.question, markdownTheme, 1).render(width));
    lines.push(...new AssistantMessageComponent(turn.answer, false, markdownTheme, "Thinking...", 1).render(width));
  }
  if (pendingQuestion !== undefined) {
    lines.push("");
    lines.push(...new UserMessageComponent(pendingQuestion, markdownTheme, 1).render(width));
  }
  return lines;
}

const TRANSCRIPT_HEADER = "Side conversation (via /btw):";
const MAX_TRANSCRIPT_CHARS = 8000;
const TRANSCRIPT_TRUNCATION = "[…earlier turns truncated]";

export function transcript(turns: Turn[]): string {
  const blocks: string[] = [];
  let budget = MAX_TRANSCRIPT_CHARS;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn) continue;
    const answer = turn.answer.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n")
      .trim();
    const block = answer ? `Q: ${turn.question}\nA: ${answer}` : `Q: ${turn.question}`;
    if (blocks.length > 0 && block.length > budget) {
      blocks.unshift(TRANSCRIPT_TRUNCATION);
      break;
    }
    budget -= block.length;
    blocks.unshift(block);
  }
  return [TRANSCRIPT_HEADER, ...blocks].join("\n\n").trim();
}

export function fitModalBody(
  lines: string[],
  requestedScrollTop: number,
  terminalRows: number,
  chromeRows: number,
  borderRows = OVERLAY_BORDER_ROWS,
): { lines: string[]; scrollTop: number; viewportRows: number; maxScroll: number } {
  const maxOverlayRows = Math.max(1, Math.floor(terminalRows) - (terminalRows >= 3 ? OVERLAY_MARGIN * 2 : 0));
  const viewportRows = Math.max(0, maxOverlayRows - chromeRows - borderRows);
  const maxScroll = Math.max(0, lines.length - viewportRows);
  const scrollTop = Math.min(maxScroll, Math.max(0, requestedScrollTop));
  return {
    lines: lines.slice(scrollTop, scrollTop + viewportRows),
    scrollTop,
    viewportRows,
    maxScroll,
  };
}

export default function (pi: ExtensionAPI) {
  let active: Operation | undefined;
  let generation = 0;

  const cancel = () => {
    const operation = active;
    if (!operation) return;
    generation++;
    operation.controller.abort();
    operation.close?.();
  };

  pi.on("session_shutdown", () => cancel());

  pi.registerCommand("btw", {
    description: "Ask a private side question without interrupting the main task",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (ctx.mode !== "tui") {
        ctx.ui.notify("btw requires interactive mode", "error");
        return;
      }
      if (ctx.model === undefined && question) {
        ctx.ui.notify("No model selected", "error");
        return;
      }
      if (active) {
        ctx.ui.notify("A /btw question is already in progress", "error");
        return;
      }

      const model = ctx.model;
      const snapshot = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
      // Main-session system entries include prompt changes and tool declarations.
      const messages: Message[] = convertToLlm(snapshot.messages).filter((message) => message.role !== "system");
      const operation: Operation = { controller: new AbortController(), generation: ++generation };
      active = operation;
      let error: unknown;

      try {
        let overlayTui: TUI | undefined;
        const result = await ctx.ui.custom<string | null>(
          (tui, theme, keybindings, done) => {
            overlayTui = tui;
            let settled = false;
            let disposed = false;
            let loading = question.length > 0;
            let pendingQuestion: string | undefined = question || undefined;
            let scrollTop = 0;
            let contentWidth = 1;
            let viewportRows = 1;
            const turns: Turn[] = [];

            const finish = (value: string | null) => {
              if (settled) return;
              settled = true;
              done(value);
            };
            const close = () => {
              operation.controller.abort();
              finish(null);
            };
            const fail = (caught: unknown) => {
              if (!operation.controller.signal.aborted && active === operation) error = caught;
              close();
            };
            let failureScheduled = false;
            const scheduleFail = (caught: unknown) => {
              if (failureScheduled || settled) return;
              failureScheduled = true;
              queueMicrotask(() => {
                failureScheduled = false;
                if (!settled) fail(caught);
              });
            };
            const startLoading = (nextQuestion: string) => {
              pendingQuestion = nextQuestion;
              loading = true;
              scrollTop = Number.MAX_SAFE_INTEGER;
              tui.requestRender();
            };

            operation.close = close;
            operation.controller.signal.addEventListener("abort", () => finish(null), { once: true });

            const editorTheme = {
              borderColor: (text: string) => theme.fg("borderMuted", text),
              selectList: {
                selectedPrefix: (text: string) => theme.fg("accent", text),
                selectedText: (text: string) => theme.fg("accent", text),
                description: (text: string) => theme.fg("muted", text),
                scrollInfo: (text: string) => theme.fg("muted", text),
                noMatch: (text: string) => theme.fg("muted", text),
              },
            };
            const replyInput = new CustomEditor(tui, editorTheme, keybindings, { paddingX: 1 });
            replyInput.onSubmit = (value) => {
              const reply = value.trim();
              if (!reply || loading) return;
              replyInput.setText("");
              startLoading(reply);
              request(reply).catch(fail);
            };
            replyInput.focused = true;

            const request = async (nextQuestion: string) => {
              if (!model) throw new Error("No model selected");
              if (operation.controller.signal.aborted || active !== operation || operation.generation !== generation)
                return;
              messages.push({ role: "user", content: [{ type: "text", text: nextQuestion }], timestamp: Date.now() });
              const response = await ctx.modelRegistry
                .streamSimple(
                  model,
                  { systemPrompt: SYSTEM_PROMPT, messages },
                  {
                    signal: operation.controller.signal,
                    cacheRetention: "none",
                    sessionId: uuidv7(),
                  },
                )
                .result();
              if (response.stopReason === "aborted") {
                close();
                return;
              }
              if (operation.controller.signal.aborted || active !== operation || operation.generation !== generation)
                return;
              if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Model request failed");
              messages.push(response);
              turns.push({ question: nextQuestion, answer: response });
              loading = false;
              pendingQuestion = undefined;
              scrollTop = Number.MAX_SAFE_INTEGER;
              tui.requestRender();
            };

            if (question) request(question).catch(fail);

            return {
              render: (width: number) => {
                if (disposed) return [];
                const maxWidth = Math.max(1, Math.floor(width));
                const maxRows = Math.max(
                  1,
                  Math.floor(tui.terminal.rows) - (tui.terminal.rows >= 3 ? OVERLAY_MARGIN * 2 : 0),
                );
                try {
                  let bordered = maxWidth >= 3;
                  let innerWidth = bordered ? maxWidth - 2 : maxWidth;
                  let body = answerLines(turns, innerWidth, loading ? pendingQuestion : undefined);
                  let inputLines = replyInput.render(innerWidth);
                  if (bordered && inputLines.length + (body.length > 0 ? 1 : 0) + OVERLAY_BORDER_ROWS > maxRows) {
                    bordered = false;
                    innerWidth = maxWidth;
                    body = answerLines(turns, innerWidth, loading ? pendingQuestion : undefined);
                    inputLines = replyInput.render(innerWidth);
                  }
                  contentWidth = innerWidth;
                  const borderRows = bordered ? OVERLAY_BORDER_ROWS : 0;
                  const inputBudget = Math.max(1, maxRows - borderRows - (body.length > 0 && maxRows > 1 ? 1 : 0));
                  if (inputLines.length > inputBudget) {
                    const cursor = inputLines.findIndex((line) => line.includes(CURSOR_MARKER));
                    const start = Math.max(0, Math.min(cursor, inputLines.length - inputBudget));
                    inputLines = inputLines.slice(start, start + inputBudget);
                  }
                  const spareRows = maxRows - borderRows - inputLines.length - (body.length > 0 ? 1 : 0);
                  const showLoading = loading && spareRows > 0;
                  const showHint = spareRows > (showLoading ? 1 : 0);
                  const chromeRows = inputLines.length + (showLoading ? 1 : 0) + (showHint ? 1 : 0);
                  const fitted = fitModalBody(body, scrollTop, tui.terminal.rows, chromeRows, borderRows);
                  scrollTop = fitted.scrollTop;
                  viewportRows = fitted.viewportRows;
                  const lines = [...fitted.lines, ...inputLines];
                  if (showLoading) lines.push(theme.fg("dim", "Thinking…"));
                  const scrollHint =
                    fitted.maxScroll > 0 ? `PgUp/PgDn scroll (${scrollTop + 1}/${fitted.maxScroll + 1}) · ` : "";
                  const hint = loading
                    ? `${scrollHint}Esc close`
                    : turns.length > 0
                      ? `${scrollHint}Enter send · Ctrl+S send to agent · Esc close`
                      : `${scrollHint}Enter send · Esc close`;
                  if (showHint) lines.push(theme.fg("dim", hint));
                  return bordered
                    ? boxed(lines, maxWidth, theme, "btw")
                    : lines.map((line) => truncateToWidth(line, maxWidth, "", true));
                } catch (caught) {
                  scheduleFail(caught);
                  return [];
                }
              },
              invalidate: () => {
                replyInput?.invalidate();
              },
              handleInput: (data: string) => {
                if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
                  close();
                  return;
                }
                if (matchesKey(data, Key.ctrl("s"))) {
                  if (!loading && turns.length > 0) finish(transcript(turns));
                  return;
                }
                if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
                  try {
                    const bodyLength = answerLines(turns, contentWidth, loading ? pendingQuestion : undefined).length;
                    const page = Math.max(1, viewportRows);
                    scrollTop += matchesKey(data, Key.pageUp) ? -page : page;
                    const maxScroll = Math.max(0, bodyLength - viewportRows);
                    scrollTop = Math.min(maxScroll, Math.max(0, scrollTop));
                  } catch (caught) {
                    scheduleFail(caught);
                  }
                  tui.requestRender();
                  return;
                }
                replyInput.handleInput(data);
                tui.requestRender();
              },
              dispose: () => {
                disposed = true;
                operation.controller.abort();
              },
            };
          },
          {
            overlay: true,
            overlayOptions: {
              anchor: "center",
              width: "100%",
              minWidth: 60,
              maxHeight: "100%",
              get margin() {
                if (!overlayTui) return OVERLAY_MARGIN;
                const horizontal = overlayTui.terminal.columns >= 3 ? OVERLAY_MARGIN : 0;
                const vertical = overlayTui.terminal.rows >= 3 ? OVERLAY_MARGIN : 0;
                return horizontal && vertical
                  ? OVERLAY_MARGIN
                  : { top: vertical, bottom: vertical, left: horizontal, right: horizontal };
              },
            },
          },
        );

        if (result === null && error !== undefined) {
          const message = (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
          ctx.ui.notify(`btw request failed: ${truncateToWidth(message, MAX_ERROR_NOTICE_COLUMNS, "…")}`, "error");
        }
        if (result !== null) {
          pi.sendUserMessage(result, { deliverAs: "followUp" });
          ctx.ui.notify("Side conversation sent to the agent", "info");
        }
      } finally {
        if (active === operation) active = undefined;
      }
    },
  });
}
