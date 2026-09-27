import { describe, expect, test } from 'vitest';
import { USAGE, parseCommand } from '../plugins/buddy/src/command.ts';

describe('parseCommand', () => {
  test.each([
    ['', { kind: 'pet' }],
    ['   ', { kind: 'pet' }],
    ['OFF', { kind: 'off' }],
    ['off', { kind: 'off' }],
    ['on', { kind: 'on' }],
    ['reload', { kind: 'reload' }],
    ['help', { kind: 'help' }],
    ['log', { kind: 'log' }],
    ['LOG', { kind: 'log' }],
    ['log the error', { kind: 'question', text: 'log the error' }],
    ['use cat', { kind: 'moved' }],
    ['list', { kind: 'moved' }],
    ['LIST', { kind: 'moved' }],
    ['list the files', { kind: 'question', text: 'list the files' }],
    ['use the force', { kind: 'question', text: 'use the force' }],
    ['what is a monad?', { kind: 'question', text: 'what is a monad?' }],
  ])('%j', (args, action) => {
    expect(parseCommand(args)).toEqual(action);
  });
  test('the usage names every command, and switching lives in the menu', () => {
    expect(USAGE).not.toMatch(/\/buddy (list|use)\b/);
    for (const word of ['off', 'on', 'reload', 'help', '{question}', '/buddy-personality']) expect(USAGE).toContain(word);
  });
});
