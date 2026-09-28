import { frameAt, type Character, type Pose } from './character.ts';
import { CONFETTI_ROWS, particles } from './particles.ts';
import { cellWidth, padEndCells, wrapCells, type AmbiguousCharacterWidth, type WidthOptions } from './width.ts';

// What the AbovePrompt band shows, as plain data: the adapter maps it to
// Box/Text one to one, and its JSON is the key that decides a redraw.

export type Seg = { pad: number; text: string; color: string };
/** How loud the bubble is: the second brain's warning over a shortcut (`warn`), or its scream over a wrong move (`alarm`). */
export type Tone = 'warn' | 'alarm';
/** A tone's ink, for the bubble's frame and words. */
export const TONE_COLOR: Record<Tone, string> = { warn: 'yellow', alarm: 'red' };
export type Scene = {
  color: string;
  /** The sprite's rows, all `spriteWidth` cells wide; none when the band is too narrow or too short for him but a bubble must show. */
  rows: string[];
  /** The sprite's left column. */
  x: number;
  /** The left column of the sprite-and-bubble row. */
  rowX: number;
  /**
   * The bubble beside him: `text` wrapped to its inner width (`width` less
   * BUBBLE_FRAME_COLS), a `\n` between lines, cut with `…` to the rows
   * `maxRows` leaves. `tone`: how loud it is, absent for a plain bubble.
   */
  bubble: { text: string; width: number; side: 'left' | 'right'; tone?: Tone } | null;
  /** Rows drawn above the sprite: a bubble with no room beside him (its words, full width), then confetti or the sleep drift. */
  effects: Seg[][];
  /** The hover card, placed against the sprite's Box. */
  card: { lines: string[]; left: number; width: number } | null;
};

export type SceneInput = {
  character: Character;
  pose: Pose;
  frame: number;
  x: number;
  cols: number;
  maxRows: number;
  bubble: string | null;
  /** The bubble's tone, absent for a plain one. */
  bubbleTone?: Tone;
  confetti: { seed: number; tick: number } | null;
  sleeping: boolean;
  zTick: number;
  stats: { pets: number; questions: number };
  /** The brain's clock in ms: a shiny sprite's color cycles with it. */
  now?: number;
  /** The terminal draws East Asian Ambiguous characters (★ █ × ·) two cells wide; default one. */
  ambiguousCharacterWidth?: AmbiguousCharacterWidth;
};

export const MIN_BUBBLE_COLS = 40;
export const MAX_BUBBLE_WIDTH = 60;
export const MIN_EFFECT_COLS = 40;
const CARD_MAX_WIDTH = 44;
/** The bubble Box's frame in drawBand (`borderStyle="round" paddingX={1}`): border and padding columns, border rows. */
export const BUBBLE_FRAME_COLS = 4;
export const BUBBLE_FRAME_ROWS = 2;
export const RAINBOW = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'] as const;
export const SHINY_STEP_MS = 200;

/** The sprite's color: its own, or for a shiny one the rainbow, a step per tick. */
export function spriteColor(c: Character, now: number): string {
  return c.shiny ? RAINBOW[Math.floor(now / SHINY_STEP_MS) % RAINBOW.length]! : c.color;
}

export const MOODS: Record<Pose, string> = {
  idle: 'curious',
  walkRight: 'strolling',
  walkLeft: 'strolling',
  rest: 'resting',
  oops: 'flustered',
  yay: 'delighted',
  thinking: 'pondering',
  petted: 'happy',
  working: 'reading along',
  sleep: 'asleep',
};

export function bubbleWidth(cols: number, width: number): number {
  return Math.min(MAX_BUBBLE_WIDTH, cols - width - 4);
}

/** The sprite's width in cells: its widest row over every pose. */
export function spriteWidth(c: Character, o: WidthOptions = {}): number {
  let w = 1;
  for (const frames of Object.values(c.poses)) for (const frame of frames ?? []) for (const row of frame) w = Math.max(w, cellWidth(row, o));
  return w;
}

/** Words as effect rows at the band's left edge, in the sprite's color. */
function textRows(lines: readonly string[], color: string): Seg[][] {
  return lines.map((text) => (text === '' ? [] : [{ pad: 0, text, color }]));
}

/** Cells at absolute columns as one row of segments: gap, then the glyph. */
function toSegs(cells: readonly { col: number; text: string; color: string }[]): Seg[] {
  const segs: Seg[] = [];
  let end = 0;
  for (const c of [...cells].sort((a, b) => a.col - b.col)) {
    if (c.col < end) continue;
    segs.push({ pad: c.col - end, text: c.text, color: c.color });
    end = c.col + cellWidth(c.text);
  }
  return segs;
}

/**
 * The scene, or null when the band has no row, or is too narrow (below the
 * sprite's width + 2) or too short for the sprite and there is no bubble. A
 * bubble is never dropped: beside him from MIN_BUBBLE_COLS, above him full
 * width below that, alone when he does not fit beside or under it; each cut to
 * `maxRows` with `…`, effects giving way to it, so the band never passes
 * `maxRows`.
 */
export function buildScene(i: SceneInput): Scene | null {
  const c = i.character;
  const o: WidthOptions = { ambiguousCharacterWidth: i.ambiguousCharacterWidth ?? 'narrow' };
  const sw = spriteWidth(c, o);
  const color = spriteColor(c, i.now ?? 0);
  // A loud bubble drawn above him, with no room beside him, takes its tone's ink.
  const words = i.bubbleTone ? TONE_COLOR[i.bubbleTone] : c.color;
  const tone = i.bubbleTone ? { tone: i.bubbleTone } : {};
  if (i.maxRows < 1) return null;
  const bw = bubbleWidth(i.cols, sw);
  const beside = !!i.bubble && i.cols >= MIN_BUBBLE_COLS && bw >= 10 && i.maxRows > BUBBLE_FRAME_ROWS;
  const fits = i.cols >= sw + 2 && i.maxRows >= c.height && (!i.bubble || beside || i.maxRows > c.height);
  if (!fits) {
    if (!i.bubble) return null;
    const lines = wrapCells(i.bubble, i.cols - 1, { ...o, maxLines: i.maxRows });
    return { color, rows: [], x: Math.max(0, i.x), rowX: 0, bubble: null, effects: textRows(lines, words), card: null };
  }
  const max = Math.max(0, i.cols - sw - 1);
  let x = Math.min(Math.max(0, i.x), max);
  let rowX = x;
  let bubble: Scene['bubble'] = null;
  let bubbleRows = 0;
  let above: string[] = [];
  if (i.bubble && beside) {
    const side = x > i.cols / 2 ? 'left' : 'right';
    if (side === 'right') {
      x = Math.min(x, Math.max(0, i.cols - sw - bw - 2));
      rowX = x;
    } else {
      x = Math.min(max, Math.max(x, bw + 1));
      rowX = x - bw - 1;
    }
    const lines = wrapCells(i.bubble, bw - BUBBLE_FRAME_COLS, { ...o, maxLines: i.maxRows - BUBBLE_FRAME_ROWS });
    bubble = { text: lines.join('\n'), width: bw, side, ...tone };
    bubbleRows = lines.length + BUBBLE_FRAME_ROWS;
  } else if (i.bubble) {
    above = wrapCells(i.bubble, i.cols - 1, { ...o, maxLines: i.maxRows - c.height });
  }
  const free = i.maxRows - Math.max(c.height, bubbleRows) - above.length;

  const effects: Seg[][] = textRows(above, words);
  if (i.confetti && i.cols >= MIN_EFFECT_COLS && free >= CONFETTI_ROWS) {
    const start = Math.max(0, x - 3);
    const span = Math.min(sw + 6, i.cols - 1 - start);
    const cells = particles(i.confetti.seed, i.confetti.tick, span);
    for (let row = 0; row < CONFETTI_ROWS; row++) {
      effects.push(toSegs(cells.filter((p) => p.row === row).map((p) => ({ col: start + p.col, text: p.ch, color: p.color }))));
    }
  } else if (i.sleeping && free >= 1) {
    const text = i.zTick % 2 === 0 ? 'z Z' : 'Z z';
    const col = Math.max(0, Math.min(i.cols - text.length - 1, x + sw - 3 + (i.zTick % 3)));
    effects.push(toSegs([{ col, text, color: 'gray' }]));
  }

  const lines = [c.name, c.card?.subtitle ?? c.description, `pets ${i.stats.pets} | questions ${i.stats.questions} | ${MOODS[i.pose]}`, ...(c.card?.rows ?? [])];
  const cw = Math.min(CARD_MAX_WIDTH, Math.max(...lines.map((l) => cellWidth(l, o))) + 4);
  const fitsRight = x + sw + 1 + cw <= i.cols;
  const fitsLeft = x - cw - 1 >= 0;
  const preferLeft = bubble?.side === 'right';
  const left = preferLeft ? (fitsLeft ? -(cw + 1) : fitsRight ? sw + 1 : null) : fitsRight ? sw + 1 : fitsLeft ? -(cw + 1) : null;
  const card = left === null ? null : { lines, left, width: cw };

  return { color, rows: frameAt(c, i.pose, i.frame).map((row) => padEndCells(row, sw, o)), x, rowX, bubble, effects, card };
}
