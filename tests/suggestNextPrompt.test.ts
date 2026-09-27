import { describe, expect, test } from 'vitest';
import { dropsHarnessSuggestion, suggestNextPromptOutcome } from '../plugins/buddy/src/suggestNextPrompt.ts';

describe('dropsHarnessSuggestion', () => {
  const harness = { kind: 'suggestion' } as const;
  test('drops the engine\'s own suggestion only while suggestNextPrompt is on and the buddy is shown', () => {
    expect(dropsHarnessSuggestion(harness, true, false, false)).toBe(true);
    expect(dropsHarnessSuggestion(harness, false, false, false)).toBe(false);
    expect(dropsHarnessSuggestion(harness, true, true, false)).toBe(false);
  });
  test('once the buddy gave up on this turn\'s suggestNextPrompt, the engine\'s own suggestion passes', () => {
    expect(dropsHarnessSuggestion(harness, true, false, true)).toBe(false);
  });
  test('a plugin\'s proposal, the buddy\'s own or another\'s, always passes', () => {
    expect(dropsHarnessSuggestion({ kind: 'plugin', name: 'buddy' }, true, false, false)).toBe(false);
    expect(dropsHarnessSuggestion({ kind: 'plugin', name: 'other' }, true, false, false)).toBe(false);
  });
});

describe('suggestNextPromptOutcome', () => {
  test('shown; not shown by the engine; not shown because a later turn had started, which is stale', () => {
    expect(suggestNextPromptOutcome(true, false)).toBe('shown');
    expect(suggestNextPromptOutcome(false, false)).toBe('not-shown');
    expect(suggestNextPromptOutcome(false, true)).toBe('stale');
  });
});
