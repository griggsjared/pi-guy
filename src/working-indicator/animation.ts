import type { Theme } from "@earendil-works/pi-coding-agent";

const THEME_COLORS = ["error", "warning", "success", "accent", "borderAccent", "customMessageLabel"] as const;
const WORKING_PATTERNS = ["shimmer", "bounce", "karaoke", "ripple", "sparkle", "rainbow", "palettePulse"] as const;
const PLAN_COUNT = 12;
const COLOR_INTERVAL_MS = 300;
const PALETTE_PULSE_INTERVAL_MS = 1500;
export const WORD_INTERVAL_MS = 9000;
export const SPINNER_INTERVAL_MS = 150;
const SPINNER_SYMBOLS = ["✻", "✽", "✻", "✾"];

type WorkingPattern = (typeof WORKING_PATTERNS)[number];
type PaletteColor = (typeof THEME_COLORS)[number];
type ColorIntensity = "bright" | "normal" | "dim";
type IntensityDirection = "brighten" | "darken";
interface PatternColor {
  color: PaletteColor;
  intensity: ColorIntensity;
}

export function createWorkingAnimation() {
  const firstPatternIndex = Math.floor(Math.random() * WORKING_PATTERNS.length);
  const plans = Array.from({ length: PLAN_COUNT }, (_, index) => {
    const pattern = WORKING_PATTERNS[(firstPatternIndex + index) % WORKING_PATTERNS.length] ?? "shimmer";
    const color = THEME_COLORS[Math.floor(Math.random() * THEME_COLORS.length)] ?? "accent";
    const randomizeIntensity =
      pattern === "shimmer" || pattern === "bounce" || pattern === "ripple" || pattern === "sparkle";
    const intensityDirection: IntensityDirection = randomizeIntensity && Math.random() < 0.5 ? "darken" : "brighten";
    return {
      pattern,
      colors: pattern === "rainbow" || pattern === "palettePulse" ? [...THEME_COLORS] : [color],
      intensityDirection,
    };
  });

  return (theme: Theme, text: string, elapsed: number) => {
    const cycle = Math.floor(elapsed / WORD_INTERVAL_MS);
    const { pattern, colors, intensityDirection } = plans[cycle % plans.length]!;
    const colorFrame = Math.floor(elapsed / COLOR_INTERVAL_MS);
    const styleColor = (styledColor: PatternColor, character: string): string => {
      if (styledColor.intensity === "dim") return theme.style(character, { fg: styledColor.color, dim: true });
      const colored = theme.fg(styledColor.color, character);
      return styledColor.intensity === "bright" ? theme.bold(colored) : colored;
    };
    const characters = [...text];
    const symbol = SPINNER_SYMBOLS[Math.floor(elapsed / SPINNER_INTERVAL_MS) % SPINNER_SYMBOLS.length]!;
    return {
      spinner: styleColor(patternColor(pattern, 0, characters.length, colorFrame, colors, intensityDirection), symbol),
      message: characters
        .map((character, index) =>
          styleColor(
            patternColor(pattern, index, characters.length, colorFrame, colors, intensityDirection),
            character,
          ),
        )
        .join(""),
    };
  };
}

function patternColor(
  pattern: WorkingPattern,
  index: number,
  length: number,
  offset: number,
  colors: PaletteColor[],
  intensityDirection: IntensityDirection,
): PatternColor {
  const color = colors[0] ?? "accent";
  const intensity = (value: ColorIntensity): ColorIntensity => {
    if (intensityDirection === "brighten") return value;
    return value === "dim" ? "bright" : "normal";
  };
  const primary = { color, intensity: intensity("bright") };
  const secondary = { color, intensity: intensity("normal") };
  const base = { color, intensity: intensity("dim") };
  switch (pattern) {
    case "shimmer": {
      const head = (offset % (length + 4)) - 2;
      const distance = Math.abs(index - head);
      return distance === 0 ? primary : distance === 1 ? secondary : base;
    }
    case "bounce": {
      const pathLength = Math.max(1, length * 2 - 2);
      const position = offset % pathLength;
      const head = position < length ? position : pathLength - position;
      const distance = Math.abs(index - head);
      return distance === 0 ? primary : distance === 1 ? secondary : base;
    }
    case "karaoke": {
      const progress = offset % (length * 2 + 2);
      const edge = progress <= length ? progress : progress - length;
      const active = progress <= length ? index < edge : index >= edge;
      return index === edge ? secondary : active ? primary : base;
    }
    case "ripple": {
      const radius = Math.ceil(length / 2);
      const pathLength = radius * 2;
      const position = offset % pathLength;
      const ring = position <= radius ? position : pathLength - position;
      const distance = Math.floor(Math.abs(index - (length - 1) / 2));
      return distance === ring ? primary : Math.abs(distance - ring) === 1 ? secondary : base;
    }
    case "sparkle": {
      const first = (offset * 3) % length;
      const second = (offset * 5 + Math.floor(length / 2)) % length;
      return index === first ? primary : index === second ? secondary : base;
    }
    case "rainbow":
      return { color: colors[offset % colors.length] ?? color, intensity: "normal" };
    case "palettePulse": {
      const colorIndex = Math.floor((offset * COLOR_INTERVAL_MS) / PALETTE_PULSE_INTERVAL_MS) % colors.length;
      return { color: colors[colorIndex] ?? color, intensity: "normal" };
    }
  }
}
