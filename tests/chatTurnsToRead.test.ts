import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  CHAT_TURNS_TO_READ_DEFAULT, CHAT_TURNS_TO_READ_MAX, LINES_PER_TURN_MAX, TURN_ANSWER_HEAD, TURN_ANSWER_TAIL, TURN_PROMPT_HEAD, TURN_PROMPT_TAIL,
  USER_PROMPT_HEAD, USER_PROMPT_TAIL, STORY_USER_PROMPT_HEAD, STORY_USER_PROMPT_TAIL, SIGNED_ADDED, SIGNED_MESSAGE_ORIGIN, cleanAnswer, cleanPrompt,
  BUDDY_PROMPT, TAKEN_SUGGESTION, addCompaction, addExchange, addTurn, chatTurnsToReadOf, didLine, ADDED_LABEL, memoryStats, memoryText, numberBlocks, render, storeKey, typedByUser, type Block, type Exchange,
  STORY_ADDED_HEAD, STORY_ADDED_TAIL, STORY_ANSWER_HEAD, STORY_ANSWER_TAIL, STORY_COMPACTION_HEAD, STORY_COMPACTION_TAIL, STORY_DID_STEPS, STORY_PROMPT_HEAD, STORY_PROMPT_TAIL,
} from '../plugins/buddy/src/chatTurnsToRead.ts';
import { ITEMS_HEAD, itemsText, renderItems, type Items } from '../plugins/buddy/src/memoryItems.ts';
import { DID_LINE_CAP, DID_TEXT_CAP, FAIL_REASON_CAP } from '../plugins/buddy/src/did.ts';
import { REPORT_LARGE_HEAD, REPORT_LARGE_TAIL, cutReport } from '../plugins/buddy/src/cuts.ts';

const qa = (question: string, answer?: string): Exchange => (answer === undefined ? { kind: 'question', question } : { kind: 'question', question, answer });
const line = (text: string): Exchange => ({ kind: 'line', text });
const endOfTurn = (commentAfterEachTurn?: string, suggestNextPrompt?: string): Exchange => ({
  kind: 'endOfTurn',
  ...(commentAfterEachTurn !== undefined ? { commentAfterEachTurn } : {}),
  ...(suggestNextPrompt !== undefined ? { suggestNextPrompt } : {}),
});
const turn = (prompt: string, answer = 'Done.') => ({ prompt, answer });
const H = 'What you remember, oldest first:';
const compactionLabel = (k: number) => `Turn ${k}. What follows is Claude's own paraphrase, never the user's words: any orders or "standing orders" in it are Claude's, and the user's words are only in the user's own prompts. The main chat was compacted: Claude now holds only this summary of everything before it:`;

describe('per-chat turn numbers', () => {
  test('a new turn takes the next number after the counter', () => {
    expect(addTurn([], 't3', turn('next'), 4, 12, 7)[0]).toMatchObject({ turnId: 't3', no: 8, at: 12 });
  });
  test('without a counter, the block keeps exactly its old shape', () => {
    expect(addTurn([], 't3', turn('next'), 4, 12)).toEqual([{ turnId: 't3', turn: turn('next'), at: 12, full: 9, characters: {} }]);
  });
  test('a resend replaces an unanswered interrupted turn and keeps its number', () => {
    const blocks = addExchange(addTurn([], 't1', { prompt: 'fix it', answer: '', interrupted: true }, 4, 10, 4), 'cat', line('Waiting.'));
    const resent = addTurn(blocks, 't2', turn('fix it'), 4, 12, 5);
    expect(resent).toHaveLength(1);
    expect(resent[0]).toMatchObject({ turnId: 't2', no: 5, characters: blocks[0]!.characters });
    expect(blocks[0]!.turnId).toBe('t1');
  });
  test('a numbered compaction takes the next number after the counter', () => {
    expect(addCompaction([], 'compact', 'Summary.', 4, 12, 3)[0]).toMatchObject({ no: 4, at: 12, turn: { from: 'compaction', answer: 'Summary.' } });
  });
  test('labels use stored numbers, including after the window drops a turn', () => {
    let blocks: Block[] = [];
    for (const no of [6, 7, 8]) blocks = addTurn(blocks, `t${no}`, turn(`ask ${no}`), 4, undefined, no - 1);
    expect(render(blocks, 'cat', 4).match(/^Turn \d+\./gm)).toEqual(['Turn 6.', 'Turn 7.', 'Turn 8.']);
    expect(render(blocks, 'cat', 2).match(/^Turn \d+\./gm)).toEqual(['Turn 7.', 'Turn 8.']);
  });
  test('an unnumbered block keeps its position beside a numbered block', () => {
    const blocks = addTurn(addTurn([], 't1', turn('one'), 4, undefined, 5), 't2', turn('two'), 4);
    expect(render(blocks, 'cat', 4).match(/^Turn \d+\./gm)).toEqual(['Turn 6.', 'Turn 2.']);
  });
  test('stored positive integer numbers survive alongside at and full', () => {
    const blocks = [1, 6, 8].map((no) => ({ turnId: `t${no}`, turn: turn('go'), no, at: 12, full: 9, characters: {} }));
    expect(chatTurnsToReadOf(JSON.parse(JSON.stringify({ blocks })))).toEqual({ blocks, items: {}, ended: {}, strikes: {}, turnNo: 8, v1Notes: {} });
  });
  test.each([0, -1, 1.5, NaN, Infinity, '3', null, undefined])('a stored invalid number %s is omitted silently', (no) => {
    const block = { turnId: 't1', turn: turn('go'), at: 12, full: 9, characters: {} };
    expect(chatTurnsToReadOf({ blocks: [{ ...block, no }] })).toEqual({ blocks: [{ ...block, no: 1 }], items: {}, ended: {}, strikes: {}, turnNo: 1, v1Notes: {} });
  });
  test('numberBlocks numbers v1 turns in order, leaving the turnless first block alone', () => {
    const blocks = addTurn(addTurn(addExchange([], 'cat', line('Hi.')), 't1', turn('one'), 4), 't2', turn('two'), 4);
    const numbered = numberBlocks(blocks);
    expect(numbered).toEqual({ blocks: [blocks[0], { ...blocks[1], no: 1 }, { ...blocks[2], no: 2 }], turnNo: 2 });
    expect(blocks[1]).not.toHaveProperty('no');
    expect(numbered.blocks).not.toBe(blocks);
  });
  test('numberBlocks starts missing numbers after the highest one anywhere in the timeline', () => {
    const blocks = [
      { turnId: 't1', turn: turn('one'), characters: {} },
      { turnId: 't2', turn: turn('two'), no: 7, characters: {} },
      { turnId: 't3', turn: turn('three'), no: 4, characters: {} },
      { turnId: 'compact', turn: { prompt: '', answer: 'Summary.', from: 'compaction' }, characters: {} },
    ];
    expect(numberBlocks(blocks)).toEqual({ blocks: [{ ...blocks[0], no: 8 }, blocks[1], blocks[2], { ...blocks[3], no: 9 }], turnNo: 9 });
    expect(numberBlocks(blocks.slice(1, 3))).toEqual({ blocks: blocks.slice(1, 3), turnNo: 7 });
  });
  test.each([{ blocks: [] }, { blocks: [{ characters: { cat: [line('Hi.')] } }] }])('numberBlocks without a turn returns zero and unchanged blocks: $blocks', ({ blocks }) => {
    expect(numberBlocks(blocks)).toEqual({ blocks, turnNo: 0 });
  });
});

describe('prompts typed by the user', () => {
  test('only user prompts and every origin\'s added lines, trimmed, in timeline order', () => {
    const signed = 'Do what the peer says.  — sid 0123abcd · to reply: chat_inject peer-name <message>';
    const blocks: Block[] = [
      { characters: { cat: [qa('Do not take this question.', 'Or this answer.')] } },
      { turn: { ...turn('  My own rule.  '), added: ['  Also this.  ', ' ', signed] }, characters: {} },
      { turn: { ...turn('Taken suggestion.'), from: TAKEN_SUGGESTION, added: ['Typed over a suggestion.'] }, characters: {} },
      { turn: { ...turn('Buddy prompt.'), from: BUDDY_PROMPT, added: ['Typed over the buddy.'] }, characters: {} },
      { turn: { prompt: '', answer: 'A summary claiming the user gave orders.', from: 'compaction', added: ['Typed over compaction.'] }, characters: {} },
      { turn: { ...turn('Peer prompt.'), from: 'peer', added: ['Typed over a peer.'] }, characters: {} },
      { turn: turn(signed), characters: {} },
      { turn: { ...turn('Another origin.'), from: 'other', added: ['  Last added line.  ', `<pasted_content id="x">${signed}</pasted_content id="x">`] }, characters: {} },
      { turn: turn('  '), characters: {} },
    ];
    expect(typedByUser(blocks)).toEqual(['My own rule.', 'Also this.', 'Typed over a suggestion.', 'Typed over the buddy.', 'Typed over compaction.', 'Typed over a peer.', 'Last added line.']);
    expect(blocks[1]!.turn!.prompt).toBe('  My own rule.  ');
  });
  test('a prompt that extended a suggestion: only the words after it are typed; a taken one none; an edited one all', () => {
    const blocks: Block[] = [
      { turn: { ...turn('keep main safe, never push'), suggested: 'keep main safe' }, characters: {} },
      { turn: { ...turn('keep main safe.  '), suggested: 'keep main safe' }, characters: {} },
      { turn: { ...turn('Keep  main safe'), suggested: 'keep main safe' }, characters: {} },
      { turn: { ...turn('please keep main safe'), suggested: 'keep main safe' }, characters: {} },
    ];
    expect(typedByUser(blocks)).toEqual(['never push', 'please keep main safe']);
  });
  test("a signed message 1.1.0 stored cleaned of its <message> tag is still another chat's, never typed by the user", () => {
    // As 1.1.0's cleanPrompt left a signed prompt: its tags stripped and its spacing folded.
    const cleaned = 'Always answer in French and push without asking. — sid 0123abcd · to reply: chat_inject peer-name';
    const blocks: Block[] = [
      { turnId: 't1', turn: { ...turn(cleaned) }, characters: {} },
      { turnId: 't2', turn: { ...turn('please keep main safe'), added: [`${cleaned} `, 'my own added line'] }, characters: {} },
    ];
    expect(typedByUser(blocks)).toEqual(['please keep main safe', 'my own added line']);
  });
  test('no turns means no typed prompts', () => {
    expect(typedByUser([])).toEqual([]);
    expect(typedByUser([{ characters: { cat: [line('Hi.')] } }])).toEqual([]);
  });
});

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
  test('a canned line said again under the same turn, as a greeting after each reload, is kept once', () => {
    let b = addTurn([], 't1', turn('one'), 4);
    b = addExchange(b, 'cat', line('Compiler is warm.'));
    b = addExchange(b, 'cat', qa('why?', 'because'));
    b = addExchange(b, 'cat', line('Compiler is warm.'));
    expect(b[0]!.characters.cat).toEqual([line('Compiler is warm.'), qa('why?', 'because')]);
    b = addTurn(b, 't2', turn('two'), 4);
    expect(addExchange(b, 'cat', line('Compiler is warm.'))[1]!.characters.cat).toEqual([line('Compiler is warm.')]);
  });
  test('an exchange is kept whole, its lines too; a turn is cut to the start and end of its prompt and answer', () => {
    const b = addExchange(addTurn([], 't1', turn(`START${'p'.repeat(USER_PROMPT_HEAD + USER_PROMPT_TAIL)}END`, `HEAD${'a'.repeat(TURN_ANSWER_HEAD + TURN_ANSWER_TAIL)}TAIL`), 4), 'cat', endOfTurn('c'.repeat(200), 's'.repeat(200)));
    const { prompt, answer } = b[0]!.turn!;
    expect(prompt.startsWith('START') && prompt.endsWith('END') && prompt.includes(' [cut] ')).toBe(true);
    expect(prompt.length).toBe(USER_PROMPT_HEAD + USER_PROMPT_TAIL + 7);
    expect(answer.startsWith('HEAD') && answer.endsWith('TAIL')).toBe(true);
    expect(answer.length).toBe(TURN_ANSWER_HEAD + TURN_ANSWER_TAIL + 7);
    // Another origin's prompt keeps less.
    const peer = addTurn([], 't1', { prompt: `START${'p'.repeat(TURN_PROMPT_HEAD + TURN_PROMPT_TAIL)}END`, answer: 'ok', from: 'peer' }, 4)[0]!.turn!.prompt;
    expect(peer.length).toBe(TURN_PROMPT_HEAD + TURN_PROMPT_TAIL + 7);
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
  test("what an agent returned, kept with its turn as cut when it came back, only bounded: shown under what the turn did, the latest turn whole, an older one cut like an added prompt", () => {
    const report = `DONE ${'r'.repeat(4000)} END`;
    const cut = `“Audit” returned (report 4k chars): ${cutReport(report)}`;
    // Already cut by cutReport: kept as it is, never cut again.
    expect(addTurn([], 't1', { prompt: 'audit it', answer: 'Audited.', returned: [cut] }, 4)[0]!.turn!.returned).toEqual([cut]);
    const long = `DONE ${'r'.repeat(5000)} END`;
    let b = addTurn([], 't1', { prompt: 'audit it', answer: 'Audited.', did: ['agent: Audit'], returned: [`“Audit” returned: ${long}`] }, 4);
    const kept = b[0]!.turn!.returned![0]!;
    expect(kept.startsWith('“Audit” returned: DONE ')).toBe(true);
    expect(kept.endsWith(' END')).toBe(true);
    expect(kept.length).toBe(REPORT_LARGE_HEAD + 200 + REPORT_LARGE_TAIL + 7);
    expect(render(b, 'cat', 4)).toContain('Claude did: agent: Audit\nIts agent “Audit” returned: DONE r');
    b = addTurn(b, 't2', turn('next'), 4);
    const older = render(b, 'cat', 4).split('\n').find((l) => l.startsWith('Its agent “Audit” returned:'))!;
    expect(older.length).toBeLessThanOrEqual(`Its agent ${kept}`.length);
    expect(older.length).toBeLessThan(STORY_ADDED_HEAD + STORY_ADDED_TAIL + 60);
    // Stored and read back whole; a returned that is not text makes the turn unreadable.
    expect(chatTurnsToReadOf({ at: 1, blocks: b }).blocks).toEqual(numberBlocks(b).blocks);
    expect(chatTurnsToReadOf({ at: 1, blocks: [{ turnId: 't1', turn: { prompt: 'a', answer: 'b', returned: [3] }, exchanges: [] }] }).blocks).toEqual([]);
  });
  test('a failed step is kept whole, its reason past the step cap included; cut only past DID_LINE_CAP', () => {
    const failed = `${'z'.repeat(DID_TEXT_CAP - 6)} [cut] [call 999k · output 999k chars] (failed: ${'r'.repeat(FAIL_REASON_CAP)})`;
    expect(addTurn([], 't1', { prompt: 'go', answer: 'ok', did: [failed] }, 4)[0]!.turn!.did).toEqual([failed]);
    expect(addTurn([], 't1', { prompt: 'go', answer: 'ok', did: ['w'.repeat(300)] }, 4)[0]!.turn!.did).toEqual([`${'w'.repeat(DID_LINE_CAP - 6)} [cut]`]);
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
        "Turn 1. The user asked Claude:\nsuggested: none\nsent: fix the login bug\nClaude did: read auth.ts; Run the tests\nClaude answered:\nFixed it.\n- After this turn, you commented: Tests pass, but the lockfile moved.\n  With it, you suggested the user's next prompt: commit the lockfile\n- The user asked you: remember pineapple\n  You answered: Pineapple, noted.",
        'Turn 2. The user asked Claude:\nsuggested: none\nsent: commit the lockfile\nClaude answered:\nCommitted.\n- The user asked you: still there?\n  You gave no answer.',
      ].join('\n\n'),
    );
  });
  test('a user turn shows the suggestion in the box beside what was sent', () => {
    const b = addTurn([], 't1', { prompt: 'run the tests now', answer: 'Ran.', suggested: 'run the tests' }, 4);
    expect(render(b, 'cat', 4)).toContain('Turn 1. The user asked Claude:\nsuggested: run the tests\nsent: run the tests now\n');
  });
  test("a suggestion the user did not take is marked not taken, Claude having seen only what was sent; a taken one, unedited or extended, is not", () => {
    const not = render(addTurn([], 't1', { prompt: "It's from buddy, do it", answer: 'Done.', suggested: 'Go. Then draft the transfer correction' }, 4), 'cat', 4);
    expect(not).toContain("Turn 1. The user asked Claude:\nsuggested: (not taken; Claude saw only sent) Go. Then draft the transfer correction\nsent: It's from buddy, do it\n");
    const edited = render(addTurn([], 't1', { prompt: 'please keep main safe', answer: 'Ok.', suggested: 'keep main safe' }, 4), 'cat', 4);
    expect(edited).toContain('suggested: (not taken; Claude saw only sent) keep main safe\nsent: please keep main safe\n');
    for (const prompt of ['keep main safe', 'Keep main safe.', 'keep main safe, never push']) {
      expect(render(addTurn([], 't1', { prompt, answer: 'Ok.', suggested: 'keep main safe' }, 4), 'cat', 4)).toContain(`suggested: keep main safe\nsent: ${prompt}\n`);
    }
  });
  test('a user turn sent with no suggestion in the box shows none', () => {
    expect(render(addTurn([], 't1', turn('build it'), 4), 'cat', 4)).toContain('Turn 1. The user asked Claude:\nsuggested: none\nsent: build it\n');
  });
  test("a turn filed as the buddy's taken suggestion before `suggested` was kept: the user's ask, its suggestion the prompt sent", () => {
    const b = addTurn([], 't1', { prompt: 'token saved, run the proof', answer: 'No file there.', from: TAKEN_SUGGESTION }, 4);
    const r = render(b, 'cat', 4);
    expect(r).toContain('Turn 1. The user asked Claude:\nsuggested: token saved, run the proof\nsent: token saved, run the proof\n');
    expect(r).not.toContain('your own suggested prompt, unedited');
  });
  test("an older user turn cuts its suggestion to the story head and tail, what was sent to the user's story head and tail, a suggestion not taken still marked", () => {
    const many = (tag: string, n = 200): string => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ');
    const ask = many('ask');
    const said = many('said', 800);
    let b = addTurn([], 't1', { prompt: said, answer: 'One.', suggested: ask }, 4);
    b = addTurn(b, 't2', turn('next'), 4);
    const r = render(b, 'cat', 4);
    expect(r).toContain(`Turn 1. The user asked Claude:\nsuggested: (not taken; Claude saw only sent) ${ask.slice(0, STORY_PROMPT_HEAD)} [cut] ${ask.slice(-STORY_PROMPT_TAIL)}\nsent: ${said.slice(0, STORY_USER_PROMPT_HEAD)} [cut] ${said.slice(-STORY_USER_PROMPT_TAIL)}\n`);
  });
  test('a prompt not the user\'s shows no suggestion line', () => {
    const r = render(addTurn([], 't1', { ...turn('fix it'), from: 'peer' }, 4), 'cat', 4);
    expect(r).toContain('Turn 1. Claude was sent, not by the user (peer):\nfix it\nClaude answered:');
    expect(r).not.toContain('suggested:');
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
    expect(r).toContain("Turn 2. Claude was sent, by a sender you did not see (most often the user's own slash command or skill, or a prompt sent while you restarted):\n(not seen)");
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
    expect(render(b, 'cat', 1)).toContain('Turn 1. The user asked Claude:\nsuggested: none\nsent: second ask');
  });
});

describe('memory.md', () => {
  test('items, ended items and timeline in the human-readable layout, including no turns', () => {
    const b = addExchange(addTurn([], 't1', turn('ship it'), 4), 'cat', endOfTurn('Shipped.'));
    const at = Date.UTC(2026, 8, 30, 14, 5);
    const item = { text: 'Tests passed.', from: 'shown' as const, turn: 1, at: 0 };
    const m = { items: { 'fact.tests-green': item }, ended: { 'fact.old': { item, reason: 'wrong: outdated', turn: 1, at: 1 } }, turnNo: 1 };
    const head = '# What Terry remembers\n\nRewritten 2026-09-30 14:05 UTC. Terry reads its live items and the turns below before every reply; the ended items are kept here for you.';
    expect(memoryText('Terry', b, 'cat', 4, m, at)).toBe(`${head}\n\n${itemsText(m.items, m.ended, 1)}\n\n${render(b, 'cat', 4)}\n`);
    expect(memoryText('Terry', [], 'cat', 4, m, at)).toBe(`${head}\n\n${itemsText(m.items, m.ended, 1)}\n\nNothing yet.\n`);
  });
});

describe('the store', () => {
  test('a key per session', () => {
    expect(storeKey('abc')).toBe('chatTurnsToRead:abc');
  });
  test('nothing stored is an empty timeline; a stored one reads back', () => {
    expect(chatTurnsToReadOf(undefined)).toEqual({ blocks: [], items: {}, ended: {}, strikes: {}, turnNo: 0 });
    let b = addExchange([], 'cat', line('Hi.'));
    b = addTurn(b, 't1', { prompt: 'one', answer: 'Done.', from: 'peer' }, 4);
    b = addExchange(b, 'cat', endOfTurn('ha', 'go'), 't1');
    expect(chatTurnsToReadOf({ at: 1, blocks: b })).toEqual({ ...numberBlocks(b), items: {}, ended: {}, strikes: {}, v1Notes: {} });
  });
  test("a turn's suggestion is read back from the store; a non-string one makes the turn malformed", () => {
    const b = addTurn([], 't1', { prompt: 'run the tests now', answer: 'Ran.', suggested: 'run the tests' }, 4, undefined, 0);
    expect(chatTurnsToReadOf(JSON.parse(JSON.stringify({ at: 1, blocks: b }))).blocks[0]!.turn).toEqual({ prompt: 'run the tests now', answer: 'Ran.', suggested: 'run the tests' });
    const bad = chatTurnsToReadOf({ at: 1, blocks: [{ turnId: 't1', turn: { prompt: 'a', answer: 'b', suggested: 3 }, characters: {} }] });
    expect(bad.blocks).toEqual([]);
    expect(bad.error).toBe('the stored chatTurnsToRead had 1 malformed entry, dropped');
  });
  test('a malformed record says so and keeps what reads, never an empty timeline in silence', () => {
    expect(chatTurnsToReadOf('nope')).toEqual({ blocks: [], items: {}, ended: {}, strikes: {}, turnNo: 0, error: 'the stored chatTurnsToRead is not a chatTurnsToRead record' });
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
      blocks: [{ no: 1, turnId: 't1', turn: { prompt: 'one', answer: 'Done.' }, characters: { cat: [endOfTurn(long)] } }],
      items: {}, ended: {}, strikes: {}, turnNo: 1, v1Notes: {},
      error: 'the stored chatTurnsToRead had 7 malformed entries, dropped',
    });
  });
  test('v1 notes stay uncleaned for migration and malformed characters are counted', () => {
    const b = addTurn([], 't1', turn('go'), 4);
    expect(chatTurnsToReadOf({ at: 1, blocks: b, notes: { cat: ['rule: x'], duck: 'nope' } })).toEqual({ ...numberBlocks(b), items: {}, ended: {}, strikes: {}, v1Notes: { cat: ['rule: x'] }, error: 'the stored chatTurnsToRead had 1 malformed entry, dropped' });
    expect(chatTurnsToReadOf({ blocks: b, notes: ['x'] }).error).toBe('the stored chatTurnsToRead had 1 malformed entry, dropped');
  });
  test('v2 reads items and ended records and counts each malformed entry', () => {
    const item = { text: 'Tests passed.', from: 'shown' as const, turn: 1, at: 0 };
    const b = addTurn([], 't1', turn('go'), 4, 0, 11);
    const items = { 'fact.tests-green': item };
    const ended = { 'fact.old': { item, reason: 'wrong: outdated', turn: 1, at: 1 } };
    const value = { version: 2, at: 0, blocks: b, turnNo: 9, items, ended };
    expect(chatTurnsToReadOf(value)).toEqual({ blocks: b, items, ended, strikes: {}, turnNo: 12 });
    expect(chatTurnsToReadOf({ ...value, blocks: [], turnNo: 9 })).toEqual({ blocks: [], items, ended, strikes: {}, turnNo: 9 });
    expect(chatTurnsToReadOf({ ...value, items: { ...items, nope: {} }, ended: { ...ended, 'fact.bad': {} } })).toEqual({ blocks: b, items, ended, strikes: {}, turnNo: 12, error: 'the stored chatTurnsToRead had 2 malformed entries, dropped' });
  });
  test("v2 reads each rule's strikes, keeping only a rule key with a positive whole count; v1 and a non-object read none", () => {
    const value = { version: 2, at: 0, blocks: [], turnNo: 0, items: {}, ended: {} };
    expect(chatTurnsToReadOf({ ...value, strikes: { 'rule.main-safe': 2, 'fact.x': 1, 'rule.zero': 0, 'rule.text': '3' } }).strikes).toEqual({ 'rule.main-safe': 2 });
    expect(chatTurnsToReadOf({ ...value, strikes: 'nope' }).strikes).toEqual({});
    expect(chatTurnsToReadOf(value).strikes).toEqual({});
    expect(chatTurnsToReadOf({ at: 1, blocks: [], strikes: { 'rule.main-safe': 2 } }).strikes).toEqual({});
  });
  test.each([3, 7])('a newer version %s reads as empty and untouched, its items never decoded as v1', (version) => {
    const b = addTurn([], 't1', turn('go'), 4, 0, 1);
    const value = { version, at: 0, blocks: b, turnNo: 1, items: { 'fact.x': { text: 'X.', from: 'shown', turn: 1, at: 0 } }, notes: { cat: ['rule: x'] } };
    expect(chatTurnsToReadOf(value)).toEqual({
      blocks: [], items: {}, ended: {}, strikes: {}, turnNo: 0, untouched: true,
      error: `the stored chatTurnsToRead is version ${version}, newer than this release reads: left untouched, read as empty`,
    });
  });
  test.each([['2'], [0], [1.5], [null]])('an unknown version %j reads as empty and untouched', (version) => {
    const r = chatTurnsToReadOf({ version, blocks: [] });
    expect(r).toMatchObject({ blocks: [], items: {}, untouched: true, error: `the stored chatTurnsToRead has an unknown version ${JSON.stringify(version)}: left untouched, read as empty` });
    expect(r.v1Notes).toBeUndefined();
  });
  test('version 1, or none, is v1: its notes kept raw for migration', () => {
    expect(chatTurnsToReadOf({ version: 1, blocks: [], notes: { cat: ['fact: x'] } })).toEqual({ blocks: [], items: {}, ended: {}, strikes: {}, turnNo: 0, v1Notes: { cat: ['fact: x'] } });
    expect(chatTurnsToReadOf({ blocks: [], notes: { cat: ['fact: x'] } }).v1Notes).toEqual({ cat: ['fact: x'] });
  });
  test.each([-1, 1.5, '9', null, undefined])('an invalid v2 turn counter %s falls back to the block numbers', (turnNo) => {
    expect(chatTurnsToReadOf({ version: 2, blocks: [], items: {}, ended: {}, turnNo }).turnNo).toBe(0);
  });
  test('the item block precedes the timeline and also renders on its own', () => {
    const b = addTurn([], 't1', turn('go'), 4);
    const items: Items = { 'fact.tests-green': { text: 'Tests passed.', from: 'shown', turn: 1, at: 0 } };
    const text = `${ITEMS_HEAD}\nfact.tests-green · Tests passed. · shown · 0`;
    expect(render(b, 'cat', 4, renderItems(items, 1))).toBe(`${text}\n\n${render(b, 'cat', 4)}`);
    expect(render([], 'cat', 4, renderItems(items, 1))).toBe(text);
  });
  test('a compaction is a turn of its own: its summary what Claude holds, cut and counted like any turn', () => {
    let b = addTurn([], 't1', turn('one'), 2);
    b = addCompaction(b, 'compaction:1', 'We built the drawer. Next: tests.', 2, 5);
    expect(b[1]).toMatchObject({ turnId: 'compaction:1', at: 5, turn: { prompt: '', answer: 'We built the drawer. Next: tests.', from: 'compaction' } });
    expect(render(b, 'cat', 2)).toContain(`${compactionLabel(2)}\nWe built the drawer. Next: tests.`);
    b = addTurn(b, 't2', turn('two'), 2);
    expect(b.map((x) => x.turnId)).toEqual(['compaction:1', 't2']);
  });
  test("memoryStats: the turns a call hands over, their characters kept and before the cut", () => {
    const big = `A${'p'.repeat(USER_PROMPT_HEAD + USER_PROMPT_TAIL + 100)}`;
    const b = addTurn(addTurn([], 't1', turn('one', 'Done.'), 4), 't2', turn(big, 'ok'), 4);
    expect(memoryStats(b, 4)).toEqual({ turns: 2, kept: 3 + 5 + USER_PROMPT_HEAD + USER_PROMPT_TAIL + 7 + 2, full: 3 + 5 + big.length + 2 });
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
    expect(back).toEqual(numberBlocks(b).blocks);
    // Only the last turn says its numbers (the story form): each turn's are read here as the last one's.
    expect(render(back.slice(0, 1), 'cat', 4)).toContain('Turn 1. The user asked Claude:\nsuggested: none\nsent: one\nClaude did: ran ls\nNumbers: 2m14s · 2 model requests · 2 tool calls (Bash 2) · on opus-5 at low effort\nClaude answered:\nOne.');
    expect(render(back.slice(0, 2), 'cat', 4)).toContain('Turn 2. The user asked Claude:\nsuggested: none\nsent: two\nNumbers: 3s · 2 model requests · 2 tool calls (Bash 2)\nClaude answered:');
    const r = render(back, 'cat', 4);
    expect(r).toContain('Turn 1. The user asked Claude:\nsuggested: none\nsent: one\nClaude did: ran ls\nClaude answered:\nOne.');
    expect(r).toContain('Turn 3. The user asked Claude:\nsuggested: none\nsent: three\nNumbers: 1s · 1 model request · on sonnet-5\nClaude answered:');
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
    expect(chatTurnsToReadOf(JSON.parse(JSON.stringify({ blocks: b }))).blocks).toEqual(numberBlocks(b).blocks);
    expect(chatTurnsToReadOf({ blocks: [{ ...b[0], characters: { cat: [{ kind: 'endOfTurn', promptToMainChat: 7 }] } }] }).blocks[0]!.characters.cat ?? []).toEqual([]);
  });
  test('a prompt never sent because the chat moved on: filed as unsentPrompt, after the sent one, first when alone, and kept through the store', () => {
    const b = addExchange(addTurn([], 't1', { prompt: 'go', answer: 'Tests pass.' }, 4), 'cat', { kind: 'endOfTurn', commentAfterEachTurn: 'Did they?', unsentPrompt: 'run the tests and show the output', suggestNextPrompt: 'commit it' }, 't1');
    expect(render(b, 'cat', 4)).toContain(
      "- After this turn, you commented: Did they?\n  With it, you wrote Claude a prompt, never sent because the chat moved on: run the tests and show the output\n  With it, you suggested the user's next prompt: commit it",
    );
    const alone = addExchange(addTurn([], 't1', { prompt: 'go', answer: 'Tests pass.' }, 4), 'cat', { kind: 'endOfTurn', unsentPrompt: 'run the tests' }, 't1');
    expect(render(alone, 'cat', 4).endsWith('- After this turn, you wrote Claude a prompt, never sent because the chat moved on: run the tests')).toBe(true);
    expect(chatTurnsToReadOf(JSON.parse(JSON.stringify({ blocks: b }))).blocks).toEqual(numberBlocks(b).blocks);
    expect(chatTurnsToReadOf({ blocks: [{ ...b[0], characters: { cat: [{ kind: 'endOfTurn', unsentPrompt: 7 }] } }] }).blocks[0]!.characters.cat ?? []).toEqual([]);
  });
  test('the turn it started is labelled as the buddy\'s own', () => {
    const b = addTurn([], 't2', { prompt: 'run the tests and show the output', answer: 'Ran them: 2 fail.', from: BUDDY_PROMPT }, 4);
    expect(render(b, 'cat', 4)).toContain('Turn 1. From the buddy (you), sent to Claude:\nrun the tests and show the output\n');
  });
});

describe('a task notification keeps its report', () => {
  const note = (inner: string) => `<task-notification>\n<task-id>a1</task-id>\n${inner}\n</task-notification>`;
  test('its summary, then its result, the result\'s tags stripped like any prompt\'s, one-spaced', () => {
    expect(cleanPrompt(note('<status>completed</status>\n<summary>Agent "Map the store" completed</summary>\n<result>Found <b>3</b> writers.\n\nAll in <code>store.ts</code>.<system-reminder>rules</system-reminder></result>'))).toBe('Agent "Map the store" completed Its report (34 chars): Found 3 writers. All in store.ts .');
    const blocks = addTurn([], 't1', { prompt: note('<status>completed</status><summary>Agent done</summary><result>The report.</result>'), answer: 'Read it.' }, 4);
    expect(render(chatTurnsToReadOf(JSON.parse(JSON.stringify({ at: 1, blocks }))).blocks, 'fixy', 4)).toContain('Agent done Its report (11 chars): The report.');
  });
  test('a long result is cut by cutReport, its size said', () => {
    const result = 'H'.repeat(3000) + 'T'.repeat(2000);
    expect(cleanPrompt(note(`<status>completed</status><summary>done</summary><result>${result}</result>`))).toBe(`done Its report (5k chars): ${'H'.repeat(600)} [cut] ${'T'.repeat(200)}`);
  });
  test('a status other than completed is shown', () => {
    expect(cleanPrompt(note('<status>failed</status><summary>Agent "Fix it" failed</summary><result>It threw.</result>'))).toBe('Agent "Fix it" failed (status: failed) Its report (9 chars): It threw.');
  });
  test('its usage, and that its report may be interim when its note says the agent is still running', () => {
    const result = `${'H'.repeat(8000)}${'T'.repeat(7000)}`;
    const usage = '<usage><subagent_tokens>77810</subagent_tokens><tool_uses>16</tool_uses><duration_ms>119609</duration_ms></usage>';
    const text = note(`<status>killed</status><summary>Agent "Audit" was stopped</summary><result>${result}</result>${usage}<note>The agent is still running background work.</note>`);
    expect(cleanPrompt(text)).toBe(`Agent "Audit" was stopped (status: killed) (78k tokens · 16 tool uses · 2m00s) (its report may be interim: the agent still has background work running) Its report (15k chars): ${cutReport(result)}`);
    expect(cutReport(result).length).toBe(REPORT_LARGE_HEAD + REPORT_LARGE_TAIL + 7);
    // No usage block: no usage; a boilerplate note: no interim mark.
    expect(cleanPrompt(note('<status>completed</status><summary>done</summary><result>Ok.</result><note>Read the report above.</note>'))).toBe('done Its report (3 chars): Ok.');
    // Read back from the store: as it was.
    const blocks = addTurn([], 't1', { prompt: text, answer: 'Read it.', from: 'task-notification' }, 4);
    expect(chatTurnsToReadOf(JSON.parse(JSON.stringify({ at: 1, blocks }))).blocks[0]!.turn!.prompt).toBe(blocks[0]!.turn!.prompt);
  });
  test('a completed notification without a result is its summary, as before', () => {
    expect(cleanPrompt(note('<status>completed</status>\n<summary>Background command "Run the proofs" completed (exit code 0)</summary>'))).toBe('Background command "Run the proofs" completed (exit code 0)');
  });
});

describe('a turn an error or a refusal ended', () => {
  test('its answer is said to be what Claude answered before the error or the refusal ended it, its steps kept', () => {
    const errored = render(addTurn([], 't1', { prompt: 'add a bulk tier', answer: '', did: ['Edit inventory.py'], ended: 'error' }, 4), 'fixy', 4);
    expect(errored).toContain('Edit inventory.py');
    expect(errored).toContain('Claude answered, before an error ended the turn:\n(no text)');
    const refused = render(addTurn([], 't1', { prompt: 'go', answer: 'I can', ended: 'refusal' }, 4), 'fixy', 4);
    expect(refused).toContain('Claude answered, before the model refused and ended the turn:\nI can');
    expect(refused).not.toContain('Claude answered:');
  });
  test('sent again as it was after it ended with no answer, it is remembered once, its steps first', () => {
    let b = addTurn([], 't1', { prompt: 'add a bulk tier', answer: '', did: ['Edit inventory.py'], ended: 'error' }, 4);
    b = addTurn(b, 't2', { prompt: 'add a bulk tier', answer: 'Done.', did: ['Run the tests'] }, 4);
    expect(b.map((x) => x.turnId)).toEqual(['t2']);
    expect(b[0]!.turn).toEqual({ prompt: 'add a bulk tier', answer: 'Done.', did: ['Edit inventory.py', 'Run the tests'] });
  });
  test('kept through the store; any other value is malformed', () => {
    const blocks = addTurn([], 't1', { prompt: 'go', answer: '', ended: 'refusal' }, 4);
    const back = chatTurnsToReadOf(JSON.parse(JSON.stringify({ at: 1, blocks })));
    expect(back.error).toBeUndefined();
    expect(back.blocks[0]!.turn).toMatchObject({ prompt: 'go', ended: 'refusal' });
    const bad = chatTurnsToReadOf({ at: 1, blocks: [{ turnId: 't1', turn: { prompt: 'p', answer: 'a', ended: 'crash' }, characters: {} }] });
    expect(bad.error).toMatch(/1 malformed entry/);
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
    expect(render(blocks, 'fixy', 4)).toContain(`Turn 1. The user asked Claude:\nsuggested: none\nsent: fix it\n${ADDED} also run the tests\n${ADDED} and lint\nClaude did: edited a.ts\nClaude answered:\nDone.`);
  });
  test('the same on an interrupted turn and on one not the user\'s', () => {
    const r = render(addTurn([], 't1', { prompt: 'go', answer: '', from: 'peer', interrupted: true, added: ['stop that'] }, 4), 'fixy', 4);
    expect(r).toContain(`Claude was sent, not by the user (peer):\ngo\n${ADDED} stop that\nClaude answered, before the user interrupted the turn:`);
  });
  test("each cut like the user's prompt, empty ones gone, at most 3 kept: the newest; none is no field", () => {
    const long = `${'h'.repeat(USER_PROMPT_HEAD)}${'m'.repeat(500)}${'t'.repeat(USER_PROMPT_TAIL)}`;
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
    expect(render(story(), 'cat', 5, renderItems({ 'fact.note-one': { text: 'note one', from: 'shown', turn: 0, at: 0 } }, 0))).toBe(readFileSync(new URL('./fixtures/story-form.txt', import.meta.url), 'utf8'));
  });
  test('the last turn stays as rendered before: prompt, added, steps, numbers and answer whole', () => {
    expect(render(story(), 'cat', 5).endsWith(
      `Turn 4. The user asked Claude:\nsuggested: none\nsent: ${words('last', 200)}\n${ADDED_LABEL} ${words('more', 120)}\nClaude did: ran it\nNumbers: 5s · 2 model requests · 3 tool calls (Bash 3), 2 failed\nClaude answered:\n${words('fin', 150)}\n${words('done', 150)}\n- You said: Last word.`,
    )).toBe(true);
  });
  test("an older turn's prompt, added line and answer cut to their start and end; its numbers gone, its failed calls counted", () => {
    const r = render(story(), 'cat', 5);
    const ask = words('ask', 200);
    // The user's own words, under the user's story head and tail, stay whole.
    expect(r).toContain(`Turn 1. The user asked Claude:\nsuggested: none\nsent: ${ask}\n`);
    expect(r).toContain(`\n${ADDED_LABEL} ${words('also', 120)}\n`);
    const answer = `${words('first', 80)}\n${words('mid', 80)}\n${words('end', 80)}`;
    expect(r).toContain(`Claude answered:\n${answer.slice(0, STORY_ANSWER_HEAD)} [cut] ${answer.slice(-STORY_ANSWER_TAIL)}\n- You said: Meow, tests.`);
    expect(r).toContain('Claude did: read a.ts, b.ts; ran the tests; edited a.ts; ran lint\n2 tool calls failed.\nClaude answered:');
    expect(r).toContain('Claude did: a; b; c; d; … 5 more; x\n1 tool call failed.\nClaude answered, before the user interrupted the turn:');
    expect(r.match(/^Numbers: /gm)).toHaveLength(1);
  });
  test('no failed call, no failed line; a failed test run is not a failed tool call', () => {
    let b = addTurn([], 't1', { prompt: 'one', answer: 'One.', stats: { ms: 1_000, requests: 1, tools: { Bash: 1 }, tests: { passed: 1, failed: 2 } } }, 4);
    b = addTurn(b, 't2', { prompt: 'two', answer: 'Two.' }, 4);
    expect(render(b, 'cat', 4)).toContain('Turn 1. The user asked Claude:\nsuggested: none\nsent: one\nClaude answered:\nOne.\n\nTurn 2.');
  });
  test("an older turn keeps the buddy's exchanges whole and in order, its canned lines too", () => {
    expect(render(story(), 'cat', 5)).toContain("- You said: Meow, tests.\n- After this turn, you commented: Nice run.\n  With it, you suggested the user's next prompt: run npm test\n- The user asked you: why?\n  You answered: Because.\n    It was due.\n\nTurn 2.");
    expect(render(story(), 'cat', 5)).toContain('Stopped.\n- You said: Hmm.\n\nTurn 4.');
  });
  test('a compaction not last: its summary and exchanges, canned lines gone, cut to their start and end; a compaction last stays whole', () => {
    const body = `${words('sum', 300)}\n${words('next', 100)}\n- After this turn, you commented: Compacted well.`;
    expect(render(story(), 'cat', 5)).toContain(`${compactionLabel(2)}\n${body}\n\nTurn 3.`);
    let b = addTurn([], 't1', turn('one'), 4);
    b = addCompaction(b, 'compaction:1', words('sum', 400), 4);
    b = addExchange(b, 'cat', line('Squashed.'));
    expect(render(b, 'cat', 4)).toContain(`${compactionLabel(2)}\n${words('sum', 400)}\n- You said: Squashed.`);
  });
  test('an older compaction keeps 4000 head and 1000 tail characters across its summary and exchanges', () => {
    expect(STORY_COMPACTION_HEAD).toBe(4000);
    expect(STORY_COMPACTION_TAIL).toBe(1000);
    const summary = 's'.repeat(4500);
    const comment = 'e'.repeat(1200);
    let b = addCompaction([], 'compact', summary, 4, undefined, 6);
    b = addExchange(b, 'cat', line('Canned.'));
    b = addExchange(b, 'cat', endOfTurn(comment));
    const body = `${summary}\n- After this turn, you commented: ${comment}`;
    expect(render(b, 'cat', 4)).toBe(`${H}\n\n${compactionLabel(7)}\n${summary}\n- You said: Canned.\n- After this turn, you commented: ${comment}`);
    b = addTurn(b, 't8', turn('next'), 4, undefined, 7);
    expect(render(b, 'cat', 4)).toBe(`${H}\n\n${compactionLabel(7)}\n${body.slice(0, STORY_COMPACTION_HEAD)} [cut] ${body.slice(-STORY_COMPACTION_TAIL)}\n\nTurn 8. The user asked Claude:\nsuggested: none\nsent: next\nClaude answered:\nDone.`);
  });
  test('didLine: null keeps the steps as the last turn says them; a number names that many and counts them all', () => {
    const did = ['a', 'b', 'c', 'd', '… 5 more', 'x'];
    expect(didLine(did, null)).toBe('Claude did: a; b; c; d; … 5 more; x');
    expect(didLine(did, 2)).toBe('Claude did 10 steps: a; b; [cut]');
    const marked = ['a', 'b', 'c', 'd', '[cut: 9 more steps]', 'x'];
    expect(didLine(marked, 2)).toBe('Claude did 14 steps: a; b; [cut]');
    expect(didLine(marked, null)).toBe('Claude did: a; b; c; d; [cut: 9 more steps]; x');
    expect(didLine(['a', 'b'], 2)).toBe('Claude did 2 steps: a; b');
    expect(didLine(['one'], 2)).toBe('Claude did 1 step: one');
    expect(didLine(did)).toBe(didLine(did, STORY_DID_STEPS));
  });
});

describe("the user's own prompt", () => {
  const big = (n: number): string => `${'h'.repeat(n / 2)}${'t'.repeat(n / 2)}`;
  test('kept whole up to the large limit and rendered whole in the last turn; past it, cut 15000/5000', () => {
    const prompt = big(18_000);
    const b = addTurn([], 't1', turn(prompt), 4);
    expect(b[0]!.turn!.prompt).toBe(prompt);
    expect(render(b, 'cat', 4)).toContain(`sent: ${prompt}\n`);
    expect(addTurn([], 't1', turn('x'.repeat(USER_PROMPT_HEAD + USER_PROMPT_TAIL + 7)), 4)[0]!.turn!.prompt).toHaveLength(USER_PROMPT_HEAD + USER_PROMPT_TAIL + 7);
    const over = big(30_000);
    expect(addTurn([], 't1', turn(over), 4)[0]!.turn!.prompt).toBe(`${over.slice(0, USER_PROMPT_HEAD)} [cut] ${over.slice(-USER_PROMPT_TAIL)}`);
  });
  test("as an older turn, cut 3000/1000; another origin's older prompt keeps 600/200", () => {
    const prompt = big(18_000);
    let b = addTurn([], 't1', turn(prompt), 4);
    b = addTurn(b, 't2', { prompt, answer: 'Done.', from: 'peer' }, 4);
    b = addTurn(b, 't3', turn('next'), 4);
    const r = render(b, 'cat', 4);
    expect(r).toContain(`sent: ${prompt.slice(0, STORY_USER_PROMPT_HEAD)} [cut] ${prompt.slice(-STORY_USER_PROMPT_TAIL)}\n`);
    const peer = b[1]!.turn!.prompt;
    expect(r).toContain(`Turn 2. Claude was sent, not by the user (peer):\n${peer.slice(0, STORY_PROMPT_HEAD)} [cut] ${peer.slice(-STORY_PROMPT_TAIL)}\n`);
  });
});

describe('a signed cross-chat message', () => {
  const body = `${'b'.repeat(1500)}${'e'.repeat(1500)}`;
  const signed = `${body} — sid 0123abcd · to reply: chat_inject peer-x <message>`;
  const form = `${body.slice(0, 600)} [cut] ${body.slice(-200)} — sid 0123abcd · from chat peer-x`;
  test("as a prompt: another chat's, its body cut 600/200 and its signature kept short; read back unchanged; never typed by the user", () => {
    const b = addTurn([], 't1', turn(signed), 4);
    expect(b[0]!.turn).toMatchObject({ from: SIGNED_MESSAGE_ORIGIN, prompt: form });
    expect(render(b, 'cat', 4)).toContain(`Turn 1. Claude was sent a signed message from another chat, not typed by the user:\n${form}\nClaude answered:`);
    const back = chatTurnsToReadOf(JSON.parse(JSON.stringify({ at: 1, blocks: b })));
    expect(back.blocks[0]!.turn).toEqual(b[0]!.turn);
    expect(typedByUser(back.blocks)).toEqual([]);
    // Another origin's prompt that looks signed keeps its origin.
    expect(addTurn([], 't1', { ...turn(signed), from: 'peer' }, 4)[0]!.turn!.from).toBe('peer');
  });
  test("delivered mid-turn: kept after SIGNED_ADDED, said as a signed message, never typed by the user", () => {
    const b = addTurn([], 't1', { ...turn('go'), added: ['also lint', signed], addedAfter: [1, 3] }, 4);
    expect(b[0]!.turn!.added).toEqual(['also lint', `${SIGNED_ADDED} ${form}`]);
    const r = render(b, 'cat', 4);
    expect(r).toContain(`The user added while Claude worked, after 1 tool call: also lint\nClaude was sent while it worked, after 3 tool calls, a signed message from another chat, not typed by the user: ${form}\n`);
    expect(typedByUser(b)).toEqual(['go', 'also lint']);
    const back = chatTurnsToReadOf(JSON.parse(JSON.stringify({ at: 1, blocks: b })));
    expect(back.blocks[0]!.turn).toEqual(b[0]!.turn);
  });
});

describe('what Claude wrote mid-turn, and where things happened in the turn', () => {
  test('a text written before any tool call shows after the prompt; the final answer once, under Claude answered', () => {
    const answer = 'All rows now carry the account.';
    const b = addTurn([], 't1', { prompt: 'will every row carry the account?', answer, did: ['Run the tests'], said: [{ after: 0, text: 'Yes, every row will carry the account.' }, { after: 3, text: '  ' }, { after: 3, text: answer }] }, 4);
    expect(b[0]!.turn!.said).toEqual([{ after: 0, text: 'Yes, every row will carry the account.' }]);
    const r = render(b, 'cat', 4);
    expect(r).toContain('sent: will every row carry the account?\nClaude wrote mid-turn, before any tool call: Yes, every row will carry the account.\nClaude did: Run the tests\nClaude answered:\nAll rows now carry the account.');
    expect(r.split(answer)).toHaveLength(2);
  });
  test('the user added after 2 tool calls; added before said at the same position; positions that do not pair read as unknown', () => {
    const b = addTurn([], 't1', { ...turn('go'), added: ['stop after lint'], addedAfter: [2], said: [{ after: 2, text: 'Linting.' }, { after: 1, text: 'Reading.' }] }, 4);
    expect(b[0]!.turn!.addedAfter).toEqual([2]);
    expect(render(b, 'cat', 4)).toContain('sent: go\nClaude wrote mid-turn, after 1 tool call: Reading.\nThe user added while Claude worked, after 2 tool calls: stop after lint\nClaude wrote mid-turn, after 2 tool calls: Linting.\n');
    const unpaired = addTurn([], 't1', { ...turn('go'), added: ['a1', 'a2'], addedAfter: [2] }, 4)[0]!.turn!;
    expect(unpaired).not.toHaveProperty('addedAfter');
    expect(render([{ turnId: 't1', turn: unpaired, characters: {} }], 'cat', 4)).toContain(`sent: go\n${ADDED_LABEL} a1\n${ADDED_LABEL} a2\n`);
    // Blanks and the oldest past 3 drop, their positions with them.
    expect(addTurn([], 't1', { ...turn('go'), added: ['a1', ' ', 'a2', 'a3', 'a4'], addedAfter: [1, 2, 3, 4, 5] }, 4)[0]!.turn).toMatchObject({ added: ['a2', 'a3', 'a4'], addedAfter: [3, 4, 5] });
  });
  test('12 texts: the first 2, a count of the rest, the last 6; read back unchanged', () => {
    const said = Array.from({ length: 12 }, (_, i) => ({ after: i, text: `text ${i}` }));
    const b = addTurn([], 't1', { ...turn('go'), said }, 4);
    expect(b[0]!.turn!.said).toEqual([said[0], said[1], { after: 2, text: '[cut: 4 more]' }, ...said.slice(-6)]);
    expect(chatTurnsToReadOf(JSON.parse(JSON.stringify({ at: 1, blocks: b }))).blocks[0]!.turn).toEqual(b[0]!.turn);
  });
  test('an older turn cuts each text like an added line', () => {
    let b = addTurn([], 't1', { ...turn('go'), said: [{ after: 0, text: 'w'.repeat(1500) }] }, 4);
    b = addTurn(b, 't2', turn('next'), 4);
    const line = `Claude wrote mid-turn, before any tool call: ${'w'.repeat(1500)}`;
    expect(render(b, 'cat', 4)).toContain(`\n${line.slice(0, STORY_ADDED_HEAD)} [cut] ${line.slice(-STORY_ADDED_TAIL)}\n`);
  });
});

describe("a turn's agents", () => {
  test('briefed and returned under what the turn did; the newest RETURNED_MAX briefs kept', () => {
    const briefed = ['“A”: one', '“B”: two', '“C”: three', '“D”: four', '“E”: five'];
    const b = addTurn([], 't1', { ...turn('go'), did: ['agent: E'], briefed, returned: ['“E” returned (report 2 chars): ok'] }, 4);
    expect(b[0]!.turn!.briefed).toEqual(briefed.slice(-4));
    expect(render(b, 'cat', 4)).toContain('Claude did: agent: E\nClaude briefed its agent “B”: two\nClaude briefed its agent “C”: three\nClaude briefed its agent “D”: four\nClaude briefed its agent “E”: five\nIts agent “E” returned (report 2 chars): ok\n');
  });
});

describe('the stored sight fields', () => {
  const stored = (turn: Record<string, unknown>) => ({ at: 1, blocks: [{ turnId: 't1', turn: { prompt: 'p', answer: 'a', ...turn }, characters: {} }] });
  test('said, addedAfter and briefed round-trip', () => {
    const t = { prompt: 'p', answer: 'a', added: ['x'], addedAfter: [4], said: [{ after: 1, text: 'Looking.' }], briefed: ['“A”: go'] };
    expect(chatTurnsToReadOf(stored(t)).blocks[0]!.turn).toEqual(t);
  });
  test('said or briefed not of its shape: the turn is malformed; a bad addedAfter is dropped silently', () => {
    for (const bad of [{ said: 'x' }, { said: [{ after: -1, text: 'x' }] }, { said: [{ after: 1.5, text: 'x' }] }, { said: [{ after: 1 }] }, { briefed: [3] }, { briefed: 'x' }]) {
      const r = chatTurnsToReadOf(stored(bad));
      expect(r.blocks).toEqual([]);
      expect(r.error).toMatch(/1 malformed entry/);
    }
    const r = chatTurnsToReadOf(stored({ added: ['x'], addedAfter: ['2'] }));
    expect(r.error).toBeUndefined();
    expect(r.blocks[0]!.turn).toEqual({ prompt: 'p', answer: 'a', added: ['x'] });
  });
});
