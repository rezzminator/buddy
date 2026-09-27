import { describe, expect, test } from 'vitest';
import { LOG_LEVELS, Logger, THROTTLE_MS, errorFields, notice, sumUsage, usageFields, type LogIO } from '../plugins/buddy/src/log.ts';

function disk(refuse = false) {
  const files: Record<string, string> = {};
  const fallback: string[] = [];
  const io: LogIO = {
    read: async (p) => files[p],
    write: async (p, t) => {
      if (refuse) throw new Error(`EACCES: ${p}`);
      files[p] = t;
    },
    fallback: (l) => fallback.push(l),
  };
  return { files, fallback, io };
}

const lines = (t = '') => t.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('Logger', () => {
  test('one JSON line per record with ts, level, event, context and fields', async () => {
    const d = disk();
    const L = new Logger('info', '/l/buddy.log', 1000, () => 0);
    L.context = { session: 's1', character: 'duck' };
    L.log('info', 'ask.start', { length: 3 });
    await L.flush(d.io);
    expect(lines(d.files['/l/buddy.log'])).toEqual([{ ts: '1970-01-01T00:00:00.000Z', level: 'info', event: 'ask.start', session: 's1', character: 'duck', length: 3 }]);
  });

  test('levels: error < info < debug; a record above the level is dropped', async () => {
    expect(LOG_LEVELS).toEqual(['error', 'info', 'debug']);
    const d = disk();
    const L = new Logger('error', '/l/b.log');
    L.log('info', 'no');
    L.log('debug', 'no');
    L.error('yes', new Error('boom'));
    await L.flush(d.io);
    const r = lines(d.files['/l/b.log']);
    expect(r.map((x) => x.event)).toEqual(['yes']);
    expect(r[0].error.message).toBe('boom');
    expect(r[0].error.stack).toContain('boom');
    L.level = 'debug';
    L.log('debug', 'now');
    await L.flush(d.io);
    expect(lines(d.files['/l/b.log']).map((x) => x.event)).toEqual(['yes', 'now']);
  });

  test('past the cap the file rotates once to .1', async () => {
    const d = disk();
    const L = new Logger('info', '/l/b.log', 200);
    for (let i = 0; i < 3; i++) L.log('info', `e${i}`, { pad: 'x'.repeat(40) });
    await L.flush(d.io);
    const first = d.files['/l/b.log']!;
    L.log('info', 'e3', { pad: 'x'.repeat(40) });
    await L.flush(d.io);
    expect(d.files['/l/b.log.1']).toBe(first);
    expect(lines(d.files['/l/b.log']).map((x) => x.event)).toEqual(['e3']);
  });

  test('two sessions flushing the same file at once keep every record', async () => {
    const d = disk();
    const A = new Logger('info', '/l/b.log');
    const B = new Logger('info', '/l/b.log');
    A.log('info', 'a1');
    B.log('info', 'b1');
    await Promise.all([A.flush(d.io), B.flush(d.io)]);
    expect(lines(d.files['/l/b.log']).map((x) => x.event).sort()).toEqual(['a1', 'b1']);
    expect(d.fallback).toEqual([]);
  });

  test('a record another writer keeps overwriting goes to the fallback, never silently', async () => {
    const d = disk();
    // Every write of the file is replaced at once by a session that read it before.
    const io: LogIO = { ...d.io, write: async (p, t) => void (d.files[p] = p.endsWith('.1') ? t : '{"event":"rival"}\n') };
    const L = new Logger('info', '/l/b.log');
    L.log('info', 'fine');
    L.error('reading x', new Error('nope'));
    await expect(L.flush(io)).resolves.toBeUndefined();
    expect(d.fallback[0]).toBe('the log /l/b.log lost 2 records to another writer at the same time');
    expect(d.fallback[1]).toMatch(/^\{.*"event":"reading x"/);
    expect(d.fallback).toHaveLength(2);
  });

  test('a failed write goes to the fallback with its errors, and never throws', async () => {
    const d = disk(true);
    const L = new Logger('info', '/l/b.log');
    L.log('info', 'fine');
    L.error('reading x', new Error('nope'));
    await expect(L.flush(d.io)).resolves.toBeUndefined();
    expect(d.fallback[0]).toBe('writing the log /l/b.log failed: EACCES: /l/b.log');
    expect(d.fallback[1]).toMatch(/^\{.*"event":"reading x".*"message":"nope"/);
    expect(d.fallback).toHaveLength(2);
  });

  test('a fallback that throws never kills the log: a later flush still writes, and flush never throws', async () => {
    const d = disk();
    let refuse = true;
    const bad: LogIO = {
      read: d.io.read,
      write: async (p, t) => {
        if (refuse) throw new Error(`EACCES: ${p}`);
        await d.io.write(p, t);
      },
      fallback: () => {
        throw new Error('no debug log either');
      },
    };
    const L = new Logger('info', '/l/b.log');
    L.error('first', new Error('lost'));
    await expect(L.flush(bad)).resolves.toBeUndefined();
    refuse = false;
    L.log('info', 'second');
    await expect(L.flush(d.io)).resolves.toBeUndefined();
    expect(lines(d.files['/l/b.log']).map((x) => x.event)).toEqual(['second']);
    const orphaned = new Logger('info', '');
    orphaned.error('orphan', 'plain');
    expect(() => orphaned.flush(bad)).not.toThrow();
  });

  test('no file: errors still reach the fallback, nothing is written', async () => {
    const d = disk();
    const L = new Logger('info', '');
    L.log('info', 'quiet');
    L.error('loud', 'plain');
    await L.flush(d.io);
    expect(d.files).toEqual({});
    expect(d.fallback).toHaveLength(1);
    expect(d.fallback[0]).toContain('"message":"plain"');
    expect(await L.tail(d.io)).toEqual([]);
  });

  test('throttled debug: at most once per THROTTLE_MS per event', async () => {
    let now = 0;
    const d = disk();
    const L = new Logger('debug', '/l/b.log', 10_000, () => now);
    L.throttled('tick');
    L.throttled('tick');
    L.throttled('other');
    now = THROTTLE_MS;
    L.throttled('tick');
    await L.flush(d.io);
    expect(lines(d.files['/l/b.log']).map((x) => x.event)).toEqual(['tick', 'other', 'tick']);
    L.level = 'info';
    now += THROTTLE_MS;
    L.throttled('tick');
    await L.flush(d.io);
    expect(lines(d.files['/l/b.log'])).toHaveLength(3);
  });

  test('tail: the last n lines after the queued writes', async () => {
    const d = disk();
    const L = new Logger('info', '/l/b.log');
    for (let i = 0; i < 25; i++) L.log('info', `e${i}`);
    const t = await L.tail(d.io);
    expect(t).toHaveLength(20);
    expect(JSON.parse(t[19]!).event).toBe('e24');
  });

  test('errorFields: message and stack of an Error; a string of anything else', () => {
    expect(errorFields('x')).toEqual({ message: 'x' });
    expect(errorFields(new Error('y')).message).toBe('y');
  });
});

describe('usageFields', () => {
  test('a model call\'s token counts as short log fields; the share read from the prompt cache as a percent', () => {
    expect(usageFields({ input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 })).toEqual({ inTok: 10, cacheRead: 90, cacheWrite: 0, outTok: 40, cachePct: 90 });
    expect(usageFields({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toEqual({ inTok: 0, cacheRead: 0, cacheWrite: 0, outTok: 0, cachePct: 0 });
  });
  test('no usage, or not an object: no fields', () => {
    expect(usageFields(undefined)).toEqual({});
    expect(usageFields('x')).toEqual({});
  });
});

describe('notice', () => {
  test('a transcript notice names the plugin: Claude Code states its name only for the debug log', () => {
    expect(notice('reading the rememberedExchanges failed: EIO')).toBe('buddy: reading the rememberedExchanges failed: EIO');
  });
});

describe('sumUsage', () => {
  test('adds two calls\' usage, key by key, so a retried question logs what both cost', () => {
    expect(usageFields(sumUsage({ input_tokens: 600, output_tokens: 0 }, { input_tokens: 610, output_tokens: 30, cache_read_input_tokens: 5 }))).toEqual({ inTok: 1210, cacheRead: 5, cacheWrite: 0, outTok: 30, cachePct: 0 });
    expect(sumUsage(undefined, { input_tokens: 1 })).toEqual({ input_tokens: 1 });
  });
});
