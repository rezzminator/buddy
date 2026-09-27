import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  companionOf, hatRow, hatchedDate, identityOf, newestFirst, originalCharacter, originalLabel, personaOf, savedOriginalOf, statBar, stars,
  type Soul,
} from '../plugins/buddy/src/original.ts';
import { frameAt } from '../plugins/buddy/src/character.ts';
import type { Bones } from '../plugins/buddy/src/hatch.ts';
import { RAINBOW, SHINY_STEP_MS, buildScene, spriteColor } from '../plugins/buddy/src/scene.ts';
import { cellWidth } from '../plugins/buddy/src/width.ts';
import { validateSpecies, type SpeciesTemplate } from '../plugins/buddy/src/species.ts';

const v = validateSpecies(JSON.parse(readFileSync(new URL('./fixtures/species-blob.json', import.meta.url), 'utf8')), 'blob');
if (!v.ok) throw new Error(`fixture species: ${v.error}`);
const template: SpeciesTemplate = v.template;
const HATS = { crown: 'www', tophat: '_|_', propeller: '-+-', halo: '(_)', wizard: '/^\\', beanie: '(__)', tinyduck: '<o)' };
const bones = (over: Partial<Bones> = {}): Bones => ({
  rarity: 'rare', species: 'blob', eye: '◉', hat: 'crown', shiny: false,
  stats: { DEBUGGING: 30, PATIENCE: 9, CHAOS: 40, WISDOM: 50, SNARK: 81 },
  ...over,
});
const soul: Soul = { name: 'Mochi', personality: 'A round, patient blob who hums at green tests.', hatchedAt: Date.UTC(2026, 3, 1) };

function original(b: Bones = bones()) {
  const r = originalCharacter({ soul, bones: b, variant: 'native', template, hats: HATS });
  if (!r.ok) throw new Error(r.error);
  return r.character;
}

describe('the config', () => {
  test('identity: accountUuid, then userID, then anon', () => {
    expect(identityOf({ oauthAccount: { accountUuid: 'u-1' }, userID: 'x' })).toBe('u-1');
    expect(identityOf({ oauthAccount: null, userID: 'x' })).toBe('x');
    expect(identityOf({ oauthAccount: {}, userID: 'x' })).toBe('x');
    expect(identityOf({})).toBe('anon');
    expect(identityOf('not an object')).toBe('anon');
  });

  test('the companion: none, malformed, or a soul', () => {
    expect(companionOf({})).toEqual({});
    expect(companionOf({ companion: 'Rex' })).toEqual({ error: 'the companion is not an object' });
    expect(companionOf({ companion: { personality: 'x' } })).toEqual({ error: 'the companion has no name' });
    expect(companionOf({ companion: { name: ' Rex ', personality: 'Gruff.', hatchedAt: 5 } })).toEqual({ soul: { name: 'Rex', personality: 'Gruff.', hatchedAt: 5 } });
  });

  test('backup names, newest first', () => {
    const sorted = [
      { name: '.claude.json.bak-20260401', mtimeMs: 5 },
      { name: '.claude.json.bak-20260409', mtimeMs: 5 },
      { name: '.claude.json.backup', mtimeMs: 9 },
    ].sort(newestFirst);
    expect(sorted.map((s) => s.name)).toEqual(['.claude.json.backup', '.claude.json.bak-20260409', '.claude.json.bak-20260401']);
  });
});

describe('originalCharacter', () => {
  test('the eye in, the hat centered on hatCol, the rarity color, the name in the lines', () => {
    const c = original();
    expect(c.id).toBe('original');
    expect(c.width).toBe(6);
    expect(frameAt(c, 'idle', 0)).toEqual([' www  ', ' (◉◉) ', ' (__) ']);
    expect(frameAt(c, 'sleep', 0)).toEqual([' www  ', ' (--) ', ' (__) ']);
    expect(c.color).toBe('blue');
    expect(c.lines.greeting).toEqual(['Mochi blobs in.']);
    expect(c.lines.petted).toEqual(['Mochi wobbles.', 'Again, says Mochi.']);
    expect(c.description).toBe('★★★ rare blob (native)');
    expect(c.shiny).toBeUndefined();
  });

  test('no hat: the hat row is dropped', () => {
    const c = original(bones({ rarity: 'common', hat: 'none' }));
    expect(c.height).toBe(2);
    expect(frameAt(c, 'idle', 0)).toEqual([' (◉◉) ', ' (__) ']);
    expect(c.color).toBe('white');
  });

  test('shiny: a sparkle column that alternates rows, and a rainbow per tick', () => {
    const c = original(bones({ shiny: true }));
    expect(c.width).toBe(7);
    expect(frameAt(c, 'walkRight', 0)).toEqual([' www  *', ' (◉◉)> ', ' /  \\  ']);
    expect(frameAt(c, 'walkRight', 1)).toEqual([' www   ', ' (◉◉)>*', ' |  |  ']);
    const colors = RAINBOW.map((_, i) => spriteColor(c, i * SHINY_STEP_MS));
    expect(colors).toEqual([...RAINBOW]);
    expect(spriteColor(original(), 12345)).toBe('blue');
  });

  test('a hat the art lacks, or the wrong species, is an error', () => {
    expect(originalCharacter({ soul, bones: bones(), variant: 'npm', template, hats: {} })).toEqual({ ok: false, error: 'species/hats.json has no crown' });
    expect(originalCharacter({ soul, bones: bones({ species: 'duck' }), variant: 'npm', template, hats: HATS })).toMatchObject({ ok: false });
  });

  test('the hover card: name, species and stars, the stats line, five bars, the hatch date', () => {
    const s = buildScene({ character: original(bones({ shiny: true })), pose: 'idle', frame: 0, x: 0, cols: 100, maxRows: 10, bubble: null, confetti: null, sleeping: false, zTick: 0, stats: { pets: 2, questions: 1 }, now: 0 })!;
    expect(s.card?.lines).toEqual([
      'Mochi',
      'blob · ★★★ rare · shiny ✨',
      'pets 2 | questions 1 | curious',
      'DEBUGGING ███░░░░░░░ 30',
      'PATIENCE  █░░░░░░░░░ 9',
      'CHAOS     ████░░░░░░ 40',
      'WISDOM    █████░░░░░ 50',
      'SNARK     ████████░░ 81',
      'hatched 2026-04-01',
    ]);
  });

  test('the card is measured in cells: ★ █ ░ · count twice on an ambiguous-wide terminal', () => {
    const input = { character: original(bones({ shiny: true })), pose: 'idle', frame: 0, x: 0, cols: 100, maxRows: 10, bubble: null, confetti: null, sleeping: false, zTick: 0, stats: { pets: 2, questions: 1 }, now: 0 } as const;
    expect(buildScene(input)!.card!.width).toBe(34);
    const wide = buildScene({ ...input, ambiguousWide: true })!;
    expect(wide.card!.width).toBe(37);
    for (const line of wide.card!.lines) expect(cellWidth(line, { ambiguousWide: true })).toBeLessThanOrEqual(wide.card!.width - 4);
  });
});

describe('the words', () => {
  test('stars, bars, dates, the hat row', () => {
    expect(stars('common')).toBe('★');
    expect(stars('legendary')).toBe('★★★★★');
    expect(statBar('SNARK', 81)).toBe('SNARK     ████████░░ 81');
    expect(statBar('CHAOS', 100)).toBe('CHAOS     ██████████ 100');
    expect(statBar('WISDOM', 1)).toBe('WISDOM    ░░░░░░░░░░ 1');
    expect(hatchedDate('2026-04-02T10:00:00Z')).toBe('2026-04-02');
    expect(hatchedDate(undefined)).toBe('unknown');
    expect(hatchedDate('soon')).toBe('unknown');
    expect(hatRow(6, 0, 'www')).toBe('www   ');
    expect(hatRow(6, 5, 'www')).toBe('   www');
  });

  test('the persona: the soul, the species and a stats hint', () => {
    const p = personaOf(soul, bones());
    expect(p).toContain('You are Mochi, a rare blob');
    expect(p).toContain('A round, patient blob who hums at green tests.');
    expect(p).toContain('SNARK 81');
    expect(p).toContain('You are sassy and a little snarky.');
    expect(p).toContain('You are a little impatient.');
  });
});

describe('the saved pick', () => {
  test('the label names the roll; the stored pick comes back validated, never the identity', () => {
    expect(originalLabel('Mochi', 'npm')).toBe('Mochi — npm install');
    expect(savedOriginalOf({ variant: 'npm', soul })).toEqual({ variant: 'npm', soul });
    expect(savedOriginalOf({ variant: 'native', soul: { name: 'Rex', personality: 'Gruff.' } })).toEqual({ variant: 'native', soul: { name: 'Rex', personality: 'Gruff.' } });
    expect(savedOriginalOf({ variant: 'other', soul })).toBeUndefined();
    expect(savedOriginalOf({ variant: 'native', soul: { personality: 'x' } })).toBeUndefined();
    expect(savedOriginalOf(undefined)).toBeUndefined();
  });
});
