import { describe, expect, test } from 'vitest';
import {
  CHARACTER_RULE, ONE_LINE_RULE, SUGGEST_NEXT_PROMPT_MAX_CHARS, TURN_DEADLINE_MS, TURN_MAX_TOKENS, CHAT_TURNS_TO_READ_DEFAULT, CHAT_TURNS_TO_READ_MAX, lostThread, pushTurn, chatTurnsToReadText, oneLine, oneLineSystem, parseTurnReply, questionPrompt, suggestNextPromptText, turnPrompt, turnSystem,
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

describe('rememberedExchanges in the prompts', () => {
  const rememberedExchanges = 'Recently (oldest first):\nYou: remember pineapple\nCat: Noted.';
  test('before the question, with leave to refer back to it', () => {
    const c = questionPrompt('what word', rememberedExchanges);
    expect(c.startsWith(rememberedExchanges)).toBe(true);
    expect(c).toContain('you may refer back to it');
    expect(c.endsWith('The user asks you directly: what word')).toBe(true);
    const tp = turnPrompt({ tools: ['Read'], failures: 0, lastBash: '' }, [{ prompt: 'hi', answer: 'Hello.' }], rememberedExchanges);
    expect(tp.startsWith(rememberedExchanges)).toBe(true);
    expect(tp).toContain('you may refer back to it');
  });
  test('a completion\'s question sees the main chat\'s chatTurnsToRead turns, after the rememberedExchanges and before the question', () => {
    const chatTurns = chatTurnsToReadText([{ prompt: 'build the thing', answer: 'Built it.' }]);
    expect(chatTurns).toContain('The user asked Claude:\nbuild the thing');
    expect(chatTurns).toContain('Claude answered:\nBuilt it.');
    const q = questionPrompt('can you see the main chat?', rememberedExchanges, chatTurns);
    expect(q.startsWith(rememberedExchanges)).toBe(true);
    expect(q.indexOf('Built it.')).toBeGreaterThan(q.indexOf(rememberedExchanges));
    expect(q.endsWith('The user asks you directly: can you see the main chat?')).toBe(true);
    expect(chatTurnsToReadText([])).toBe('');
    expect(questionPrompt('hi', '', '')).toBe('The user asks you directly: hi');
  });
  test('the chatTurnsToRead turns render oldest first, each prompt and answer keeping its end past its cap; the turn prompt reads the same block', () => {
    const turns = [{ prompt: 'first ask', answer: 'first reply' }, { prompt: '', answer: '' }, { prompt: 'third ask', answer: 'third reply' }];
    const w = chatTurnsToReadText(turns);
    expect(w.indexOf('first ask')).toBeLessThan(w.indexOf('first reply'));
    expect(w.indexOf('first reply')).toBeLessThan(w.indexOf('(not seen)'));
    expect(w.indexOf('(no text)')).toBeLessThan(w.indexOf('third ask'));
    expect(w.match(/The user asked Claude:/g)).toHaveLength(3);
    const long = chatTurnsToReadText([{ prompt: `START${'a'.repeat(1500)}END`, answer: `HEAD${'b'.repeat(3000)}TAIL` }]);
    expect(long).toContain(`...${'a'.repeat(1497)}END`);
    expect(long).toContain(`...${'b'.repeat(2996)}TAIL`);
    expect(long).not.toContain('START');
    expect(long).not.toContain('HEAD');
    expect(chatTurnsToReadText([{ prompt: 'p'.repeat(1500), answer: 'a'.repeat(3000) }])).not.toContain('...');
    expect(turnPrompt({ tools: [], failures: 0, lastBash: '' }, turns)).toContain(w);
  });
  test('pushTurn keeps the last CHAT_TURNS_TO_READ_DEFAULT (3) turns, dropping the oldest, never changing the one it is given', () => {
    expect(CHAT_TURNS_TO_READ_DEFAULT).toBe(3);
    const t = (n: number) => ({ prompt: `p${n}`, answer: `a${n}` });
    let turns: ReturnType<typeof t>[] = [];
    for (let n = 1; n <= 3; n++) turns = pushTurn(turns, t(n));
    expect(turns).toEqual([t(1), t(2), t(3)]);
    const before = turns;
    turns = pushTurn(turns, t(4));
    expect(turns).toEqual([t(2), t(3), t(4)]);
    expect(before).toEqual([t(1), t(2), t(3)]);
  });
  test('pushTurn honours a chatTurnsToRead of N from 1 to CHAT_TURNS_TO_READ_MAX (10): the last N turns, oldest first', () => {
    expect(CHAT_TURNS_TO_READ_MAX).toBe(10);
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
  test('no rememberedExchanges: the prompts as before', () => {
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
  test('comes right after the persona: questions and commentAfterEachTurn', () => {
    expect(oneLineSystem('You are X.').startsWith(`You are X.\n\n${CHARACTER_RULE}\n\n`)).toBe(true);
    expect(turnSystem('You are X.', { commentAfterEachTurn: true, suggestNextPrompt: true }).startsWith(`You are X.\n\n${CHARACTER_RULE}\n\n`)).toBe(true);
    expect(turnSystem('You are X.', { commentAfterEachTurn: true, suggestNextPrompt: false }).startsWith(`You are X.\n\n${CHARACTER_RULE}\n\n`)).toBe(true);
  });
  test('a suggestNextPrompt alone is the user\'s own words, not the character\'s: no rule', () => {
    expect(turnSystem('You are X.', { commentAfterEachTurn: false, suggestNextPrompt: true })).not.toContain(CHARACTER_RULE);
  });
});

describe('the end-of-turn call', () => {
  test('the system: the persona, then commentAfterEachTurn in character and suggestNextPrompt in the user\'s own words, NONE only when finished', () => {
    const s = turnSystem('You are X.', { commentAfterEachTurn: true, suggestNextPrompt: true });
    expect(s.startsWith('You are X.\n\n')).toBe(true);
    expect(s).toContain('COMMENT_AFTER_EACH_TURN:');
    expect(s).toContain('at most 20 words');
    expect(s).toContain('SUGGEST_NEXT_PROMPT:');
    expect(s).toContain('the prompt the user is most likely to send Claude next');
    expect(s).toContain("in the user's own words");
    expect(s).toContain('at most 15 words');
    expect(s).toContain('SUGGEST_NEXT_PROMPT: NONE');
    expect(s).toContain('Do not use tools.');
  });
  test('the system asks only for what is wanted', () => {
    const commentOnly = turnSystem('You are X.', { commentAfterEachTurn: true, suggestNextPrompt: false });
    expect(commentOnly).toContain('COMMENT_AFTER_EACH_TURN:');
    expect(commentOnly).not.toContain('SUGGEST_NEXT_PROMPT:');
    const suggestOnly = turnSystem('You are X.', { commentAfterEachTurn: false, suggestNextPrompt: true });
    expect(suggestOnly).toContain('SUGGEST_NEXT_PROMPT:');
    expect(suggestOnly).not.toContain('COMMENT_AFTER_EACH_TURN:');
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
    expect(parseTurnReply('COMMENT_AFTER_EACH_TURN: "Tests are green!"\nSUGGEST_NEXT_PROMPT: commit this')).toEqual({ commentAfterEachTurn: 'Tests are green!', suggestNextPrompt: 'commit this' });
    expect(parseTurnReply('  - comment_after_each_turn: Nice.\n * suggest_next_prompt:  run   the tests ')).toEqual({ commentAfterEachTurn: 'Nice.', suggestNextPrompt: 'run the tests' });
    expect(parseTurnReply('SUGGEST_NEXT_PROMPT: add a test\nCOMMENT_AFTER_EACH_TURN: Onward.')).toEqual({ commentAfterEachTurn: 'Onward.', suggestNextPrompt: 'add a test' });
  });
  test('parseTurnReply: SUGGEST_NEXT_PROMPT NONE, empty or past the cap is no suggestNextPrompt; an empty COMMENT_AFTER_EACH_TURN is no commentAfterEachTurn', () => {
    expect(parseTurnReply('COMMENT_AFTER_EACH_TURN: Done and dusted.\nSUGGEST_NEXT_PROMPT: NONE')).toEqual({ commentAfterEachTurn: 'Done and dusted.', suggestNextPrompt: null });
    expect(parseTurnReply('COMMENT_AFTER_EACH_TURN:\nSUGGEST_NEXT_PROMPT:')).toEqual({ commentAfterEachTurn: null, suggestNextPrompt: null });
    expect(parseTurnReply(`SUGGEST_NEXT_PROMPT: ${'y'.repeat(SUGGEST_NEXT_PROMPT_MAX_CHARS + 1)}`)).toEqual({ commentAfterEachTurn: null, suggestNextPrompt: null });
  });
  test('parseTurnReply: an untagged reply is the commentAfterEachTurn alone', () => {
    expect(parseTurnReply('\n  Quack, that went well.\nmore')).toEqual({ commentAfterEachTurn: 'Quack, that went well.', suggestNextPrompt: null });
    expect(parseTurnReply('')).toEqual({ commentAfterEachTurn: null, suggestNextPrompt: null });
  });
  test('one short call: 120 tokens, 30 s', () => {
    expect(TURN_MAX_TOKENS).toBe(120);
    expect(TURN_DEADLINE_MS).toBe(30_000);
  });
  test('suggestNextPromptText: the first non-empty line, unquoted, whitespace collapsed', () => {
    expect(suggestNextPromptText('\n  "run   the tests"  \nmore')).toBe('run the tests');
    expect(suggestNextPromptText('`commit this`')).toBe('commit this');
    expect(suggestNextPromptText("'fix the\tlinter'")).toBe('fix the linter');
  });
  test('suggestNextPromptText: nothing for an empty reply, NONE in any case, or a line past the cap', () => {
    expect(suggestNextPromptText('')).toBeNull();
    expect(suggestNextPromptText('  \n ')).toBeNull();
    expect(suggestNextPromptText('NONE')).toBeNull();
    expect(suggestNextPromptText('none.')).toBeNull();
    expect(suggestNextPromptText('"None"')).toBeNull();
    expect(suggestNextPromptText('None of the tests ran, rerun them')).toBe('None of the tests ran, rerun them');
    expect(SUGGEST_NEXT_PROMPT_MAX_CHARS).toBe(160);
    expect(suggestNextPromptText('y'.repeat(SUGGEST_NEXT_PROMPT_MAX_CHARS))).toHaveLength(SUGGEST_NEXT_PROMPT_MAX_CHARS);
    expect(suggestNextPromptText('y'.repeat(SUGGEST_NEXT_PROMPT_MAX_CHARS + 1))).toBeNull();
  });
});
import { createBrain, endTurn } from '../plugins/buddy/src/brain.ts';
import { validateCharacter } from '../plugins/buddy/src/character.ts';
import {
  NO_PROMPTS, RETRY_MIN_MS, endPromptTurn, endsConversation, isUserOrigin, requestTimeoutMs, retriesEmpty, skipReason, startPromptTurn, submitPrompt, turnMay, type TurnGate,
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
  const g: TurnGate = { answered: true, hidden: false, interactive: true, bandSeen: true, commentAfterEachTurn: true, suggestNextPrompt: true };
  test('commentAfterEachTurn only once the band has drawn; suggestNextPrompt regardless', () => {
    expect(turnMay(g)).toEqual({ commentAfterEachTurn: true, suggestNextPrompt: true });
    expect(turnMay({ ...g, bandSeen: false })).toEqual({ commentAfterEachTurn: false, suggestNextPrompt: true });
    expect(turnMay({ ...g, answered: false })).toEqual({ commentAfterEachTurn: false, suggestNextPrompt: false });
    expect(turnMay({ ...g, interactive: false })).toEqual({ commentAfterEachTurn: false, suggestNextPrompt: false });
    expect(turnMay({ ...g, hidden: true })).toEqual({ commentAfterEachTurn: false, suggestNextPrompt: false });
  });
  test('each skip names why', () => {
    expect(skipReason({ ...g, answered: false })).toBe('not an answered turn');
    expect(skipReason({ ...g, interactive: false })).toBe('headless');
    expect(skipReason({ ...g, hidden: true })).toBe('hidden');
    expect(skipReason({ ...g, commentAfterEachTurn: false, suggestNextPrompt: false })).toBe('commentAfterEachTurn and suggestNextPrompt off');
    expect(skipReason({ ...g, bandSeen: false, suggestNextPrompt: false })).toBe('band never drawn');
  });
  test('the secondsBetweenComments skip, built as the adapter builds it: suggestNextPrompt off, commentAfterEachTurn not yet due', () => {
    const v = validateCharacter(raw());
    if (!v.ok) throw new Error(v.error);
    const b = createBrain(v.character, true);
    const gate = { ...g, suggestNextPrompt: false };
    const may = turnMay(gate);
    expect(endTurn(b, may.commentAfterEachTurn, 60).commentAfterEachTurnDue).toBe(true);
    const { commentAfterEachTurnDue } = endTurn(b, may.commentAfterEachTurn, 60);
    expect({ commentAfterEachTurn: commentAfterEachTurnDue, suggestNextPrompt: may.suggestNextPrompt }).toEqual({ commentAfterEachTurn: false, suggestNextPrompt: false });
    expect(skipReason(gate)).toBe('secondsBetweenComments');
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
    const w = chatTurnsToReadText([{ prompt: 'hello from a peer', answer: 'Hi, peer.', from: 'peer' }]);
    expect(w).not.toContain('The user asked Claude');
    expect(w).toContain('Claude was sent, not by the user (peer):\nhello from a peer\n\nClaude answered:\nHi, peer.');
  });
});

describe('an empty reply to a question', () => {
  test('is asked once more while enough of the deadline is left', () => {
    expect(retriesEmpty({ isAnswered: false, reason: 'empty-reply' }, 89_000)).toBe(true);
    expect(retriesEmpty({ isAnswered: true, text: '  \n ' }, 89_000)).toBe(true);
  });
  test('never when too little is left, and never for a reply with words or another failure', () => {
    expect(retriesEmpty({ isAnswered: false, reason: 'empty-reply' }, RETRY_MIN_MS - 1)).toBe(false);
    expect(retriesEmpty({ isAnswered: true, text: 'Quack.' }, 89_000)).toBe(false);
    expect(retriesEmpty({ isAnswered: false, reason: 'aborted' }, 89_000)).toBe(false);
    expect(retriesEmpty({ isAnswered: false, reason: 'api-error' }, 89_000)).toBe(false);
  });
});
