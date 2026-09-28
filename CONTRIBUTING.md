# Contributing

The best thing to add to buddy is a character. A character is one JSON file:
a persona, a few poses of ASCII art and, if you like, some lines to say. You
can build and try one in a folder of your own, without touching this
repository, and then send it in to ship with buddy.

## The character file

One JSON object per file, `{id}.json`, the file name equal to `id`. The
contract is [`plugins/buddy/schema/character.schema.json`](./plugins/buddy/schema/character.schema.json)
(JSON Schema, draft 2020-12); a field, pose or line event it does not name
makes the file invalid.

| Field | Type | Req | Meaning |
| --- | --- | --- | --- |
| `$schema` | string | no | `"../schema/character.schema.json"` in built-ins |
| `id` | string, `^[a-z0-9][a-z0-9-]{0,31}$` | yes | unique, and not `original`, reserved for your original companion: a file taking it is refused with an error naming the file, shown in the Yours group of the drawer's personality tab and in the bubble at a session's start and after `/buddy reload`; the id the personality tab stores |
| `name` | string ≤ 40 | yes | display name |
| `description` | string ≤ 100 | yes | one line for the personality tab's preview and the hover card |
| `author` | string ≤ 60 | no | credit |
| `persona` | string ≤ 1200 | yes | the character's voice prompt, 2nd person ("You are …") |
| `color` | Ink color name or `#rrggbb` | no | sprite color, default `"yellow"` |
| `poses` | object | yes | pose name → array of frames; frame = array of rows (strings) |
| `lines` | object | no | event name → array of canned one-liners (≤ 120 chars each) |
| `motion` | object | no | `walk` (bool, default true), `stepMs` (80–1000, default 200), `restChance` (0–0.2, default 0.02), `restTicks` (1–100, default 15) |

The Ink color names are `black`, `red`, `green`, `yellow`, `blue`,
`magenta`, `cyan`, `white`, `gray` (or `grey`), and each of the first eight
with `Bright` appended (`cyanBright`).

### Poses

A pose is an array of frames: a walking pose moves one frame per step,
every other pose turns a frame every 0.9 seconds, and a pose with a single
frame is static. A pose you leave out falls back to another:

| Pose | Required | Falls back to | Drawn when |
| --- | --- | --- | --- |
| `idle` | yes, ≥ 1 frame | | standing still |
| `walkRight` | when `motion.walk` is true (the default), ≥ 2 frames | | walking right: the leg cycle |
| `walkLeft` | no | `walkRight` | walking left |
| `rest` | no | `idle` | a pause in the walk (Quack floats on the water) |
| `oops` | no | `idle` | a tool call failed, or a test run failed |
| `yay` | no | `idle` | a test run passed |
| `thinking` | no | `idle` | a question is being answered |
| `petted` | no | `yay` | `/buddy` |
| `working` | no | `idle` | Claude is working; the character stands still, reading a book for instance |
| `sleep` | no | `rest` | midnight to 6 am, after a minute with nothing happening; a `z Z` drifts above it |

### The art

- Rows are printable ASCII only (0x20 to 0x7E): no tabs, no emoji, no wide
  or other Unicode characters, because alignment is counted per cell.
- A frame is at most 16 columns wide and 6 rows tall.
- Rows need no padding: the engine pads every row to the character's
  widest row and aligns shorter frames at the bottom, so the feet stay on
  the line.
- In JSON a backslash is written `"\\"`: the row `\o/` is `"\\o/"`.

### Lines

`lines` maps an event to a pool of one-liners, each at most 120
characters. A line never repeats twice in a row within its pool. A pool you
leave out falls back to a short, neutral pool of the engine's (`wake` first
borrows your `greeting`); no character ever speaks in another character's
voice.

| Event | Said when |
| --- | --- |
| `greeting` | the session starts, or after a switch in the drawer's personality tab, `/buddy reload` and `/buddy on` |
| `toolFail` | a tool call failed or was denied |
| `testPass` | a Bash command's output reads like a test pass |
| `testFail` | a Bash command's output reads like a test failure |
| `petted` | you type `/buddy` |
| `thinking` | it starts on a question you asked |
| `rest` | one walking rest in four, for 6 seconds, beside the `rest` pose |
| `working` | Claude starts working and no bubble is showing: one time in four, for 6 seconds |
| `wake` | any event (a tool call, `/buddy`, a turn ending, work starting) wakes it from `sleep` |
| `farewell` | `/buddy off`: printed as the command's reply, since the band hides at once |

### Persona

`persona` is the prompt a model answers in when you ask a question, and at
the end of every answered turn, when it voices `commentAfterEachTurn` and
decides what `suggestNextPrompt` nudges toward, though
`suggestNextPrompt` itself is written in the user's words. Write it in the second person ("You are …"): who
the character is, how it talks, a phrase or two it likes. The engine puts
its character rule (`CHARACTER_RULE`) right after the persona: become the
character completely and say one useful thing that both the user and Claude
missed, the character deciding how it is said, never what is true. So write
the persona for voice, not for tasks: what to say comes from the rule. The
engine also adds the rule that answers are one line, so the persona does
not need to.

### Motion

`motion` is optional. `walk: false` keeps the character standing on its
`idle` frames, and then `walkRight` is not required. `stepMs` is the time
per step, `restChance` the chance per step of stopping to rest, and
`restTicks` how many steps a rest lasts.

## A minimal example

A blob that wobbles along, cheers when tests pass, and has a few lines of
its own:

```json
{
  "$schema": "https://raw.githubusercontent.com/rezzminator/buddy/main/plugins/buddy/schema/character.schema.json",
  "id": "blob",
  "name": "Blob",
  "description": "A small, cheerful blob that wobbles along your prompt.",
  "author": "you",
  "persona": "You are Blob, a small cheerful blob who lives above a developer's Claude Code prompt. You speak in short, happy sentences, you are easily impressed, and you never give up on a failing test.",
  "color": "cyan",
  "poses": {
    "idle": [[" .--. ", "( oo )", " `--' "]],
    "walkRight": [
      [" .--. ", "( oo )", " `--' "],
      [" .--. ", "( oo )", " '--` "]
    ],
    "yay": [["\\.--./", "( ^^ )", " `--' "]]
  },
  "lines": {
    "greeting": ["Blob is here!", "Hello again, friend."],
    "testPass": ["Green! Wobble wobble.", "All passing. Blob is proud."],
    "toolFail": ["Oof. Try again?", "That one did not go well."]
  }
}
```

Every pose it leaves out falls back as the table above says: `oops`,
`thinking` and `working` draw `idle`, and `petted` draws `yay`.

## Try it locally

1. Save the file in a folder of your own, for example
   `my-characters/blob.json`.
2. Point the `customCharactersDir` option at that folder: through `/plugin configure`, or in
   `settings.json` under `pluginConfigs["buddy@buddy"].options.customCharactersDir`.
   Start a new session.
3. `/buddy` opens the drawer; its personality tab (ctrl+x t) lists it under Yours, or as `blob (invalid)`
   with the first thing wrong in the file in its preview.
4. ctrl+x n or ctrl+x b onto it draws it.
5. Edit the file, save, and run `/buddy reload` to see the change. Try a
   narrow window as well as a wide one.
6. Pick your usual character in the personality tab to go back to it.

An editor that reads `$schema` checks the file as you type. Inside this
repository, the built-ins use the relative path
`"../schema/character.schema.json"` instead of the URL.

## Send it in

1. Fork this repository and branch off `develop`.
2. Add `plugins/buddy/characters/{id}.json`, with
   `"$schema": "../schema/character.schema.json"` and your `author`, and a
   row for it in the Characters table of `README.md`.
3. Run the checks:

   ```sh
   npm install
   export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
   npm test
   npm run validate:plugin
   ```

4. Try it in a real session: `claude --plugin-dir plugins/buddy`, then
   pick it in the personality tab of `/buddy`.
5. Open a pull request against `develop`, with each pose pasted in a text
   block.

A character ships when:

- the art and the persona are your own work, not a copy of an existing
  character, a trademark or a real person;
- its lines and persona are friendly: it is a companion, not a critic;
- it is new: not a recolour or a near copy of one already built in;
- you agree to license it under the repository's MIT license.

## Species templates

The "Yours" group of the drawer's personality tab brings back the companion that
Claude Code's old `/buddy` hatched for you. Your account decides its species, eye, hat and rarity; its
look comes from a species template, `plugins/buddy/species/{species}.json`,
and its hat from `plugins/buddy/species/hats.json`. A template is ASCII art
with blanks that the engine fills in: the eyes, the hat and the color.

The 18 species are fixed, because the hatching algorithm picks from them:
`duck`, `goose`, `blob`, `cat`, `dragon`, `octopus`, `owl`, `penguin`,
`turtle`, `snail`, `ghost`, `axolotl`, `capybara`, `cactus`, `robot`,
`rabbit`, `mushroom`, `chonk`. A contribution improves one of them.

```json
{
  "$schema": "../schema/species.schema.json",
  "species": "blob",
  "width": 9,
  "hatCol": 4,
  "poses": { "idle": [], "walkRight": [], "oops": [], "yay": [], "sleep": [] },
  "lines": { "greeting": [] }
}
```

The rules:

- `species` equals the file name.
- A frame is an array of rows. Row 0 of every frame is the hat row: all
  spaces, because the engine draws the hat there. Then come 1 to 4 body rows.
- `width` is at most 12. Every row of every frame is exactly `width` columns
  wide, padded with spaces. Unlike a character, a template is not padded for
  you, and a shorter row is invalid.
- `{E}` marks an eye. The engine swaps in the companion's eye glyph, which is
  one column wide, so `{E}` counts as one column. Everything else is printable
  ASCII.
- By convention, which `validateSpecies` does not check: keep `hatCol` at
  least 3 columns from either edge. A hat can be up to 7 columns wide.
- `idle`, `walkRight`, `oops`, `yay` and `sleep` are required. `walkLeft`,
  `working` and `rest` are optional.
  - `idle` has at least 3 frames. By convention, which `validateSpecies`
    does not check: frame 0 is the base, a fidget comes somewhere in
    between, and the last frame is the blink: the base with every `{E}`
    replaced by `-`. Repeat the base frame to slow the rhythm.
  - `walkRight` has at least 2 frames, and legs or body visibly move between
    them.
  - `sleep` draws its eyes as `-`. A `z` is welcome.
- A creature drawn side-on needs its own `walkLeft`: the mirror image of
  `walkRight`, with the head turned the other way. Keep its head on the
  middle column, so that the mirrored head stays under the same `hatCol`.
- By convention, which `validateSpecies` does not check: `lines` has a pool
  for every event in the Lines table above, each with 2 to 4 lines of at
  most 120 characters, in the species' own voice. `{name}` becomes the
  companion's name.
- `hats.json` maps `crown`, `tophat`, `propeller`, `halo`, `wizard`, `beanie`
  and `tinyduck` to one row of at most 7 columns each. `none` draws no row.

### Preview a template

From the repository root, this command prints the first frame of every pose,
with `o` for the eyes and bars at the edges so that the padding shows:

```sh
node -e 'const t=require("./plugins/buddy/species/blob.json");for(const [p,fs] of Object.entries(t.poses))console.log(p+"\n"+fs[0].map(r=>"|"+r.replaceAll("{E}","o")+"|").join("\n"))'
```

The engine checks a template with `validateSpecies` in
`plugins/buddy/src/species.ts`, which reports the first thing wrong by its
path. The drawer's personality tab previews your own companion live. A template ships under
the same rules as a character: the art and the lines are your own work, and
they are friendly.

## Code

A change to the engine lands in `plugins/buddy/src/` as a pure function with
a test in `tests/` that you watched fail first; `plugins/buddy/hooks/buddy.tsx`
only wires it to Claude Code, and its hook tests live in `plugins/buddy/tests/`,
where `claude plugin test` requires them. `npm test`, `npm run typecheck` and
`npm run validate:plugin` pass before a pull request, and the pull request
goes to `develop`. `npm run typecheck` first writes the plugin API's types
into `types/` from your installed Claude Code (`npm run types`); git ignores
them, so they always match the Claude Code you run.
