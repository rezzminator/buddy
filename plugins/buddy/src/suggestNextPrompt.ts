// `suggestNextPrompt`: with it on, the buddy's end-of-turn call writes the
// suggestNextPrompt, and the engine's own suggestion is held back so it never
// covers the buddy's; when the buddy gives up, the
// engine's own is shown after all.

/** Who proposes a prompt suggestion: `suggestion` is the engine's own guess, `plugin` a plugin's. */
export type SuggestionOrigin = { kind: 'suggestion' } | { kind: 'plugin'; name: string };

/** Whether a proposed suggestion is held back: only the engine's own, while suggestNextPrompt is on, the buddy is shown, and it has not given up on this turn's. */
export function dropsHarnessSuggestion(origin: SuggestionOrigin, enabled: boolean, hidden: boolean, gaveUp: boolean): boolean {
  return origin.kind === 'suggestion' && enabled && !hidden && !gaveUp;
}

/** How the buddy's suggestNextPrompt ended: shown, not shown by the engine, or not shown because a later turn had started (`overtaken`), which is stale. */
export function suggestNextPromptOutcome(isShown: boolean, overtaken: boolean): 'shown' | 'not-shown' | 'stale' {
  if (isShown) return 'shown';
  return overtaken ? 'stale' : 'not-shown';
}

/**
 * Why the engine's held suggestion, given up on, is released unshown: the
 * buddy is hidden (`harness-hidden`), or a later turn started, so it was for
 * an ended one (`harness-stale`); null when it is proposed.
 */
export function heldSuggestionRelease(hidden: boolean, turnStarted: boolean): 'harness-hidden' | 'harness-stale' | null {
  if (hidden) return 'harness-hidden';
  return turnStarted ? 'harness-stale' : null;
}
