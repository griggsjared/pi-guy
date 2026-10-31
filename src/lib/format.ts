export function formatTokens(count: number, decimals = 1): string {
  if (count < 1000) return String(count);
  // Dividing by a whole token step keeps halves exact (10350 / 100 = 103.5), unlike 10350 / 1000 = 10.3499…
  const step = 10 ** decimals;
  const thousands = Math.round(count / (1000 / step)) / step;
  if (thousands < 1000) return `${thousands}k`;
  return `${Math.round(count / (1000000 / step)) / step}m`;
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m${seconds % 60}s` : `${seconds}s`;
}
