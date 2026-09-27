import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { SALT, fnv1a32, hash32, mulberry32, roll, rollSeed, utf8, wyhash64, type Bones, type Variant } from '../plugins/buddy/src/hatch.ts';

// Golden vectors from running Claude Code 2.1.96's own functions (native: Bun,
// npm: Node), and Bun.hash itself over strings of every length branch.

type Golden = { runtime: string; count: number; vectors: { id: string; hash32: number; bones: Bones; inspirationSeed: number }[] };
type BunVectors = { count: number; vectors: { s: string; bytes: number; hash64: string; hash32: number }[] };
const load = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;

function mismatches(g: Golden, variant: Variant): string[] {
  const out: string[] = [];
  g.vectors.forEach((v, i) => {
    const r = roll(v.id, variant);
    const want = { hash32: v.hash32, bones: v.bones, inspirationSeed: v.inspirationSeed };
    if (JSON.stringify(r) !== JSON.stringify(want)) out.push(`#${i} (id length ${v.id.length}): got ${JSON.stringify(r)}, want ${JSON.stringify(want)}`);
  });
  return out;
}

describe('roll: the golden vectors, every field exact', () => {
  test('native (wyhash): all 300', () => {
    const g = load<Golden>('hatch-wyhash.json');
    expect(g.vectors).toHaveLength(300);
    expect(mismatches(g, 'native')).toEqual([]);
  });

  test('npm (FNV-1a): all 300', () => {
    const g = load<Golden>('hatch-fnv.json');
    expect(g.vectors).toHaveLength(300);
    expect(mismatches(g, 'npm')).toEqual([]);
  });

  test('the vectors cover every rarity, a hat on a non-common, none on every common', () => {
    const all = [...load<Golden>('hatch-wyhash.json').vectors, ...load<Golden>('hatch-fnv.json').vectors];
    expect(new Set(all.map((v) => v.bones.rarity))).toEqual(new Set(['common', 'uncommon', 'rare', 'epic', 'legendary']));
    expect(all.filter((v) => v.bones.rarity === 'common').every((v) => v.bones.hat === 'none')).toBe(true);
    expect(all.some((v) => v.bones.rarity !== 'common' && v.bones.hat !== 'none')).toBe(true);
  });

  test('the two installs disagree: the variant matters', () => {
    const same = load<Golden>('hatch-wyhash.json').vectors.filter((v) => roll(v.id, 'npm').bones.species === v.bones.species).length;
    expect(same).toBeLessThan(60);
  });
});

describe('wyhash64: equal to Bun.hash', () => {
  const b = load<BunVectors>('wyhash-bun.json');

  test('every recorded string, 64 bits and the low 32', () => {
    const bad = b.vectors.filter((v) => wyhash64(utf8(v.s)).toString() !== v.hash64 || Number(wyhash64(utf8(v.s)) & 0xffffffffn) !== v.hash32).map((v) => `${v.bytes} bytes`);
    expect(b.vectors.length).toBeGreaterThanOrEqual(300);
    expect(bad).toEqual([]);
  });

  test('the recorded strings reach every length branch, multi-byte UTF-8 included', () => {
    const lens = new Set(b.vectors.map((v) => v.bytes));
    for (const n of [0, 1, 2, 3, 4, 8, 9, 16, 17, 47, 48, 49, 95, 96, 97, 144, 145, 200]) expect(lens.has(n), `${n} bytes`).toBe(true);
    expect(b.vectors.some((v) => v.bytes > v.s.length)).toBe(true);
  });

  test('utf8 is the UTF-8 encoding', () => {
    for (const v of b.vectors) expect(Buffer.from(utf8(v.s)).equals(Buffer.from(v.s, 'utf8'))).toBe(true);
    expect([...utf8('\ud800')]).toEqual([0xef, 0xbf, 0xbd]);
  });
});

describe('the pieces', () => {
  test('fnv1a32 over UTF-16 code units', () => {
    expect(fnv1a32('')).toBe(2166136261);
    expect(fnv1a32('a')).toBe(0xe40c292c);
  });

  test('hash32 salts the identity', () => {
    expect(hash32('anon', 'npm')).toBe(fnv1a32(`anon${SALT}`));
    expect(hash32('anon', 'native')).toBe(Number(wyhash64(utf8(`anon${SALT}`)) & 0xffffffffn));
  });

  test('mulberry32 is deterministic floats in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x >= 0 && x < 1).toBe(true);
    }
  });

  test('rollSeed is roll without the hash', () => {
    const r = roll('anon', 'native');
    expect(rollSeed(r.hash32)).toEqual({ bones: r.bones, inspirationSeed: r.inspirationSeed });
  });
});
