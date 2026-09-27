import { describe, expect, test } from 'vitest';
import { DEFAULTS, expandHome, logPath, resolveEffort, resolveModel, resolveOptions } from '../plugins/buddy/src/options.ts';

describe('resolveOptions', () => {
  test('the manifest defaults', () => {
    expect(resolveOptions({})).toEqual({ ...DEFAULTS, errors: [] });
    expect(DEFAULTS).toEqual({ character: 'duck', characterDir: '', motion: true, questionMode: 'complete', quips: true, quipModel: 'opus', effort: 'low', quipCooldownSec: 0, suggestions: true, memory: 6, turnMode: 'complete', contextTurns: 3, logLevel: 'info', logFile: '$CLAUDE_CONFIG_DIR/buddy/buddy.log', ambiguousWidth: 'narrow' });
  });
  test('good values', () => {
    const o = resolveOptions({ character: ' Cat ', characterDir: '~/chars', motion: false, questionMode: 'FORK', quips: 'false', quipModel: 'sonnet', effort: ' HIGH ', quipCooldownSec: '10' });
    expect(o).toMatchObject({ character: 'cat', characterDir: '~/chars', motion: false, questionMode: 'fork', quips: false, quipModel: 'sonnet', effort: 'high', quipCooldownSec: 10, errors: [] });
  });
  test('a bad value is ignored by name', () => {
    const o = resolveOptions({ questionMode: 'loud', motion: 'maybe', quipCooldownSec: -1 });
    expect(o.questionMode).toBe('complete');
    expect(o.motion).toBe(true);
    expect(o.quipCooldownSec).toBe(0);
    expect(o.errors).toEqual([
      'option motion ignored: "maybe" is not true or false',
      'option questionMode ignored: "loud" is not fork, complete or off',
      'option quipCooldownSec ignored: -1 is not a number of seconds',
    ]);
  });
});

describe('the effort option', () => {
  test('low by default; any ModelEffort, any case; anything else is ignored by name', () => {
    expect(resolveOptions({}).effort).toBe('low');
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) expect(resolveOptions({ effort: e })).toMatchObject({ effort: e, errors: [] });
    expect(resolveOptions({ effort: 'Max' })).toMatchObject({ effort: 'max', errors: [] });
    expect(resolveOptions({ effort: '' })).toMatchObject({ effort: 'low', errors: [] });
    expect(resolveOptions({ effort: 'turbo' })).toMatchObject({ effort: 'low', errors: ['option effort ignored: "turbo" is not low, medium, high, xhigh, max or inherit'] });
    expect(resolveOptions({ effort: 3 })).toMatchObject({ effort: 'low', errors: ['option effort ignored: 3 is not low, medium, high, xhigh, max or inherit'] });
  });
  test('inherit, any case, is kept as inherit', () => {
    expect(resolveOptions({ effort: 'inherit' })).toMatchObject({ effort: 'inherit', errors: [] });
    expect(resolveOptions({ effort: ' Inherit ' })).toMatchObject({ effort: 'inherit', errors: [] });
  });
});

describe('the quipModel option', () => {
  test('opus by default; a model name as given; inherit, any case, is kept as inherit', () => {
    expect(resolveOptions({}).quipModel).toBe('opus');
    expect(resolveOptions({ quipModel: ' haiku ' })).toMatchObject({ quipModel: 'haiku', errors: [] });
    expect(resolveOptions({ quipModel: 'inherit' })).toMatchObject({ quipModel: 'inherit', errors: [] });
    expect(resolveOptions({ quipModel: 'INHERIT' })).toMatchObject({ quipModel: 'inherit', errors: [] });
  });
});

describe('resolveModel', () => {
  test('a named model is itself, whatever the main chat runs', () => {
    expect(resolveModel('sonnet', 'claude-opus-4-1')).toBe('sonnet');
    expect(resolveModel('haiku', undefined)).toBe('haiku');
  });
  test("inherit is the main chat's model", () => {
    expect(resolveModel('inherit', 'claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
  });
  test('inherit with no main-chat model falls back to opus', () => {
    expect(resolveModel('inherit', undefined)).toBe('opus');
    expect(resolveModel('inherit', '')).toBe('opus');
    expect(resolveModel('inherit', '  ')).toBe('opus');
  });
});

describe('resolveEffort', () => {
  test('a named level is itself, whatever the main chat uses', () => {
    expect(resolveEffort('high', 'max')).toBe('high');
    expect(resolveEffort('low', undefined)).toBe('low');
  });
  test("inherit is the main chat's level, when it is one of the five", () => {
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) expect(resolveEffort('inherit', e)).toBe(e);
    expect(resolveEffort('inherit', ' High ')).toBe('high');
  });
  test("inherit without a known level sends none: the model's default applies", () => {
    expect(resolveEffort('inherit', undefined)).toBeUndefined();
    expect(resolveEffort('inherit', '')).toBeUndefined();
    expect(resolveEffort('inherit', 'turbo')).toBeUndefined();
  });
});

describe('the suggestions option', () => {
  test('on by default; true or false, as a boolean or its string; anything else is ignored by name', () => {
    expect(resolveOptions({}).suggestions).toBe(true);
    expect(resolveOptions({ suggestions: false })).toMatchObject({ suggestions: false, errors: [] });
    expect(resolveOptions({ suggestions: 'true' })).toMatchObject({ suggestions: true, errors: [] });
    expect(resolveOptions({ suggestions: 'yes' })).toMatchObject({ suggestions: true, errors: ['option suggestions ignored: "yes" is not true or false'] });
  });
  test('quips and suggestions turn off independently', () => {
    expect(resolveOptions({ quips: false })).toMatchObject({ quips: false, suggestions: true, errors: [] });
    expect(resolveOptions({ suggestions: 'false' })).toMatchObject({ quips: true, suggestions: false, errors: [] });
  });
});

describe('the turnMode option', () => {
  test('complete by default; complete or fork, any case; anything else is ignored by name', () => {
    expect(resolveOptions({}).turnMode).toBe('complete');
    expect(resolveOptions({ turnMode: ' FORK ' })).toMatchObject({ turnMode: 'fork', errors: [] });
    expect(resolveOptions({ turnMode: 'complete' })).toMatchObject({ turnMode: 'complete', errors: [] });
    expect(resolveOptions({ turnMode: '' })).toMatchObject({ turnMode: 'complete', errors: [] });
    for (const v of ['off', 7]) {
      const o = resolveOptions({ turnMode: v });
      expect(o.turnMode).toBe('complete');
      expect(o.errors).toEqual([`option turnMode ignored: ${JSON.stringify(v)} is not complete or fork`]);
    }
  });
});

describe('the contextTurns option', () => {
  test('3 by default; a whole number from 1 to 10, as a number or its string', () => {
    expect(resolveOptions({}).contextTurns).toBe(3);
    expect(resolveOptions({ contextTurns: 1 })).toMatchObject({ contextTurns: 1, errors: [] });
    expect(resolveOptions({ contextTurns: '10' })).toMatchObject({ contextTurns: 10, errors: [] });
    expect(resolveOptions({ contextTurns: '' })).toMatchObject({ contextTurns: 3, errors: [] });
  });
  test('0, above 10, fractional or not a number: 3, and the error says why', () => {
    for (const v of [0, 11, 2.5, 'lots', true]) {
      const o = resolveOptions({ contextTurns: v });
      expect(o.contextTurns).toBe(3);
      expect(o.errors).toEqual([`option contextTurns ignored: ${JSON.stringify(v)} is not a whole number from 1 to 10; reading 3`]);
    }
  });
});

describe('the memory option', () => {
  test('default 6; 0 is off; a whole number as given', () => {
    expect(resolveOptions({}).memory).toBe(6);
    expect(resolveOptions({ memory: 0 })).toMatchObject({ memory: 0, errors: [] });
    expect(resolveOptions({ memory: '12' })).toMatchObject({ memory: 12, errors: [] });
    expect(resolveOptions({ memory: 30 })).toMatchObject({ memory: 30, errors: [] });
  });
  test('above 30 caps at 30 and says so', () => {
    expect(resolveOptions({ memory: 31 })).toMatchObject({ memory: 30, errors: ['option memory capped: 31 is above 30; remembering 30'] });
  });
  test('negative, fractional or not a number: 6, and the note says why', () => {
    expect(resolveOptions({ memory: -1 })).toMatchObject({ memory: 6, errors: ['option memory ignored: -1 is not a whole number of exchanges; remembering 6'] });
    expect(resolveOptions({ memory: 2.5 })).toMatchObject({ memory: 6, errors: ['option memory ignored: 2.5 is not a whole number of exchanges; remembering 6'] });
    expect(resolveOptions({ memory: 'x' })).toMatchObject({ memory: 6, errors: ['option memory ignored: "x" is not a whole number of exchanges; remembering 6'] });
    expect(resolveOptions({ memory: true })).toMatchObject({ memory: 6, errors: ['option memory ignored: true is not a whole number of exchanges; remembering 6'] });
  });
});

describe('logPath', () => {
  test('the default, $CLAUDE_CONFIG_DIR/buddy/buddy.log: in CLAUDE_CONFIG_DIR when set, else in ~/.claude', () => {
    const d = DEFAULTS.logFile;
    expect(logPath(d, { HOME: '/opt/me', CLAUDE_CONFIG_DIR: '/opt/work/' })).toEqual({ path: '/opt/work/buddy/buddy.log' });
    expect(logPath(d, { HOME: '/opt/me/' })).toEqual({ path: '/opt/me/.claude/buddy/buddy.log' });
    expect(logPath(d, { HOME: '/opt/me', CLAUDE_CONFIG_DIR: '' })).toEqual({ path: '/opt/me/.claude/buddy/buddy.log' });
    expect(logPath(d, {})).toEqual({ error: 'no log file: neither CLAUDE_CONFIG_DIR nor HOME is set to place $CLAUDE_CONFIG_DIR/buddy/buddy.log' });
    expect(logPath('$CLAUDE_CONFIG_DIRx/b.log', { HOME: '/opt/me', CLAUDE_CONFIG_DIR: '/opt/work' })).toEqual({ path: '$CLAUDE_CONFIG_DIRx/b.log' });
  });
  test('set: used as given, ~ against HOME whatever CLAUDE_CONFIG_DIR says; empty is no file', () => {
    expect(logPath('/var/b.log', { HOME: '/opt/me', CLAUDE_CONFIG_DIR: '/opt/work' })).toEqual({ path: '/var/b.log' });
    expect(logPath('~/.claude/buddy/buddy.log', { HOME: '/opt/me', CLAUDE_CONFIG_DIR: '/opt/work' })).toEqual({ path: '/opt/me/.claude/buddy/buddy.log' });
    expect(logPath('', { HOME: '/opt/me', CLAUDE_CONFIG_DIR: '/opt/work' })).toEqual({ path: '' });
    expect(logPath('~/b.log', {})).toEqual({ error: 'no HOME to expand ~/b.log' });
  });
});

describe('expandHome', () => {
  test('~ and ~/ only', () => {
    expect(expandHome('~/chars', '/opt/me')).toBe('/opt/me/chars');
    expect(expandHome('~', '/opt/me/')).toBe('/opt/me');
    expect(expandHome('/abs/chars', '/opt/me')).toBe('/abs/chars');
    expect(expandHome('~other', '/opt/me')).toBe('~other');
    expect(expandHome('~/chars', undefined)).toBe('~/chars');
  });
  test('logLevel: error, info or debug, any case; anything else is ignored by name', () => {
    expect(resolveOptions({ logLevel: 'DEBUG' }).logLevel).toBe('debug');
    expect(resolveOptions({ logLevel: 'error' }).logLevel).toBe('error');
    expect(resolveOptions({ logLevel: '' }).logLevel).toBe('info');
    const o = resolveOptions({ logLevel: 'loud' });
    expect(o.logLevel).toBe('info');
    expect(o.errors).toEqual(['option logLevel ignored: "loud" is not error, info or debug']);
  });

  test('logFile: a path, trimmed; empty turns the file off; a non-string is ignored by name', () => {
    expect(resolveOptions({ logFile: ' ~/logs/b.log ' }).logFile).toBe('~/logs/b.log');
    expect(resolveOptions({ logFile: '' }).logFile).toBe('');
    const o = resolveOptions({ logFile: 7 });
    expect(o.logFile).toBe('$CLAUDE_CONFIG_DIR/buddy/buddy.log');
    expect(o.errors).toEqual(['option logFile ignored: not a string']);
  });
  test('ambiguousWidth: narrow or wide, any case; anything else is ignored by name', () => {
    expect(resolveOptions({ ambiguousWidth: ' WIDE ' }).ambiguousWidth).toBe('wide');
    expect(resolveOptions({ ambiguousWidth: 'narrow' }).ambiguousWidth).toBe('narrow');
    const o = resolveOptions({ ambiguousWidth: 'double' });
    expect(o.ambiguousWidth).toBe('narrow');
    expect(o.errors).toEqual(['option ambiguousWidth ignored: "double" is not narrow or wide']);
  });
});
