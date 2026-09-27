import { describe, expect, test } from 'vitest';
import {
  REMEMBERED_EXCHANGES_TEXT_CAP, rememberedExchangesOf, capText, characterRememberedExchanges, addRememberedExchange, remember, render, staleKeys, storeKey, type RememberedExchanges, type Exchange,
} from '../plugins/buddy/src/rememberedExchanges.ts';

const qa = (question: string, answer?: string): Exchange => (answer === undefined ? { kind: 'question', question } : { kind: 'question', question, answer });
const line = (text: string): Exchange => ({ kind: 'line', text });
const commentAfterEachTurn = (text: string): Exchange => ({ kind: 'commentAfterEachTurn', text });

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
    const rememberedExchanges = addRememberedExchange({}, 'cat', qa('hello', 'meow'), 0);
    expect(characterRememberedExchanges(rememberedExchanges, 'cat', 0)).toEqual([]);
    expect(render(characterRememberedExchanges(rememberedExchanges, 'cat', 0), 'Cat')).toBe('');
  });
  test('each text is one line of at most 160 characters, the question and its answer each', () => {
    const [x] = remember([], qa('q'.repeat(200), `a\n${'b'.repeat(200)}`), 6);
    if (x?.kind !== 'question') throw new Error('not a question');
    expect(x.question).toHaveLength(REMEMBERED_EXCHANGES_TEXT_CAP);
    expect(x.question.endsWith('...')).toBe(true);
    expect(x.answer).toHaveLength(REMEMBERED_EXCHANGES_TEXT_CAP);
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
    expect(render([qa('remember pineapple', 'Pineapple, noted.'), commentAfterEachTurn('Tests pass.'), qa('still there?')], 'Cat')).toBe(
      'Recently (oldest first):\nYou: remember pineapple\nCat: Pineapple, noted.\nCat: Tests pass.\nYou: still there?',
    );
  });
  test('a suggestNextPrompt is labelled as one, never as a line said', () => {
    expect(render([qa('run the tests?', 'Go on.'), { kind: 'suggestNextPrompt', text: 'run npm test' }], 'Cat')).toBe(
      'Recently (oldest first):\nYou: run the tests?\nCat: Go on.\nCat suggested your next prompt: run npm test',
    );
  });
  test('empty is empty', () => {
    expect(render([], 'Cat')).toBe('');
  });
});

describe('per character', () => {
  test('a character reads only its own ring', () => {
    let rememberedExchanges: RememberedExchanges = {};
    rememberedExchanges = addRememberedExchange(rememberedExchanges, 'cat', qa('to the cat', 'Meow.'), 6);
    rememberedExchanges = addRememberedExchange(rememberedExchanges, 'duck', line('Quack.'), 6);
    expect(characterRememberedExchanges(rememberedExchanges, 'cat', 6)).toEqual([qa('to the cat', 'Meow.')]);
    expect(characterRememberedExchanges(rememberedExchanges, 'duck', 6)).toEqual([line('Quack.')]);
    expect(characterRememberedExchanges(rememberedExchanges, 'robot', 6)).toEqual([]);
    expect(render(characterRememberedExchanges(rememberedExchanges, 'duck', 6), 'Duck')).not.toContain('Meow');
  });
  test('a lowered n reads only the newest exchanges', () => {
    const rememberedExchanges = [line('1'), qa('2', 'two'), line('3')].reduce<RememberedExchanges>((b, x) => addRememberedExchange(b, 'cat', x, 6), {});
    expect(characterRememberedExchanges(rememberedExchanges, 'cat', 2)).toEqual([qa('2', 'two'), line('3')]);
  });
});

describe('the store', () => {
  test('a key per session', () => {
    expect(storeKey('abc')).toBe('rememberedExchanges:abc');
  });
  test('nothing stored is an empty rememberedExchanges; a stored rememberedExchanges reads back', () => {
    expect(rememberedExchangesOf(undefined)).toEqual({ rememberedExchanges: {} });
    expect(rememberedExchangesOf({ at: 1, characters: { cat: [qa('hi', 'meow'), qa('alone'), commentAfterEachTurn('ha')] } })).toEqual({ rememberedExchanges: { cat: [qa('hi', 'meow'), qa('alone'), commentAfterEachTurn('ha')] } });
  });
  test('a malformed record says so, never an empty rememberedExchanges in silence', () => {
    expect(rememberedExchangesOf('nope')).toEqual({ rememberedExchanges: {}, error: 'the stored rememberedExchanges is not a rememberedExchanges record' });
    // An entry of the old one-line shape is malformed now: no migration, and it is said.
    expect(rememberedExchangesOf({ at: 1, characters: { cat: [line('hi'), { who: 'you', kind: 'question', text: 'x' }, { kind: 'question', question: 'q', answer: 3 }], duck: 'x' } })).toEqual({
      rememberedExchanges: { cat: [line('hi')] },
      error: 'the stored rememberedExchanges had 3 malformed exchanges, dropped',
    });
  });
  test('a stored suggestNextPrompt reads back as a suggestNextPrompt, capped; one without text is dropped', () => {
    const long = 'x'.repeat(REMEMBERED_EXCHANGES_TEXT_CAP + 20);
    expect(rememberedExchangesOf({ at: 1, characters: { cat: [{ kind: 'suggestNextPrompt', text: 'run npm test' }, { kind: 'suggestNextPrompt', text: long }, { kind: 'suggestNextPrompt' }] } })).toEqual({
      rememberedExchanges: { cat: [{ kind: 'suggestNextPrompt', text: 'run npm test' }, { kind: 'suggestNextPrompt', text: capText(long) }] },
      error: 'the stored rememberedExchanges had 1 malformed exchange, dropped',
    });
  });
  test('old sessions: all but the newest kept', () => {
    expect(staleKeys([{ key: 'rememberedExchanges:a', at: 1 }, { key: 'rememberedExchanges:b', at: 3 }, { key: 'rememberedExchanges:c', at: 2 }], 2)).toEqual(['rememberedExchanges:a']);
  });
});
