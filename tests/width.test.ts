import { describe, expect, test } from 'vitest';
import { cellWidth, padEndCells, sliceCells, wrapCells } from '../plugins/buddy/src/width.ts';

const wide = { ambiguousCharacterWidth: 'wide' } as const;

describe('cellWidth', () => {
  test('ASCII: one cell a character, exactly .length', () => {
    for (const s of ['', 'a', 'Quack!', '(o)>', ' /|\\ ', 'pets 2 | questions 1 | curious']) {
      expect(cellWidth(s)).toBe(s.length);
      expect(cellWidth(s, wide)).toBe(s.length);
    }
  });
  test('East Asian Wide and Fullwidth: two cells on every terminal', () => {
    expect(cellWidth('漢字')).toBe(4);
    expect(cellWidth('こんにちは')).toBe(10);
    expect(cellWidth('한')).toBe(2);
    expect(cellWidth('ＡＢ')).toBe(4);
    expect(cellWidth('✨')).toBe(2);
    expect(cellWidth('🦆')).toBe(2);
    expect(cellWidth('漢', wide)).toBe(2);
  });
  test('East Asian Ambiguous: one cell by default, two on a CJK-ambiguous-wide terminal', () => {
    for (const ch of ['★', '█', '░', '×', '◉', '✦', '·', '°', '…']) {
      expect(cellWidth(ch)).toBe(1);
      expect(cellWidth(ch, wide)).toBe(2);
    }
    expect(cellWidth('SNARK     ████████░░ 81')).toBe(23);
    expect(cellWidth('SNARK     ████████░░ 81', wide)).toBe(33);
  });
  test('zero width: combining marks, joiners, variation selectors, controls', () => {
    expect(cellWidth('é')).toBe(1);
    expect(cellWidth('a‍b')).toBe(2);
    expect(cellWidth('x️')).toBe(1);
    expect(cellWidth('\u0007')).toBe(0);
  });
});

describe('padding and slicing by cells', () => {
  test('padEndCells pads to the cell width, never cuts', () => {
    expect(padEndCells('ab', 4)).toBe('ab  ');
    expect(padEndCells('(×)', 4)).toBe('(×) ');
    expect(padEndCells('(×)', 4, wide)).toBe('(×)');
    expect(padEndCells('abcdef', 3)).toBe('abcdef');
  });
  test('sliceCells keeps the longest prefix that fits', () => {
    expect(sliceCells('abc', 5)).toBe('abc');
    expect(sliceCells('abcdef', 3)).toBe('abc');
    expect(sliceCells('漢字x', 3)).toBe('漢');
    expect(sliceCells('★★★', 3, wide)).toBe('★');
  });
});

describe('wrapCells', () => {
  test('word wrap to the width, a word longer than a line broken inside it', () => {
    expect(wrapCells('hi', 10)).toEqual(['hi']);
    expect(wrapCells('the quick brown fox', 10)).toEqual(['the quick', 'brown fox']);
    expect(wrapCells('abcdefghijkl', 5)).toEqual(['abcde', 'fghij', 'kl']);
    expect(wrapCells('a\nb c', 10)).toEqual(['a', 'b c']);
  });
  test('cells, not characters: wide text wraps sooner', () => {
    expect(wrapCells('漢字漢字漢字', 5)).toEqual(['漢字', '漢字', '漢字']);
    expect(wrapCells('★★★ ★★', 6)).toEqual(['★★★ ★★']);
    expect(wrapCells('★★★ ★★', 6, wide)).toEqual(['★★★', '★★']);
  });
  test('at most maxLines, the last one cut with …', () => {
    expect(wrapCells('one two three four five', 9, { maxLines: 2 })).toEqual(['one two', 'three…']);
    expect(wrapCells('abcdefghij', 4, { maxLines: 1 })).toEqual(['abc…']);
    expect(wrapCells('abcdefghij', 4, { maxLines: 1, ambiguousCharacterWidth: 'wide' })).toEqual(['ab…']);
    const lines = wrapCells('word '.repeat(48).trim(), 21, { maxLines: 4 });
    expect(lines).toHaveLength(4);
    for (const l of lines) expect(cellWidth(l)).toBeLessThanOrEqual(21);
  });
});
