# Security policy

## Supported versions

Only the latest release of buddy gets security fixes. The current version is
in [CHANGELOG.md](./CHANGELOG.md).

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it
privately through GitHub's
[private vulnerability reporting](https://github.com/rezzminator/buddy/security/advisories/new)
(the repository's **Security** tab, **Report a vulnerability**).

Include what you found, the steps to reproduce it, the Claude Code version
(`claude --version`) and the buddy version.

## What buddy touches

Useful when judging impact:

- It reads Claude Code's config, `~/.claude.json` (or
  `$CLAUDE_CONFIG_DIR/.claude.json` when `CLAUDE_CONFIG_DIR` is set), and its
  ten newest backups, beside it and in `~/.claude/backups/` (or
  `$CLAUDE_CONFIG_DIR/backups/`), to recompute your original companion. It
  skips unfinished `.tmp.*` writes, empty files and files over 5 MB, and
  never writes any of them. Your account id is never shown, saved or logged.
- Its one shell hook, `hooks/function-hooks-check.sh`, runs when a session
  starts or resumes: when `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is unset it
  searches the config for Claude Code's function-hooks rollout flag, and it
  prints one line saying buddy is off, or nothing. It writes nothing.
- It reads the character JSON files in the folder the `customCharactersDir` option
  names.
- It makes model calls only through Claude Code itself: a `/buddy` question,
  and one short call at the end of each answered turn for the buddy's line
  and the prompt suggestion, on `model` (default `opus`) at `effort`
  (default `low`) and sent its memory and the chat's last `chatTurnsToRead` turns (default 3) (`commentAfterEachTurn` and `suggestNextPrompt`, on by default; turn
  both off for none). There is no buddy server.

It writes two things, and nothing else:

- **Its own Claude Code plugin store:** the memory of the last 20 sessions
  (per character, its recent exchanges: a `/buddy` question with its
  answer, or the question alone if it got none, or one line it said;
  nothing when `rememberedExchanges` is 0), the picked character, the picked
  original companion's soul (its name and personality) and which install's
  roll you chose, the pet count, and whether it is hidden.
- **The log file**, unless `logFile` is empty: by default
  `~/.claude/buddy/buddy.log` (`$CLAUDE_CONFIG_DIR/buddy/buddy.log` when
  `CLAUDE_CONFIG_DIR` is set; a path you set is used with `~` and a leading `$CLAUDE_CONFIG_DIR` expanded), one JSON line
  per record, with one rotation, `buddy.log.1`, past 1 MB.
  One JSON line per record: every failure with its message and stack; at
  `info` (the default) also session starts, commands (their kind and length,
  never their text), each question's outcome, quips and menu picks; at
  `debug` also the question text, the first 80 characters of each model
  answer, and band decisions. It never holds your account identity or any
  content of `~/.claude.json`.
