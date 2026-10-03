import { describe, expect, test } from 'vitest';
import { AWAY_EFFORT, AWAY_IDLE_MS, AWAY_MODEL, AWAY_PUSHES_MAX, AWAY_REARM_MIN_MS, AWAY_REARM_SPREAD_MS, AWAY_STALE_MS, AWAY_SYSTEM, awayBody, awayDecision, awayRearmMs, awayRecordOf, awayWaitStale, type AwayRecord } from '../plugins/buddy/src/away.ts';

describe('the away call', () => {
  test('waits 30 idle minutes, runs on opus at low effort, and allows 3 pushes without a user prompt', () => {
    expect(AWAY_IDLE_MS).toBe(30 * 60_000);
    expect(AWAY_MODEL).toBe('opus');
    expect(AWAY_EFFORT).toBe('low');
    expect(AWAY_PUSHES_MAX).toBe(3);
  });
  test('its system prompt is R4b prompt d2, and forbids a git push, a deletion and a publication', () => {
    expect(AWAY_SYSTEM.startsWith('Decide whether an idle Claude chat should resume.')).toBe(true);
    expect(AWAY_SYSTEM).toContain('Never ask for a git push, a deletion, a publication, a credential or an account change.');
    expect(AWAY_SYSTEM.endsWith('PAUSE when in doubt.')).toBe(true);
  });
});

describe('awayBody: body A, the last response verbatim', () => {
  test('quotes the response whole', () => {
    expect(awayBody('Done. Tests pass.')).toBe('Claude has been idle for 30 minutes. Its last response, verbatim:\n<last_response>\nDone. Tests pass.\n</last_response>');
  });
  test('never trims or cuts a long, multi-line response', () => {
    const long = `  first line\n${'x'.repeat(20_000)}\n  `;
    expect(awayBody(long)).toContain(`<last_response>\n${long}\n</last_response>`);
  });
});

describe('awayDecision: PAUSE, or one line PUSH: {text}', () => {
  test('the whole word PAUSE, around whitespace, pauses', () => {
    expect(awayDecision('  PAUSE\n')).toEqual({ decision: 'pause' });
  });
  test('one PUSH line pushes its text, trimmed', () => {
    expect(awayDecision('PUSH: Run the remaining replay and report.')).toEqual({ decision: 'push', text: 'Run the remaining replay and report.' });
    expect(awayDecision('\nPUSH: Finish the migration.  \n')).toEqual({ decision: 'push', text: 'Finish the migration.' });
  });
  test.each(['PAUSE because the request is finished', 'PUSH:', 'PUSH:   ', 'PUSH: a\nb', 'PUSH: a\rb', 'push: x', 'PUSH:x', 'Pause', ''])('anything else is malformed: %j', (reply) => {
    expect(awayDecision(reply)).toEqual({ decision: 'malformed' });
  });
  test.each(['git push the branch', 'delete the old logs', 'publish the release', 'Push to origin.', 'rm the build folder', 'tag v2', 'merge develop', 'log in again', 'rotate the API key'])('a push asking a forbidden step is refused: %j', (text) => {
    expect(awayDecision(`PUSH: ${text}`)).toEqual({ decision: 'refused', text });
  });
  test.each([
    // The review's examples, each sent before.
    'Commit the changes and push them.', 'Push your commits.', 'force-push the fix', 'git branch -D old', 'git clean -fdx and rebuild', 'unlink the stale file', 'gh pr create for the fix',
    // Every git write the promise names, in any phrasing.
    'Pushing now.', 'commit-and-push the fix', 'Force the update through.', 'git branch -d old', 'git reset --hard origin/main', 'Tag the build.', 'Merge the branch.', 'rebase onto develop', 'Rebasing is next.',
    'gh release create v3', 'gh repo create buddy-next', 'Open a pull request.',
    // Deletions and publications.
    'rm -rf dist', 'Delete the cache.', 'Drop the table.', 'Remove the stale fixtures.', 'publish the package', 'npm publish', 'Release v3.', 'Deploy to staging.', 'redeploy is not a word, deploy is',
    // Account steps.
    'login to the registry', 'Log out and back in.', 'log-in again', 'Rotate the token.', 'Check the account settings.', 'Store the credential.', 'Set the access key.', 'Update the password.',
  ])('every step the promise names is refused, in any phrasing: %j', (text) => {
    expect(awayDecision(`PUSH: ${text}`)).toEqual({ decision: 'refused', text });
  });
  test.each(['Run the remaining replay and report.', 'Finish the migration of the parser tests.', 'Commit the fix locally and run the tests.', 'Enforce the lint rule in the remaining files.', 'Update the tokenizer tests.', 'Rerun the formatter on the remaining files.'])('owed local work still pushes: %j', (text) => {
    expect(awayDecision(`PUSH: ${text}`)).toEqual({ decision: 'push', text });
  });
  test('the forbidden check holds call after call: no regex state between them', () => {
    expect(awayDecision('PUSH: delete the old logs').decision).toBe('refused');
    expect(awayDecision('PUSH: delete the old logs').decision).toBe('refused');
  });
  test('a word that merely contains a forbidden one is no forbidden step', () => {
    expect(awayDecision('PUSH: Rerun the formatter on the remaining files.')).toEqual({ decision: 'push', text: 'Rerun the formatter on the remaining files.' });
  });
});

describe('awayRecordOf: the kept wait, read back', () => {
  test('a good record is accepted, with a wait or without', () => {
    const kept = { version: 1, wait: { at: 1_700_000_000_000, answer: 'Done.' }, pushes: 2 };
    expect(awayRecordOf(kept)).toEqual(kept);
    expect(awayRecordOf({ version: 1, wait: null, pushes: 0 })).toEqual({ version: 1, wait: null, pushes: 0 });
  });
  test.each([
    ['a wrong version', { version: 2, wait: null, pushes: 0 }],
    ['negative pushes', { version: 1, wait: null, pushes: -1 }],
    ['fractional pushes', { version: 1, wait: null, pushes: 1.5 }],
    ['a missing wait', { version: 1, pushes: 0 }],
    ['a non-string answer', { version: 1, wait: { at: 1, answer: 5 }, pushes: 0 }],
    ['a non-finite at', { version: 1, wait: { at: Number.POSITIVE_INFINITY, answer: 'A' }, pushes: 0 }],
    ['a string at', { version: 1, wait: { at: '1', answer: 'A' }, pushes: 0 }],
    ['a null', null],
    ['a string', 'away'],
    ['an array', []],
  ])('%s is rejected', (_name, value) => {
    expect(awayRecordOf(value)).toBeNull();
  });
});

describe('awayRearmMs: what remains of the wait after a load', () => {
  const NOW = 1_700_000_000_000;
  const GATE = { promptWhenIdle: true, midTurn: false };
  const kept = (over: Partial<AwayRecord> = {}): AwayRecord => ({ version: 1, wait: { at: NOW - 20 * 60_000, answer: 'Halfway.' }, pushes: 0, ...over });
  test('a wait whose turn ended more than 2 hours ago is stale: dropped, never re-armed', () => {
    expect(AWAY_STALE_MS).toBe(2 * 60 * 60_000);
    const at = (ago: number) => kept({ wait: { at: NOW - ago, answer: 'Halfway.' } });
    expect(awayWaitStale(at(AWAY_STALE_MS + 1), NOW)).toBe(true);
    expect(awayRearmMs(at(AWAY_STALE_MS + 1), NOW, 0, GATE)).toBeNull();
    expect(awayWaitStale(at(24 * 60 * 60_000), NOW)).toBe(true);
    expect(awayRearmMs(at(24 * 60 * 60_000), NOW, 0, GATE)).toBeNull();
    // Exactly 2 hours is still kept: past due, it fires soon.
    expect(awayWaitStale(at(AWAY_STALE_MS), NOW)).toBe(false);
    expect(awayRearmMs(at(AWAY_STALE_MS), NOW, 0, GATE)).toBe(AWAY_REARM_MIN_MS);
    expect(awayWaitStale(kept({ wait: null }), NOW)).toBe(false);
  });
  test('re-arms for exactly what remains of the 30 minutes', () => {
    expect(awayRearmMs(kept(), NOW, 0.5, GATE)).toBe(10 * 60_000);
  });
  test('arms nothing with promptWhenIdle off, mid-turn, with no wait, at the push limit or with a blank answer', () => {
    expect(awayRearmMs(kept(), NOW, 0, { promptWhenIdle: false, midTurn: false })).toBeNull();
    expect(awayRearmMs(kept(), NOW, 0, { promptWhenIdle: true, midTurn: true })).toBeNull();
    expect(awayRearmMs(kept({ wait: null }), NOW, 0, GATE)).toBeNull();
    expect(awayRearmMs(kept({ pushes: AWAY_PUSHES_MAX }), NOW, 0, GATE)).toBeNull();
    expect(typeof awayRearmMs(kept({ pushes: AWAY_PUSHES_MAX - 1 }), NOW, 0, GATE)).toBe('number');
    expect(awayRearmMs(kept({ wait: { at: NOW, answer: ' \n ' } }), NOW, 0, GATE)).toBeNull();
  });
  test('a turn that ended in the future (clock skew) waits at most the whole 30 minutes', () => {
    expect(awayRearmMs(kept({ wait: { at: NOW + 10 * 60_000, answer: 'A' } }), NOW, 0, GATE)).toBe(AWAY_IDLE_MS);
  });
  test.each([0, 0.5, 1])('a wait due within a minute, or long past due, is spread: spread %s', (spread) => {
    const ms = AWAY_REARM_MIN_MS + Math.floor(spread * AWAY_REARM_SPREAD_MS);
    expect(awayRearmMs(kept({ wait: { at: NOW - AWAY_IDLE_MS + 30_000, answer: 'A' } }), NOW, spread, GATE)).toBe(ms);
    expect(awayRearmMs(kept({ wait: { at: NOW - 2 * 3_600_000, answer: 'A' } }), NOW, spread, GATE)).toBe(ms);
  });
  test('a spread outside [0, 1] is clamped and a NaN one counts as 0', () => {
    expect(awayRearmMs(kept({ wait: { at: NOW - 2 * 3_600_000, answer: 'A' } }), NOW, Number.NaN, GATE)).toBe(AWAY_REARM_MIN_MS);
    expect(awayRearmMs(kept({ wait: { at: NOW - 2 * 3_600_000, answer: 'A' } }), NOW, 7, GATE)).toBe(AWAY_REARM_MIN_MS + AWAY_REARM_SPREAD_MS);
    expect(awayRearmMs(kept({ wait: { at: NOW - 2 * 3_600_000, answer: 'A' } }), NOW, -1, GATE)).toBe(AWAY_REARM_MIN_MS);
  });
});
