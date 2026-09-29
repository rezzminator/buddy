// The numbers of one main turn, as the buddy remembers them beside what Claude
// did: how long it ran and after what pause, its model requests, its tool
// calls by name with their failures and refusals, its subagents, the files it
// touched and the lines it changed, the tests it ran, its commits and pushes,
// its web reads, its tokens and cost, the context window after it, the rate
// limits it neared, and the signs of a turn going in circles (a file edited
// over and over, a shell command run again unchanged, a response cut at max
// tokens). Every number is counted in code as the turn runs; the model reads
// them as one line per remembered turn (renderStats), a few dozen tokens.
// The main loop's own tool calls are counted by name; its subagents' in one
// number; what a call did (files, lines, tests, git, web) counts whoever made
// it, and only when it succeeded. A main-loop shell command's own edits are
// measured, never guessed: the files it names (shellTargets), read before and
// after it runs, count only when they really changed (shellChanges), whatever
// its exit; a tree sweep of the folders it works in (shellFolders) catches
// the files it changes without naming them, a script's or a formatter's
// (sweptChanges), their lines counted where their text was read before, else
// said to be unmeasured (sweptShellChange).
// No I/O: the adapter feeds a Tally from turn.start, turn.step, tool.call and
// turn.complete, reads the session's usage at the turn's start and end, reads
// a shell command's files around it, and closes the Tally into the TurnStats
// filed with the turn.

/** The most tool names one turn's line names, the most used first; the rest are counted. */
export const TOOL_NAMES_MAX = 4;
/** How many edits of one file make it the turn's hot file: the sign of a change going in circles. */
export const HOT_EDITS = 3;
/** The rate-limit use at which a turn's line names the window: below it, the limit is no news. */
export const LIMIT_SAID_PERCENT = 50;
/** The most files one shell command's words are checked as: past it the rest go unmeasured. */
export const SHELL_CANDIDATES_MAX = 24;
/** The largest file a shell command's edits are measured in: a bigger one is left unread. */
export const SHELL_FILE_MAX_BYTES = 256 * 1024;
/** The most files a tree sweep marks, nearest the command's folders first: past it the rest go unmarked. */
export const SWEEP_FILES_MAX = 400;
/** How many folders deep a tree sweep walks below each folder the command works in. */
export const SWEEP_DEPTH_MAX = 4;
/** The most bytes a tree sweep reads before the command runs, smallest files first, so a file it changes has its lines counted. */
export const SWEEP_READ_BYTES_MAX = 512 * 1024;
/** Folders a tree sweep never walks into, beside every dot-folder: dependencies and build output. */
export const SWEEP_SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor', 'target', 'venv', '__pycache__', 'out']);

/** Tokens as the API counts them: input read fresh, output, and input read from or written to the prompt cache. */
export type Tokens = { in: number; out: number; cacheRead: number; cacheWrite: number };

/** One turn's numbers, as stored; a group that stayed zero is left out. */
export type TurnStats = {
  /** The turn's wall-clock time. */
  ms: number;
  /** Since the previous main turn of this conversation ended: how long the user took before this prompt; absent for the first. */
  gapMs?: number;
  /** The main loop's model requests. */
  requests?: number;
  /** The main loop's tool calls, by tool. */
  tools?: Record<string, number>;
  /** The main loop's tool calls that errored, and that were refused (a permission, a hook). */
  failed?: number;
  denied?: number;
  /** The main loop's shell commands run again unchanged in the same turn. */
  reruns?: number;
  /** The subagent runs that ended during the turn, their tool calls, and every token they spent. */
  agents?: { runs: number; tools: number; tokens: number };
  /** Distinct files read, edited and written. */
  files?: { read: number; edited: number; wrote: number };
  /** The file edited most, by name, once edited HOT_EDITS times or more. */
  hot?: { file: string; edits: number };
  /** Lines added and removed by edits and writes; a write counts all its lines as added. `unmeasured`: the files a shell command changed whose lines could not be counted. */
  lines?: { added: number; removed: number; unmeasured?: number };
  /** Test runs that passed and that failed. */
  tests?: { passed: number; failed: number };
  git?: { commits: number; pushes: number };
  /** Web pages fetched and searches made. */
  web?: number;
  /** Responses cut at max tokens, and requests the context window could not hold. */
  stops?: { maxTokens: number; contextFull: number };
  /** The main loop's tokens, and the model that spent them. */
  tokens?: Tokens;
  model?: string;
  /** The effort of the main loop's latest request: a level, or a number. */
  effort?: string;
  /** What the session's cost grew by over the turn, in dollars, as /cost counts it. */
  usd?: number;
  /** The context window after the turn: how full, of how many tokens. */
  context?: { percent: number; window: number };
  /** The rate-limit windows' use after the turn, in percent. */
  limits?: { fiveHour?: number; sevenDay?: number };
};

/** A running main turn's counts, from its start to its end. */
export type Tally = {
  turnId: string;
  /** When the turn began: its time when turn.complete carries none. */
  startedAt: number;
  gapMs?: number;
  requests: number;
  tools: Record<string, number>;
  failed: number;
  denied: number;
  commands: Set<string>;
  reruns: number;
  agentRuns: number;
  agentTools: number;
  agentTokens: number;
  read: Set<string>;
  edited: Set<string>;
  wrote: Set<string>;
  edits: Map<string, number>;
  added: number;
  removed: number;
  unmeasured: Set<string>;
  passed: number;
  failedTests: number;
  commits: number;
  pushes: number;
  web: number;
  maxTokens: number;
  contextFull: number;
};

/** The session's usage as the adapter reads it ($.session.usage()): the fields the numbers take. */
export type UsageReading = {
  context?: { tokens?: number; window?: number; percent?: number };
  rateLimits?: readonly { kind: string; percentUsed: number }[];
  cost?: { usd: number };
};

/**
 * The session's usage as read, checked at entry: its context, rate limits and
 * cost where each is well formed, a malformed one left out; null when it is
 * not an object at all.
 */
export function usageReadingOf(v: unknown): UsageReading | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const u = v as Record<string, unknown>;
  const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
  const field = (o: unknown, k: string): unknown => (typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[k] : undefined);
  const [tokens, window, percent] = [num(field(u.context, 'tokens')), num(field(u.context, 'window')), num(field(u.context, 'percent'))];
  const context = { ...(tokens === undefined ? {} : { tokens }), ...(window === undefined ? {} : { window }), ...(percent === undefined ? {} : { percent }) };
  const rateLimits = (Array.isArray(u.rateLimits) ? (u.rateLimits as unknown[]) : []).flatMap((l) => {
    const kind = field(l, 'kind');
    const used = num(field(l, 'percentUsed'));
    return typeof kind === 'string' && used !== undefined ? [{ kind, percentUsed: used }] : [];
  });
  const usd = num(field(u.cost, 'usd'));
  return { ...(Object.keys(context).length > 0 ? { context } : {}), rateLimits, ...(usd === undefined ? {} : { cost: { usd } }) };
}

/** A tool call as the tally reads it: the tool.call event's tool and arguments, flat, and how it went. */
export type CountedCall = {
  tool: string;
  args: Record<string, unknown>;
  failed: boolean;
  denied: boolean;
  /** The call's test outcome (reactions.ts classifyToolCall). */
  outcome: 'testPass' | 'testFail' | 'toolFail' | null;
  /** Made by the main loop, not a subagent. */
  main: boolean;
};

/** A new turn's tally: `now` and `lastEndAt` (the previous main turn's end, if any) make its gap. */
export function openTally(turnId: string, now: number, lastEndAt?: number): Tally {
  return {
    turnId,
    startedAt: now,
    ...(lastEndAt === undefined || now < lastEndAt ? {} : { gapMs: now - lastEndAt }),
    requests: 0,
    tools: {},
    failed: 0,
    denied: 0,
    commands: new Set(),
    reruns: 0,
    agentRuns: 0,
    agentTools: 0,
    agentTokens: 0,
    read: new Set(),
    edited: new Set(),
    wrote: new Set(),
    edits: new Map(),
    added: 0,
    removed: 0,
    unmeasured: new Set(),
    passed: 0,
    failedTests: 0,
    commits: 0,
    pushes: 0,
    web: 0,
    maxTokens: 0,
    contextFull: 0,
  };
}

/** One main-loop model request that ended with `stopReason` (turn.step's result; null when no response came). */
export function countStep(t: Tally, stopReason: string | null): void {
  t.requests++;
  if (stopReason === 'max_tokens') t.maxTokens++;
  if (stopReason === 'model_context_window_exceeded') t.contextFull++;
}

/** A subagent run that ended during the turn, with the tokens it spent. */
export function countAgentRun(t: Tally, usage?: Partial<ApiUsage>): void {
  t.agentRuns++;
  const u = tokensOf(usage);
  t.agentTokens += u.in + u.out + u.cacheRead + u.cacheWrite;
}

const WEB = /^(?:WebFetch|WebSearch)$|^mcp__.*(?:harvester|web|fetch|browser|playwright)/i;
/** A git commit or push where a command starts (never inside a quoted string), past git's own options (`-C dir`, `-c key=value`, `--no-pager`). */
const GIT = /(?:^|[;&|(\n])\s*(?:\w+=\S*\s+)*git(?:\s+-[Cc]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+(commit|push)\b/g;

/** One tool call, by the main loop or a subagent. */
export function countToolCall(t: Tally, c: CountedCall): void {
  if (c.main) {
    t.tools[c.tool] = (t.tools[c.tool] ?? 0) + 1;
    if (c.denied) t.denied++;
    else if (c.failed) t.failed++;
    const command = c.tool === 'Bash' ? text(c.args.command).replace(/\s+/g, ' ').trim() : '';
    if (command) {
      if (t.commands.has(command)) t.reruns++;
      else t.commands.add(command);
    }
  } else {
    t.agentTools++;
  }
  if (c.outcome === 'testPass') t.passed++;
  if (c.outcome === 'testFail') t.failedTests++;
  if (c.failed || c.denied) return;
  const file = text(c.args.file_path) || text(c.args.notebook_path);
  switch (c.tool) {
    case 'Read':
      if (file) t.read.add(file);
      break;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Write': {
      if (!file) break;
      (c.tool === 'Write' ? t.wrote : t.edited).add(file);
      t.edits.set(file, (t.edits.get(file) ?? 0) + 1);
      const d = changedLines(c.tool, c.args);
      t.added += d.added;
      t.removed += d.removed;
      break;
    }
    case 'Bash':
      for (const m of text(c.args.command).matchAll(GIT)) {
        if (m[1] === 'commit') t.commits++;
        else t.pushes++;
      }
      break;
  }
  if (WEB.test(c.tool)) t.web++;
}

/** The lines an edit or a write changed: an edit's old and new text, their shared first and last lines left out; a write's every line added. */
export function changedLines(tool: string, args: Record<string, unknown>): { added: number; removed: number } {
  if (tool === 'Write') return { added: lineCount(text(args.content)), removed: 0 };
  if (tool === 'NotebookEdit') return { added: lineCount(text(args.new_source)), removed: 0 };
  const pairs = tool === 'MultiEdit' && Array.isArray(args.edits) ? (args.edits as unknown[]) : [args];
  let added = 0;
  let removed = 0;
  for (const p of pairs) {
    if (typeof p !== 'object' || p === null) continue;
    const e = p as Record<string, unknown>;
    const d = lineDiff(text(e.old_string), text(e.new_string));
    added += d.added;
    removed += d.removed;
  }
  return { added, removed };
}

/** One file a shell command really changed: `made` when it did not exist before; its lines as fileLineDelta counts them, or `unmeasured` when its text was not read. */
export type ShellChange = { file: string; made: boolean; added: number; removed: number; unmeasured?: true };

/** A file as a tree sweep marks it: a change of its size or its modification time is a change. */
export type FileMark = { size: number; mtimeMs: number };

// A word that may be a file: letters, digits and `@~.+/_-` only (no glob, variable or flag), with a slash or an extension.
const PATH_WORD = /^[\w@~.+/-]+$/;
const pathLike = (w: string): boolean =>
  w.length >= 2 && w.length <= 300 && !w.startsWith('-') && PATH_WORD.test(w) && (w.includes('/') || /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(w));
// A folder the command moves into or points a tool at: `cd dir`, `-C dir`.
const INTO = /(?:(?:^|[;&|({\n])\s*cd|\s-C)\s+(?:'([^'\n]+)'|"([^"\n]+)"|([^\s;&|)]+))/g;
const QUOTED = /'([^'\n]*)'|"([^"\n]*)"/g;

/** `rel` from folder `base`, `.` and `..` resolved; an absolute `rel` stands alone. */
function joinPath(base: string, rel: string): string {
  const out: string[] = [];
  for (const p of (rel.startsWith('/') ? rel : `${base}/${rel}`).split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return `/${out.join('/')}`;
}

/** A word as a path from `base`: `~` is `home`; null for `~user` or a `~` with no home known. */
function resolveWord(w: string, base: string, home: string): string | null {
  if (w === '~' || w.startsWith('~/')) return home ? joinPath(home, w.slice(2)) : null;
  if (w.startsWith('~')) return null;
  return joinPath(base, w);
}

/**
 * The files a shell command may change, as it names them: each path-like word
 * or quoted string, from the session's folder `cwd` and from each folder the
 * command `cd`s into or points `-C` at; `~` is `home`. At most
 * SHELL_CANDIDATES_MAX, device files left out. Only measuring them tells which
 * changed (shellChanges).
 */
export function shellTargets(command: string, cwd: string, home: string): string[] {
  const bases = shellFolders(command, cwd, home);
  const words: string[] = [];
  for (const m of command.matchAll(QUOTED)) words.push(m[1] ?? m[2] ?? '');
  words.push(...command.replace(QUOTED, ' ').split(/[\s;&|()<>`=,]+/));
  const out: string[] = [];
  for (const w of words) {
    if (!pathLike(w)) continue;
    for (const base of w.startsWith('/') || w.startsWith('~') ? [cwd] : bases) {
      const f = resolveWord(w, base, home);
      if (f === null || f.startsWith('/dev/') || f.startsWith('/proc/') || out.includes(f)) continue;
      if (out.length === SHELL_CANDIDATES_MAX) return out;
      out.push(f);
    }
  }
  return out;
}

/** The folders a shell command works in: the session's folder `cwd`, then each it `cd`s into or points `-C` at; `~` is `home`. */
export function shellFolders(command: string, cwd: string, home: string): string[] {
  const bases = [cwd];
  for (const m of command.matchAll(INTO)) {
    const dir = resolveWord(m[1] ?? m[2] ?? m[3] ?? '', cwd, home);
    if (dir && !bases.includes(dir)) bases.push(dir);
  }
  return bases;
}

/** A file's text as lines, its last newline ending the last line. */
const fileLines = (s: string): string[] => (s === '' ? [] : (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n'));

/**
 * The lines a whole file changed, counted as git counts them: past the lines
 * both share at the start and the end, each line's count before against after,
 * so two edits far apart are two lines each way, never the span between.
 */
export function fileLineDelta(before: string, after: string): { added: number; removed: number } {
  const a = fileLines(before);
  const b = fileLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const net = new Map<string, number>();
  for (let i = head; i < a.length - tail; i++) net.set(a[i]!, (net.get(a[i]!) ?? 0) + 1);
  for (let i = head; i < b.length - tail; i++) net.set(b[i]!, (net.get(b[i]!) ?? 0) - 1);
  let added = 0;
  let removed = 0;
  for (const n of net.values()) {
    if (n > 0) removed += n;
    else added -= n;
  }
  return { added, removed };
}

/** The files a shell command changed: each measured before (`null` when absent) and after it ran; a file not measured after is left out. */
export function shellChanges(before: ReadonlyMap<string, string | null>, after: ReadonlyMap<string, string | null>): ShellChange[] {
  const out: ShellChange[] = [];
  for (const [file, was] of before) {
    if (!after.has(file)) continue;
    const now = after.get(file) ?? null;
    if (was === now) continue;
    out.push({ file, made: was === null, ...fileLineDelta(was ?? '', now ?? '') });
  }
  return out;
}

/**
 * The files two tree sweeps of the same folders tell apart: `changed` when its
 * size or modification time moved; `made` and `gone` only when both sweeps
 * were `whole` (no cap cut either short), since a file past a cap is missing
 * from one sweep without having come or gone.
 */
export function sweptChanges(before: ReadonlyMap<string, FileMark>, after: ReadonlyMap<string, FileMark>, whole: boolean): { file: string; kind: 'changed' | 'made' | 'gone' }[] {
  const out: { file: string; kind: 'changed' | 'made' | 'gone' }[] = [];
  for (const [file, was] of before) {
    const now = after.get(file);
    if (now === undefined) {
      if (whole) out.push({ file, kind: 'gone' });
    } else if (now.size !== was.size || now.mtimeMs !== was.mtimeMs) out.push({ file, kind: 'changed' });
  }
  if (whole) for (const file of after.keys()) if (!before.has(file)) out.push({ file, kind: 'made' });
  return out;
}

/**
 * A swept change as a ShellChange: `was` and `now` the file's text before and
 * after (`null` absent, `undefined` not read). Its lines count when both sides
 * are known, and a touch that left the text as it was is no change (null);
 * with a side unknown the file still counts, its lines `unmeasured`.
 */
export function sweptShellChange(file: string, kind: 'changed' | 'made' | 'gone', was: string | null | undefined, now: string | null | undefined): ShellChange | null {
  const made = kind === 'made';
  const before = made ? '' : was;
  const after = kind === 'gone' ? '' : now;
  if (typeof before !== 'string' || typeof after !== 'string') return { file, made, added: 0, removed: 0, unmeasured: true };
  if (kind === 'changed' && before === after) return null;
  return { file, made, ...fileLineDelta(before, after) };
}

/** A shell command's changes into the tally: a file made is written, one changed or deleted edited, each an edit of that file, its lines counted or kept as unmeasured. */
export function countShellChanges(t: Tally, changes: readonly ShellChange[]): void {
  for (const c of changes) {
    (c.made ? t.wrote : t.edited).add(c.file);
    t.edits.set(c.file, (t.edits.get(c.file) ?? 0) + 1);
    t.added += c.added;
    t.removed += c.removed;
    if (c.unmeasured) t.unmeasured.add(c.file);
  }
}

/** `before` replaced by `after`, as whole lines: the lines they share at the start and the end are unchanged. */
function lineDiff(before: string, after: string): { added: number; removed: number } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { added: b.length - head - tail, removed: a.length - head - tail };
}

function lineCount(s: string): number {
  const t = s.endsWith('\n') ? s.slice(0, -1) : s;
  return t === '' ? 0 : t.split('\n').length;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Usage as the API reports it. */
type ApiUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };

function tokensOf(u?: Partial<ApiUsage>): Tokens {
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return { in: n(u?.input_tokens), out: n(u?.output_tokens), cacheRead: n(u?.cache_read_input_tokens), cacheWrite: n(u?.cache_creation_input_tokens) };
}

/**
 * The turn's numbers: the tally, and from its end `ms`, the main loop's
 * `usage` (turn.complete's, with its model) and `effort`; `before` and
 * `after` the session's usage at its start and end (null when not read):
 * the cost between them, the context and the limits after.
 */
export function closeTally(
  t: Tally,
  end: { ms: number; usage?: Partial<ApiUsage> & { model?: string }; effort?: string | number },
  before: UsageReading | null,
  after: UsageReading | null,
): TurnStats {
  const tokens = tokensOf(end.usage);
  const hot = [...t.edits].sort((x, y) => y[1] - x[1])[0];
  const usd = typeof before?.cost?.usd === 'number' && typeof after?.cost?.usd === 'number' ? after.cost.usd - before.cost.usd : undefined;
  const ctx = after?.context;
  const percent = typeof ctx?.percent === 'number' ? ctx.percent : typeof ctx?.tokens === 'number' && typeof ctx.window === 'number' && ctx.window > 0 ? (100 * ctx.tokens) / ctx.window : undefined;
  const limit = (kind: string): number | undefined => after?.rateLimits?.find((l) => l.kind === kind)?.percentUsed;
  const fiveHour = limit('five_hour');
  const sevenDay = limit('seven_day');
  const some = (...ns: number[]): boolean => ns.some((n) => n > 0);
  return {
    ms: Number.isFinite(end.ms) ? Math.max(0, Math.round(end.ms)) : 0,
    ...(t.gapMs === undefined ? {} : { gapMs: t.gapMs }),
    ...(t.requests > 0 ? { requests: t.requests } : {}),
    ...(Object.keys(t.tools).length > 0 ? { tools: { ...t.tools } } : {}),
    ...(t.failed > 0 ? { failed: t.failed } : {}),
    ...(t.denied > 0 ? { denied: t.denied } : {}),
    ...(t.reruns > 0 ? { reruns: t.reruns } : {}),
    ...(some(t.agentRuns, t.agentTools) ? { agents: { runs: t.agentRuns, tools: t.agentTools, tokens: t.agentTokens } } : {}),
    ...(some(t.read.size, t.edited.size, t.wrote.size) ? { files: { read: t.read.size, edited: t.edited.size, wrote: t.wrote.size } } : {}),
    ...(hot && hot[1] >= HOT_EDITS ? { hot: { file: hot[0].replace(/\/+$/, '').split('/').pop() ?? hot[0], edits: hot[1] } } : {}),
    ...(some(t.added, t.removed, t.unmeasured.size) ? { lines: { added: t.added, removed: t.removed, ...(t.unmeasured.size > 0 ? { unmeasured: t.unmeasured.size } : {}) } } : {}),
    ...(some(t.passed, t.failedTests) ? { tests: { passed: t.passed, failed: t.failedTests } } : {}),
    ...(some(t.commits, t.pushes) ? { git: { commits: t.commits, pushes: t.pushes } } : {}),
    ...(t.web > 0 ? { web: t.web } : {}),
    ...(some(t.maxTokens, t.contextFull) ? { stops: { maxTokens: t.maxTokens, contextFull: t.contextFull } } : {}),
    ...(some(tokens.in, tokens.out, tokens.cacheRead, tokens.cacheWrite) ? { tokens } : {}),
    ...(end.usage?.model ? { model: end.usage.model } : {}),
    ...(end.effort === undefined ? {} : { effort: String(end.effort) }),
    ...(usd !== undefined && usd >= 0 ? { usd } : {}),
    ...(percent !== undefined && typeof ctx?.window === 'number' ? { context: { percent: Math.round(percent), window: ctx.window } } : {}),
    ...(fiveHour !== undefined || sevenDay !== undefined ? { limits: { ...(fiveHour === undefined ? {} : { fiveHour }), ...(sevenDay === undefined ? {} : { sevenDay }) } } : {}),
  };
}

/** A count, short: 950, 1.2k, 34k, 1.2M; each step up where rounding would reach the next. */
export function count(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 9_950) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** A span, short: 12s, 2m14s, 1h04m. */
export function span(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** Dollars, short: <$0.01, $0.42, $12.30, $123. */
export function dollars(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  return usd < 100 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${count(n)} ${n === 1 ? one : many}`;
/** A model id without its vendor prefix: claude-opus-5 is opus-5. */
const modelName = (m: string): string => m.replace(/^claude-/, '');
/** A tool by its own name, an MCP tool's server dropped: mcp__professor__chat_new is chat_new. */
const toolName = (t: string): string => (t.startsWith('mcp__') ? t.split('__').slice(2).join('__') || t : t);

/**
 * The turn's numbers as one line for the model; `prev`, the turn remembered
 * before it: its model and effort are said again only when they changed, and
 * only for a turn that made a model request.
 */
export function renderStats(s: TurnStats, prev?: TurnStats): string {
  const parts: string[] = [];
  parts.push(s.gapMs === undefined ? span(s.ms) : `${span(s.ms)}, after a ${span(s.gapMs)} pause`);
  if (s.requests) parts.push(plural(s.requests, 'model request'));
  if (s.tools) {
    const byUse = Object.entries(s.tools).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const total = byUse.reduce((n, [, k]) => n + k, 0);
    const named = byUse.slice(0, TOOL_NAMES_MAX).map(([name, k]) => `${toolName(name)} ${k}`);
    if (byUse.length > TOOL_NAMES_MAX) named.push(plural(byUse.length - TOOL_NAMES_MAX, 'more kind'));
    const trouble = [s.failed ? `${s.failed} failed` : '', s.denied ? `${s.denied} denied` : '', s.reruns ? `${plural(s.reruns, 'shell command')} run again unchanged` : ''].filter(Boolean);
    parts.push([`${plural(total, 'tool call')} (${named.join(', ')})`, ...trouble].join(', '));
  }
  if (s.agents) {
    // Runs still going when the turn ended show only their calls so far.
    const spent = [s.agents.tools ? plural(s.agents.tools, 'tool call') : '', s.agents.tokens ? `${count(s.agents.tokens)} tokens` : ''].filter(Boolean).join(', ');
    parts.push(`${s.agents.runs ? plural(s.agents.runs, 'subagent run') : 'subagents'}${spent ? `: ${spent}` : ''}`);
  }
  if (s.files) {
    const f = [s.files.read ? `${count(s.files.read)} read` : '', s.files.edited ? `${count(s.files.edited)} edited` : '', s.files.wrote ? `${count(s.files.wrote)} written` : ''].filter(Boolean);
    parts.push(`files ${f.join(', ')}${s.hot ? `; ${s.hot.file} edited ${s.hot.edits}×` : ''}`);
  }
  if (s.lines) {
    const unmeasured = s.lines.unmeasured ? `unmeasured in ${plural(s.lines.unmeasured, 'file')}` : '';
    parts.push(unmeasured && !s.lines.added && !s.lines.removed ? `lines ${unmeasured}` : `lines +${count(s.lines.added)} −${count(s.lines.removed)}${unmeasured ? `, ${unmeasured}` : ''}`);
  }
  if (s.tests) parts.push(`test runs ${[s.tests.passed ? `${s.tests.passed} passed` : '', s.tests.failed ? `${s.tests.failed} failed` : ''].filter(Boolean).join(', ')}`);
  if (s.git) parts.push([s.git.commits ? plural(s.git.commits, 'commit') : '', s.git.pushes ? plural(s.git.pushes, 'push', 'pushes') : ''].filter(Boolean).join(', '));
  if (s.web) parts.push(`${plural(s.web, 'web read')}`);
  if (s.stops) parts.push([s.stops.maxTokens ? `cut at max tokens ${s.stops.maxTokens}×` : '', s.stops.contextFull ? `context window full ${s.stops.contextFull}×` : ''].filter(Boolean).join(', '));
  if (s.tokens) {
    const input = s.tokens.in + s.tokens.cacheRead + s.tokens.cacheWrite;
    const cached = input > 0 ? Math.round((100 * s.tokens.cacheRead) / input) : 0;
    parts.push(`tokens ${count(input)} in (${cached}% cached), ${count(s.tokens.out)} out`);
  }
  if (s.usd !== undefined) parts.push(dollars(s.usd));
  if (s.context) parts.push(`context ${s.context.percent}% full of ${count(s.context.window)}`);
  const limits = [s.limits?.fiveHour !== undefined && s.limits.fiveHour >= LIMIT_SAID_PERCENT ? `5-hour limit ${Math.round(s.limits.fiveHour)}% used` : '', s.limits?.sevenDay !== undefined && s.limits.sevenDay >= LIMIT_SAID_PERCENT ? `weekly limit ${Math.round(s.limits.sevenDay)}% used` : ''].filter(Boolean);
  if (limits.length > 0) parts.push(limits.join(', '));
  const runsOn = [s.model ? modelName(s.model) : '', s.effort ? `${s.effort} effort` : ''].filter(Boolean).join(' at ');
  // Said for a turn that asked a model anything, and only when it changed.
  if (runsOn && s.requests && (prev?.model !== s.model || prev?.effort !== s.effort)) parts.push(`on ${runsOn}`);
  return `Numbers: ${parts.join(' · ')}`;
}

/** The turn's numbers for the drawer's row of it: its time, its tool calls, its cost or else its tokens. */
export function statsBrief(s: TurnStats): string {
  const tools = Object.values(s.tools ?? {}).reduce((n, k) => n + k, 0) + (s.agents?.tools ?? 0);
  const spent = s.usd !== undefined ? dollars(s.usd) : s.tokens ? `${count(s.tokens.in + s.tokens.cacheRead + s.tokens.cacheWrite + s.tokens.out)} tokens` : '';
  return [span(s.ms), tools > 0 ? plural(tools, 'tool') : '', spent].filter(Boolean).join(' · ');
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
/** An object whose every key in `keys` is a count; `optional` ones may be absent. */
function counts(v: unknown, keys: readonly string[], optional = false): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return keys.every((k) => (optional && o[k] === undefined) || isCount(o[k]));
}

/** Stored numbers, checked field by field; null when any field is malformed. */
export function turnStatsOf(v: unknown): TurnStats | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const s = v as Record<string, unknown>;
  if (!isCount(s.ms)) return null;
  const ok =
    [s.gapMs, s.requests, s.failed, s.denied, s.reruns, s.web, s.usd].every((n) => n === undefined || isCount(n)) &&
    (s.tools === undefined || (counts(s.tools, Object.keys(s.tools as object)) && Object.keys(s.tools as object).length > 0)) &&
    (s.agents === undefined || counts(s.agents, ['runs', 'tools', 'tokens'])) &&
    (s.files === undefined || counts(s.files, ['read', 'edited', 'wrote'])) &&
    (s.hot === undefined || (typeof (s.hot as { file?: unknown }).file === 'string' && counts(s.hot, ['edits']))) &&
    (s.lines === undefined || (counts(s.lines, ['added', 'removed']) && counts(s.lines, ['unmeasured'], true))) &&
    (s.tests === undefined || counts(s.tests, ['passed', 'failed'])) &&
    (s.git === undefined || counts(s.git, ['commits', 'pushes'])) &&
    (s.stops === undefined || counts(s.stops, ['maxTokens', 'contextFull'])) &&
    (s.tokens === undefined || counts(s.tokens, ['in', 'out', 'cacheRead', 'cacheWrite'])) &&
    (s.model === undefined || typeof s.model === 'string') &&
    (s.effort === undefined || typeof s.effort === 'string') &&
    (s.context === undefined || counts(s.context, ['percent', 'window'])) &&
    (s.limits === undefined || counts(s.limits, ['fiveHour', 'sevenDay'], true));
  return ok ? (s as TurnStats) : null;
}
