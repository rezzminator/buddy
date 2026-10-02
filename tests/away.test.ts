import { describe, expect, test } from 'vitest';
import { AWAY_EFFORT, AWAY_IDLE_MS, AWAY_MODEL, AWAY_PUSHES_MAX, AWAY_SYSTEM, awayBody, awayDecision } from '../plugins/buddy/src/away.ts';

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
