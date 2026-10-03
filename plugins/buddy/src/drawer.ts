/** Rows the drawer can take: inline, leave the picker's frame and the prompt/footer visible; a dock shares columns, not rows. */
export function drawerRows(maxRows: number, pickerRows: number, isFullscreen: boolean): number {
  if (pickerRows <= 0 || isFullscreen) return maxRows;
  // Inline: the picker's body, its frame (2) and the prompt with its footer (6) come off the band; the drawer
  // keeps at least its own frame (2), body (4), ask bar (3) and memory row (1), within the band.
  return Math.min(maxRows, Math.max(10, maxRows - pickerRows - 2 - 6));
}

/** The picker's intrinsic content rows while the surface measures its visible body. */
export function pickerContentRows(requestedRows: number, bodyRows: number): number {
  return Math.max(requestedRows, bodyRows);
}

/** The window before the first measurement uses the requested body, not a one-row list. */
export function pickerBodyRows(requestedRows: number, bodyRows: number): number {
  return Math.max(1, bodyRows > 0 ? bodyRows : requestedRows);
}
