// A character file (characters/{id}.json) validated and normalised: the
// contract of schema/character.schema.json, checked field by field so an
// author reads the first thing wrong, by its path.

export const POSES = ['idle', 'walkRight', 'walkLeft', 'rest', 'oops', 'yay', 'thinking', 'working', 'sleep'] as const;
export type Pose = (typeof POSES)[number];

export const LINE_EVENTS = ['greeting', 'toolFail', 'testPass', 'testFail', 'thinking', 'rest', 'working', 'wake', 'farewell'] as const;
export type LineEvent = (typeof LINE_EVENTS)[number];

/** One frame: its rows, top to bottom. */
export type Frame = readonly string[];

export type Motion = { walk: boolean; stepMs: number; restChance: number; restTicks: number };

export type Character = {
  id: string;
  name: string;
  description: string;
  author?: string;
  persona: string;
  color: string;
  /** Every frame padded to `width` columns and bottom-aligned to `height` rows. */
  poses: Partial<Record<Pose, Frame[]>>;
  lines: Partial<Record<LineEvent, string[]>>;
  motion: Motion;
  width: number;
  height: number;
  /** An original companion: the sprite color cycles through the rainbow each tick. */
  shiny?: boolean;
  /** An original companion: its species line and the rows below it, in the personality picker's preview. */
  card?: { subtitle: string; rows: readonly string[] };
};

export type Validation = { ok: true; character: Character } | { ok: false; error: string };

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const DEFAULT_COLOR = 'yellow';
export const DEFAULT_MOTION: Motion = { walk: true, stepMs: 200, restChance: 0.02, restTicks: 15 };
export const MAX_COLS = 16;
export const MAX_ROWS = 6;
export const MAX_LINE = 120;
export const INK_COLORS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray', 'grey',
  'blackBright', 'redBright', 'greenBright', 'yellowBright', 'blueBright', 'magentaBright', 'cyanBright', 'whiteBright',
] as const;

const FIELDS = ['$schema', 'id', 'name', 'description', 'author', 'persona', 'color', 'poses', 'lines', 'motion'];
const MOTION_FIELDS = ['walk', 'stepMs', 'restChance', 'restTicks'];
const PRINTABLE = /^[\x20-\x7E]*$/;

/** A missing pose draws the next one in its chain; `idle` is always there. */
export const POSE_FALLBACK: Record<Pose, Pose | null> = {
  idle: null,
  walkRight: 'idle',
  walkLeft: 'walkRight',
  rest: 'idle',
  oops: 'idle',
  yay: 'idle',
  thinking: 'idle',
  working: 'idle',
  sleep: 'rest',
};

export class Invalid extends Error {}

export function fail(error: string): never {
  throw new Invalid(error);
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(o: Record<string, unknown>, key: string, max: number, required: boolean): string | undefined {
  const v = o[key];
  if (v === undefined) return required ? fail(`${key}: required`) : undefined;
  if (typeof v !== 'string') fail(`${key}: must be a string`);
  if (required && v.trim() === '') fail(`${key}: must not be empty`);
  if (v.length > max) fail(`${key}: at most ${max} characters (has ${v.length})`);
  return v;
}

function frames(v: unknown, path: string, min: number): Frame[] {
  if (!Array.isArray(v)) fail(`${path}: must be an array of frames`);
  if (v.length < min) fail(`${path}: needs at least ${min} frame${min === 1 ? '' : 's'}`);
  return v.map((frame, f) => {
    if (!Array.isArray(frame)) fail(`${path}[${f}]: a frame must be an array of rows`);
    if (frame.length < 1 || frame.length > MAX_ROWS) fail(`${path}[${f}]: 1 to ${MAX_ROWS} rows (has ${frame.length})`);
    return frame.map((row, r) => {
      if (typeof row !== 'string') fail(`${path}[${f}][${r}]: a row must be a string`);
      if (!PRINTABLE.test(row)) fail(`${path}[${f}][${r}]: printable ASCII only (no tabs, emoji or wide characters)`);
      if (row.length > MAX_COLS) fail(`${path}[${f}][${r}]: at most ${MAX_COLS} columns (has ${row.length})`);
      return row;
    });
  });
}

function color(v: unknown): string {
  if (v === undefined) return DEFAULT_COLOR;
  if (typeof v === 'string' && ((INK_COLORS as readonly string[]).includes(v) || /^#[0-9a-fA-F]{6}$/.test(v))) return v;
  return fail(`color: an Ink color name (${INK_COLORS.slice(0, 9).join(', ')}, ...) or #rrggbb`);
}

function num(o: Record<string, unknown>, key: string, lo: number, hi: number, integer: boolean, dflt: number): number {
  const v = o[key];
  if (v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v) || (integer && !Number.isInteger(v))) fail(`motion.${key}: must be ${integer ? 'an integer' : 'a number'}`);
  if (v < lo || v > hi) fail(`motion.${key}: must be ${lo} to ${hi} (is ${v})`);
  return v;
}

function motion(v: unknown): Motion {
  if (v === undefined) return { ...DEFAULT_MOTION };
  if (!isObject(v)) fail('motion: must be an object');
  const unknown = Object.keys(v).find((k) => !MOTION_FIELDS.includes(k));
  if (unknown) fail(`motion.${unknown}: unknown field (known: ${MOTION_FIELDS.join(', ')})`);
  if (v.walk !== undefined && typeof v.walk !== 'boolean') fail('motion.walk: must be true or false');
  return {
    walk: v.walk === undefined ? DEFAULT_MOTION.walk : v.walk,
    stepMs: num(v, 'stepMs', 80, 1000, true, DEFAULT_MOTION.stepMs),
    restChance: num(v, 'restChance', 0, 0.2, false, DEFAULT_MOTION.restChance),
    restTicks: num(v, 'restTicks', 1, 100, true, DEFAULT_MOTION.restTicks),
  };
}

function poses(v: unknown, walk: boolean): Partial<Record<Pose, Frame[]>> {
  if (!isObject(v)) fail('poses: required, an object of pose name to frames');
  const out: Partial<Record<Pose, Frame[]>> = {};
  for (const [name, value] of Object.entries(v)) {
    if (!(POSES as readonly string[]).includes(name)) fail(`poses.${name}: unknown pose (known: ${POSES.join(', ')})`);
    out[name as Pose] = frames(value, `poses.${name}`, name === 'walkRight' ? 2 : 1);
  }
  if (!out.idle) fail('poses.idle: required');
  if (walk && !out.walkRight) fail('poses.walkRight: required while motion.walk is true (set motion.walk false for a character that stands still)');
  return out;
}

export function parseLines(v: unknown): Partial<Record<LineEvent, string[]>> {
  if (v === undefined) return {};
  if (!isObject(v)) fail('lines: must be an object of event name to lines');
  const out: Partial<Record<LineEvent, string[]>> = {};
  for (const [event, pool] of Object.entries(v)) {
    if (!(LINE_EVENTS as readonly string[]).includes(event)) fail(`lines.${event}: unknown event (known: ${LINE_EVENTS.join(', ')})`);
    if (!Array.isArray(pool) || pool.length === 0) fail(`lines.${event}: must be a non-empty array of strings`);
    out[event as LineEvent] = pool.map((line, i) => {
      if (typeof line !== 'string' || line.trim() === '') fail(`lines.${event}[${i}]: must be a non-empty string`);
      if (line.length > MAX_LINE) fail(`lines.${event}[${i}]: at most ${MAX_LINE} characters (has ${line.length})`);
      return line;
    });
  }
  return out;
}

/** Pads every row to the widest and bottom-aligns every frame to the tallest. */
export function normalizeFrames(p: Partial<Record<Pose, Frame[]>>): { poses: Partial<Record<Pose, Frame[]>>; width: number; height: number } {
  const all = Object.values(p).flat();
  const width = Math.max(1, ...all.flat().map((row) => row.length));
  const height = Math.max(1, ...all.map((frame) => frame.length));
  const out: Partial<Record<Pose, Frame[]>> = {};
  for (const [name, list] of Object.entries(p) as [Pose, Frame[]][]) {
    out[name] = list.map((frame) => [...Array<string>(height - frame.length).fill(''), ...frame].map((row) => row.padEnd(width)));
  }
  return { poses: out, width, height };
}

/**
 * Validates one parsed character file. `fileId` is the file name less `.json`;
 * the `id` must equal it. The error is the first problem, by its path.
 */
export function validateCharacter(raw: unknown, fileId?: string): Validation {
  try {
    if (!isObject(raw)) fail('must be a JSON object');
    const unknown = Object.keys(raw).find((k) => !FIELDS.includes(k));
    if (unknown) fail(`${unknown}: unknown field (known: ${FIELDS.join(', ')})`);
    if (raw.$schema !== undefined && typeof raw.$schema !== 'string') fail('$schema: must be a string');
    const id = text(raw, 'id', 32, true)!;
    if (!ID_PATTERN.test(id)) fail(`id: "${id}" must match ${ID_PATTERN.source}`);
    if (fileId !== undefined && id !== fileId) fail(`id: "${id}" must equal the file name (${fileId}.json)`);
    const name = text(raw, 'name', 40, true)!;
    const description = text(raw, 'description', 100, true)!;
    const author = text(raw, 'author', 60, false);
    const persona = text(raw, 'persona', 1200, true)!;
    const col = color(raw.color);
    const mot = motion(raw.motion);
    const norm = normalizeFrames(poses(raw.poses, mot.walk));
    const character: Character = { id, name, description, persona, color: col, poses: norm.poses, lines: parseLines(raw.lines), motion: mot, width: norm.width, height: norm.height };
    if (author !== undefined) character.author = author;
    return { ok: true, character };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, error: error.message };
    throw error;
  }
}

/** The frames a pose draws, following POSE_FALLBACK to one the character has. */
export function framesFor(c: Character, pose: Pose): Frame[] {
  for (let p: Pose | null = pose; p; p = POSE_FALLBACK[p]) {
    const f = c.poses[p];
    if (f && f.length > 0) return f;
  }
  return c.poses.idle ?? [[]];
}

/** Frame `n` of a pose: frames alternate each tick; one frame is static. */
export function frameAt(c: Character, pose: Pose, n: number): Frame {
  const f = framesFor(c, pose);
  return f[((n % f.length) + f.length) % f.length] ?? [];
}
