import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { formatDuration } from "../lib/format.ts";
import { createWorkingAnimation, WORD_INTERVAL_MS } from "./animation.ts";

type EditorStatusIndicator = Parameters<CustomEditor["setWorkingStatusIndicator"]>[0];

const STATUS_WORDS = {
  compaction: ["Condensing", "Distilling", "Summarizing", "Consolidating", "Compressing", "Pruning"],
  branchSummary: ["Summarizing", "Gathering", "Reviewing", "Condensing", "Distilling", "Consolidating"],
  retry: ["Waiting", "Reconnecting", "Regrouping", "Pausing", "Holding", "Biding"],
};

export class PromptEditor extends CustomEditor {
  private getTheme: () => Theme;
  private showStatus: (component: Component | undefined) => void;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    getTheme: () => Theme,
    showStatus: (component: Component | undefined) => void,
  ) {
    super(tui, theme, keybindings, { paddingX: 2, embedWorkingStatus: true });
    this.getTheme = getTheme;
    this.showStatus = showStatus;
  }

  setWorkingStatusIndicator(indicator: EditorStatusIndicator): void {
    if (!indicator) {
      this.showStatus(undefined);
      return;
    }
    if (indicator.kind === "working") {
      this.showStatus({
        render: (width) => {
          const lines = indicator.render(width);
          return [...(lines[0] === "" ? lines.slice(1) : lines), ""];
        },
        invalidate: () => indicator.invalidate(),
      });
      return;
    }
    const words = STATUS_WORDS[indicator.kind];
    const startedAt = Date.now();
    const animate = createWorkingAnimation();
    let lastCycle = -1;
    let wordIndex = -1;
    const render = () => {
      const elapsed = Math.max(0, Date.now() - startedAt);
      const cycle = Math.floor(elapsed / WORD_INTERVAL_MS);
      if (cycle !== lastCycle) {
        let nextIndex = Math.floor(Math.random() * words.length);
        if (nextIndex === wordIndex) nextIndex = (nextIndex + 1) % words.length;
        wordIndex = nextIndex;
        lastCycle = cycle;
      }
      const theme = this.getTheme();
      const frame = animate(theme, `${words[wordIndex]!}…`, elapsed);
      return { ...frame, duration: theme.fg("dim", `(${formatDuration(elapsed)})`) };
    };
    this.showStatus({
      render(width) {
        const { spinner, message, duration } = render();
        const contentWidth = width - visibleWidth(duration) - 2;
        const line =
          contentWidth < visibleWidth(spinner) + 1
            ? truncateToWidth(` ${spinner}`, width, "")
            : ` ${truncateToWidth(`${spinner} ${message}`, contentWidth, "")} ${duration}`;
        return [line, ""];
      },
      invalidate: () => indicator.invalidate(),
    });
  }

  setPaddingX(padding: number): void {
    super.setPaddingX(Math.max(2, padding));
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (width >= 5 && lines[1]) {
      lines[1] = this.borderColor("❯ ") + lines[1].slice(2);
    }
    return lines;
  }
}
