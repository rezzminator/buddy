import type { LineEvent, Pose } from './character.ts';

// What a finished tool call means to the buddy: a table from outcome to pose,
// line pool and effect, so a new reaction is a row, not a branch.

/** One multiline regex matching any of `parts`. */
const anyOf = (parts: RegExp[]): RegExp => new RegExp(parts.map((p) => p.source).join('|'), 'm');

// A summary line that opens with counts: `1 failed, 2 passed in 0.1s` (pytest),
// `  3 passing (5ms)` (mocha), `  2 tests failed` (ava), ` 3 pass` (bun),
// `3 tests completed, 1 failed` (gradle). The count ends the line or meets
// `,` `;` `(` `|` or `in 1.2s`, so `Attempt 1 failed` or `1 failed login` is no summary.
const counts = (words: string): RegExp =>
  new RegExp(String.raw`^[ \t=]*(?:\d+ [a-z]+(?: [a-z]+)?[,;] )*[1-9]\d* (?:tests? )?(?:${words})(?=[ \t]*(?:$|[,;(|]|in [\d.]))`);

/** A passing run's summary line, one shape per runner; a zero count never passes. */
export const TEST_PASS = anyOf([
  counts('passed|passing|pass'),
  /^[ \t]*(?:Tests?|Test Files|Test Suites):?[ \t](?:[^\n]*?[ \t])?[1-9]\d* passed\b/, // vitest, jest
  /^[ \t]*PASS[ \t]+\S/, // jest, tap: a passing file
  /^[ \t]*ok [1-9]\d*\b(?![^\n]*#[ \t]*[Ss][Kk][Ii][Pp])/, // TAP; a skip is no pass
  /^# pass[ \t]+[1-9]/, // TAP counts
  /^(?:Asserts|Suites):[ \t]+[1-9]\d* pass\b/, // tap
  /^ok[ \t]+\S+[ \t]+(?:[\d.]+s|\(cached\))(?![^\n]*no tests to run)/, // go test
  /^test result: ok\. [1-9]\d* passed/, // cargo
  /^[ \t]*(?:\d+ [a-z]+, )*[1-9]\d* (?:examples?|tests?), 0 failures\b/, // rspec, mix test
  /^[1-9]\d* runs?, \d+ assertions?, 0 failures?, 0 errors?\b/, // minitest (rake test)
  /^Ran [1-9]\d* tests? in [\d.]+s[ \t\r]*\n\s*OK(?: \([^)\n]*\))?[ \t]*$/, // unittest: both lines, so a stray OK never counts
  /^OK \([1-9]\d* tests?, \d+ assertions?\)/, // phpunit
  /^\d+% tests passed, 0 tests failed out of [1-9]/, // ctest
  /^[ \t]*Passed![ \t]+-[ \t]+Failed:[ \t]+0,[ \t]+Passed:[ \t]+[1-9]/, // dotnet test
  /^(?:\[\w+\][ \t]+)?Tests run: [1-9]\d*, Failures: 0, Errors: 0\b/, // mvn (surefire)
  /^ok \| [1-9]\d* passed\b/, // deno test
]);

/** A failing run's summary line, or the mark of one failed test. */
export const TEST_FAIL = anyOf([
  counts('failed|failing|fail|errors?'),
  /^[ \t]*(?:Tests?|Test Files|Test Suites):?[ \t](?:[^\n]*?[ \t])?[1-9]\d* failed\b/, // vitest, jest
  /^[ \t]*Errors[ \t]+[1-9]\d* errors?\b/, // vitest: unhandled errors
  /^[ \t]*FAIL(?:[ \t]|$)/, // jest, vitest, tap: a failing file; go
  /^--- FAIL\b/, // go test
  /^[ \t]*not ok \d+\b(?![^\n]*#[ \t]*[Tt][Oo][Dd][Oo])/, // TAP; a TODO is no failure
  /^Bail out!/, // TAP
  /^# fail[ \t]+[1-9]/, // TAP counts
  /^(?:Asserts|Suites):[ \t]+\d+ pass[ \t]+[1-9]\d* fail\b/, // tap
  /^test result: FAILED\./, // cargo
  /^FAILED[ \t]+\S+::/, // pytest: a failed test id
  /^FAILED \([a-z ]+=\d+/, // unittest
  /^[ \t]*(?:\d+ [a-z]+, )*\d+ (?:examples?|tests?), [1-9]\d* failures?\b/, // rspec, mix test
  /^[ \t]*\d+ examples?, \d+ failures?, [1-9]\d* errors? occurred\b/, // rspec: an error outside the examples
  /^\d+ runs?, \d+ assertions?, (?:[1-9]\d* failures?|\d+ failures?, [1-9]\d* errors?)\b/, // minitest (rake test)
  /^(?:FAILURES|ERRORS)!/, // phpunit
  /^\d+% tests passed, [1-9]\d* tests? failed\b/, // ctest
  /^[ \t]*Failed![ \t]+-[ \t]+Failed:[ \t]+[1-9]/, // dotnet test
  /^(?:\[\w+\][ \t]+)?Tests run: \d+, Failures: (?:[1-9]\d*, Errors: \d+|\d+, Errors: [1-9])/, // mvn (surefire)
  /^> Task \S*:test FAILED\b/, // gradle
  /^FAILED \| \d+ passed\b[^\n]*\| [1-9]\d* failed\b/, // deno test
]);

export type Outcome = 'toolFail' | 'testPass' | 'testFail';
export type Reaction = { pose: Pose; line: LineEvent; confetti: boolean };

export const REACTIONS: Record<Outcome, Reaction> = {
  toolFail: { pose: 'oops', line: 'toolFail', confetti: false },
  testPass: { pose: 'yay', line: 'testPass', confetti: true },
  testFail: { pose: 'oops', line: 'testFail', confetti: false },
};

// Where a shell command starts: a line start or after `;` `&` `|` `(`, past any
// `VAR=value`, a launcher (`npx`, `pnpm exec`, `bundle exec`, `uv run`, `timeout 60`, ...)
// with its flags, and a path (`./gradlew`, `vendor/bin/phpunit`). So `cat jest.config.js`
// or `echo "npm test"` runs no test runner.
const AT_COMMAND = String.raw`(?:^|[;&|(])[ \t]*(?:(?:[A-Za-z_]\w*=\S*|(?:npx|bunx|npm[ \t]+exec|pnpm(?:[ \t]+(?:exec|dlx))?|yarn(?:[ \t]+(?:exec|dlx))?|bundle[ \t]+exec|uv[ \t]+run|poetry[ \t]+run|pipenv[ \t]+run|time|env|timeout[ \t]+\S+)(?:[ \t]+-[\w=-]+)*)[ \t]+)*(?:[\w.~/-]*\/)?`;
const RUNNERS = [
  String.raw`(?:npm|pnpm|yarn|bun)(?:[ \t]+[^\s;&|]+)*?[ \t]+(?:run[ \t]+)?test(?:[:-][\w:.-]+)?`, // npm test, pnpm -r test, npm run test:unit
  String.raw`vitest|jest|mocha|ava|tap|pytest|rspec|phpunit|ctest`,
  String.raw`python(?:3(?:\.\d+)?)?[ \t]+-m[ \t]+(?:pytest|unittest)`,
  String.raw`(?:go|cargo|mix|dotnet|deno|rake|rails)[ \t]+test|cargo[ \t]+nextest`,
  String.raw`(?:mvnw?|gradlew?)(?:[ \t]+[^\s;&|]+)*?[ \t]+(?:[^\s;&|]*:)?test`, // mvn -q test, ./gradlew :app:test
];

/** A shell command that runs a test runner: only its output is read as a test result. */
export const TEST_RUNNER = new RegExp(String.raw`${AT_COMMAND}(?:${RUNNERS.join('|')})(?=[ \t;&|)]|$)`, 'm');

/**
 * How much of a command TEST_RUNNER reads: its launcher star and lazy token
 * loop are quadratic on one long line of runner-like words (80 KB of `pnpm `
 * takes seconds, on the Bash tool path), so it reads the head only, where a
 * test command starts.
 */
export const COMMAND_CAP = 4096;

/** Terminal color codes, which a forced-color runner prints around its counts. */
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** `command`: the Bash command; its output is a test result only when it runs a test runner. */
export type ToolCall = { tool: string; isError: boolean; denied: boolean; output: string; command?: string };

/**
 * A denied or failed call is `toolFail`; the output of a Bash test runner
 * (TEST_RUNNER, on the command's first COMMAND_CAP characters), color codes
 * stripped, with a fail summary line is `testFail`, with a pass one and no fail
 * one `testPass`; any other command's output is no test result.
 */
export function classifyToolCall(c: ToolCall): Outcome | null {
  if (c.denied) return 'toolFail';
  if (c.tool === 'Bash' && TEST_RUNNER.test((c.command ?? '').slice(0, COMMAND_CAP))) {
    const out = c.output.replace(ANSI, '');
    if (TEST_FAIL.test(out)) return 'testFail';
    if (TEST_PASS.test(out)) return c.isError ? 'toolFail' : 'testPass';
  }
  return c.isError ? 'toolFail' : null;
}

const OUTPUT_CAP = 20000;

/**
 * The text a tool call produced: core's `text` when it is a string, else the
 * string fields of `result` (stdout, stderr, ...). The tail is kept, where a
 * test runner prints its summary.
 */
export function toolOutput(r: { text?: unknown; result?: unknown }): string {
  let out = '';
  if (typeof r.text === 'string') out = r.text;
  else if (typeof r.result === 'string') out = r.result;
  else if (typeof r.result === 'object' && r.result !== null) {
    out = Object.values(r.result as Record<string, unknown>).filter((v): v is string => typeof v === 'string').join('\n');
  }
  return out.length > OUTPUT_CAP ? out.slice(-OUTPUT_CAP) : out;
}

/** The shell command of a Bash call: `e.command`, or `e.input.command`. */
export function bashCommand(e: { command?: unknown; input?: unknown }): string {
  if (typeof e.command === 'string') return e.command;
  const input = e.input as { command?: unknown } | undefined;
  return typeof input?.command === 'string' ? input.command : '';
}
