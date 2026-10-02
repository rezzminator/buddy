// The buddy's per-chat memory: keyed items edited by the model, checked and
// stamped by code, with ended items kept separately. No I/O: the adapter
// supplies the user's typed prompts, the chat's turn number and the time.

import { isObject } from './character.ts';

export type Kind = 'rule' | 'open' | 'fact' | 'lesson' | 'doubt';
export type From = 'user' | 'claude' | 'shown' | 'buddy';
/** `migrated` is set by migrateNotes on every item it makes, and gone once the model rewrites the item. */
export type Item = { text?: string; words?: string; covers?: string; from: From; turn: number; at: number; migrated?: true };
export type Items = Record<string, Item>;
export type Ended = { item: Item; reason: string; turn: number; at: number };
export type EndedItems = Record<string, Ended>;
export type MemoryOp = { key: string; op: 'add' | 'set' | 'end' | 'drop' | 'evict' | 'expire' | 'migrate'; why: string; turn: number };
export type MemoryContext = { turn: number; at: number; typed: readonly string[] };

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

function checkOp(key: string, value: unknown, items: Items, ctx: MemoryContext): string | null {
  if (!ITEM_KEY.test(key)) return 'bad key';
  if (!isObject(value)) return 'not an object';
  const fields = Object.entries(value);
  for (const [field] of fields) if (!FIELDS.includes(field)) return `unknown field ${field}`;
  for (const [field, text] of fields) if (typeof text !== 'string') return `not text: ${field}`;
  for (const [field, text] of fields) if ((text as string).trim() === '') return `empty: ${field}`;
  for (const [field, text] of fields) if ((text as string).trim().length > ITEM_MAX_CHARS) return `too long: ${field}`;
  const change = Object.fromEntries(fields.map(([field, text]) => [field, (text as string).trim()])) as Change;
  if (change.from !== undefined && !FROM.includes(change.from)) return 'bad from';
  const old = items[key];
  if (change.end !== undefined) {
    if (!old) return 'end on unknown key';
    if (!/^(done|met|lifted|stale|wrong)\b/i.test(change.end)) return 'bad end';
    return null;
  }
  if (fields.length === 0) return 'no field';
  if (!old) {
    if (kindOf(key) !== 'rule' && change.text === undefined) return 'new item without text';
    if (kindOf(key) === 'rule' && (change.words === undefined || change.covers === undefined)) return 'new rule without words or covers';
    if (kindOf(key) === 'rule' && Object.keys(items).filter((k) => kindOf(k) === 'rule').length >= ITEM_CAPS.rule) return 'rule cap 10';
  }
  if (kindOf(key) === 'rule' && change.words !== undefined && !wordsTyped(change.words, ctx.typed)) return 'words not typed by the user';
  return null;
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
    .sort(([, a], [, b]) => b.at - a.at || b.turn - a.turn).slice(0, ENDED_KEPT));
}

/** Apply only the named keys, leaving the caller's objects unchanged. */
export function applyMemory(memory: { items: Items; ended: EndedItems }, raw: string | null, ctx: MemoryContext): MemoryResult {
  const result: MemoryResult = { items: { ...memory.items }, ended: { ...memory.ended }, ops: [] };
  if (raw !== null) {
    let value: unknown;
    try { value = JSON.parse(raw); } catch { value = null; }
    if (!isObject(value)) {
      result.ops.push({ key: '*', op: 'drop', why: 'not a JSON object', turn: ctx.turn });
    } else {
      for (const [key, change] of Object.entries(value)) {
        const why = checkOp(key, change, result.items, ctx);
        if (why !== null) {
          result.ops.push({ key, op: 'drop', why, turn: ctx.turn });
          continue;
        }
        const fields = Object.fromEntries(Object.entries(change as Record<string, string>).map(([field, text]) => [field, text.trim()])) as Change;
        const old = result.items[key];
        if (fields.end !== undefined) {
          endItem(result, key, 'end', fields.end, ctx);
        } else {
          if (kindOf(key) === 'rule') fields.from = 'user';
          else { delete fields.words; delete fields.covers; }
          const next: Item = { from: 'buddy', ...old, ...fields, turn: ctx.turn, at: ctx.at };
          delete next.migrated;
          result.items[key] = next;
          const added = result.ended[key] ? 're-added after end' : 'added';
          delete result.ended[key];
          result.ops.push({ key, op: old ? 'set' : 'add', why: old ? ITEM_FIELDS.filter((field) => old[field] !== result.items[key]![field]).join(', ') : added, turn: ctx.turn });
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

function cutNote(text: string): string {
  return text.length > ITEM_MAX_CHARS ? `${text.slice(0, ITEM_MAX_CHARS - 1)}…` : text;
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
        ? `- ${key} · "${item.words}" covers: ${item.covers} · from user · age ${age}`
        : `- ${key} · ${item.text} · from ${item.from} · age ${age}`);
    }
    lines.push('');
  }
  if (!entries.length) lines.push('none', '');
  lines.push('## Ended, newest first', '');
  const records = Object.entries(ended).sort(([, a], [, b]) => b.at - a.at || b.turn - a.turn);
  for (const [key, record] of records) lines.push(`- ${key} · ${record.reason} · turn ${record.turn} · ${record.item.words ?? record.item.text}`);
  if (!records.length) lines.push('none');
  return lines.join('\n');
}

function storedItem(key: string, value: unknown): value is Item {
  if (!ITEM_KEY.test(key) || !isObject(value)) return false;
  if (!FROM.includes(value.from as From) || !Number.isFinite(value.turn) || !Number.isFinite(value.at)) return false;
  for (const field of ['text', 'words', 'covers']) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return false;
  }
  if (value.migrated !== undefined && value.migrated !== true) return false;
  return kindOf(key) === 'rule' ? typeof value.words === 'string' && typeof value.covers === 'string' : typeof value.text === 'string';
}

/** Keep valid stored entries, counting each malformed item or ended record once. */
export function itemsOf(items: unknown, ended: unknown): { items: Items; ended: EndedItems; dropped: number } {
  const result = { items: {} as Items, ended: {} as EndedItems, dropped: 0 };
  if (items !== undefined) {
    if (!isObject(items)) result.dropped++;
    else for (const [key, value] of Object.entries(items)) {
      if (storedItem(key, value)) result.items[key] = value;
      else result.dropped++;
    }
  }
  if (ended !== undefined) {
    if (!isObject(ended)) result.dropped++;
    else for (const [key, value] of Object.entries(ended)) {
      if (isObject(value) && storedItem(key, value.item) && typeof value.reason === 'string' && Number.isFinite(value.turn) && Number.isFinite(value.at)) {
        result.ended[key] = value as Ended;
      } else result.dropped++;
    }
  }
  return result;
}
