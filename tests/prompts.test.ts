import { describe, expect, test } from 'vitest';
import {
  ASKED_PROMPT_MAX_CHARS, ASKED_PROMPT_RULE, CHARACTER_RULE, ONE_LINE_RULE, SUGGEST_NEXT_PROMPT_MAX_CHARS, TURN_DEADLINE_MS, TURN_MAX_TOKENS, DESIRE_MAX_CHARS, JUST_ENDED, MEMORY_LINE, TAKEN_SUGGESTION_CONTEXT, EXTENDED_SUGGESTION_CONTEXT, VERDICTS, lostThread, memoryRule, oneLine, oneLineSystem, parseAskReply, parseTurnReply, questionPrompt, suggestNextPromptText, turnPrompt, turnSystem, isOwnPrompt,
} from '../plugins/buddy/src/prompts.ts';
import { ITEM_CAPS, ITEMS_HEAD } from '../plugins/buddy/src/memoryItems.ts';

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
  test('the turn prompt counts tools and keeps the start and end of a long command', () => {
    const p = turnPrompt({ tools: ['Bash', 'Read', 'Bash'], failures: 1, lastBash: 'x'.repeat(200), actions: [] });
    expect(p).toContain(`Tools used: Bash x2, Read. Failures: 1. Last shell command: ${'x'.repeat(200)}.`);
    const long = `rsync -a src/ dst/ && ${'y'.repeat(600)} | grep -vE '(daemon|bg-spare)'`;
    expect(turnPrompt({ tools: ['Bash'], failures: 0, lastBash: long, actions: [] })).toContain(`Last shell command: ${long.slice(0, 240)} [cut] ${long.slice(-120)}.`);
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
  const chatTurnsToRead = 'What you remember, oldest first:\n\nTurn 1. The user asked Claude:\nsuggested: none\nsent: build it\nClaude answered:\nBuilt.\n- The user asked you: remember pineapple\n  You answered: Noted.';
  test('before the question and before what the turn did, set apart by a blank line', () => {
    expect(questionPrompt('what word', chatTurnsToRead)).toBe(`${chatTurnsToRead}\n\nThe user asks you directly: what word`);
    const tp = turnPrompt({ tools: ['Read'], failures: 0, lastBash: '', actions: [] }, chatTurnsToRead);
    expect(tp).toBe(`${chatTurnsToRead}\n\nIn the turn that just ended: Tools used: Read. Failures: 0. Last shell command: none.`);
  });
  test('a memory holding the turn just ended is pointed to, never repeated; an empty one still gets what the turn did', () => {
    const t = { tools: ['Read'], failures: 0, lastBash: '', actions: [] };
    expect(turnPrompt(t, chatTurnsToRead, true)).toBe(`${chatTurnsToRead}\n\n${JUST_ENDED}`);
    expect(turnPrompt(t, '', true)).toBe('In the turn that just ended: Tools used: Read. Failures: 0. Last shell command: none.');
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
    expect(turnSystem('You are X.', { commentAfterEachTurn: true, suggestNextPrompt: true, promptToMainChat: false })).not.toContain('short-term memory');
  });
});

describe('the character rule', () => {
  test('says a [cut] hides the unknown and uncut text is whole, wherever the character speaks', () => {
    const sentence = 'Text marked [cut] was shortened before you read it, and a size in brackets tells how much there was: what a cut hides is unknown, neither missing nor there; text with no cut is whole, so what it leaves out is truly left out.';
    expect(oneLineSystem('You are X.', 4)).toContain(sentence);
    expect(turnSystem('You are X.', { commentAfterEachTurn: true, suggestNextPrompt: true, promptToMainChat: true })).toContain(sentence);
  });
  test('says: become the character, one useful thing both missed, the character is HOW never WHAT, no repeating', () => {
    expect(CHARACTER_RULE).toMatch(/completely/);
    expect(CHARACTER_RULE).toMatch(/ONE thing/);
    expect(CHARACTER_RULE).toMatch(/both the user and the assistant/);
    expect(CHARACTER_RULE).toMatch(/a risk, a gap, a wrong assumption/);
    expect(CHARACTER_RULE).toMatch(/HOW.*never WHAT/);
    expect(CHARACTER_RULE).toMatch(/repeat/);
  });
  test("states as fact only what the chat shows or what is generally true: a guess about the chat's own state is asked, or named as the check that settles it", () => {
    expect(CHARACTER_RULE).toContain('State as fact only what the chat shows or what is generally true');
    expect(CHARACTER_RULE).toContain("ask a guess about this chat's own state (a file, a process, what someone did) as a question, or name the check that settles it");
  });
  test("the end-of-turn call is told only what was sent is the user's ask, never a suggestion not taken, whatever it is asked for", () => {
    const sentence = "In the turns you remember, the user's ask is only what was sent: a suggestion marked not taken never reached Claude and is never the user's ask, order or approval.";
    for (const c of [true, false]) for (const g of [true, false]) for (const p of [true, false]) {
      expect(turnSystem('You are X.', { commentAfterEachTurn: c, suggestNextPrompt: g, promptToMainChat: p })).toContain(sentence);
    }
  });
  test('comes right after the persona: questions and the end-of-turn call, whatever it is asked for', () => {
    expect(oneLineSystem('You are X.', 4).startsWith(`You are X.\n\n${CHARACTER_RULE}\n\n`)).toBe(true);
    for (const wants of [{ commentAfterEachTurn: true, suggestNextPrompt: true, promptToMainChat: false }, { commentAfterEachTurn: true, suggestNextPrompt: false, promptToMainChat: false }, { commentAfterEachTurn: false, suggestNextPrompt: true, promptToMainChat: false }]) {
      expect(turnSystem('You are X.', wants).startsWith(`You are X.\n\n${CHARACTER_RULE}\n\n`)).toBe(true);
    }
  });
});

describe('the end-of-turn call: the character and the suggestion combined', () => {
  test('the system asks only for what is wanted: the comment alone, the second brain alone, or both', () => {
    const commentOnly = turnSystem('You are X.', { commentAfterEachTurn: true, suggestNextPrompt: false, promptToMainChat: false });
    expect(commentOnly).toContain('COMMENT_AFTER_EACH_TURN: your own reaction to the turn, in character, one line, at most 20 words.');
    for (const tag of ['DESIRE:', 'VERDICT:', 'WHY:', 'SUGGEST_NEXT_PROMPT:', 'second brain']) expect(commentOnly).not.toContain(tag);
    const brainOnly = turnSystem('You are X.', { commentAfterEachTurn: false, suggestNextPrompt: true, promptToMainChat: false });
    for (const tag of ['DESIRE:', 'VERDICT:', 'WHY:', 'SUGGEST_NEXT_PROMPT:', "the user's second brain"]) expect(brainOnly).toContain(tag);
    expect(brainOnly).not.toContain('COMMENT_AFTER_EACH_TURN:');
    expect(turnSystem('You are X.', { commentAfterEachTurn: true, suggestNextPrompt: true, promptToMainChat: false })).toContain('Do not use tools.');
  });
  test('both: the judgement first, then the comment knowing it, then the suggestion that follows the verdict', () => {
    const s = turnSystem('You are X.', { commentAfterEachTurn: true, suggestNextPrompt: true, promptToMainChat: false });
    const at = ['DESIRE:', 'VERDICT:', 'WHY:', 'COMMENT_AFTER_EACH_TURN:', 'SUGGEST_NEXT_PROMPT:'].map((t) => s.indexOf(t));
    expect(at.every((n, i) => n >= 0 && (i === 0 || n > at[i - 1]!))).toBe(true);
    expect(s).toContain('knowing your verdict, never repeating WHY');
    expect(s).toContain('DESIRE: what the user most deeply wants');
    expect(s).toContain('VERDICT: RIGHT, SHORTCUT or WRONG');
    expect(s).toContain('"done" claimed without evidence');
    expect(s).toContain('a destructive or irreversible step');
    expect(s).toContain('For WRONG, scream it');
    expect(s).toContain('SUGGEST_NEXT_PROMPT: the prompt the user should send Claude next');
    expect(s).toContain('After RIGHT, say yes');
    expect(s).toContain('after WRONG, stop Claude');
    expect(s).toContain('SUGGEST_NEXT_PROMPT: NONE');
    expect(s).not.toContain('you named the user');
  });
  test("the suggestion asks, instructs or decides: every fact in it already in the chat, never the user's report of what they did", () => {
    const s = turnSystem('You are X.', { commentAfterEachTurn: true, suggestNextPrompt: true, promptToMainChat: false });
    expect(s).not.toContain("in the user's own words");
    expect(s).toContain('It asks, instructs or decides, and every fact in it is already in the chat');
    expect(s).toContain('It asks, instructs or decides, and every fact in it is already in the chat: the user may send it with one key, unread, so it never reports what the user did, ran, saw or saved, and never puts an approval, a ruling or an observation in the user\'s mouth (no "approved", "as I said", "I checked", "looks right"): it asks for the step instead. ');
    expect(s).toContain("When the next step is the user's own");
    expect(s).toContain('suggest what they would ask Claude about it');
    expect(ASKED_PROMPT_RULE).not.toContain("in the user's own words");
    expect(ASKED_PROMPT_RULE).toContain('it asks, instructs or decides, stating no fact the chat has not shown');
  });
  test("a taken suggestion's context tells Claude its claims are the buddy's guess, to check, and never the user's ruling", () => {
    expect(TAKEN_SUGGESTION_CONTEXT).toBe(
      "This prompt is the buddy's suggestion, a plugin's guess at the user's next prompt, sent by the user unedited. Any claim in it about what the user did, ran, saw or saved is the buddy's guess, not the user's report: check it before acting on it. Never record it, or any part of it, as the user's ruling, order or approval.",
    );
  });
  test("an extended suggestion's context tells Claude only the added words are the user's", () => {
    expect(EXTENDED_SUGGESTION_CONTEXT).toBe(
      "This prompt starts with the buddy's suggestion, a plugin's guess at the user's next prompt, and the user added words of their own after it. Any claim in the suggested part about what the user did, ran, saw or saved is the buddy's guess, not the user's report: check it before acting on it. Only the added words are the user's: never record the suggested part as the user's ruling, order or approval.",
    );
  });
  test("the last turn's desire is carried, kept unless the chat shows it changed; never without the second brain", () => {
    const s = turnSystem('You are X.', { commentAfterEachTurn: true, suggestNextPrompt: true, promptToMainChat: false }, 'ship buddy 1.1 with a second brain');
    expect(s).toContain("At the last turn's end you named the user's deepest desire: ship buddy 1.1 with a second brain");
    expect(s).toContain("Keep it while the user's work still serves it; when the user turns to other work, name what that work is for.");
    expect(turnSystem('You are X.', { commentAfterEachTurn: true, suggestNextPrompt: false, promptToMainChat: false }, 'ship it')).not.toContain('ship it');
  });
  test('parseTurnReply: every line, in any order and case, bullets tolerated', () => {
    expect(parseTurnReply('DESIRE: a release nobody has to roll back\nVERDICT: SHORTCUT\nWHY: called it done without running the suite.\nCOMMENT_AFTER_EACH_TURN: "Tests are green?"\nSUGGEST_NEXT_PROMPT: run the full suite before we call it done')).toEqual({
      commentAfterEachTurn: 'Tests are green?', desire: 'a release nobody has to roll back', verdict: 'SHORTCUT', why: 'called it done without running the suite.', suggestNextPrompt: 'run the full suite before we call it done', promptToMainChat: null, ruleBroken: null, memory: null,
    });
    expect(parseTurnReply(' - why: DELETING MAIN?!\n * verdict: wrong.\nsuggest_next_prompt:  stop, restore  main\ndesire: keep main safe\n  - comment_after_each_turn: Nice.')).toEqual({
      commentAfterEachTurn: 'Nice.', desire: 'keep main safe', verdict: 'WRONG', why: 'DELETING MAIN?!', suggestNextPrompt: 'stop, restore main', promptToMainChat: null, ruleBroken: null, memory: null,
    });
  });
  test('parseTurnReply: an unknown verdict, an empty line, NONE, or a line past its cap is none; an untagged reply is the comment alone', () => {
    const none = { commentAfterEachTurn: null, desire: null, verdict: null, why: null, suggestNextPrompt: null, promptToMainChat: null, ruleBroken: null, memory: null };
    expect(parseTurnReply('COMMENT_AFTER_EACH_TURN:\nVERDICT: MAYBE\nWHY:\nSUGGEST_NEXT_PROMPT: NONE')).toEqual(none);
    expect(parseTurnReply(`DESIRE: ${'d'.repeat(DESIRE_MAX_CHARS + 1)}\nSUGGEST_NEXT_PROMPT: ${'y'.repeat(SUGGEST_NEXT_PROMPT_MAX_CHARS + 1)}`)).toEqual(none);
    expect(parseTurnReply('\n  Quack, that went well.\nmore')).toEqual({ ...none, commentAfterEachTurn: 'Quack, that went well.' });
    expect(parseTurnReply('')).toEqual(none);
    expect(VERDICTS).toEqual(['RIGHT', 'SHORTCUT', 'WRONG']);
  });
  test("MEMORY: asked for last in every end-of-turn system, whatever else is wanted: R3's paragraph, one JSON object keyed by item, the caps as the code holds them", () => {
    for (const wants of [{ commentAfterEachTurn: true, suggestNextPrompt: true, promptToMainChat: false }, { commentAfterEachTurn: true, suggestNextPrompt: false, promptToMainChat: false }, { commentAfterEachTurn: false, suggestNextPrompt: true, promptToMainChat: false }]) {
      const s = turnSystem('You are X.', wants);
      expect(s).toContain(MEMORY_LINE);
      expect(s.indexOf(MEMORY_LINE)).toBeGreaterThan(s.lastIndexOf('COMMENT_AFTER_EACH_TURN:'));
      expect(s.indexOf(MEMORY_LINE)).toBeGreaterThan(s.lastIndexOf('SUGGEST_NEXT_PROMPT:'));
    }
    expect(MEMORY_LINE.startsWith('MEMORY: your memory of this chat is the list under "Your memory"')).toBe(true);
    expect(MEMORY_LINE).toContain('one item per line as key · text or words · from · age');
    expect(MEMORY_LINE).toContain('MEMORY: {} changes nothing');
    expect(MEMORY_LINE).toContain('{"end": "done|met|lifted|stale|wrong: why"}');
    expect(MEMORY_LINE).toContain(`rule ${ITEM_CAPS.rule}, open ${ITEM_CAPS.open}, fact ${ITEM_CAPS.fact}, lesson ${ITEM_CAPS.lesson} and doubt ${ITEM_CAPS.doubt}`);
    expect(MEMORY_LINE).toContain('Never write a JSON list.');
    expect(ITEMS_HEAD.startsWith('Your memory (')).toBe(true);
  });
  test.each([
    ['COMMENT_AFTER_EACH_TURN: Hi.\nMEMORY: {"fact.x":{"text":"x"}}  ', '{"fact.x":{"text":"x"}}'],
    ['MEMORY: {}\nMEMORY: {"fact.y":{"text":"y"}}', '{}'],
    ['- memory: {"fact.x":{"text":"x"}}', '{"fact.x":{"text":"x"}}'],
    ['COMMENT_AFTER_EACH_TURN: Hi.', null],
    ['Hi.', null],
  ])('parseTurnReply keeps the first MEMORY line verbatim, trimmed: %s', (reply, memory) => {
    expect(parseTurnReply(reply!).memory).toBe(memory);
  });
  test('the rules the audit asked for: nothing invented, no remade point, how not whether, no poll, no secret, a deletion alone', () => {
    expect(CHARACTER_RULE).toContain('When the chat shows nothing missed, say so, or react to what did happen: never invent a miss.');
    expect(CHARACTER_RULE).toContain('nor remake a point of your own (your earlier lines and notes are your views, not evidence) unless this turn brings new evidence for it');
    const s = turnSystem('You are X.', { commentAfterEachTurn: true, suggestNextPrompt: true, promptToMainChat: false }, 'ship it');
    expect(s).toContain("Judge how Claude carried out the ask, never the ask itself: doing what the user ordered, or what your own suggestion they sent asked, the proper way, is RIGHT; a step Claude only proposes, awaiting the user's go, is not taken yet.");
    expect(s).toContain('Never ask whether work Claude left running (a background command or agent, a push, a review) has finished: it reports back by itself');
    expect(s).toContain('Safety first: never suggest searching for, printing, copying or checking a secret (a password, token or key)');
    expect(s).toContain('a deletion is a prompt of its own, naming exactly what it deletes, never bundled with other work');
    expect(memoryRule(4)).toContain("Asked about the main chat's past beyond it");
  });
  test('parseTurnReply keeps a bare MEMORY line as empty text for applyMemory', () => {
    expect(parseTurnReply('VERDICT: RIGHT\nMEMORY:\nWHY: ok').memory).toBe('');
    expect(parseTurnReply('MEMORY: \nWHY: ok').memory).toBe('');
  });
  test('parseTurnReply takes the balanced MEMORY object over several lines, fenced or in backticks', () => {
    const object = '{"fact.x":{"text":"a } inside \\" a string"},"open.y":{"text":"y"}}';
    expect(JSON.parse(parseTurnReply(`COMMENT_AFTER_EACH_TURN: Hi.\nMEMORY:\n{\n  "fact.x": {"text": "x"},\n  "open.y": {"text": "y"}\n}\nWHY: ok`).memory!)).toEqual({ 'fact.x': { text: 'x' }, 'open.y': { text: 'y' } });
    expect(JSON.parse(parseTurnReply(`MEMORY: {\n  "fact.x": {"text": "x"}\n}`).memory!)).toEqual({ 'fact.x': { text: 'x' } });
    expect(JSON.parse(parseTurnReply('MEMORY:\n```json\n{"fact.x": {"text": "x"}}\n```\nVERDICT: RIGHT').memory!)).toEqual({ 'fact.x': { text: 'x' } });
    expect(JSON.parse(parseTurnReply('MEMORY: ```\n{"fact.x":\n {"text": "x"}}\n```').memory!)).toEqual({ 'fact.x': { text: 'x' } });
    expect(parseTurnReply('MEMORY: `{"fact.x":{"text":"x"}}`').memory).toBe('{"fact.x":{"text":"x"}}');
    expect(JSON.parse(parseTurnReply(`MEMORY: ${object}`).memory!)).toEqual(JSON.parse(object));
  });
  test('parseTurnReply: a prose Memory line earlier never hides the MEMORY object after it', () => {
    expect(parseTurnReply('Memory: nothing new worth keeping, I think.\nMEMORY: {"fact.x":{"text":"x"}}').memory).toBe('{"fact.x":{"text":"x"}}');
    expect(parseTurnReply('MEMORY: \nMEMORY: {}').memory).toBe('{}');
  });
  test('parseTurnReply: an object that never closes is kept as its line, for applyMemory to drop', () => {
    expect(parseTurnReply('MEMORY: {"fact.x":{"text":"x"}\nWHY: ok').memory).toBe('{"fact.x":{"text":"x"}');
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
  NO_PROMPTS, RETRY_MIN_MS, deliverPrompts, endPromptTurn, sayInTurn, endsConversation, isUserOrigin, requestTimeoutMs, retriesEmpty, skipReason, startPromptTurn, submitPrompt, turnMay, type TurnGate,
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
  test('a user prompt typed over a running turn records that turn; one entered idle records none', () => {
    const l = startPromptTurn(submitPrompt(NO_PROMPTS, 'P1', 'composer'), 't1', 'P1');
    expect(submitPrompt(l, 'P2', 'composer', 't1').entered).toEqual([{ text: 'P2', over: 't1' }]);
    expect(submitPrompt(NO_PROMPTS, 'P1', 'composer').entered[0]).not.toHaveProperty('over');
  });
  test('a turn\'s next request delivers the prompts typed over it, in order, and only those; with no started entry it leaves them waiting', () => {
    let l = startPromptTurn(submitPrompt(NO_PROMPTS, 'P1', 'composer'), 't1', 'P1');
    l = submitPrompt(l, 'A', 'composer', 't1');
    l = submitPrompt(l, 'idle', 'composer');
    l = submitPrompt(l, 'C', 'composer', 'tX');
    l = submitPrompt(l, 'B', 'composer', 't1');
    // tX has no started entry: nothing moves.
    expect(deliverPrompts(l, 'tX')).toEqual(l);
    let d = deliverPrompts(l, 't1');
    expect(d.entered).toEqual([{ text: 'idle' }, { text: 'C', over: 'tX' }]);
    d = deliverPrompts(submitPrompt(d, 'D', 'composer', 't1'), 't1');
    const ended = endPromptTurn(d, 't1');
    expect(ended).toMatchObject({ prompt: 'P1', added: ['A', 'B', 'D'] });
    expect(ended.from).toBeUndefined();
  });
  test('each delivered prompt records the main-loop tool calls made before it; the positions end with the turn', () => {
    let l = startPromptTurn(submitPrompt(NO_PROMPTS, 'P1', 'composer'), 't1', 'P1');
    l = deliverPrompts(submitPrompt(l, 'A', 'composer', 't1'), 't1', 2);
    l = deliverPrompts(submitPrompt(submitPrompt(l, 'B', 'composer', 't1'), 'C', 'composer', 't1'), 't1', 5);
    expect(endPromptTurn(l, 't1')).toMatchObject({ added: ['A', 'B', 'C'], addedAfter: [2, 5, 5] });
    // No position given: before any tool call.
    const d = deliverPrompts(submitPrompt(startPromptTurn(submitPrompt(NO_PROMPTS, 'P1', 'composer'), 't1', 'P1'), 'A', 'composer', 't1'), 't1');
    expect(endPromptTurn(d, 't1')).toMatchObject({ added: ['A'], addedAfter: [0] });
  });
  test('what Claude wrote mid-turn joins its turn in order with its position; blank text or no entry leaves the ledger', () => {
    let l = startPromptTurn(submitPrompt(NO_PROMPTS, 'P1', 'composer'), 't1', 'P1');
    expect(sayInTurn(l, 't1', '  \n ', 0)).toBe(l);
    expect(sayInTurn(l, 'tX', 'Yes.', 0)).toBe(l);
    l = sayInTurn(sayInTurn(l, 't1', 'Yes, every row.', 0), 't1', 'Now the tests.', 3);
    expect(endPromptTurn(l, 't1')).toMatchObject({ prompt: 'P1', said: [{ after: 0, text: 'Yes, every row.' }, { after: 3, text: 'Now the tests.' }] });
    // A submission settling after the turn began keeps what the turn gathered.
    let late = startPromptTurn(NO_PROMPTS, 't2', 'P2');
    late = sayInTurn(late, 't2', 'Reading.', 1);
    late = submitPrompt(late, 'P2', 'composer');
    expect(endPromptTurn(late, 't2')).toMatchObject({ prompt: 'P2', said: [{ after: 1, text: 'Reading.' }] });
    expect(endPromptTurn(startPromptTurn(NO_PROMPTS, 't3', 'x'), 't3')).not.toHaveProperty('said');
  });
  test('a turn nothing was delivered into ends with no added prompts', () => {
    const l = startPromptTurn(submitPrompt(NO_PROMPTS, 'P1', 'composer'), 't1', 'P1');
    expect(endPromptTurn(deliverPrompts(l, 't1'), 't1')).not.toHaveProperty('added');
  });
  test('a typed-over prompt never delivered still starts its own turn; a delivered one starts none', () => {
    let l = startPromptTurn(submitPrompt(NO_PROMPTS, 'P1', 'composer'), 't1', 'P1');
    l = submitPrompt(l, 'P2', 'composer', 't1');
    l = startPromptTurn(endPromptTurn(l, 't1').ledger, 't2', 'P2');
    expect(filed(endPromptTurn(l, 't2'))).toEqual({ prompt: 'P2', from: undefined });
    let d = startPromptTurn(submitPrompt(NO_PROMPTS, 'P1', 'composer'), 't1', 'P1');
    d = deliverPrompts(submitPrompt(d, 'P2', 'composer', 't1'), 't1');
    d = startPromptTurn(endPromptTurn(d, 't1').ledger, 't2', 'P2');
    expect(endPromptTurn(d, 't2').from).toBe('unknown');
  });
  test('/clear and a resume start a fresh conversation; an exit does not matter', () => {
    expect(endsConversation('clear')).toBe(true);
    expect(endsConversation('resume')).toBe(true);
    expect(endsConversation('prompt_input_exit')).toBe(false);
    expect(endsConversation('other')).toBe(false);
  });
  /** Claude Code's frame around a plugin's prompt submitted without `asUser`, its fixed wording copied from a real session's transcript. */
  const framed = (plugin: string, text: string): string =>
    `The ${plugin} plugin sent a message:\n${text}\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.`;
  const ASK = 'Please draft that correction now, without publishing or committing anything.\n\nThen say which clauses changed.';
  test("the buddy's own prompt, which Claude Code starts its turn wrapped in its plugin frame, is filed as the buddy's, whichever settles first", () => {
    let l = startPromptTurn(submitPrompt(NO_PROMPTS, ASK, BUDDY_PROMPT), 't1', framed('buddy', ASK));
    expect(filed(endPromptTurn(l, 't1'))).toEqual({ prompt: framed('buddy', ASK), from: BUDDY_PROMPT });
    l = submitPrompt(startPromptTurn(NO_PROMPTS, 't2', framed('buddy', ASK)), ASK, BUDDY_PROMPT);
    expect(filed(endPromptTurn(l, 't2'))).toEqual({ prompt: framed('buddy', ASK), from: BUDDY_PROMPT });
  });
  test('a framed turn whose submission was never seen, or only shares words with one, or was the user\'s, stays unknown', () => {
    const turn = framed('buddy', ASK);
    expect(endPromptTurn(startPromptTurn(NO_PROMPTS, 't1', turn), 't1').from).toBe('unknown');
    for (const [text, origin] of [['Please draft that correction now', BUDDY_PROMPT], [`${ASK} Thanks.`, BUDDY_PROMPT], [ASK, 'composer'], [turn.replace('Address the message above.', ''), BUDDY_PROMPT]] as const) {
      expect(endPromptTurn(startPromptTurn(submitPrompt(NO_PROMPTS, text, origin), 't1', turn), 't1').from).toBe('unknown');
      expect(endPromptTurn(submitPrompt(startPromptTurn(NO_PROMPTS, 't1', turn), text, origin), 't1').from).toBe('unknown');
    }
    // A user prompt that is a framed text is the user's own, matched as ever.
    expect(filed(endPromptTurn(startPromptTurn(submitPrompt(NO_PROMPTS, turn, 'composer'), 't1', turn), 't1'))).toEqual({ prompt: turn, from: undefined });
  });
});

describe('the end-of-turn gate', () => {
  const g: TurnGate = { answered: true, hidden: false, interactive: true, bandSeen: true, commentAfterEachTurn: true, suggestNextPrompt: true, promptToMainChat: false, mainChatPromptArmed: false };
  test('commentAfterEachTurn only once the band has drawn; suggestNextPrompt regardless', () => {
    expect(turnMay(g)).toEqual({ commentAfterEachTurn: true, suggestNextPrompt: true, promptToMainChat: false });
    expect(turnMay({ ...g, bandSeen: false })).toEqual({ commentAfterEachTurn: false, suggestNextPrompt: true, promptToMainChat: false });
    expect(turnMay({ ...g, answered: false })).toEqual({ commentAfterEachTurn: false, suggestNextPrompt: false, promptToMainChat: false });
    expect(turnMay({ ...g, interactive: false })).toEqual({ commentAfterEachTurn: false, suggestNextPrompt: false, promptToMainChat: false });
    expect(turnMay({ ...g, hidden: true })).toEqual({ commentAfterEachTurn: false, suggestNextPrompt: false, promptToMainChat: false });
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

import { BUDDY_PROMPT_CONTEXT, PROMPT_TO_MAIN_CHAT_MAX_CHARS, originOf } from '../plugins/buddy/src/prompts.ts';
import { BUDDY_PROMPT } from '../plugins/buddy/src/chatTurnsToRead.ts';

describe('promptToMainChat: a prompt the buddy sends Claude itself', () => {
  const LINE =
    "PROMPT_TO_MAIN_CHAT: a prompt you send Claude yourself, right now, before the user reads on. Send one only on evidence inside this turn that the user's own ask is unmet or unproven: a step marked failed, or failed test runs, that the answer passes over or contradicts (a step marked failed ended in an error, so a result the answer draws from it is unproven, unless the error was the point, such as a crash reproduced or a test watched failing; a step marked \"tests passed, a later command failed\" is no failed test: its tests passed, and only a result drawn from that later command is unproven); a conclusion the answer states (done, installed, verified, none left, all pass) that rests on less than it names, such as a check of some of the items or a change made in one of the places; an instruction in the ask (a stop, a condition, an order) Claude did not follow; a part of the ask the answer never addresses. Your own doubts are never a reason: a better method, a risk that might bite, a hypothesis to test, a tidy-up, a gap Claude named while leaving its conclusion open: those go in SUGGEST_NEXT_PROMPT. Plain words, not in character, at most 40 words: name the evidence, then the one fix or check it needs; it reaches Claude as yours, never as the user's. Write PROMPT_TO_MAIN_CHAT: NONE otherwise.";
  /** The line with suggestNextPrompt off: no SUGGEST_NEXT_PROMPT to route to. */
  const LINE_ALONE = LINE.replace('those go in SUGGEST_NEXT_PROMPT.', 'those never go here.');
  const RULE_LINE =
    'RULE_BROKEN: when your PROMPT_TO_MAIN_CHAT is about an instruction Claude did not follow and that instruction is a rule under "Your memory", that rule\'s key exactly as listed (rule.…); RULE_BROKEN: NONE otherwise.';
  const ADDENDUM = ' After a PROMPT_TO_MAIN_CHAT of yours, write SUGGEST_NEXT_PROMPT: NONE: Claude is about to act on it.';
  test('off, no end-of-turn system prompt asks for or mentions PROMPT_TO_MAIN_CHAT', () => {
    for (const c of [false, true]) for (const g of [false, true]) for (const d of [null, 'a release nobody rolls back']) {
      const s = turnSystem('You are X.', { commentAfterEachTurn: c, suggestNextPrompt: g, promptToMainChat: false }, d);
      expect(s).not.toContain('PROMPT_TO_MAIN_CHAT');
      expect(s).not.toContain('RULE_BROKEN');
    }
  });
  test('on, its line is asked for verbatim, after the comment and before the suggestion, the RULE_BROKEN line right after it', () => {
    const s = turnSystem('You are X.', { commentAfterEachTurn: true, suggestNextPrompt: true, promptToMainChat: true });
    expect(s).toContain(`\n${LINE}\n${RULE_LINE}\n`);
    const at = ['DESIRE:', 'VERDICT:', 'WHY:', 'COMMENT_AFTER_EACH_TURN:', 'PROMPT_TO_MAIN_CHAT: a prompt', 'RULE_BROKEN: when', 'SUGGEST_NEXT_PROMPT: the prompt', 'MEMORY:'].map((t) => s.indexOf(t));
    expect(at.every((n, i) => n >= 0 && (i === 0 || n > at[i - 1]!))).toBe(true);
  });
  test('on with suggestNextPrompt off: the judgement and the second brain still come, no suggestion line, no addendum', () => {
    const s = turnSystem('You are X.', { commentAfterEachTurn: false, suggestNextPrompt: false, promptToMainChat: true }, 'ship it');
    for (const tag of ['DESIRE:', 'VERDICT:', 'WHY:', "the user's second brain", "deepest desire: ship it", `${LINE_ALONE}\n${RULE_LINE}\n`]) expect(s).toContain(tag);
    expect(s).not.toContain('SUGGEST_NEXT_PROMPT');
    expect(s).not.toContain('COMMENT_AFTER_EACH_TURN');
  });
  test("the suggestion's addendum only when both are wanted", () => {
    expect(turnSystem('You are X.', { commentAfterEachTurn: true, suggestNextPrompt: true, promptToMainChat: true })).toContain(`Write SUGGEST_NEXT_PROMPT: NONE when the work is finished, or waiting on such a report with nothing for the user to decide.${ADDENDUM}\n`);
    expect(turnSystem('You are X.', { commentAfterEachTurn: true, suggestNextPrompt: true, promptToMainChat: false })).not.toContain(ADDENDUM);
  });
  test('the reply line: its text, unquoted and one-spaced; NONE, an empty line, none at all or past its cap is null', () => {
    expect(parseTurnReply('COMMENT_AFTER_EACH_TURN: Hm.\nPROMPT_TO_MAIN_CHAT: "run the   tests: you said they pass"\nSUGGEST_NEXT_PROMPT: NONE').promptToMainChat).toBe('run the tests: you said they pass');
    expect(parseTurnReply(' - prompt_to_main_chat: check the diff').promptToMainChat).toBe('check the diff');
    expect(parseTurnReply('PROMPT_TO_MAIN_CHAT: NONE').promptToMainChat).toBeNull();
    expect(parseTurnReply('PROMPT_TO_MAIN_CHAT:\nCOMMENT_AFTER_EACH_TURN: Hm.').promptToMainChat).toBeNull();
    expect(parseTurnReply('COMMENT_AFTER_EACH_TURN: Hm.').promptToMainChat).toBeNull();
    expect(parseTurnReply('Quack.').promptToMainChat).toBeNull();
    expect(PROMPT_TO_MAIN_CHAT_MAX_CHARS).toBe(400);
    expect(parseTurnReply(`PROMPT_TO_MAIN_CHAT: ${'x'.repeat(400)}`).promptToMainChat).toBe('x'.repeat(400));
    expect(parseTurnReply(`PROMPT_TO_MAIN_CHAT: ${'x'.repeat(401)}`).promptToMainChat).toBeNull();
  });
  test("RULE_BROKEN: a rule's key, trimmed; NONE, another kind's key, a malformed key or none at all is null", () => {
    expect(parseTurnReply('PROMPT_TO_MAIN_CHAT: Keep main safe: you pushed.\nRULE_BROKEN:  rule.main-safe ').ruleBroken).toBe('rule.main-safe');
    expect(parseTurnReply(' - rule_broken: rule.main-safe').ruleBroken).toBe('rule.main-safe');
    expect(parseTurnReply('RULE_BROKEN: NONE').ruleBroken).toBeNull();
    expect(parseTurnReply('RULE_BROKEN: none').ruleBroken).toBeNull();
    expect(parseTurnReply('RULE_BROKEN: fact.x').ruleBroken).toBeNull();
    expect(parseTurnReply('RULE_BROKEN: rule.Main Safe').ruleBroken).toBeNull();
    // A key the model decorates still names its rule.
    for (const value of ['rule.main-safe.', '`rule.main-safe`', '"rule.main-safe"', '**rule.main-safe**', 'rule.main-safe (keep main safe)', 'rule.main-safe, pushed anyway', 'rule.main-safe: pushed']) {
      expect(parseTurnReply(`RULE_BROKEN: ${value}`).ruleBroken).toBe('rule.main-safe');
    }
    expect(parseTurnReply('PROMPT_TO_MAIN_CHAT: check the diff').ruleBroken).toBeNull();
    expect(parseTurnReply('Quack.').ruleBroken).toBeNull();
  });
  test('the gate: only armed (a prompt of the user\'s since the last one sent), and only where a call is made', () => {
    const g: TurnGate = { answered: true, hidden: false, interactive: true, bandSeen: true, commentAfterEachTurn: false, suggestNextPrompt: false, promptToMainChat: true, mainChatPromptArmed: true };
    expect(turnMay(g)).toEqual({ commentAfterEachTurn: false, suggestNextPrompt: false, promptToMainChat: true });
    expect(turnMay({ ...g, mainChatPromptArmed: false }).promptToMainChat).toBe(false);
    expect(turnMay({ ...g, promptToMainChat: false }).promptToMainChat).toBe(false);
    expect(turnMay({ ...g, answered: false }).promptToMainChat).toBe(false);
    expect(turnMay({ ...g, hidden: true }).promptToMainChat).toBe(false);
    expect(turnMay({ ...g, interactive: false }).promptToMainChat).toBe(false);
    expect(skipReason({ ...g, mainChatPromptArmed: false })).toBe('promptToMainChat unarmed until the user prompts');
    expect(skipReason({ ...g, promptToMainChat: false })).toBe('commentAfterEachTurn and suggestNextPrompt off');
  });
  test("this plugin's own prompt is BUDDY_PROMPT; another plugin's, or any other, goes by its kind", () => {
    expect(originOf({ kind: 'plugin', name: 'buddy' }, 'buddy')).toBe(BUDDY_PROMPT);
    expect(originOf({ kind: 'plugin', name: 'another' }, 'buddy')).toBe('plugin');
    expect(originOf({ kind: 'composer' }, 'buddy')).toBe('composer');
    expect(originOf(undefined, 'buddy')).toBe('unclassified');
  });
  test("the buddy's own prompt is known by its origin, or, where the engine leaves a plugin's origin out, as the text it just sent from no user", () => {
    expect(isOwnPrompt({ kind: 'plugin', name: 'buddy' }, 'buddy', 'anything', undefined)).toBe(true);
    expect(isOwnPrompt(undefined, 'buddy', 'Re-run  the tests\n', 'Re-run the tests')).toBe(true);
    expect(isOwnPrompt({ kind: 'composer' }, 'buddy', 'Re-run the tests', 'Re-run the tests')).toBe(false);
    expect(isOwnPrompt(undefined, 'buddy', 'Something else', 'Re-run the tests')).toBe(false);
    expect(isOwnPrompt(undefined, 'buddy', 'Re-run the tests', undefined)).toBe(false);
    expect(isOwnPrompt({ kind: 'plugin', name: 'another' }, 'buddy', 'x', undefined)).toBe(false);
  });
  test('what Claude reads beside it, verbatim', () => {
    expect(BUDDY_PROMPT_CONTEXT).toBe(
      "This prompt was sent by the buddy plugin, not by the user: a second model that watches this chat and judged your last turn. The user did not write it and may not have read it. Treat it as a reviewer's note: check what it claims, act on what holds up, and say plainly what does not.",
    );
  });
});
