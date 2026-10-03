import { describe, expect, test } from 'vitest';
import { BRIEF_HEAD, BRIEF_TAIL, CUT, REPORT_HEAD, REPORT_LARGE_HEAD, REPORT_LARGE_TAIL, REPORT_TAIL, cutBrief, cutReport, ends } from '../plugins/buddy/src/cuts.ts';
import { ends as reexported } from '../plugins/buddy/src/chatTurnsToRead.ts';

describe('ends', () => {
  test('a text past its head and tail keeps both around a [cut] mark', () => {
    expect(ends('a'.repeat(50), 10, 5)).toBe('aaaaaaaaaa [cut] aaaaa');
  });
  test('a text no longer than head + tail + 7 stays whole; cutting again keeps it', () => {
    expect(ends('a'.repeat(22), 10, 5)).toBe('a'.repeat(22));
    expect(ends('a'.repeat(23), 10, 5)).toBe('aaaaaaaaaa [cut] aaaaa');
    const once = ends('x'.repeat(500), 100, 50);
    expect(ends(once, 100, 50)).toBe(once);
  });
  test('chatTurnsToRead re-exports it', () => {
    expect(reexported).toBe(ends);
  });
});

describe('cutReport', () => {
  const report = (n: number): string => `${'h'.repeat(n / 2)}${'t'.repeat(n / 2)}`;
  test('a small report keeps 600 and 200 around the mark', () => {
    const r = report(4000);
    expect(cutReport(r)).toBe(`${r.slice(0, REPORT_HEAD)} ${CUT} ${r.slice(-REPORT_TAIL)}`);
    expect([REPORT_HEAD, REPORT_TAIL]).toEqual([600, 200]);
  });
  test('a report of at most 807 characters stays whole', () => {
    expect(cutReport('r'.repeat(807))).toBe('r'.repeat(807));
    expect(cutReport('r'.repeat(808))).toContain(` ${CUT} `);
  });
  test('a report over 10,000 characters keeps 2400 and 800; exactly 10,000 is cut by the small rule', () => {
    const large = report(12_000);
    expect(cutReport(large)).toBe(`${large.slice(0, REPORT_LARGE_HEAD)} ${CUT} ${large.slice(-REPORT_LARGE_TAIL)}`);
    expect([REPORT_LARGE_HEAD, REPORT_LARGE_TAIL]).toEqual([2400, 800]);
    const edge = report(10_000);
    expect(cutReport(edge)).toBe(`${edge.slice(0, REPORT_HEAD)} ${CUT} ${edge.slice(-REPORT_TAIL)}`);
  });
});

describe('cutBrief', () => {
  test('a long brief keeps its first line and last 3 nonempty lines around a [cut] line', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    lines.splice(18, 0, '   ');
    expect(cutBrief(lines.join('\n'))).toBe(['line 0', CUT, 'line 17', 'line 18', 'line 19'].join('\n'));
  });
  test('a short brief stays whole', () => {
    expect(cutBrief('one\ntwo\nthree')).toBe('one\ntwo\nthree');
    expect(cutBrief('just one line')).toBe('just one line');
  });
  test('a huge first line is bounded by 900 and 300', () => {
    const brief = `${'f'.repeat(5000)}\n${Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n')}`;
    const cut = cutBrief(brief);
    expect(cut.length).toBe(BRIEF_HEAD + BRIEF_TAIL + CUT.length + 2);
    expect(cut.startsWith('f'.repeat(BRIEF_HEAD))).toBe(true);
    expect(cut.endsWith('l7\nl8\nl9')).toBe(true);
  });
});
