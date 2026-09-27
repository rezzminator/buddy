import { describe, expect, test } from 'vitest';
import {
  MEMORY_TEXT_CAP, bookOf, capText, recall, record, remember, render, staleKeys, storeKey, type Book, type Exchange,
} from '../plugins/buddy/src/memory.ts';

const qa = (question: string, answer?: string): Exchange => (answer === undefined ? { kind: 'question', question } : { kind: 'question', question, answer });
const line = (text: string): Exchange => ({ kind: 'line', text });
const quip = (text: string): Exchange => ({ kind: 'quip', text });

describe('remember', () => {
  test('a ring of the last n exchanges, oldest dropped first', () => {
    let ring: Exchange[] = [];
    for (const t of ['one', 'two', 'three', 'four']) ring = remember(ring, line(t), 3);
    expect(ring).toEqual([line('two'), line('three'), line('four')]);
  });
  test('a question with its answer is one slot', () => {
    let ring: Exchange[] = [];
    ring = remember(ring, qa('q1', 'a1'), 2);
    ring = remember(ring, line('hi'), 2);
    ring = remember(ring, qa('q2', 'a2'), 2);
    expect(ring).toEqual([line('hi'), qa('q2', 'a2')]);
    expect(render(ring, 'Cat')).toBe('Recently (oldest first):\nCat: hi\nYou: q2\nCat: a2');
  });
  test('n = 0 records nothing and renders nothing', () => {
    expect(remember([line('kept?')], qa('no', 'no'), 0)).toEqual([]);
    const book = record({}, 'cat', qa('hello', 'meow'), 0);
    expect(recall(book, 'cat', 0)).toEqual([]);
    expect(render(recall(book, 'cat', 0), 'Cat')).toBe('');
  });
  test('each text is one line of at most 160 characters, the question and its answer each', () => {
    const [x] = remember([], qa('q'.repeat(200), `a\n${'b'.repeat(200)}`), 6);
    if (x?.kind !== 'question') throw new Error('not a question');
    expect(x.question).toHaveLength(MEMORY_TEXT_CAP);
    expect(x.question.endsWith('...')).toBe(true);
    expect(x.answer).toHaveLength(MEMORY_TEXT_CAP);
    expect(x.answer!.startsWith('a b')).toBe(true);
    expect(capText('y'.repeat(160))).toBe('y'.repeat(160));
  });
  test('an empty line or question is not an exchange; an empty answer leaves the question alone', () => {
    expect(remember([line('a')], line('  \n '), 6)).toEqual([line('a')]);
    expect(remember([], qa(' ', 'x'), 6)).toEqual([]);
    expect(remember([], qa('why?', ' '), 6)).toEqual([qa('why?')]);
  });
});

describe('render', () => {
  test('oldest first, You and the name; a question with no answer stands alone', () => {
    expect(render([qa('remember pineapple', 'Pineapple, noted.'), quip('Tests pass.'), qa('still there?')], 'Cat')).toBe(
      'Recently (oldest first):\nYou: remember pineapple\nCat: Pineapple, noted.\nCat: Tests pass.\nYou: still there?',
    );
  });
  test('a suggested next prompt is labelled as one, never as a line said', () => {
    expect(render([qa('run the tests?', 'Go on.'), { kind: 'suggestion', text: 'run npm test' }], 'Cat')).toBe(
      'Recently (oldest first):\nYou: run the tests?\nCat: Go on.\nCat suggested your next prompt: run npm test',
    );
  });
  test('empty is empty', () => {
    expect(render([], 'Cat')).toBe('');
  });
});

describe('per character', () => {
  test('a character recalls only its own ring', () => {
    let book: Book = {};
    book = record(book, 'cat', qa('to the cat', 'Meow.'), 6);
    book = record(book, 'duck', line('Quack.'), 6);
    expect(recall(book, 'cat', 6)).toEqual([qa('to the cat', 'Meow.')]);
    expect(recall(book, 'duck', 6)).toEqual([line('Quack.')]);
    expect(recall(book, 'robot', 6)).toEqual([]);
    expect(render(recall(book, 'duck', 6), 'Duck')).not.toContain('Meow');
  });
  test('a lowered n recalls only the newest exchanges', () => {
    const book = [line('1'), qa('2', 'two'), line('3')].reduce<Book>((b, x) => record(b, 'cat', x, 6), {});
    expect(recall(book, 'cat', 2)).toEqual([qa('2', 'two'), line('3')]);
  });
});

describe('the store', () => {
  test('a key per session', () => {
    expect(storeKey('abc')).toBe('memory:abc');
  });
  test('nothing stored is an empty book; a stored book reads back', () => {
    expect(bookOf(undefined)).toEqual({ book: {} });
    expect(bookOf({ at: 1, characters: { cat: [qa('hi', 'meow'), qa('alone'), quip('ha')] } })).toEqual({ book: { cat: [qa('hi', 'meow'), qa('alone'), quip('ha')] } });
  });
  test('a malformed record says so, never an empty book in silence', () => {
    expect(bookOf('nope')).toEqual({ book: {}, error: 'the stored memory is not a memory record' });
    // An entry of the old one-line shape is malformed now: no migration, and it is said.
    expect(bookOf({ at: 1, characters: { cat: [line('hi'), { who: 'you', kind: 'question', text: 'x' }, { kind: 'question', question: 'q', answer: 3 }], duck: 'x' } })).toEqual({
      book: { cat: [line('hi')] },
      error: 'the stored memory had 3 malformed exchanges, dropped',
    });
  });
  test('a stored suggestion reads back as a suggestion, capped; one without text is dropped', () => {
    const long = 'x'.repeat(MEMORY_TEXT_CAP + 20);
    expect(bookOf({ at: 1, characters: { cat: [{ kind: 'suggestion', text: 'run npm test' }, { kind: 'suggestion', text: long }, { kind: 'suggestion' }] } })).toEqual({
      book: { cat: [{ kind: 'suggestion', text: 'run npm test' }, { kind: 'suggestion', text: capText(long) }] },
      error: 'the stored memory had 1 malformed exchange, dropped',
    });
  });
  test('old sessions: all but the newest kept', () => {
    expect(staleKeys([{ key: 'memory:a', at: 1 }, { key: 'memory:b', at: 3 }, { key: 'memory:c', at: 2 }], 2)).toEqual(['memory:a']);
  });
});
