import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function boxed(lines: string[], width: number, theme: { fg(color: string, text: string): string }, title?: string): string[] {
  if (width < 3) return lines.map((line) => truncateToWidth(line, Math.max(1, width), "", true));
  const innerWidth = width - 2;
  const border = (text: string) => theme.fg("border", text);
  let top = border(`╭${"─".repeat(innerWidth)}╮`);
  if (title !== undefined) {
    const titleText = truncateToWidth(` ${title} `, innerWidth, "");
    const left = "─".repeat(Math.max(0, Math.floor((innerWidth - visibleWidth(titleText)) / 2)));
    const right = "─".repeat(Math.max(0, innerWidth - visibleWidth(titleText) - left.length));
    top = border(`╭${left}`) + theme.fg("accent", titleText) + border(`${right}╮`);
  }
  const output = [top];
  for (const line of lines) {
    const clipped = truncateToWidth(line, innerWidth, "", true);
    output.push(`${border("│")}${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}${border("│")}`);
  }
  output.push(border(`╰${"─".repeat(innerWidth)}╯`));
  return output;
}
