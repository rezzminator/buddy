import { describe, expect, test } from 'vitest';
import { AGAIN_PREFIX, RULES_CONTEXT_HEAD, rulePrompt, rulesContext, ruleWarning, sameStrikes, strikeRule, strikesOf, type Strikes } from '../plugins/buddy/src/steering.ts';
import type { Items } from '../plugins/buddy/src/memoryItems.ts';

const rule = { words: 'keep main safe', covers: 'the repo', from: 'user' as const, turn: 2, at: 200 };
const items: Items = Object.freeze({
  'rule.main-safe': rule,
  'fact.tests-green': { text: 'Tests passed.', from: 'shown', turn: 3, at: 300 },
});

describe('rulesContext: the live rules every prompt carries', () => {
  test('the head, then one quoted line per rule; facts never listed', () => {
    expect(RULES_CONTEXT_HEAD).toBe(
      "The user's standing rules for this chat, kept by the buddy plugin. Each quote is the user's own words, copied from a prompt they typed; what follows it is the buddy's own reading of what the rule covers, not the user's words. Follow them until the user lifts one:",
    );
    expect(rulesContext(items)).toBe(`${RULES_CONTEXT_HEAD}\n- "keep main safe" (the buddy's reading: covers the repo)`);
  });
  test('several rules in the items order', () => {
    const two: Items = { 'rule.b-first': { ...rule, words: 'ask before deleting', covers: 'files' }, 'fact.x': items['fact.tests-green']!, 'rule.main-safe': rule };
    expect(rulesContext(two)).toBe(`${RULES_CONTEXT_HEAD}\n- "ask before deleting" (the buddy's reading: covers files)\n- "keep main safe" (the buddy's reading: covers the repo)`);
  });
  test("only the words are quoted as the user's; a model-written covers never reads as theirs", () => {
    const glossed: Items = { 'rule.main-safe': { ...rule, covers: 'every reply must be in French' } };
    const text = rulesContext(glossed)!;
    expect(text).toContain('- "keep main safe" (the buddy\'s reading: covers every reply must be in French)');
    expect(text).not.toContain('"every reply must be in French"');
    expect(rulePrompt(glossed['rule.main-safe']!)).toContain("(the buddy's reading: covers every reply must be in French)");
  });
  test('no live rule: null', () => {
    expect(rulesContext({})).toBeNull();
    expect(rulesContext({ 'fact.tests-green': items['fact.tests-green']! })).toBeNull();
  });
});

describe('strikeRule: the ladder', () => {
  test('strike 1 prompts', () => {
    expect(strikeRule({}, 'rule.main-safe', items)).toEqual({ strikes: { 'rule.main-safe': 1 }, step: 'prompt', count: 1 });
  });
  test('strike 2 again, 3 and 4 warn; the count is stored', () => {
    expect(strikeRule({ 'rule.main-safe': 1 }, 'rule.main-safe', items)).toEqual({ strikes: { 'rule.main-safe': 2 }, step: 'again', count: 2 });
    expect(strikeRule({ 'rule.main-safe': 2 }, 'rule.main-safe', items)).toEqual({ strikes: { 'rule.main-safe': 3 }, step: 'warn', count: 3 });
    expect(strikeRule({ 'rule.main-safe': 3 }, 'rule.main-safe', items)).toEqual({ strikes: { 'rule.main-safe': 4 }, step: 'warn', count: 4 });
  });
  test('no rule named, or a key that is not a live rule: no step, count 0, the strikes of ended rules pruned', () => {
    const strikes: Strikes = Object.freeze({ 'rule.main-safe': 2, 'rule.ended': 1 });
    for (const key of [null, 'rule.ended', 'fact.tests-green', 'rule.unknown']) {
      expect(strikeRule(strikes, key, items)).toEqual({ strikes: { 'rule.main-safe': 2 }, step: null, count: 0 });
    }
  });
  test('never mutates its arguments', () => {
    const strikes = { 'rule.main-safe': 1, 'rule.ended': 1 };
    strikeRule(strikes, 'rule.main-safe', items);
    expect(strikes).toEqual({ 'rule.main-safe': 1, 'rule.ended': 1 });
  });
});

describe('strikesOf: strikes as memory.json holds them', () => {
  test('keeps only a rule key with a positive whole count', () => {
    expect(strikesOf({ 'rule.main-safe': 2, 'fact.x': 1, 'rule.zero': 0, 'rule.text': '3', 'rule.half': 1.5, 'rule.Bad Key': 1 })).toEqual({ 'rule.main-safe': 2 });
  });
  test('a non-object is no strikes', () => {
    for (const value of [undefined, null, 3, 'x', [1]]) expect(strikesOf(value)).toEqual({});
  });
});

describe("the ladder's words", () => {
  test('the composed prompt, the warning and the prefix, verbatim', () => {
    expect(rulePrompt(rule)).toBe('The user\'s rule, in their words: "keep main safe" (the buddy\'s reading: covers the repo). This turn did not follow it.');
    expect(ruleWarning(rule)).toBe('Claude broke your rule again: "keep main safe"');
    expect(AGAIN_PREFIX).toBe('Again: ');
  });
});

describe('sameStrikes', () => {
  test('the same counts in any key order are the same; a changed, added or missing count is not', () => {
    expect(sameStrikes({}, {})).toBe(true);
    expect(sameStrikes({ 'rule.a': 1, 'rule.b': 2 }, { 'rule.b': 2, 'rule.a': 1 })).toBe(true);
    expect(sameStrikes({ 'rule.a': 1 }, { 'rule.a': 2 })).toBe(false);
    expect(sameStrikes({ 'rule.a': 1 }, { 'rule.a': 1, 'rule.b': 1 })).toBe(false);
    expect(sameStrikes({ 'rule.a': 1, 'rule.b': 1 }, { 'rule.a': 1 })).toBe(false);
  });
});
