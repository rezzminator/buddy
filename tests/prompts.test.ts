import { describe, expect, test } from 'vitest';
import {
  CHARACTER_RULE, ONE_LINE_RULE, SUGGESTION_MAX_CHARS, TURN_DEADLINE_MS, TURN_MAX_TOKENS, TURN_WINDOW, TURN_WINDOW_MAX, lostThread, pushTurn, recentTurns, oneLine, oneLineSystem, parseTurnReply, questionPrompt, suggestionText, turnPrompt, turnSystem,
} from '../plugins/buddy/src/prompts.ts';

describe('prompts', () => {
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
    const c = questionPrompt('what word', memory);
    expect(c.startsWith(memory)).toBe(true);
    expect(c).toContain('you may refer back to it');
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
  test('no memory: the prompts as before', () => {
    expect(questionPrompt('hi', '')).toBe('The user asks you directly: hi');
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
  test('comes right after the persona: questions and the end-of-turn LINE', () => {
    expect(oneLineSystem('You are X.').startsWith(`You are X.\n\n${CHARACTER_RULE}\n\n`)).toBe(true);
    expect(turnSystem('You are X.', { line: true, next: true }).startsWith(`You are X.\n\n${CHARACTER_RULE}\n\n`)).toBe(true);
    expect(turnSystem('You are X.', { line: true, next: false }).startsWith(`You are X.\n\n${CHARACTER_RULE}\n\n`)).toBe(true);
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
import { createBrain, endTurn } from '../plugins/buddy/src/brain.ts';
import { validateCharacter } from '../plugins/buddy/src/character.ts';
import {
  NO_PROMPTS, endPromptTurn, endsConversation, isUserOrigin, requestTimeoutMs, skipReason, startPromptTurn, submitPrompt, turnMay, type TurnGate,
} from '../plugins/buddy/src/prompts.ts';
import { raw } from './fixtures.ts';

/** A ledger's filing of a turn: its prompt and whose. */
function filed(r: { prompt: string; from?: string }): { prompt: string; from: string | undefined } {
  return { prompt: r.prompt, from: r.from };
}

describe('the prompt ledger', () => {
  test('each turn is filed with the text its turn.start carried, whatever was typed over it meanwhile', () => {
    let l = submitPrompt(NO_PROMPTS, 'P1', 'composer');
    l = startPromptTurn(l, 't1', 'P1');
    l = submitPrompt(l, 'P2', 'composer', 't1');
    const one = endPromptTurn(l, 't1');
    expect(filed(one)).toEqual({ prompt: 'P1', from: undefined });
    l = startPromptTurn(one.ledger, 't2', 'P2');
    expect(filed(endPromptTurn(l, 't2'))).toEqual({ prompt: 'P2', from: undefined });
  });
  test('a peer message or a task notification delivered into a running turn never shifts the next turn\'s prompt', () => {
    let l = startPromptTurn(submitPrompt(NO_PROMPTS, 'P1', 'composer'), 't1', 'P1');
    l = submitPrompt(l, 'from a peer', 'peer', 't1');
    l = submitPrompt(l, 'a task finished', 'task-notification', 't1');
    l = submitPrompt(l, 'P2', 'composer', 't1');
    l = endPromptTurn(l, 't1').ledger;
    l = startPromptTurn(l, 't2', 'P2');
    expect(filed(endPromptTurn(l, 't2'))).toEqual({ prompt: 'P2', from: undefined });
  });
  test('a turn a non-user prompt started is filed under its origin, never as the user\'s', () => {
    let l = startPromptTurn(submitPrompt(NO_PROMPTS, 'hello from a peer', 'peer'), 't1', 'hello from a peer');
    expect(endPromptTurn(l, 't1')).toMatchObject({ prompt: 'hello from a peer', from: 'peer' });
    // A turn with no submission seen (a continuation) is not presumed the user's.
    l = startPromptTurn(NO_PROMPTS, 't2', '');
    expect(endPromptTurn(l, 't2').from).toBe('unknown');
    expect(endPromptTurn(NO_PROMPTS, 't3')).toMatchObject({ prompt: '', from: 'unknown' });
  });
  test('a turn started before its prompt.submit settled takes the origin once it does', () => {
    let l = startPromptTurn(NO_PROMPTS, 't1', 'P1');
    l = submitPrompt(l, 'P1', 'composer');
    expect(filed(endPromptTurn(l, 't1'))).toEqual({ prompt: 'P1', from: undefined });
    let peer = startPromptTurn(NO_PROMPTS, 't1', 'P1');
    peer = submitPrompt(peer, 'P1', 'peer');
    expect(endPromptTurn(peer, 't1').from).toBe('peer');
  });
  test('the user\'s own origins: the terminal, Remote Control, an SDK host', () => {
    expect(['composer', 'bridge', 'sdk'].every(isUserOrigin)).toBe(true);
    expect(['peer', 'task-notification', 'plugin', 'unclassified', 'auto-continuation', 'scheduled-trigger'].some(isUserOrigin)).toBe(false);
  });
  test('/clear and a resume start a fresh conversation; an exit does not matter', () => {
    expect(endsConversation('clear')).toBe(true);
    expect(endsConversation('resume')).toBe(true);
    expect(endsConversation('prompt_input_exit')).toBe(false);
    expect(endsConversation('other')).toBe(false);
  });
});

describe('the end-of-turn gate', () => {
  const g: TurnGate = { answered: true, hidden: false, interactive: true, bandSeen: true, quips: true, suggestions: true };
  test('a line only once the band has drawn; the suggestion regardless', () => {
    expect(turnMay(g)).toEqual({ line: true, next: true });
    expect(turnMay({ ...g, bandSeen: false })).toEqual({ line: false, next: true });
    expect(turnMay({ ...g, answered: false })).toEqual({ line: false, next: false });
    expect(turnMay({ ...g, interactive: false })).toEqual({ line: false, next: false });
    expect(turnMay({ ...g, hidden: true })).toEqual({ line: false, next: false });
  });
  test('each skip names why', () => {
    expect(skipReason({ ...g, answered: false })).toBe('not an answered turn');
    expect(skipReason({ ...g, interactive: false })).toBe('headless');
    expect(skipReason({ ...g, hidden: true })).toBe('hidden');
    expect(skipReason({ ...g, quips: false, suggestions: false })).toBe('quips and suggestions off');
    expect(skipReason({ ...g, bandSeen: false, suggestions: false })).toBe('band never drawn');
  });
  test('the cooldown skip, built as the adapter builds it: suggestions off, a line not yet due', () => {
    const v = validateCharacter(raw());
    if (!v.ok) throw new Error(v.error);
    const b = createBrain(v.character, true);
    const gate = { ...g, suggestions: false };
    const may = turnMay(gate);
    expect(endTurn(b, may.line, 60).lineDue).toBe(true);
    const { lineDue } = endTurn(b, may.line, 60);
    expect({ line: lineDue, next: may.next }).toEqual({ line: false, next: false });
    expect(skipReason(gate)).toBe('cooldown');
  });
});

describe('the request timeout', () => {
  test('5 s past what is left of the deadline when the request is sent', () => {
    expect(requestTimeoutMs(30_000, 0)).toBe(35_000);
    expect(requestTimeoutMs(90_000, 60_000)).toBe(35_000);
    expect(requestTimeoutMs(30_000, 45_000)).toBe(5_000);
  });
});

describe('a turn not started by the user', () => {
  test('is never shown to a completion as what the user asked', () => {
    const w = recentTurns([{ prompt: 'hello from a peer', answer: 'Hi, peer.', from: 'peer' }]);
    expect(w).not.toContain('The user asked Claude');
    expect(w).toContain('Claude was sent, not by the user (peer):\nhello from a peer\n\nClaude answered:\nHi, peer.');
  });
});
