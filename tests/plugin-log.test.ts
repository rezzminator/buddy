import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';
import { APPEND_SCRIPT, PLUGIN_LOG_CAP_BYTES, ROW_MAX_BYTES, PluginLogQueue, appendArgv, eventId, failureEvent, infoEvent, levelRow, pluginLogDetail, pluginLogDir, type LevelFields, type Run } from '../plugins/buddy/src/plugin-log.ts';

const exec = promisify(execFile);
const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-plugin-log-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const now = 1791991231123;
const fields: LevelFields = { plugin: 'buddy', level: 'error', event: 'writing-memory-failed', msg: 'writing memory.md failed: denied', where: 'hooks/buddy.tsx#writeMemoryText', session: 's1', detail: { error: 'denied' } };
const row = (level: LevelFields['level'] = 'error') => levelRow({ ...fields, level }, now);
const run: Run = async (argv) => {
  try {
    const result = await exec('/bin/sh', argv.slice(1));
    return { exitCode: 0, ...result };
  } catch (error) {
    const result = error as Error & { code: number; stdout: string; stderr: string };
    return { exitCode: typeof result.code === 'number' ? result.code : 1, stdout: result.stdout ?? '', stderr: result.stderr || result.message };
  }
};
const lines = async (file: string): Promise<Record<string, any>[]> => (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

describe('plugin log row contract', () => {
  test.each([
    ['known session', fields, ['ts', 'plugin', 'level', 'event', 'msg', 'where', 'session', 'detail']],
    ['unknown session', { ...fields, session: undefined }, ['ts', 'plugin', 'level', 'event', 'msg', 'where', 'detail']],
  ] as const)('%s preserves exact keys and timestamp', (_name, input, keys) => {
    const text = levelRow(input, now);
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed)).toEqual(keys);
    expect(parsed).toEqual({ ts: '2026-10-14T15:20:31.123Z', ...input, ...(input.session === undefined ? {} : { session: 's1' }) });
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n')).toHaveLength(2);
  });
  test.each(['x'.repeat(10000), '😀'.repeat(4000), '\u0000"\\\n'.repeat(2000)])('caps encoded rows with explicit truncation', (msg) => {
    const original = { ...fields, msg, detail: { error: 'e'.repeat(10000) } };
    const bytes = Buffer.byteLength(`${JSON.stringify({ ts: new Date(now).toISOString(), ...original })}\n`);
    const text = levelRow(original, now);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(ROW_MAX_BYTES);
    const parsed = JSON.parse(text);
    expect(parsed.detail).toEqual({ truncated: true, bytes });
    expect(parsed.msg.length).toBeGreaterThan(0);
    expect(msg.startsWith(parsed.msg)).toBe(true);
  });
  test.each([
    ['option.warning', 'option-warning'], ['promptToMainChat.dropped', 'prompt-to-main-chat-dropped'],
    ['writing memory.md', 'writing-memory-md'], ['session-id-unreadable', 'session-id-unreadable'],
  ])('eventId normalizes %s', (input, expected) => expect(eventId(input)).toBe(expected));
  test.each([
    ['writing memory.md', 'writing-memory-failed'], ['drawing the band', 'drawing-the-band-failed'],
  ])('failure event for %s', (what, expected) => expect(failureEvent(what)).toBe(expected));
  test('only approved scalar diagnostic details cross the adapter', () => {
    expect(pluginLogDetail({ id: 'duck', count: 2, file: '/f', error: 'denied', outcome: 'refused', prompt: 'private prompt', text: 'private answer', toolInput: { body: 'private' }, env: { SECRET: 'private' }, reason: { body: 'private' }, length: 10 })).toEqual({ id: 'duck', count: 2, file: '/f', error: 'denied', outcome: 'refused', length: 10 });
  });
  test.each([
    ['character.switch', {}, true], ['promptToMainChat.dropped', {}, true], ['drawer.open', {}, true],
    ['ask.outcome', { outcome: 'refused' }, true], ['roster.load', {}, false], ['turn.numbers', {}, false],
    ['memory.op', {}, false], ['call.cost', {}, false], ['session.start', {}, false],
  ] as const)('info policy for %s', (event, detail, expected) => expect(infoEvent(event, detail)).toBe(expected));
  test('caps even hostile oversized identifiers with escaped bytes', () => {
    const text = levelRow({ ...fields, plugin: '\u0000'.repeat(10000), event: '\u0000'.repeat(10000), where: '\u0000'.repeat(10000), session: '\u0000'.repeat(10000), msg: 'message' }, now);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
    expect(JSON.parse(text).detail.truncated).toBe(true);
  });
  test.each([
    ['/x/logs', '/h/u', '/x/logs/buddy'], [undefined, '/h/u', '/h/u/.local/state/buddy/logs'],
    [undefined, undefined, undefined], ['', '/h/u', '/h/u/.local/state/buddy/logs'],
  ])('resolves directory %s / %s', (dir, home, expected) => expect(pluginLogDir(dir, home, 'buddy')).toBe(expected));
});

describe('real append script', () => {
  test('writes one row to each level with private modes and no shell interpolation', async () => {
    const dir = join(await temp(), 'a "quoted" $directory');
    const rows = ['error', 'warning', 'info'].map((level) => row(level as LevelFields['level']));
    for (const argv of appendArgv(dir, 'buddy', rows)) expect((await run(argv)).exitCode).toBe(0);
    for (const [file, level] of [['errors', 'error'], ['warnings', 'warning'], ['info', 'info']]) {
      expect(await lines(join(dir, `${file}.jsonl`))).toEqual([{ ts: new Date(now).toISOString(), ...fields, level }]);
      expect((await stat(join(dir, `${file}.jsonl`))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });
  test('moves a capped file aside and records a log-capped warning', async () => {
    const dir = await temp();
    await writeFile(join(dir, 'errors.jsonl'), 'x'.repeat(PLUGIN_LOG_CAP_BYTES + 1));
    await writeFile(join(dir, 'errors.jsonl.1'), 'older');
    const [argv] = appendArgv(dir, 'buddy', [row()]);
    expect((await run(argv!)).exitCode).toBe(0);
    expect((await stat(join(dir, 'errors.jsonl.1'))).size).toBe(20971521);
    expect(await lines(join(dir, 'errors.jsonl'))).toEqual([{ ts: new Date(now).toISOString(), ...fields }]);
    const [warning] = await lines(join(dir, 'warnings.jsonl'));
    expect(warning).toMatchObject({ plugin: 'buddy', level: 'warning', event: 'log-capped', where: 'src/plugin-log.ts#APPEND_SCRIPT', detail: { file: 'errors.jsonl', bytes: 20971521 } });
  });
  test.each(['known', 'quote"\\\n😀', '', undefined, 's'.repeat(3800)])('cap notices preserve session %s and remain bounded', async (session) => {
    const dir = await temp();
    await writeFile(join(dir, 'errors.jsonl'), 'x'.repeat(PLUGIN_LOG_CAP_BYTES + 1));
    const input = levelRow({ ...fields, session, msg: '' }, now);
    expect(Buffer.byteLength(input)).toBeLessThanOrEqual(ROW_MAX_BYTES);
    for (const argv of appendArgv(dir, 'buddy', [input])) expect((await run(argv)).exitCode).toBe(0);
    const text = await readFile(join(dir, 'warnings.jsonl'), 'utf8');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(ROW_MAX_BYTES);
    const [notice] = await lines(join(dir, 'warnings.jsonl'));
    expect(notice!.event).toBe('log-capped');
    expect(notice!.session).toBe(session);
    expect(Object.keys(notice!)).toEqual(['ts', 'plugin', 'level', 'event', 'msg', 'where', ...(session !== undefined ? ['session'] : []), 'detail']);
  });
  test.each(['s', '😀', '\u0000"\\'])('bounds a cap notice for an already-valid boundary row with %s session bytes', async (unit) => {
    const dir = await temp();
    await writeFile(join(dir, 'errors.jsonl'), 'x'.repeat(PLUGIN_LOG_CAP_BYTES + 1));
    const base = { plugin: 'buddy', level: 'error' as const, event: 'e', msg: '', where: 'w', detail: {} };
    let session = '';
    while (Buffer.byteLength(levelRow({ ...base, session: session + unit }, now)) < ROW_MAX_BYTES && !JSON.parse(levelRow({ ...base, session: session + unit }, now)).detail.truncated) session += unit;
    const input = levelRow({ ...base, session }, now);
    expect(Buffer.byteLength(input)).toBeGreaterThan(4000);
    expect(JSON.parse(input).session).toBe(session);
    const result = await run(appendArgv(dir, 'buddy', [input])[0]!);
    expect(result.exitCode).toBe(0);
    const text = await readFile(join(dir, 'warnings.jsonl'), 'utf8');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(ROW_MAX_BYTES);
    const notice = JSON.parse(text);
    expect(notice.event).toBe('log-capped');
    expect(notice.detail.truncated).toBe(true);
    expect(notice.detail.bytes).toBeGreaterThan(ROW_MAX_BYTES);
    expect(notice.session.length).toBeGreaterThan(0);
    expect(session.startsWith(notice.session)).toBe(true);
    expect(notice.session.endsWith('\ud83d')).toBe(false);
  });
  test('each cap notice independently marks truncation of the same boundary session', async () => {
    const dir = await temp();
    for (const file of ['warnings.jsonl', 'errors.jsonl']) await writeFile(join(dir, file), 'x'.repeat(PLUGIN_LOG_CAP_BYTES + 1));
    const session = 's'.repeat(3950);
    const input = levelRow({ plugin: 'buddy', level: 'error', event: 'e', msg: '', where: 'w', session }, now);
    expect(JSON.parse(input).session).toBe(session);
    expect((await run(appendArgv(dir, 'buddy', [input])[0]!)).exitCode).toBe(0);
    const notices = await lines(join(dir, 'warnings.jsonl'));
    expect(notices).toHaveLength(2);
    for (const notice of notices) {
      expect(notice.detail.truncated).toBe(true);
      expect(notice.detail.bytes).toBeGreaterThan(4096);
      expect(session.startsWith(notice.session)).toBe(true);
    }
  });
  test('does not read fake session keys from message or detail as the notice session', async () => {
    const dir = await temp();
    await writeFile(join(dir, 'errors.jsonl'), 'x'.repeat(PLUGIN_LOG_CAP_BYTES + 1));
    const input = levelRow({ ...fields, session: undefined, msg: ',"session":"message-fake"', detail: { count: 1, session: 'detail-fake' } }, now);
    expect((await run(appendArgv(dir, 'buddy', [input])[0]!)).exitCode).toBe(0);
    expect((await lines(join(dir, 'warnings.jsonl')))[0]!.session).toBeUndefined();
  });
  test('recaps warnings before each cap notice append', async () => {
    const dir = await temp();
    // Scale only the rotation threshold, not the production cap-notice encoder.
    const cap = 64;
    for (const file of ['warnings.jsonl', 'errors.jsonl']) await writeFile(join(dir, file), 'x'.repeat(cap + 1));
    const argv = appendArgv(dir, 'buddy', [row()])[0]!;
    argv[2] = APPEND_SCRIPT.replaceAll(String(PLUGIN_LOG_CAP_BYTES), String(cap));
    expect((await run(argv)).exitCode).toBe(0);
    // The first notice itself exceeds this scaled cap; the second must move it aside first.
    expect((await lines(join(dir, 'warnings.jsonl.1')))[0]!.detail.file).toBe('warnings.jsonl');
    expect((await lines(join(dir, 'warnings.jsonl'))).at(-1)!.detail.file).toBe('errors.jsonl');
  });
  test('reports an invalid directory path as a failed write', async () => {
    const file = join(await temp(), 'not-a-directory');
    await writeFile(file, 'occupied');
    const [argv] = appendArgv(file, 'buddy', [row()]);
    const result = await run(argv!);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(file);
    expect(await readFile(file, 'utf8')).toBe('occupied');
  });
  test.skipIf(process.getuid?.() === 0)('skip-because:superuser — rejects an unwritable directory', async () => {
    const dir = await temp();
    await chmod(dir, 0o500);
    try {
      const [argv] = appendArgv(dir, 'buddy', [row()]);
      const result = await run(argv!);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(dir);
    } finally { await chmod(dir, 0o700); }
  });
  test('concurrent writers retain complete rows', async () => {
    const dir = await temp();
    const rows = Array.from({ length: 100 }, (_, index) => levelRow({ ...fields, detail: { index } }, now));
    await Promise.all([0, 1].map(async () => { for (const argv of appendArgv(dir, 'buddy', rows)) expect((await run(argv)).exitCode).toBe(0); }));
    const output = await lines(join(dir, 'errors.jsonl'));
    expect(output).toHaveLength(200);
    for (let index = 0; index < 100; index++) expect(output.filter((line) => line.detail.index === index)).toHaveLength(2);
  });
  test('exports the shell script and batches at most 64 pairs', () => {
    const batches = appendArgv('/x', 'buddy', Array.from({ length: 129 }, () => row()));
    expect(batches.map((argv) => (argv.length - 6) / 2)).toEqual([64, 64, 1]);
    expect(batches[0]!.slice(0, 6)).toEqual(['/bin/sh', '-c', APPEND_SCRIPT, 'plugin-log', '/x', 'buddy']);
  });
});

describe('plugin log queue', () => {
  test('does not run for an empty queue and serializes concurrent flushes', async () => {
    const dir = await temp();
    const queue = new PluginLogQueue(dir, 'buddy');
    let active = 0;
    let max = 0;
    let calls = 0;
    const counted: Run = async (argv) => {
      active++; max = Math.max(max, active); calls++;
      const result = await run(argv);
      active--;
      return result;
    };
    await queue.flush(counted);
    expect(calls).toBe(0);
    queue.add(row());
    const first = queue.flush(counted);
    queue.add(row('warning'));
    const second = queue.flush(counted);
    await Promise.all([first, second]);
    expect(max).toBe(1);
    expect(calls).toBe(2);
    expect(await lines(join(dir, 'errors.jsonl'))).toHaveLength(1);
    expect(await lines(join(dir, 'warnings.jsonl'))).toHaveLength(1);
  });
  test('fallback fires once per failed streak, names dropped rows, and rearms on success', async () => {
    const dir = await temp();
    const queue = new PluginLogQueue(dir, 'buddy');
    const notices: string[] = [];
    const fail: Run = async () => { throw new Error('cannot start'); };
    for (let i = 0; i < 2; i++) { queue.add(row()); await queue.flush(fail, (line) => notices.push(line)); }
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(dir);
    expect(notices[0]).toContain('cannot start');
    expect(notices[0]).toContain('1 row');
    queue.add(row('info')); await queue.flush(run, (line) => notices.push(line));
    queue.add(row()); await queue.flush(async () => ({ exitCode: 1, stdout: '', stderr: 'disk full\nmore' }), (line) => notices.push(line));
    expect(notices).toHaveLength(2);
    expect(notices[1]).toContain('disk full');
    expect(await lines(join(dir, 'info.jsonl'))).toHaveLength(1);
  });
  test('a missing process capability reported by the adapter remains an unavailable notice', async () => {
    const queue = new PluginLogQueue('/logs', 'buddy');
    const notices: string[] = [];
    queue.add(row());
    await queue.flush(async () => { throw new Error('process.run unavailable; fs.write replaces whole files and cannot provide append/private modes/.1 rename'); }, (line) => notices.push(line));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('/logs unavailable: process.run unavailable');
  });
  test.each([undefined, '/logs'])('missing directory or process is visible and never rejects', async (dir) => {
    const queue = new PluginLogQueue(dir, 'buddy');
    const notices: string[] = [];
    queue.add(row());
    await queue.flush(undefined, (line) => notices.push(line));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(dir ? 'process.run unavailable' : 'plugin log off: no PLUGIN_LOG_DIR and no HOME');
    if (dir) {
      expect(notices[0]).toContain('unavailable:');
      expect(notices[0]).toContain('fs.write replaces whole files');
      expect(notices[0]).toContain('append/private modes/.1 rename');
    }
  });
});
