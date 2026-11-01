import { POSES, fail, Invalid, isObject, parseLines, type Frame, type LineEvent, type Pose } from './character.ts';
import { HATS, SPECIES, type Hat, type Species } from './hatch.ts';

// A species template (species/{species}.json) and the hat art (species/hats.json):
// the sprite an original companion wears before its eye, hat and color are
// filled in. The contract of schema/species.schema.json, checked field by
// field so an artist reads the first thing wrong, by its path.

export const EYE_TOKEN = '{E}';
export const SPECIES_MAX_WIDTH = 12;
export const SPECIES_MAX_BODY_ROWS = 4;
export const HAT_MAX_WIDTH = 7;
export const SPECIES_REQUIRED_POSES = ['idle', 'walkRight', 'oops', 'yay', 'sleep'] as const;
export const SPECIES_MIN_FRAMES: Partial<Record<Pose, number>> = { idle: 3, walkRight: 2 };
/** Every hat but `none`, which draws no row. */
export const HAT_ART_NAMES = HATS.filter((h): h is Exclude<Hat, 'none'> => h !== 'none');

export type SpeciesTemplate = {
  species: Species;
  width: number;
  hatCol: number;
  /** Row 0 of every frame is the blank hat row; `{E}` marks each eye. */
  poses: Partial<Record<Pose, Frame[]>>;
  lines: Partial<Record<LineEvent, string[]>>;
};
export type HatArt = Partial<Record<Exclude<Hat, 'none'>, string>>;

export type SpeciesValidation = { ok: true; template: SpeciesTemplate } | { ok: false; error: string };
export type HatsValidation = { ok: true; hats: HatArt } | { ok: false; error: string };

const FIELDS = ['$schema', 'species', 'width', 'hatCol', 'poses', 'lines'];
const PRINTABLE = /^[\x20-\x7E]*$/;

/** A row's width in columns, each `{E}` one column (the eye glyph it becomes). */
export function rowWidth(row: string): number {
  return row.split(EYE_TOKEN).join('E').length;
}

function int(o: Record<string, unknown>, key: string, lo: number, hi: number): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) fail(`${key}: required, an integer`);
  if (v < lo || v > hi) fail(`${key}: must be ${lo} to ${hi} (is ${v})`);
  return v;
}

function frames(v: unknown, path: string, min: number, width: number): Frame[] {
  if (!Array.isArray(v)) fail(`${path}: must be an array of frames`);
  if (v.length < min) fail(`${path}: needs at least ${min} frame${min === 1 ? '' : 's'}`);
  return v.map((frame, f) => {
    if (!Array.isArray(frame)) fail(`${path}[${f}]: a frame must be an array of rows`);
    if (frame.length < 2 || frame.length > 1 + SPECIES_MAX_BODY_ROWS) fail(`${path}[${f}]: the hat row, then 1 to ${SPECIES_MAX_BODY_ROWS} body rows (has ${frame.length} rows)`);
    return frame.map((row, r) => {
      const at = `${path}[${f}][${r}]`;
      if (typeof row !== 'string') fail(`${at}: a row must be a string`);
      if (!PRINTABLE.test(row)) fail(`${at}: printable ASCII only ({E} marks an eye)`);
      if (r === 0 && row.trim() !== '') fail(`${at}: row 0 is the hat row and must be all spaces`);
      const w = rowWidth(row);
      if (w !== width) fail(`${at}: must be exactly ${width} columns (width), {E} counted as one (has ${w})`);
      return row;
    });
  });
}

function poses(v: unknown, width: number): Partial<Record<Pose, Frame[]>> {
  if (!isObject(v)) fail('poses: required, an object of pose name to frames');
  const out: Partial<Record<Pose, Frame[]>> = {};
  for (const [name, value] of Object.entries(v)) {
    if (!(POSES as readonly string[]).includes(name)) fail(`poses.${name}: unknown pose (known: ${POSES.join(', ')})`);
    out[name as Pose] = frames(value, `poses.${name}`, SPECIES_MIN_FRAMES[name as Pose] ?? 1, width);
  }
  const missing = SPECIES_REQUIRED_POSES.find((p) => !out[p]);
  if (missing) fail(`poses.${missing}: required (required: ${SPECIES_REQUIRED_POSES.join(', ')})`);
  return out;
}

/**
 * Validates one parsed species file. `fileSpecies` is the file name less
 * `.json`; `species` must equal it. The error is the first problem, by its path.
 */
export function validateSpecies(raw: unknown, fileSpecies?: string): SpeciesValidation {
  try {
    if (!isObject(raw)) fail('must be a JSON object');
    const unknown = Object.keys(raw).find((k) => !FIELDS.includes(k));
    if (unknown) fail(`${unknown}: unknown field (known: ${FIELDS.join(', ')})`);
    const species = raw.species;
    if (typeof species !== 'string' || !(SPECIES as readonly string[]).includes(species)) fail(`species: one of ${SPECIES.join(', ')}`);
    if (fileSpecies !== undefined && species !== fileSpecies) fail(`species: "${species}" must equal the file name (${fileSpecies}.json)`);
    const width = int(raw, 'width', 1, SPECIES_MAX_WIDTH);
    const hatCol = int(raw, 'hatCol', 0, width - 1);
    return { ok: true, template: { species: species as Species, width, hatCol, poses: poses(raw.poses, width), lines: parseLines(raw.lines) } };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, error: error.message };
    throw error;
  }
}

/** Validates species/hats.json: one row of art, at most 7 columns, per hat but `none`. */
export function validateHats(raw: unknown): HatsValidation {
  try {
    if (!isObject(raw)) fail('must be a JSON object of hat name to one row of art');
    const unknown = Object.keys(raw).find((k) => !(HAT_ART_NAMES as readonly string[]).includes(k));
    if (unknown) fail(`${unknown}: unknown hat (known: ${HAT_ART_NAMES.join(', ')}; none draws no row)`);
    const hats: HatArt = {};
    for (const name of HAT_ART_NAMES) {
      const v = raw[name];
      if (v === undefined) fail(`${name}: required`);
      if (typeof v !== 'string' || v.trim() === '') fail(`${name}: must be a non-empty string`);
      if (!PRINTABLE.test(v)) fail(`${name}: printable ASCII only`);
      if (v.length > HAT_MAX_WIDTH) fail(`${name}: at most ${HAT_MAX_WIDTH} columns (has ${v.length})`);
      hats[name] = v;
    }
    return { ok: true, hats };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, error: error.message };
    throw error;
  }
}
