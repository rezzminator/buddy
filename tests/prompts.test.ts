import { describe, expect, test } from 'vitest';
import {
  ASKED_PROMPT_MAX_CHARS, ASKED_PROMPT_RULE, CHARACTER_RULE, ONE_LINE_RULE, SUGGEST_NEXT_PROMPT_MAX_CHARS, TURN_DEADLINE_MS, TURN_MAX_TOKENS, DESIRE_MAX_CHARS, MEMORY_LINE, VERDICTS, lostThread, memoryRule, oneLine, oneLineSystem, parseAskReply, parseTurnReply, questionPrompt, suggestNextPromptText, turnPrompt, turnSystem,
} from '../plugins/buddy/src/prompts.ts';

describe('prompts', () => {
  test('a question asking for a prompt: the answer its untagged line, the prompt its SUGGEST_NEXT_PROMPT line, one too long said so', () => {
    expect(parseAskReply('Quote the turn verbatim.\nSUGGEST_NEXT_PROMPT: "design the ledger extractive"')).toEqual({ answer: 'Quote the turn verbatim.', prompt: 'design the ledger extractive', tooLong: false });
    expect(parseAskReply('SUGGEST_NEXT_PROMPT: run it\nFine.')).toEqual({ answer: 'Fine.', prompt: 'run it', tooLong: false });
    expect(parseAskReply('Just an answer.')).toEqual({ answer: 'Just an answer.', prompt: null, tooLong: false });
    expect(parseAskReply('Nope.\nSUGGEST_NEXT_PROMPT: NONE')).toEqual({ answer: 'Nope.', prompt: null, tooLong: false });
    const long = 'x '.repeat(ASKED_PROMPT_MAX_CHARS).trim();
    expect(parseAskReply(`Here.\nSUGGEST_NEXT_PROMPT: ${long}`)).toEqual({ answer: 'Here.', prompt: null, tooLong: true });
  });
  test('the completion system and prompt', () => {
    expect(oneLineSystem('You are X.', 4)).toBe(`You are X.\n\n${CHARACTER_RULE}\n\n${memoryRule(4)}\n\n${ONE_LINE_RULE} ${ASKED_PROMPT_RULE}`);
    expect(questionPrompt('hi')).toBe('The user asks you directly: hi');
  });
  test('the turn prompt counts tools and caps the command', () => {
    const p = turnPrompt({ tools: ['Bash', 'Read', 'Bash'], failures: 1, lastBash: 'x'.repeat(200), actions: [] });
    expect(p).toContain(`Tools used: Bash x2, Read. Failures: 1. Last shell command: ${'x'.repeat(120)}.`);
    expect(turnPrompt({ tools: [], failures: 0, lastBash: '', actions: [] })).toBe('In the turn that just ended: Tools used: none. Failures: 0. Last shell command: none.');
  });
  test('oneLine takes the first non-empty line, unquoted, capped', () => {
    expect(oneLine('\n  "Hello there."  \nmore')).toBe('Hello there.');
    expect(oneLine('')).toBe('');
    expect(oneLine('y'.repeat(3000))).toHaveLength(3000);
  });
  test('lostThread', () => {
    expect(lostThread('Fixy', 'api-error')).toBe("Fixy couldn't answer: api-error");
  });
});

describe('chatTurnsToRead in the prompts', () => {
  const chatTurnsToRead = 'What you remember, oldest first:\n\nTurn 1. The user asked Claude:\nbuild it\nClaude answered:\nBuilt.\n- The user asked you: remember pineapple\n  You answered: Noted.';
  test('before the question and before what the turn did, set apart by a blank line', () => {
    expect(questionPrompt('what word', chatTurnsToRead)).toBe(`${chatTurnsToRead}\n\nThe user asks you directly: what word`);
    const tp = turnPrompt({ tools: ['Read'], failures: 0, lastBash: '', actions: [] }, chatTurnsToRead);
    expect(tp).toBe(`${chatTurnsToRead}\n\nIn the turn that just ended: Tools used: Read. Failures: 0. Last shell command: none.`);
  });
  test('nothing remembered: the question alone', () => {
    expect(questionPrompt('hi', '')).toBe('The user asks you directly: hi');
  });
});

describe('the memory rule', () => {
  test('names how far the memory reaches, and tells the character to say it does not remember, never to make it up', () => {
    expect(memoryRule(4)).toContain("you remember only the main chat's last 4 turns and what you and the user said around them");
    expect(memoryRule(1)).toContain("the main chat's last turn and");
    expect(memoryRule(4)).toContain("say in character that your short-term memory doesn't reach that far");
    expect(memoryRule(4)).toContain('never guess it or make it up');
  });
  test('a question is told its reach; a comment is not asked anything', () => {
    expect(oneLineSystem('You are X.', 7)).toContain(memoryRule(7));
    expect(turnSystem('You are X.', { commentAfterEachTurn: true, suggestNextPrompt: true })).not.toContain('short-term memory');
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
  test('comes right after the persona: questions and the end-of-turn call, whatever it is asked for', () => {
    expect(oneLineSystem('You are X.', 4).startsWith(`You are X.\n\n${CHARACTER_RULE}\n\n`)).toBe(true);
    for (const wants of [{ commentAfterEachTurn: true, suggestNextPrompt: true }, { commentAfterEachTurn: true, suggestNextPrompt: false }, { commentAfterEachTurn: false, suggestNextPrompt: true }]) {
      expect(turnSystem('You are X.', wants).startsWith(`You are X.\n\n${CHARACTER_RULE}\n\n`)).toBe(true);
    }
  });
});

describe('the end-of-turn call: the character and the suggestion combined', () => {
  test('the system asks only for what is wanted: the comment alone, the second brain alone, or both', () => {
    const commentOnly = turnSystem('You are X.', { commentAfterEachTurn: true, suggestNextPrompt: false });
    expect(commentOnly).toContain('COMMENT_AFTER_EACH_TURN: your own reaction to the turn, in character, one line, at most 20 words.');
    for (const tag of ['DESIRE:', 'VERDICT:', 'WHY:', 'SUGGEST_NEXT_PROMPT:', 'second brain']) expect(commentOnly).not.toContain(tag);
    const brainOnly = turnSystem('You are X.', { commentAfterEachTurn: false, suggestNextPrompt: true });
    for (const tag of ['DESIRE:', 'VERDICT:', 'WHY:', 'SUGGEST_NEXT_PROMPT:', "the user's second brain"]) expect(brainOnly).toContain(tag);
    expect(brainOnly).not.toContain('COMMENT_AFTER_EACH_TURN:');
    expect(turnSystem('You are X.', { commentAfterEachTurn: true, suggestNextPrompt: true })).toContain('Do not use tools.');
  });
  test('both: the judgement first, then the comment knowing it, then the suggestion that follows the verdict', () => {
    const s = turnSystem('You are X.', { commentAfterEachTurn: true, suggestNextPrompt: true });
    const at = ['DESIRE:', 'VERDICT:', 'WHY:', 'COMMENT_AFTER_EACH_TURN:', 'SUGGEST_NEXT_PROMPT:'].map((t) => s.indexOf(t));
    expect(at.every((n, i) => n >= 0 && (i === 0 || n > at[i - 1]!))).toBe(true);
    expect(s).toContain('knowing your verdict, never repeating WHY');
    expect(s).toContain('DESIRE: what the user most deeply wants');
    expect(s).toContain('VERDICT: RIGHT, SHORTCUT or WRONG');
    expect(s).toContain('"done" claimed without evidence');
    expect(s).toContain('a destructive or irreversible step');
    expect(s).toContain('For WRONG, scream it');
    expect(s).toContain('SUGGEST_NEXT_PROMPT: the prompt the user should send Claude next');
    expect(s).toContain("in the user's own words");
    expect(s).toContain('After RIGHT, say yes');
    expect(s).toContain('after WRONG, stop Claude');
    expect(s).toContain('SUGGEST_NEXT_PROMPT: NONE');
    expect(s).not.toContain('you named the user');
  });
  test("the last turn's desire is carried, kept unless the chat shows it changed; never without the second brain", () => {
    const s = turnSystem('You are X.', { commentAfterEachTurn: true, suggestNextPrompt: true }, 'ship buddy 1.1 with a second brain');
    expect(s).toContain("At the last turn's end you named the user's deepest desire: ship buddy 1.1 with a second brain");
    expect(s).toContain('Keep it unless this chat shows it changed.');
    expect(turnSystem('You are X.', { commentAfterEachTurn: true, suggestNextPrompt: false }, 'ship it')).not.toContain('ship it');
  });
  test('parseTurnReply: every line, in any order and case, bullets tolerated', () => {
    expect(parseTurnReply('DESIRE: a release nobody has to roll back\nVERDICT: SHORTCUT\nWHY: called it done without running the suite.\nCOMMENT_AFTER_EACH_TURN: "Tests are green?"\nSUGGEST_NEXT_PROMPT: run the full suite before we call it done')).toEqual({
      commentAfterEachTurn: 'Tests are green?', desire: 'a release nobody has to roll back', verdict: 'SHORTCUT', why: 'called it done without running the suite.', suggestNextPrompt: 'run the full suite before we call it done', memory: null,
    });
    expect(parseTurnReply(' - why: DELETING MAIN?!\n * verdict: wrong.\nsuggest_next_prompt:  stop, restore  main\ndesire: keep main safe\n  - comment_after_each_turn: Nice.')).toEqual({
      commentAfterEachTurn: 'Nice.', desire: 'keep main safe', verdict: 'WRONG', why: 'DELETING MAIN?!', suggestNextPrompt: 'stop, restore main', memory: null,
    });
  });
  test('parseTurnReply: an unknown verdict, an empty line, NONE, or a line past its cap is none; an untagged reply is the comment alone', () => {
    const none = { commentAfterEachTurn: null, desire: null, verdict: null, why: null, suggestNextPrompt: null, memory: null };
    expect(parseTurnReply('COMMENT_AFTER_EACH_TURN:\nVERDICT: MAYBE\nWHY:\nSUGGEST_NEXT_PROMPT: NONE')).toEqual(none);
    expect(parseTurnReply(`DESIRE: ${'d'.repeat(DESIRE_MAX_CHARS + 1)}\nSUGGEST_NEXT_PROMPT: ${'y'.repeat(SUGGEST_NEXT_PROMPT_MAX_CHARS + 1)}`)).toEqual(none);
    expect(parseTurnReply('\n  Quack, that went well.\nmore')).toEqual({ ...none, commentAfterEachTurn: 'Quack, that went well.' });
    expect(parseTurnReply('')).toEqual(none);
    expect(VERDICTS).toEqual(['RIGHT', 'SHORTCUT', 'WRONG']);
  });
  test('MEMORY: asked for last in every end-of-turn system, whatever else is wanted: the whole memory, rewritten, up to NOTES_MAX lines', () => {
    for (const wants of [{ commentAfterEachTurn: true, suggestNextPrompt: true }, { commentAfterEachTurn: true, suggestNextPrompt: false }, { commentAfterEachTurn: false, suggestNextPrompt: true }]) {
      const s = turnSystem('You are X.', wants);
      expect(s).toContain(MEMORY_LINE);
      expect(s.indexOf('MEMORY:')).toBeGreaterThan(s.lastIndexOf('COMMENT_AFTER_EACH_TURN:'));
      expect(s.indexOf('MEMORY:')).toBeGreaterThan(s.lastIndexOf('SUGGEST_NEXT_PROMPT:'));
    }
    expect(MEMORY_LINE).toContain('Write up to 6 MEMORY lines');
    expect(MEMORY_LINE).toContain('Keep what still matters, edit what changed, drop what no longer holds, add what this turn taught you');
    expect(MEMORY_LINE).toContain('MEMORY: NONE');
  });
  test('parseTurnReply: every MEMORY line is a note, cleaned; NONE alone forgets them; no MEMORY line keeps them (null)', () => {
    expect(parseTurnReply('COMMENT_AFTER_EACH_TURN: Hi.\nMEMORY: Wants main safe.\n- memory: - Tests before tags.\nMEMORY: Wants main safe.').memory).toEqual(['Wants main safe.', 'Tests before tags.']);
    expect(parseTurnReply('COMMENT_AFTER_EACH_TURN: Hi.\nMEMORY: NONE').memory).toEqual([]);
    expect(parseTurnReply('COMMENT_AFTER_EACH_TURN: Hi.').memory).toBeNull();
    expect(parseTurnReply(Array.from({ length: 8 }, (_, i) => `MEMORY: note ${i}.`).join('\n')).memory).toHaveLength(6);
  });
  test('one short call: 120 tokens, 30 s', () => {
    expect(TURN_MAX_TOKENS).toBe(2048);
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
    expect(SUGGEST_NEXT_PROMPT_MAX_CHARS).toBe(200);
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
  test('the user\'s own origins: the terminal, Remote Control, an SDK host, the owner\'s Slack ping, a continuation of the user\'s own action', () => {
    expect(['composer', 'bridge', 'sdk', 'slack-ping', 'auto-continuation'].every(isUserOrigin)).toBe(true);
    expect(['peer', 'task-notification', 'plugin', 'unclassified', 'scheduled-trigger', 'channel'].some(isUserOrigin)).toBe(false);
  });
  test('a submission never matches the turn it was typed over, even with the same text', () => {
    // A continuation turn carries '' and an image-only prompt typed over it carries '' too.
    let l = startPromptTurn(NO_PROMPTS, 't1', '');
    l = submitPrompt(l, '', 'composer', 't1');
    expect(endPromptTurn(l, 't1').from).toBe('unknown');
  });
  test('a user prompt delivered into a running turn, which started no turn, never gives its origin to a later turn of the same text', () => {
    let l = startPromptTurn(submitPrompt(NO_PROMPTS, 'P1', 'composer'), 't1', 'P1');
    // Typed over t1 and delivered into it: no turn.start of its own.
    l = submitPrompt(l, 'yes', 'composer', 't1');
    l = endPromptTurn(l, 't1').ledger;
    // A peer's 'yes' arrives idle: its turn.start comes first, inside prompt.submit's next.
    l = startPromptTurn(l, 't2', 'yes');
    l = submitPrompt(l, 'yes', 'peer');
    expect(endPromptTurn(l, 't2').from).toBe('peer');
    // The user's own next 'yes' is the user's.
    l = startPromptTurn(endPromptTurn(l, 't2').ledger, 't3', 'yes');
    l = submitPrompt(l, 'yes', 'composer');
    expect(filed(endPromptTurn(l, 't3'))).toEqual({ prompt: 'yes', from: undefined });
  });
  test('prompts left waiting when a turn starts from another are dropped: none is handed to a later turn', () => {
    let l = startPromptTurn(submitPrompt(NO_PROMPTS, 'P1', 'composer'), 't1', 'P1');
    l = submitPrompt(l, 'again', 'composer', 't1');
    l = endPromptTurn(l, 't1').ledger;
    // t2 was started by something else (its submission never seen): 'again' was delivered into t1.
    l = startPromptTurn(l, 't2', 'a task finished');
    l = endPromptTurn(l, 't2').ledger;
    l = startPromptTurn(l, 't3', 'again');
    expect(endPromptTurn(l, 't3').from).toBe('unknown');
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
