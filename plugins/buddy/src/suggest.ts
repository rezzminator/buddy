// Prompt suggestions (the `suggestions` option): with it on, the buddy's own
// fork proposes the next prompt after each turn, and the engine's own guess is
// held back so it never covers the buddy's; when the buddy gives up, the
// engine's own is shown after all.

/**
 * How long the suggestion fork may take before the turn's suggestion is given up.
 * A fork of a long chat takes tens of seconds and cannot be cancelled: a shorter
 * wait throws away an answer already paid for. A late one is safe, since the
 * prompt box refuses it once the person types or a turn runs.
 */
export const SUGGEST_DEADLINE_MS = 90_000;

/** Who proposes a prompt suggestion: `suggestion` is the engine's own guess, `plugin` a plugin's. */
export type SuggestionOrigin = { kind: 'suggestion' } | { kind: 'plugin'; name: string };

/** Whether a proposed suggestion is held back: only the engine's own, while suggestions are on, the buddy is shown, and it has not given up on this turn's. */
export function dropsHarnessSuggestion(origin: SuggestionOrigin, enabled: boolean, hidden: boolean, gaveUp: boolean): boolean {
  return origin.kind === 'suggestion' && enabled && !hidden && !gaveUp;
}
