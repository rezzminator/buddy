// The buddy's per-chat memory: keyed items edited by the model, checked and
// stamped by code, with ended items kept separately. No I/O: the adapter
// supplies the user's typed prompts, the chat's turn number and the time.

import { isObject } from './character.ts';
import { cutTo } from './cuts.ts';

export type Kind = 'rule' | 'open' | 'fact' | 'lesson' | 'doubt';
/** `unknown`: a from the model or a stored item gave that is none of the others; it is display text and decides nothing. */
export type From = 'user' | 'claude' | 'shown' | 'buddy' | 'unknown';
/** `migrated` is set by migrateNotes on every item it makes, and gone once the model rewrites the item. */
export type Item = { text?: string; words?: string; covers?: string; from: From; turn: number; at: number; migrated?: true };
export type Items = Record<string, Item>;
/** `turn` and `at` absent: a stored record that lost them, kept with its item; they only order and label it. */
export type Ended = { item: Item; reason: string; turn?: number; at?: number };
export type EndedItems = Record<string, Ended>;
export type MemoryOp = { key: string; op: 'add' | 'set' | 'end' | 'drop' | 'evict' | 'expire' | 'migrate'; why: string; turn: number };
/**
 * `since`: for a late reply, the items and ended items as its call read them;
 * an op on a key changed since then is dropped, the newer change kept.
 */
export type MemoryContext = { turn: number; at: number; typed: readonly string[]; since?: { items: Items; ended: EndedItems } };

export const ITEM_KEY = /^(rule|open|fact|lesson|doubt)\.[a-z0-9]+(-[a-z0-9]+){0,3}$/;
export const ITEM_CAPS: Record<Kind, number> = { rule: 10, open: 6, fact: 6, lesson: 4, doubt: 3 };
export const ITEM_MAX_CHARS = 300;
export const ENDED_KEPT = 20;
export const DOUBT_UNTOUCHED_TURNS = 3;
export const ITEMS_HEAD = 'Your memory (one item per line: key · text or words · from · age in turns since it last changed):';

type MemoryResult = { items: Items; ended: EndedItems; ops: MemoryOp[] };
type Change = Partial<Pick<Item, 'text' | 'words' | 'covers' | 'from'>> & { end?: string };
const FIELDS = ['text', 'words', 'covers', 'from', 'end'];
const ITEM_FIELDS = ['text', 'words', 'covers', 'from'] as const;
const FROM: readonly From[] = ['user', 'claude', 'shown', 'buddy'];
/** The reason an end or a stored ended record is kept with when its own is not one this release reads. */
export const UNKNOWN_REASON = 'unknown';
const KINDS = Object.keys(ITEM_CAPS) as Kind[];

function foldWords(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The least a rule's words hold: a quote shorter than this proves nothing about what the user said. */
export const RULE_WORDS_MIN = 3;
export const RULE_CHARS_MIN = 12;

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Whether `inner` occurs in `outer` with no word character either side of it. */
function boundedIn(outer: string, inner: string): boolean {
  for (let at = outer.indexOf(inner); at >= 0; at = outer.indexOf(inner, at + 1)) {
    const before = at === 0 ? '' : outer[at - 1]!;
    const after = outer[at + inner.length] ?? '';
    if (!(before && WORD_CHAR.test(before) && WORD_CHAR.test(inner[0]!)) && !(after && WORD_CHAR.test(after) && WORD_CHAR.test(inner.at(-1)!))) return true;
  }
  return false;
}

/**
 * Rules quote a meaningful span of a prompt the user typed: at least
 * RULE_WORDS_MIN words and RULE_CHARS_MIN characters, matched at word
 * boundaries, with spacing, case and quotes folded.
 */
export function wordsTyped(words: string, typed: readonly string[]): boolean {
  const folded = foldWords(words);
  if (folded.length < RULE_CHARS_MIN) return false;
  if (folded.split(' ').filter((w) => WORD_CHAR.test(w)).length < RULE_WORDS_MIN) return false;
  return typed.some((text) => boundedIn(foldWords(text), folded));
}

function kindOf(key: string): Kind {
  return key.slice(0, key.indexOf('.')) as Kind;
}

/**
 * One op's change, or why it is dropped whole. A bad field never costs the op
 * its good ones: an unknown, non-text or blank field is ignored, a field past
 * ITEM_MAX_CHARS is cut (rule words at a word boundary, so they still quote
 * what was typed), a from that is none of FROM reads as unknown, an end
 * reason off its grammar ends the item with the reason unknown; each is named
 * in `notes`, which the op row carries.
 */
function checkOp(key: string, value: unknown, items: Items, ctx: MemoryContext): { why: string | null; change: Change; notes: string[] } {
  const notes: string[] = [];
  const change: Change = {};
  const drop = (why: string) => ({ why, change, notes });
  if (!ITEM_KEY.test(key)) return drop('bad key');
  if (!isObject(value)) return drop('not an object');
  for (const [field, raw] of Object.entries(value)) {
    if (!FIELDS.includes(field)) notes.push(`ignored unknown field ${field}`);
    else if (typeof raw !== 'string') notes.push(`ignored not text: ${field}`);
    else if (raw.trim() === '') notes.push(`ignored empty: ${field}`);
    else {
      const text = raw.trim();
      const long = text.length > ITEM_MAX_CHARS;
      if (long) notes.push(`cut too long: ${field}`);
      (change as Record<string, string>)[field] = !long ? text : field === 'words' ? cutWords(text) : cutNote(text);
    }
  }
  if (change.from !== undefined && !FROM.includes(change.from)) {
    notes.push(`bad from ${change.from}: unknown`);
    change.from = 'unknown';
  }
  const old = items[key];
  if (change.end !== undefined) {
    if (!old) return drop('end on unknown key');
    if (!/^(done|met|lifted|stale|wrong)\b/i.test(change.end)) {
      notes.push(`bad end: reason ${UNKNOWN_REASON}`);
      change.end = `${UNKNOWN_REASON}: ${change.end}`;
    }
    return { why: null, change, notes };
  }
  if (Object.keys(change).length === 0) return drop('no field');
  if (!old) {
    if (kindOf(key) !== 'rule' && change.text === undefined) return drop('new item without text');
    if (kindOf(key) === 'rule' && change.words === undefined) return drop('new rule without words');
    if (kindOf(key) === 'rule' && Object.keys(items).filter((k) => kindOf(k) === 'rule').length >= ITEM_CAPS.rule) return drop('rule cap 10');
  }
  if (kindOf(key) === 'rule' && change.words !== undefined && !wordsTyped(change.words, ctx.typed)) return drop('words not typed by the user');
  return { why: null, change, notes };
}

function endItem(result: MemoryResult, key: string, action: 'end' | 'expire' | 'evict', reason: string, ctx: MemoryContext): void {
  result.ended[key] = { item: result.items[key]!, reason, turn: ctx.turn, at: ctx.at };
  delete result.items[key];
  result.ops.push({ key, op: action, why: reason, turn: ctx.turn });
}

/**
 * A kind holds at most its cap of items the model changed and, beside them, at
 * most its cap of untouched migrated items; migration is their only maker, so
 * that group only shrinks. The prompt stays bounded by twice the caps. Within a
 * group the least recently changed goes first (turn, then time, then later position).
 */
function capItems(result: MemoryResult, ctx: MemoryContext): void {
  for (const kind of KINDS.filter((k) => k !== 'rule')) {
    for (const migrated of [false, true]) {
      const entries = Object.entries(result.items).filter(([key, item]) => kindOf(key) === kind && (item.migrated === true) === migrated);
      const oldest = entries.map(([key, item], index) => ({ key, item, index }))
        .sort((a, b) => a.item.turn - b.item.turn || a.item.at - b.item.at || b.index - a.index);
      for (const { key } of oldest.slice(0, Math.max(0, entries.length - ITEM_CAPS[kind]))) {
        endItem(result, key, 'evict', 'stale: evicted', ctx);
      }
    }
  }
  result.ended = Object.fromEntries(Object.entries(result.ended)
    .sort(([, a], [, b]) => newestFirst(a, b)).slice(0, ENDED_KEPT));
}

/** Apply only the named keys, leaving the caller's objects unchanged. */
export function applyMemory(memory: { items: Items; ended: EndedItems }, raw: string | null, ctx: MemoryContext): MemoryResult {
  const result: MemoryResult = { items: { ...memory.items }, ended: { ...memory.ended }, ops: [] };
  if (raw !== null) {
    let value: unknown;
    try { value = JSON.parse(raw); } catch { value = null; }
    if (!isObject(value)) {
      // The ops it held are unreadable; their text stays in the op row.
      result.ops.push({ key: '*', op: 'drop', why: `not a JSON object: ${cutNote(raw)}`, turn: ctx.turn });
    } else {
      for (const [key, change] of Object.entries(value)) {
        if (ctx.since && changedSince(key, memory, ctx.since)) {
          const held = key in ctx.since.items || key in ctx.since.ended;
          result.ops.push({ key, op: 'drop', why: held ? 'late reply: a newer memory save changed it first' : "late reply: the call's prompt did not hold this item", turn: ctx.turn });
          continue;
        }
        const { why, change: fields, notes } = checkOp(key, change, result.items, ctx);
        const noted = (base: string) => [base, ...notes].filter(Boolean).join('; ');
        if (why !== null) {
          result.ops.push({ key, op: 'drop', why: noted(why), turn: ctx.turn });
          continue;
        }
        const old = result.items[key];
        if (fields.end !== undefined) {
          endItem(result, key, 'end', fields.end, ctx);
          if (notes.length > 0) result.ops.at(-1)!.why = noted(fields.end);
        } else {
          if (kindOf(key) === 'rule') fields.from = 'user';
          else { delete fields.words; delete fields.covers; }
          const next: Item = { from: 'buddy', ...old, ...fields, turn: ctx.turn, at: ctx.at };
          delete next.migrated;
          result.items[key] = next;
          const added = result.ended[key] ? 're-added after end' : 'added';
          delete result.ended[key];
          result.ops.push({ key, op: old ? 'set' : 'add', why: noted(old ? ITEM_FIELDS.filter((field) => old[field] !== result.items[key]![field]).join(', ') : added), turn: ctx.turn });
        }
      }
    }
  }
  for (const [key, item] of Object.entries(result.items)) {
    if (kindOf(key) === 'doubt' && ctx.turn - item.turn >= DOUBT_UNTOUCHED_TURNS) {
      endItem(result, key, 'expire', 'stale: untouched 3 turns', ctx);
    }
  }
  capItems(result, ctx);
  return result;
}

/** Whether item `key`, live or ended, differs in `now` from `then`. */
function changedSince(key: string, now: { items: Items; ended: EndedItems }, then: { items: Items; ended: EndedItems }): boolean {
  return JSON.stringify(now.items[key]) !== JSON.stringify(then.items[key]) || JSON.stringify(now.ended[key]) !== JSON.stringify(then.ended[key]);
}

/** Ended records newest first, by time then turn; one without them sorts as the oldest. */
function newestFirst(a: Ended, b: Ended): number {
  return (b.at ?? 0) - (a.at ?? 0) || (b.turn ?? 0) - (a.turn ?? 0);
}

function cutNote(text: string): string {
  return cutTo(text, ITEM_MAX_CHARS);
}

/** Rule words cut to ITEM_MAX_CHARS at their last word boundary, no mark added: a cut quote still quotes what was typed. */
function cutWords(text: string): string {
  const head = text.slice(0, ITEM_MAX_CHARS + 1);
  const at = head.lastIndexOf(' ');
  return (at > 0 ? head.slice(0, at) : head.slice(0, ITEM_MAX_CHARS)).trim();
}

function migrationKey(kind: Kind, text: string, items: Items): string {
  const runs = text.toLowerCase().match(/[a-z0-9]+/g) ?? ['note'];
  let key = `${kind}.${runs.slice(0, 4).join('-')}`;
  for (let n = 2; Object.hasOwn(items, key); n++) key = `${kind}.${runs.slice(0, 3).join('-')}-${n}`;
  return key;
}

/** One-time v1 migration, drawn character first; old rules need the same typed-words proof. */
export function migrateNotes(notes: Record<string, string[]>, drawnId: string | null, ctx: MemoryContext): MemoryResult {
  const result: MemoryResult = { items: {}, ended: {}, ops: [] };
  const ids = Object.keys(notes);
  if (drawnId !== null && Object.hasOwn(notes, drawnId)) ids.splice(0, 0, ...ids.splice(ids.indexOf(drawnId), 1));
  const seen = new Set<string>();
  const fromRule = new Set<string>();
  for (const id of ids) {
    for (const note of notes[id]!) {
      const cleaned = note.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '').trim();
      const prefix = /^(rule|open|fact|lesson|doubt)\s*:\s*/i.exec(cleaned);
      const originalKind = (prefix?.[1]?.toLowerCase() ?? 'fact') as Kind;
      const text = cleaned.slice(prefix?.[0].length ?? 0).trim();
      if (text === '') {
        result.ops.push({ key: `${originalKind}.note`, op: 'drop', why: `empty note of ${id}`, turn: ctx.turn });
        continue;
      }
      // Words cut to fit would no longer be what the user typed: a longer rule note stays a fact.
      const verified = originalKind === 'rule' && text.length <= ITEM_MAX_CHARS && wordsTyped(text, ctx.typed);
      const kind = originalKind === 'rule' && !verified ? 'fact' : originalKind;
      const key = migrationKey(kind, text, result.items);
      const folded = foldWords(text);
      if (seen.has(folded)) {
        result.ops.push({ key, op: 'drop', why: 'duplicate note', turn: ctx.turn });
        continue;
      }
      seen.add(folded);
      if (verified) {
        result.items[key] = { words: text, covers: 'the chat', from: 'user', turn: ctx.turn, at: ctx.at, migrated: true };
      } else {
        const unverified = originalKind === 'rule';
        const from: From = unverified || kind === 'doubt' ? 'buddy' : kind === 'open' ? 'user' : 'shown';
        result.items[key] = { text: cutNote(unverified ? `Noted earlier as the user's rule, unverified: ${text}` : text), from, turn: ctx.turn, at: ctx.at, migrated: true };
      }
      if (originalKind === 'rule') fromRule.add(key);
      const why = originalKind === 'rule' && !verified
        ? `rule note of ${id}, not typed by the user: kept as a fact` : `${kind} note of ${id}`;
      result.ops.push({ key, op: 'migrate', why, turn: ctx.turn });
    }
  }
  // At a kind's cap a rule note kept as a fact outranks a plain note: the stable sort puts them first.
  result.items = Object.fromEntries(Object.entries(result.items).sort(([a], [b]) => Number(!fromRule.has(a)) - Number(!fromRule.has(b))));
  for (const key of Object.keys(result.items).filter((k) => kindOf(k) === 'rule').slice(ITEM_CAPS.rule)) {
    delete result.items[key];
    result.ops.push({ key, op: 'drop', why: 'rule cap 10', turn: ctx.turn });
  }
  capItems(result, ctx);
  return result;
}

function orderedItems(items: Items): [string, Item][] {
  const entries = Object.entries(items);
  return KINDS.flatMap((kind) => entries.filter(([key]) => kindOf(key) === kind));
}

/** The item-line rendering tested with the memory instruction, live items only. */
export function renderItems(items: Items, turn: number): string {
  const lines = orderedItems(items).map(([key, item]) => `${key} · ${kindOf(key) === 'rule' ? item.words : item.text} · ${item.from} · ${Math.max(0, turn - item.turn)}`);
  return [ITEMS_HEAD, ...(lines.length ? lines : ['none'])].join('\n');
}

/** The human-readable part of memory.md, including ended items. */
export function itemsText(items: Items, ended: EndedItems, turn: number): string {
  const lines = ['## Items, by kind (age: turns since it last changed)', ''];
  const entries = orderedItems(items);
  for (const kind of KINDS) {
    const group = entries.filter(([key]) => kindOf(key) === kind);
    if (!group.length) continue;
    lines.push(`### ${kind}`);
    for (const [key, item] of group) {
      const age = Math.max(0, turn - item.turn);
      lines.push(kind === 'rule'
        ? `- ${key} · "${item.words}" covers: ${item.covers ?? 'unknown'} · from user · age ${age}`
        : `- ${key} · ${item.text} · from ${item.from} · age ${age}`);
    }
    lines.push('');
  }
  if (!entries.length) lines.push('none', '');
  lines.push('## Ended, newest first', '');
  const records = Object.entries(ended).sort(([, a], [, b]) => newestFirst(a, b));
  for (const [key, record] of records) lines.push(`- ${key} · ${record.reason} · turn ${record.turn ?? 'unknown'} · ${record.item.words ?? record.item.text}`);
  if (!records.length) lines.push('none');
  return lines.join('\n');
}

/**
 * A stored item as this release keeps it, or null when it holds no content (a
 * rule's words, another kind's text) or no stamps: a from that is none of
 * FROM reads as unknown, a non-text covers or text is left out, a migrated
 * other than true is absent.
 */
function storedItem(key: string, value: unknown): Item | null {
  if (!ITEM_KEY.test(key) || !isObject(value) || !Number.isFinite(value.turn) || !Number.isFinite(value.at)) return null;
  const rule = kindOf(key) === 'rule';
  const content = rule ? value.words : value.text;
  if (typeof content !== 'string') return null;
  const text = (field: 'text' | 'words' | 'covers') => (typeof value[field] === 'string' ? { [field]: value[field] as string } : {});
  return {
    ...text('text'), ...text('words'), ...text('covers'),
    from: FROM.includes(value.from as From) ? (value.from as From) : 'unknown',
    turn: value.turn as number,
    at: value.at as number,
    ...(value.migrated === true ? { migrated: true as const } : {}),
  };
}

/** Keep valid stored entries, counting each malformed item or ended record once; an ended record keeps its item with the reason unknown and without a turn or time it lost. */
export function itemsOf(items: unknown, ended: unknown): { items: Items; ended: EndedItems; dropped: number } {
  const result = { items: {} as Items, ended: {} as EndedItems, dropped: 0 };
  if (items !== undefined) {
    if (!isObject(items)) result.dropped++;
    else for (const [key, value] of Object.entries(items)) {
      const kept = storedItem(key, value);
      if (kept) result.items[key] = kept;
      else result.dropped++;
    }
  }
  if (ended !== undefined) {
    if (!isObject(ended)) result.dropped++;
    else for (const [key, value] of Object.entries(ended)) {
      const item = isObject(value) ? storedItem(key, value.item) : null;
      if (!item || !isObject(value)) {
        result.dropped++;
        continue;
      }
      result.ended[key] = {
        item,
        reason: typeof value.reason === 'string' ? value.reason : UNKNOWN_REASON,
        ...(Number.isFinite(value.turn) ? { turn: value.turn as number } : {}),
        ...(Number.isFinite(value.at) ? { at: value.at as number } : {}),
      };
    }
  }
  return result;
}
