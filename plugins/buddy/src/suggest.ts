// Prompt suggestions (the `suggestions` option): with it on, the buddy's
// end-of-turn call proposes the next prompt, and the engine's own guess is
// held back so it never covers the buddy's; when the buddy gives up, the
// engine's own is shown after all.

/** Who proposes a prompt suggestion: `suggestion` is the engine's own guess, `plugin` a plugin's. */
export type SuggestionOrigin = { kind: 'suggestion' } | { kind: 'plugin'; name: string };

/** Whether a proposed suggestion is held back: only the engine's own, while suggestions are on, the buddy is shown, and it has not given up on this turn's. */
export function dropsHarnessSuggestion(origin: SuggestionOrigin, enabled: boolean, hidden: boolean, gaveUp: boolean): boolean {
  return origin.kind === 'suggestion' && enabled && !hidden && !gaveUp;
}

/** How a suggestion of the buddy's ended: shown, not shown by the engine, or not shown because a later turn had started (`overtaken`), which is stale. */
export function suggestOutcome(isShown: boolean, overtaken: boolean): 'shown' | 'not-shown' | 'stale' {
  if (isShown) return 'shown';
  return overtaken ? 'stale' : 'not-shown';
}
