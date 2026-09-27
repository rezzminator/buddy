import { describe, expect, test } from 'vitest';
import { validateCharacter, type Character } from '../plugins/buddy/src/character.ts';
import { CONFETTI_ROWS } from '../plugins/buddy/src/particles.ts';
import { BUBBLE_FRAME_ROWS, MOODS, bubbleWidth, buildScene, type Scene, type SceneInput } from '../plugins/buddy/src/scene.ts';
import { raw } from './fixtures.ts';

const v = validateCharacter(raw({ poses: { idle: [['(o)', '/|\\'], ['   ', '(o)']], walkRight: [['a'], ['b']] } }));
if (!v.ok) throw new Error(v.error);
const c: Character = v.character;
const base: SceneInput = { character: c, pose: 'idle', frame: 0, x: 10, cols: 100, maxRows: 10, bubble: null, confetti: null, sleeping: false, zTick: 0, stats: { pets: 2, questions: 1 } };
/** The effect rows as the text they draw. */
const textOf = (s: Scene): string[] => s.effects.map((segs) => segs.map((g) => ' '.repeat(g.pad) + g.text).join(''));

describe('buildScene', () => {
  test('draws the frame, padded and bottom-aligned, blank rows kept', () => {
    const s = buildScene(base)!;
    expect(s.rows).toEqual(['(o)', '/|\\']);
    expect(buildScene({ ...base, frame: 1 })!.rows).toEqual(['   ', '(o)']);
    expect(s).toMatchObject({ x: 10, rowX: 10, bubble: null, effects: [], color: 'yellow' });
  });
  test('the sprite hides below width + 2 columns', () => {
    expect(buildScene({ ...base, cols: c.width + 1 })).toBeNull();
    expect(buildScene({ ...base, cols: c.width + 2 })).not.toBeNull();
  });
  test('the bubble: min(60, cols - width - 4) wide, opening toward the free side', () => {
    expect(bubbleWidth(100, 3)).toBe(60);
    expect(bubbleWidth(50, 3)).toBe(43);
    const right = buildScene({ ...base, bubble: 'hi' })!;
    expect(right.bubble).toEqual({ text: 'hi', width: 60, side: 'right' });
    expect(right.x).toBe(10);
    const left = buildScene({ ...base, x: 80, bubble: 'hi' })!;
    expect(left.bubble?.side).toBe('left');
    expect(left).toMatchObject({ x: 80, rowX: 19 });
  });
  test('the bubble pushes the sprite so the row fits', () => {
    const s = buildScene({ ...base, x: 60, cols: 100, bubble: 'hi' })!;
    expect(s.bubble?.side).toBe('left');
    const r = buildScene({ ...base, x: 45, cols: 100, bubble: 'hi' })!;
    expect(r.bubble?.side).toBe('right');
    expect(r.x + c.width + 1 + 60).toBeLessThanOrEqual(99);
    const l = buildScene({ ...base, x: 55, cols: 80, bubble: 'hi' })!;
    expect(l.rowX).toBeGreaterThanOrEqual(0);
  });
  test('below 40 columns the bubble is drawn above him, full width and wrapped, never dropped', () => {
    const said = 'a monad is a monoid in the category of endofunctors';
    const s = buildScene({ ...base, x: 0, cols: 20, bubble: said })!;
    expect(s.bubble).toBeNull();
    const lines = textOf(s);
    expect(lines.join(' ')).toBe(said);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(19);
    expect(s.effects.length + c.height).toBeLessThanOrEqual(base.maxRows);
    expect(textOf(buildScene({ ...base, x: 0, cols: 39, bubble: 'hi' })!)).toEqual(['hi']);
  });
  test('too narrow for the sprite, a bubble still shows, alone', () => {
    expect(buildScene({ ...base, cols: c.width + 1 })).toBeNull();
    const s = buildScene({ ...base, cols: c.width + 1, bubble: 'no x' })!;
    expect(s).toMatchObject({ rows: [], bubble: null, card: null });
    expect(textOf(s).join('')).toBe('nox');
  });
  test('the bubble is cut to the rows the band has, ending in …', () => {
    const long = 'word '.repeat(48).trim();
    for (const [cols, maxRows] of [[40, 6], [44, 6], [80, 6], [100, 4], [30, 6], [30, 3]] as const) {
      const s = buildScene({ ...base, x: 0, cols, maxRows, bubble: long })!;
      const lines = s.bubble ? s.bubble.text.split('\n') : textOf(s);
      const height = s.effects.length + (s.bubble ? Math.max(c.height, lines.length + 2) : c.height);
      expect(height).toBeLessThanOrEqual(maxRows);
      expect(lines.at(-1)!.endsWith('…')).toBe(true);
      const inner = s.bubble ? s.bubble.width - 4 : cols - 1;
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(inner);
    }
    expect(buildScene({ ...base, bubble: 'hi' })!.bubble!.text).toBe('hi');
  });
  test('effects give way to a tall bubble: sprite, effects and bubble fit maxRows', () => {
    const long = 'word '.repeat(48).trim();
    const s = buildScene({ ...base, maxRows: 6, bubble: long, confetti: { seed: 3, tick: 4 } })!;
    expect(s.effects.length + Math.max(c.height, s.bubble!.text.split('\n').length + 2)).toBeLessThanOrEqual(6);
    expect(s.effects).toEqual([]);
    expect(buildScene({ ...base, maxRows: 6, bubble: 'yay', confetti: { seed: 3, tick: 4 } })!.effects).toHaveLength(CONFETTI_ROWS);
  });
  test('an ambiguous-wide terminal: the sprite measured in cells', () => {
    const eyes: Character = { ...c, poses: { idle: [['(×)', '/|\\']] } };
    expect(buildScene({ ...base, character: eyes })!.rows).toEqual(['(×)', '/|\\']);
    const s = buildScene({ ...base, character: eyes, ambiguousWide: true })!;
    expect(s.rows).toEqual(['(×)', '/|\\ ']);
    expect(s.card!.left).toBe(5);
    expect(buildScene({ ...base, character: eyes, cols: 50, bubble: 'hi', ambiguousWide: true })!.bubble!.width).toBe(42);
    expect(buildScene({ ...base, character: eyes, cols: 5 })).not.toBeNull();
    expect(buildScene({ ...base, character: eyes, cols: 5, ambiguousWide: true })).toBeNull();
  });
  test('confetti: 3 rows above him, skipped when narrow or short', () => {
    const s = buildScene({ ...base, confetti: { seed: 3, tick: 4 } })!;
    expect(s.effects).toHaveLength(CONFETTI_ROWS);
    expect(s.effects.flat().length).toBeGreaterThan(0);
    for (const g of s.effects.flat()) expect(g.pad).toBeGreaterThanOrEqual(0);
    expect(buildScene({ ...base, cols: 39, confetti: { seed: 3, tick: 4 } })!.effects).toEqual([]);
    expect(buildScene({ ...base, maxRows: c.height + 2, confetti: { seed: 3, tick: 4 } })!.effects).toEqual([]);
  });
  test('sleep: a z Z drift above him', () => {
    const a = buildScene({ ...base, sleeping: true, pose: 'sleep', zTick: 0 })!;
    const b = buildScene({ ...base, sleeping: true, pose: 'sleep', zTick: 1 })!;
    expect(a.effects).toHaveLength(1);
    expect(a.effects[0]![0]!.text).toBe('z Z');
    expect(b.effects[0]![0]!.text).toBe('Z z');
    expect(a.effects[0]![0]!.pad).not.toBe(b.effects[0]![0]!.pad);
  });
  test('the hover card: name, description, pets, questions, mood; away from the bubble', () => {
    const s = buildScene(base)!;
    expect(s.card?.lines).toEqual(['Fixy', 'A test fixture.', 'pets 2 | questions 1 | curious']);
    expect(s.card?.left).toBe(c.width + 1);
    const withBubble = buildScene({ ...base, x: 40, bubble: 'hi' })!;
    expect(withBubble.card!.left).toBeLessThan(0);
    expect(MOODS.sleep).toBe('asleep');
  });
});

describe('the band never draws past maxRows', () => {
  const tall = validateCharacter(raw({ poses: { idle: [['(o)', '/|\\', '/ \\', '^ ^']], walkRight: [['a'], ['b']] } }));
  if (!tall.ok) throw new Error(tall.error);
  const t: Character = tall.character;
  /** The rows the band draws: the effects above, then the sprite or the bubble beside it, whichever is taller. */
  const height = (s: Scene | null): number => {
    if (!s) return 0;
    const bubble = s.bubble ? s.bubble.text.split('\n').length + BUBBLE_FRAME_ROWS : 0;
    return s.effects.length + Math.max(s.rows.length, bubble);
  };
  const long = 'a long line that wraps over and over again in a narrow band';
  test.each([
    [30, 4, long],
    [30, 5, long],
    [80, 3, null],
    [80, 3, long],
    [80, 2, long],
    [80, 1, long],
    [30, 1, long],
    [30, 2, null],
  ])('cols %i, maxRows %i, bubble %j', (cols, maxRows, bubble) => {
    for (const confetti of [null, { seed: 1, tick: 0 }]) {
      const s = buildScene({ ...base, character: t, cols, maxRows, bubble, confetti, sleeping: true, x: 0 });
      expect(height(s)).toBeLessThanOrEqual(maxRows);
      if (bubble) expect(s && (s.bubble !== null || s.effects.length > 0)).toBe(true);
    }
  });
});
