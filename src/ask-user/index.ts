import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { SelectItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  CHAT_VALUE,
  confirmAnswers,
  OTHER_VALUE,
  pickMultiSimple,
  pickMultiTui,
  pickSimple,
  pickTui,
} from "./picker.ts";
import type { InitialState } from "./picker.ts";

const MAX_OPTIONS = 4;
const MIN_OPTIONS = 2;
const RESERVED_OPTION_RE =
  /^(other(?: \(specify\))?|custom(?: answer)?|something else|type (?:my|your) own(?: answer)?|write-in|let['’]?s chat about this|discuss this after the questions)$/i;

const OptionParams = Type.Object({
  label: Type.String({
    description:
      "Concrete option label shown in the picker. Do not provide an Other, Custom, write-in, free-text, or discussion option.",
  }),
  description: Type.Optional(Type.String({ description: "One-line explanation shown under the label" })),
});

const QuestionParams = Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  title: Type.Optional(Type.String({ description: "Optional short title shown above the question" })),
  description: Type.Optional(Type.String({ description: "Optional extra context shown under the question" })),
  options: Type.Array(OptionParams, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: `${MIN_OPTIONS}-${MAX_OPTIONS} concrete options; the UI automatically adds Other (specify) and Discuss this after the questions`,
  }),
  multiple: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Allow selecting multiple options (checkboxes)",
    }),
  ),
});

const AskUserParams = Type.Object({
  questions: Type.Array(QuestionParams, {
    minItems: 1,
    description: "Questions asked in order",
  }),
});

interface MultiSelected {
  items: { label: string; description?: string; index: number; context?: string }[];
  other?: string;
}

type Selected =
  | { label: string; description?: string; index: number; context?: string }
  | { other: string }
  | { discuss: true }
  | MultiSelected;

interface Answer {
  question: string;
  selected: Selected;
}

interface AskUserToolDetails {
  answers: Answer[];
  cancelled: boolean;
}

function buildItems(question: { options: { label: string; description?: string }[] }): SelectItem[] {
  const items: SelectItem[] = question.options
    .filter((option) => !RESERVED_OPTION_RE.test(option.label.trim()))
    .map((option, index) => ({
      value: String(index),
      label: option.label,
      description: option.description,
    }));
  items.push({
    value: OTHER_VALUE,
    label: "Other (specify)",
    description: "Type a custom answer",
  });
  items.push({
    value: CHAT_VALUE,
    label: "Discuss this after the questions",
    description: "Defer this question and continue to the next",
  });
  return items;
}

function choiceText(selected: Selected): string {
  if ("discuss" in selected) return "Discuss after questions";
  if ("label" in selected) {
    return selected.context ? `${selected.label} — ${selected.context}` : selected.label;
  }
  if ("items" in selected) {
    const parts = selected.items.map((item) => (item.context ? `${item.label} — ${item.context}` : item.label));
    if (selected.other) parts.push(`Other: ${selected.other}`);
    return parts.join(", ");
  }
  return `Other: ${selected.other}`;
}

function formatAnswers(answers: Answer[], cancelled: boolean): string {
  if (answers.length === 0) {
    return cancelled ? "User cancelled without answering any question." : "(no answers)";
  }
  const lines = answers.map((answer, index) => `${index + 1}. ${answer.question}\n   → ${choiceText(answer.selected)}`);
  if (cancelled) lines.push("(user cancelled — answers not confirmed)");
  else if (answers.some((answer) => "discuss" in answer.selected)) {
    lines.push(
      "\nUse the confirmed answers. Briefly restate the questions marked for discussion and invite discussion in prose, then wait for the user's reply. Do not choose answers for those questions or reopen the picker.",
    );
  }
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool<typeof AskUserParams, AskUserToolDetails>({
    name: "ask_user",
    exposure: "model-only",
    label: "Ask User",
    description:
      "Ask the user multiple-choice questions when the task needs direction or clarification. Renders an interactive picker in the TUI (single-select or multi-select), then a confirmation step with per-question re-answer, and returns the chosen options, or free text via the 'Other (specify)' fallback. Each question has 2-4 options. The built-in 'Discuss this after the questions' choice defers only that question, continues through the remaining questions, and includes it in confirmation for later discussion.",
    promptSnippet: "Ask the user multiple-choice questions when direction is needed",
    promptGuidelines: [
      "When the task needs direction — ambiguous requirements, multiple valid approaches, or choices with trade-offs — ask the user with ask_user instead of guessing or asking in prose.",
      "One decision per question: keep questions and option labels short, and add a one-line description to each option when it clarifies the trade-off.",
      "Use 2-4 concrete options per question. Set multiple when several options can apply at once (e.g. 'which features?'). The ask_user UI automatically adds 'Other (specify)' and 'Discuss this after the questions'; never include an Other, Custom, write-in, free-text, or discussion choice in options.",
      "After confirmation, use the chosen answers and briefly restate any questions marked for discussion. Invite discussion in prose and wait for the user's reply before choosing answers for those questions. Do not reopen the picker.",
      "If the user cancels, ask in prose or proceed with the most reasonable default and state your assumption.",
    ],
    parameters: AskUserParams,
    renderCall(args, theme, _context) {
      const questionCount = (args.questions ?? []).length;
      return new Text(
        theme.fg("toolTitle", theme.bold("ask_user ")) +
          theme.fg("muted", `${questionCount} question${questionCount > 1 ? "s" : ""}`),
        0,
        0,
      );
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        throw new Error(
          "Cannot show interactive pickers in this mode. Ask the user in prose or proceed with the most reasonable default and state your assumption.",
        );
      }
      const answers: Answer[] = [];
      let cancelled = false;
      const askOne = async (
        question: (typeof params.questions)[number],
        index: number,
        previous?: Answer,
      ): Promise<Answer | null> => {
        const initial: InitialState | undefined =
          previous && !("discuss" in previous.selected)
            ? "items" in previous.selected
              ? {
                  values: [
                    ...previous.selected.items.map((item) => String(item.index)),
                    ...(previous.selected.other ? [OTHER_VALUE] : []),
                  ],
                  otherText: previous.selected.other,
                  contexts: Object.fromEntries(
                    previous.selected.items.flatMap((item) =>
                      item.context ? [[String(item.index), item.context]] : [],
                    ),
                  ),
                }
              : "other" in previous.selected
                ? { otherText: previous.selected.other }
                : {
                    values: [String(previous.selected.index)],
                    contexts: previous.selected.context
                      ? { [String(previous.selected.index)]: previous.selected.context }
                      : undefined,
                  }
            : undefined;
        const prompt = {
          ...question,
          title: `Question ${index + 1}/${params.questions.length}${question.title ? ` · ${question.title}` : ""}`,
        };
        const items = buildItems(question);
        const result =
          ctx.mode === "tui"
            ? question.multiple
              ? await pickMultiTui(ctx, prompt, items, signal, initial)
              : await pickTui(ctx, prompt, items, signal, initial)
            : question.multiple
              ? await pickMultiSimple(ctx.ui, prompt, items, signal)
              : await pickSimple(ctx.ui, prompt, items, signal);
        if (result === null) return null;
        if (result.kind === "chat") {
          return { question: question.question, selected: { discuss: true } };
        }
        if (result.kind === "multi") {
          const otherToggled = result.values.includes(OTHER_VALUE);
          const multi: MultiSelected = {
            items: result.values
              .filter((value) => value !== OTHER_VALUE)
              .map((value) => {
                const item = items.find((i) => i.value === value);
                return {
                  label: item?.label ?? value,
                  description: item?.description,
                  index: Number(value),
                  context: result.contexts?.[value],
                };
              }),
          };
          if (otherToggled) {
            const text = result.otherText ?? (await ctx.ui.input("Other (specify)", "Type your answer", { signal }));
            if (text !== undefined && text.trim()) multi.other = text.trim();
          }
          return { question: question.question, selected: multi };
        }
        if (result.kind === "other") {
          return { question: question.question, selected: { other: result.text } };
        }
        const item = result.item;
        if (item.value === OTHER_VALUE) {
          const text = await ctx.ui.input("Other (specify)", "Type your answer", { signal });
          if (text === undefined) return null;
          return { question: question.question, selected: { other: text } };
        }
        return {
          question: question.question,
          selected: {
            label: item.label,
            description: item.description,
            index: Number(item.value),
            context: result.context,
          },
        };
      };

      for (const [index, question] of params.questions.entries()) {
        const answer = await askOne(question, index);
        if (answer === null) {
          cancelled = true;
          break;
        }
        answers.push(answer);
      }

      if (!cancelled) {
        while (true) {
          const items: SelectItem[] = [
            { value: "confirm", label: "Confirm answers", description: "Use these answers" },
            ...params.questions.map((_question, index) => ({
              value: `re-${index}`,
              label: `Re-answer question ${index + 1}`,
              description: choiceText(answers[index]!.selected),
            })),
          ];
          const summary = params.questions.map(
            (question, index) => `${index + 1}. ${question.question} → ${choiceText(answers[index]!.selected)}`,
          );
          const confirmIndex = await confirmAnswers(ctx, summary, items, signal);
          if (confirmIndex === null) {
            cancelled = true;
            break;
          }
          if (confirmIndex === 0) break;
          const reanswered = await askOne(
            params.questions[confirmIndex - 1]!,
            confirmIndex - 1,
            answers[confirmIndex - 1],
          );
          if (reanswered === null) {
            cancelled = true;
            break;
          }
          answers[confirmIndex - 1] = reanswered;
        }
      }
      return {
        content: [{ type: "text", text: formatAnswers(answers, cancelled) }],
        details: { answers, cancelled },
      };
    },
  });
}
