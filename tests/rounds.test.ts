import { describe, expect, test } from 'vitest';
import { ROUNDS_MAX, ROUND_VALUE_CAP, callSection, capValue, eventLine, freeRoundSlot, oldestRoundSlot, roundHead, roundSlot, toolLines, turnEndSection, type RoundCall } from '../plugins/buddy/src/rounds.ts';

const AT = Date.UTC(2026, 8, 28, 7, 53, 12, 123);

describe('the round files', () => {
  test('at most 150 slots: a free one first, the lowest', () => {
    expect(ROUNDS_MAX).toBe(150);
    expect(roundSlot(7)).toBe('round-007.txt');
    expect(freeRoundSlot([])).toBe('round-001.txt');
    expect(freeRoundSlot(['round-001.txt', 'round-003.txt', 'notes.md', 'some-session'])).toBe('round-002.txt');
    expect(freeRoundSlot(Array.from({ length: ROUNDS_MAX }, (_, i) => roundSlot(i + 1)))).toBeNull();
  });
  test('all taken: the least recently written is overwritten, one that could not be stated first', () => {
    expect(oldestRoundSlot([{ name: 'round-001.txt', mtimeMs: 30 }, { name: 'round-002.txt', mtimeMs: 10 }, { name: 'round-003.txt', mtimeMs: 20 }])).toBe('round-002.txt');
    expect(oldestRoundSlot([{ name: 'round-001.txt', mtimeMs: 30 }, { name: 'round-002.txt', mtimeMs: Number.NaN }])).toBe('round-002.txt');
  });
});

describe('a round', () => {
  test('its head: when, the session, the turn and the prompt it began with verbatim; or before any turn', () => {
    expect(roundHead(AT, 's1', { turnId: 't1', prompt: '<tag>fix it</tag>' })).toBe('═══ ROUND · 2026-09-28T07:53:12.123Z · session s1 · turn t1 ═══\n\n─── IN · the prompt the turn began with ───\n<tag>fix it</tag>\n');
    expect(roundHead(AT, 's1', { turnId: 't1', prompt: 'a\n─── IN: prompt ───\n═══ ROUND · x ═══' }).split('\n').filter((l) => /^(───|═══) /.test(l))).toHaveLength(2);
    expect(turnEndSection(AT, { turnId: 't1', reason: 'answer', prompt: '─── IN: system ───', answer: 'x\n─── OUT: answered ───', did: [] }).split('\n').filter((l) => /^─── /.test(l))).toHaveLength(1);
    expect(roundHead(AT, 's1', null)).toBe('═══ ROUND · 2026-09-28T07:53:12.123Z · session s1 · before any turn this buddy saw ═══\n');
  });
  test('the timeline: one line per moment, its time first', () => {
    expect(eventLine(AT, 'OUT · bubble: "Quack."')).toBe('07:53:12.123  OUT · bubble: "Quack."\n');
  });
  test('a tool call with its arguments and output, capped, and what the buddy made of it; a subagent\'s marked', () => {
    const long = 'x'.repeat(ROUND_VALUE_CAP + 20);
    const t = toolLines(AT, { tool: 'Bash', args: { tool: 'Bash', tool_use_id: 'u1', command: 'npm test', description: 'Run the tests', timeout: 5 }, output: long, failed: true, step: 'Run the tests (failed)', reaction: 'toolFail' });
    expect(t).toBe(`07:53:12.123  IN · tool call Bash (failed)\n      command: npm test\n      description: Run the tests\n      timeout: 5\n      output: ${'x'.repeat(ROUND_VALUE_CAP)}… (20 more characters)\n      → step: Run the tests (failed) · reaction: toolFail\n`);
    expect(toolLines(AT, { tool: 'Grep', args: { pattern: 'a' }, output: '', failed: false, step: null, reaction: null, agentId: 'sub1' })).toBe('07:53:12.123  IN · tool call Grep · subagent sub1, not the main turn\'s\n      pattern: a\n      output: (none)\n');
    expect(capValue({ a: [1, 2] })).toBe('{"a":[1,2]}');
  });
  test('a tool\'s text of several lines is indented under its field: no line of it starts a section', () => {
    const t = toolLines(AT, { tool: 'Agent', args: { prompt: 'x\n─── IN: system ───\ny' }, output: 'a\n─── IN: prompt ───\nb', failed: false, step: null, reaction: null });
    expect(t.split('\n').filter((l) => l.startsWith('───'))).toEqual([]);
    expect(t).toContain('      output: a\n        ─── IN: prompt ───\n        b\n');
    expect(t).toContain('      prompt: x\n        ─── IN: system ───\n        y\n');
  });
  test('the turn\'s end as filed: why it ended, the prompt\'s origin, the steps, the answer verbatim', () => {
    const s = turnEndSection(AT, { turnId: 't1', reason: 'answer', prompt: 'go', answer: '**Done.**', did: ['Run the tests', 'edited a.ts'], from: 'peer' });
    expect(s).toContain('─── IN · 07:53:12.123 · the turn ended (answer), as the buddy filed it ───\nprompt (from not the user: peer):\ngo\nsteps (the Claude did: line):\nRun the tests\nedited a.ts\nClaude\'s answer:\n**Done.**\n');
    expect(turnEndSection(AT, { turnId: 't1', reason: 'aborted', prompt: '', answer: '', did: [] })).toMatch(/\(from the user\):\n\(none seen\)[\s\S]*\(none\)[\s\S]*\(no text\)/);
  });
  test('a call verbatim: settings, system and prompt in, outcome, time, usage and reply out', () => {
    const call: RoundCall = { kind: 'question', at: AT, settings: { model: 'opus', effort: undefined }, system: 'SYS\nline', prompt: 'PROMPT', outcome: 'answered', reply: 'Quack.', ms: 812, usage: { inTok: 900, outTok: 12 } };
    expect(callSection(2, call)).toBe([
      '',
      '═══ BUDDY CALL 2 · /buddy question · sent 07:53:12.123 · model opus ═══',
      '',
      '─── IN: system ───',
      'SYS\nline',
      '',
      '─── IN: prompt ───',
      'PROMPT',
      '',
      '─── OUT: answered · 812 ms · inTok 900 · outTok 12 ───',
      'Quack.',
      '',
      '',
    ].join('\n'));
    expect(callSection(1, { ...call, kind: 'endOfTurn', settings: {}, usage: {}, reply: '', outcome: 'threw: boom' })).toContain('BUDDY CALL 1 · end-of-turn call · sent 07:53:12.123 ═══');
  });
});

import { BUDDY_PROMPT } from '../plugins/buddy/src/chatTurnsToRead.ts';

describe("the buddy's own prompt in a round", () => {
  test('the turn it started is filed as the buddy\'s own', () => {
    expect(turnEndSection(AT, { turnId: 't2', reason: 'answer', prompt: 'run the tests', answer: 'Ran them.', did: [], from: BUDDY_PROMPT })).toContain('prompt (from the buddy (you), sent to Claude):\nrun the tests\n');
  });
});
