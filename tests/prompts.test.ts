import { describe, expect, test } from 'vitest';
import {
  CHARACTER_RULE, FORK_ROLE, ONE_LINE_RULE, SUGGESTION_MAX_CHARS, TURN_DEADLINE_MS, TURN_MAX_TOKENS, TURN_WINDOW, TURN_WINDOW_MAX, forkPrompt, lostThread, pushTurn, recentTurns, oneLine, oneLineSystem, parseTurnReply, questionPrompt, suggestionText, turnForkPrompt, turnPrompt, turnSystem,
} from '../plugins/buddy/src/prompts.ts';

describe('prompts', () => {
  test('the fork prompt: steps out of the chat\'s assistant voice, then persona, the question, the one-line rule', () => {
    expect(forkPrompt('You are X.', 'why')).toBe(
      `${FORK_ROLE}\n\nYou are X.\n\n${CHARACTER_RULE}\n\nThe user asks you directly: why. Answer in ONE line, at most 25 words, in character. Do not use tools. Do not think out loud.`,
    );
    expect(FORK_ROLE).toContain('not the assistant');
    expect(FORK_ROLE).toContain('sign-off');
  });
  test('every fork, the question\'s and the end-of-turn one, is told it has no tools: a denied tool attempt is another slow round', () => {
    expect(FORK_ROLE).toContain('You have no tools in this reply');
    expect(turnForkPrompt('You are X.', { line: true, next: true })).toContain('You have no tools in this reply');
  });
  test('the completion system and prompt', () => {
    expect(oneLineSystem('You are X.')).toBe(`You are X.\n\n${CHARACTER_RULE}\n\n${ONE_LINE_RULE}`);
    expect(questionPrompt('hi')).toBe('The user asks you directly: hi');
  });
  test('the turn prompt counts tools and caps the command', () => {
    const p = turnPrompt({ tools: ['Bash', 'Read', 'Bash'], failures: 1, lastBash: 'x'.repeat(200) }, [{ prompt: 'fix it', answer: 'Fixed.' }]);
    expect(p).toContain(`Tools used: Bash x2, Read. Failures: 1. Last shell command: ${'x'.repeat(120)}.`);
    expect(turnPrompt({ tools: [], failures: 0, lastBash: '' }, [{ prompt: 'hi', answer: 'Hello.' }])).toContain('Tools used: none. Failures: 0. Last shell command: none.');
  });
  test('oneLine takes the first non-empty line, unquoted, capped', () => {
    expect(oneLine('\n  "Hello there."  \nmore')).toBe('Hello there.');
    expect(oneLine('')).toBe('');
    expect(oneLine('y'.repeat(300))).toHaveLength(240);
  });
  test('lostThread', () => {
    expect(lostThread('Fixy', 'api-error')).toBe("Fixy couldn't answer: api-error");
  });
});

describe('memory in the prompts', () => {
  const memory = 'Recently (oldest first):\nYou: remember pineapple\nCat: Noted.';
  test('before the question, with leave to refer back to it', () => {
    const f = forkPrompt('You are X.', 'what word', memory);
    expect(f.indexOf(memory)).toBeGreaterThan(f.indexOf('You are X.'));
    expect(f.indexOf(memory)).toBeLessThan(f.indexOf('The user asks you directly: what word'));
    expect(f).toContain('you may refer back to it');
    const c = questionPrompt('what word', memory);
    expect(c.startsWith(memory)).toBe(true);
    expect(c.endsWith('The user asks you directly: what word')).toBe(true);
    const tp = turnPrompt({ tools: ['Read'], failures: 0, lastBash: '' }, [{ prompt: 'hi', answer: 'Hello.' }], memory);
    expect(tp.startsWith(memory)).toBe(true);
    expect(tp).toContain('you may refer back to it');
  });
  test('a completion\'s question sees the main chat\'s recent turns, after the memory and before the question', () => {
    const window = recentTurns([{ prompt: 'build the thing', answer: 'Built it.' }]);
    expect(window).toContain('The user asked Claude:\nbuild the thing');
    expect(window).toContain('Claude answered:\nBuilt it.');
    const q = questionPrompt('can you see the main chat?', memory, window);
    expect(q.startsWith(memory)).toBe(true);
    expect(q.indexOf('Built it.')).toBeGreaterThan(q.indexOf(memory));
    expect(q.endsWith('The user asks you directly: can you see the main chat?')).toBe(true);
    expect(recentTurns([])).toBe('');
    expect(questionPrompt('hi', '', '')).toBe('The user asks you directly: hi');
  });
  test('the recent turns render oldest first, each prompt and answer keeping its end past its cap; the turn prompt reads the same block', () => {
    const turns = [{ prompt: 'first ask', answer: 'first reply' }, { prompt: '', answer: '' }, { prompt: 'third ask', answer: 'third reply' }];
    const w = recentTurns(turns);
    expect(w.indexOf('first ask')).toBeLessThan(w.indexOf('first reply'));
    expect(w.indexOf('first reply')).toBeLessThan(w.indexOf('(not seen)'));
    expect(w.indexOf('(no text)')).toBeLessThan(w.indexOf('third ask'));
    expect(w.match(/The user asked Claude:/g)).toHaveLength(3);
    const long = recentTurns([{ prompt: `START${'a'.repeat(1500)}END`, answer: `HEAD${'b'.repeat(3000)}TAIL` }]);
    expect(long).toContain(`...${'a'.repeat(1497)}END`);
    expect(long).toContain(`...${'b'.repeat(2996)}TAIL`);
    expect(long).not.toContain('START');
    expect(long).not.toContain('HEAD');
    expect(recentTurns([{ prompt: 'p'.repeat(1500), answer: 'a'.repeat(3000) }])).not.toContain('...');
    expect(turnPrompt({ tools: [], failures: 0, lastBash: '' }, turns)).toContain(w);
  });
  test('the turn window keeps the last TURN_WINDOW (3) turns, dropping the oldest, never changing the one it is given', () => {
    expect(TURN_WINDOW).toBe(3);
    const t = (n: number) => ({ prompt: `p${n}`, answer: `a${n}` });
    let turns: ReturnType<typeof t>[] = [];
    for (let n = 1; n <= 3; n++) turns = pushTurn(turns, t(n));
    expect(turns).toEqual([t(1), t(2), t(3)]);
    const before = turns;
    turns = pushTurn(turns, t(4));
    expect(turns).toEqual([t(2), t(3), t(4)]);
    expect(before).toEqual([t(1), t(2), t(3)]);
  });
  test('the turn window honours a size N from 1 to TURN_WINDOW_MAX (10): the last N turns, oldest first', () => {
    expect(TURN_WINDOW_MAX).toBe(10);
    const t = (n: number) => ({ prompt: `p${n}`, answer: `a${n}` });
    let one: ReturnType<typeof t>[] = [];
    let ten: ReturnType<typeof t>[] = [];
    for (let n = 1; n <= 12; n++) {
      one = pushTurn(one, t(n), 1);
      ten = pushTurn(ten, t(n), 10);
    }
    expect(one).toEqual([t(12)]);
    expect(ten).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(t));
    expect(pushTurn(ten, t(13), 5)).toEqual([9, 10, 11, 12, 13].map(t));
  });
  test('the end-of-turn fork prompt: the step out of the assistant voice, then the end-of-turn system prompt, then the memory', () => {
    const both = { line: true, next: true };
    expect(turnForkPrompt('You are X.', both)).toBe(`${FORK_ROLE}\n\n${turnSystem('You are X.', both)}`);
    expect(turnForkPrompt('You are X.', both, '')).toBe(turnForkPrompt('You are X.', both));
    const next = { line: false, next: true };
    const p = turnForkPrompt('You are X.', next, 'Fixy: Still here.');
    expect(p).toBe(`${FORK_ROLE}\n\n${turnSystem('You are X.', next)}\n\nFixy: Still here.\nThat is what you and the user said to each other lately; you may refer back to it.`);
    expect(p).toContain('NEXT:');
    expect(p).not.toContain('LINE:');
  });
  test('no memory: the prompts as before', () => {
    expect(questionPrompt('hi', '')).toBe('The user asks you directly: hi');
    expect(forkPrompt('You are X.', 'why', '')).toBe(forkPrompt('You are X.', 'why'));
  });
});

describe('the character rule', () => {
  test('says: become the character, one useful thing both missed, the character is HOW never WHAT, no repeating', () => {
    expect(CHARACTER_RULE).toMatch(/completely/);
    expect(CHARACTER_RULE).toMatch(/ONE thing/);
    expect(CHARACTER_RULE).toMatch(/both the user and the assistant/);
    expect(CHARACTER_RULE).toMatch(/a risk, a gap, a wrong assumption/);
    expect(CHARACTER_RULE).toMatch(/HOW.*never WHAT/);
    expect(CHARACTER_RULE).toMatch(/repeat/);
  });
  test('comes right after the persona: questions, the end-of-turn LINE, and a fork (after its role)', () => {
    expect(oneLineSystem('You are X.').startsWith(`You are X.\n\n${CHARACTER_RULE}\n\n`)).toBe(true);
    expect(turnSystem('You are X.', { line: true, next: true }).startsWith(`You are X.\n\n${CHARACTER_RULE}\n\n`)).toBe(true);
    expect(turnSystem('You are X.', { line: true, next: false }).startsWith(`You are X.\n\n${CHARACTER_RULE}\n\n`)).toBe(true);
    const f = forkPrompt('You are X.', 'why', 'Recently: x');
    expect(f.startsWith(`${FORK_ROLE}\n\nYou are X.\n\n${CHARACTER_RULE}\n\n`)).toBe(true);
    expect(f.indexOf(CHARACTER_RULE)).toBeLessThan(f.indexOf('Recently: x'));
  });
  test('a NEXT alone is the user\'s own words, not the character\'s: no rule', () => {
    expect(turnSystem('You are X.', { line: false, next: true })).not.toContain(CHARACTER_RULE);
  });
});

describe('the end-of-turn call', () => {
  test('the system: the persona, then a LINE in character and a NEXT in the user\'s own words, NONE only when finished', () => {
    const s = turnSystem('You are X.', { line: true, next: true });
    expect(s.startsWith('You are X.\n\n')).toBe(true);
    expect(s).toContain('LINE:');
    expect(s).toContain('at most 20 words');
    expect(s).toContain('NEXT:');
    expect(s).toContain('the prompt the user is most likely to send Claude next');
    expect(s).toContain("in the user's own words");
    expect(s).toContain('at most 15 words');
    expect(s).toContain('NEXT: NONE');
    expect(s).toContain('Do not use tools.');
  });
  test('the system asks only for what is wanted', () => {
    const line = turnSystem('You are X.', { line: true, next: false });
    expect(line).toContain('LINE:');
    expect(line).not.toContain('NEXT:');
    const next = turnSystem('You are X.', { line: false, next: true });
    expect(next).toContain('NEXT:');
    expect(next).not.toContain('LINE:');
  });
  test('the prompt: the user\'s last prompt, then Claude\'s answer, each keeping its end past its cap', () => {
    const t = { tools: [], failures: 0, lastBash: '' };
    const p = turnPrompt(t, [{ prompt: 'add a login page', answer: 'Done: login.tsx is in.' }]);
    expect(p).toContain('The user asked Claude:\nadd a login page');
    expect(p).toContain('Claude answered:\nDone: login.tsx is in.');
    expect(p.indexOf('add a login page')).toBeLessThan(p.indexOf('Done: login.tsx is in.'));
    const long = turnPrompt(t, [{ prompt: `START${'a'.repeat(5000)}END`, answer: `HEAD${'b'.repeat(9000)}TAIL` }]);
    expect(long).toContain('END');
    expect(long).toContain('TAIL');
    expect(long).not.toContain('START');
    expect(long).not.toContain('HEAD');
    expect(long.length).toBeLessThan(1500 + 3000 + 400);
  });
  test('parseTurnReply: the tagged lines, in any case, bullets tolerated', () => {
    expect(parseTurnReply('LINE: "Tests are green!"\nNEXT: commit this')).toEqual({ line: 'Tests are green!', next: 'commit this' });
    expect(parseTurnReply('  - line: Nice.\n * next:  run   the tests ')).toEqual({ line: 'Nice.', next: 'run the tests' });
    expect(parseTurnReply('NEXT: add a test\nLINE: Onward.')).toEqual({ line: 'Onward.', next: 'add a test' });
  });
  test('parseTurnReply: NEXT NONE, empty or past the cap is no suggestion; an empty LINE is no line', () => {
    expect(parseTurnReply('LINE: Done and dusted.\nNEXT: NONE')).toEqual({ line: 'Done and dusted.', next: null });
    expect(parseTurnReply('LINE:\nNEXT:')).toEqual({ line: null, next: null });
    expect(parseTurnReply(`NEXT: ${'y'.repeat(SUGGESTION_MAX_CHARS + 1)}`)).toEqual({ line: null, next: null });
  });
  test('parseTurnReply: an untagged reply is the line alone', () => {
    expect(parseTurnReply('\n  Quack, that went well.\nmore')).toEqual({ line: 'Quack, that went well.', next: null });
    expect(parseTurnReply('')).toEqual({ line: null, next: null });
  });
  test('one short call: 120 tokens, 30 s', () => {
    expect(TURN_MAX_TOKENS).toBe(120);
    expect(TURN_DEADLINE_MS).toBe(30_000);
  });
  test('suggestionText: the first non-empty line, unquoted, whitespace collapsed', () => {
    expect(suggestionText('\n  "run   the tests"  \nmore')).toBe('run the tests');
    expect(suggestionText('`commit this`')).toBe('commit this');
    expect(suggestionText("'fix the\tlinter'")).toBe('fix the linter');
  });
  test('suggestionText: nothing for an empty reply, NONE in any case, or a line past the cap', () => {
    expect(suggestionText('')).toBeNull();
    expect(suggestionText('  \n ')).toBeNull();
    expect(suggestionText('NONE')).toBeNull();
    expect(suggestionText('none.')).toBeNull();
    expect(suggestionText('"None"')).toBeNull();
    expect(suggestionText('None of the tests ran, rerun them')).toBe('None of the tests ran, rerun them');
    expect(SUGGESTION_MAX_CHARS).toBe(160);
    expect(suggestionText('y'.repeat(SUGGESTION_MAX_CHARS))).toHaveLength(SUGGESTION_MAX_CHARS);
    expect(suggestionText('y'.repeat(SUGGESTION_MAX_CHARS + 1))).toBeNull();
  });
});
