/** One model's list price, USD per million tokens: input, output, 5-minute cache write, 1-hour cache write, cache read. */
type Price = { in: number; out: number; w5m: number; w1h: number; hit: number };

/** The token fields a model call logs (`usageFields`); a missing one counts 0, any other key is ignored. `cacheWrite1h` is the part of `cacheWrite` held for one hour, when the usage reports the split. */
export type CallUsage = { inTok?: number; outTok?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number };

/** The one price table: the plugin prices its calls from it, and scripts/audit.mjs imports this module for the calls an older log line left without a `usd`. */
export const PRICES = {
  aliases: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-4-5', fable: 'claude-fable-5-1' },
  models: {
    'claude-fable-5-1': { in: 10, out: 50, w5m: 12.5, w1h: 20, hit: 0.25 },
    'claude-mythos-5-1': { in: 10, out: 50, w5m: 12.5, w1h: 20, hit: 0.25 },
    'claude-fable-5': { in: 10, out: 50, w5m: 12.5, w1h: 20, hit: 1 },
    'claude-mythos-5': { in: 10, out: 50, w5m: 12.5, w1h: 20, hit: 1 },
    'claude-opus-5-5': { in: 4, out: 20, w5m: 5, w1h: 8, hit: 0.2 },
    'claude-opus-5': { in: 5, out: 25, w5m: 6.25, w1h: 10, hit: 0.5 },
    'claude-opus-4-8': { in: 5, out: 25, w5m: 6.25, w1h: 10, hit: 0.5 },
    'claude-opus-4-7': { in: 5, out: 25, w5m: 6.25, w1h: 10, hit: 0.5 },
    'claude-opus-4-6': { in: 5, out: 25, w5m: 6.25, w1h: 10, hit: 0.5 },
    'claude-opus-4-5': { in: 5, out: 25, w5m: 6.25, w1h: 10, hit: 0.5 },
    'claude-opus-4-1': { in: 15, out: 75, w5m: 18.75, w1h: 30, hit: 1.5 },
    'claude-opus-4-0': { in: 15, out: 75, w5m: 18.75, w1h: 30, hit: 1.5 },
    'claude-opus-4': { in: 15, out: 75, w5m: 18.75, w1h: 30, hit: 1.5 },
    'claude-sonnet-5-5': { in: 2, out: 10, w5m: 2.5, w1h: 4, hit: 0.2 },
    'claude-sonnet-5': { in: 2, out: 10, w5m: 2.5, w1h: 4, hit: 0.2 },
    'claude-sonnet-4-6': { in: 3, out: 15, w5m: 3.75, w1h: 6, hit: 0.3 },
    'claude-sonnet-4-5': { in: 3, out: 15, w5m: 3.75, w1h: 6, hit: 0.3 },
    'claude-sonnet-4-0': { in: 3, out: 15, w5m: 3.75, w1h: 6, hit: 0.3 },
    'claude-sonnet-4': { in: 3, out: 15, w5m: 3.75, w1h: 6, hit: 0.3 },
    'claude-haiku-4-5': { in: 1, out: 5, w5m: 1.25, w1h: 2, hit: 0.1 },
    'claude-3-5-haiku': { in: 0.8, out: 4, w5m: 1, w1h: 1.6, hit: 0.08 },
  },
} as const;

const models: Readonly<Record<string, Price>> = PRICES.models;
const aliases: Readonly<Record<string, string>> = PRICES.aliases;

/** The row of a model name: an alias, an exact id, or an id with an 8-digit date suffix (`-20251001`); undefined for anything else. */
function lookup(model: string): Price | undefined {
  const name = model.trim().toLowerCase();
  const id = Object.hasOwn(aliases, name) ? aliases[name] : name;
  if (id !== undefined && Object.hasOwn(models, id)) return models[id];
  const base = name.replace(/-\d{8}$/, '');
  return base !== name && Object.hasOwn(models, base) ? models[base] : undefined;
}

/** USD one model call cost, at list price; undefined (never 0) when the model is unknown. `cacheWrite1h` bills at the 1-hour price and the rest of `cacheWrite` at the 5-minute price; a usage with no split bills every cache write at the 5-minute price. */
export function priceCall(model: string, usage: CallUsage): number | undefined {
  const p = lookup(model);
  if (p === undefined) return undefined;
  const w1h = usage.cacheWrite1h ?? 0;
  const w5m = Math.max(0, (usage.cacheWrite ?? 0) - w1h);
  return ((usage.inTok ?? 0) * p.in + (usage.outTok ?? 0) * p.out + w5m * p.w5m + w1h * p.w1h + (usage.cacheRead ?? 0) * p.hit) / 1e6;
}

const numberOr = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const record = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** The `usage` of a `claude -p --output-format json` reply as a CallUsage, the one-hour cache write included; not an object gives `{}`, a field that is not a number is left out. */
export function usageOfClaudeJson(usage: unknown): CallUsage {
  const u = record(usage);
  if (u === undefined) return {};
  const fields: [keyof CallUsage, unknown][] = [
    ['inTok', u.input_tokens],
    ['outTok', u.output_tokens],
    ['cacheRead', u.cache_read_input_tokens],
    ['cacheWrite', u.cache_creation_input_tokens],
    ['cacheWrite1h', record(u.cache_creation)?.ephemeral_1h_input_tokens],
  ];
  const out: CallUsage = {};
  for (const [key, v] of fields) {
    const n = numberOr(v);
    if (n !== undefined) out[key] = n;
  }
  return out;
}
