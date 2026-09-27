<div align="center">

# buddy

**Claude Code buddy plugin: Quack the ASCII duck waddles above your prompt and talks back — or bring back your /buddy**

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)](https://docs.claude.com/en/docs/claude-code/plugins)
[![Version](https://img.shields.io/badge/version-0.3.0-blue)](./CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![CI](https://github.com/rezzminator/buddy/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/rezzminator/buddy/actions/workflows/ci.yml)
[![Built with Professor](https://img.shields.io/badge/built%20with-Professor-8A2BE2)](https://github.com/rezzminator/professor)

[Quick start](#-quick-start) · [Characters](#-characters) · [Docs](docs/design/_index.md) · [Changelog](./CHANGELOG.md) · [Help](#-help)

</div>

Meet **Quack**, a sarcastic little duck with a sharp tongue, waddling through
your code with smug confidence. It lives on the line right above your Claude
Code prompt:

```text
    .-.            *  .-.           ╭───────────────────────────────────╮
\__( x)=          \__( x)=          │ QUACK! All green, like pond weed. │
 \____)            \_\/_)           ╰───────────────────────────────────╯
 L   L              L  L
walking           tests pass

    .-.  Z            .-. !         ╭─────────────────────────────────────────────╮
\__( -)=          \__( x)<          │ That one splashed. Let's dry off and retry. │
 \____)            \____)           ╰─────────────────────────────────────────────╯
~~~~~~~~            L  L
after midnight    a tool fails
```

Every line in those bubbles is one of Quack's own; its art and its lines live
in [`plugins/buddy/characters/duck.json`](./plugins/buddy/characters/duck.json).

---

## 🦆 Why buddy

Claude Code once shipped `/buddy`, a companion that sat beside the prompt
and commented on your work in a speech bubble. It worked up to version
2.1.96; version 2.1.97 removed it.

**buddy** brings a companion back as a plugin. It lives inside Claude Code's
own interface, on the line right above the prompt, sees every tool call as it
happens, and answers you through Claude Code's own model calls: it needs no
server of its own.

- 🚶 **A duck on your prompt line.** Quack walks back and forth above the
  prompt, stops now and then to rest, stands still while Claude works, and
  falls asleep after midnight.
- 🎉 **Reacts to the work.** A test run passing in a Bash command gets a
  cheer and a burst of confetti; a failing one, or a failed or denied tool
  call, gets an "oops".
- 💬 **Talks back, and remembers.** `/buddy why is this slow?` gets a
  one-line answer, in character, that says what you and Claude both
  missed. By default it is one fast call that sees the chat's last 3 turns;
  `questionMode: fork` forks this chat instead: the same model, the whole
  conversation in view, served from its prompt cache. It keeps your last few exchanges (the `memory` option) for its
  next answer.
- 🐣 **Your own buddy, back.** `/buddy-personality` opens a menu with a
  live preview; its "Yours" group recomputes the companion Claude Code
  hatched for your account (species, rarity, eyes, hat, stats) with the name
  and personality it saved.
- 🤫 **Free unless you ask.** Walking, petting, switching and reactions never
  call a model. Only a question you ask, and one short call at the end of
  each answered turn for the buddy's line and the prompt suggestion (on by
  default; `quips: false` and `suggestions: false` turn them off), spend tokens.
- 🛡️ **Never in the way.** A character that fails to load is replaced by the
  duck, who says why; a hook that fails logs the error and steps aside.
  `/buddy off` hides it, and it stays hidden across restarts.

Quack is the default. buddy also ships the Professor, a cat, a robot, a
ghost, a dragon and a yellow duck, and draws your own characters from a folder of JSON
files (see [Characters](#-characters)).

## 🚀 Quick start

1. Turn on function hooks: add this `env` block to `~/.claude/settings.json`
   (merged into the object already there), so every new terminal has them.

   ```json
   { "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
   ```

   Or export it in your shell, `export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`;
   an export vanishes in the next terminal.

2. Install:

   ```sh
   claude plugin marketplace add rezzminator/buddy
   claude plugin install buddy@buddy
   ```

Start a new session and Quack walks in above your prompt; type `/buddy` to
pet it.

After installing, Claude Code may print `N userConfig options not yet set —
run /plugin configure`. You can ignore it: every buddy option has a default,
so nothing needs setting and buddy works as installed. Use
`/plugin configure` only to change a default.

If function hooks are off, buddy says so when a session starts or resumes:
`buddy is off: … Add "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } to
~/.claude/settings.json, then start a new session.` (with `CLAUDE_CONFIG_DIR`
set it names `$CLAUDE_CONFIG_DIR/settings.json`). The line goes away once
the variable is set.

> **Early access.** buddy is built on Claude Code's function hooks, an
> early-access surface that may change between releases. A plugin built on
> function hooks cannot enter the official plugin directory, so buddy
> installs from this repository's own marketplace, as above. It is tested on
> Claude Code 2.1.283.

> **Where it shows.** The line above the prompt exists in Claude Code in the
> terminal and in the desktop app. The VS Code extension and mobile do not
> draw it, so there the character never appears.

## 🧭 Commands

| Command | What it does |
| --- | --- |
| `/buddy` | Pet it: a happy pose, a line, and the count so far (`Quack: 3 pets`). |
| `/buddy off` / `/buddy on` | Hide or show it, remembered across restarts and shared with your other sessions. |
| `/buddy reload` | Rescan the characters, after you edit one. |
| `/buddy help` | Usage, then every option that was ignored or capped, and why. |
| `/buddy log` | The log file's path and its last 20 lines, to paste into an issue. |
| `/buddy list` / `/buddy use {id}` | `Switching characters moved to /buddy-personality.` — no model call. |
| `/buddy {anything else}` | A question: it thinks, then answers in one line, in character (see `questionMode`). While hidden it replies `{name} is hidden; /buddy on first`. |
| `/buddy-personality` | The one place to see every character and switch: a menu with a live preview, `*` on the current one, `(invalid)` on one that failed to load; Enter switches and remembers it, Esc closes (see [Pick a personality](#-pick-a-personality)). |

## 🎭 Characters

| id | |
| --- | --- |
| `duck` | Quack: a sarcastic little duck with a sharp tongue, waddling through your code with smug confidence. The default. |
| `professor` | A warm, precise professor with a cup of tea. |
| `cat` | An aloof cat who supervises your terminal and pretends not to care. |
| `robot` | A literal little robot on one wheel that reports exactly what happened. |
| `ghost` | A gentle ghost that drifts along your prompt line, softly spooky. |
| `dragon` | A very small dragon with very large pride, guarding your code. |
| `yellow-duck` | A listening duck: explain your bug out loud, get a quack back. |

The choice is, in order: your last pick in `/buddy-personality`, then the
`character` option, then `duck`. Your own characters sit beside these, and one with
a built-in's id replaces it. The id `original` is reserved for your original
companion: a file that takes it is refused, never drawn, with an error
naming the file in the Your folder group of `/buddy-personality`, and in
the bubble when a session starts and after `/buddy reload`.

## 🐣 Pick a personality

`/buddy-personality` opens a menu in a pane above the prompt: the entries on
the left, a live preview of the highlighted one on the right.

- **Shipped**: the characters that come with the plugin.
- **Yours**: the companion Claude Code's own `/buddy` hatched for your
  account, when Claude Code's config still holds its name and personality,
  or one of its ten newest backups does. The config is `~/.claude.json`, its
  backups beside it and in `~/.claude/backups/`; with `CLAUDE_CONFIG_DIR`
  set, `$CLAUDE_CONFIG_DIR/.claude.json` and `$CLAUDE_CONFIG_DIR/backups/`
  instead. Only real backups count: an unfinished `.tmp.*` write, an empty
  file or one over 5 MB is skipped. It is listed
  twice, as the native install and as the npm install rolled it: the two
  turned your account id into a different species, eyes, hat and stats, and
  the preview lets you recognise yours.
- **Your folder**: your own characters, from the `characterDir` option.

↑ and ↓ move the highlight, and the preview follows: the sprite in its idle
animation, the name, its description (for your original, its saved personality) and a greeting in its voice;
for your original companion also its rarity stars, shiny, the five stats as
bars (`SNARK     ████████░░ 81`) and the day it hatched. `*` marks the one
drawn now. Enter switches to the highlighted one and remembers it: it is still there
after `/reload` and a restart. Esc
closes the menu and changes nothing.

The menu only reads the config and its backups; it never writes them. A file it cannot
read shows as one line in the "Yours" group, saying why. Your account id is
never shown, saved or logged. To go back to your usual character, pick it
in the menu: the `character` option's one is listed under Shipped, or under
Your folder when it is your own.

## 🧠 How it works

The full design, decision by decision, lives in [docs/design](docs/design/_index.md).

- **Walking.** The character steps one column every `stepMs` (200 ms unless
  the character says otherwise), turns at the edge, and rests now and then.
  It stops walking while a bubble is up. With the `motion` option off, or a
  character that does not walk, it stands still and its frames still
  animate.
- **While Claude works** it draws its `working` pose and stands still. From
  midnight to 6 am, after a minute with nothing happening, it falls asleep
  with a `z Z` drifting above it; anything that happens wakes it up.
- **Reactions.** A tool call that fails or is denied: the `oops` pose and a
  line. The output of a Bash command that runs a test runner (npm/pnpm/yarn/bun
  test, vitest, jest, mocha, ava, tap, pytest, unittest, go test, cargo test
  or nextest, rspec, rake or rails test, mix test, dotnet test, mvn/gradle
  test, deno test, phpunit, ctest) is read from its summary lines: a pass (a count of zero
  never passes) gives the `yay` pose, a line and two seconds of confetti; a
  failure gives the `oops` pose and a line. A failure always wins, and any
  other command's output never counts as a test. Not recognised yet: a
  gradle pass (gradle prints no count), `make test`, a runner inside docker
  or `bash -c`, and `node --test`.
- **The bubble** holds one line, wrapped to fit a rounded box beside the
  character, opening toward the free side. A line stays 6 seconds, a model
  answer 15. Below 40 columns the bubble is drawn above the sprite, across
  the whole width, and the confetti is left out; a window too narrow for the
  sprite shows the bubble alone. A long bubble is cut with `…` to fit the
  rows it has. Text is measured in terminal cells, so CJK text and emoji
  line up; if your terminal draws East Asian ambiguous-width characters two
  columns wide, as a CJK locale often does, set `ambiguousWidth` to `wide`.
- **Hover card.** Hover over the character to see its name, description,
  pets, mood and the questions asked this session. It needs a terminal that
  reports the mouse; elsewhere the card never shows.
- **Questions.** In `complete` mode (the default) `/buddy {question}` is
  one fast call on `quipModel` (default `opus`) at the `effort` option's
  level (default `low`), with the character's persona, the character rule,
  its memory and the chat's last 3 turns (each of your prompts' last 1500
  characters and each of Claude's answers' last 3000), answered at once,
  even while Claude is busy mid-turn. The character rule tells it to become
  the character completely and say one useful thing that both you and
  Claude missed in those turns: a risk, a gap, a wrong assumption, a better
  next step; the character decides how it is said, never what is true. In
  `fork` mode `/buddy {question}` replays
  this chat's own request with the question added, so it runs on the chat's
  model, sees the whole conversation, and reads the prefix from the chat's
  prompt cache instead of writing it again. Only the fork answers: in a long
  chat that can take a minute. A question asked while Claude is busy
  mid-turn, when a fork would only continue that turn, waits for the turn
  to end, however it ends, then forks. Before the chat's first reply there
  is nothing to fork, and the bubble says `nothing to fork yet: ask again
  after Claude's first reply`. `off` turns questions off. Every question
  ends in the bubble: its
  answer, or `{name} couldn't answer: {reason}`, such as `api-error 529` or
  `no answer in 180 s`: a fork has 180 seconds from when it starts (never
  counting the wait for the turn), a `complete` question 90, and the
  thinking line stays up until the answer, the failure or the deadline. The
  deadline ends the question, not a fork already sent: Claude Code offers no
  way to cancel one, so it runs to its end and may still bill. An
  answer holds the bubble for its 15 seconds; a reaction or other line
  nobody asked for waits, and the latest one shows once it ends. An answer
  that arrives after you switched characters is dropped, never said by the
  new one. One
  question at a time: asking again before the answer gets `{name} is still
  thinking about your last question; ask again once it answers.`
- **The log.** buddy keeps its own log in `logFile` (default
  `~/.claude/buddy/buddy.log`, or `$CLAUDE_CONFIG_DIR/buddy/buddy.log` when
  `CLAUDE_CONFIG_DIR` is set; a path you set is used with `~` and a leading `$CLAUDE_CONFIG_DIR` expanded), one JSON
  line per record; a write another session overwrote is retried, and a record
  lost after the retries is reported, though two writes landing at the same instant can still drop one unseen; capped at 1 MB with one rotation (`buddy.log.1`). `logLevel` `error` writes failures
  only; `info`, the default, adds sessions, commands, questions and their
  outcomes, quips and menu picks; `debug` adds the question text and the
  model's result shapes. It never holds your account id or anything from
  `~/.claude.json`. `/buddy log` shows the path and the last 20 lines, to
  paste into an issue; an empty `logFile` writes no file.
- **Quips** (on by default). At the end of every answered turn, tool use or
  not, one short call on `quipModel` (at most 120 output tokens, a 30-second
  deadline, at the `effort` level) reads the chat's last 3 turns (your
  prompts and Claude's answers, each capped from its end) and the turn's
  tally (the tools it used, how many failed, the last Bash command) and
  writes the buddy's one-line reaction for the bubble, told the same
  character rule as a question. `quipCooldownSec`
  (default 0) spaces the lines out; `quips: false` keeps the buddy quiet. An
  aborted turn, or a subagent's, makes no call.
- **Prompt suggestions** (on by default). The same call also writes the
  prompt you are most likely to send next, in your own words, the
  character's persona deciding what it nudges toward; it shows as the
  prompt box's dim suggestion, Tab to take it. One call serves the line and
  the suggestion, never a fork of the chat. Claude Code's own suggestion is
  held back meanwhile and shown only when the buddy has none (it answers
  `NONE`, nothing, or not within 30 seconds); the next turn or `/buddy off`
  drops a late one. `suggestions: false` leaves Claude Code's own alone;
  with it on, turning off Claude Code's own prompt suggestions saves paying
  for both.
- **Errors are never silent.** A chosen character that is missing or invalid
  draws the duck with a bubble
  `Couldn't load {id}: {error}; /buddy-personality picks another` for 10
  seconds, and `/buddy-personality` marks it `(invalid)` with the error in
  its preview.

## ⚙️ Configuration

Set these through `/plugin configure`, or under `pluginConfigs["buddy@buddy"].options`
in `settings.json`. The key must be the full plugin id: Claude Code silently
ignores options under any other key. A value buddy cannot use is ignored by
name and its default kept (a `memory` above 30 is capped to 30): the first
greeting's bubble says so once, and `/buddy help` and the log list it.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `character` | string | `"duck"` | Character id (see /buddy-personality) |
| `characterDir` | directory | `""` | Folder of your own character JSON files |
| `motion` | boolean | `true` | Walk along the prompt line |
| `questionMode` | string | `"complete"` | /buddy questions: complete (fast, on quipModel at `effort`, seeing the chat's last 3 turns; answers at once), fork (only the chat's own model, context and cache answer; waits for a running turn), or off |
| `quips` | boolean | `true` | The buddy says a line at the end of every answered turn, from one short `quipModel` call that also writes the suggestion (spends tokens); `false` keeps it quiet |
| `quipModel` | string | `"opus"` | Model for the buddy's lines, suggestions and questions: the end-of-turn call and questions that do not fork. `inherit` follows the main chat's model, read at every call (`opus` when it cannot be read) |
| `effort` | string | `"low"` | How hard `quipModel` thinks on each of those calls: low, medium, high, xhigh, max or `inherit`; a fork keeps the chat's own. `inherit` uses the main chat's level, read at every call, when Claude Code exposes it (`CLAUDE_EFFORT`), and otherwise sends none, so the model's default applies |
| `quipCooldownSec` | number | `0` | Minimum seconds between the buddy's lines; 0 = every answered turn |
| `suggestions` | boolean | `true` | The buddy writes the prompt suggestion in the same end-of-turn call (spends tokens); Claude Code's own is held back and shown only when the buddy has none; `false` keeps Claude Code's own |
| `memory` | number | `6` | How many recent exchanges the buddy remembers (0 = off). Counts exchanges, not lines or tokens: an exchange is a /buddy question with its answer (or the question alone if it got none), one line the buddy said, or a next prompt it suggested that the prompt box showed. They go into its next answer or quip, kept per session and per character; at most 30 |
| `logLevel` | string | `"info"` | Log level: error, info or debug |
| `logFile` | string | `"$CLAUDE_CONFIG_DIR/buddy/buddy.log"` | Log file, one JSON line appended per record, capped at 1 MB with one rotation; a leading `$CLAUDE_CONFIG_DIR` is the config folder (`~/.claude` when the variable is unset), `~` is your home folder, any other path is used as given (empty = no log file) |
| `ambiguousWidth` | string | `"narrow"` | Ambiguous-width characters: narrow or wide; `wide` for a terminal that draws them two columns wide, as a CJK locale often does |

```json
{
  "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" },
  "pluginConfigs": {
    "buddy@buddy": {
      "options": { "characterDir": "/path/to/my-characters", "quips": true }
    }
  }
}
```

## 🎨 Your own character

A character is one JSON file, `{id}.json`, checked against
[`plugins/buddy/schema/character.schema.json`](./plugins/buddy/schema/character.schema.json).
Put yours in a folder, point `characterDir` at it, and `/buddy reload`.

| Field | Type | Req | Meaning |
| --- | --- | --- | --- |
| `$schema` | string | no | `"../schema/character.schema.json"` in built-ins |
| `id` | string, `^[a-z0-9][a-z0-9-]{0,31}$` | yes | unique, and not `original` (reserved); the id `/buddy-personality` stores |
| `name` | string ≤ 40 | yes | display name |
| `description` | string ≤ 100 | yes | one line for the menu's preview and the hover card |
| `author` | string ≤ 60 | no | credit |
| `persona` | string ≤ 1200 | yes | the character's voice prompt, 2nd person ("You are …") |
| `color` | Ink color name or `#rrggbb` | no | sprite color, default `"yellow"` |
| `poses` | object | yes | pose name → array of frames; frame = array of rows (strings) |
| `lines` | object | no | event name → array of canned one-liners (≤ 120 chars each) |
| `motion` | object | no | `walk` (bool, default true), `stepMs` (80–1000, default 200), `restChance` (0–0.2, default 0.02), `restTicks` (1–100, default 15) |

[CONTRIBUTING.md](./CONTRIBUTING.md) has the rest of the contract (the
poses and their fallbacks, the line events, the rules for the art), a
working example, how to test it, and how to send it in to ship with buddy.

## ❓ FAQ

<details>
<summary><b>Is this the <code>/buddy</code> that Claude Code removed?</b></summary>

No. buddy is an independent plugin, not a patch to Claude Code or a revival
of the removed code. You choose a character, and its reactions come from its
own lines and from your own model calls, not from a server. But the
"Yours" group of `/buddy-personality` does bring back the companion the
removed `/buddy` hatched for your account: the same species, rarity, eyes, hat and stats, recomputed
from your account id, with the name and personality Claude Code's config (`~/.claude.json`, or
`$CLAUDE_CONFIG_DIR/.claude.json`) kept.
</details>

<details>
<summary><b>Does it cost tokens?</b></summary>

Only when a model answers. Walking, reactions, petting and every command
except a question are local. A question in `complete` mode (the default)
sends `quipModel`, at the `effort` level, the question, the character's
persona, its memory and the ends of the chat's last 3 turns, never the rest
of the conversation; a question in `fork` mode runs on the chat's own model
and reads the conversation from its prompt cache, and one asked while
Claude is busy mid-turn waits for the turn to end before it forks.
A fork that reaches its 180-second deadline ends in the bubble, but a
fork already sent runs on to its end (Claude Code offers no cancel), so it
may still bill. Quips and prompt suggestions are on by default: one short
`quipModel` call per answered turn, sent the ends of the chat's last 3
turns and the turn's tally; `quips: false` and `suggestions: false`
turn them off, and with suggestions on, turning off Claude Code's own prompt
suggestions saves paying for both.
</details>

<details>
<summary><b>I installed it and nothing shows.</b></summary>

Check that `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` was set before Claude Code
started: with it off, a new session prints `buddy is off: …` and names what
to add to `settings.json` (see [Quick start](#-quick-start)). Then check
that you are in the terminal or the desktop app (the VS Code
extension and mobile do not draw the line above the prompt), that the
window is wide enough for the character, and that `/buddy on` is in effect.
</details>

<details>
<summary><b>Why is my buddy asleep?</b></summary>

From midnight to 6 am, local time, it falls asleep after a minute with
nothing happening. Anything that happens wakes it.
</details>

<details>
<summary><b>My character shows as invalid.</b></summary>

`/buddy-personality` lists it as `{id} (invalid)`, and its preview names the
first error in the file. Fix it, save, and run `/buddy reload`.
</details>

## 🛠️ Development

```sh
npm install
npm test              # unit tests (vitest) and function-hook tests (claude plugin test)
npm run typecheck
npm run validate:plugin
npm run live          # live proof in tmux, spends a few cents of Haiku
```

Work lands on `develop`; `main` holds only releases, and each one is tagged
`buddy--vX.Y.Z` with its notes in [CHANGELOG.md](./CHANGELOG.md). Pull
requests go to `develop`; [CONTRIBUTING.md](./CONTRIBUTING.md) covers both
characters and code.

`plugins/buddy/hooks/buddy.tsx` is a thin adapter over `plugins/buddy/src/`,
where every decision is a pure, unit-tested module.

## 🎓 Built with Professor

buddy is built and maintained with [Professor](https://github.com/rezzminator/professor), a fleet controller and discipline layer for Claude Code, Codex and OpenCode: chats that message each other, agents held to the project's rules, and gated releases. The Professor character, shipped alongside Quack, carries its namesake.

## 🆘 Help

- A question, or buddy not showing up: see the [FAQ](#-faq), then
  [SUPPORT.md](./SUPPORT.md).
- A bug or an idea: [open an issue](https://github.com/rezzminator/buddy/issues/new/choose);
  there is a template for bugs, features and new characters.
- A security problem: [SECURITY.md](./SECURITY.md), never a public issue.

## 🤝 Contributing

The best thing to add is a character: one JSON file, a persona and a few
poses of ASCII art. [CONTRIBUTING.md](./CONTRIBUTING.md) walks through it;
issues labelled
[`good first issue`](https://github.com/rezzminator/buddy/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
are a place to start. Everyone taking part follows the
[Code of Conduct](./CODE_OF_CONDUCT.md).

<sub>Keywords: Claude Code buddy · /buddy · Claude Code companion · terminal pet · ASCII pet · tamagotchi · speech bubble · Claude Code plugin · function hooks · Claude Mods · custom characters</sub>

## License

[MIT](./LICENSE)
