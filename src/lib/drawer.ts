import type { OverlayOptions } from "@earendil-works/pi-tui";

const FREE_ROWS_DIVISOR = 4;

/** A drawer must size itself with drawerRows: maxHeight only cuts off rows past the terminal. */
export const DRAWER_OVERLAY_OPTIONS: OverlayOptions = { anchor: "top-center", width: "100%", maxHeight: "100%" };

/** Rows a drawer may fill: three quarters of the terminal, and at least one. */
export function drawerRows(terminalRows: number): number {
  const rows = Math.floor(terminalRows);
  return Math.max(1, rows - Math.floor(rows / FREE_ROWS_DIVISOR));
}
