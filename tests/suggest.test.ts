import { describe, expect, test } from 'vitest';
import { SUGGEST_DEADLINE_MS, dropsHarnessSuggestion } from '../plugins/buddy/src/suggest.ts';

describe('dropsHarnessSuggestion', () => {
  const harness = { kind: 'suggestion' } as const;
  test('drops the engine\'s own suggestion only while suggestions are on and the buddy is shown', () => {
    expect(dropsHarnessSuggestion(harness, true, false)).toBe(true);
    expect(dropsHarnessSuggestion(harness, false, false)).toBe(false);
    expect(dropsHarnessSuggestion(harness, true, true)).toBe(false);
  });
  test('a plugin\'s proposal, the buddy\'s own or another\'s, always passes', () => {
    expect(dropsHarnessSuggestion({ kind: 'plugin', name: 'buddy' }, true, false)).toBe(false);
    expect(dropsHarnessSuggestion({ kind: 'plugin', name: 'other' }, true, false)).toBe(false);
  });
  test('the fork gets 20 s', () => {
    expect(SUGGEST_DEADLINE_MS).toBe(20_000);
  });
});
