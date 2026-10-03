// The plugin's own log: one JSON line per record, `{ts, level, event,
// session?, character?, ...fields}`, added to a file that, past LOG_CAP
// bytes, is archived whole to the next free `{file}.N` (1, 2, 3, …), none ever
// overwritten, so no record is dropped. No `$` here: the adapter hands in the file
// I/O on each flush (a hook's `$` is never kept), so a test drives it from
// memory. Writing never throws into a hook: a failed write goes to the fallback
// (the adapter's `$.ui.log`).
//
// `$.fs` has no append, only a whole-file write, so a flush reads the file,
// writes it back with the new lines, and reads it again: when another session
// sharing the file wrote over them in between, it adds them again, up to
// WRITE_ATTEMPTS times. A record is lost only when the other session's write
// lands after that re-read, and then the fallback says so.

/** The plugin's name, which every transcript notice leads with. */
export const PLUGIN_NAME = 'buddy';

/**
 * A line for `$.ui.log`'s transcript, naming the plugin: Claude Code states
 * that it files a line under the plugin's name only in the debug log, so a
 * transcript notice names the plugin itself. The debug log's copy of the line
 * then reads `buddy: buddy: …`, accepted: `$.ui.log` has no transcript-only
 * sink (UiLogSink: `transcript` goes to the debug log too, `debug` only there).
 */
export function notice(text: string): string {
  return `${PLUGIN_NAME}: ${text}`;
}

export type LogLevel = 'error' | 'info' | 'debug';
export const LOG_LEVELS: readonly LogLevel[] = ['error', 'info', 'debug'];
/** The file's size past which it is archived whole to the next free `{file}.N`: it bounds what each flush reads and writes back, never what is kept. */
export const LOG_CAP = 1_000_000;
/** A throttled debug event is written at most once per this many milliseconds. */
export const THROTTLE_MS = 1000;
export const TAIL_LINES = 20;
/** How many times a flush writes its lines before it reports them lost to another writer. */
export const WRITE_ATTEMPTS = 3;

const RANK: Record<LogLevel, number> = { error: 0, info: 1, debug: 2 };

export type LogIO = {
  /** The file's text; undefined when it does not exist. */
  read: (path: string) => Promise<string | undefined>;
  /** Whether the file exists, without reading it. */
  exists: (path: string) => Promise<boolean>;
  /** Replaces the file's text, creating it and its folders. */
  write: (path: string, text: string) => Promise<void>;
  /** Where a record goes when the file cannot take it, and why. */
  fallback: (line: string) => void;
};

export type LogFields = Record<string, unknown>;

/** An error as fields: its message and stack, never its object. */
export function errorFields(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return error.stack ? { message: error.message, stack: error.stack } : { message: error.message };
  return { message: String(error) };
}

/**
 * The rejection Claude Code gives every `$` call of a `ui.render` hook once a
 * newer render of the same instance replaced it: harmless, the newer render
 * draws, so it is never a failure.
 */
export const RENDER_SUPERSEDED = 'ui.render: superseded';

/** Whether `error` is a render's call cut short by a newer render (RENDER_SUPERSEDED). */
export function superseded(error: unknown): boolean {
  return errorFields(error).message === RENDER_SUPERSEDED;
}

export class Logger {
  level: LogLevel;
  /** The log file; '' writes no file (errors still reach the fallback). */
  file: string;
  context: { session?: string; character?: string } = {};
  /** Sees every record, at any level and whether or not the file is on, before the level decides: the round files' timeline. */
  tap: ((record: { at: number; level: LogLevel; event: string; fields: LogFields }) => void) | null = null;
  private readonly now: () => number;
  private readonly cap: number;
  private pending: string[] = [];
  private chain: Promise<void> = Promise.resolve();
  private lastAt = new Map<string, number>();

  /** Records queued while the file is off, errors only, waiting for a fallback. */
  private orphans: string[] = [];

  constructor(level: LogLevel = 'info', file = '', cap = LOG_CAP, now: () => number = Date.now) {
    this.now = now;
    this.level = level;
    this.file = file;
    this.cap = cap;
  }

  enabled(level: LogLevel): boolean {
    return RANK[level] <= RANK[this.level];
  }

  /** Queues one record when `level` is on; the next flush writes it after every one before it. */
  log(level: LogLevel, event: string, fields: LogFields = {}): void {
    try {
      this.tap?.({ at: this.now(), level, event, fields });
    } catch {
      // A tap that throws never costs the log its record.
    }
    if (!this.enabled(level)) return;
    let line: string;
    try {
      line = JSON.stringify({ ts: new Date(this.now()).toISOString(), level, event, ...this.context, ...fields });
    } catch (error) {
      line = JSON.stringify({ ts: new Date(this.now()).toISOString(), level, event, ...this.context, unloggable: errorFields(error).message });
    }
    if (!this.file) {
      if (level === 'error') this.orphans.push(line);
      return;
    }
    this.pending.push(line);
  }

  error(event: string, error: unknown, fields: LogFields = {}): void {
    this.log('error', event, { ...fields, error: errorFields(error) });
  }

  /**
   * A failure of `what`: an error record, and true, to be said. A render's
   * call a newer render superseded is an info `render.superseded` instead,
   * and false: nothing to say.
   */
  failed(what: string, error: unknown, fields: LogFields = {}): boolean {
    if (superseded(error)) {
      this.log('info', 'render.superseded', { what, ...fields });
      return false;
    }
    this.error(what, error, fields);
    return true;
  }

  /** A debug record at most once per THROTTLE_MS for its event. */
  throttled(event: string, fields: LogFields = {}): void {
    if (!this.enabled('debug')) return;
    const now = this.now();
    const last = this.lastAt.get(event);
    if (last !== undefined && now - last < THROTTLE_MS) return;
    this.lastAt.set(event, now);
    this.log('debug', event, fields);
  }

  /** Writes every queued record through `io`, after every flush before; never throws or rejects. */
  flush(io: LogIO): Promise<void> {
    for (const l of this.orphans.splice(0)) this.fallback(io, l);
    if (this.pending.length === 0) return this.chain;
    // Never left rejected: a rejected chain would skip every later drain, the log dead in silence.
    this.chain = this.chain.then(() => this.drain(io)).catch(() => undefined);
    return this.chain;
  }

  /** The last `n` lines of the file, after every queued write; rejects when it cannot be read. */
  async tail(io: LogIO, n = TAIL_LINES): Promise<string[]> {
    await this.flush(io);
    if (!this.file) return [];
    const text = (await io.read(this.file)) ?? '';
    return text.split('\n').filter((l) => l !== '').slice(-n);
  }

  private async drain(io: LogIO): Promise<void> {
    const lines = this.pending.splice(0);
    if (lines.length === 0) return;
    const add = `${lines.join('\n')}\n`;
    const file = this.file;
    try {
      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
        if (await this.landed(io, file, await this.put(io, file, add))) return;
      }
      this.fallback(io, `the log ${file} lost ${lines.length} records to another writer at the same time`);
    } catch (error) {
      this.fallback(io, `writing the log ${file} failed: ${errorFields(error).message}`);
    }
    for (const l of lines) if (l.includes('"level":"error"')) this.fallback(io, l);
  }

  /** `line` to the fallback; a fallback that throws is swallowed, there being nowhere left to say it. */
  private fallback(io: LogIO, line: string): void {
    try {
      io.fallback(line);
    } catch {
      // The fallback is the last place a record can go.
    }
  }

  /** Adds `add` to the file; past the cap the file is first archived whole to the next free `{file}.N`. Resolves with `add`, whole. */
  private async put(io: LogIO, file: string, add: string): Promise<string> {
    const current = (await io.read(file)) ?? '';
    if (current === '' || current.length + add.length <= this.cap) {
      await io.write(file, current + add);
      return add;
    }
    await io.write(`${file}.${(await this.newestArchive(io, file)) + 1}`, current);
    await io.write(file, add);
    return add;
  }

  /** The highest N with a `{file}.N`, 0 when none: archives are numbered from 1 with no gap. */
  private async newestArchive(io: LogIO, file: string): Promise<number> {
    let n = 0;
    while (await io.exists(`${file}.${n + 1}`)) n++;
    return n;
  }

  /** Whether `text` is in the file, or in the newest archive when another writer archived it since. */
  private async landed(io: LogIO, file: string, text: string): Promise<boolean> {
    if (((await io.read(file)) ?? '').includes(text)) return true;
    const n = await this.newestArchive(io, file);
    return n > 0 && ((await io.read(`${file}.${n}`)) ?? '').includes(text);
  }
}

/** Two calls' raw usage added key by key (numbers only), so a retried call logs what both cost. */
export function sumUsage(a: unknown, b: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of [a, b]) {
    if (typeof u !== 'object' || u === null) continue;
    for (const [k, v] of Object.entries(u)) if (typeof v === 'number') out[k] = (out[k] ?? 0) + v;
  }
  return out;
}

/** A model call's usage as short log fields, with the share of its input read from the prompt cache; {} when there is none. */
export function usageFields(usage: unknown): Record<string, number> {
  if (typeof usage !== 'object' || usage === null) return {};
  const u = usage as Record<string, unknown>;
  const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  const inTok = n('input_tokens');
  const cacheRead = n('cache_read_input_tokens');
  const cacheWrite = n('cache_creation_input_tokens');
  const all = inTok + cacheRead + cacheWrite;
  return { inTok, cacheRead, cacheWrite, outTok: n('output_tokens'), cachePct: all === 0 ? 0 : Math.round((cacheRead / all) * 100) };
}
