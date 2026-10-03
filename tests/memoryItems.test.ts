import { describe, expect, test } from 'vitest';
import { applyMemory, migrateNotes, wordsTyped, renderItems, itemsText, itemsOf, ITEMS_HEAD, ITEM_CAPS, ITEM_MAX_CHARS, DOUBT_UNTOUCHED_TURNS, ENDED_KEPT, type Kind, type Item, type Items, type EndedItems, type MemoryContext, type MemoryOp } from '../plugins/buddy/src/memoryItems.ts';

const ctx: MemoryContext = { turn: 10, at: 1000, typed: ['please keep main safe and never push without asking'] };
const item = (text = 'Old.', turn = 4, at = 400): Item => ({ text, from: 'shown', turn, at });
const empty = () => ({ items: {} as Items, ended: {} as EndedItems });
const op = (key: string, action: MemoryOp['op'], why: string): MemoryOp => ({ key, op: action, why, turn: ctx.turn });
const apply = (value: unknown, items: Items = {}, ended: EndedItems = {}, context = ctx) => applyMemory({ items, ended }, JSON.stringify(value), context);

describe('memory ops: parse, add and merge', () => {
  test('adds a fact and records its provenance and code stamps once', () => {
    expect(apply({ 'fact.tests-green': { text: 'Tests passed.', from: 'shown' } })).toEqual({
      items: { 'fact.tests-green': { text: 'Tests passed.', from: 'shown', turn: 10, at: 1000 } }, ended: {},
      ops: [op('fact.tests-green', 'add', 'added')],
    });
  });
  test('an add without from defaults to buddy', () => {
    expect(apply({ 'open.fix-cli': { text: 'Fix the CLI.' } }).items['open.fix-cli']).toEqual({ text: 'Fix the CLI.', from: 'buddy', turn: 10, at: 1000 });
  });
  test('set merges named fields, keeps omitted provenance and stamps the item', () => {
    const old = Object.freeze(item());
    const items = Object.freeze({ 'fact.x': old });
    expect(apply({ 'fact.x': { text: 'New.' } }, items)).toEqual({
      items: { 'fact.x': { text: 'New.', from: 'shown', turn: 10, at: 1000 } }, ended: {}, ops: [op('fact.x', 'set', 'text')],
    });
    expect(items['fact.x']).toBe(old);
  });
  test('keys left out preserve their exact object values', () => {
    const items = { 'fact.a': item(), 'fact.b': item('B.'), 'open.c': item('C.') };
    const r = apply({ 'fact.a': { text: 'Changed.' } }, items);
    expect(r.items['fact.b']).toBe(items['fact.b']);
    expect(r.items['open.c']).toBe(items['open.c']);
    expect(r.items).not.toBe(items);
  });
  test('an empty object preserves items and ended without ops', () => {
    const items = { 'fact.x': item() };
    const ended = { 'open.y': { item: item(), reason: 'done: shipped', turn: 3, at: 300 } };
    expect(apply({}, items, ended)).toEqual({ items, ended, ops: [] });
  });
  test('no MEMORY line applies no ops', () => {
    const memory = { ...empty(), items: { 'fact.x': item() } };
    expect(applyMemory(memory, null, ctx)).toEqual({ ...memory, ops: [] });
  });
  test.each(['{oops', '[1]', '""', 'null', '1', 'true'])('broken or non-object JSON %s drops once', (raw) => {
    const memory = { ...empty(), items: { 'fact.x': item() } };
    expect(applyMemory(memory, raw, ctx)).toEqual({ ...memory, ops: [op('*', 'drop', 'not a JSON object')] });
  });
  test('end saves the original item and removes the live key', () => {
    const old = Object.freeze(item('Fix the CLI.'));
    const memory = Object.freeze({ items: Object.freeze({ 'open.fix-cli': old }), ended: Object.freeze({}) });
    expect(applyMemory(memory, '{"open.fix-cli":{"end":"done: shipped"}}', ctx)).toEqual({
      items: {}, ended: { 'open.fix-cli': { item: old, reason: 'done: shipped', turn: 10, at: 1000 } },
      ops: [op('open.fix-cli', 'end', 'done: shipped')],
    });
    expect(memory.items['open.fix-cli']).toBe(old);
  });
});

const rule = (words = 'keep main safe', covers = 'the repo'): Item => ({ words, covers, from: 'user', turn: 4, at: 400 });

describe('memory ops: checks in order, the rest still applied', () => {
  const bad: [string, string, unknown, string, Items?][] = [
    ...['Rule.X', 'note.x', 'fact.a-b-c-d-e', 'fact.', 'fact.a_b'].map((key): [string, string, unknown, string] => [key, key, { text: 'a' }, 'bad key']),
    ...['text', [], 1, null].map((value): [string, string, unknown, string] => [`value ${JSON.stringify(value)}`, 'fact.x', value, 'not an object']),
    ['unknown field', 'fact.x', { text: 'a', kind: 'fact' }, 'unknown field kind'],
    ...['text', 'words', 'covers', 'from', 'end'].flatMap((field) => [[], { a: 1 }, 1, null].map((value): [string, string, unknown, string] => [`${field} ${JSON.stringify(value)}`, 'fact.x', { [field]: value }, `not text: ${field}`])),
    ...['text', 'words', 'covers', 'end'].map((field): [string, string, unknown, string] => [`long ${field}`, 'fact.x', { [field]: 'x'.repeat(301) }, `too long: ${field}`]),
    ...['text', 'words', 'covers', 'from', 'end'].map((field): [string, string, unknown, string] => [`empty ${field}`, 'fact.x', { [field]: '  ' }, `empty: ${field}`]),
    ['bad from', 'fact.x', { text: 'a', from: 'me' }, 'bad from'],
    ['bad end', 'open.x', { end: 'finished' }, 'bad end', { 'open.x': item() }],
    ['end unknown', 'open.x', { end: 'done: shipped' }, 'end on unknown key'],
    ['new no text', 'fact.x', { from: 'shown' }, 'new item without text'],
    ['new rule no covers', 'rule.x', { words: 'keep main safe' }, 'new rule without words or covers'],
    ['new rule no words', 'rule.x', { covers: 'the repo' }, 'new rule without words or covers'],
    ['untyped words', 'rule.x', { words: 'push freely', covers: 'the repo' }, 'words not typed by the user'],
    ['set untyped words', 'rule.x', { words: 'push freely' }, 'words not typed by the user', { 'rule.x': rule() }],
    ['no field', 'fact.x', {}, 'no field'],
    ['key before value', 'bad', null, 'bad key'],
    ['unknown before value type', 'fact.x', { text: [], kind: 'fact' }, 'unknown field kind'],
    ['type before blank', 'fact.x', { text: ' ', covers: null }, 'not text: covers'],
    ['blank before length', 'fact.x', { text: 'x'.repeat(301), words: ' ' }, 'empty: words'],
    ['length before from', 'fact.x', { text: 'x'.repeat(301), from: 'me' }, 'too long: text'],
    ['from before end unknown', 'open.x', { end: 'finished', from: 'me' }, 'bad from'],
    ['unknown before end grammar', 'open.x', { end: 'finished' }, 'end on unknown key'],
  ];
  test.each(bad)('%s', (_label, key, value, why, items = {}) => {
    const before = structuredClone(items);
    const r = apply({ [key]: value, 'fact.valid': { text: 'Applied.' } }, items);
    expect(r.ops).toEqual([op(key, 'drop', why), op('fact.valid', 'add', 'added')]);
    expect(r.items).toEqual({ ...before, 'fact.valid': { text: 'Applied.', from: 'buddy', turn: 10, at: 1000 } });
    expect(items).toEqual(before);
  });
  test('an ended key is still unknown to end', () => {
    const ended = { 'open.x': { item: item(), reason: 'done: before', turn: 4, at: 400 } };
    expect(apply({ 'open.x': { end: 'done: again' } }, {}, ended)).toEqual({ items: {}, ended, ops: [op('open.x', 'drop', 'end on unknown key')] });
  });
  test('trims every string; 300 trimmed characters are accepted without filtering digits or hashes', () => {
    const text = 'v2 47 abc123 '.padEnd(ITEM_MAX_CHARS, 'x');
    expect(apply({ 'fact.x': { text: `  ${text}  `, from: ' shown ' } }).items['fact.x']).toEqual({ text, from: 'shown', turn: 10, at: 1000 });
  });
  test('adds rule words as typed, forces user from and keeps optional text', () => {
    expect(apply({ 'rule.main-safe': { words: ' Keep  MAIN safe ', covers: ' the repo ', from: 'claude', text: 'Extra.' } })).toEqual({
      items: { 'rule.main-safe': { words: 'Keep  MAIN safe', covers: 'the repo', from: 'user', text: 'Extra.', turn: 10, at: 1000 } },
      ended: {}, ops: [op('rule.main-safe', 'add', 'added')],
    });
  });
  test('set rule covers without resubmitting words and keep its forced provenance', () => {
    expect(apply({ 'rule.x': { covers: 'all repos', from: 'buddy' } }, { 'rule.x': rule() })).toEqual({
      items: { 'rule.x': { ...rule(), covers: 'all repos', turn: 10, at: 1000 } }, ended: {}, ops: [op('rule.x', 'set', 'covers')],
    });
  });
  test('ignores words and covers on a non-rule, set why lists only changed fields in fixed order', () => {
    expect(apply({ 'fact.x': { from: 'claude', covers: 'ignored', words: 'ignored', text: 'New.' } }, { 'fact.x': item() })).toEqual({
      items: { 'fact.x': { text: 'New.', from: 'claude', turn: 10, at: 1000 } }, ended: {}, ops: [op('fact.x', 'set', 'text, from')],
    });
    expect(apply({ 'fact.x': { text: 'Old.' } }, { 'fact.x': item() }).ops).toEqual([op('fact.x', 'set', '')]);
  });
  test('a rule set names text, words, covers, from in that order when changed', () => {
    const old = { ...rule('old words', 'old cover'), from: 'shown' as const };
    expect(apply({ 'rule.x': { covers: 'new cover', words: 'keep main safe', from: 'buddy', text: 'New.' } }, { 'rule.x': old }).ops).toEqual([op('rule.x', 'set', 'text, words, covers, from')]);
  });
  test.each(['done: shipped', 'MET condition', 'lifted', 'Stale: old', 'wrong: guessed'])('end accepts %s, closes the original and ignores other fields', (reason) => {
    const old = item();
    expect(apply({ 'open.x': { text: 'ignored', end: ` ${reason} ` } }, { 'open.x': old })).toEqual({
      items: {}, ended: { 'open.x': { item: old, reason, turn: 10, at: 1000 } }, ops: [op('open.x', 'end', reason)],
    });
  });
});

describe('wordsTyped', () => {
  test.each([
    ['Keep  MAIN\n safe', ctx.typed, true],
    ["don't push the branch", ['don’t push the branch'], true],
    ['don’t push the branch', ["don't push the branch"], true],
    ['keep ‘main’ safe', ["keep 'main' safe"], true],
    ['keep "main" safe', ['keep “main” safe'], true],
    ['keep “main” safe', ['keep "main" safe'], true],
    ['keep main safe', ['other', 'please keep main safe today'], true],
    ['push freely', ctx.typed, false],
    [' ', ctx.typed, false],
    ['keep main safe', [], false],
    ['keep main safe', ['keep main', 'safe'], false],
  ])('folds %j in %j to %s', (words, typed, expected) => {
    expect(wordsTyped(words, typed)).toBe(expected);
  });
  test.each([
    ['e', 'one letter'],
    ['never push', 'two words'],
    ['a b c d e', 'five words, under twelve characters'],
    ['ep main sa', 'three words, under twelve characters'],
  ])('a quote too short to prove anything is refused: %j (%s)', (words) => {
    expect(wordsTyped(words, ctx.typed)).toBe(false);
  });
  test.each([
    ['eep main safe and', 'starts inside a word'],
    ['keep main saf', 'ends inside a word'],
    ['lease keep main', 'starts inside a word'],
  ])('a quote that cuts a typed word is refused: %j (%s)', (words) => {
    expect(wordsTyped(words, ctx.typed)).toBe(false);
  });
  test('a quote bounded by punctuation still counts, and so does a later bounded occurrence', () => {
    expect(wordsTyped('keep main safe', ['(keep main safe)'])).toBe(true);
    expect(wordsTyped('keep main safe', ['xkeep main safe, then keep main safe.'])).toBe(true);
  });
  test('the review\'s model-invented rule: one letter of a typed prompt adds nothing', () => {
    const r = apply({ 'rule.anything': { words: 'e', covers: 'every reply must be in French' } });
    expect(r.items).toEqual({});
    expect(r.ops).toEqual([op('rule.anything', 'drop', 'words not typed by the user')]);
  });
});

describe('memory ops: ended items, expiry and caps', () => {
  test('re-adding an ended key makes a fresh item and removes only its ended record', () => {
    const record = Object.freeze({ item: item(), reason: 'done: before', turn: 4, at: 400 });
    const ended = Object.freeze({ 'fact.x': record, 'open.y': record });
    expect(apply({ 'fact.x': { text: 'Back.' } }, {}, ended)).toEqual({
      items: { 'fact.x': { text: 'Back.', from: 'buddy', turn: 10, at: 1000 } }, ended: { 'open.y': record },
      ops: [op('fact.x', 'add', 're-added after end')],
    });
    expect(ended['fact.x']).toBe(record);
  });
  test('ten rules refuse a new rule before the words check and never evict a rule', () => {
    const items = Object.fromEntries(Array.from({ length: ITEM_CAPS.rule }, (_, i) => [`rule.r${i}`, rule()]));
    expect(apply({ 'rule.new': { words: 'not typed', covers: 'the chat' } }, items)).toEqual({ items, ended: {}, ops: [op('rule.new', 'drop', 'rule cap 10')] });
    expect(apply({ 'rule.r0': { covers: 'new scope' } }, items).ops).toEqual([op('rule.r0', 'set', 'covers')]);
    const r = apply({ 'rule.r0': { end: 'lifted' }, 'rule.new': { words: 'keep main safe', covers: 'the chat' } }, items);
    expect(Object.keys(r.items)).toHaveLength(10);
    expect(r.ops).toEqual([op('rule.r0', 'end', 'lifted'), op('rule.new', 'add', 'added')]);
  });
  test('rule cap counts earlier additions in the same object', () => {
    const items = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`rule.r${i}`, rule()]));
    expect(apply({ 'rule.first': { words: 'keep main safe', covers: 'the repo' }, 'rule.second': { words: 'keep main safe', covers: 'the repo' } }, items).ops).toEqual([
      op('rule.first', 'add', 'added'), op('rule.second', 'drop', 'rule cap 10'),
    ]);
  });
  test('two new facts evict the two least recently changed facts after all ops', () => {
    const items = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`fact.f${i + 1}`, item(`Fact ${i + 1}.`, i + 1)]));
    const r = apply({ 'fact.new-one': { text: 'One.' }, 'fact.new-two': { text: 'Two.' } }, items);
    expect(Object.keys(r.items)).toEqual(['fact.f3', 'fact.f4', 'fact.f5', 'fact.f6', 'fact.new-one', 'fact.new-two']);
    expect(r.ended).toEqual({
      'fact.f1': { item: items['fact.f1'], reason: 'stale: evicted', turn: 10, at: 1000 },
      'fact.f2': { item: items['fact.f2'], reason: 'stale: evicted', turn: 10, at: 1000 },
    });
    expect(r.ops).toEqual([op('fact.new-one', 'add', 'added'), op('fact.new-two', 'add', 'added'), op('fact.f1', 'evict', 'stale: evicted'), op('fact.f2', 'evict', 'stale: evicted')]);
    expect(Object.keys(items)).toHaveLength(6);
  });
  test.each(['open', 'fact', 'lesson', 'doubt'] as Kind[])('%s obeys its own cap; equal stamps evict later object entries first', (kind) => {
    const n = ITEM_CAPS[kind];
    const items = Object.fromEntries(Array.from({ length: n + 2 }, (_, i) => [`${kind}.x${i}`, item('Same.', 10, 1000)]));
    const r = apply({}, items);
    expect(Object.keys(r.items)).toEqual(Object.keys(items).slice(0, n));
    expect(r.ops).toEqual([op(`${kind}.x${n + 1}`, 'evict', 'stale: evicted'), op(`${kind}.x${n}`, 'evict', 'stale: evicted')]);
  });
  test('eviction compares turn first, then time, then later object position', () => {
    const items = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`fact.keep${i}`, item('Keep.', 8, 1)]));
    items['fact.first'] = item('First.', 1, 500);
    items['fact.second'] = item('Second.', 1, 300);
    items['fact.third'] = item('Third.', 2, 100);
    expect(apply({}, items).ops).toEqual([op('fact.second', 'evict', 'stale: evicted'), op('fact.first', 'evict', 'stale: evicted')]);
  });
  test.each([null, '{}', '{oops', '[1]', '""'])('doubt expiry still runs for raw %j', (raw) => {
    const stale = item('Unsure.', ctx.turn - DOUBT_UNTOUCHED_TURNS);
    const recent = item('Recent.', 8);
    const r = applyMemory({ items: { 'doubt.old': stale, 'doubt.recent': recent }, ended: {} }, raw, ctx);
    expect(r.items).toEqual({ 'doubt.recent': recent });
    expect(r.ended).toEqual({ 'doubt.old': { item: stale, reason: 'stale: untouched 3 turns', turn: 10, at: 1000 } });
    expect(r.ops).toEqual([
      ...(raw === null || raw === '{}' ? [] : [op('*', 'drop', 'not a JSON object')]),
      op('doubt.old', 'expire', 'stale: untouched 3 turns'),
    ]);
  });
  test('a touched doubt survives; an expired doubt is not also evicted', () => {
    const items = { 'doubt.old': item('Old.', 7), 'doubt.a': item('A.', 8), 'doubt.b': item('B.', 8), 'doubt.c': item('C.', 8) };
    expect(apply({}, items).ops).toEqual([op('doubt.old', 'expire', 'stale: untouched 3 turns')]);
    const r = apply({ 'doubt.old': { text: 'Updated.' } }, items);
    expect(r.items['doubt.old']).toEqual({ text: 'Updated.', from: 'shown', turn: 10, at: 1000 });
    expect(r.ops).toEqual([op('doubt.old', 'set', 'text'), op('doubt.c', 'evict', 'stale: evicted')]);
  });
  test.each([null, '{}'])('ended keeps the twenty newest by time, then turn for raw %j', (raw) => {
    const ended = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`fact.x${i}`, { item: item(), reason: 'done', turn: i, at: Math.floor(i / 2) }]));
    const r = applyMemory({ items: {}, ended }, raw, ctx);
    expect(Object.keys(r.ended)).toHaveLength(ENDED_KEPT);
    expect(new Set(Object.keys(r.ended))).toEqual(new Set(Object.keys(ended).slice(5)));
    expect(r.ops).toEqual([]);
    expect(Object.keys(ended)).toHaveLength(25);
  });
});

describe('v1 note migration', () => {
  test('drawn character first, then object order, list order, every kind and default provenance', () => {
    const notes = Object.freeze({
      duck: Object.freeze(['- OPEN: Fix the CLI.', '* lesson: Check before tagging.']),
      cat: Object.freeze(['• rule: keep main safe', '1. fact: Tests passed.', '1) doubt: Maybe a race.', 'Untyped plain note.']),
    });
    const r = migrateNotes(notes as unknown as Record<string, string[]>, 'cat', ctx);
    expect(r).toEqual({
      items: {
        'rule.keep-main-safe': { words: 'keep main safe', covers: 'the chat', from: 'user', turn: 10, at: 1000, migrated: true },
        'fact.tests-passed': { text: 'Tests passed.', from: 'shown', turn: 10, at: 1000, migrated: true },
        'doubt.maybe-a-race': { text: 'Maybe a race.', from: 'buddy', turn: 10, at: 1000, migrated: true },
        'fact.untyped-plain-note': { text: 'Untyped plain note.', from: 'shown', turn: 10, at: 1000, migrated: true },
        'open.fix-the-cli': { text: 'Fix the CLI.', from: 'user', turn: 10, at: 1000, migrated: true },
        'lesson.check-before-tagging': { text: 'Check before tagging.', from: 'shown', turn: 10, at: 1000, migrated: true },
      }, ended: {}, ops: [
        op('rule.keep-main-safe', 'migrate', 'rule note of cat'),
        op('fact.tests-passed', 'migrate', 'fact note of cat'),
        op('doubt.maybe-a-race', 'migrate', 'doubt note of cat'),
        op('fact.untyped-plain-note', 'migrate', 'fact note of cat'),
        op('open.fix-the-cli', 'migrate', 'open note of duck'),
        op('lesson.check-before-tagging', 'migrate', 'lesson note of duck'),
      ],
    });
    expect(notes.cat[0]).toBe('• rule: keep main safe');
  });
  test.each([null, 'missing'])('no drawn character %j preserves object order', (drawn) => {
    expect(Object.keys(migrateNotes({ duck: ['First.'], cat: ['Second.'] }, drawn, ctx).items)).toEqual(['fact.first', 'fact.second']);
    expect(migrateNotes({}, drawn, ctx)).toEqual({ items: {}, ended: {}, ops: [] });
  });
  test('folded duplicates are dropped across characters and kinds, with the would-be key', () => {
    expect(migrateNotes({ duck: ['fact: Tests passed.', 'open: “Main” safe'], cat: ['  * FACT: TESTS   PASSED.  ', 'lesson: "main" safe'] }, 'duck', ctx).ops).toEqual([
      op('fact.tests-passed', 'migrate', 'fact note of duck'),
      op('open.main-safe', 'migrate', 'open note of duck'),
      op('fact.tests-passed-2', 'drop', 'duplicate note'),
      op('lesson.main-safe', 'drop', 'duplicate note'),
    ]);
  });
  test('slugs use the first four runs, collisions use the first three plus a suffix, no runs use note', () => {
    const r = migrateNotes({ duck: ['One two three four five.', 'One two three four six.', 'One two three 2.', 'One two three four seven.', '!!!', '???'] }, null, ctx);
    expect(Object.keys(r.items)).toEqual(['fact.one-two-three-four', 'fact.one-two-three-2', 'fact.one-two-three-3', 'fact.one-two-three-4', 'fact.note', 'fact.note-2']);
    for (const entry of Object.values(r.items)) expect(entry).toMatchObject({ from: 'shown', turn: 10, at: 1000, migrated: true });
  });
  test('an untyped old rule becomes a buddy fact without granting user authority', () => {
    expect(migrateNotes({ duck: ['rule: push freely'] }, null, ctx)).toEqual({
      items: { 'fact.push-freely': { text: "Noted earlier as the user's rule, unverified: push freely", from: 'buddy', turn: 10, at: 1000, migrated: true } },
      ended: {}, ops: [op('fact.push-freely', 'migrate', 'rule note of duck, not typed by the user: kept as a fact')],
    });
  });
  test('truncates long notes and the unverified-rule wrapper to 299 characters plus ellipsis', () => {
    const long = 'x'.repeat(301);
    const unverified = `Noted earlier as the user's rule, unverified: ${long}`;
    const r = migrateNotes({ duck: [long, `rule: ${long}`] }, null, ctx);
    // The same original text is a duplicate even when it had another kind.
    expect(Object.values(r.items)[0]!.text).toBe(`${long.slice(0, 299)}…`);
    expect(r.ops[1]).toMatchObject({ op: 'drop', why: 'duplicate note' });
    expect(Object.values(migrateNotes({ duck: [`rule: ${long}`] }, null, ctx).items)[0]!.text).toBe(`${unverified.slice(0, 299)}…`);
    expect(Object.values(migrateNotes({ duck: ['x'.repeat(300)] }, null, ctx).items)[0]!.text).toBe('x'.repeat(300));
  });
  test('a rule note too long to keep whole stays an unverified fact: its cut words would quote nothing typed', () => {
    const text = 'keep '.repeat(61).trim();
    const r = migrateNotes({ cat: [`rule: ${text}`] }, 'cat', { ...ctx, typed: [text] });
    expect(Object.keys(r.items)).toEqual(['fact.keep-keep-keep-keep']);
    expect(Object.values(r.items)[0]).toMatchObject({ from: 'buddy' });
    expect(Object.values(r.items)[0]!.words).toBeUndefined();
    expect(r.ops).toEqual([op('fact.keep-keep-keep-keep', 'migrate', 'rule note of cat, not typed by the user: kept as a fact')]);
  });
  test('a verified rule note at the size limit keeps its words whole', () => {
    const text = `keep main safe ${'x'.repeat(ITEM_MAX_CHARS - 15)}`;
    const r = migrateNotes({ cat: [`rule: ${text}`] }, 'cat', { ...ctx, typed: [text] });
    expect(Object.values(r.items)[0]).toEqual({ words: text, covers: 'the chat', from: 'user', turn: 10, at: 1000, migrated: true });
  });
  test('an empty note, or one that is only its kind, is dropped rather than migrated empty', () => {
    const r = migrateNotes({ cat: ['', '   ', 'fact:', '- rule: ', 'Kept.'] }, 'cat', ctx);
    expect(Object.keys(r.items)).toEqual(['fact.kept']);
    expect(r.ops.filter((o) => o.op === 'drop').map((o) => o.why)).toEqual(['empty note of cat', 'empty note of cat', 'empty note of cat', 'empty note of cat']);
  });
  test.each(['open', 'fact', 'lesson', 'doubt'] as Kind[])('migration applies %s cap after migrate ops, with no expiry', (kind) => {
    const n = ITEM_CAPS[kind];
    const notes = Array.from({ length: n + 2 }, (_, i) => `${kind}: Note ${i}.`);
    const r = migrateNotes({ cat: notes }, 'cat', ctx);
    expect(Object.keys(r.items)).toEqual(Array.from({ length: n }, (_, i) => `${kind}.note-${i}`));
    expect(r.ops).toEqual([
      ...notes.map((_, i) => op(`${kind}.note-${i}`, 'migrate', `${kind} note of cat`)),
      op(`${kind}.note-${n + 1}`, 'evict', 'stale: evicted'), op(`${kind}.note-${n}`, 'evict', 'stale: evicted'),
    ]);
    expect(Object.keys(r.ended)).toHaveLength(2);
  });
  test('migration drops rules past ten after migration, keeping the drawn character first', () => {
    const first = Array.from({ length: 10 }, (_, i) => `keep main safe ${i}`);
    const later = ['keep main safe 10', 'keep main safe 11'];
    const r = migrateNotes({ duck: later.map((s) => `rule: ${s}`), cat: first.map((s) => `rule: ${s}`) }, 'cat', { ...ctx, typed: [...first, ...later] });
    expect(Object.keys(r.items)).toEqual(first.map((_, i) => `rule.keep-main-safe-${i}`));
    expect(r.ended).toEqual({});
    expect(r.ops).toEqual([
      ...first.map((_, i) => op(`rule.keep-main-safe-${i}`, 'migrate', 'rule note of cat')),
      ...later.map((_, i) => op(`rule.keep-main-safe-${i + 10}`, 'migrate', 'rule note of duck')),
      op('rule.keep-main-safe-10', 'drop', 'rule cap 10'), op('rule.keep-main-safe-11', 'drop', 'rule cap 10'),
    ]);
  });
  test('a migrated item is never evicted by new items of its kind, and joins them once the model rewrites it', () => {
    const migrated = migrateNotes({ cat: Array.from({ length: 5 }, (_, i) => `rule: Standing order ${i}`) }, 'cat', ctx);
    const standing = Array.from({ length: 5 }, (_, i) => `fact.standing-order-${i}`);
    expect(Object.keys(migrated.items)).toEqual(standing);
    let memory = { items: migrated.items, ended: migrated.ended };
    const ops: MemoryOp[] = [];
    for (let i = 1; i <= 6; i++) {
      const r = applyMemory(memory, JSON.stringify({ [`fact.new-${i}`]: { text: `New ${i}.` } }), { ...ctx, turn: 10 + i, at: 1000 + i });
      ops.push(...r.ops);
      memory = r;
    }
    expect(ops.filter((o) => o.op === 'evict')).toEqual([]);
    expect(Object.keys(memory.items)).toHaveLength(11);
    for (const key of standing) expect(memory.items[key]).toMatchObject({ migrated: true });
    const rewritten = applyMemory(memory, JSON.stringify({ 'fact.standing-order-2': { text: 'Rewritten.' } }), { ...ctx, turn: 17, at: 1017 });
    expect(rewritten.items['fact.standing-order-2']).toEqual({ text: 'Rewritten.', from: 'buddy', turn: 17, at: 1017 });
    // It joins the six new facts, so the seventh non-migrated fact evicts the least recently changed of them.
    expect(rewritten.ops).toEqual([
      { key: 'fact.standing-order-2', op: 'set', why: 'text', turn: 17 },
      { key: 'fact.new-1', op: 'evict', why: 'stale: evicted', turn: 17 },
    ]);
    const next = applyMemory(rewritten, JSON.stringify({ 'fact.new-7': { text: 'New 7.' } }), { ...ctx, turn: 18, at: 1018 });
    expect(next.ops).toEqual([
      { key: 'fact.new-7', op: 'add', why: 'added', turn: 18 },
      { key: 'fact.new-2', op: 'evict', why: 'stale: evicted', turn: 18 },
    ]);
    for (const key of standing.filter((k) => k !== 'fact.standing-order-2')) expect(next.items[key]).toMatchObject({ migrated: true });
    expect(next.items['fact.standing-order-2']).not.toHaveProperty('migrated');
  });
  test('an end still ends a migrated item; a migrated doubt still expires after 3 untouched turns', () => {
    const migrated = migrateNotes({ cat: ['open: Fix the CLI.', 'doubt: Maybe a race.'] }, 'cat', ctx);
    const memory = { items: migrated.items, ended: migrated.ended };
    const ended = apply({ 'open.fix-the-cli': { end: 'done: shipped' } }, memory.items, memory.ended);
    expect(ended.items).not.toHaveProperty(['open.fix-the-cli']);
    expect(ended.ended['open.fix-the-cli']).toEqual({ item: memory.items['open.fix-the-cli'], reason: 'done: shipped', turn: 10, at: 1000 });
    expect(ended.ops).toEqual([op('open.fix-the-cli', 'end', 'done: shipped')]);
    const early = applyMemory(memory, null, { ...ctx, turn: 10 + DOUBT_UNTOUCHED_TURNS - 1 });
    expect(early.items).toHaveProperty(['doubt.maybe-a-race']);
    const expired = applyMemory(memory, null, { ...ctx, turn: 10 + DOUBT_UNTOUCHED_TURNS });
    expect(expired.items).not.toHaveProperty(['doubt.maybe-a-race']);
    expect(expired.ops).toEqual([{ key: 'doubt.maybe-a-race', op: 'expire', why: 'stale: untouched 3 turns', turn: 13 }]);
  });
  test('migration keeps rule notes ahead of plain notes of their kind at the cap', () => {
    const duck = Array.from({ length: 6 }, (_, i) => `fact: Duck note ${i}`);
    const r = migrateNotes({ duck, cat: ['rule: Cat rule 0', 'rule: Cat rule 1'] }, 'duck', ctx);
    expect(Object.keys(r.items)).toEqual(['fact.cat-rule-0', 'fact.cat-rule-1', 'fact.duck-note-0', 'fact.duck-note-1', 'fact.duck-note-2', 'fact.duck-note-3']);
    expect(r.ops.filter((o) => o.op === 'evict').map((o) => o.key)).toEqual(['fact.duck-note-5', 'fact.duck-note-4']);
    expect(r.ops.filter((o) => o.op === 'migrate').map((o) => o.key)).toEqual(['fact.duck-note-0', 'fact.duck-note-1', 'fact.duck-note-2', 'fact.duck-note-3', 'fact.duck-note-4', 'fact.duck-note-5', 'fact.cat-rule-0', 'fact.cat-rule-1']);
  });
  test('migration trims ended history to twenty after all kind caps', () => {
    const notes = (['open', 'fact', 'lesson', 'doubt'] as Kind[]).flatMap((kind) => Array.from({ length: 15 }, (_, i) => `${kind}: ${kind} ${i}`));
    expect(Object.keys(migrateNotes({ cat: notes }, null, ctx).ended)).toHaveLength(ENDED_KEPT);
  });
});

describe('memory renderings', () => {
  const items: Items = {
    'doubt.race': { text: 'Maybe a race.', from: 'buddy', turn: 11, at: 100 },
    'fact.tests': item('Tests passed.', 8),
    'rule.main': { ...rule(), text: 'Internal explanation.' },
    'lesson.check': { text: 'Check before tagging.', from: 'claude', turn: 6, at: 100 },
    'open.cli': { text: 'Fix the CLI.', from: 'user', turn: 9, at: 100 },
    'fact.next': item('Next fact.', 9),
  };
  test('renderItems uses the R3 header and kinds in order, insertion order within a kind, nonnegative age', () => {
    expect(ITEMS_HEAD).toBe('Your memory (one item per line: key · text or words · from · age in turns since it last changed):');
    expect(renderItems(items, 10)).toBe([
      ITEMS_HEAD,
      'rule.main · keep main safe · user · 6',
      'open.cli · Fix the CLI. · user · 1',
      'fact.tests · Tests passed. · shown · 2',
      'fact.next · Next fact. · shown · 1',
      'lesson.check · Check before tagging. · claude · 4',
      'doubt.race · Maybe a race. · buddy · 0',
    ].join('\n'));
    expect(renderItems({}, 10)).toBe(`${ITEMS_HEAD}\nnone`);
  });
  test('itemsText renders the exact markdown layout and ended records newest first, then turn on ties', () => {
    const ended = {
      'fact.old': { item: item('Old fact.'), reason: 'stale: evicted', turn: 4, at: 400 },
      'open.latest': { item: item('CLI shipped.'), reason: 'done: shipped', turn: 10, at: 1000 },
      'rule.lifted': { item: rule('never push without asking'), reason: 'lifted: allowed', turn: 9, at: 1000 },
    };
    expect(itemsText(items, ended, 10)).toBe([
      '## Items, by kind (age: turns since it last changed)', '',
      '### rule', '- rule.main · "keep main safe" covers: the repo · from user · age 6', '',
      '### open', '- open.cli · Fix the CLI. · from user · age 1', '',
      '### fact', '- fact.tests · Tests passed. · from shown · age 2', '- fact.next · Next fact. · from shown · age 1', '',
      '### lesson', '- lesson.check · Check before tagging. · from claude · age 4', '',
      '### doubt', '- doubt.race · Maybe a race. · from buddy · age 0', '',
      '## Ended, newest first', '',
      '- open.latest · done: shipped · turn 10 · CLI shipped.',
      '- rule.lifted · lifted: allowed · turn 9 · never push without asking',
      '- fact.old · stale: evicted · turn 4 · Old fact.',
    ].join('\n'));
  });
  test('empty memory and ended history say none; missing kinds add no extra headings', () => {
    expect(itemsText({}, {}, 10)).toBe('## Items, by kind (age: turns since it last changed)\n\nnone\n\n## Ended, newest first\n\nnone');
    expect(itemsText({ 'fact.x': item() }, {}, 10)).toBe('## Items, by kind (age: turns since it last changed)\n\n### fact\n- fact.x · Old. · from shown · age 6\n\n## Ended, newest first\n\nnone');
  });
});

describe('stored items loader', () => {
  test('keeps valid values and counts a malformed live item and ended record', () => {
    const live = item();
    const ended = { item: rule(), reason: 'lifted: done', turn: 9, at: 900 };
    const r = itemsOf({ 'fact.x': live, 'fact.bad': { text: 'bad' } }, { 'rule.x': ended, 'open.bad': { item: item(), reason: 1, turn: 10, at: 1000 } });
    expect(r).toEqual({ items: { 'fact.x': live }, ended: { 'rule.x': ended }, dropped: 2 });
    expect(r.items['fact.x']).toBe(live);
    expect(r.ended['rule.x']).toBe(ended);
  });
  test('undefined is an empty store with no dropped entries', () => {
    expect(itemsOf(undefined, undefined)).toEqual({ items: {}, ended: {}, dropped: 0 });
  });
  test.each([null, [], 1, 'text', false])('non-object %j counts once for each store', (value) => {
    expect(itemsOf(value, value)).toEqual({ items: {}, ended: {}, dropped: 2 });
    expect(itemsOf(value, undefined).dropped).toBe(1);
    expect(itemsOf(undefined, value).dropped).toBe(1);
  });
  const malformed: [string, string, unknown][] = [
    ['bad key', 'bad.x', item()],
    ...[null, [], 'text', 1].map((value): [string, string, unknown] => [`not object ${JSON.stringify(value)}`, 'fact.x', value]),
    ['bad from', 'fact.x', { ...item(), from: 'me' }],
    ['missing from', 'fact.x', { text: 'a', turn: 1, at: 1 }],
    ...['turn', 'at'].flatMap((field) => [undefined, NaN, Infinity, -Infinity, '1', null].map((value): [string, string, unknown] => [`${field} ${String(value)}`, 'fact.x', { ...item(), [field]: value }])),
    ...['text', 'words', 'covers'].flatMap((field) => [null, [], {}, 1].map((value): [string, string, unknown] => [`${field} ${JSON.stringify(value)}`, 'fact.x', { ...item(), [field]: value }])),
    ['missing text', 'fact.x', { from: 'shown', turn: 1, at: 1 }],
    ['rule missing words', 'rule.x', { covers: 'repo', from: 'user', turn: 1, at: 1 }],
    ['rule missing covers', 'rule.x', { words: 'keep safe', from: 'user', turn: 1, at: 1 }],
  ];
  test.each(malformed)('%s rejected both live and inside an ended record', (_label, key, value) => {
    expect(itemsOf({ [key]: value }, { [key]: { item: value, reason: 'done', turn: 10, at: 1000 } })).toEqual({ items: {}, ended: {}, dropped: 2 });
  });
  test.each([
    null, [], 'text', 1,
    { item: item(), reason: 1, turn: 10, at: 1000 },
    { item: item(), turn: 10, at: 1000 },
    ...['turn', 'at'].flatMap((field) => [undefined, NaN, Infinity, '1', null].map((value) => ({ item: item(), reason: 'done', turn: 10, at: 1000, [field]: value }))),
  ])('malformed ended record %j counts once', (value) => {
    expect(itemsOf(undefined, { 'fact.x': value })).toEqual({ items: {}, ended: {}, dropped: 1 });
  });
  test('a migrated marker is kept only when it is exactly true', () => {
    const good = { ...item(), migrated: true };
    const r = itemsOf({ 'fact.a': good, 'fact.b': { ...item(), migrated: false }, 'fact.c': { ...item(), migrated: 'yes' } }, undefined);
    expect(r).toEqual({ items: { 'fact.a': good }, ended: {}, dropped: 2 });
  });
  test('all four From values accepted; loading checks stored shape without reapplying op limits', () => {
    const items = Object.fromEntries(['user', 'claude', 'shown', 'buddy'].map((from, i) => [`fact.x${i}`, { text: 'x'.repeat(301), from, turn: 1, at: 1 }]));
    items['rule.x'] = { ...rule(), from: 'claude' } as unknown as typeof items[string];
    expect(itemsOf(items, undefined)).toEqual({ items, ended: {}, dropped: 0 });
  });
});
