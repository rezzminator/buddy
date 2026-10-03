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

/** How many of the latest suggestions shown in this chat a new one is checked against for a repeat. */
export const REPEAT_WINDOW = 5;
/** Two suggestions are nearly the same when they share at least this many content words... */
const REPEAT_SHARED_WORDS = 3;
/** ...and those words are at least this share of the shorter one's. */
const REPEAT_SHARE = 0.6;

/** Words that carry no ask of their own: a repeat is judged on the rest. */
const FILLER = new Set(
  'a an the and or but then so to of in on at by for with from as is are be it its this that these those me my i you your we our us what which who whether if do does did now still also just any every all each into over than too very can will would should could has have had not no'.split(' '),
);

/** A suggestion's content words: runs of letters and digits, lower case, filler left out. */
function contentWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !FILLER.has(w)));
}

/**
 * Whether two suggestions ask nearly the same: the same text once folded
 * (whitespace runs to one space, trimmed, lower case), or at least
 * REPEAT_SHARED_WORDS content words in common that make up at least
 * REPEAT_SHARE of the shorter one's content words.
 */
export function nearlySameSuggestion(a: string, b: string): boolean {
  if (folded(a) !== '' && folded(a) === folded(b)) return true;
  const wa = contentWords(a);
  const wb = contentWords(b);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared >= REPEAT_SHARED_WORDS && shared / Math.min(wa.size, wb.size) >= REPEAT_SHARE;
}

/** A feed entry as repeatedSuggestion reads it: a `suggest` one shown in the prompt box, `taken` true when the user sent it. */
export type ShownEntry = { kind: string; text: string; taken?: boolean };

/**
 * The suggestion `text` repeats: one of the last REPEAT_WINDOW suggestions
 * shown in this chat (`suggest` entries of `feed`, oldest first, since its
 * last `clear`) that the user did not take and that nearlySameSuggestion
 * matches; null when there is none, so `text` may show.
 */
export function repeatedSuggestion(text: string, feed: readonly ShownEntry[]): string | null {
  const since = feed.slice(feed.findLastIndex((e) => e.kind === 'clear') + 1);
  const recent = since.filter((e) => e.kind === 'suggest').slice(-REPEAT_WINDOW);
  return recent.findLast((e) => e.taken !== true && nearlySameSuggestion(text, e.text))?.text ?? null;
}
