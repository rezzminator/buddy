# Getting help

- **Quack does not show up.** Check the [FAQ](./README.md#-faq) first: function
  hooks must be on (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, best in the `env`
  block of `~/.claude/settings.json`) before Claude Code starts; with them
  off, a new session prints `buddy is off: …`. The character draws only in
  the terminal and the desktop app.
- **A question about using buddy or writing a character.**
  [Open an issue](https://github.com/rezzminator/buddy/issues/new/choose)
  with the Question template; [CONTRIBUTING.md](./CONTRIBUTING.md) covers
  the character format.
- **A bug.** Use the bug report template; include `claude --version`, the buddy
  version, what the bubble said, if anything, and the reply of `/buddy log`
  (it never holds your account id).
- **A security problem.** Follow [SECURITY.md](./SECURITY.md), never a public
  issue.

