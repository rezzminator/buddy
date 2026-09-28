// The feed: what passed between you and the buddy in this session, in order,
// for the drawer /buddy opens: your prompts to Claude (the context each buddy
// line answers), the main chat's compactions, your questions and its answers,
// its comment after each turn, each next prompt it suggested and whether you
// sent it, the canned lines it said on its own, and every failure, said as
// one. Texts are kept whole. It spans exactly what the buddy remembers
// (src/chatTurnsToRead.ts): the same last turns, nothing before a /clear. No
// I/O: the adapter keeps the feed in $.state and draws it.

import { COMPACTION, type Block } from './chatTurnsToRead.ts';

export type FeedKind = 'you' | 'compact' | 'ask' | 'answer' | 'comment' | 'suggest' | 'line' | 'failed' | 'clear';

/**
 * One entry. `who` and `color`: the character that said it (its name and
 * ink). `ms` and `tokens`: the model call behind it, from the ask or the
 * turn's end to the reply. `taken`: a suggestion you then sent as your prompt
 * (true), sent another prompt after (false), or not yet answered (absent).
 * `turnId`: the main turn a `you` entry started, or a `compact` entry's id.
 * `read`: whether the buddy filed that turn into its memory (true), or it
 * ended unanswered and the buddy never read it (false); absent while it runs.
 */
export type FeedEntry = {
  id: number;
  at: number;
  kind: FeedKind;
  text: string;
  who?: string;
  color?: string;
  ms?: number;
  tokens?: number;
  taken?: boolean;
  turnId?: string;
  read?: boolean;
};

export type NewEntry = Omit<FeedEntry, 'id'>;

/** `feed` with `entry` added last, numbered after the last, its text whole but for the blank space around it. */
export function pushEntry(feed: readonly FeedEntry[], entry: NewEntry): FeedEntry[] {
  const id = (feed.at(-1)?.id ?? 0) + 1;
  return [...feed, { ...entry, text: entry.text.trim(), id }];
}

/** The `you` entry of turn `turnId` marked read or not by the buddy. */
export function markRead(feed: readonly FeedEntry[], turnId: string, read: boolean): FeedEntry[] {
  return feed.map((e) => (e.kind === 'you' && e.turnId === turnId ? { ...e, read } : e));
}

/**
 * The feed cut to what the buddy remembers of `n` turns: nothing before the
 * last /clear, and nothing before the `n`th newest turn it read (a compaction
 * is one). A turn it never read stays inside that span.
 */
export function pruneToMemory(feed: readonly FeedEntry[], n: number): FeedEntry[] {
  let from = 0;
  for (let i = feed.length - 1; i >= 0; i--) {
    if (feed[i]!.kind === 'clear') {
      from = i;
      break;
    }
  }
  const turns: number[] = [];
  for (let i = from; i < feed.length; i++) {
    const e = feed[i]!;
    if (e.kind === 'compact' || (e.kind === 'you' && e.read === true)) turns.push(i);
  }
  if (turns.length > n) from = turns[turns.length - n]!;
  return from === 0 ? [...feed] : feed.slice(from);
}

/**
 * The feed drawn back from the buddy's memory, where the session's own feed
 * is gone (a resume, a restart): each remembered turn or compaction, then
 * what `characterId` said after it; `at` where a block has no time.
 */
export function feedOfMemory(blocks: readonly Block[], characterId: string, voice: { who?: string; color?: string }, at: number): FeedEntry[] {
  let f: FeedEntry[] = [];
  for (const b of blocks) {
    const when = b.at ?? at;
    if (b.turn) {
      if (b.turn.from === COMPACTION) f = pushEntry(f, { at: when, kind: 'compact', text: b.turn.answer, turnId: b.turnId, read: true });
      else f = pushEntry(answerSuggestions(f, b.turn.prompt), { at: when, kind: 'you', text: b.turn.prompt, turnId: b.turnId, read: true });
    }
    for (const x of b.characters[characterId] ?? []) {
      if (x.kind === 'question') {
        f = pushEntry(f, { at: when, kind: 'ask', text: x.question });
        if (x.answer) f = pushEntry(f, { at: when, kind: 'answer', text: x.answer, ...voice });
      } else if (x.kind === 'line') {
        f = pushEntry(f, { at: when, kind: 'line', text: x.text, ...voice });
      } else {
        if (x.commentAfterEachTurn) f = pushEntry(f, { at: when, kind: 'comment', text: x.commentAfterEachTurn, ...voice });
        if (x.suggestNextPrompt) f = pushEntry(f, { at: when, kind: 'suggest', text: x.suggestNextPrompt, ...voice });
      }
    }
  }
  return f;
}

const same = (a: string) => a.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Your prompt `prompt` was sent: every suggestion not yet answered is taken
 * when the prompt is that suggestion (spacing and case aside), passed over
 * otherwise.
 */
export function answerSuggestions(feed: readonly FeedEntry[], prompt: string): FeedEntry[] {
  const p = same(prompt);
  return feed.map((e) => (e.kind === 'suggest' && e.taken === undefined ? { ...e, taken: p !== '' && same(e.text) === p } : e));
}

export type FeedStats = {
  comments: number;
  answers: number;
  asks: number;
  suggestions: number;
  taken: number;
  failed: number;
  /** The mean time of the calls that said how long they took; null when none did. */
  avgMs: number | null;
  tokens: number;
};

export function statsOf(feed: readonly FeedEntry[]): FeedStats {
  const count = (k: FeedKind) => feed.filter((e) => e.kind === k).length;
  const times = feed.filter((e) => e.ms !== undefined).map((e) => e.ms!);
  return {
    comments: count('comment'),
    answers: count('answer'),
    asks: count('ask'),
    suggestions: count('suggest'),
    taken: feed.filter((e) => e.kind === 'suggest' && e.taken === true).length,
    failed: count('failed'),
    avgMs: times.length > 0 ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
    tokens: feed.reduce((n, e) => n + (e.tokens ?? 0), 0),
  };
}

/** `at` as the local wall clock, HH:MM. */
export function clockOf(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** A count short: 950, 1.2k, 34k, 1.2M. */
export function short(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Milliseconds short: 820ms, 2.3s, 41s. */
export function seconds(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

/** `text` broken into lines of at most `width` columns, at spaces where it can, a word longer than a line cut. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let rest = word;
      while (rest.length > w) {
        if (line) {
          out.push(line);
          line = '';
        }
        out.push(rest.slice(0, w));
        rest = rest.slice(w);
      }
      if (!rest) continue;
      if (!line) line = rest;
      else if (line.length + 1 + rest.length <= w) line += ` ${rest}`;
      else {
        out.push(line);
        line = rest;
      }
    }
    out.push(line);
  }
  return out;
}

// ---- colors: the cells of a Raster -----------------------------------------

/** The RGB of each ink a character may be drawn in (character.ts INK_COLORS), for the panels' gradients. */
const INK_RGB: Record<string, number> = {
  black: 0x3b3b3b, red: 0xe5534b, green: 0x57ab5a, yellow: 0xe0b341, blue: 0x539bf5, magenta: 0xc678dd, cyan: 0x39c5cf, white: 0xe6e6e6, gray: 0x8b949e, grey: 0x8b949e,
  redBright: 0xff7b72, greenBright: 0x7ee787, yellowBright: 0xf2cc60, blueBright: 0x79c0ff, magentaBright: 0xd2a8ff, cyanBright: 0x56d4dd, whiteBright: 0xffffff, blackBright: 0x6e7681,
};

/** An ink's RGB, or a hex `#rrggbb` color's; a warm gold when unknown. */
export function rgbOf(color: string | undefined): number {
  if (color && /^#[0-9a-f]{6}$/i.test(color)) return Number.parseInt(color.slice(1), 16);
  return (color !== undefined ? INK_RGB[color] : undefined) ?? 0xe0b341;
}

/** The color `t` of the way (0 to 1) from `a` to `b`. */
export function mix(a: number, b: number, t: number): number {
  const c = (shift: number) => Math.round(((a >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t) << shift;
  return c(16) | c(8) | c(0);
}

/** The terminal's own background, for a Raster cell (RasterProps). */
export const DEFAULT_BG = 0x01000000;

/** One cell of a Raster: a glyph, its color, its background. */
export type Cell = [glyph: string, fg: number, bg: number];

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Cells as a Raster takes them: little-endian u32 triplets [codePoint, fg, bg], padded base64. */
export function packCells(cells: readonly Cell[]): string {
  const bytes: number[] = [];
  const u32 = (v: number) => bytes.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
  for (const [g, fg, bg] of cells) {
    u32(g.codePointAt(0) ?? 32);
    u32(fg);
    u32(bg);
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = [bytes[i]!, bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=') + (i + 2 < bytes.length ? B64[n & 63]! : '=');
  }
  return out;
}

/** A rule `width` cells wide in `glyph`, its color running from `from` to `to` and back, the peak moved by `phase` (0 to 1): a light passing along it. */
export function shimmerRule(width: number, from: number, to: number, phase: number, glyph = '━'): Cell[] {
  const w = Math.max(1, width);
  return Array.from({ length: w }, (_, i) => {
    const d = Math.abs(i / w - phase);
    const t = Math.max(0, 1 - Math.min(d, 1 - d) * 4);
    return [glyph, mix(from, to, t), DEFAULT_BG] as Cell;
  });
}
