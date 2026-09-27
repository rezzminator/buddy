import { frameAt, type Character } from './character.ts';
import type { Variant } from './hatch.ts';
import { poolFor } from './lines.ts';
import { ORIGINAL_ID, SHOWN_CONFIG, originalLabel, type Soul } from './original.ts';
import type { Entry, Roster } from './roster.ts';
import { spriteColor } from './scene.ts';

// `/buddy-personality`: the menu as plain data. Three titled groups of
// entries, one focusable row each, and the preview of the one the focus is
// on. The adapter draws it one to one; an error is a line in its group.

export const MENU_COMMAND = 'buddy-personality';
export const MENU_PANE = 'buddy-personality';
export const MENU_TITLE = 'Pick a personality';
/** How often the preview's idle frames turn. */
export const PREVIEW_MS = 500;
export const MENU_MAX_ROWS = 30;
export const PREVIEW_ROWS = 14;

export type Pick = { kind: 'use'; id: string } | { kind: 'original'; variant: Variant };
/** `about`: the line the preview says of it, its description, or an original's personality. */
export type Item = { key: string; label: string; pick: Pick; character?: Character; about?: string; error?: string };
/** A titled group: its rows, and lines said in place of rows (an error, an empty group). */
export type Section = { title: string; lines: string[]; items: Item[] };
export type Menu = { sections: Section[] };

/** What the "Yours" group found: a failure to look, nothing, or the companion rolled both ways. */
export type Originals =
  | { kind: 'error'; error: string }
  | { kind: 'none'; notes: string[]; shownConfig?: string }
  | { kind: 'found'; soul: Soul; from?: string; notes: string[]; rolls: { variant: Variant; character?: Character; error?: string }[] };

export type MenuInput = {
  roster: Roster;
  /** Why the plugin's characters/ could not be listed, if it could not. */
  shippedError?: string;
  /** Whether a customCharactersFolder is set, and why it could not be listed. */
  folder: { isSet: boolean; error?: string };
  originals: Originals;
};

export function itemKey(p: Pick): string {
  return p.kind === 'use' ? `use:${p.id}` : `original:${p.variant}`;
}

function entryItem(e: Entry): Item {
  const pick: Pick = { kind: 'use', id: e.id };
  return e.character ? { key: itemKey(pick), label: `${e.character.name} (${e.id})`, pick, character: e.character, about: e.character.description } : { key: itemKey(pick), label: `${e.id} (invalid)`, pick, error: e.error ?? 'invalid' };
}

function yours(o: Originals): Section {
  const title = 'Yours';
  if (o.kind === 'error') return { title, lines: [o.error], items: [] };
  if (o.kind === 'none') return { title, lines: [`No companion in ${o.shownConfig ?? SHOWN_CONFIG} or its backups.`, ...o.notes], items: [] };
  const items = o.rolls.map((r): Item => {
    const pick: Pick = { kind: 'original', variant: r.variant };
    const item: Item = { key: itemKey(pick), label: originalLabel(o.soul.name, r.variant), pick };
    if (r.character) {
      item.character = r.character;
      item.about = o.soul.personality || r.character.description;
    } else item.error = r.error ?? 'no art for it';
    return item;
  });
  return { title, lines: [...(o.from ? [`From the backup ${o.from}.`] : []), ...o.notes], items };
}

export function buildMenu(i: MenuInput): Menu {
  const shipped = i.roster.entries.filter((e) => e.source === 'builtin').map(entryItem);
  const mine = i.roster.entries.filter((e) => e.source === 'user').map(entryItem);
  const shippedLines = i.shippedError ? [i.shippedError] : shipped.length === 0 ? ['No shipped characters found.'] : [];
  // A roster error that is not a listing failure: a file taking a reserved id, said in the folder's group.
  const listing = new Set([i.shippedError, i.folder.error]);
  const refused = i.roster.errors.filter((e) => !listing.has(e));
  const folderLines = [...(!i.folder.isSet ? ['No folder set: the customCharactersFolder option names one.'] : i.folder.error ? [i.folder.error] : mine.length === 0 ? ['No character files in your folder.'] : []), ...refused];
  return {
    sections: [
      { title: 'Shipped', lines: shippedLines, items: shipped },
      yours(i.originals),
      { title: 'Your folder', lines: folderLines, items: mine },
    ],
  };
}

export function allItems(m: Menu): Item[] {
  return m.sections.flatMap((s) => s.items);
}

export function findItem(m: Menu, key: string): Item | undefined {
  return allItems(m).find((i) => i.key === key);
}

/** The key `by` rows from `key`, kept inside the list: what Down (+1) and Up (-1) reach. */
export function moveKey(m: Menu, key: string, by: number): string | undefined {
  const items = allItems(m);
  if (items.length === 0) return undefined;
  const at = Math.max(0, items.findIndex((i) => i.key === key));
  return items[Math.max(0, Math.min(items.length - 1, at + by))]!.key;
}

/** The entry drawn now: the original by its roll, any other by its id. */
export function currentKeyOf(drawnId: string, originalVariant: Variant | undefined): string {
  return drawnId === ORIGINAL_ID && originalVariant ? itemKey({ kind: 'original', variant: originalVariant }) : itemKey({ kind: 'use', id: drawnId });
}

/** A row's text: `* ` on the one drawn now. */
export function rowLabel(item: Item, current: string): string {
  return `${item.key === current ? '* ' : '  '}${item.label}`;
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

/** The rows the pane wants: every title, line (as wrapped in the list) and entry, a gap between groups. */
export function menuRows(m: Menu): number {
  const w = listWidth(m);
  const lineRows = (line: string) => Math.max(1, Math.ceil(line.length / w));
  const left = m.sections.reduce((n, s) => n + 1 + s.lines.reduce((k, l) => k + lineRows(l), 0) + s.items.length, 0) + m.sections.length - 1;
  return Math.min(MENU_MAX_ROWS, Math.max(left, PREVIEW_ROWS));
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
