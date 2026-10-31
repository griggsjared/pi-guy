import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { boxed } from "../lib/box.ts";

const CHARS_PER_TOKEN = 4;
const GRID_ROWS = 4;
const MAX_GRID_COLUMNS = 20;
const WARNING_PERCENT = 90;
const ERROR_PERCENT = 100;

function allocate(weights: number[], total: number): number[] {
  const sum = weights.reduce((value, weight) => value + weight, 0);
  if (sum === 0) return weights.map(() => 0);
  const shares = weights.map((weight) => (weight / sum) * total);
  const counts = shares.map(Math.floor);
  const order = shares
    .map((share, index) => ({ index, remainder: share - counts[index]! }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  const remaining = total - counts.reduce((value, count) => value + count, 0);
  for (let index = 0; index < remaining; index++) counts[order[index]!.index]!++;
  return counts;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("context", {
    description: "Show context usage and an estimated breakdown",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("context requires interactive mode", "error");
        return;
      }

      try {
        const usage = ctx.getContextUsage();
        const piUsed =
          usage?.tokens != null && Number.isFinite(usage.tokens) && usage.tokens >= 0 ? Math.round(usage.tokens) : null;
        const capacity = usage?.contextWindow ?? ctx.model?.contextWindow;
        const window =
          capacity !== undefined && Number.isFinite(capacity) && capacity > 0 ? Math.round(capacity) : null;
        const active = new Set(pi.getActiveTools());
        const hidden = new Set(ctx.getSystemPromptOptions().hiddenTools);
        const tools = pi
          .getAllTools()
          .filter((tool) => active.has(tool.name) && !hidden.has(tool.name) && tool.exposure !== "hidden");
        const weights = [
          ctx.getSystemPrompt().length,
          tools.reduce(
            (sum, tool) =>
              sum +
              JSON.stringify({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              }).length,
            0,
          ),
          0,
          0,
        ];
        const messages = convertToLlm(ctx.sessionManager.buildSessionProjection().messages);
        for (const message of messages) {
          // The current prompt and tool snapshots already account for system content.
          if (message.role === "system") continue;
          const weight =
            typeof message.content === "string"
              ? message.content.length
              : message.content.reduce((sum, block) => {
                  if (block.type === "text") return sum + block.text.length;
                  if (block.type === "thinking") return sum + block.thinking.length;
                  if (block.type === "toolCall")
                    return sum + block.name.length + JSON.stringify(block.arguments).length;
                  return sum;
                }, 0);
          weights[message.role === "toolResult" ? 3 : 2]! += weight;
        }
        // Pi reports zero before the first request records the prompt and tools.
        const startupEstimate = usage?.tokens === 0 && messages.length === 0;
        const used = startupEstimate ? Math.ceil((weights[0]! + weights[1]!) / CHARS_PER_TOKEN) : piUsed;
        const free = used !== null && window !== null ? Math.max(0, window - used) : null;
        const percent = used !== null && window !== null ? (used / window) * 100 : null;
        const attributed = weights.some((weight) => weight > 0);
        const counts = used !== null && (attributed || used === 0) ? allocate(weights, used) : null;
        const categories = [
          { label: "System instructions", color: "accent" },
          { label: "Tool definitions", color: "warning" },
          { label: "Conversation", color: "success" },
          { label: "Tool results", color: "toolTitle" },
        ] as const;
        const number = (value: number | null) => (value === null ? "unknown" : value.toLocaleString("en-US"));

        await ctx.ui.custom<void>(
          (_tui, theme, keybindings, done) => ({
            render: (width: number) => {
              const innerWidth = Math.max(1, width - 2);
              const columns = Math.min(MAX_GRID_COLUMNS, Math.max(1, Math.floor((innerWidth + 1) / 2)));
              const cells = columns * GRID_ROWS;
              const grid: string[] = [];
              if (used !== null && free !== null) {
                const gridCounts = allocate([...(counts ?? [0, 0, 0, 0]), counts === null ? used : 0, free], cells);
                const colors = [...categories.map((category) => category.color), "muted", "dim"] as const;
                for (let index = 0; index < gridCounts.length; index++) {
                  for (let cell = 0; cell < gridCounts[index]!; cell++) {
                    grid.push(theme.fg(colors[index]!, index === 5 ? "·" : "■"));
                  }
                }
              } else {
                grid.push(...Array.from({ length: cells }, () => theme.fg("dim", "?")));
              }
              const lines = [
                `Model: ${ctx.model?.name ?? ctx.model?.id ?? "Unknown"}`,
                `Window: ${number(window)} tokens`,
                theme.fg(
                  percent !== null && percent >= ERROR_PERCENT
                    ? "error"
                    : percent !== null && percent >= WARNING_PERCENT
                      ? "warning"
                      : "text",
                  `Used: ${number(used)} tokens${percent === null ? "" : ` (${percent.toFixed(1)}%)`} · ${startupEstimate ? "Startup estimate (chars/4)" : "Pi estimate"}`,
                ),
                `Free: ${number(free)} tokens · grid: · free, ? unknown`,
                "",
              ];
              for (let row = 0; row < GRID_ROWS; row++)
                lines.push(grid.slice(row * columns, (row + 1) * columns).join(" "));
              lines.push("", "Estimated breakdown");
              for (let index = 0; index < categories.length; index++) {
                const category = categories[index]!;
                lines.push(
                  `${theme.fg(category.color, `■ ${category.label}`)}: ${counts === null ? "unknown" : `~${number(counts[index]!)}`} tokens`,
                );
              }
              if (used !== null && counts === null)
                lines.push(`Unattributed: ${number(used)} tokens (no text/schema weights)`);
              lines.push(
                "",
                ...wrapTextWithAnsi(
                  theme.fg(
                    "dim",
                    "Relative text/schema estimates, not measured category counts. Images and provider serialization are not measured.",
                  ),
                  innerWidth,
                ),
              );
              lines.push(
                theme.fg(
                  "dim",
                  `${keybindings.getKeys("tui.select.cancel").join("/")} / ${keybindings.getKeys("tui.select.confirm").join("/")} close`,
                ),
              );
              return boxed(lines, width, theme, "Context");
            },
            handleInput: (data: string) => {
              if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "tui.select.confirm"))
                done();
            },
            invalidate: () => {},
          }),
          {
            overlay: true,
            overlayOptions: { anchor: "center", width: 76, maxHeight: "100%" },
          },
        );
      } catch (error) {
        ctx.ui.notify(
          `Unable to show context usage: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
