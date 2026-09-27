import { validateCharacter, type Character } from './character.ts';
import { ORIGINAL_ID } from './original.ts';

// Every character the buddy knows: the built-ins, then the user's folder, an
// id in both taken from the user's. An invalid file stays in the roster with
// its first error, so /buddy-personality shows it rather than hiding it.

export const DEFAULT_ID = 'duck';

export type Source = 'builtin' | 'user' | 'original';
export type Entry = { id: string; source: Source; character?: Character; error?: string };
export type Roster = { entries: Entry[]; errors: string[] };
/** A listed file: its text, or why it could not be read. */
export type LoadedFile = { name: string; text?: string; error?: string };
export type Choice = { id: string; character: Character; error?: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A directory entry that may be a character: a `.json` file (or link), not hidden. */
export function isCharacterFile(name: string, kind: string): boolean {
  return kind !== 'dir' && name.endsWith('.json') && !name.startsWith('.');
}

export function loadEntries(files: readonly LoadedFile[], source: Source): Entry[] {
  return files.map((f) => {
    const id = f.name.replace(/\.json$/, '');
    if (f.error !== undefined) return { id, source, error: f.error };
    let raw: unknown;
    try {
      raw = JSON.parse(f.text ?? '');
    } catch (error) {
      return { id, source, error: `not valid JSON: ${message(error)}` };
    }
    const v = validateCharacter(raw, id);
    return v.ok ? { id, source, character: v.character } : { id, source, error: v.error };
  });
}

export function mergeRoster(builtins: readonly Entry[], users: readonly Entry[], errors: readonly string[] = []): Roster {
  const byId = new Map<string, Entry>();
  const errs = [...errors];
  for (const e of [...builtins, ...users]) {
    // The original companion's id is reserved: a file taking it is said, never drawn in its place.
    if (e.id === ORIGINAL_ID) {
      errs.push(`${e.id}.json (${e.source}): "${ORIGINAL_ID}" is reserved for your original companion; rename the file and its id`);
      continue;
    }
    byId.set(e.id, e);
  }
  return { entries: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), errors: errs };
}

/** The roster with `e` in it, replacing any entry of its id. */
export function withEntry(r: Roster, e: Entry): Roster {
  return { entries: [...r.entries.filter((x) => x.id !== e.id), e].sort((a, b) => a.id.localeCompare(b.id)), errors: r.errors };
}

export function findEntry(r: Roster, id: string): Entry | undefined {
  return r.entries.find((e) => e.id === id);
}

/**
 * The stand-in drawn when duck.json does not load: a minimal duck, with the
 * generic lines, so an error still shows a buddy and a bubble.
 */
const STANDIN = validateCharacter({
  id: DEFAULT_ID,
  name: 'Quack',
  description: 'Built-in stand-in, drawn when duck.json does not load.',
  persona: "You are Quack, a small duck who sits above a developer's Claude Code prompt: sarcastic, quick and a little smug.",
  poses: {
    idle: [['    .-.    ', '\\__( x)=   ', ' \\____)    ', '  L  L     ']],
    walkRight: [
      ['    .-.    ', '\\__( x)=   ', ' \\____)    ', ' L   L     '],
      ['    .-.    ', '\\__( x)=   ', ' \\____)    ', '   LL      '],
    ],
    walkLeft: [
      ['    .-.    ', '   =(x )__/', '    (____/ ', '     J   J '],
      ['    .-.    ', '   =(x )__/', '    (____/ ', '      JJ   '],
    ],
  },
});
if (!STANDIN.ok) throw new Error(`buddy: the built-in stand-in is invalid: ${STANDIN.error}`);
export const STANDIN_DEFAULT: Character = STANDIN.character;

/**
 * What the first greeting's bubble says instead of a greeting: the choice's
 * error, the roster's errors (a folder that did not list, a file taking a
 * reserved id) pointing at /buddy-personality, and every ignored option,
 * joined; undefined when none.
 */
export function startWarning(choiceError: string | undefined, rosterErrors: readonly string[], optionErrors: readonly string[]): string | undefined {
  const roster = rosterErrors.length > 0 ? `${rosterErrors.join('; ')}; /buddy-personality lists your characters` : '';
  const all = [choiceError ?? '', roster, ...optionErrors].filter(Boolean);
  return all.length > 0 ? all.join('; ') : undefined;
}

/**
 * The character to draw: the stored choice, else the option, else the duck
 * (`DEFAULT_ID`). A missing or invalid choice draws the duck (or the stand-in)
 * and says why in `error`.
 */
export function choose(r: Roster, storeChoice: string | undefined, optionChoice: string | undefined): Choice {
  const id = storeChoice || optionChoice || DEFAULT_ID;
  const entry = findEntry(r, id);
  if (entry?.character) return { id, character: entry.character };
  const why = entry?.error ?? 'no such character';
  const fallback = findEntry(r, DEFAULT_ID)?.character ?? STANDIN_DEFAULT;
  return { id, character: fallback, error: `Couldn't load ${id}: ${why}; /buddy-personality picks another` };
}
