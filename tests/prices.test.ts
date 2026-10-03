import { describe, expect, test } from 'vitest';
import { PRICES, priceCall, usageOfClaudeJson } from '../plugins/buddy/src/prices.ts';

const M = 1_000_000;

describe('priceCall: aliases', () => {
  test.each([
    ['opus', 'claude-opus-5-5'],
    ['sonnet', 'claude-sonnet-5-5'],
    ['haiku', 'claude-haiku-4-5'],
    ['fable', 'claude-fable-5-1'],
  ])('%s prices as %s', (alias, id) => {
    for (const usage of [{ inTok: M }, { outTok: M }, { cacheWrite: M }, { cacheRead: M }]) {
      expect(priceCall(alias, usage)).toBe(priceCall(id, usage));
    }
  });

  test('opus is Opus 5.5 on every column', () => {
    expect(priceCall('opus', { inTok: M })).toBeCloseTo(4, 10);
    expect(priceCall('opus', { outTok: M })).toBeCloseTo(20, 10);
    expect(priceCall('opus', { cacheWrite: M })).toBeCloseTo(5, 10);
    expect(priceCall('opus', { cacheRead: M })).toBeCloseTo(0.2, 10);
  });
});

describe('priceCall: the formula', () => {
  test('a mixed usage on haiku 4.5 bills in, out, cache write at 5m and cache read', () => {
    // 1000*1 + 500*5 + 2000*1.25 + 40000*0.1 = 1000 + 2500 + 2500 + 4000 = 10000 per million
    const usd = priceCall('claude-haiku-4-5', { inTok: 1000, outTok: 500, cacheWrite: 2000, cacheRead: 40000 });
    expect(usd).toBeCloseTo(0.01, 10);
  });

  test('a cache write with no one-hour part bills at the 5-minute price', () => {
    expect(priceCall('claude-opus-4-1', { cacheWrite: M })).toBeCloseTo(18.75, 10);
    expect(priceCall('claude-haiku-4-5', { cacheWrite: 1000 })).toBeCloseTo((1000 * 1.25) / M, 12);
  });

  test('the one-hour part of a cache write bills at the 1-hour price, the rest at the 5-minute price', () => {
    // haiku 4.5: 400 at 1.25 (w5m) + 600 at 2 (w1h)
    expect(priceCall('claude-haiku-4-5', { cacheWrite: 1000, cacheWrite1h: 600 })).toBeCloseTo((400 * 1.25 + 600 * 2) / M, 12);
    expect(priceCall('claude-opus-4-1', { cacheWrite: M, cacheWrite1h: M })).toBeCloseTo(30, 10);
  });

  test('a usage carrying cachePct (what usageFields returns) ignores it', () => {
    const usage: Record<string, number> = { inTok: M, cacheRead: 0, cacheWrite: 0, outTok: 0, cachePct: 99 };
    expect(priceCall('claude-sonnet-4-5', usage)).toBeCloseTo(3, 10);
  });

  test('empty usage on a known model is 0', () => {
    expect(priceCall('claude-haiku-4-5', {})).toBe(0);
  });

  test('a decimal list price is exact to the cent-fraction', () => {
    expect(priceCall('claude-3-5-haiku', { inTok: 1000, outTok: 1000, cacheWrite: 1000, cacheRead: 1000 })).toBeCloseTo((0.8 + 4 + 1 + 0.08) / 1000, 12);
  });
});

describe('usageOfClaudeJson', () => {
  // The usage of a captured `claude -p --output-format json` reply.
  const usage = {
    input_tokens: 2,
    cache_creation_input_tokens: 4054,
    cache_read_input_tokens: 2308,
    output_tokens: 289,
    cache_creation: { ephemeral_1h_input_tokens: 4054, ephemeral_5m_input_tokens: 0 },
  };

  test('maps every token field, the one-hour cache write included', () => {
    expect(usageOfClaudeJson(usage)).toEqual({ inTok: 2, outTok: 289, cacheRead: 2308, cacheWrite: 4054, cacheWrite1h: 4054 });
  });

  test('priced, it bills in, out, read, the one-hour write and the rest at their own columns', () => {
    const mixed = { ...usage, cache_creation_input_tokens: 5000, cache_creation: { ephemeral_1h_input_tokens: 4054, ephemeral_5m_input_tokens: 946 } };
    const p = PRICES.models['claude-opus-5-5'];
    const want = (2 * p.in + 289 * p.out + 2308 * p.hit + 4054 * p.w1h + 946 * p.w5m) / M;
    expect(priceCall('opus', usageOfClaudeJson(mixed))).toBeCloseTo(want, 12);
  });

  test.each([null, undefined, 'usage', 42, [1, 2]])('%j is not an object: {}', (v) => {
    expect(usageOfClaudeJson(v)).toEqual({});
  });

  test('a field that is not a number is left out', () => {
    expect(usageOfClaudeJson({ input_tokens: '2', output_tokens: 5, cache_read_input_tokens: null, cache_creation: 'x' })).toEqual({ outTok: 5 });
    expect(usageOfClaudeJson({ cache_creation: { ephemeral_1h_input_tokens: '9' } })).toEqual({});
  });
});

describe('priceCall: model lookup', () => {
  test('a dated id prices as its base id', () => {
    expect(priceCall('claude-haiku-4-5-20251001', { inTok: M, outTok: M })).toBe(priceCall('claude-haiku-4-5', { inTok: M, outTok: M }));
    expect(priceCall('claude-haiku-4-5-20251001', { inTok: M })).toBeCloseTo(1, 10);
  });

  test('the published Haiku 3.5 id, with its date, prices at 0.8 in, 4 out, 1 cache write and 0.08 cache read', () => {
    const id = 'claude-3-5-haiku-20241022';
    expect(priceCall(id, { inTok: M })).toBeCloseTo(0.8, 10);
    expect(priceCall(id, { outTok: M })).toBeCloseTo(4, 10);
    expect(priceCall(id, { cacheWrite: M })).toBeCloseTo(1, 10);
    expect(priceCall(id, { cacheRead: M })).toBeCloseTo(0.08, 10);
  });

  test('case and surrounding whitespace resolve', () => {
    expect(priceCall(' Opus ', { inTok: M })).toBeCloseTo(4, 10);
    expect(priceCall('  CLAUDE-Sonnet-4-6\n', { outTok: M })).toBeCloseTo(15, 10);
  });

  test('a date suffix is stripped once, and only when it is 8 digits', () => {
    expect(priceCall('claude-haiku-4-5-2025', { inTok: M })).toBeUndefined();
    expect(priceCall('claude-haiku-4-5-20251001-20251001', { inTok: M })).toBeUndefined();
    expect(priceCall('claude-nope-20251001', { inTok: M })).toBeUndefined();
  });

  test.each(['opus[1m]', 'us.anthropic.claude-opus-5-5', 'gpt-4', ''])('%j is unknown: undefined, never 0', (model) => {
    expect(priceCall(model, { inTok: M, outTok: M })).toBeUndefined();
    expect(priceCall(model, {})).toBeUndefined();
  });

  test('a name on the Object prototype is unknown', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(priceCall(name, { inTok: M })).toBeUndefined();
  });
});

describe('PRICES', () => {
  const columns = ['in', 'out', 'w5m', 'w1h', 'hit'] as const;

  test('every row has all five numeric columns', () => {
    const rows = Object.entries(PRICES.models);
    expect(rows.length).toBeGreaterThan(0);
    for (const [id, row] of rows) {
      for (const c of columns) {
        const v = row[c];
        expect(typeof v, `${id}.${c}`).toBe('number');
        expect(Number.isFinite(v), `${id}.${c}`).toBe(true);
        expect(v, `${id}.${c}`).toBeGreaterThan(0);
      }
    }
  });

  test('every alias points at an existing row', () => {
    const aliases = Object.entries(PRICES.aliases);
    expect(aliases.map(([k]) => k).sort()).toEqual(['fable', 'haiku', 'opus', 'sonnet']);
    for (const [alias, id] of aliases) expect(Object.keys(PRICES.models), alias).toContain(id);
  });

  test('every row prices through priceCall with its own columns', () => {
    for (const [id, row] of Object.entries(PRICES.models)) {
      expect(priceCall(id, { inTok: M }), id).toBeCloseTo(row.in, 10);
      expect(priceCall(id, { outTok: M }), id).toBeCloseTo(row.out, 10);
      expect(priceCall(id, { cacheWrite: M }), id).toBeCloseTo(row.w5m, 10);
      expect(priceCall(id, { cacheRead: M }), id).toBeCloseTo(row.hit, 10);
    }
  });
});
