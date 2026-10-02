import { describe, expect, test } from 'vitest';
import { afterSuggestion, dropsHarnessSuggestion, heldSuggestionRelease, suggestNextPromptOutcome, suggestionUse } from '../plugins/buddy/src/suggestNextPrompt.ts';

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

describe('heldSuggestionRelease', () => {
  test('the engine\'s held suggestion given up on is proposed, or released as what happened: the buddy hidden, a later turn started', () => {
    expect(heldSuggestionRelease(false, false)).toBeNull();
    expect(heldSuggestionRelease(true, false)).toBe('harness-hidden');
    expect(heldSuggestionRelease(false, true)).toBe('harness-stale');
  });
});

describe('suggestionUse', () => {
  test('the suggestion sent as it was, spacing and case aside, is unedited', () => {
    expect(suggestionUse('Run  the tests', ' run the tests\n')).toBe('unedited');
    expect(afterSuggestion('Run  the tests', ' run the tests\n')).toBe('');
  });
  test('the suggestion kept whole at the start, words added after it, is extended: the added words are what follows it', () => {
    expect(suggestionUse('run the tests', 'Run the tests, then fix the first failure')).toBe('extended');
    expect(afterSuggestion('run the tests', 'Run the tests, then fix the first failure')).toBe('then fix the first failure');
    expect(afterSuggestion('keep main safe', 'keep   Main safe — never push ')).toBe('never push');
    expect(afterSuggestion('run the tests', 'run the tests/unit too')).toBe('/unit too');
  });
  test('a prompt going on mid-word, or editing the suggestion, used none of it', () => {
    expect(suggestionUse('run the test', 'run the tests')).toBeNull();
    expect(suggestionUse('run the tests', 'please run the tests')).toBeNull();
    expect(afterSuggestion('run the test', 'run the tests')).toBe('');
  });
  test('a blank suggestion or prompt is no use', () => {
    expect(suggestionUse('', 'run the tests')).toBeNull();
    expect(suggestionUse('run the tests', '  \n')).toBeNull();
    expect(afterSuggestion('  ', 'run the tests')).toBe('');
  });
});
