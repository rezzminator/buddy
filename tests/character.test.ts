import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { frameAt, framesFor, normalizeFrames, validateCharacter, type Character } from '../plugins/buddy/src/character.ts';
import { raw } from './fixtures.ts';

function ok(r: Record<string, unknown>, fileId?: string): Character {
  const v = validateCharacter(r, fileId);
  if (!v.ok) throw new Error(v.error);
  return v.character;
}
function err(r: unknown, fileId?: string): string {
  const v = validateCharacter(r, fileId);
  return v.ok ? 'valid' : v.error;
}

describe('validateCharacter', () => {
  test('applies the defaults', () => {
    const c = ok(raw(), 'fixy');
    expect(c.color).toBe('yellow');
    expect(c.motion).toEqual({ walk: true, stepMs: 200, restChance: 0.02, restTicks: 15 });
    expect(c.author).toBeUndefined();
  });

  test('pads rows to the widest and bottom-aligns frames to the tallest', () => {
    const c = ok(raw());
    expect(c.width).toBe(4);
    expect(c.height).toBe(2);
    expect(c.poses.yay).toEqual([['    ', '\\o/ ']]);
    expect(c.poses.idle).toEqual([['(o) ', '/|\\ ']]);
  });

  test('names the first problem by its path', () => {
    expect(err([])).toBe('must be a JSON object');
    expect(err(raw({ persona: undefined }))).toBe('persona: required');
    expect(err(raw({ id: 'Fixy' }))).toMatch(/^id: "Fixy" must match/);
    expect(err(raw(), 'other')).toBe('id: "fixy" must equal the file name (other.json)');
    expect(err(raw({ name: 'x'.repeat(41) }))).toBe('name: at most 40 characters (has 41)');
    expect(err(raw({ extra: 1 }))).toMatch(/^extra: unknown field/);
    expect(err(raw({ color: 'teal' }))).toMatch(/^color: an Ink color name/);
    expect(err(raw({ poses: { walkRight: [['a'], ['b']] } }))).toBe('poses.idle: required');
    expect(err(raw({ poses: { idle: [['a']] } }))).toMatch(/^poses.walkRight: required while motion.walk is true/);
    expect(err(raw({ poses: { idle: [['a']], walkRight: [['a']] } }))).toBe('poses.walkRight: needs at least 2 frames');
    expect(err(raw({ poses: { idle: [['a\tb']] }, motion: { walk: false } }))).toBe('poses.idle[0][0]: printable ASCII only (no tabs, emoji or wide characters)');
    expect(err(raw({ poses: { idle: [['é']] }, motion: { walk: false } }))).toMatch(/printable ASCII only/);
    expect(err(raw({ poses: { idle: [['x'.repeat(17)]] }, motion: { walk: false } }))).toBe('poses.idle[0][0]: at most 16 columns (has 17)');
    expect(err(raw({ poses: { idle: [['1', '2', '3', '4', '5', '6', '7']] }, motion: { walk: false } }))).toBe('poses.idle[0]: 1 to 6 rows (has 7)');
    expect(err(raw({ poses: { idle: [['a']], dance: [['b']] }, motion: { walk: false } }))).toMatch(/^poses.dance: unknown pose/);
    expect(err(raw({ lines: { hello: ['x'] } }))).toMatch(/^lines.hello: unknown event/);
    expect(err(raw({ lines: { greeting: ['x'.repeat(121)] } }))).toBe('lines.greeting[0]: at most 120 characters (has 121)');
    expect(err(raw({ lines: { greeting: [] } }))).toBe('lines.greeting: must be a non-empty array of strings');
    expect(err(raw({ motion: { stepMs: 50 } }))).toBe('motion.stepMs: must be 80 to 1000 (is 50)');
    expect(err(raw({ motion: { restChance: 0.5 } }))).toBe('motion.restChance: must be 0 to 0.2 (is 0.5)');
    expect(err(raw({ motion: { restTicks: 1.5 } }))).toBe('motion.restTicks: must be an integer');
    expect(err(raw({ motion: { walk: 'yes' } }))).toBe('motion.walk: must be true or false');
  });

  test('a standing character needs no walk frames; hex colors pass', () => {
    const c = ok(raw({ poses: { idle: [['a']] }, motion: { walk: false }, color: '#ff8800', author: 'Someone' }));
    expect(c.motion.walk).toBe(false);
    expect(c.color).toBe('#ff8800');
    expect(c.author).toBe('Someone');
  });
});

describe('poses', () => {
  const c = ok(raw());
  test('fall back along their chain', () => {
    expect(framesFor(c, 'walkLeft')).toBe(c.poses.walkRight);
    expect(framesFor(c, 'petted')).toBe(c.poses.yay);
    expect(framesFor(c, 'sleep')).toBe(c.poses.idle);
    expect(framesFor(c, 'oops')).toBe(c.poses.idle);
    expect(framesFor(c, 'working')).toBe(c.poses.idle);
  });
  test('frames alternate by tick; one frame is static', () => {
    expect(frameAt(c, 'walkRight', 0)).toEqual(['(o)>', '/|\\ ']);
    expect(frameAt(c, 'walkRight', 1)).toEqual(['(o)>', '/ \\ ']);
    expect(frameAt(c, 'walkRight', 2)).toEqual(frameAt(c, 'walkRight', 0));
    expect(frameAt(c, 'idle', 5)).toEqual(frameAt(c, 'idle', 0));
  });
  test('normalizeFrames on an empty set is 1x1', () => {
    expect(normalizeFrames({})).toEqual({ poses: {}, width: 1, height: 1 });
  });
});

describe('the shipped characters', () => {
  const dir = new URL('../plugins/buddy/characters/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

  test('the directory holds the seven shipped characters', () => {
    expect(files).toEqual(['cat.json', 'dragon.json', 'duck.json', 'ghost.json', 'professor.json', 'robot.json', 'yellow-duck.json']);
  });

  test.each(files)('%s validates', (f) => {
    const v = validateCharacter(JSON.parse(readFileSync(new URL(f, dir), 'utf8')), f.replace(/\.json$/, ''));
    expect(v.ok || v.error).toBe(true);
  });
});

describe('the shipped duck', () => {
  test('has its own petted pose: same width as idle, ASCII, and a petted pool; it validates', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = JSON.parse(readFileSync(new URL('../plugins/buddy/characters/duck.json', import.meta.url), 'utf8'));
    const v = validateCharacter(raw);
    expect(v.ok ? 'valid' : v.error).toBe('valid');
    const frames: string[][] = raw.poses.petted;
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames.length).toBeLessThanOrEqual(2);
    const width = raw.poses.idle[0][0].length;
    for (const f of frames) {
      expect(f).toHaveLength(raw.poses.idle[0].length);
      for (const row of f) {
        expect(row).toHaveLength(width);
        expect(row).toMatch(/^[\x20-\x7e]+$/);
      }
    }
    expect(raw.lines.petted.length).toBeGreaterThan(0);
  });
});
