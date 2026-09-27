// Prompt suggestions (the `suggestions` option): with it on, the buddy's own
// fork proposes the next prompt after each turn, and the engine's own guess is
// dropped so it never covers the buddy's.

/** How long the suggestion fork may take before the turn's suggestion is given up. */
export const SUGGEST_DEADLINE_MS = 20_000;

/** Who proposes a prompt suggestion: `suggestion` is the engine's own guess, `plugin` a plugin's. */
export type SuggestionOrigin = { kind: 'suggestion' } | { kind: 'plugin'; name: string };

/** Whether a proposed suggestion is dropped: only the engine's own, while suggestions are on and the buddy is shown. */
export function dropsHarnessSuggestion(origin: SuggestionOrigin, enabled: boolean, hidden: boolean): boolean {
  return origin.kind === 'suggestion' && enabled && !hidden;
}
