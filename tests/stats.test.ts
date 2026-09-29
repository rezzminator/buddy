import { describe, expect, test } from 'vitest';
import {
  HOT_EDITS, LIMIT_SAID_PERCENT, TOOL_NAMES_MAX,
  SHELL_CANDIDATES_MAX,
  changedLines, closeTally, count, countAgentRun, countShellChanges, countStep, countToolCall, dollars, fileLineDelta, openTally, renderStats, shellChanges, shellFolders, shellTargets, span, statsBrief, sweptChanges, sweptShellChange, turnStatsOf,
  type CountedCall, type TurnStats,
} from '../plugins/buddy/src/stats.ts';

const call = (tool: string, args: Record<string, unknown> = {}, more: Partial<CountedCall> = {}): CountedCall => ({ tool, args, failed: false, denied: false, outcome: null, main: true, ...more });
const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite });

describe('the tally', () => {
  test('a turn with nothing counted is its time alone; its gap is from the turn before', () => {
    expect(closeTally(openTally('t1', 1_000), { ms: 1234.4 }, null, null)).toEqual({ ms: 1234 });
    expect(closeTally(openTally('t2', 5_000, 2_000), { ms: 10 }, null, null)).toEqual({ ms: 10, gapMs: 3_000 });
    // A clock that went back gives no gap; a time that is not a number is 0.
    expect(closeTally(openTally('t3', 1_000, 2_000), { ms: Number.NaN }, null, null)).toEqual({ ms: 0 });
  });

  test("the main loop's calls by tool, failed and denied apart, a shell command run again unchanged counted", () => {
    const t = openTally('t', 0);
    countToolCall(t, call('Bash', { command: 'npm  test' }));
    countToolCall(t, call('Bash', { command: 'npm test' }, { failed: true }));
    countToolCall(t, call('Bash', { command: 'ls' }, { denied: true }));
    countToolCall(t, call('Read', { file_path: '/r/a.ts' }));
    countToolCall(t, call('Grep', { pattern: 'x' }, { main: false }));
    const s = closeTally(t, { ms: 0 }, null, null);
    expect(s).toMatchObject({ tools: { Bash: 3, Read: 1 }, failed: 1, denied: 1, reruns: 1, agents: { runs: 0, tools: 1, tokens: 0 }, files: { read: 1, edited: 0, wrote: 0 } });
  });

  test('files are counted once each; the file edited HOT_EDITS times is the hot one; a failed call touches nothing', () => {
    const t = openTally('t', 0);
    for (let i = 0; i < HOT_EDITS; i++) countToolCall(t, call('Edit', { file_path: '/r/src/buddy.tsx', old_string: `a${i}`, new_string: `b${i}` }));
    countToolCall(t, call('MultiEdit', { file_path: '/r/src/x.ts', edits: [{ old_string: 'a', new_string: 'b\nc' }, { old_string: 'd\ne', new_string: '' }] }));
    countToolCall(t, call('Write', { file_path: '/r/new.md', content: 'one\ntwo\n' }));
    countToolCall(t, call('Read', { file_path: '/r/src/x.ts' }));
    countToolCall(t, call('Read', { file_path: '/r/src/x.ts' }));
    countToolCall(t, call('Edit', { file_path: '/r/failed.ts', old_string: 'a', new_string: 'b' }, { failed: true }));
    // A subagent's edit is the turn's work too.
    countToolCall(t, call('NotebookEdit', { notebook_path: '/r/n.ipynb', new_source: 'x' }, { main: false }));
    const s = closeTally(t, { ms: 0 }, null, null);
    expect(s.files).toEqual({ read: 1, edited: 3, wrote: 1 });
    expect(s.hot).toEqual({ file: 'buddy.tsx', edits: HOT_EDITS });
    expect(s.lines).toEqual({ added: HOT_EDITS + 2 + 0 + 2 + 1, removed: HOT_EDITS + 1 + 2 });
    expect(s.failed).toBe(1);
  });

  test('no hot file below HOT_EDITS edits', () => {
    const t = openTally('t', 0);
    for (let i = 0; i < HOT_EDITS - 1; i++) countToolCall(t, call('Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' }));
    expect(closeTally(t, { ms: 0 }, null, null).hot).toBeUndefined();
  });

  test('an edit counts only the lines that changed, its shared first and last lines left out', () => {
    expect(changedLines('Edit', { old_string: 'a\nb\nc\nd', new_string: 'a\nB\nC\nX\nd' })).toEqual({ added: 3, removed: 2 });
    expect(changedLines('Edit', { old_string: 'a\nb', new_string: 'a\nb\nc' })).toEqual({ added: 1, removed: 0 });
    expect(changedLines('Edit', { old_string: 'a\nb\nc', new_string: 'a\nc' })).toEqual({ added: 0, removed: 1 });
    expect(changedLines('Edit', { old_string: 'same', new_string: 'same' })).toEqual({ added: 0, removed: 0 });
    expect(changedLines('Write', { content: '' })).toEqual({ added: 0, removed: 0 });
    expect(changedLines('MultiEdit', { edits: 'not a list' })).toEqual({ added: 0, removed: 0 });
    expect(changedLines('Edit', {})).toEqual({ added: 0, removed: 0 });
  });

  test('test runs, commits and pushes past git options, web reads; a failed push is no push', () => {
    const t = openTally('t', 0);
    countToolCall(t, call('Bash', { command: 'npm test' }, { outcome: 'testPass' }));
    countToolCall(t, call('Bash', { command: 'npm test -- a' }, { outcome: 'testFail', failed: true }));
    countToolCall(t, call('Bash', { command: 'git -C repo commit -m x && git --no-pager push origin develop' }));
    countToolCall(t, call('Bash', { command: 'git -c user.name=x commit --amend' }, { main: false }));
    countToolCall(t, call('Bash', { command: 'git push' }, { failed: true }));
    countToolCall(t, call('Bash', { command: 'echo "git commit" is how' }));
    countToolCall(t, call('Bash', { command: 'git log --oneline' }));
    countToolCall(t, call('WebFetch', { url: 'https://example.com' }));
    countToolCall(t, call('mcp__professor__harvester_read'));
    countToolCall(t, call('mcp__playwright__browser_click', {}, { main: false }));
    countToolCall(t, call('mcp__professor__chat_ls'));
    const s = closeTally(t, { ms: 0 }, null, null);
    expect(s.tests).toEqual({ passed: 1, failed: 1 });
    // A commit in a quoted string, and a log, are no commits.
    expect(s.git).toEqual({ commits: 2, pushes: 1 });
    expect(s.web).toBe(3);
  });

  test('model requests and why they stopped; subagent runs with every token they spent', () => {
    const t = openTally('t', 0);
    countStep(t, 'tool_use');
    countStep(t, 'max_tokens');
    countStep(t, 'model_context_window_exceeded');
    countStep(t, null);
    countAgentRun(t, usage(10, 20, 30, 40));
    countAgentRun(t);
    const s = closeTally(t, { ms: 0 }, null, null);
    expect(s).toMatchObject({ requests: 4, stops: { maxTokens: 1, contextFull: 1 }, agents: { runs: 2, tools: 0, tokens: 100 } });
  });

  test("the main loop's tokens, model and effort; the cost between the session's usage at the start and the end; the context and limits after", () => {
    const before = { cost: { usd: 1.25 }, context: { window: 200_000 }, rateLimits: [] };
    const after = { cost: { usd: 1.67 }, context: { tokens: 50_000, window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 71 }, { kind: 'seven_day', percentUsed: 12 }, { kind: 'spend_limit', percentUsed: 99 }] };
    const s = closeTally(openTally('t', 0), { ms: 5, usage: { ...usage(100, 200, 900, 0), model: 'claude-opus-5' }, effort: 'xhigh' }, before, after);
    expect(s).toMatchObject({ tokens: { in: 100, out: 200, cacheRead: 900, cacheWrite: 0 }, model: 'claude-opus-5', effort: 'xhigh', context: { percent: 25, window: 200_000 }, limits: { fiveHour: 71, sevenDay: 12 } });
    expect(s.usd).toBeCloseTo(0.42);
    // The engine's own percent wins; a numeric effort is kept as text.
    expect(closeTally(openTally('t', 0), { ms: 0, effort: 31 }, null, { context: { tokens: 1, window: 10, percent: 62.4 } })).toMatchObject({ effort: '31', context: { percent: 62, window: 10 } });
  });

  test('no cost without both readings, none that went down (a /clear); no context without a window', () => {
    expect(closeTally(openTally('t', 0), { ms: 0 }, null, { cost: { usd: 2 } }).usd).toBeUndefined();
    expect(closeTally(openTally('t', 0), { ms: 0 }, { cost: { usd: 3 } }, { cost: { usd: 1 } }).usd).toBeUndefined();
    expect(closeTally(openTally('t', 0), { ms: 0 }, null, { context: { tokens: 5 } }).context).toBeUndefined();
    expect(closeTally(openTally('t', 0), { ms: 0 }, null, { rateLimits: [] }).limits).toBeUndefined();
  });
});

describe('the line the model reads', () => {
  const full: TurnStats = {
    ms: 252_000, gapMs: 840_000, requests: 31, tools: { Bash: 20, Edit: 12, Read: 10, Grep: 3, Glob: 1, Write: 1 }, failed: 3, denied: 1, reruns: 2,
    agents: { runs: 2, tools: 57, tokens: 340_000 }, files: { read: 8, edited: 5, wrote: 1 }, hot: { file: 'buddy.tsx', edits: 9 }, lines: { added: 212, removed: 47 },
    tests: { passed: 2, failed: 1 }, git: { commits: 1, pushes: 1 }, web: 3, stops: { maxTokens: 1, contextFull: 0 },
    tokens: { in: 60_000, out: 18_000, cacheRead: 1_140_000, cacheWrite: 0 }, model: 'claude-opus-5', effort: 'xhigh', usd: 0.42,
    context: { percent: 62, window: 200_000 }, limits: { fiveHour: 71, sevenDay: 33 },
  };

  test('every group, the most used tools named first, the rest counted', () => {
    expect(renderStats(full)).toBe(
      'Numbers: 4m12s, after a 14m00s pause · 31 model requests · 47 tool calls (Bash 20, Edit 12, Read 10, Grep 3, 2 more kinds), 3 failed, 1 denied, 2 shell commands run again unchanged · ' +
        '2 subagent runs: 57 tool calls, 340k tokens · files 8 read, 5 edited, 1 written; buddy.tsx edited 9× · lines +212 −47 · test runs 2 passed, 1 failed · 1 commit, 1 push · 3 web reads · ' +
        'cut at max tokens 1× · tokens 1.2M in (95% cached), 18k out · $0.42 · context 62% full of 200k · 5-hour limit 71% used · on opus-5 at xhigh effort',
    );
    expect(Object.keys(full.tools!).length).toBeGreaterThan(TOOL_NAMES_MAX);
  });
  test('one kind past the named ones is singular', () => {
    const tools = { Bash: 5, Edit: 4, Read: 3, Grep: 2, Write: 1 };
    expect(renderStats({ ms: 1_000, tools })).toBe('Numbers: 1s · 15 tool calls (Bash 5, Edit 4, Read 3, Grep 2, 1 more kind)');
  });

  test('the model and effort only when they changed from the turn before; a limit below LIMIT_SAID_PERCENT unsaid', () => {
    const next: TurnStats = { ms: 3_000, requests: 1, model: 'claude-opus-5', effort: 'xhigh', limits: { fiveHour: LIMIT_SAID_PERCENT - 1 } };
    expect(renderStats(next, full)).toBe('Numbers: 3s · 1 model request');
    expect(renderStats({ ...next, effort: 'low' }, full)).toBe('Numbers: 3s · 1 model request · on opus-5 at low effort');
    // A turn that asked no model says none.
    expect(renderStats({ ms: 0, effort: 'max' })).toBe('Numbers: 0s');
    expect(renderStats({ ms: 1, limits: { sevenDay: LIMIT_SAID_PERCENT } })).toBe('Numbers: 0s · weekly limit 50% used');
  });

  test('subagents still running at the turn\'s end show their calls alone; one call is singular', () => {
    expect(renderStats({ ms: 0, agents: { runs: 0, tools: 1, tokens: 0 } })).toBe('Numbers: 0s · subagents: 1 tool call');
    expect(renderStats({ ms: 0, agents: { runs: 1, tools: 0, tokens: 0 } })).toBe('Numbers: 0s · 1 subagent run');
    expect(renderStats({ ms: 0, tools: { Read: 1 }, git: { commits: 0, pushes: 2 } })).toBe('Numbers: 0s · 1 tool call (Read 1) · 2 pushes');
    // An MCP tool by its own name, its server dropped.
    expect(renderStats({ ms: 0, tools: { mcp__professor__chat_new: 2, mcp__x: 1 } })).toBe('Numbers: 0s · 3 tool calls (chat_new 2, mcp__x 1)');
  });

  test('the drawer\'s brief: its time, its tool calls with its subagents\', its cost, else its tokens', () => {
    expect(statsBrief(full)).toBe('4m12s · 104 tools · $0.42');
    expect(statsBrief({ ms: 12_000, tools: { Read: 1 }, tokens: { in: 1, out: 1, cacheRead: 998, cacheWrite: 0 } })).toBe('12s · 1 tool · 1k tokens');
    expect(statsBrief({ ms: 500 })).toBe('1s');
  });

  test('short counts, spans and dollars', () => {
    expect([0, 999, 1000, 1234, 9_949, 9_950, 34_400, 999_499, 999_500, 1_260_000].map(count)).toEqual(['0', '999', '1k', '1.2k', '9.9k', '10k', '34k', '999k', '1M', '1.3M']);
    expect([0, 499, 12_000, 60_000, 134_000, 3_600_000, 3_840_000].map(span)).toEqual(['0s', '0s', '12s', '1m00s', '2m14s', '1h00m', '1h04m']);
    expect([0, 0.009, 0.42, 12.3, 123.4].map(dollars)).toEqual(['<$0.01', '<$0.01', '$0.42', '$12.30', '$123']);
  });
});

describe('stored numbers', () => {
  test('a closed tally reads back whole', () => {
    const t = openTally('t', 0, 0);
    countToolCall(t, call('Edit', { file_path: '/a', old_string: 'a', new_string: 'b' }));
    countStep(t, 'end_turn');
    const s = closeTally(t, { ms: 9, usage: { ...usage(1, 2), model: 'm' }, effort: 'low' }, { cost: { usd: 0 } }, { cost: { usd: 0.5 }, context: { tokens: 1, window: 4 }, rateLimits: [{ kind: 'five_hour', percentUsed: 5 }] });
    expect(turnStatsOf(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  test('any malformed field makes it unreadable', () => {
    for (const bad of [null, [], 'x', {}, { ms: -1 }, { ms: 1, tools: {} }, { ms: 1, tools: { Bash: 'x' } }, { ms: 1, agents: { runs: 1 } }, { ms: 1, hot: { edits: 3 } }, { ms: 1, model: 3 }, { ms: 1, effort: 3 }, { ms: 1, limits: { fiveHour: 'x' } }, { ms: 1, usd: Number.NaN }, { ms: 1, context: { percent: 3 } }]) {
      expect(turnStatsOf(bad)).toBeNull();
    }
    expect(turnStatsOf({ ms: 1, limits: {} })).toEqual({ ms: 1, limits: {} });
  });
});

describe("a shell command's own edits", () => {
  test('its candidates: every path-like word or quoted string, against the session folder and each folder it cds into; home for ~; no flag, URL or glob', () => {
    const c = shellTargets("cd pfm && sed -i '' s/a/b/ src/a.ts > ~/out.log; curl https://x.io/a.json; rm -f *.tmp; python3 - <<'PY'\np='docs/x.md'\nopen(p,'w')\nPY", '/w/app', '/h');
    for (const f of ['/w/app/src/a.ts', '/w/app/pfm/src/a.ts', '/w/app/docs/x.md', '/w/app/pfm/docs/x.md', '/h/out.log']) expect(c).toContain(f);
    expect(c.some((f) => f.includes('https') || f.includes('*') || f.includes('-i'))).toBe(false);
    expect(shellTargets('cat /etc/hosts ../up/b.txt', '/w/app', '/h')).toEqual(['/etc/hosts', '/w/up/b.txt']);
    expect(shellTargets('git -C sub commit -a && cat notes.md 2>/dev/null', '/w/app', '/h')).toEqual(['/w/app/notes.md', '/w/app/sub/notes.md']);
    expect(shellTargets(Array.from({ length: 40 }, (_, i) => `f${i}.txt`).join(' '), '/w', '/h')).toHaveLength(SHELL_CANDIDATES_MAX);
  });
  test('the lines a whole file changed, counted as git counts them: two edits far apart are two lines each way, not the span between', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    const edited = ten.map((l, i) => (i === 1 || i === 8 ? `${l}!` : l));
    expect(fileLineDelta(ten.join('\n') + '\n', edited.join('\n') + '\n')).toEqual({ added: 2, removed: 2 });
    expect(fileLineDelta('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual({ added: 2, removed: 1 });
    expect(fileLineDelta('', 'x\ny\n')).toEqual({ added: 2, removed: 0 });
    expect(fileLineDelta('same\n', 'same\n')).toEqual({ added: 0, removed: 0 });
  });
  test('only a real change counts: a file made is written, one changed or deleted edited, its lines counted', () => {
    const before = new Map<string, string | null>([['/a.ts', 'one\ntwo\n'], ['/new.txt', null], ['/same.md', 'x\n'], ['/gone.txt', 'p\nq\n'], ['/never.txt', null]]);
    const after = new Map<string, string | null>([['/a.ts', 'one\n2\nthree\n'], ['/new.txt', 'x\ny\n'], ['/same.md', 'x\n'], ['/gone.txt', null], ['/never.txt', null]]);
    const changes = shellChanges(before, after);
    expect(changes).toEqual([
      { file: '/a.ts', made: false, added: 2, removed: 1 },
      { file: '/new.txt', made: true, added: 2, removed: 0 },
      { file: '/gone.txt', made: false, added: 0, removed: 2 },
    ]);
    const t = openTally('t1', 0);
    countShellChanges(t, changes);
    countShellChanges(t, [{ file: '/a.ts', made: false, added: 1, removed: 0 }]);
    expect([...t.edited].sort()).toEqual(['/a.ts', '/gone.txt']);
    expect([...t.wrote]).toEqual(['/new.txt']);
    expect(t.edits.get('/a.ts')).toBe(2);
    expect([t.added, t.removed]).toEqual([5, 3]);
  });
  test('the folders a command works in: the session folder, then each it cds into or points -C at', () => {
    expect(shellFolders('cd pfm && make; git -C ../lib status; cd ~/x', '/w/app', '/h')).toEqual(['/w/app', '/w/app/pfm', '/w/lib', '/h/x']);
    expect(shellFolders('python3 fix.py', '/w/app', '/h')).toEqual(['/w/app']);
  });
  test("a tree sweep's changes: size or time moved is changed; made and gone only when both sweeps were whole", () => {
    const before = new Map([['/a.js', { size: 4, mtimeMs: 1 }], ['/b.js', { size: 4, mtimeMs: 1 }], ['/same.js', { size: 2, mtimeMs: 5 }], ['/gone.js', { size: 1, mtimeMs: 1 }]]);
    const after = new Map([['/a.js', { size: 6, mtimeMs: 1 }], ['/b.js', { size: 4, mtimeMs: 2 }], ['/same.js', { size: 2, mtimeMs: 5 }], ['/new.js', { size: 3, mtimeMs: 9 }]]);
    expect(sweptChanges(before, after, true)).toEqual([
      { file: '/a.js', kind: 'changed' },
      { file: '/b.js', kind: 'changed' },
      { file: '/gone.js', kind: 'gone' },
      { file: '/new.js', kind: 'made' },
    ]);
    expect(sweptChanges(before, after, false)).toEqual([{ file: '/a.js', kind: 'changed' }, { file: '/b.js', kind: 'changed' }]);
  });
  test("a swept change's lines: counted when its text is known both sides, a touch with the same text no change, an unknown side unmeasured", () => {
    expect(sweptShellChange('/a.js', 'changed', 'a\nb\n', 'a\nB\n')).toEqual({ file: '/a.js', made: false, added: 1, removed: 1 });
    expect(sweptShellChange('/a.js', 'changed', 'a\n', 'a\n')).toBeNull();
    expect(sweptShellChange('/n.js', 'made', null, 'x\ny\n')).toEqual({ file: '/n.js', made: true, added: 2, removed: 0 });
    expect(sweptShellChange('/g.js', 'gone', 'p\nq\n', null)).toEqual({ file: '/g.js', made: false, added: 0, removed: 2 });
    expect(sweptShellChange('/logo.png', 'changed', undefined, undefined)).toEqual({ file: '/logo.png', made: false, added: 0, removed: 0, unmeasured: true });
    expect(sweptShellChange('/big.json', 'made', null, undefined)).toEqual({ file: '/big.json', made: true, added: 0, removed: 0, unmeasured: true });
  });
  test('a file whose lines went unmeasured still counts as a file, and the line says so instead of reading as no change', () => {
    const t = openTally('t1', 0);
    countShellChanges(t, [{ file: '/a.js', made: false, added: 1, removed: 1 }, { file: '/logo.png', made: false, added: 0, removed: 0, unmeasured: true }]);
    const s = closeTally(t, { ms: 1000 }, null, null);
    expect(s.files).toEqual({ read: 0, edited: 2, wrote: 0 });
    expect(s.lines).toEqual({ added: 1, removed: 1, unmeasured: 1 });
    expect(renderStats(s)).toContain('lines +1 −1, unmeasured in 1 file');
    expect(turnStatsOf(JSON.parse(JSON.stringify(s)))).toEqual(s);
    const only = openTally('t2', 0);
    countShellChanges(only, [{ file: '/x.bin', made: false, added: 0, removed: 0, unmeasured: true }, { file: '/y.bin', made: false, added: 0, removed: 0, unmeasured: true }]);
    expect(renderStats(closeTally(only, { ms: 1000 }, null, null))).toContain('lines unmeasured in 2 files');
    expect(turnStatsOf({ ms: 1, lines: { added: 1, removed: 0, unmeasured: -1 } })).toBeNull();
  });
});
