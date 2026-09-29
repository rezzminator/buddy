import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  CHAT_TURNS_TO_READ_DEFAULT, CHAT_TURNS_TO_READ_MAX, LINES_PER_TURN_MAX, TURN_ANSWER_HEAD, TURN_ANSWER_TAIL, TURN_PROMPT_HEAD, TURN_PROMPT_TAIL,
  NOTIFICATION_RESULT_HEAD, NOTIFICATION_RESULT_TAIL, cleanAnswer, cleanPrompt,
  BUDDY_PROMPT, NOTES_MAX, NOTE_MAX_CHARS, TAKEN_SUGGESTION, addCompaction, addExchange, addTurn, chatTurnsToReadOf, cleanNotes, didLine, ADDED_LABEL, memoryStats, render, storeKey, type Block, type Exchange,
  STORY_ADDED_HEAD, STORY_ADDED_TAIL, STORY_ANSWER_HEAD, STORY_ANSWER_TAIL, STORY_COMPACTION_HEAD, STORY_COMPACTION_TAIL, STORY_DID_STEPS, STORY_PROMPT_HEAD, STORY_PROMPT_TAIL,
} from '../plugins/buddy/src/chatTurnsToRead.ts';
import { DID_LINE_CAP, DID_TEXT_CAP, FAIL_REASON_CAP } from '../plugins/buddy/src/did.ts';

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
  test('a turn interrupted before any answer, then sent again as it was, is remembered once: the resend takes its place, keeping its steps and exchanges', () => {
    let b = addTurn([], 't0', turn('zero'), 4);
    b = addTurn(b, 't1', { prompt: 'fix the build', answer: '', did: ['Read the log'], interrupted: true }, 4);
    b = addExchange(b, 'cat', qa('what broke?', 'the linker'), 't1');
    b = addTurn(b, 't2', { prompt: 'fix the build', answer: 'Fixed.', did: ['Edit ld.conf'] }, 4);
    expect(b.map((x) => x.turnId)).toEqual(['t0', 't2']);
    expect(b[1]!.turn).toEqual({ prompt: 'fix the build', answer: 'Fixed.', did: ['Read the log', 'Edit ld.conf'] });
    expect(b[1]!.characters.cat).toEqual([qa('what broke?', 'the linker')]);
  });
  test('an interrupted turn stays its own when it answered something, when the next prompt differs, or when it came from elsewhere', () => {
    const cut = (answer: string) => addTurn([], 't1', { prompt: 'fix the build', answer, interrupted: true }, 4);
    expect(addTurn(cut('Half done.'), 't2', turn('fix the build'), 4).map((x) => x.turnId)).toEqual(['t1', 't2']);
    expect(addTurn(cut(''), 't2', turn('fix the tests'), 4).map((x) => x.turnId)).toEqual(['t1', 't2']);
    expect(addTurn(cut(''), 't2', { prompt: 'fix the build', answer: 'Done.', from: 'task-notification' }, 4).map((x) => x.turnId)).toEqual(['t1', 't2']);
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
  test('a failed step is kept whole, its reason past the step cap included; cut only past DID_LINE_CAP', () => {
    const failed = `${'z'.repeat(DID_TEXT_CAP - 1)}… (failed: ${'r'.repeat(FAIL_REASON_CAP)})`;
    expect(addTurn([], 't1', { prompt: 'go', answer: 'ok', did: [failed] }, 4)[0]!.turn!.did).toEqual([failed]);
    expect(addTurn([], 't1', { prompt: 'go', answer: 'ok', did: ['w'.repeat(300)] }, 4)[0]!.turn!.did).toEqual([`${'w'.repeat(DID_LINE_CAP - 1)}…`]);
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
  test("a turn the user sent with the buddy's own suggestion, unedited: filed as the buddy's words the user chose", () => {
    const b = addTurn([], 't1', { prompt: 'token saved, run the proof', answer: 'No file there.', from: TAKEN_SUGGESTION }, 4);
    expect(render(b, 'cat', 4)).toContain('Turn 1. The user sent Claude your own suggested prompt, unedited:\ntoken saved, run the proof\n');
  });
  test('a suggestion alone, a comment alone', () => {
    let b = addTurn([], 't1', turn('go'), 4);
    b = addExchange(b, 'cat', endOfTurn(undefined, 'run npm test'), 't1');
    expect(render(b, 'cat', 4)).toContain("- After this turn, you suggested the user's next prompt: run npm test");
    b = addExchange(addTurn([], 't1', turn('go'), 4), 'cat', endOfTurn('Tests pass.'), 't1');
    expect(render(b, 'cat', 4).endsWith('- After this turn, you commented: Tests pass.')).toBe(true);
  });
  test('a turn\'s end with a warning: the comment, the warning, the suggestion, in that order', () => {
    const b = addExchange(addTurn([], 't1', turn('go'), 4), 'cat', { kind: 'endOfTurn', commentAfterEachTurn: 'Shipped?', warned: 'no test ran', suggestNextPrompt: 'run the tests first' }, 't1');
    expect(render(b, 'cat', 4)).toContain(
      "- After this turn, you commented: Shipped?\n  With it, you warned the user: no test ran\n  With it, you suggested the user's next prompt: run the tests first",
    );
    const alone = addExchange(addTurn([], 't1', turn('go'), 4), 'cat', { kind: 'endOfTurn', warned: 'no test ran' }, 't1');
    expect(render(alone, 'cat', 4).endsWith('- After this turn, you warned the user: no test ran')).toBe(true);
  });
  test('a warning survives the store round trip; a malformed one drops the exchange', () => {
    const b = addExchange(addTurn([], 't1', turn('go'), 4), 'cat', { kind: 'endOfTurn', warned: 'no test ran' }, 't1');
    expect(chatTurnsToReadOf(JSON.parse(JSON.stringify({ blocks: b }))).blocks[0]!.characters.cat).toEqual([{ kind: 'endOfTurn', warned: 'no test ran' }]);
    const bad = [{ turnId: 't1', turn: { prompt: 'go', answer: 'Done.' }, characters: { cat: [{ kind: 'endOfTurn', warned: 7 }] } }];
    expect(chatTurnsToReadOf({ blocks: bad }).blocks[0]!.characters.cat).toEqual([]);
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
    expect(chatTurnsToReadOf(undefined)).toEqual({ blocks: [], notes: {} });
    let b = addExchange([], 'cat', line('Hi.'));
    b = addTurn(b, 't1', { prompt: 'one', answer: 'Done.', from: 'peer' }, 4);
    b = addExchange(b, 'cat', endOfTurn('ha', 'go'), 't1');
    expect(chatTurnsToReadOf({ at: 1, blocks: b })).toEqual({ blocks: b, notes: {} });
  });
  test('a malformed record says so and keeps what reads, never an empty timeline in silence', () => {
    expect(chatTurnsToReadOf('nope')).toEqual({ blocks: [], notes: {}, error: 'the stored chatTurnsToRead is not a chatTurnsToRead record' });
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
      notes: {},
      error: 'the stored chatTurnsToRead had 7 malformed entries, dropped',
    });
  });
  test('the notes: each character\'s own, cleaned, read back with the timeline; a character whose notes are not text is dropped and counted', () => {
    const b = addTurn([], 't1', turn('go'), 4);
    expect(chatTurnsToReadOf({ at: 1, blocks: b, notes: { cat: ['- Wants main safe.', 'Wants main safe.', '  ', 'x'.repeat(NOTE_MAX_CHARS + 1), '2) Tests before tags.'] } })).toEqual({ blocks: b, notes: { cat: ['Wants main safe.', 'Tests before tags.'] } });
    expect(chatTurnsToReadOf({ at: 1, blocks: b, notes: { cat: 'nope', duck: ['Quack.'] } })).toEqual({ blocks: b, notes: { duck: ['Quack.'] }, error: 'the stored chatTurnsToRead had 1 malformed entry, dropped' });
    expect(chatTurnsToReadOf({ at: 1, blocks: b, notes: ['x'] }).error).toBe('the stored chatTurnsToRead had 1 malformed entry, dropped');
  });
  test('cleanNotes keeps at most NOTES_MAX, the first ones', () => {
    expect(NOTES_MAX).toBe(8);
    expect(cleanNotes(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });
  test('cleanNotes past NOTES_MAX drops doubts first, then facts and untyped notes, then open items; a rule of the user goes last', () => {
    const notes = ['rule: r1', 'open: o1', 'fact: f1', 'doubt: d1', 'fact: f2', 'doubt: d2', 'plain', 'open: o2', 'rule: r2', 'fact: f3'];
    expect(cleanNotes(notes)).toEqual(['rule: r1', 'open: o1', 'fact: f1', 'fact: f2', 'plain', 'open: o2', 'rule: r2', 'fact: f3']);
    expect(cleanNotes([...Array.from({ length: 8 }, (_, i) => `fact: f${i}`), 'rule: kept'])).toEqual([...Array.from({ length: 7 }, (_, i) => `fact: f${i}`), 'rule: kept']);
  });
  test('the notes lead what the character remembers, before its timeline; notes alone still render', () => {
    const b = addTurn([], 't1', turn('go'), 4);
    expect(render(b, 'cat', 4, ['Wants main safe.', 'Tests before tags.']).startsWith(
      'Your own notes on this chat, which you keep and rewrite yourself:\n- Wants main safe.\n- Tests before tags.\n\nWhat you remember, oldest first:',
    )).toBe(true);
    expect(render([], 'cat', 4, ['Wants main safe.'])).toBe('Your own notes on this chat, which you keep and rewrite yourself:\n- Wants main safe.');
    expect(render(b, 'cat', 4)).not.toContain('Your own notes');
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
});

describe("a turn's numbers", () => {
  const stats = { ms: 134_000, requests: 2, tools: { Bash: 2 }, model: 'claude-opus-5', effort: 'low' };
  test('kept with the turn, read back from the file, and said under what Claude did, by the last turn only; the model again only when it changed', () => {
    let b = addTurn([], 't1', { prompt: 'one', answer: 'One.', did: ['ran ls'], stats }, 4, 1);
    b = addTurn(b, 't2', { prompt: 'two', answer: 'Two.', stats: { ...stats, ms: 3_000 } }, 4, 2);
    b = addTurn(b, 't3', { prompt: 'three', answer: 'Three.', stats: { ms: 1_000, requests: 1, model: 'claude-sonnet-5' } }, 4, 3);
    const back = chatTurnsToReadOf(JSON.parse(JSON.stringify({ blocks: b }))).blocks;
    expect(back).toEqual(b);
    // Only the last turn says its numbers (the story form): each turn's are read here as the last one's.
    expect(render(back.slice(0, 1), 'cat', 4)).toContain('Turn 1. The user asked Claude:\none\nClaude did: ran ls\nNumbers: 2m14s · 2 model requests · 2 tool calls (Bash 2) · on opus-5 at low effort\nClaude answered:\nOne.');
    expect(render(back.slice(0, 2), 'cat', 4)).toContain('Turn 2. The user asked Claude:\ntwo\nNumbers: 3s · 2 model requests · 2 tool calls (Bash 2)\nClaude answered:');
    const r = render(back, 'cat', 4);
    expect(r).toContain('Turn 1. The user asked Claude:\none\nClaude did: ran ls\nClaude answered:\nOne.');
    expect(r).toContain('Turn 3. The user asked Claude:\nthree\nNumbers: 1s · 1 model request · on sonnet-5\nClaude answered:');
  });
  test('a turn whose stored numbers are malformed is dropped, as one with malformed steps is; a turn kept before the numbers has none', () => {
    const b = [{ turnId: 't1', turn: { prompt: 'p', answer: 'a', stats: { ms: 'slow' } }, characters: {} }, { turnId: 't2', turn: { prompt: 'q', answer: 'b' }, characters: {} }];
    const back = chatTurnsToReadOf({ blocks: b }).blocks;
    expect(back.map((x) => x.turnId)).toEqual(['t2']);
    expect(render(back, 'cat', 4)).not.toContain('Numbers:');
  });
});


describe("the buddy's own prompt to the main chat, remembered", () => {
  test('filed with the turn\'s end, next to the suggestion, and kept through the store', () => {
    const b = addExchange(addTurn([], 't1', { prompt: 'go', answer: 'Tests pass.' }, 4), 'cat', { kind: 'endOfTurn', commentAfterEachTurn: 'Did they?', promptToMainChat: 'run the tests and show the output', suggestNextPrompt: 'commit it' }, 't1');
    expect(render(b, 'cat', 4)).toContain(
      "- After this turn, you commented: Did they?\n  With it, you sent Claude this prompt yourself: run the tests and show the output\n  With it, you suggested the user's next prompt: commit it",
    );
    const alone = addExchange(addTurn([], 't1', { prompt: 'go', answer: 'Tests pass.' }, 4), 'cat', { kind: 'endOfTurn', promptToMainChat: 'run the tests' }, 't1');
    expect(render(alone, 'cat', 4).endsWith('- After this turn, you sent Claude this prompt yourself: run the tests')).toBe(true);
    expect(chatTurnsToReadOf(JSON.parse(JSON.stringify({ blocks: b }))).blocks).toEqual(b);
    expect(chatTurnsToReadOf({ blocks: [{ ...b[0], characters: { cat: [{ kind: 'endOfTurn', promptToMainChat: 7 }] } }] }).blocks[0]!.characters.cat ?? []).toEqual([]);
  });
  test('the turn it started is labelled as the buddy\'s own', () => {
    const b = addTurn([], 't2', { prompt: 'run the tests and show the output', answer: 'Ran them: 2 fail.', from: BUDDY_PROMPT }, 4);
    expect(render(b, 'cat', 4)).toContain('Turn 1. From the buddy (you), sent to Claude:\nrun the tests and show the output\n');
  });
});

describe('a task notification keeps its report', () => {
  const note = (inner: string) => `<task-notification>\n<task-id>a1</task-id>\n${inner}\n</task-notification>`;
  test('its summary, then its result, the result\'s tags stripped like any prompt\'s, one-spaced', () => {
    expect(cleanPrompt(note('<status>completed</status>\n<summary>Agent "Map the store" completed</summary>\n<result>Found <b>3</b> writers.\n\nAll in <code>store.ts</code>.<system-reminder>rules</system-reminder></result>'))).toBe('Agent "Map the store" completed Its report: Found 3 writers. All in store.ts .');
    const blocks = addTurn([], 't1', { prompt: note('<status>completed</status><summary>Agent done</summary><result>The report.</result>'), answer: 'Read it.' }, 4);
    expect(render(chatTurnsToReadOf(JSON.parse(JSON.stringify({ at: 1, blocks }))).blocks, 'fixy', 4)).toContain('Agent done Its report: The report.');
  });
  test('a long result is cut to its start and end', () => {
    expect([NOTIFICATION_RESULT_HEAD, NOTIFICATION_RESULT_TAIL]).toEqual([1200, 400]);
    const result = 'H'.repeat(3000) + 'T'.repeat(2000);
    expect(cleanPrompt(note(`<status>completed</status><summary>done</summary><result>${result}</result>`))).toBe(`done Its report: ${'H'.repeat(NOTIFICATION_RESULT_HEAD)} … ${'T'.repeat(NOTIFICATION_RESULT_TAIL)}`);
  });
  test('a status other than completed is shown', () => {
    expect(cleanPrompt(note('<status>failed</status><summary>Agent "Fix it" failed</summary><result>It threw.</result>'))).toBe('Agent "Fix it" failed (status: failed) Its report: It threw.');
  });
  test('a completed notification without a result is its summary, as before', () => {
    expect(cleanPrompt(note('<status>completed</status>\n<summary>Background command "Run the proofs" completed (exit code 0)</summary>'))).toBe('Background command "Run the proofs" completed (exit code 0)');
  });
});

describe('an interrupted turn', () => {
  test('its answer is said to be what Claude answered before the user interrupted, empty or not', () => {
    const blocks = addTurn([], 't1', { prompt: 'refactor it', answer: 'Starting on the', interrupted: true }, 4);
    const r = render(blocks, 'fixy', 4);
    expect(r).toContain('Claude answered, before the user interrupted the turn:\nStarting on the');
    expect(r).not.toContain('Claude answered:');
    expect(render(addTurn([], 't2', { prompt: 'go', answer: '', interrupted: true }, 4), 'fixy', 4)).toContain('Claude answered, before the user interrupted the turn:\n(no text)');
  });
  test('kept through the store; false is no interruption, a non-boolean malformed, an older record without it still reads', () => {
    const blocks = addTurn([], 't1', { prompt: 'refactor it', answer: 'Starting', interrupted: true }, 4);
    const back = chatTurnsToReadOf(JSON.parse(JSON.stringify({ at: 1, blocks })));
    expect(back.error).toBeUndefined();
    expect(back.blocks[0]!.turn).toMatchObject({ prompt: 'refactor it', answer: 'Starting', interrupted: true });
    const stored = (interrupted: unknown) => ({ at: 1, blocks: [{ turnId: 't1', turn: { prompt: 'p', answer: 'a', interrupted }, characters: {} }] });
    const off = chatTurnsToReadOf(stored(false));
    expect(off.error).toBeUndefined();
    expect(off.blocks[0]!.turn).toEqual({ prompt: 'p', answer: 'a' });
    const bad = chatTurnsToReadOf(stored('yes'));
    expect(bad.error).toMatch(/1 malformed entry/);
    expect(bad.blocks).toEqual([]);
    const old = chatTurnsToReadOf({ at: 1, blocks: [{ turnId: 't1', turn: { prompt: 'p', answer: 'a' }, characters: {} }] });
    expect(old.error).toBeUndefined();
    expect(old.blocks[0]!.turn).toEqual({ prompt: 'p', answer: 'a' });
  });
});

describe('prompts the user added while Claude worked', () => {
  const ADDED = 'The user added while Claude worked:';
  test('said right after the prompt, one line each, before the steps and the answer', () => {
    const blocks = addTurn([], 't1', { prompt: 'fix it', answer: 'Done.', did: ['edited a.ts'], added: ['also run the tests', 'and lint'] }, 4);
    expect(render(blocks, 'fixy', 4)).toContain(`Turn 1. The user asked Claude:\nfix it\n${ADDED} also run the tests\n${ADDED} and lint\nClaude did: edited a.ts\nClaude answered:\nDone.`);
  });
  test('the same on an interrupted turn and on one not the user\'s', () => {
    const r = render(addTurn([], 't1', { prompt: 'go', answer: '', from: 'peer', interrupted: true, added: ['stop that'] }, 4), 'fixy', 4);
    expect(r).toContain(`Claude was sent, not by the user (peer):\ngo\n${ADDED} stop that\nClaude answered, before the user interrupted the turn:`);
  });
  test('each cut like the prompt, empty ones gone, at most 3 kept: the newest; none is no field', () => {
    const long = `${'h'.repeat(TURN_PROMPT_HEAD)}${'m'.repeat(500)}${'t'.repeat(TURN_PROMPT_TAIL)}`;
    const cut = addTurn([], 'x', { prompt: long, answer: '' }, 4)[0]!.turn!.prompt;
    const turn = addTurn([], 't1', { prompt: 'p', answer: 'a', added: ['a1', 'a2', '<system-reminder>x</system-reminder>', 'a3', long] }, 4)[0]!.turn!;
    expect(turn.added).toEqual(['a2', 'a3', cut]);
    expect(addTurn([], 't1', { prompt: 'p', answer: 'a', added: [] }, 4)[0]!.turn).not.toHaveProperty('added');
  });
  test('kept through the store; a non-list or a non-text entry is malformed; an older record without it still reads', () => {
    const blocks = addTurn([], 't1', { prompt: 'p', answer: 'a', added: ['also BANANA'] }, 4);
    const back = chatTurnsToReadOf(JSON.parse(JSON.stringify({ at: 1, blocks })));
    expect(back.error).toBeUndefined();
    expect(back.blocks[0]!.turn).toEqual({ prompt: 'p', answer: 'a', added: ['also BANANA'] });
    const stored = (added: unknown) => ({ at: 1, blocks: [{ turnId: 't1', turn: { prompt: 'p', answer: 'a', added }, characters: {} }] });
    for (const bad of ['also', ['ok', 3]]) {
      const r = chatTurnsToReadOf(stored(bad));
      expect(r.error).toMatch(/1 malformed entry/);
      expect(r.blocks).toEqual([]);
    }
    expect(chatTurnsToReadOf({ at: 1, blocks: [{ turnId: 't1', turn: { prompt: 'p', answer: 'a' }, characters: {} }] }).blocks[0]!.turn).toEqual({ prompt: 'p', answer: 'a' });
  });
});

describe('the story form: every remembered turn but the last, cut to what steers', () => {
  const words = (tag: string, n: number): string => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ');
  const failed = { ms: 5_000, requests: 2, tools: { Bash: 3 }, failed: 2 };
  /** A turnless block, a long turn, a long compaction, a short turn of another origin, and a long last turn, each with the cat's exchanges. */
  function story(): Block[] {
    let b = addExchange([], 'cat', line('Hi before.'));
    b = addTurn(b, 't1', { prompt: words('ask', 200), answer: `${words('first', 80)}\n${words('mid', 80)}\n${words('end', 80)}`, added: [words('also', 120)], did: ['read a.ts, b.ts', 'ran the tests', 'edited a.ts', 'ran lint'], stats: failed }, 5);
    b = addExchange(b, 'cat', line('Meow, tests.'));
    b = addExchange(b, 'cat', { kind: 'endOfTurn', commentAfterEachTurn: 'Nice run.', suggestNextPrompt: 'run npm test' });
    b = addExchange(b, 'cat', qa('why?', 'Because.\nIt was due.'));
    b = addCompaction(b, 'compaction:1', `${words('sum', 300)}\n${words('next', 100)}`, 5);
    b = addExchange(b, 'cat', line('Squashed.'));
    b = addExchange(b, 'cat', endOfTurn('Compacted well.'));
    b = addTurn(b, 't3', { prompt: 'fix it', answer: 'Stopped.', from: 'peer', interrupted: true, did: ['a', 'b', 'c', 'd', '… 5 more', 'x'], stats: { ms: 1_000, requests: 1, tools: { Read: 1 }, failed: 1 } }, 5);
    b = addExchange(b, 'cat', line('Hmm.'));
    b = addTurn(b, 't4', { prompt: words('last', 200), answer: `${words('fin', 150)}\n${words('done', 150)}`, added: [words('more', 120)], did: ['ran it'], stats: failed }, 5);
    return addExchange(b, 'cat', line('Last word.'));
  }

  test("an older turn renders as the benched reference's story form of today's rendering (fixtures/story-form.txt)", () => {
    expect(render(story(), 'cat', 5, ['fact: note one'])).toBe(readFileSync(new URL('./fixtures/story-form.txt', import.meta.url), 'utf8'));
  });
  test('the last turn stays as rendered before: prompt, added, steps, numbers and answer whole', () => {
    expect(render(story(), 'cat', 5).endsWith(
      `Turn 4. The user asked Claude:\n${words('last', 200)}\n${ADDED_LABEL} ${words('more', 120)}\nClaude did: ran it\nNumbers: 5s · 2 model requests · 3 tool calls (Bash 3), 2 failed\nClaude answered:\n${words('fin', 150)}\n${words('done', 150)}\n- You said: Last word.`,
    )).toBe(true);
  });
  test("an older turn's prompt, added line and answer cut to their start and end; its numbers gone, its failed calls counted", () => {
    const r = render(story(), 'cat', 5);
    const ask = words('ask', 200);
    expect(r).toContain(`Turn 1. The user asked Claude:\n${ask.slice(0, STORY_PROMPT_HEAD)} … ${ask.slice(-STORY_PROMPT_TAIL)}\n`);
    const added = `${ADDED_LABEL} ${words('also', 120)}`;
    expect(r).toContain(`\n${added.slice(0, STORY_ADDED_HEAD)} … ${added.slice(-STORY_ADDED_TAIL)}\n`);
    const answer = `${words('first', 80)}\n${words('mid', 80)}\n${words('end', 80)}`;
    expect(r).toContain(`Claude answered:\n${answer.slice(0, STORY_ANSWER_HEAD)} … ${answer.slice(-STORY_ANSWER_TAIL)}\n- You said: Meow, tests.`);
    expect(r).toContain('Claude did: read a.ts, b.ts; ran the tests; edited a.ts; ran lint\n2 tool calls failed.\nClaude answered:');
    expect(r).toContain('Claude did: a; b; c; d; … 5 more; x\n1 tool call failed.\nClaude answered, before the user interrupted the turn:');
    expect(r.match(/^Numbers: /gm)).toHaveLength(1);
  });
  test('no failed call, no failed line; a failed test run is not a failed tool call', () => {
    let b = addTurn([], 't1', { prompt: 'one', answer: 'One.', stats: { ms: 1_000, requests: 1, tools: { Bash: 1 }, tests: { passed: 1, failed: 2 } } }, 4);
    b = addTurn(b, 't2', { prompt: 'two', answer: 'Two.' }, 4);
    expect(render(b, 'cat', 4)).toContain('Turn 1. The user asked Claude:\none\nClaude answered:\nOne.\n\nTurn 2.');
  });
  test("an older turn keeps the buddy's exchanges whole and in order, its canned lines too", () => {
    expect(render(story(), 'cat', 5)).toContain("- You said: Meow, tests.\n- After this turn, you commented: Nice run.\n  With it, you suggested the user's next prompt: run npm test\n- The user asked you: why?\n  You answered: Because.\n    It was due.\n\nTurn 2.");
    expect(render(story(), 'cat', 5)).toContain('Stopped.\n- You said: Hmm.\n\nTurn 4.');
  });
  test('a compaction not last: its summary and exchanges, canned lines gone, cut to their start and end; a compaction last stays whole', () => {
    const body = `${words('sum', 300)}\n${words('next', 100)}\n- After this turn, you commented: Compacted well.`;
    expect(render(story(), 'cat', 5)).toContain(`Turn 2. The main chat was compacted: Claude now holds only this summary of everything before it:\n${body.slice(0, STORY_COMPACTION_HEAD)} … ${body.slice(-STORY_COMPACTION_TAIL)}\n\nTurn 3.`);
    let b = addTurn([], 't1', turn('one'), 4);
    b = addCompaction(b, 'compaction:1', words('sum', 400), 4);
    b = addExchange(b, 'cat', line('Squashed.'));
    expect(render(b, 'cat', 4).endsWith(`everything before it:\n${words('sum', 400)}\n- You said: Squashed.`)).toBe(true);
  });
  test('didLine: null keeps the steps as the last turn says them; a number names that many and counts them all', () => {
    const did = ['a', 'b', 'c', 'd', '… 5 more', 'x'];
    expect(didLine(did, null)).toBe('Claude did: a; b; c; d; … 5 more; x');
    expect(didLine(did, 2)).toBe('Claude did 10 steps: a; b; …');
    expect(didLine(['a', 'b'], 2)).toBe('Claude did 2 steps: a; b');
    expect(didLine(['one'], 2)).toBe('Claude did 1 step: one');
    expect(didLine(did)).toBe(didLine(did, STORY_DID_STEPS));
  });
});
