import { describe, expect, test } from 'vitest';
import {
  CHAT_TURNS_TO_READ_DEFAULT, CHAT_TURNS_TO_READ_MAX, LINES_PER_TURN_MAX, TURN_ANSWER_HEAD, TURN_ANSWER_TAIL, TURN_PROMPT_HEAD, TURN_PROMPT_TAIL,
  cleanAnswer, cleanPrompt,
  addCompaction, addExchange, addTurn, chatTurnsToReadOf, memoryStats, render, staleKeys, storeKey, type Block, type Exchange,
} from '../plugins/buddy/src/chatTurnsToRead.ts';

const qa = (question: string, answer?: string): Exchange => (answer === undefined ? { kind: 'question', question } : { kind: 'question', question, answer });
const line = (text: string): Exchange => ({ kind: 'line', text });
const endOfTurn = (commentAfterEachTurn?: string, suggestNextPrompt?: string): Exchange => ({
  kind: 'endOfTurn',
  ...(commentAfterEachTurn !== undefined ? { commentAfterEachTurn } : {}),
  ...(suggestNextPrompt !== undefined ? { suggestNextPrompt } : {}),
});
const turn = (prompt: string, answer = 'Done.') => ({ prompt, answer });
const H = 'What you remember, oldest first:';

describe('the timeline', () => {
  test('4 turns by default, at most 10', () => {
    expect(CHAT_TURNS_TO_READ_DEFAULT).toBe(4);
    expect(CHAT_TURNS_TO_READ_MAX).toBe(10);
  });
  test('the last n turns, oldest dropped first, and with each turn every exchange after it', () => {
    let b: Block[] = [];
    for (const id of ['t1', 't2', 't3']) {
      b = addTurn(b, id, turn(`ask ${id}`), 2);
      b = addExchange(b, 'cat', endOfTurn(`about ${id}`), id);
    }
    expect(b.map((x) => x.turnId)).toEqual(['t2', 't3']);
    // The buddy remembers of itself exactly as far back as of the chat: nothing about t1 is left.
    expect(JSON.stringify(b)).not.toContain('t1');
  });
  test('before any turn, exchanges go to a first turnless block, which goes once n turns follow it', () => {
    let b = addExchange([], 'cat', line('Hi.'));
    expect(b).toEqual([{ characters: { cat: [line('Hi.')] } }]);
    b = addTurn(b, 't1', turn('one'), 2);
    expect(b).toHaveLength(2);
    b = addTurn(b, 't2', turn('two'), 2);
    expect(b.map((x) => x.turnId)).toEqual(['t1', 't2']);
  });
  test('an exchange is filed under the turn it came after; one whose turn is gone is dropped', () => {
    let b = addTurn([], 't1', turn('one'), 4);
    b = addTurn(b, 't2', turn('two'), 4);
    b = addExchange(b, 'cat', qa('asked during two', 'ok'), 't1');
    expect(b[0]!.characters.cat).toEqual([qa('asked during two', 'ok')]);
    expect(b[1]!.characters.cat).toBeUndefined();
    expect(addExchange(b, 'cat', line('late'), 'gone')).toEqual(b);
    expect(addExchange([], 'cat', line('late'), 'gone')).toEqual([]);
    // No anchor: the newest block.
    expect(addExchange(b, 'cat', line('now'))[1]!.characters.cat).toEqual([line('now')]);
  });
  test('each character keeps its own exchanges: every question and end of turn, only the newest LINES_PER_TURN_MAX canned lines', () => {
    let b = addTurn([], 't1', turn('one'), 4);
    for (let i = 0; i < 25; i++) b = addExchange(b, 'cat', qa(`q${i}`, `a${i}`));
    for (let i = 0; i < LINES_PER_TURN_MAX + 2; i++) b = addExchange(b, 'cat', line(`l${i}`));
    b = addExchange(b, 'duck', line('Quack.'));
    const cat = b[0]!.characters.cat!;
    expect(cat.filter((x) => x.kind === 'question')).toHaveLength(25);
    expect(cat.filter((x) => x.kind === 'line')).toEqual([line('l2'), line('l3'), line('l4')]);
    expect(b[0]!.characters.duck).toEqual([line('Quack.')]);
  });
  test('an exchange is kept whole, its lines too; a turn is cut to the start and end of its prompt and answer', () => {
    const b = addExchange(addTurn([], 't1', turn(`START${'p'.repeat(TURN_PROMPT_HEAD + TURN_PROMPT_TAIL)}END`, `HEAD${'a'.repeat(TURN_ANSWER_HEAD + TURN_ANSWER_TAIL)}TAIL`), 4), 'cat', endOfTurn('c'.repeat(200), 's'.repeat(200)));
    const { prompt, answer } = b[0]!.turn!;
    expect(prompt.startsWith('START') && prompt.endsWith('END') && prompt.includes(' … ')).toBe(true);
    expect(prompt.length).toBe(TURN_PROMPT_HEAD + TURN_PROMPT_TAIL + 3);
    expect(answer.startsWith('HEAD') && answer.endsWith('TAIL')).toBe(true);
    expect(answer.length).toBe(TURN_ANSWER_HEAD + TURN_ANSWER_TAIL + 3);
    // Capping again keeps it as it is: a stored turn read back is not cut twice.
    expect(addTurn([], 't1', b[0]!.turn!, 4)[0]!.turn).toEqual(b[0]!.turn);
    const x = b[0]!.characters.cat![0]!;
    if (x.kind !== 'endOfTurn') throw new Error('not an endOfTurn');
    expect(x.commentAfterEachTurn).toBe('c'.repeat(200));
    expect(x.suggestNextPrompt).toBe('s'.repeat(200));
    const long = addExchange(addTurn([], 't1', turn('one'), 4), 'cat', qa('why?', `first line\nsecond ${'w'.repeat(3000)}`));
    expect(long[0]!.characters.cat).toEqual([qa('why?', `first line\nsecond ${'w'.repeat(3000)}`)]);
    // Every line of a long answer stays under its item.
    expect(render(long, 'cat', 4)).toContain(`  You answered: first line\n    second ${'w'.repeat(3000)}`);
  });
  test('a prompt without its markup: a task notification is its summary, a system reminder gone, tags dropped, text kept', () => {
    expect(cleanPrompt('<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "Run the proofs" completed (exit code 0)</summary>\n</task-notification>')).toBe('Background command "Run the proofs" completed (exit code 0)');
    expect(cleanPrompt('fix it<system-reminder>\nlong rules\n</system-reminder> now')).toBe('fix it now');
    expect(cleanPrompt('<pasted_content id="7c1e">\n  48 for 48\n</pasted_content id="7c1e">\nlook')).toBe('48 for 48 look');
    expect(cleanPrompt('is a < b and <b> bold?')).toBe('is a < b and bold?');
  });
  test('an answer without markdown noise: bold, heading marks, table rules and blank lines go; code and words stay', () => {
    expect(cleanAnswer('## Done\n\n**All** `npm test` passes.\n\n| a | b |\n|---|:--:|\n| 1 | 2 |')).toBe('Done\nAll `npm test` passes.\n| a | b |\n| 1 | 2 |');
  });
  test('what the turn did, kept with it, capped when read back', () => {
    const b = addTurn([], 't1', { prompt: 'go', answer: 'ok', did: ['Run the tests', 'edited a.ts'] }, 4);
    expect(b[0]!.turn!.did).toEqual(['Run the tests', 'edited a.ts']);
    expect(addTurn([], 't1', { prompt: 'go', answer: 'ok', did: [] }, 4)[0]!.turn).toEqual({ prompt: 'go', answer: 'ok' });
  });
  test('an exchange that says nothing is not one; an empty answer leaves the question alone', () => {
    const b = addTurn([], 't1', turn('one'), 4);
    expect(addExchange(b, 'cat', line('  \n '))).toEqual(b);
    expect(addExchange(b, 'cat', endOfTurn(' ', ' '))).toEqual(b);
    expect(addExchange(b, 'cat', qa(' ', 'x'))).toEqual(b);
    expect(addExchange(b, 'cat', qa('why?', ' '))[0]!.characters.cat).toEqual([qa('why?')]);
    expect(addExchange(b, 'cat', endOfTurn('Nice.', ' '))[0]!.characters.cat).toEqual([endOfTurn('Nice.')]);
  });
});

describe('render', () => {
  test('each turn, then what the character and the user said after it, addressed to the character as you', () => {
    let b = addExchange([], 'cat', line('Hi.'));
    b = addTurn(b, 't1', { prompt: 'fix the login bug', answer: 'Fixed it.', did: ['read auth.ts', 'Run the tests'] }, 4);
    b = addExchange(b, 'cat', endOfTurn('Tests pass, but the lockfile moved.', 'commit the lockfile'), 't1');
    b = addExchange(b, 'cat', qa('remember pineapple', 'Pineapple, noted.'), 't1');
    b = addTurn(b, 't2', turn('commit the lockfile', 'Committed.'), 4);
    b = addExchange(b, 'cat', qa('still there?'), 't2');
    expect(render(b, 'cat', 4)).toBe(
      [
        H,
        'Before those turns:\n- You said: Hi.',
        "Turn 1. The user asked Claude:\nfix the login bug\nClaude did: read auth.ts; Run the tests\nClaude answered:\nFixed it.\n- After this turn, you commented: Tests pass, but the lockfile moved.\n  With it, you suggested the user's next prompt: commit the lockfile\n- The user asked you: remember pineapple\n  You answered: Pineapple, noted.",
        'Turn 2. The user asked Claude:\ncommit the lockfile\nClaude answered:\nCommitted.\n- The user asked you: still there?\n  You gave no answer.',
      ].join('\n\n'),
    );
  });
  test('a suggestion alone, a comment alone', () => {
    let b = addTurn([], 't1', turn('go'), 4);
    b = addExchange(b, 'cat', endOfTurn(undefined, 'run npm test'), 't1');
    expect(render(b, 'cat', 4)).toContain("- After this turn, you suggested the user's next prompt: run npm test");
    b = addExchange(addTurn([], 't1', turn('go'), 4), 'cat', endOfTurn('Tests pass.'), 't1');
    expect(render(b, 'cat', 4).endsWith('- After this turn, you commented: Tests pass.')).toBe(true);
  });
  test('a prompt not the user\'s is never shown as the user\'s; an unknown one never said not to be; empty text marked', () => {
    let b = addTurn([], 't1', { prompt: 'ping', answer: '', from: 'peer' }, 4);
    b = addTurn(b, 't2', { prompt: '', answer: 'ok', from: 'unknown' }, 4);
    const r = render(b, 'cat', 4);
    expect(r).toContain('Turn 1. Claude was sent, not by the user (peer):\nping\nClaude answered:\n(no text)');
    expect(r).toContain('Turn 2. Claude was sent, from an unknown origin:\n(not seen)');
  });
  test('only the character\'s own exchanges; nothing is empty; a lowered n reads the newest', () => {
    let b = addTurn([], 't1', turn('one'), 4);
    b = addExchange(b, 'cat', qa('to the cat', 'Meow.'));
    expect(render(b, 'duck', 4)).not.toContain('Meow');
    expect(render(addExchange([], 'cat', line('Hi.')), 'duck', 4)).toBe('');
    expect(render(addExchange([], 'cat', line('Hi.')), 'cat', 4)).toBe(`${H}\n\nBefore any turn of the main chat:\n- You said: Hi.`);
    expect(render([], 'cat', 4)).toBe('');
    b = addTurn(b, 't2', turn('second ask'), 4);
    expect(render(b, 'cat', 1)).not.toMatch(/\bone\b|Meow/);
    expect(render(b, 'cat', 1)).toContain('Turn 1. The user asked Claude:\nsecond ask');
  });
});

describe('the store', () => {
  test('a key per session', () => {
    expect(storeKey('abc')).toBe('chatTurnsToRead:abc');
  });
  test('nothing stored is an empty timeline; a stored one reads back', () => {
    expect(chatTurnsToReadOf(undefined)).toEqual({ blocks: [] });
    let b = addExchange([], 'cat', line('Hi.'));
    b = addTurn(b, 't1', { prompt: 'one', answer: 'Done.', from: 'peer' }, 4);
    b = addExchange(b, 'cat', endOfTurn('ha', 'go'), 't1');
    expect(chatTurnsToReadOf({ at: 1, blocks: b })).toEqual({ blocks: b });
  });
  test('a malformed record says so and keeps what reads, never an empty timeline in silence', () => {
    expect(chatTurnsToReadOf('nope')).toEqual({ blocks: [], error: 'the stored chatTurnsToRead is not a chatTurnsToRead record' });
    // An older record's shape (`characters` at the top) is not this record: said, never read.
    expect(chatTurnsToReadOf({ at: 1, characters: { cat: [line('hi')] } }).error).toBe('the stored chatTurnsToRead is not a chatTurnsToRead record');
    const long = 'x'.repeat(500);
    expect(chatTurnsToReadOf({ at: 1, blocks: [
      { turnId: 't1', turn: { prompt: 'one', answer: 'Done.' }, characters: { cat: [endOfTurn(long), { kind: 'endOfTurn' }, { kind: 'suggestNextPrompt', text: 'old' }], duck: 'x' } },
      { characters: {} },
      { turn: { prompt: 'no id', answer: '' }, characters: {} },
      { turnId: 't2', turn: { prompt: 3, answer: '' }, characters: {} },
      { turnId: 't3', turn: { prompt: 'x', answer: '', did: 'nope' }, characters: {} },
    ] })).toEqual({
      blocks: [{ turnId: 't1', turn: { prompt: 'one', answer: 'Done.' }, characters: { cat: [endOfTurn(long)] } }],
      error: 'the stored chatTurnsToRead had 7 malformed entries, dropped',
    });
  });
  test('a compaction is a turn of its own: its summary what Claude holds, cut and counted like any turn', () => {
    let b = addTurn([], 't1', turn('one'), 2);
    b = addCompaction(b, 'compaction:1', 'We built the drawer. Next: tests.', 2, 5);
    expect(b[1]).toMatchObject({ turnId: 'compaction:1', at: 5, turn: { prompt: '', answer: 'We built the drawer. Next: tests.', from: 'compaction' } });
    expect(render(b, 'cat', 2)).toContain('Turn 2. The main chat was compacted: Claude now holds only this summary of everything before it:\nWe built the drawer. Next: tests.');
    b = addTurn(b, 't2', turn('two'), 2);
    expect(b.map((x) => x.turnId)).toEqual(['compaction:1', 't2']);
  });
  test("memoryStats: the turns a call hands over, their characters kept and before the cut", () => {
    const big = `A${'p'.repeat(TURN_PROMPT_HEAD + TURN_PROMPT_TAIL + 100)}`;
    const b = addTurn(addTurn([], 't1', turn('one', 'Done.'), 4), 't2', turn(big, 'ok'), 4);
    expect(memoryStats(b, 4)).toEqual({ turns: 2, kept: 3 + 5 + TURN_PROMPT_HEAD + TURN_PROMPT_TAIL + 3 + 2, full: 3 + 5 + big.length + 2 });
    expect(memoryStats(b, 1).turns).toBe(1);
    expect(memoryStats([], 4)).toEqual({ turns: 0, kept: 0, full: 0 });
  });
  test('old sessions: all but the newest kept', () => {
    expect(staleKeys([{ key: 'chatTurnsToRead:a', at: 1 }, { key: 'chatTurnsToRead:b', at: 3 }, { key: 'chatTurnsToRead:c', at: 2 }], 2)).toEqual(['chatTurnsToRead:a']);
  });
});
