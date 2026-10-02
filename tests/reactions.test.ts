import { describe, expect, test } from 'vitest';
import { COMMAND_CAP, REACTIONS, TEST_FAIL, TEST_PASS, bashCommand, classifyToolCall, toolOutput } from '../plugins/buddy/src/reactions.ts';

const bash = (output: string, isError = false) => ({ tool: 'Bash', isError, denied: false, output, command: 'npm test' });

describe('the test patterns', () => {
  test.each(['12 passed', '3 passing', 'ok  \tgithub.com/x/y\t0.2s', 'PASS src/a.test.ts', 'Tests: 5 passed, 5 total', 'Test: 1 passed'])('pass: %s', (s) => {
    expect(TEST_PASS.test(s)).toBe(true);
  });
  test.each(['2 failed', '1 failing', 'FAIL src/a.test.ts', '--- FAIL: TestX', 'FAILED tests/test_a.py::t'])('fail: %s', (s) => {
    expect(TEST_FAIL.test(s)).toBe(true);
  });
  test.each(['3 passed; 0 failed', 'test result: ok. 3 passed; 0 failed; 0 ignored', '10 passed, 0 failing'])('a zero count is not a fail: %s', (s) => {
    expect(TEST_FAIL.test(s)).toBe(false);
  });
  test.each(['0 passing', 'Tests: 0 passed, 0 total'])('a zero count is not a pass: %s', (s) => {
    expect(TEST_PASS.test(s)).toBe(false);
  });
  test.each(['passed the salt', 'PASSWORD', 'notok x', 'failed to connect', 'a FAILURE'])('neither: %s', (s) => {
    expect(TEST_PASS.test(s)).toBe(false);
    expect(TEST_FAIL.test(s)).toBe(false);
  });
});

describe('classifyToolCall', () => {
  test.each(['npm test', 'pnpm test', 'yarn test', 'npx vitest run', 'jest --ci', 'pytest -q', 'python -m pytest', 'python3 -m unittest', 'go test ./...', 'cargo test', 'rspec', 'bundle exec rspec', 'mix test', 'dotnet test', 'mvn test', './gradlew test', 'cd app && npm run test'])('a test runner reacts: %s', (cmd) => {
    expect(classifyToolCall({ tool: 'Bash', isError: false, denied: false, output: '12 passed', command: cmd })).toBe('testPass');
  });
  test.each([['git log', 'abc123 fix: FAILED tests/test_a.py::t'], ['grep -r FAILED .', 'notes.md: FAILED once'], ['ls', 'ok_file.txt\nok stuff'], ['echo hi', '12 passed']])('any other command never reacts as a test: %s', (cmd, out) => {
    expect(classifyToolCall({ tool: 'Bash', isError: false, denied: false, output: out, command: cmd })).toBe(null);
  });
  test('failing TAP (not ok N) is never a pass', () => {
    expect(classifyToolCall({ tool: 'Bash', isError: false, denied: false, output: 'TAP version 13\nok 1 - a\nnot ok 2 - b\n1..2', command: 'npm test' })).toBe('testFail');
  });
  test.each(['12 examples, 0 failures', 'Finished in 0.1 seconds\n1 example, 0 failures, 1 pending', 'Ran 3 tests in 0.002s\n\nOK', 'Ran 1 test in 0.1s\nOK (skipped=1)'])('rspec and unittest passes: %j', (s) => {
    expect(classifyToolCall(bash(s))).toBe('testPass');
  });
  test.each(['12 examples, 2 failures', '1 example, 1 failure', 'Ran 3 tests in 0.002s\n\nFAILED (failures=1)'])('rspec and unittest fails: %j', (s) => {
    expect(classifyToolCall(bash(s))).toBe('testFail');
  });
  test.each(['OK', 'all OK here', '0 examples, 0 failures', 'Ran 3 tests in 0.002s', 'Ran 3 tests in 0.002s\nOKAY'])('no summary, no reaction: %j', (s) => {
    expect(classifyToolCall(bash(s))).toBe(null);
  });
  test('a cargo run with 0 failed is a pass', () => {
    expect(classifyToolCall(bash('test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured'))).toBe('testPass');
  });
  test('a denial or an error is toolFail', () => {
    expect(classifyToolCall({ tool: 'Edit', isError: false, denied: true, output: '' })).toBe('toolFail');
    expect(classifyToolCall({ tool: 'Read', isError: true, denied: false, output: '' })).toBe('toolFail');
  });
  test('Bash test output: pass, fail, fail over pass', () => {
    expect(classifyToolCall(bash('Tests  12 passed (12)'))).toBe('testPass');
    expect(classifyToolCall(bash('3 failed, 9 passed', true))).toBe('testFail');
    expect(classifyToolCall(bash('ok\nFAIL x'))).toBe('testFail');
  });
  test('a pass pattern in a failed call is a tool failure', () => {
    expect(classifyToolCall(bash('5 passed\nsegfault', true))).toBe('toolFail');
  });
  test('only Bash is read for tests; plain success is nothing', () => {
    expect(classifyToolCall({ tool: 'Read', isError: false, denied: false, output: '12 passed' })).toBeNull();
    expect(classifyToolCall(bash('hello'))).toBeNull();
  });
  test('the table: testPass is yay with confetti, the failures oops', () => {
    expect(REACTIONS.testPass).toEqual({ pose: 'yay', line: 'testPass', confetti: true });
    expect(REACTIONS.testFail.pose).toBe('oops');
    expect(REACTIONS.toolFail.pose).toBe('oops');
  });
});

describe('toolOutput and bashCommand', () => {
  test("core's text, else the result's strings, the tail kept", () => {
    expect(toolOutput({ text: 'T', result: { stdout: 'S' } })).toBe('T');
    expect(toolOutput({ result: { stdout: 'out', stderr: 'err', code: 1 } })).toBe('out\nerr');
    expect(toolOutput({ result: 'plain' })).toBe('plain');
    expect(toolOutput({})).toBe('');
    expect(toolOutput({ text: 'x'.repeat(25000) + 'END' }).endsWith('END')).toBe(true);
    expect(toolOutput({ text: 'x'.repeat(25000) }).length).toBe(20000);
  });
  test('e.command, or e.input.command', () => {
    expect(bashCommand({ command: 'ls' })).toBe('ls');
    expect(bashCommand({ input: { command: 'pwd' } })).toBe('pwd');
    expect(bashCommand({})).toBe('');
  });
});

describe("a runner's summary lines, and nothing else, are its result", () => {
  const run = (command: string, output: string, isError = false) => classifyToolCall({ tool: 'Bash', isError, denied: false, output, command });

  test.each([
    'bun test', 'bun run test', 'npm run test', 'npm run test:unit', 'vitest run', 'npx jest', 'npx --yes vitest', 'mocha', 'npx mocha test/', 'ava', 'tap test/*.js',
    'rake test', 'bundle exec rake test', 'gradle test', './gradlew :app:test', 'deno test -A', 'phpunit', './vendor/bin/phpunit', 'ctest --output-on-failure',
    'CI=1 npm test', 'npm test 2>&1 | tail -20', 'pnpm --filter web test', 'uv run pytest', 'timeout 60 go test ./...', '(cd api && cargo test)', './mvnw -q test',
    'claude plugin test plugins/x', "bash -c 'go test ./...'", 'sh -c "npm test"', "bash -lc 'cd api && cargo test'", "scripts/dev.sh run 'go test ./...'", "docker exec app sh -c 'pytest -q'", 'go -C sub test ./...',
  ])('a runner: %s', (cmd) => {
    expect(run(cmd, '12 passed')).toBe('testPass');
  });
  test.each(['cat jest.config.js', 'grep -rn vitest src', 'echo "npm test"', 'git log --grep "go test"', 'grep -c "npm test" notes.md', 'echo "run go test"', 'ls pytest.ini', 'mvn -DskipTests package', 'mvn test-compile', 'npm run build', 'npm install'])(
    'not a runner: %s',
    (cmd) => {
      expect(run(cmd, '12 passed')).toBeNull();
    },
  );

  test('a go test run quoted inside a container wrapper, piped to tail, is read as a test run', () => {
    const command = `cd w; scripts/dev.sh run 'go -C app test -count=1 -run "TestA|TestB" ./cmd/app/ 2>&1 | tail -12' </dev/null 2>&1 | tail -14`;
    expect(run(command, 'container: ready\n--- FAIL: TestA (0.00s)\nFAIL\nFAIL\tex.com/app/cmd/app\t0.8s\nFAIL\n\nall steps passed.')).toBe('testFail');
  });
  test.each([
    ['git log', 'abc123 fix: retry when upload FAILED'],
    ['grep -rn FAILED src', 'src/a.ts:12: if (s === "FAILED")'],
    ['./deploy.sh', 'Attempt 1 failed, retrying'],
    ['env', 'DB_HOST=x\nPASS=hunter2'],
    ['ls', 'ok.txt\nok notes.md'],
  ])('the audit rows count as nothing (%s)', (cmd, out) => {
    expect(run(cmd, out)).toBeNull();
  });
  test.each([
    'abc123 fix: retry when upload FAILED',
    'src/a.ts:12: if (s === "FAILED")',
    'Attempt 1 failed, retrying',
    'DB_HOST=x\nPASS=hunter2',
    'ok.txt\nok notes.md',
    '  1 failed login, retried',
  ])("stray words inside a runner's output count as nothing: %j", (out) => {
    expect(run('npm test', out)).toBeNull();
  });

  test.each([
    ['vitest', ' Test Files  1 passed (1)\n      Tests  63 passed (63)'],
    ['vitest', '\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m12 passed\u001b[39m\u001b[22m\u001b[90m (12)\u001b[39m'],
    ['jest', 'PASS src/a.test.ts\nTests:       5 passed, 5 total'],
    ['pytest', '============ 3 passed, 1 warning in 0.12s ============'],
    ['pytest -q', '....\n3 passed in 0.01s'],
    ['mocha', '  3 passing (5ms)\n  1 pending'],
    ['ava', '  3 tests passed'],
    ['tap', 'TAP version 13\nok 1 - a\nnot ok 2 - b # TODO later\n1..2'],
    ['tap', 'Asserts:  3 pass  0 fail  3 of 3 complete'],
    ['go test ./...', '?   \tpkg/a\t[no test files]\nok  \tpkg/b\t0.2s'],
    ['go test ./...', 'ok  \tpkg/b\t(cached)'],
    ['cargo test', 'test result: ok. 3 passed; 0 failed; 0 ignored\n   Doc-tests x\ntest result: ok. 0 passed; 0 failed'],
    ['rake test', '3 runs, 5 assertions, 0 failures, 0 errors, 0 skips'],
    ['mix test', 'Finished in 0.03 seconds\n1 doctest, 3 tests, 0 failures'],
    ['python -m unittest', '----\nRan 12 tests in 0.004s\n\nOK (skipped=1)'],
    ['dotnet test', 'Passed!  - Failed:     0, Passed:    12, Skipped:     0, Total:    12, Duration: 1 s - A.dll (net8.0)'],
    ['mvn test', '[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS'],
    ['deno test', 'ok | 3 passed | 0 failed (15ms)'],
    ['phpunit', 'OK (12 tests, 30 assertions)'],
    ['ctest', '100% tests passed, 0 tests failed out of 12'],
    ['bun test', ' 3 pass\n 0 fail\n 3 expect() calls\nRan 3 tests across 1 files. [10.00ms]'],
  ])('%s passes: %j', (cmd, out) => {
    expect(run(cmd, out)).toBe('testPass');
  });

  test.each([
    ['vitest', ' FAIL  tests/a.test.ts > adds\n      Tests  1 failed | 62 passed (63)'],
    ['vitest', '      Tests  63 passed (63)\n      Errors  1 error'],
    ['jest', 'Tests:       1 failed, 4 passed, 5 total'],
    ['pytest', '====== 1 failed, 2 passed in 0.12s ======'],
    ['pytest', '====== 2 passed, 1 error in 0.12s ======'],
    ['mocha', '  2 passing (5ms)\n  1 failing'],
    ['ava', '  2 tests passed\n  1 test failed'],
    ['tap', 'not ok 1 - adds\nok 2 - subs'],
    ['tap', 'ok 1 - a\nBail out! db down'],
    ['tap', 'Asserts:  2 pass  1 fail  3 of 3 complete'],
    ['go test ./...', '--- FAIL: TestX (0.00s)\nFAIL\nFAIL\tpkg\t0.2s'],
    ['cargo test', 'test result: FAILED. 2 passed; 1 failed; 0 ignored'],
    ['rspec', '12 examples, 2 failures'],
    ['rspec', '0 examples, 0 failures, 1 error occurred outside of examples'],
    ['rake test', '3 runs, 5 assertions, 1 failures, 0 errors, 0 skips'],
    ['rake test', '3 runs, 5 assertions, 0 failures, 1 errors, 0 skips'],
    ['mix test', '3 tests, 1 failure'],
    ['python -m unittest', 'Ran 3 tests in 0.002s\n\nFAILED (errors=1)'],
    ['dotnet test', 'Failed!  - Failed:     1, Passed:    11, Skipped:     0, Total:    12'],
    ['mvn test', '[ERROR] Tests run: 12, Failures: 1, Errors: 0, Skipped: 0'],
    ['gradle test', '3 tests completed, 1 failed\n> Task :test FAILED'],
    ['deno test', 'FAILED | 2 passed | 1 failed (20ms)'],
    ['phpunit', 'FAILURES!\nTests: 12, Assertions: 30, Failures: 1.'],
    ['ctest', '83% tests passed, 2 tests failed out of 12'],
    ['bun test', ' 2 pass\n 1 fail\nRan 3 tests across 1 files.'],
  ])('%s fails: %j', (cmd, out) => {
    expect(run(cmd, out)).toBe('testFail');
  });

  test.each([
    ['go test ./...', 'testing: warning: no tests to run\nPASS\nok  \tpkg\t0.1s [no tests to run]'],
    ['cargo test', 'test result: ok. 0 passed; 0 failed; 0 ignored'],
    ['tap', 'not ok 1 - later # TODO not built'],
    ['tap', 'ok 1 - a # SKIP no db\n1..1'],
    ['python -m unittest', 'Ran 0 tests in 0.000s\n\nOK'],
    ['phpunit', 'No tests executed!'],
    ['mvn test', '[INFO] Tests run: 0, Failures: 0, Errors: 0, Skipped: 0'],
    ['bun test', ' 0 pass\n 0 fail'],
    ['gradle test', 'BUILD SUCCESSFUL in 3s'],
  ])('%s with no counted pass is no result: %j', (cmd, out) => {
    expect(run(cmd, out)).toBeNull();
  });

  test('a long run of blank lines after `Ran N tests` stays fast', () => {
    const t = Date.now();
    expect(run('python -m unittest', 'Ran 3 tests in 0.1s' + '\n'.repeat(40) + 'X')).toBeNull();
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe('the test-runner check stays fast on a long command', () => {
  const run = (command: string) => classifyToolCall({ tool: 'Bash', isError: false, denied: false, output: '3 passed', command });
  // The budget separates the capped read from an uncapped one, not a fast machine from a slow one:
  // the regex is still quadratic within COMMAND_CAP (up to ~35 ms idle, up to 130 ms beside concurrent
  // test runs), while reading the whole 80 KB takes 1.3-2.4 s here. A 50 ms budget failed 9 times in
  // 36 loaded runs.
  test.each(['pnpm ', 'yarn exec ', 'mvn '])('80 KB of %j runs in under 400 ms', (token) => {
    const command = token.repeat(Math.ceil(80_000 / token.length));
    const t0 = performance.now();
    run(command);
    expect(performance.now() - t0).toBeLessThan(400);
  });
  test('only the first COMMAND_CAP characters are read for a runner', () => {
    const inside = `echo ${'x'.repeat(COMMAND_CAP - 'echo ; npm test'.length)}; npm test`;
    expect(inside).toHaveLength(COMMAND_CAP);
    expect(run(inside)).toBe('testPass');
    expect(run(`echo x${inside.slice('echo '.length)}`)).toBe(null); // one character later, `npm test` ends past the cap
  });
  test('a runner at the start of a long command is still found', () => {
    expect(run(`npm test && echo ${'x'.repeat(80_000)}`)).toBe('testPass');
    expect(run(`cat <<'EOF'\n${'pnpm '.repeat(16_000)}\nEOF`)).toBe(null);
  });
});
