/** One model's list price, USD per million tokens: input, output, 5-minute cache write, 1-hour cache write, cache read. */
type Price = { in: number; out: number; w5m: number; w1h: number; hit: number };

/** The token fields a model call logs (`usageFields`); a missing one counts 0, any other key is ignored. */
export type CallUsage = { inTok?: number; outTok?: number; cacheRead?: number; cacheWrite?: number };

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

/** USD one model call cost, at list price; undefined (never 0) when the model is unknown. The usage has no 5m/1h split, so every cache write bills at the 5-minute price. */
export function priceCall(model: string, usage: CallUsage): number | undefined {
  const p = lookup(model);
  if (p === undefined) return undefined;
  return ((usage.inTok ?? 0) * p.in + (usage.outTok ?? 0) * p.out + (usage.cacheWrite ?? 0) * p.w5m + (usage.cacheRead ?? 0) * p.hit) / 1e6;
}
