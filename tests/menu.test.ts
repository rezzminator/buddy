import { describe, expect, test } from 'vitest';
import { validateCharacter, type Character } from '../plugins/buddy/src/character.ts';
import {
  LIST_MIN_WIDTH, allItems, buildMenu, currentKeyOf, findItem, listWidth, previewOf, rowLabel, type MenuInput, type Originals,
} from '../plugins/buddy/src/menu.ts';
import { loadEntries, mergeRoster } from '../plugins/buddy/src/roster.ts';

// Invented characters and an invented companion: never a real ~/.claude.json.

function char(id: string, name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id, name, description: `${name}.`, persona: `You are ${name},\n  a test.`, poses: { idle: [[`(${id})`], [`[${id}]`]] }, lines: { greeting: [`${name} waves.`] }, motion: { walk: false }, ...extra });
}

const builtins = loadEntries([{ name: 'cat.json', text: char('cat', 'Cat') }, { name: 'duck.json', text: char('duck', 'Duck') }, { name: 'bad.json', text: '{' }], 'builtin');
const users = loadEntries([{ name: 'mine.json', text: char('mine', 'Mine') }], 'user');
const roster = mergeRoster(builtins, users);
const v = validateCharacter(JSON.parse(char('original', 'Mochi', { lines: {} })));
if (!v.ok) throw new Error(v.error);
const mochi: Character = { ...v.character, card: { subtitle: 'blob · ★★★ rare', rows: ['SNARK     ████████░░ 81', 'hatched 2026-04-01'] } };
const found: Originals = { kind: 'found', soul: { name: 'Mochi', personality: 'Round.' }, notes: [], rolls: [{ variant: 'native', character: mochi }, { variant: 'npm', error: 'species/hats.json has no crown' }] };
const input = (o: Partial<MenuInput> = {}): MenuInput => ({ roster, customCharactersDir: { isSet: true }, originals: found, ...o });

describe('buildMenu', () => {
  test('two titled groups: shipped, and yours (the original companion both rolls, then your own files)', () => {
    const m = buildMenu(input());
    expect(m.sections.map((s) => s.title)).toEqual(['Shipped', 'Yours']);
    expect(m.sections[0]!.items.map((i) => i.label)).toEqual(['bad (invalid)', 'Cat (cat)', 'Duck (duck)']);
    expect(m.sections[1]!.items.map((i) => [i.key, i.label])).toEqual([['original:native', 'Mochi — native install'], ['original:npm', 'Mochi — npm install'], ['use:mine', 'Mine (mine)']]);
    expect(m.sections[1]!.items[1]!.error).toBe('species/hats.json has no crown');
    expect(m.sections.flatMap((s) => s.lines)).toEqual([]);
  });

  test('a failure to look is a line in its group, never an empty group', () => {
    const m = buildMenu(input({ originals: { kind: 'error', error: "couldn't read ~/.claude.json: EACCES" }, shippedError: "couldn't read /x/characters: gone", customCharactersDir: { isSet: true, error: "couldn't read ~/chars: gone" } }));
    expect(m.sections.map((s) => s.lines)).toEqual([["couldn't read /x/characters: gone"], ["couldn't read ~/.claude.json: EACCES", "couldn't read ~/chars: gone"]]);
    expect(m.sections[1]!.items.map((i) => i.key)).toEqual(['use:mine']);
  });

  test('no companion is no line; an empty Yours says how to fill it in one line; a backup is named', () => {
    const none = buildMenu(input({ originals: { kind: 'none', notes: [] }, customCharactersDir: { isSet: false }, roster: mergeRoster([], []) }));
    expect(none.sections.map((s) => s.lines)).toEqual([['No shipped characters found.'], ['None yet: set customCharactersDir to a folder of your own character files.']]);
    expect(buildMenu(input({ originals: { kind: 'none', notes: [] }, customCharactersDir: { isSet: true }, roster: mergeRoster([], []) })).sections[1]!.lines).toEqual(['No character files in customCharactersDir.']);
    expect(buildMenu(input({ originals: { kind: 'none', notes: [] } })).sections[1]).toMatchObject({ lines: [], items: [{ key: 'use:mine' }] });
    const backup = buildMenu(input({ originals: { ...found, from: '~/.claude.json.backup' } as Originals }));
    expect(backup.sections[1]!.lines).toEqual(['From the backup ~/.claude.json.backup.']);
  });
});

describe('moving and marking', () => {
  const m = buildMenu(input());
  test('every row in order: the shipped ones, then yours', () => {
    expect(allItems(m).map((i) => i.key)).toEqual(['use:bad', 'use:cat', 'use:duck', 'original:native', 'original:npm', 'use:mine']);
  });
  test('the current row: the original by its roll, any other by id, marked with *', () => {
    expect(currentKeyOf('original', 'npm')).toBe('original:npm');
    expect(currentKeyOf('cat', undefined)).toBe('use:cat');
    expect(rowLabel(findItem(m, 'use:cat')!, 'use:cat')).toBe('* Cat (cat)');
    expect(rowLabel(findItem(m, 'use:duck')!, 'use:cat')).toBe('  Duck (duck)');
  });
});

describe('previewOf', () => {
  const m = buildMenu(input());
  test('the idle frames turn; name, description (never the persona prompt), greeting', () => {
    const p0 = previewOf(findItem(m, 'use:cat'), 0, 0);
    const p1 = previewOf(findItem(m, 'use:cat'), 1, 0);
    expect(p0).toMatchObject({ kind: 'character', rows: ['(cat)'], name: 'Cat', about: 'Cat.', sample: 'Cat waves.', card: [] });
    expect(JSON.stringify(p0)).not.toContain('You are Cat');
    expect(p1).toMatchObject({ rows: ['[cat]'] });
  });
  test('an original shows its card; no greeting of its own falls back to the generic one', () => {
    const p = previewOf(findItem(m, 'original:native'), 0, 0);
    expect(p).toMatchObject({ name: 'Mochi', about: 'Round.', card: ['blob · ★★★ rare', 'SNARK     ████████░░ 81', 'hatched 2026-04-01'], sample: 'Hello there.' });
    expect(JSON.stringify(p)).not.toContain('You are Mochi');
  });
  test('an entry that will not draw says why', () => {
    expect(previewOf(findItem(m, 'use:bad'), 0, 0)).toMatchObject({ kind: 'error', label: 'bad (invalid)' });
    expect(previewOf(findItem(m, 'original:npm'), 0, 0)).toEqual({ kind: 'error', label: 'Mochi — npm install', error: 'species/hats.json has no crown' });
    expect(previewOf(undefined, 0, 0)).toMatchObject({ kind: 'error' });
  });
});

describe('listWidth', () => {
  const menu = (lines: string[], labels: string[]) => ({ sections: [{ title: 'Shipped', lines: [], items: labels.map((l) => ({ key: `use:${l}`, label: l })) }, { title: 'Yours', lines, items: [] }] }) as never;
  test('the widest entry or title sets it, with room for the marker; a long notice never widens it', () => {
    const notice = 'No companion in $CLAUDE_CONFIG_DIR/.claude.json or its backups.';
    expect(listWidth(menu([notice], ['Yellow Duck (yellow-duck)']))).toBe('* Yellow Duck (yellow-duck)'.length);
    expect(listWidth(menu([], ['Cat (cat)']))).toBe(LIST_MIN_WIDTH);
  });
});
