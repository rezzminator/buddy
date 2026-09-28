import { describe, expect, test } from 'vitest';
import {
  ASKED_PROMPT_MAX_CHARS, ASKED_PROMPT_RULE, CHARACTER_RULE, ONE_LINE_RULE, SUGGEST_NEXT_PROMPT_MAX_CHARS, TURN_DEADLINE_MS, TURN_MAX_TOKENS, DESIRE_MAX_CHARS, VERDICTS, lostThread, memoryRule, oneLine, oneLineSystem, parseAskReply, parseTurnReply, parseWatchReply, questionPrompt, suggestNextPromptText, turnPrompt, turnSystem, watchSystem,
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
    expect(turnSystem('You are X.')).not.toContain('short-term memory');
    expect(watchSystem('You are X.')).not.toContain('short-term memory');
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
  test('comes right after the persona: questions, the comment call and the watch call', () => {
    expect(oneLineSystem('You are X.', 4).startsWith(`You are X.\n\n${CHARACTER_RULE}\n\n`)).toBe(true);
    expect(turnSystem('You are X.').startsWith(`You are X.\n\n${CHARACTER_RULE}\n\n`)).toBe(true);
    expect(watchSystem('You are X.').startsWith(`You are X.\n\n${CHARACTER_RULE}\n\n`)).toBe(true);
  });
});

describe('the comment call', () => {
  test('the system: the persona, then one COMMENT_AFTER_EACH_TURN line in character, and nothing of the suggestion', () => {
    const s = turnSystem('You are X.');
    expect(s).toContain('COMMENT_AFTER_EACH_TURN:');
    expect(s).toContain('at most 20 words');
    expect(s).not.toContain('SUGGEST_NEXT_PROMPT');
    expect(s).toContain('Do not use tools.');
  });
  test('parseTurnReply: the tagged line in any case, bullets tolerated, else the first line', () => {
    expect(parseTurnReply('COMMENT_AFTER_EACH_TURN: "Tests are green!"')).toBe('Tests are green!');
    expect(parseTurnReply('  - comment_after_each_turn: Nice.')).toBe('Nice.');
    expect(parseTurnReply('\n  Quack, that went well.\nmore')).toBe('Quack, that went well.');
    expect(parseTurnReply('Why: nobody ran the tests.')).toBe('Why: nobody ran the tests.');
  });
  test('parseTurnReply: an empty reply or tag is no comment', () => {
    expect(parseTurnReply('COMMENT_AFTER_EACH_TURN:')).toBeNull();
    expect(parseTurnReply('')).toBeNull();
  });
});

describe('the watch call: the second brain', () => {
  test('the system: DESIRE, VERDICT (RIGHT, SHORTCUT, WRONG), WHY screamed for WRONG, and the suggestion that follows the verdict', () => {
    const s = watchSystem('You are X.');
    expect(s).toContain("the user's second brain");
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
    expect(s).toContain('Do not use tools.');
    expect(s).not.toContain('last turn');
  });
  test("the last turn's desire is carried, kept unless the chat shows it changed", () => {
    const s = watchSystem('You are X.', 'ship buddy 1.1 with a second brain');
    expect(s).toContain("At the last turn's end you named the user's deepest desire: ship buddy 1.1 with a second brain");
    expect(s).toContain('Keep it unless this chat shows it changed.');
  });
  test('parseWatchReply: the four lines, in any order and case, bullets tolerated', () => {
    expect(parseWatchReply('DESIRE: a release nobody has to roll back\nVERDICT: SHORTCUT\nWHY: called it done without running the suite.\nSUGGEST_NEXT_PROMPT: run the full suite before we call it done')).toEqual({
      desire: 'a release nobody has to roll back', verdict: 'SHORTCUT', why: 'called it done without running the suite.', suggestNextPrompt: 'run the full suite before we call it done',
    });
    expect(parseWatchReply(' - why: DELETING MAIN?!\n * verdict: wrong.\nsuggest_next_prompt:  stop, restore  main\ndesire: keep main safe')).toEqual({
      desire: 'keep main safe', verdict: 'WRONG', why: 'DELETING MAIN?!', suggestNextPrompt: 'stop, restore main',
    });
  });
  test('parseWatchReply: an unknown verdict, an empty line, NONE, or a line past its cap is none', () => {
    expect(parseWatchReply('VERDICT: MAYBE\nWHY:\nSUGGEST_NEXT_PROMPT: NONE')).toEqual({ desire: null, verdict: null, why: null, suggestNextPrompt: null });
    expect(parseWatchReply(`DESIRE: ${'d'.repeat(DESIRE_MAX_CHARS + 1)}\nSUGGEST_NEXT_PROMPT: ${'y'.repeat(SUGGEST_NEXT_PROMPT_MAX_CHARS + 1)}`)).toEqual({ desire: null, verdict: null, why: null, suggestNextPrompt: null });
    expect(parseWatchReply('')).toEqual({ desire: null, verdict: null, why: null, suggestNextPrompt: null });
    expect(VERDICTS).toEqual(['RIGHT', 'SHORTCUT', 'WRONG']);
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
