import { describe, expect, test } from 'vitest';
import { validateCharacter } from '../plugins/buddy/src/character.ts';
import { GENERIC_LINES, pickLine, poolFor } from '../plugins/buddy/src/lines.ts';
import { raw } from './fixtures.ts';

const v = validateCharacter(raw());
if (!v.ok) throw new Error(v.error);
const c = v.character;

describe('lines', () => {
  test("a character's own pool wins; a missing one is the generic pool", () => {
    expect(poolFor(c, 'greeting')).toEqual(['Hi from Fixy.']);
    expect(poolFor(c, 'toolFail')).toBe(GENERIC_LINES.toolFail);
  });
  test('wake falls back to the greeting before the generic pool', () => {
    expect(poolFor(c, 'wake')).toEqual(['Hi from Fixy.']);
  });
  test('never repeats the last line of a pool', () => {
    const pool = ['a', 'b', 'c'];
    for (const r of [0, 0.34, 0.67, 0.99]) expect(pickLine(pool, 'b', () => r)).not.toBe('b');
    expect(pickLine(['only'], 'only', () => 0.5)).toBe('only');
  });
  test('every generic line fits a bubble', () => {
    for (const pool of Object.values(GENERIC_LINES)) for (const l of pool) expect(l.length).toBeLessThanOrEqual(120);
  });
});
