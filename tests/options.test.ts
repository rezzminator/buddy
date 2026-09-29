import { describe, expect, test } from 'vitest';
import { DEFAULTS, expandHome, logPath, observeEffort, resolveEffort, resolveModel, resolveOptions } from '../plugins/buddy/src/options.ts';

describe('resolveOptions', () => {
  test('the manifest defaults', () => {
    expect(resolveOptions({})).toEqual({ ...DEFAULTS, errors: [] });
    expect(DEFAULTS).toEqual({ character: 'duck', customCharactersDir: '', walkOverPromptBar: true, commentAfterEachTurn: true, model: 'opus', effort: 'low', secondsBetweenComments: 0, suggestNextPrompt: true, promptToMainChat: false, chatTurnsToRead: 4, logLevel: 'info', logFile: '$CLAUDE_CONFIG_DIR/buddy/buddy.log', saveRounds: true, ambiguousCharacterWidth: 'narrow' });
  });
  test('good values', () => {
    const o = resolveOptions({ character: ' Cat ', customCharactersDir: '~/chars', walkOverPromptBar: false, commentAfterEachTurn: 'false', model: 'sonnet', effort: ' HIGH ', secondsBetweenComments: '10' });
    expect(o).toMatchObject({ character: 'cat', customCharactersDir: '~/chars', walkOverPromptBar: false, commentAfterEachTurn: false, model: 'sonnet', effort: 'high', secondsBetweenComments: 10, errors: [] });
  });
  test('a bad value is ignored by name', () => {
    const o = resolveOptions({ walkOverPromptBar: 'maybe', secondsBetweenComments: -1 });
    expect(o.walkOverPromptBar).toBe(true);
    expect(o.secondsBetweenComments).toBe(0);
    expect(o.errors).toEqual([
      'option walkOverPromptBar ignored: "maybe" is not true or false',
      'option secondsBetweenComments ignored: -1 is not a number of seconds',
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

describe('the model option', () => {
  test('opus by default; a model name as given; inherit, any case, is kept as inherit', () => {
    expect(resolveOptions({}).model).toBe('opus');
    expect(resolveOptions({ model: ' haiku ' })).toMatchObject({ model: 'haiku', errors: [] });
    expect(resolveOptions({ model: 'inherit' })).toMatchObject({ model: 'inherit', errors: [] });
    expect(resolveOptions({ model: 'INHERIT' })).toMatchObject({ model: 'inherit', errors: [] });
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
  test("inherit is the level of the main chat's latest request", () => {
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max'] as const) expect(resolveEffort('inherit', e)).toBe(e);
  });
  test("inherit with a numeric effort, none on the request, or no request yet sends none: the model's default applies", () => {
    expect(resolveEffort('inherit', 32000)).toBeUndefined();
    expect(resolveEffort('inherit', undefined)).toBeUndefined();
  });
});

describe('observeEffort', () => {
  test("a step of the running main turn replaces the recorded effort, an absent one included", () => {
    expect(observeEffort(undefined, { turnId: 't1', effort: 'medium' }, 't1')).toBe('medium');
    expect(observeEffort('medium', { turnId: 't1', effort: 'max' }, 't1')).toBe('max');
    expect(observeEffort('medium', { turnId: 't1', effort: 32000 }, 't1')).toBe(32000);
    expect(observeEffort('medium', { turnId: 't1' }, 't1')).toBeUndefined();
  });
  test("a subagent's step leaves the main chat's recorded effort as it was", () => {
    expect(observeEffort('medium', { turnId: 's1', agentId: 'sub1', effort: 'max' }, 't1')).toBe('medium');
    expect(observeEffort(undefined, { turnId: 't1', agentId: 'sub1', effort: 'low' }, 't1')).toBeUndefined();
  });
  test('a step outside the running main turn (an engine side request, or none running) leaves it', () => {
    expect(observeEffort('medium', { turnId: 'side', effort: 'max' }, 't1')).toBe('medium');
    expect(observeEffort('medium', { turnId: 't1', effort: 'max' }, undefined)).toBe('medium');
  });
  test('a main-turn medium then inherit resolves to medium; a later subagent or side step keeps it', () => {
    let seen = observeEffort(undefined, { turnId: 't1', effort: 'medium' }, 't1');
    seen = observeEffort(seen, { turnId: 's1', agentId: 'sub1', effort: 'high' }, 't1');
    seen = observeEffort(seen, { turnId: 'side' }, 't1');
    expect(resolveEffort('inherit', seen)).toBe('medium');
  });
});

describe('the suggestNextPrompt option', () => {
  test('on by default; true or false, as a boolean or its string; anything else is ignored by name', () => {
    expect(resolveOptions({}).suggestNextPrompt).toBe(true);
    expect(resolveOptions({ suggestNextPrompt: false })).toMatchObject({ suggestNextPrompt: false, errors: [] });
    expect(resolveOptions({ suggestNextPrompt: 'true' })).toMatchObject({ suggestNextPrompt: true, errors: [] });
    expect(resolveOptions({ suggestNextPrompt: 'yes' })).toMatchObject({ suggestNextPrompt: true, errors: ['option suggestNextPrompt ignored: "yes" is not true or false'] });
  });
  test('commentAfterEachTurn and suggestNextPrompt turn off independently', () => {
    expect(resolveOptions({ commentAfterEachTurn: false })).toMatchObject({ commentAfterEachTurn: false, suggestNextPrompt: true, errors: [] });
    expect(resolveOptions({ suggestNextPrompt: 'false' })).toMatchObject({ commentAfterEachTurn: true, suggestNextPrompt: false, errors: [] });
  });
});

describe('the chatTurnsToRead option', () => {
  test('4 by default; a whole number from 1 to 10, as a number or its string', () => {
    expect(resolveOptions({}).chatTurnsToRead).toBe(4);
    expect(resolveOptions({ chatTurnsToRead: 1 })).toMatchObject({ chatTurnsToRead: 1, errors: [] });
    expect(resolveOptions({ chatTurnsToRead: '10' })).toMatchObject({ chatTurnsToRead: 10, errors: [] });
    expect(resolveOptions({ chatTurnsToRead: '' })).toMatchObject({ chatTurnsToRead: 4, errors: [] });
  });
  test('0, above 10, fractional or not a number: 4, and the error says why', () => {
    for (const v of [0, 11, 2.5, 'lots', true]) {
      const o = resolveOptions({ chatTurnsToRead: v });
      expect(o.chatTurnsToRead).toBe(4);
      expect(o.errors).toEqual([`option chatTurnsToRead ignored: ${JSON.stringify(v)} is not a whole number from 1 to 10; reading 4`]);
    }
  });
  test('the removed rememberedExchanges is an unknown option: it changes nothing', () => {
    const o = resolveOptions({ rememberedExchanges: 0 });
    expect(o).not.toHaveProperty('rememberedExchanges');
    expect(o.chatTurnsToRead).toBe(4);
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

  test('saveRounds: on by default; true or false, as text too; anything else is ignored by name', () => {
    expect(resolveOptions({}).saveRounds).toBe(true);
    expect(resolveOptions({ saveRounds: false }).saveRounds).toBe(false);
    expect(resolveOptions({ saveRounds: 'false' }).saveRounds).toBe(false);
    expect(resolveOptions({ saveRounds: '~/rounds' }).errors).toEqual(['option saveRounds ignored: "~/rounds" is not true or false']);
  });

  test('logFile: a path, trimmed; empty turns the file off; a non-string is ignored by name', () => {
    expect(resolveOptions({ logFile: ' ~/logs/b.log ' }).logFile).toBe('~/logs/b.log');
    expect(resolveOptions({ logFile: '' }).logFile).toBe('');
    const o = resolveOptions({ logFile: 7 });
    expect(o.logFile).toBe('$CLAUDE_CONFIG_DIR/buddy/buddy.log');
    expect(o.errors).toEqual(['option logFile ignored: not a string']);
  });
  test('ambiguousCharacterWidth: narrow or wide, any case; anything else is ignored by name', () => {
    expect(resolveOptions({ ambiguousCharacterWidth: ' WIDE ' }).ambiguousCharacterWidth).toBe('wide');
    expect(resolveOptions({ ambiguousCharacterWidth: 'narrow' }).ambiguousCharacterWidth).toBe('narrow');
    const o = resolveOptions({ ambiguousCharacterWidth: 'double' });
    expect(o.ambiguousCharacterWidth).toBe('narrow');
    expect(o.errors).toEqual(['option ambiguousCharacterWidth ignored: "double" is not narrow or wide']);
  });
});

describe('config.example.json', () => {
  test('lists every option of the manifest at its default, under the installed plugin id', async () => {
    const { readFileSync } = await import('node:fs');
    const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
    const example = read('../config.example.json');
    const manifest = read('../plugins/buddy/.claude-plugin/plugin.json');
    const defaults = Object.fromEntries(Object.entries(manifest.userConfig as Record<string, { default: unknown }>).map(([k, v]) => [k, v.default]));
    expect(example.pluginConfigs['buddy@buddy'].options).toEqual(defaults);
    expect(example.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS).toBe('1');
  });
});

describe('the promptToMainChat option', () => {
  test('off unless set; true or "true" turns it on; any other value is ignored by name', () => {
    expect(resolveOptions({}).promptToMainChat).toBe(false);
    expect(resolveOptions({ promptToMainChat: true })).toMatchObject({ promptToMainChat: true, errors: [] });
    expect(resolveOptions({ promptToMainChat: 'true' })).toMatchObject({ promptToMainChat: true, errors: [] });
    expect(resolveOptions({ promptToMainChat: 'yes' })).toMatchObject({ promptToMainChat: false, errors: ['option promptToMainChat ignored: "yes" is not true or false'] });
  });
});
