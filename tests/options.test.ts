import { describe, expect, test } from 'vitest';
import { DEFAULTS, expandHome, logPath, resolveOptions } from '../plugins/buddy/src/options.ts';

describe('resolveOptions', () => {
  test('the manifest defaults', () => {
    expect(resolveOptions({})).toEqual({ ...DEFAULTS, errors: [] });
    expect(DEFAULTS).toEqual({ character: 'duck', characterDir: '', motion: true, questionMode: 'fork', quips: false, quipModel: 'haiku', quipCooldownSec: 45, memory: 6, logLevel: 'info', logFile: '$CLAUDE_CONFIG_DIR/buddy/buddy.log', ambiguousWidth: 'narrow' });
  });
  test('good values', () => {
    const o = resolveOptions({ character: ' Cat ', characterDir: '~/chars', motion: false, questionMode: 'COMPLETE', quips: 'true', quipModel: 'sonnet', quipCooldownSec: '10' });
    expect(o).toMatchObject({ character: 'cat', characterDir: '~/chars', motion: false, questionMode: 'complete', quips: true, quipModel: 'sonnet', quipCooldownSec: 10, errors: [] });
  });
  test('a bad value is ignored by name', () => {
    const o = resolveOptions({ questionMode: 'loud', motion: 'maybe', quipCooldownSec: -1 });
    expect(o.questionMode).toBe('fork');
    expect(o.motion).toBe(true);
    expect(o.quipCooldownSec).toBe(45);
    expect(o.errors).toEqual([
      'option motion ignored: "maybe" is not true or false',
      'option questionMode ignored: "loud" is not fork, complete or off',
      'option quipCooldownSec ignored: -1 is not a number of seconds',
    ]);
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
