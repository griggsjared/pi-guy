function scaleTokens(count: number, decimals: number): { value: number; unit: number; suffix: string } {
  if (count < 1000) return { value: count, unit: 1, suffix: "" };
  // Dividing by a whole token step keeps halves exact (10350 / 100 = 103.5), unlike 10350 / 1000 = 10.3499…
  const step = 10 ** decimals;
  const thousands = Math.round(count / (1000 / step)) / step;
  if (thousands < 1000) return { value: thousands, unit: 1000, suffix: "k" };
  return { value: Math.round(count / (1_000_000 / step)) / step, unit: 1_000_000, suffix: "m" };
}

export function roundTokens(count: number, decimals = 1): number {
  const { value, unit } = scaleTokens(count, decimals);
  return value * unit;
}

export function formatTokens(count: number, decimals = 1): string {
  const { value, suffix } = scaleTokens(count, decimals);
  return `${value}${suffix}`;
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m${seconds % 60}s` : `${seconds}s`;
}
