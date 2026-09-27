import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../plugins/buddy/hooks/function-hooks-check.sh', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'buddy-hooks-check-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A fresh HOME, with `claudeJson` as its `.claude.json` when given. */
function home(claudeJson?: string): string {
  const dir = join(root, `home${n++}`);
  mkdirSync(dir);
  if (claudeJson !== undefined) writeFileSync(join(dir, '.claude.json'), claudeJson);
  return dir;
}

/** Runs the hook with only PATH, HOME and `env`: never the caller's own flag or account. */
function run(env: Record<string, string>, claudeJson?: string): { stdout: string; status: number | null } {
  const r = spawnSync('sh', [SCRIPT], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home(claudeJson), ...env }, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { stdout: r.stdout, status: r.status };
}

/** The systemMessage the hook printed, or a failure naming what it printed instead. */
function message(stdout: string): string {
  const lines = stdout.split('\n').filter(Boolean);
  expect(lines).toHaveLength(1);
  const parsed = JSON.parse(lines[0]!) as { systemMessage?: unknown };
  expect(Object.keys(parsed)).toEqual(['systemMessage']);
  expect(typeof parsed.systemMessage).toBe('string');
  return parsed.systemMessage as string;
}

const ROLLOUT_ON = '{\n  "cachedGrowthBookFeatures": {\n    "tengu_plugin_hooks_modules": true\n  }\n}\n';

describe('function-hooks-check.sh', () => {
  test.each(['1', 'true', ' YES ', 'On'])('the variable on (%j): nothing printed', (value) => {
    expect(run({ CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: value })).toEqual({ stdout: '', status: 0 });
  });

  test('unset, with no rollout flag: one systemMessage naming the variable and ~/.claude/settings.json', () => {
    const r = run({});
    expect(r.status).toBe(0);
    const m = message(r.stdout);
    expect(m).toMatch(/^buddy is off: Claude Code loads its function hooks only with CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1\./);
    expect(m).toContain('Add "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } to ~/.claude/settings.json, then start a new session.');
  });

  test.each(['0', 'false', 'off', 'no'])('falsy (%j): the systemMessage, even with the rollout flag on', (value) => {
    expect(message(run({ CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: value }, ROLLOUT_ON).stdout)).toContain('CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1');
  });

  test.each([
    ['pretty-printed', ROLLOUT_ON],
    ['minified', '{"cachedGrowthBookFeatures":{"tengu_plugin_hooks_modules":true}}'],
  ])('unset or empty, the cached rollout flag on (%s): nothing printed', (_shape, json) => {
    expect(run({}, json)).toEqual({ stdout: '', status: 0 });
    expect(run({ CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '' }, json)).toEqual({ stdout: '', status: 0 });
  });

  test('unset, the cached rollout flag off: the systemMessage', () => {
    expect(message(run({}, '{"cachedGrowthBookFeatures":{"tengu_plugin_hooks_modules":false}}').stdout)).toContain('CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1');
  });

  test('CLAUDE_CONFIG_DIR: the rollout flag read there, not in HOME, and its settings.json named, JSON-escaped', () => {
    const config = join(root, 'config');
    mkdirSync(config);
    writeFileSync(join(config, '.claude.json'), ROLLOUT_ON);
    expect(run({ CLAUDE_CONFIG_DIR: config })).toEqual({ stdout: '', status: 0 });
    const odd = 'C:\\Users\\a "b"\\.claude';
    const m = message(run({ CLAUDE_CONFIG_DIR: odd }, ROLLOUT_ON).stdout);
    expect(m).toContain(`to ${odd}/settings.json, then`);
  });
});
