import { describe, expect, test } from 'vitest';
import { afterSuggestion, dropsHarnessSuggestion, heldSuggestionRelease, REPEAT_WINDOW, repeatedSuggestion, suggestNextPromptOutcome, suggestionUse } from '../plugins/buddy/src/suggestNextPrompt.ts';

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

describe('repeatedSuggestion', () => {
  // Real wordings from audited chats, where each repeat showed while nobody took the one before.
  const timerThenClose = 'Stop the flight-watch timer now, then tell me what else must close before a runbook relaunch';
  const timerThenList = 'Stop the flight-watch timer, then list every chat that must close before the M7 runbook relaunch';
  const timerThenCheck = "Stop the flight-watch timer, then show the runbook's store-identity step matches the fix";
  const decisions = 'List every decision still on me, including C8 archive.db versioning and the S2 NULL totals';
  const decisionsWhile = 'While the foreman runs, list every decision still on me, including C8 archive.db versioning';
  const reminderAfterMerge = 'After the merge, how do I get the reminder CLI and timer installed here while host-install waits?';
  const reminderOnceDevelop = 'Once develop has it, how do I get the reminder CLI and timer running here while host-install waits?';
  const shown = (text: string, taken?: boolean) => ({ kind: 'suggest', text, ...(taken === undefined ? {} : { taken }) });

  test('the same suggestion again, spacing and case aside, repeats one the user passed over', () => {
    expect(repeatedSuggestion('Run  the tests.', [shown('run the tests.', false)])).toBe('run the tests.');
  });
  test('the audited near-repeats repeat the untaken one before them', () => {
    expect(repeatedSuggestion(timerThenList, [shown(timerThenClose, false)])).toBe(timerThenClose);
    expect(repeatedSuggestion(decisionsWhile, [shown(decisions, false)])).toBe(decisions);
    expect(repeatedSuggestion(reminderOnceDevelop, [shown(reminderAfterMerge, false)])).toBe(reminderAfterMerge);
  });
  test('one still in the box, not yet answered, counts as untaken', () => {
    expect(repeatedSuggestion(timerThenList, [shown(timerThenClose)])).toBe(timerThenClose);
  });
  test('a distinct suggestion passes, even one sharing its first words', () => {
    expect(repeatedSuggestion(timerThenCheck, [shown(timerThenClose, false)])).toBeNull();
    expect(repeatedSuggestion('Commit and push it', [shown('Commit it', false)])).toBeNull();
    expect(repeatedSuggestion(decisions, [shown(timerThenClose, false), shown(reminderAfterMerge, false)])).toBeNull();
  });
  test('a suggestion the user took never blocks a later similar one', () => {
    expect(repeatedSuggestion(timerThenList, [shown(timerThenClose, true)])).toBeNull();
    expect(repeatedSuggestion('run the tests', [shown('run the tests', true)])).toBeNull();
  });
  test(`only the last ${REPEAT_WINDOW} suggestions shown count, taken ones among them`, () => {
    expect(REPEAT_WINDOW).toBe(5);
    const others = ['Fix the parser', 'Open the release notes', 'Rename the config key', 'Draft the migration note'].map((t) => shown(t, false));
    expect(repeatedSuggestion(timerThenList, [shown(timerThenClose, false), ...others])).toBe(timerThenClose);
    expect(repeatedSuggestion(timerThenList, [shown(timerThenClose, false), ...others, shown('Ship it', true)])).toBeNull();
  });
  test('only suggestions since the last /clear count, and other feed entries are not suggestions', () => {
    expect(repeatedSuggestion(timerThenList, [shown(timerThenClose, false), { kind: 'clear', text: 'clear' }])).toBeNull();
    expect(repeatedSuggestion(timerThenList, [{ kind: 'you', text: timerThenClose }])).toBeNull();
    expect(repeatedSuggestion(timerThenList, [])).toBeNull();
  });
});
