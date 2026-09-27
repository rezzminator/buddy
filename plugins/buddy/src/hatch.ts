// The companion Claude Code's own /buddy hatched for an account (it shipped
// until 2.1.96), recomputed. Its bones were never stored: they are a pure
// function of the identity, rolled from a 32-bit hash of identity + SALT
// through a small PRNG. Only the algorithm is reimplemented here; the ORDER
// of the draws is the contract, and the golden vectors in tests/fixtures pin it.

export const SALT = 'friend-2026-401';

export const SPECIES = [
  'duck', 'goose', 'blob', 'cat', 'dragon', 'octopus', 'owl', 'penguin', 'turtle',
  'snail', 'ghost', 'axolotl', 'capybara', 'cactus', 'robot', 'rabbit', 'mushroom', 'chonk',
] as const;
export type Species = (typeof SPECIES)[number];

export const EYES = ['·', '✦', '×', '◉', '@', '°'] as const;
export type Eye = (typeof EYES)[number];

export const HATS = ['none', 'crown', 'tophat', 'propeller', 'halo', 'wizard', 'beanie', 'tinyduck'] as const;
export type Hat = (typeof HATS)[number];

export const STATS = ['DEBUGGING', 'PATIENCE', 'CHAOS', 'WISDOM', 'SNARK'] as const;
export type Stat = (typeof STATS)[number];

export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
export type Rarity = (typeof RARITIES)[number];

export const RARITY_WEIGHTS: Record<Rarity, number> = { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1 };
export const STAT_FLOOR: Record<Rarity, number> = { common: 5, uncommon: 15, rare: 25, epic: 35, legendary: 50 };

/** Which runtime hatched it: the native install hashed with wyhash, the npm one with FNV-1a. */
export type Variant = 'native' | 'npm';
export const VARIANTS: readonly Variant[] = ['native', 'npm'];

export type Bones = { rarity: Rarity; species: Species; eye: Eye; hat: Hat; shiny: boolean; stats: Record<Stat, number> };
export type Roll = { hash32: number; bones: Bones; inspirationSeed: number };

// ---- hashes -------------------------------------------------------------

const M64 = 0xffffffffffffffffn;
const SECRET = [0xa0761d6478bd642fn, 0xe7037ed1a0b428dbn, 0x8ebc6af09c88c6e3n, 0x589965cc75374cc3n] as const;

/** UTF-8 bytes of a string; a lone surrogate becomes U+FFFD, as TextEncoder writes it. */
export function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

function r8(p: Uint8Array, i: number): bigint {
  let v = 0n;
  for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(p[i + k]!);
  return v;
}

function r4(p: Uint8Array, i: number): bigint {
  return BigInt((p[i]! | (p[i + 1]! << 8) | (p[i + 2]! << 16) | (p[i + 3]! << 24)) >>> 0);
}

/** The 128-bit product folded: low 64 bits xor high 64 bits. */
function mix(a: bigint, b: bigint): bigint {
  const x = a * b;
  return (x & M64) ^ (x >> 64n);
}

/**
 * wyhash (the final revision Zig's std.hash.Wyhash implements, which is
 * Bun.hash) of `bytes` with `seed`: an unsigned 64-bit BigInt. The block loop
 * stops while more than 48 bytes remain unread, so 1 to 48 always reach the tail.
 */
export function wyhash64(bytes: Uint8Array, seed = 0n): bigint {
  const len = bytes.length;
  let s0 = seed ^ mix(seed ^ SECRET[0], SECRET[1]);
  let a: bigint;
  let b: bigint;
  if (len <= 16) {
    if (len >= 4) {
      const quarter = (len >> 3) << 2;
      const end = len - 4;
      a = (r4(bytes, 0) << 32n) | r4(bytes, quarter);
      b = (r4(bytes, end) << 32n) | r4(bytes, end - quarter);
    } else if (len > 0) {
      a = (BigInt(bytes[0]!) << 16n) | (BigInt(bytes[len >> 1]!) << 8n) | BigInt(bytes[len - 1]!);
      b = 0n;
    } else {
      a = 0n;
      b = 0n;
    }
  } else {
    let i = 0;
    if (len >= 48) {
      let s1 = s0;
      let s2 = s0;
      for (; i + 48 < len; i += 48) {
        s0 = mix(r8(bytes, i) ^ SECRET[1], r8(bytes, i + 8) ^ s0);
        s1 = mix(r8(bytes, i + 16) ^ SECRET[2], r8(bytes, i + 24) ^ s1);
        s2 = mix(r8(bytes, i + 32) ^ SECRET[3], r8(bytes, i + 40) ^ s2);
      }
      s0 ^= s1 ^ s2;
    }
    for (; i + 16 < len; i += 16) s0 = mix(r8(bytes, i) ^ SECRET[1], r8(bytes, i + 8) ^ s0);
    a = r8(bytes, len - 16);
    b = r8(bytes, len - 8);
  }
  a ^= SECRET[1];
  b ^= s0;
  const x = a * b;
  return mix((x & M64) ^ SECRET[0] ^ BigInt(len), (x >> 64n) ^ SECRET[1]);
}

/** FNV-1a 32 over UTF-16 code units, unsigned. */
export function fnv1a32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The 32-bit seed of an identity: wyhash's low 32 bits (native) or FNV-1a (npm). */
export function hash32(identity: string, variant: Variant): number {
  const key = identity + SALT;
  return variant === 'npm' ? fnv1a32(key) : Number(wyhash64(utf8(key)) & 0xffffffffn);
}

// ---- the roll -----------------------------------------------------------

/** The mulberry32 variant: floats in [0, 1) from a 32-bit seed. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 1831565813) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(next: () => number, list: readonly T[]): T {
  return list[Math.floor(next() * list.length)]!;
}

function rarityOf(next: () => number): Rarity {
  let r = next() * 100;
  for (const z of RARITIES) {
    r -= RARITY_WEIGHTS[z];
    if (r < 0) return z;
  }
  return 'common';
}

function statsOf(next: () => number, rarity: Rarity): Record<Stat, number> {
  const floor = STAT_FLOOR[rarity];
  const peak = pick(next, STATS);
  let dump = pick(next, STATS);
  while (dump === peak) dump = pick(next, STATS);
  const out = {} as Record<Stat, number>;
  for (const s of STATS) {
    if (s === peak) out[s] = Math.min(100, floor + 50 + Math.floor(next() * 30));
    else if (s === dump) out[s] = Math.max(1, floor - 10 + Math.floor(next() * 15));
    else out[s] = floor + Math.floor(next() * 40);
  }
  return out;
}

/**
 * The draws, in order: rarity, species, eye, hat (a common one draws none and
 * consumes NO draw), shiny, stats (peak, dump re-drawn until it differs, then
 * one per stat), the inspiration seed.
 */
export function rollSeed(seed: number): Omit<Roll, 'hash32'> {
  const next = mulberry32(seed);
  const rarity = rarityOf(next);
  const species = pick(next, SPECIES);
  const eye = pick(next, EYES);
  const hat: Hat = rarity === 'common' ? 'none' : pick(next, HATS);
  const shiny = next() < 0.01;
  const stats = statsOf(next, rarity);
  const inspirationSeed = Math.floor(next() * 1e9);
  return { bones: { rarity, species, eye, hat, shiny, stats }, inspirationSeed };
}

/** The companion's bones for an identity, as the native or the npm install rolled them. */
export function roll(identity: string, variant: Variant): Roll {
  const h = hash32(identity, variant);
  return { hash32: h, ...rollSeed(h) };
}
