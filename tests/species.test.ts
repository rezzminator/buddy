import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { HATS, SPECIES } from '../plugins/buddy/src/hatch.ts';
import { SPECIES_MAX_WIDTH, SPECIES_REQUIRED_POSES, rowWidth, validateHats, validateSpecies } from '../plugins/buddy/src/species.ts';

// The species template contract, on a fixture of our own; then every file the
// plugin ships in species/, found by listing the directory.

const fixture = (): Record<string, unknown> => JSON.parse(readFileSync(new URL('./fixtures/species-blob.json', import.meta.url), 'utf8'));
const HAT_ART = { crown: 'www', tophat: '_|_', propeller: '-+-', halo: '(_)', wizard: '/^\\', beanie: '(__)', tinyduck: '<o)' };
const DIR = new URL('../plugins/buddy/species/', import.meta.url);

function withPose(pose: string, frames: unknown): Record<string, unknown> {
  const raw = fixture();
  return { ...raw, poses: { ...(raw.poses as object), [pose]: frames } };
}

describe('validateSpecies', () => {
  test('the fixture is valid, {E} counted as one column', () => {
    const v = validateSpecies(fixture(), 'blob');
    expect(v.ok).toBe(true);
    // $schema is read nowhere: any value of it passes.
    expect(validateSpecies({ ...fixture(), $schema: 7 }, 'blob')).toEqual(v);
    expect(rowWidth(' ({E}{E}) ')).toBe(6);
  });

  test.each([
    ['row 0 must be blank', withPose('oops', [['  ^   ', ' ({E}{E})!']]), 'poses.oops[0][0]: row 0 is the hat row and must be all spaces'],
    ['a row of the wrong width', withPose('yay', [['      ', ' ({E}{E}) ! ']]), 'poses.yay[0][1]: must be exactly 6 columns (width), {E} counted as one (has 8)'],
    ['idle needs 3 frames', withPose('idle', [['      ', ' ({E}{E}) ']]), 'poses.idle: needs at least 3 frames'],
    ['walkRight needs 2 frames', withPose('walkRight', [['      ', ' ({E}{E})>']]), 'poses.walkRight: needs at least 2 frames'],
    ['at most 4 body rows', withPose('oops', [['      ', ' (__) ', ' (__) ', ' (__) ', ' (__) ', ' (__) ']]), 'poses.oops[0]: the hat row, then 1 to 4 body rows (has 6 rows)'],
    ['printable ASCII only', withPose('oops', [['      ', ' (°°) ']]), 'poses.oops[0][1]: printable ASCII only ({E} marks an eye)'],
    ['an unknown pose', withPose('dance', [['      ', ' (__) ']]), 'poses.dance: unknown pose'],
    ['an unknown field', { ...fixture(), author: 'x' }, 'author: unknown field'],
    ['a species not in the roll', { ...fixture(), species: 'unicorn' }, 'species: one of duck'],
    ['width over 12', { ...fixture(), width: 13 }, 'width: must be 1 to 12 (is 13)'],
    ['hatCol inside the width', { ...fixture(), hatCol: 6 }, 'hatCol: must be 0 to 5 (is 6)'],
    ['an unknown line event', { ...fixture(), lines: { hello: ['hi'] } }, 'lines.hello: unknown event'],
  ])('%s', (_name, raw, error) => {
    const v = validateSpecies(raw, 'blob');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain(error);
  });

  test('a missing required pose, and the file name', () => {
    const raw = fixture();
    const { sleep: _sleep, ...rest } = raw.poses as Record<string, unknown>;
    const v = validateSpecies({ ...raw, poses: rest }, 'blob');
    expect(v.ok || v.error).toBe('poses.sleep: required (required: idle, walkRight, oops, yay, sleep)');
    const w = validateSpecies(fixture(), 'duck');
    expect(w.ok || w.error).toBe('species: "blob" must equal the file name (duck.json)');
  });
});

describe('validateHats', () => {
  test('one row of at most 7 columns per hat but none', () => {
    expect(validateHats(HAT_ART).ok).toBe(true);
    const { halo: _halo, ...noHalo } = HAT_ART;
    expect(validateHats(noHalo)).toEqual({ ok: false, error: 'halo: required' });
    expect(validateHats({ ...HAT_ART, crown: '12345678' })).toEqual({ ok: false, error: 'crown: at most 7 columns (has 8)' });
    expect(validateHats({ ...HAT_ART, none: '' })).toMatchObject({ ok: false, error: expect.stringContaining('none: unknown hat') });
  });
});

describe('schema/species.schema.json agrees with the validator', () => {
  const schema = JSON.parse(readFileSync(new URL('../plugins/buddy/schema/species.schema.json', import.meta.url), 'utf8'));
  test('species, width, required poses', () => {
    expect(schema.properties.species.enum).toEqual([...SPECIES]);
    expect(schema.properties.width.maximum).toBe(SPECIES_MAX_WIDTH);
    expect(schema.properties.poses.required).toEqual([...SPECIES_REQUIRED_POSES]);
    expect(HATS[0]).toBe('none');
  });
});

describe('the shipped species/ directory', () => {
  const names = existsSync(DIR) ? readdirSync(DIR).filter((n) => n.endsWith('.json')).sort() : null;
  const species = (names ?? []).filter((n) => n !== 'hats.json');
  const found = names === null ? 'no species/ directory' : `${species.length} species files${names.includes('hats.json') ? ' and hats.json' : ', no hats.json'}`;

  test(`holds one template per species, 18 (found: ${found})`, () => {
    expect(names, 'plugins/buddy/species/ does not exist').not.toBeNull();
    expect(species.length, `species/ holds ${species.length} species files, not 18`).toBe(18);
    expect(species).toEqual(SPECIES.map((s) => `${s}.json`).sort());
  });

  test('every species file validates, by its file name', () => {
    expect(species.length, 'no species files to validate').toBeGreaterThan(0);
    const bad = species.flatMap((n) => {
      const v = validateSpecies(JSON.parse(readFileSync(new URL(n, DIR), 'utf8')), n.replace(/\.json$/, ''));
      return v.ok ? [] : [`${n}: ${v.error}`];
    });
    expect(bad).toEqual([]);
  });

  test('hats.json validates', () => {
    expect(names?.includes('hats.json'), 'species/hats.json does not exist').toBe(true);
    const v = validateHats(JSON.parse(readFileSync(new URL('hats.json', DIR), 'utf8')));
    expect(v.ok || v.error).toBe(true);
  });
});
