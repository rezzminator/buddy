// Steering, with promptToMainChat on: the user's live rules from the buddy's
// memory ride every prompt to the main chat as context, and a rule Claude
// breaks again climbs a ladder. The first strike sends the buddy's prompt to
// Claude, the second sends it again prefixed `Again: `, the third and on send
// none and warn the user in the bubble instead. Strikes are counted per rule
// and kept in memory.json beside the items; a rule's strikes vanish when it
// ends, so a rule set again starts its ladder over.
// No I/O: the adapter reads the items and strikes from the chat's memory,
// writes the strikes back and sends or shows what the step names.

import { ITEM_KEY, type Item, type Items } from './memoryItems.ts';

/** How many times the buddy has named each live rule as broken, by rule key. */
export type Strikes = Record<string, number>;
/** What a strike does: send the buddy's prompt, send it again prefixed AGAIN_PREFIX, or warn the user. */
export type StrikeStep = 'prompt' | 'again' | 'warn';

/** The line before the user's rules, in the context every prompt carries. */
export const RULES_CONTEXT_HEAD =
  "The user's standing rules for this chat, kept by the buddy plugin. Each quote is the user's own words, copied from a prompt they typed; what follows it is the buddy's own reading of what the rule covers, not the user's words. Follow them until the user lifts one:";

/** What a rule's `covers` is called wherever it reaches Claude: the model's gloss, never the user's words. */
function buddyReading(item: Item): string {
  return `the buddy's reading: covers ${item.covers ?? ''}`;
}
/** What the second strike's prompt starts with. */
export const AGAIN_PREFIX = 'Again: ';

function isRuleKey(key: string): boolean {
  return key.startsWith('rule.') && ITEM_KEY.test(key);
}

/** The user's live rules as the context a prompt carries, one line each in the items' order: only the words quoted as the user's, `covers` labelled the buddy's reading; null with none. Facts and other kinds are never listed. */
export function rulesContext(items: Items): string | null {
  const rules = Object.entries(items).filter(([key]) => isRuleKey(key)).map(([, item]) => `- "${item.words ?? ''}" (${buddyReading(item)})`);
  return rules.length === 0 ? null : `${RULES_CONTEXT_HEAD}\n${rules.join('\n')}`;
}

/**
 * One end-of-turn's strike: the strikes pruned to the live rules, then, when
 * `key` names one, its count raised by one. Step 1 is `prompt`, 2 `again`, 3
 * and on `warn`; with no live rule named, no step and a count of 0. Never
 * mutates its arguments.
 */
export function strikeRule(strikes: Strikes, key: string | null, items: Items): { strikes: Strikes; step: StrikeStep | null; count: number } {
  const live = (k: string) => isRuleKey(k) && Object.hasOwn(items, k);
  const kept: Strikes = Object.fromEntries(Object.entries(strikes).filter(([k]) => live(k)));
  if (key === null || !live(key)) return { strikes: kept, step: null, count: 0 };
  const count = (kept[key] ?? 0) + 1;
  return { strikes: { ...kept, [key]: count }, step: count === 1 ? 'prompt' : count === 2 ? 'again' : 'warn', count };
}

/** Strikes as memory.json holds them: entries keyed by a rule's key with a positive whole count; anything else is dropped. */
export function strikesOf(value: unknown): Strikes {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([k, n]) => isRuleKey(k) && typeof n === 'number' && Number.isInteger(n) && n > 0));
}

/** The prompt a first strike sends Claude when the buddy wrote none of its own. */
export function rulePrompt(item: Item): string {
  return `The user's rule, in their words: "${item.words ?? ''}" (${buddyReading(item)}). This turn did not follow it.`;
}

/** What the bubble tells the user from the third strike on. */
export function ruleWarning(item: Item): string {
  return `Claude broke your rule again: "${item.words ?? ''}"`;
}

/** Whether two strike records hold the same counts, whatever their key order: an unchanged one is never written again. */
export function sameStrikes(a: Strikes, b: Strikes): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}
