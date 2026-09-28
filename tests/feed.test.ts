import { describe, expect, test } from 'vitest';
import {
  DEFAULT_BG, answerSuggestions, feedOfMemory, markRead, mix, packCells, pruneToMemory, pushEntry, rgbOf, seconds, shimmerRule, short, statsOf, wrapText,
  type FeedEntry,
} from '../plugins/buddy/src/feed.ts';

const at = 1_000;

describe('the feed', () => {
  test('an entry is numbered after the last, its text whole but for the blank space around it', () => {
    const one = pushEntry([], { at, kind: 'ask', text: '  hi  ' });
    expect(one).toEqual([{ id: 1, at, kind: 'ask', text: 'hi' }]);
    expect(pushEntry(one, { at, kind: 'answer', text: `${'x'.repeat(5000)}\nmore`, who: 'Quack' })[1]!.text).toBe(`${'x'.repeat(5000)}\nmore`);
    let f: FeedEntry[] = [];
    for (let i = 0; i < 500; i++) f = pushEntry(f, { at, kind: 'line', text: String(i) });
    expect(f).toHaveLength(500);
  });
  test('it spans what the buddy remembers: the last n turns it read, nothing before a /clear; a turn it never read stays inside', () => {
    let f: FeedEntry[] = [];
    const you = (id: string) => (f = pushEntry(f, { at, kind: 'you', text: id, turnId: id }));
    you('t1'); f = pushEntry(f, { at, kind: 'ask', text: 'q1' }); f = markRead(f, 't1', true);
    you('t2'); f = markRead(f, 't2', false);
    you('t3'); f = markRead(f, 't3', true);
    f = pushEntry(f, { at, kind: 'compact', text: 'summary', turnId: 'c1', read: true });
    expect(pruneToMemory(f, 3).map((e) => e.text)).toEqual(['t1', 'q1', 't2', 't3', 'summary']);
    expect(pruneToMemory(f, 2).map((e) => e.text)).toEqual(['t3', 'summary']);
    f = pushEntry(f, { at, kind: 'clear', text: '/clear' });
    f = pushEntry(f, { at, kind: 'ask', text: 'fresh' });
    expect(pruneToMemory(f, 4).map((e) => e.text)).toEqual(['/clear', 'fresh']);
  });
  test('drawn back from the memory: each turn or compaction, then what that character said after it', () => {
    const f = feedOfMemory([
      { characters: { cat: [{ kind: 'line', text: 'Hi.' }] } },
      { turnId: 't1', at: 7, turn: { prompt: 'Ship it', answer: 'Done.' }, characters: { cat: [{ kind: 'question', question: 'ok?', answer: 'yes' }, { kind: 'endOfTurn', commentAfterEachTurn: 'nice', suggestNextPrompt: 'run the tests' }], duck: [{ kind: 'line', text: 'Quack.' }] } },
      { turnId: 'compaction:1', turn: { prompt: '', answer: 'the summary', from: 'compaction' }, characters: {} },
      { turnId: 't2', turn: { prompt: 'run the tests', answer: 'Green.' }, characters: {} },
    ], 'cat', { who: 'Cat', color: 'red' }, 1);
    expect(f.map((e) => [e.kind, e.text, e.at])).toEqual([
      ['line', 'Hi.', 1], ['you', 'Ship it', 7], ['ask', 'ok?', 7], ['answer', 'yes', 7], ['comment', 'nice', 7], ['suggest', 'run the tests', 7], ['compact', 'the summary', 1], ['you', 'run the tests', 1],
    ]);
    expect(f.find((e) => e.kind === 'suggest')!.taken).toBe(true);
    expect(f.filter((e) => e.kind === 'you').every((e) => e.read === true)).toBe(true);
  });
  test('a prompt answers every open suggestion: taken when it is that suggestion, spacing and case aside; one answered stays', () => {
    let f = pushEntry([], { at, kind: 'suggest', text: 'Run  the tests' });
    f = answerSuggestions(f, ' run the tests');
    expect(f[0]!.taken).toBe(true);
    f = pushEntry(f, { at, kind: 'suggest', text: 'Ship it' });
    f = answerSuggestions(f, 'no, wait');
    expect(f.map((e) => e.taken)).toEqual([true, false]);
    expect(answerSuggestions(pushEntry([], { at, kind: 'suggest', text: 'a' }), '   ')[0]!.taken).toBe(false);
  });
  test('its stats: counts per kind, the suggestions taken, the mean call time, the tokens', () => {
    let f: FeedEntry[] = [];
    f = pushEntry(f, { at, kind: 'comment', text: 'c', ms: 1000, tokens: 500 });
    f = pushEntry(f, { at, kind: 'suggest', text: 's', taken: true });
    f = pushEntry(f, { at, kind: 'answer', text: 'a', ms: 3000, tokens: 250 });
    f = pushEntry(f, { at, kind: 'failed', text: 'timeout' });
    expect(statsOf(f)).toEqual({ comments: 1, answers: 1, asks: 0, suggestions: 1, taken: 1, failed: 1, avgMs: 2000, tokens: 750 });
    expect(statsOf([]).avgMs).toBeNull();
  });
});

describe('the words the panels draw', () => {
  test('short counts and seconds', () => {
    expect([short(950), short(1234), short(34_400), short(1_250_000)]).toEqual(['950', '1.2k', '34k', '1.3M']);
    expect([seconds(820), seconds(2345), seconds(41_200)]).toEqual(['820ms', '2.3s', '41s']);
  });
  test('wrapping breaks at spaces, cuts a word longer than a line, keeps line breaks', () => {
    expect(wrapText('the quick brown fox', 9)).toEqual(['the quick', 'brown fox']);
    expect(wrapText('abcdefghij xy', 4)).toEqual(['abcd', 'efgh', 'ij', 'xy']);
    expect(wrapText('a\n\nb', 5)).toEqual(['a', '', 'b']);
  });
});

describe('the Raster cells', () => {
  test('packed as little-endian u32 triplets in padded base64', () => {
    // RasterProps' own example: one orange full block on the default background.
    expect(packCells([['█', 0xff8800, DEFAULT_BG]])).toBe(Buffer.from(new Uint8Array(Uint32Array.of(0x2588, 0xff8800, DEFAULT_BG).buffer)).toString('base64'));
    const two = packCells([['a', 1, 2], ['b', 3, 4]]);
    expect(Buffer.from(two, 'base64').length).toBe(24);
  });
  test('inks as RGB, a hex color as itself, an unknown one gold; colors mixed', () => {
    expect(rgbOf('red')).toBe(0xe5534b);
    expect(rgbOf('#102030')).toBe(0x102030);
    expect(rgbOf('nope')).toBe(0xe0b341);
    expect(mix(0x000000, 0xffffff, 0.5)).toBe(0x808080);
  });
  test('a shimmer rule is as wide as asked, brightest at its phase', () => {
    const r = shimmerRule(10, 0x000000, 0xffffff, 0.5);
    expect(r).toHaveLength(10);
    expect(r[5]![1]).toBe(0xffffff);
    expect(r[0]![1]).toBe(0x000000);
  });
});
