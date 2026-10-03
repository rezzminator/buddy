import { frameAt, type Character } from './character.ts';
import type { Variant } from './hatch.ts';
import { poolFor } from './lines.ts';
import { ORIGINAL_ID, originalLabel, type Soul } from './original.ts';
import type { Entry, Roster } from './roster.ts';
import { spriteColor } from './scene.ts';

// The personality pane (ctrl+x t in the drawer) as plain data. Two titled
// groups of entries, Shipped and Yours (your original companion's two rolls,
// then your own character files), one row each, and the preview of the one
// lit. The pane draws it one to one; an error is a line in its group.

export type Pick = { kind: 'use'; id: string } | { kind: 'original'; variant: Variant };
/** `about`: the line the preview says of it, its description, or an original's personality. */
export type Item = { key: string; label: string; pick: Pick; character?: Character; about?: string; error?: string };
/** A titled group: its rows, and lines said in place of rows (an error, an empty group). */
export type Section = { title: string; lines: string[]; items: Item[] };
export type Menu = { sections: Section[] };

/** What the look for your original companion found: a failure to look, nothing, or the companion rolled both ways. */
export type Originals =
  | { kind: 'error'; error: string }
  | { kind: 'none'; notes: string[] }
  | { kind: 'found'; soul: Soul; from?: string; notes: string[]; rolls: { variant: Variant; character?: Character; error?: string }[] };

export type MenuInput = {
  roster: Roster;
  /** Why the plugin's characters/ could not be listed, if it could not. */
  shippedError?: string;
  /** Whether a customCharactersDir is set, and why it could not be listed. */
  customCharactersDir: { isSet: boolean; error?: string };
  originals: Originals;
};

export function itemKey(p: Pick): string {
  return p.kind === 'use' ? `use:${p.id}` : `original:${p.variant}`;
}

function entryItem(e: Entry): Item {
  const pick: Pick = { kind: 'use', id: e.id };
  return e.character ? { key: itemKey(pick), label: `${e.character.name} (${e.id})`, pick, character: e.character, about: e.character.description } : { key: itemKey(pick), label: `${e.id} (invalid)`, pick, error: e.error ?? 'invalid' };
}

/** Your original companion's rolls, and the lines said of the look for it: a failure, where a backup was read from, its notes; nothing when there is none. */
function originals(o: Originals): { lines: string[]; items: Item[] } {
  if (o.kind === 'error') return { lines: [o.error], items: [] };
  if (o.kind === 'none') return { lines: o.notes, items: [] };
  const items = o.rolls.map((r): Item => {
    const pick: Pick = { kind: 'original', variant: r.variant };
    const item: Item = { key: itemKey(pick), label: originalLabel(o.soul.name, r.variant), pick };
    if (r.character) {
      item.character = r.character;
      item.about = o.soul.personality || r.character.description;
    } else item.error = r.error ?? 'no art for it';
    return item;
  });
  return { lines: [...(o.from ? [`From the backup ${o.from}.`] : []), ...o.notes], items };
}

export function buildMenu(i: MenuInput): Menu {
  const shipped = i.roster.entries.filter((e) => e.source === 'builtin').map(entryItem);
  const mine = i.roster.entries.filter((e) => e.source === 'user').map(entryItem);
  const shippedLines = i.shippedError ? [i.shippedError] : shipped.length === 0 ? ['No shipped characters found.'] : [];
  // A roster error that is not a listing failure: a file taking a reserved id, said in Yours.
  const listing = new Set([i.shippedError, i.customCharactersDir.error]);
  const refused = i.roster.errors.filter((e) => !listing.has(e));
  const original = originals(i.originals);
  const items = [...original.items, ...mine];
  const dir = i.customCharactersDir.error ? [i.customCharactersDir.error] : items.length > 0 ? [] : i.customCharactersDir.isSet ? ['No character files in customCharactersDir.'] : ['None yet: set customCharactersDir to a folder of your own character files.'];
  return {
    sections: [
      { title: 'Shipped', lines: shippedLines, items: shipped },
      { title: 'Yours', lines: [...original.lines, ...dir, ...refused], items },
    ],
  };
}

export function allItems(m: Menu): Item[] {
  return m.sections.flatMap((s) => s.items);
}

export function findItem(m: Menu, key: string): Item | undefined {
  return allItems(m).find((i) => i.key === key);
}

/** The entry drawn now: the original by its roll, any other by its id. */
export function currentKeyOf(drawnId: string, originalVariant: Variant | undefined): string {
  return drawnId === ORIGINAL_ID && originalVariant ? itemKey({ kind: 'original', variant: originalVariant }) : itemKey({ kind: 'use', id: drawnId });
}

/** A row's text: `* ` on the one drawn now. */
export function rowLabel(item: Item, current: string): string {
  return `${item.key === current ? '* ' : '  '}${item.label}`;
}

/** One row of the entry list: a group's gap, title or line, or an entry. */
export type MenuRow = { key: string } & ({ kind: 'gap' } | { kind: 'title'; text: string } | { kind: 'line'; text: string } | { kind: 'item'; item: Item });

/** The entry list's rows in order: each group after a gap (but the first), its title, its lines, then its entries. */
export function menuRows(m: Menu): MenuRow[] {
  return m.sections.flatMap((s, n): MenuRow[] => [
    ...(n === 0 ? [] : [{ key: `gap:${n}`, kind: 'gap' as const }]),
    { key: `group:${n}`, kind: 'title', text: s.title },
    ...s.lines.map((text, i) => ({ key: `line:${n}:${i}`, kind: 'line' as const, text })),
    ...s.items.map((item) => ({ key: item.key, kind: 'item' as const, item })),
  ]);
}

/**
 * The rows [from, to) of `rows` a list `size` rows tall shows round the lit
 * entry `lit`: all of them when they fit; else a row kept above and below to
 * count what is left out, the lit entry centred, and the window moved to hold
 * the entries before and after it where they fit: the ring moves only onto a
 * drawn row, so ↑ and ↓ always have one to reach.
 */
export function listWindow(rows: readonly MenuRow[], lit: string, size: number): { from: number; to: number } {
  const count = rows.length;
  if (count <= size) return { from: 0, to: count };
  const room = Math.max(1, size - 2);
  const entries = rows.flatMap((r, i) => (r.kind === 'item' ? [i] : []));
  const at = Math.max(0, rows.findIndex((r) => r.key === lit));
  const k = entries.indexOf(at);
  const before = k > 0 ? entries[k - 1]! : at;
  const after = k >= 0 && k < entries.length - 1 ? entries[k + 1]! : at;
  let from = at - Math.floor(room / 2);
  if (after - before < room) from = Math.min(Math.max(from, after - room + 1), before);
  from = Math.min(Math.max(0, from), count - room);
  return { from, to: from + room };
}

/** The most rows the personality pane asks for. */
export const PANE_ROWS_MAX = 20;

/** The rows the personality pane asks for: its whole list, or the lit entry's preview when that is taller; at most PANE_ROWS_MAX. */
export function paneRows(m: Menu, lit: string): number {
  const p = previewOf(findItem(m, lit), 0, 0);
  // The sprite, then its name, one line about it, its greeting and its card.
  const preview = p.kind === 'error' ? 2 : p.rows.length + 3 + p.card.length;
  return Math.min(PANE_ROWS_MAX, Math.max(menuRows(m).length, preview));
}

/** The narrowest the entry list gets, so a notice under a short list still reads. */
export const LIST_MIN_WIDTH = 24;

/**
 * The entry list's width: its widest title or entry row (with the current marker),
 * never a notice line, which wraps inside it; a long notice widening the list
 * squeezed the preview beside it to a few columns.
 */
export function listWidth(m: Menu): number {
  let w = LIST_MIN_WIDTH;
  for (const s of m.sections) {
    w = Math.max(w, s.title.length);
    for (const item of s.items) w = Math.max(w, `* ${item.label}`.length);
  }
  return w;
}

export type Preview =
  | { kind: 'character'; rows: string[]; color: string; name: string; about: string; sample: string; card: string[] }
  | { kind: 'error'; label: string; error: string };

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** What the right side shows for `item`: its idle frame `frame`, name, one line about it (never its persona prompt), greeting and card; or why it cannot. */
export function previewOf(item: Item | undefined, frame: number, now: number): Preview {
  if (!item) return { kind: 'error', label: 'Nothing to preview', error: 'no entry is highlighted' };
  const c = item.character;
  if (!c) return { kind: 'error', label: item.label, error: item.error ?? 'invalid' };
  return {
    kind: 'character',
    rows: [...frameAt(c, 'idle', frame)],
    color: spriteColor(c, now),
    name: c.name,
    about: oneLine(item.about ?? c.description),
    sample: poolFor(c, 'greeting')[0] ?? '',
    card: c.card ? [c.card.subtitle, ...c.card.rows] : [],
  };
}
