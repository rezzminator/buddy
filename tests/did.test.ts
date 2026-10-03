import { describe, expect, test } from 'vitest';
import {
  DID_FILES_MAX, DID_HEAD, DID_LINE_CAP, DID_MAX, DID_TEXT_CAP, FAIL_REASON_CAP, SHORT_COMMAND_CAP, actionOf, agentUsageOf, agentUsageText, briefedOf, callSize, denialReason, didOf, failureReason, redact, returnedOf, type Action, type Failure,
} from '../plugins/buddy/src/did.ts';
import { cutBrief, cutReport } from '../plugins/buddy/src/cuts.ts';
import { lostTurnOf } from '../plugins/buddy/src/prompts.ts';

const did = (...calls: [Record<string, unknown> & { tool: string }, (boolean | Failure)?][]): string[] =>
  didOf(calls.map(([c, f]) => actionOf(c, f === true ? { kind: 'failed', reason: '' } : f || null)).filter((a): a is Action => a !== null));

describe('a step', () => {
  test('a shell command is its description, never its output; failed marked', () => {
    expect(did([{ tool: 'Bash', command: 'npm test', description: 'Run the unit tests' }, true])).toEqual(['Run the unit tests (failed)']);
  });
  test('an undescribed command without its cds, paths cut to their last part, at most 110 ending [cut]', () => {
    expect(SHORT_COMMAND_CAP).toBe(110);
    expect(did([{ tool: 'Bash', command: 'cd /w/x/repo && cat /w/x/repo/src/a.ts' }])).toEqual(['ran cat a.ts']);
    const ran = did([{ tool: 'Bash', command: `echo ${'y'.repeat(200)}` }])[0]!;
    expect(ran).toBe(`ran echo ${'y'.repeat(99)} [cut]`);
    expect(ran.slice('ran '.length)).toHaveLength(SHORT_COMMAND_CAP);
  });
  test('a path is cut to its last part, never glued to the word before it; a URL stays whole', () => {
    const ran = (command: string): string | undefined => did([{ tool: 'Bash', command }])[0];
    expect(ran('npx vitest run plugins/buddy/test/buddy.test.tsx')).toBe('ran npx vitest run buddy.test.tsx');
    expect(ran('cat /w/x/a/b.ts')).toBe('ran cat b.ts');
    expect(ran('git -C ~/work/repo status')).toBe('ran git -C repo status');
    expect(ran('curl -s https://example.com/api/v1')).toBe('ran curl -s https://example.com/api/v1');
  });
  test('a path whose last part another word of the command shares stays whole', () => {
    const ran = (command: string): string | undefined => did([{ tool: 'Bash', command }])[0];
    expect(ran('ls -d tmp app/tmp 2>&1')).toBe('ran ls -d tmp app/tmp 2>&1');
    expect(ran('diff a/x.ts b/x.ts')).toBe('ran diff a/x.ts b/x.ts');
    expect(ran('ls -d tmp app/tmp/bin')).toBe('ran ls -d tmp bin');
  });
  test("what an agent returned rides with its step, its resume and usage lines dropped; an agent launched async is background work, its acknowledgement no report", () => {
    const fg = actionOf({ tool: 'Agent', description: 'Audit the diff' }, null, 'DONE: 3 findings, all fixed.\nagentId: a1b2 (for resuming to continue this agent\'s work if needed)\n<usage>total_tokens: 5</usage>');
    expect(fg).toEqual({ text: 'agent: Audit the diff', returned: '“Audit the diff” returned (5 tokens · report 28 chars): DONE: 3 findings, all fixed.' });
    expect(didOf([fg!])).toEqual(['agent: Audit the diff']);
    expect(returnedOf([fg!, { text: 'Run the tests' }, { verb: 'read', file: 'a.ts' }])).toEqual(['“Audit the diff” returned (5 tokens · report 28 chars): DONE: 3 findings, all fixed.']);
    const bg = actionOf({ tool: 'Agent', description: 'Audit the diff' }, null, 'Async agent launched successfully.\nagentId: a1 (internal ID - do not mention to user.)');
    expect(bg).toEqual({ text: 'agent in the background (reports back later): Audit the diff' });
    expect(returnedOf([bg!])).toEqual([]);
    // A failed agent says why as any failed step; nothing returned.
    expect(actionOf({ tool: 'Task', description: 'Audit' }, { kind: 'failed', reason: 'timed out' }, 'timed out')).toEqual({ text: 'agent: Audit', fail: 'failed: timed out' });
    expect(actionOf({ tool: 'Agent' }, null, 'Fixed.')).toEqual({ text: 'ran an agent', returned: '“an agent” returned (report 6 chars): Fixed.' });
    expect(actionOf({ tool: 'Agent', description: 'Audit' }, null, '  \n')).toEqual({ text: 'agent: Audit' });
  });
  test('background work says so; a foreground call is unchanged', () => {
    expect(did([{ tool: 'Bash', command: 'npm run dev', description: 'Start the dev server', run_in_background: true }])).toEqual(['Start the dev server (in the background, reports back later)']);
    expect(did([{ tool: 'Bash', command: 'npm run dev', description: 'Start the dev server', run_in_background: false }])).toEqual(['Start the dev server']);
    expect(did([{ tool: 'Agent', description: 'Audit the diff', run_in_background: true }])).toEqual(['agent in the background (reports back later): Audit the diff']);
    expect(did([{ tool: 'Task', run_in_background: true }])).toEqual(['ran an agent in the background']);
    expect(did([{ tool: 'Agent', description: 'Audit the diff' }])).toEqual(['agent: Audit the diff']);
  });
  test('a file tool by its verb and the file name; an agent, a skill, the web, an MCP tool by what they did', () => {
    expect(did(
      [{ tool: 'Agent', description: 'Audit the diff', prompt: 'long…' }],
      [{ tool: 'Skill', skill: 'dev' }],
      [{ tool: 'WebFetch', url: 'https://example.com/a/b?c=1' }],
      [{ tool: 'mcp__professor__chat_new', name: 'x' }],
      [{ tool: 'SendMessage', to: 'gitter', message: 'm' }],
    )).toEqual(['agent: Audit the diff', 'skill dev', 'fetched example.com', 'chat new', 'messaged gitter']);
  });
  test('bookkeeping says nothing of the work: dropped', () => {
    expect(did([{ tool: 'ToolSearch', query: 'x' }], [{ tool: 'TaskStop', task_id: '1' }], [{ tool: 'Monitor' }])).toEqual([]);
    expect(actionOf({ tool: 'Read' }, null)).toBeNull();
  });
});

describe('a failed or denied step', () => {
  test('a failed command says why: the error line, after the exit code', () => {
    const reason = failureReason("Exit code 1\n\nsome log\nError: ENOENT: no such file, open 'x.json'");
    expect(reason).toBe("exit 1: Error: ENOENT: no such file, open 'x.json'");
    expect(did([{ tool: 'Bash', command: 'npm test', description: 'Run the unit tests' }, { kind: 'failed', reason }])[0])
      .toMatch(/ \(failed: exit 1: Error: ENOENT: no such file, open 'x\.json'\)$/);
  });
  test('without an error line the last line; colors gone, one-spaced, cut to FAIL_REASON_CAP', () => {
    expect(failureReason('\u001b[31mstarting\u001b[0m\n  done   with 3   warnings  \n')).toBe('done with 3 warnings');
    expect(failureReason('Exit code 2')).toBe('exit 2');
    expect(failureReason('')).toBe('');
    const long = failureReason(`Error: ${'x'.repeat(200)}`);
    expect(long).toHaveLength(FAIL_REASON_CAP);
    expect(long.endsWith(' [cut]')).toBe(true);
  });
  test('an exit 1 from a trailing check names the check: its last segment, or a check before a trailing && that only prints', () => {
    expect(failureReason('Exit code 1\n0', 'make check && grep -c "no DONE line" /tmp/x.log')).toBe('exit 1 from its last check (`grep -c "no DONE line" /tmp/x.log`): 0');
    expect(failureReason('Exit code 1\nrun-3 rc=0 283 ms', './bench.sh; [ $rc -ne 0 ] && tail -5 /tmp/x.log')).toBe('exit 1 from its last check (`[ $rc -ne 0 ]`): run-3 rc=0 283 ms');
    expect(failureReason('Exit code 1', 'make || [[ -f out/a.bin ]]')).toBe('exit 1 from its last check (`[[ -f out/a.bin ]]`)');
    expect(failureReason('Exit code 1', 'cat a.txt | test -s b.txt')).toBe('exit 1 from its last check (`test -s b.txt`)');
    expect(failureReason('Exit code 1\n1c1', 'sort a > b; diff b c')).toBe('exit 1 from its last check (`diff b c`): 1c1');
    expect(failureReason('Exit code 1', 'cmp a.bin b.bin')).toBe('exit 1 from its last check (`cmp a.bin b.bin`)');
    expect(failureReason('Exit code 1', 'grep -c "a; b && c" x.log')).toBe('exit 1 from its last check (`grep -c "a; b && c" x.log`)');
    expect(failureReason('Exit code 1', `grep -q ${'x'.repeat(60)} f`)).toBe(`exit 1 from its last check (\`grep -q ${'x'.repeat(26)} [cut]\`)`);
  });
  test('any other exit stays plain: another code, another last command, or no command', () => {
    expect(failureReason('Exit code 2\nno such file', 'grep x a.txt')).toBe('exit 2: no such file');
    expect(failureReason('Exit code 1\nboom', 'grep -q x a && npm test')).toBe('exit 1: boom');
    expect(failureReason('Exit code 1\nboom', 'git grep x')).toBe('exit 1: boom');
    expect(failureReason('Exit code 1\nboom', '[ -d out ] && make')).toBe('exit 1: boom');
    expect(failureReason('Exit code 1\nboom')).toBe('exit 1: boom');
  });
  test("a lost turn's failed shell step names its trailing check", () => {
    const rows = [
      { role: 'user', text: 'check the log' },
      { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command: 'make && grep -c ERR /tmp/x.log', description: 'Count errors' }, text: 'Exit code 1\n0', isError: true as const }] },
    ];
    expect(lostTurnOf(rows).steps).toEqual([{ text: 'Count errors', fail: 'failed: exit 1 from its last check (`grep -c ERR /tmp/x.log`): 0' }]);
  });
  test('a denial is not a failure', () => {
    expect(did([{ tool: 'Bash', command: 'rm -rf x', description: 'Remove x' }, { kind: 'denied', reason: denialReason('User rejected') }])).toEqual(['Remove x (denied: User rejected)']);
    expect(did([{ tool: 'Bash', command: 'rm -rf x', description: 'Remove x' }, { kind: 'denied', reason: '' }])).toEqual(['Remove x (denied)']);
  });
  test('a failed or denied file tool is a step of its own, never gathered under the verb', () => {
    expect(did(
      [{ tool: 'Edit', file_path: '/r/a.ts' }, { kind: 'failed', reason: 'String to replace not found in file.' }],
      [{ tool: 'Edit', file_path: '/r/b.ts' }],
      [{ tool: 'Read', file_path: '/r/x.ts' }, { kind: 'denied', reason: 'no' }],
      [{ tool: 'Write', file_path: '/r/c.ts' }, true],
      [{ tool: 'Grep', pattern: 'foo' }, true],
    )).toEqual(['edit a.ts (failed: String to replace not found in file.)', 'edited b.ts', 'read x.ts (denied: no)', 'write c.ts (failed)', 'search foo (failed)']);
  });
  test('the same step twice in a row is one only when its failure matches too', () => {
    const bash = { tool: 'Bash', command: 'a', description: 'Run it' };
    expect(did([bash, { kind: 'failed', reason: 'one' }], [bash, { kind: 'failed', reason: 'two' }], [bash, { kind: 'failed', reason: 'two' }])).toEqual(['Run it (failed: one)', 'Run it (failed: two)']);
    expect(did([bash, true], [bash])).toEqual(['Run it (failed)', 'Run it']);
  });
  test('a secret in a reason is redacted', () => {
    expect(failureReason('Error: auth failed for sk-ant-abcdef123456')).toBe('Error: auth failed for [redacted]');
    expect(denialReason('bad TOKEN=hunter2 given')).toBe('bad TOKEN=[redacted] given');
    expect(redact('ghp_abcdefghijklmnopqrstuvwxyz0123 xoxb-1-2-abc AKIAABCDEFGHIJKLMNOP eyJhbGciOiJIUzI1.eyJzdWIi.sig password: pw api_key=k')).toBe(
      '[redacted] [redacted] [redacted] [redacted] password: [redacted] api_key=[redacted]',
    );
  });
  test('the failure marker survives the step cap whole', () => {
    const d = did([{ tool: 'Bash', command: 'a', description: 'z'.repeat(200) }, { kind: 'failed', reason: 'boom' }])[0];
    expect(d).toBe(`${'z'.repeat(DID_TEXT_CAP - 6)} [cut] (failed: boom)`);
    expect(DID_TEXT_CAP).toBe(120);
    const sized = didOf([actionOf({ tool: 'Bash', command: 'a', description: 'z'.repeat(200) }, { kind: 'failed', reason: 'boom' }, '', { size: { call: 250, output: 40 } })!])[0];
    expect(sized).toBe(`${'z'.repeat(DID_TEXT_CAP - 6)} [cut] [call 250 · output 40 chars] (failed: boom)`);
    const worst = didOf([actionOf({ tool: 'Bash', command: 'a', description: 'z'.repeat(200) }, { kind: 'denied', reason: denialReason('d'.repeat(300)) }, '', { size: { call: 999_499, output: 999_499 } })!])[0]!;
    expect(worst.length).toBeLessThanOrEqual(DID_LINE_CAP);
  });
});

describe('a test run that passed before a later command of its chain failed', () => {
  // The audited case: the go test passed, then a trailing `ls` exited 2.
  const command = `./scripts/dev.sh iso run 'go -C tool test -count=1 -run "TestConfigShow" ./cmd/tool/' 2>&1 | tail -3; make -C tool build 2>&1 | tail -1; ls tool/tmp/bin/`;
  const output = "Exit code 2\nok  \texample.com/tool/cmd/tool\t4.790s\n\nall steps passed.\nmake: Leaving directory 'tool'\nls: cannot access 'tool/tmp/bin/': No such file or directory";
  test('its reason says the tests passed and a later command failed, with its exit and error line', () => {
    expect(failureReason(output, command)).toMatch(/^tests passed, a later command failed \(exit 2\): ls: cannot access 'tool\/tmp\/bin\/'/);
  });
  test('its step is never marked failed', () => {
    const step = did([{ tool: 'Bash', command, description: 'Run TestConfigShow, build, list the binaries' }, { kind: 'failed', reason: failureReason(output, command) }])[0]!;
    expect(step).toMatch(/^Run TestConfigShow, build, list the binaries \(tests passed, a later command failed \(exit 2\): ls: cannot access/);
    expect(step).not.toContain('failed: ');
  });
  test('an exit 1 from a trailing check after the passing tests names the check', () => {
    expect(failureReason('Exit code 1\nok  \texample.com/tool\t0.1s', 'go test ./... && grep -q done out.log')).toBe('tests passed, then exit 1 from its last check (`grep -q done out.log`)');
  });
  test('a plain failing test still reads as failed', () => {
    const red = failureReason(output.replace('ok  ', 'FAIL'), command);
    expect(red).toMatch(/^exit 2: FAIL example\.com\/tool\/cmd\/tool/);
    expect(did([{ tool: 'Bash', command, description: 'Run the test' }, { kind: 'failed', reason: red }])[0]).toContain('(failed: exit 2: FAIL');
    expect(failureReason('Exit code 1\n5 passed\nError: coverage below 80%', 'npx vitest run --coverage')).toBe('exit 1: Error: coverage below 80%');
    expect(failureReason('Exit code 1\n5 passed\nError: coverage below 80%', 'npx vitest run --coverage | tee out.log')).toBe('exit 1: Error: coverage below 80%');
  });
});

describe('the turn', () => {
  test('files gathered under their verb, each once, where the verb first came', () => {
    expect(did(
      [{ tool: 'Read', file_path: '/r/src/a.ts' }],
      [{ tool: 'Bash', command: 'x', description: 'Run the tests' }],
      [{ tool: 'Edit', file_path: '/r/src/a.ts' }],
      [{ tool: 'Read', file_path: '/r/src/b.ts' }],
      [{ tool: 'Edit', file_path: '/r/src/a.ts' }],
      [{ tool: 'Grep', pattern: 'turnFacts' }],
    )).toEqual(['read a.ts, b.ts', 'Run the tests', 'edited a.ts', 'searched turnFacts']);
  });
  test('a step said twice in a row once; past DID_FILES_MAX files counted; each step capped', () => {
    const edits = Array.from({ length: DID_FILES_MAX + 2 }, (_, i) => [{ tool: 'Edit', file_path: `f${i}.ts` }] as [{ tool: string; file_path: string }]);
    expect(did(...edits)).toEqual([`edited ${Array.from({ length: DID_FILES_MAX }, (_, i) => `f${i}.ts`).join(', ')} +2`]);
    expect(did([{ tool: 'Bash', command: 'a', description: 'Wait' }], [{ tool: 'Bash', command: 'a', description: 'Wait' }])).toEqual(['Wait']);
    expect(did([{ tool: 'Bash', command: 'a', description: 'z'.repeat(200) }])[0]).toHaveLength(DID_TEXT_CAP);
  });
  test('past DID_MAX steps: the first and the last stay around a count of the rest', () => {
    const steps = Array.from({ length: 20 }, (_, i) => [{ tool: 'Bash', command: 'a', description: `step ${i}` }] as [{ tool: string; command: string; description: string }]);
    const d = did(...steps);
    expect(d).toHaveLength(DID_MAX);
    expect(d.slice(0, 5)).toEqual(['step 0', 'step 1', 'step 2', 'step 3', '[cut: 9 more steps]']);
    expect(d.at(-1)).toBe('step 19');
    const one = did(...steps.slice(0, DID_MAX + 1));
    expect(one[DID_HEAD]).toBe('[cut: 2 more steps]');
  });
});

describe("a step's size", () => {
  const sized = (call: Record<string, unknown> & { tool: string }, size: { call: number; output: number }, failure: Failure | null = null): Action =>
    actionOf(call, failure, '', { size })!;
  test('after its text, before its failure marker: the call and output sizes in characters', () => {
    expect(didOf([sized({ tool: 'Bash', command: 'npm test', description: 'Run the tests' }, { call: 30, output: 34_000 })])).toEqual(['Run the tests [call 30 · output 34k chars]']);
    expect(didOf([sized({ tool: 'Bash', command: 'npm test', description: 'Run the tests' }, { call: 30, output: 12 }, { kind: 'failed', reason: 'exit 1' })])).toEqual(['Run the tests [call 30 · output 12 chars] (failed: exit 1)']);
  });
  test('an action without a size has no mark', () => {
    expect(didOf([{ text: 'Run the tests' }, { verb: 'read', file: 'a.ts' }])).toEqual(['Run the tests', 'read a.ts']);
  });
  test('the same step twice in a row, and the edits of one verb, sum their sizes', () => {
    const run = { tool: 'Bash', command: 'a', description: 'Wait' };
    expect(didOf([sized(run, { call: 10, output: 100 }), sized(run, { call: 10, output: 200 })])).toEqual(['Wait [call 20 · output 300 chars]']);
    expect(didOf([sized({ tool: 'Edit', file_path: '/r/a.ts' }, { call: 50, output: 20 }), sized({ tool: 'Edit', file_path: '/r/b.ts' }, { call: 70, output: 30 })])).toEqual(['edited a.ts, b.ts [call 120 · output 50 chars]']);
    // One of the merged calls with a size is enough for the mark.
    expect(didOf([{ verb: 'read', file: 'a.ts' }, sized({ tool: 'Read', file_path: '/r/b.ts' }, { call: 5, output: 9 })])).toEqual(['read a.ts, b.ts [call 5 · output 9 chars]']);
  });
  test("callSize: the call's arguments as JSON, without the event's own keys", () => {
    const call = { tool: 'Bash', command: 'npm test', tool_use_id: 'tu1', agentId: 'a1' };
    expect(callSize(call)).toBe(JSON.stringify({ command: 'npm test' }).length);
  });
});

describe("an agent's brief, report and usage", () => {
  const brief = Array.from({ length: 10 }, (_, i) => `brief line ${i}`).join('\n');
  const report = `${'R'.repeat(2000)}${'S'.repeat(2000)}`;
  test('a sync agent: its brief, and what it returned with its usage and the size of its uncut report', () => {
    const a = actionOf({ tool: 'Agent', description: 'Audit', prompt: brief }, null, report, { result: { totalTokens: 15166, totalToolUseCount: 5, totalDurationMs: 15512 } })!;
    expect(briefedOf([a])).toEqual([`“Audit”: ${cutBrief(brief)}`]);
    expect(returnedOf([a])).toEqual([`“Audit” returned (15k tokens · 5 tool uses · 16s · report 4k chars): ${cutReport(report)}`]);
    expect(didOf([a])).toEqual(['agent: Audit']);
  });
  test('no usage anywhere: the report size alone; a failed call returns nothing and keeps its brief', () => {
    const a = actionOf({ tool: 'Agent', description: 'Audit', prompt: brief }, null, report)!;
    expect(returnedOf([a])).toEqual([`“Audit” returned (report 4k chars): ${cutReport(report)}`]);
    const failed = actionOf({ tool: 'Agent', description: 'Audit', prompt: brief }, { kind: 'failed', reason: 'timed out' }, report)!;
    expect(returnedOf([failed])).toEqual([]);
    expect(briefedOf([failed])).toEqual([`“Audit”: ${cutBrief(brief)}`]);
  });
  test('usage in the text: read from its <usage> block, which stays out of the report', () => {
    const text = `${report}\n<usage><subagent_tokens>77810</subagent_tokens><tool_uses>16</tool_uses><duration_ms>119609</duration_ms></usage>`;
    const a = actionOf({ tool: 'Agent', description: 'Audit' }, null, text)!;
    expect(returnedOf([a])).toEqual([`“Audit” returned (78k tokens · 16 tool uses · 2m00s · report 4k chars): ${cutReport(report)}`]);
  });
  test('a background agent: its step as before, plus its brief; no description is “an agent”', () => {
    const a = actionOf({ tool: 'Agent', description: 'Audit', prompt: brief, run_in_background: true }, null, 'Async agent launched successfully.')!;
    expect(a).toEqual({ text: 'agent in the background (reports back later): Audit', brief: cutBrief(brief) });
    expect(briefedOf([a, actionOf({ tool: 'Task', prompt: 'go' }, null, '')!])).toEqual([`“Audit”: ${cutBrief(brief)}`, '“an agent”: go']);
  });
  test('agentUsageOf: typed fields first, else the tag or line form, null when nothing; agentUsageText says the parts known', () => {
    expect(agentUsageOf({ totalTokens: 1, totalToolUseCount: 2, totalDurationMs: 3000 }, '<usage>total_tokens: 9</usage>')).toEqual({ tokens: 1, toolUses: 2, ms: 3000 });
    expect(agentUsageOf(null, '<usage>total_tokens: 9\ntool_uses: 4\nduration_ms: 61000</usage>')).toEqual({ tokens: 9, toolUses: 4, ms: 61000 });
    expect(agentUsageOf({ totalTokens: 'x' }, 'no block')).toBeNull();
    expect(agentUsageText({ tokens: 1200, ms: 134_000 })).toBe('1.2k tokens · 2m14s');
    expect(agentUsageText(null)).toBe('');
  });
});
