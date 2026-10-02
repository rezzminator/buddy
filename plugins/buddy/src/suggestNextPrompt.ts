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

/**
 * How the user used the suggestion shown when they sent a prompt: sent as it
 * was (`unedited`, spacing and case aside), or kept whole at its start with
 * words of their own after it (`extended`); null when either is blank, or the
 * prompt edits it, or goes on mid-word.
 */
export type SuggestionUse = 'unedited' | 'extended';

const folded = (a: string) => a.replace(/\s+/g, ' ').trim().toLowerCase();
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** How `prompt` used `suggestion`, both folded (whitespace runs to one space, trimmed, lower case): see SuggestionUse. */
export function suggestionUse(suggestion: string, prompt: string): SuggestionUse | null {
  const s = folded(suggestion);
  const p = folded(prompt);
  if (s === '' || p === '') return null;
  if (s === p) return 'unedited';
  if (!p.startsWith(s)) return null;
  return WORD_CHAR.test(String.fromCodePoint(p.codePointAt(s.length)!)) ? null : 'extended';
}

/**
 * The words the user added after the suggestion they extended, as they typed
 * them, trimmed of whitespace and of the punctuation that joined them on
 * (`, ; : . - – —`); '' unless the use is `extended`.
 */
export function afterSuggestion(suggestion: string, prompt: string): string {
  if (suggestionUse(suggestion, prompt) !== 'extended') return '';
  // Walk the original prompt until it has given as many folded characters as
  // the folded suggestion holds: a whitespace run folds to one space, and a
  // character to its lower case.
  const target = folded(suggestion).length;
  const chars = Array.from(prompt.replace(/^\s+/, ''));
  let n = 0;
  let i = 0;
  while (n < target && i < chars.length) {
    if (/\s/.test(chars[i]!)) {
      while (i < chars.length && /\s/.test(chars[i]!)) i++;
      n += 1;
    } else {
      n += chars[i]!.toLowerCase().length;
      i++;
    }
  }
  const rest = chars.slice(i).join('');
  return rest.replace(/^[\s,;:.\-–—]+/u, '').trim();
}
