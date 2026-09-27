import { describe, expect, test } from 'vitest';
import { dropsHarnessSuggestion, suggestOutcome } from '../plugins/buddy/src/suggest.ts';

describe('dropsHarnessSuggestion', () => {
  const harness = { kind: 'suggestion' } as const;
  test('drops the engine\'s own suggestion only while suggestions are on and the buddy is shown', () => {
    expect(dropsHarnessSuggestion(harness, true, false, false)).toBe(true);
    expect(dropsHarnessSuggestion(harness, false, false, false)).toBe(false);
    expect(dropsHarnessSuggestion(harness, true, true, false)).toBe(false);
  });
  test('once the buddy gave up on this turn\'s suggestion, the engine\'s own passes', () => {
    expect(dropsHarnessSuggestion(harness, true, false, true)).toBe(false);
  });
  test('a plugin\'s proposal, the buddy\'s own or another\'s, always passes', () => {
    expect(dropsHarnessSuggestion({ kind: 'plugin', name: 'buddy' }, true, false, false)).toBe(false);
    expect(dropsHarnessSuggestion({ kind: 'plugin', name: 'other' }, true, false, false)).toBe(false);
  });
});

describe('suggestOutcome', () => {
  test('shown; not shown by the engine; not shown because a later turn had started, which is stale', () => {
    expect(suggestOutcome(true, false)).toBe('shown');
    expect(suggestOutcome(false, false)).toBe('not-shown');
    expect(suggestOutcome(false, true)).toBe('stale');
  });
});
