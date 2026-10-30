import { describe, expect, test } from 'vitest';
import { DEFAULTS, configFilePath, expandHome, leftoverOptionKeys, observeEffort, parseConfigFile, resolveEffort, resolveModel, resolveOptions, sessionOptions, staleOptionsWarning } from '../plugins/buddy/src/options.ts';

describe('resolveOptions', () => {
  test('the manifest defaults', () => {
    expect(resolveOptions({})).toEqual({ ...DEFAULTS, errors: [] });
    expect(DEFAULTS).toEqual({ character: 'duck', customCharactersDir: '', walkOverPromptBar: true, commentAfterEachTurn: true, model: 'opus', effort: 'low', secondsBetweenComments: 0, suggestNextPrompt: true, promptToMainChat: true, promptWhenIdle: false, chatTurnsToRead: 4, logLevel: 'info', saveRounds: true, ambiguousCharacterWidth: 'narrow' });
  });
  test('good values', () => {
    const o = resolveOptions({ character: ' Cat ', customCharactersDir: '~/chars', walkOverPromptBar: false, commentAfterEachTurn: false, model: 'sonnet', effort: ' HIGH ', secondsBetweenComments: 10 });
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
  test('on by default; a JSON true or false; anything else, a string "true" included, is ignored by name', () => {
    expect(resolveOptions({}).suggestNextPrompt).toBe(true);
    expect(resolveOptions({ suggestNextPrompt: false })).toMatchObject({ suggestNextPrompt: false, errors: [] });
    expect(resolveOptions({ suggestNextPrompt: 'true' })).toMatchObject({ suggestNextPrompt: true, errors: ['option suggestNextPrompt ignored: "true" is not true or false'] });
    expect(resolveOptions({ suggestNextPrompt: 'yes' })).toMatchObject({ suggestNextPrompt: true, errors: ['option suggestNextPrompt ignored: "yes" is not true or false'] });
  });
  test('commentAfterEachTurn and suggestNextPrompt turn off independently', () => {
    expect(resolveOptions({ commentAfterEachTurn: false })).toMatchObject({ commentAfterEachTurn: false, suggestNextPrompt: true, errors: [] });
    expect(resolveOptions({ suggestNextPrompt: false })).toMatchObject({ commentAfterEachTurn: true, suggestNextPrompt: false, errors: [] });
  });
});

describe('the chatTurnsToRead option', () => {
  test('4 by default; a whole number from 1 to 10 as a JSON number; a string is ignored by name', () => {
    expect(resolveOptions({}).chatTurnsToRead).toBe(4);
    expect(resolveOptions({ chatTurnsToRead: 1 })).toMatchObject({ chatTurnsToRead: 1, errors: [] });
    expect(resolveOptions({ chatTurnsToRead: 10 })).toMatchObject({ chatTurnsToRead: 10, errors: [] });
    expect(resolveOptions({ chatTurnsToRead: '10' })).toMatchObject({ chatTurnsToRead: 4, errors: ['option chatTurnsToRead ignored: "10" is not a whole number from 1 to 10; reading 4'] });
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
    expect(o.errors).toEqual(['option rememberedExchanges ignored: not a buddy option']);
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

  test('saveRounds: on by default; a JSON true or false; anything else is ignored by name', () => {
    expect(resolveOptions({}).saveRounds).toBe(true);
    expect(resolveOptions({ saveRounds: false }).saveRounds).toBe(false);
    expect(resolveOptions({ saveRounds: 'false' }).errors).toEqual(['option saveRounds ignored: "false" is not true or false']);
    expect(resolveOptions({ saveRounds: '~/rounds' }).errors).toEqual(['option saveRounds ignored: "~/rounds" is not true or false']);
  });

  test('logFile is gone: a config file naming it is told where buddy.log lives now, and nothing else changes', () => {
    const o = resolveOptions({ logFile: '~/logs/b.log', effort: 'high' });
    expect(o).not.toHaveProperty('logFile');
    expect(o.effort).toBe('high');
    expect(o.errors).toEqual(['option logFile ignored: removed; buddy.log is in $PLUGIN_LOG_DIR/buddy, else ~/.local/state/buddy/logs']);
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
  test('is the config file itself: a flat object listing every option at its default', async () => {
    const { readFileSync } = await import('node:fs');
    const example = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
    expect(example).toEqual(DEFAULTS);
    const parsed = parseConfigFile(JSON.stringify(example), '/x/config.json');
    expect(parsed.errors).toEqual([]);
    expect(resolveOptions(parsed.raw)).toEqual({ ...DEFAULTS, errors: [] });
  });
});

describe('the promptToMainChat option', () => {
  test('on unless set; false turns it off; any other value is ignored by name', () => {
    expect(resolveOptions({}).promptToMainChat).toBe(true);
    expect(resolveOptions({ promptToMainChat: false })).toMatchObject({ promptToMainChat: false, errors: [] });
    expect(resolveOptions({ promptToMainChat: 'false' })).toMatchObject({ promptToMainChat: true, errors: ['option promptToMainChat ignored: "false" is not true or false'] });
    expect(resolveOptions({ promptToMainChat: true })).toMatchObject({ promptToMainChat: true, errors: [] });
    expect(resolveOptions({ promptToMainChat: 'yes' })).toMatchObject({ promptToMainChat: true, errors: ['option promptToMainChat ignored: "yes" is not true or false'] });
  });
});

describe('the promptWhenIdle option', () => {
  test('off unless set; true turns it on; any other value is ignored by name', () => {
    expect(resolveOptions({}).promptWhenIdle).toBe(false);
    expect(resolveOptions({ promptWhenIdle: true })).toMatchObject({ promptWhenIdle: true, errors: [] });
    expect(resolveOptions({ promptWhenIdle: 'true' })).toMatchObject({ promptWhenIdle: false, errors: ['option promptWhenIdle ignored: "true" is not true or false'] });
    expect(resolveOptions({ promptWhenIdle: 'yes' })).toMatchObject({ promptWhenIdle: false, errors: ['option promptWhenIdle ignored: "yes" is not true or false'] });
  });
});

describe('configFilePath', () => {
  test('XDG_CONFIG_HOME when set and absolute, else ~/.config; trailing slashes dropped', () => {
    expect(configFilePath({ HOME: '/opt/me', XDG_CONFIG_HOME: '/opt/xdg' })).toEqual({ path: '/opt/xdg/buddy/config.json' });
    expect(configFilePath({ HOME: '/opt/me', XDG_CONFIG_HOME: '/opt/xdg//' })).toEqual({ path: '/opt/xdg/buddy/config.json' });
    expect(configFilePath({ HOME: '/opt/me/' })).toEqual({ path: '/opt/me/.config/buddy/config.json' });
    expect(configFilePath({ HOME: '/opt/me' , XDG_CONFIG_HOME: '' })).toEqual({ path: '/opt/me/.config/buddy/config.json' });
    expect(configFilePath({ XDG_CONFIG_HOME: '/opt/xdg' })).toEqual({ path: '/opt/xdg/buddy/config.json' });
  });
  test('the root is an absolute base like any other', () => {
    expect(configFilePath({ HOME: '/opt/me', XDG_CONFIG_HOME: '/' })).toEqual({ path: '/buddy/config.json' });
    expect(configFilePath({ HOME: '/' })).toEqual({ path: '/.config/buddy/config.json' });
  });
  test('a relative XDG_CONFIG_HOME or HOME is ignored, never read under the working directory; with no absolute base the error says so', () => {
    const none = { error: 'no config file: neither XDG_CONFIG_HOME nor HOME is an absolute path to place buddy/config.json under' };
    expect(configFilePath({ HOME: '/opt/me', XDG_CONFIG_HOME: 'rel/dir' })).toEqual({ path: '/opt/me/.config/buddy/config.json' });
    expect(configFilePath({ XDG_CONFIG_HOME: 'rel/dir' })).toEqual(none);
    expect(configFilePath({ HOME: 'proj' })).toEqual(none);
    expect(configFilePath({ HOME: 'proj', XDG_CONFIG_HOME: 'rel/dir' })).toEqual(none);
    expect(configFilePath({})).toEqual(none);
  });
});

describe('parseConfigFile', () => {
  const path = '/opt/me/.config/buddy/config.json';
  test('a flat JSON object is the raw options, no errors; {} too', () => {
    expect(parseConfigFile('{}', path)).toEqual({ raw: {}, errors: [] });
    expect(parseConfigFile('{"promptWhenIdle":false,"saveRounds":true}\n', path)).toEqual({ raw: { promptWhenIdle: false, saveRounds: true }, errors: [] });
  });
  test.each([
    ['', 'is not valid JSON'],
    ['{"a":', 'is not valid JSON'],
    ['nope', 'is not valid JSON'],
    ['[]', 'must hold a JSON object, not an array'],
    ['null', 'must hold a JSON object, not null'],
    ['3', 'must hold a JSON object, not a number'],
    ['"x"', 'must hold a JSON object, not a string'],
  ])('%j: no options, one error naming the file and the defaults', (text, why) => {
    const r = parseConfigFile(text, path);
    expect(r.raw).toEqual({});
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain(`config file ${path} ${why}`);
    expect(r.errors[0]).toMatch(/; using the defaults$/);
  });
});

describe('resolveOptions from the config file', () => {
  const keys = Object.keys(DEFAULTS);
  test('the six host values of the file all apply, the rest stay at their defaults', () => {
    const six = { commentAfterEachTurn: true, promptToMainChat: true, promptWhenIdle: false, saveRounds: true, suggestNextPrompt: true, walkOverPromptBar: true };
    expect(resolveOptions(six)).toEqual({ ...DEFAULTS, ...six, errors: [] });
  });
  test('every option key is accepted at a non-default value of its type', () => {
    const file = { character: 'robot', customCharactersDir: '~/chars', walkOverPromptBar: false, commentAfterEachTurn: false, model: 'haiku', effort: 'max', secondsBetweenComments: 30, suggestNextPrompt: false, promptToMainChat: false, promptWhenIdle: true, chatTurnsToRead: 7, logLevel: 'debug', saveRounds: false, ambiguousCharacterWidth: 'wide' };
    expect(Object.keys(file).sort()).toEqual([...keys].sort());
    expect(resolveOptions(file)).toEqual({ ...file, errors: [] });
  });
  test('an unknown key is named and ignored; the valid keys still apply', () => {
    expect(resolveOptions({ effort: 'high', colour: 'red' })).toMatchObject({ effort: 'high', errors: ['option colour ignored: not a buddy option'] });
  });
  test('a wrong-typed value is named; its default applies and the others still apply', () => {
    const o = resolveOptions({ character: 3, walkOverPromptBar: 'true', secondsBetweenComments: '5', effort: 'low', chatTurnsToRead: 11 });
    expect(o).toMatchObject({ character: 'duck', walkOverPromptBar: true, secondsBetweenComments: 0, effort: 'low', chatTurnsToRead: 4 });
    expect(o.errors).toEqual([
      'option character ignored: not a string',
      'option walkOverPromptBar ignored: "true" is not true or false',
      'option secondsBetweenComments ignored: "5" is not a number of seconds',
      'option chatTurnsToRead ignored: 11 is not a whole number from 1 to 10; reading 4',
    ]);
  });
  test('file-level errors come first, then each key problem', () => {
    expect(resolveOptions({ colour: 1 }, ['config file /x ... ; using the defaults']).errors).toEqual(['config file /x ... ; using the defaults', 'option colour ignored: not a buddy option']);
  });
});

describe('leftoverOptionKeys', () => {
  test('the option keys of every buddy@ entry across the sources, each once; other plugins, empty and malformed entries add none', () => {
    const user = { pluginConfigs: { 'buddy@professor': { options: { promptToMainChat: false, effort: 'high' } }, 'other@x': { options: { colour: 'red' } }, 'buddyx@y': { options: { model: 'haiku' } } } };
    const local = { pluginConfigs: { 'buddy@inline': { options: { effort: 'low', saveRounds: false } }, 'buddy@elsewhere': { options: {} } } };
    const odd = { pluginConfigs: { 'buddy@a': null, 'buddy@b': { options: ['x'] }, 'buddy@c': 'text' } };
    expect(leftoverOptionKeys([user, {}, local, odd, { pluginConfigs: [] }])).toEqual(['promptToMainChat', 'effort', 'saveRounds']);
  });
  test('no pluginConfigs anywhere: none', () => {
    expect(leftoverOptionKeys([{}, { env: { A: '1' } }])).toEqual([]);
  });
});

describe('staleOptionsWarning', () => {
  const path = '/opt/me/.config/buddy/config.json';
  test('no options: no warning', () => {
    expect(staleOptionsWarning([], path)).toBeUndefined();
  });
  test('options from an old pluginConfigs entry: one warning naming their keys and the file', () => {
    const w = staleOptionsWarning(['promptToMainChat', 'effort'], path);
    expect(w).toBe(`pluginConfigs options (promptToMainChat, effort) are no longer read and not applied: buddy reads ${path} instead; move them there and remove the pluginConfigs entry`);
  });
});

describe('sessionOptions', () => {
  const path = '/opt/me/.config/buddy/config.json';
  test('the file decides; the keys of an old pluginConfigs entry are never applied, and are said once after the file errors', () => {
    const file = { raw: { saveRounds: false }, errors: ['config file x is broken'], path };
    const leftover = ['promptToMainChat', 'effort'];
    const o = sessionOptions(file, leftover);
    expect(o).toMatchObject({ saveRounds: false, promptToMainChat: true, effort: 'low' });
    expect(o.errors).toEqual(['config file x is broken', staleOptionsWarning(leftover, path)]);
  });
  test('no leftover entry: only the file speaks', () => {
    expect(sessionOptions({ raw: {}, errors: [], path }, [])).toEqual({ ...DEFAULTS, errors: [] });
  });
});
