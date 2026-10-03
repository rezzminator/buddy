import { describe, expect, test } from 'vitest';
import { STANDIN_DEFAULT, choose, isCharacterFile, loadEntries, mergeRoster, startWarning } from '../plugins/buddy/src/roster.ts';
import { raw } from './fixtures.ts';

const json = (o: Record<string, unknown>) => JSON.stringify(raw(o));
const builtins = loadEntries(
  [
    { name: 'duck.json', text: json({ id: 'duck', name: 'Quacky' }) },
    { name: 'cat.json', text: json({ id: 'cat', name: 'Cat' }) },
    { name: 'bad.json', text: '{ nope' },
    { name: 'gone.json', error: 'unreadable: EACCES' },
  ],
  'builtin',
);

describe('roster', () => {
  test('character files are visible .json entries that are not directories', () => {
    expect(isCharacterFile('cat.json', 'file')).toBe(true);
    expect(isCharacterFile('cat.json', 'other')).toBe(true);
    expect(isCharacterFile('cat.json', 'dir')).toBe(false);
    expect(isCharacterFile('.cat.json', 'file')).toBe(false);
    expect(isCharacterFile('README.md', 'file')).toBe(false);
  });
  test('an invalid file stays in with its first error', () => {
    expect(builtins.map((e) => [e.id, e.error ?? 'ok'])).toEqual([
      ['duck', 'ok'],
      ['cat', 'ok'],
      ['bad', expect.stringMatching(/^not valid JSON: /)],
      ['gone', 'unreadable: EACCES'],
    ]);
  });
  test("the user's file wins an id; entries sort by id", () => {
    const user = loadEntries([{ name: 'cat.json', text: json({ id: 'cat', name: 'My Cat' }) }], 'user');
    const r = mergeRoster(builtins, user, ['couldn\'t read x']);
    expect(r.entries.map((e) => e.id)).toEqual(['bad', 'cat', 'duck', 'gone']);
    expect(r.entries.find((e) => e.id === 'cat')).toMatchObject({ source: 'user', character: { name: 'My Cat' } });
    expect(r.errors).toEqual(["couldn't read x"]);
  });
  test('choice: store, then option, then the duck', () => {
    const r = mergeRoster(builtins, []);
    expect(choose(r, 'cat', 'duck').character.name).toBe('Cat');
    expect(choose(r, undefined, 'cat').character.name).toBe('Cat');
    expect(choose(r, undefined, undefined)).toMatchObject({ id: 'duck', character: { name: 'Quacky' } });
    expect(choose(r, undefined, undefined).error).toBeUndefined();
  });
  test('a missing or invalid choice draws the duck and says why', () => {
    const r = mergeRoster(builtins, []);
    expect(choose(r, 'bad', undefined)).toMatchObject({ character: { name: 'Quacky' }, error: expect.stringMatching(/^Couldn't load bad: not valid JSON: /) });
    expect(choose(r, 'ghost', undefined).error).toBe("Couldn't load ghost: no such character; ctrl+x t in /buddy picks another");
  });
  test('no duck file: the stand-in duck, and the error', () => {
    const r = mergeRoster([], []);
    const c = choose(r, undefined, undefined);
    expect(c.character).toBe(STANDIN_DEFAULT);
    expect(c.character.id).toBe('duck');
    expect(c.error).toBe("Couldn't load duck: no such character; ctrl+x t in /buddy picks another");
  });
  test('"original" is reserved for the original companion: a file taking it is an error, never an entry', () => {
    const users = loadEntries([{ name: 'original.json', text: json({ id: 'original', name: 'Impostor' }) }, { name: 'mine.json', text: json({ id: 'mine', name: 'Mine' }) }], 'user');
    const r = mergeRoster(builtins, users, ['an earlier error']);
    expect(r.entries.map((e) => e.id)).not.toContain('original');
    expect(r.entries.map((e) => e.id)).toContain('mine');
    expect(r.errors).toEqual(['an earlier error', 'original.json (user): "original" is reserved for your original companion; rename the file and its id']);
  });
  test('the first greeting says the choice error, the roster errors and every ignored option, joined; nothing when all is well', () => {
    expect(startWarning(undefined, [], [])).toBeUndefined();
    expect(startWarning("Couldn't load x: no such character", [], ['option walkOverPromptBar ignored: "maybe" is not true or false'])).toBe(
      'Couldn\'t load x: no such character; option walkOverPromptBar ignored: "maybe" is not true or false',
    );
    expect(startWarning(undefined, [], ['option commentAfterEachTurn ignored: 1 is not true or false'])).toBe('option commentAfterEachTurn ignored: 1 is not true or false');
  });
  test('a roster error, such as a file taking the reserved id "original", is said in the first greeting and points at the personality picker', () => {
    const { errors } = mergeRoster(builtins, loadEntries([{ name: 'original.json', text: json({ id: 'original', name: 'Impostor' }) }], 'user'));
    expect(startWarning(undefined, errors, [])).toBe(
      'original.json (user): "original" is reserved for your original companion; rename the file and its id; ctrl+x t in /buddy lists your characters',
    );
    expect(startWarning("Couldn't load original: no original companion saved; ctrl+x t in /buddy picks one", errors, ['option commentAfterEachTurn ignored: 1 is not true or false'])).toBe(
      'Couldn\'t load original: no original companion saved; ctrl+x t in /buddy picks one; original.json (user): "original" is reserved for your original companion; rename the file and its id; ctrl+x t in /buddy lists your characters; option commentAfterEachTurn ignored: 1 is not true or false',
    );
  });
});
