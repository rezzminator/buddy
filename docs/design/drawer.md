# The drawer

`/buddy` alone opens the band above the prompt full width into the drawer; `/buddy` again, or ctrl+x q from the prompt, folds it back into the buddy.
It has two tabs: talk, everything the buddy remembers, and personality, where the character is picked from a list instead of by id, a live preview of the lit one beside it.
It is the one command: `/buddy {question}` asks, and every other surface of the plugin lives in the drawer.

## The flow

```mermaid
sequenceDiagram
  participant You
  participant CC as Claude Code
  participant A as adapter
  You->>CC: /buddy
  CC->>A: command.run
  A->>A: open the drawer, start the 500 ms clock, scroll to the newest line
  You->>CC: ctrl+x t, from the prompt
  CC->>A: the key-tab Button (pane:next) fires onPress
  A->>A: read the Yours group, build the list
  You->>CC: ctrl+x n or ctrl+x b
  CC->>A: the key-next (diff:back) or key-back (app:cycleDiffBase) Button fires onPress
  A->>A: light the next or previous entry, round the list; the preview follows
  alt the entry draws
    A->>A: save the choice, switch, move the *
  else it cannot be drawn
    A->>A: lit only; its preview says why
  end
```

The drawer is the band's own tree (`drawDrawer` in `hooks/drawer.tsx`), drawn by the adapter's `ui.render` hook on `AbovePrompt`: no pane opens.
A round border in the character's ink holds it; inside, the left card (sprite, name, status with the pet count as `♥ N`, counts) and the body (the tab's content) each sit in a single gray border, and under them one bar: the tabs and the guide at the left, the ask box at the right. The drawer fits the band's `maxRows`: the frame's and the body's borders take 4 rows and the bar 3 (2 without an ask box), and the body the rest, never less than the card. The talk tab draws the newest messages that fit, a first row `↑ N older messages` counting the rest; the personality tab draws a window of its list round the lit row, `↑ N more` and `↓ N more` at its ends, and its preview clipped to the body.
The band scrolls when the tree is taller than the rows Claude Code gives it; opening the drawer, or going back to talk, scrolls it to the end (`scrollDrawerToEnd`).
The personality tab's list comes from a `Menu` that `buildMenu` makes as plain data.

## The shortcuts: ctrl+x chords

The drawer has nothing to press or step through. Every act is a ctrl+x chord pressed from the prompt, and their guide (`guide`) sits at the drawer's bottom-left, each chord spelled whole and bright: `ctrl+x tab` ask · `ctrl+x t` talk/personality · `ctrl+x u` use the idea · `ctrl+x n` next character · `ctrl+x b` previous character · `ctrl+x p` pet · `ctrl+x q` close (`DRAWER_KEYS` in `src/command.ts` says them in full in `/buddy help` and the reply to `/buddy`).

A plugin hears a chord only through a `Button` naming a Claude Code keybinding action that no engine handler holds at the prompt: the engine runs the Button's `onPress` when the action's chord is pressed.
So each chord is a plain `Button` in the guide (`SHORTCUTS`), drawn as its dim label, its `action` borrowed:

| Chord | Button key | Action | Bound by | Does |
| --- | --- | --- | --- | --- |
| ctrl+x tab | | | Claude Code's own step-in | into the ask box (`autoFocus`) |
| ctrl+x t | `key-tab` | `pane:next` | your `keybindings.json` | talk to personality and back (`openPersonality`, `showTalk`) |
| ctrl+x u | `key-use` | `pane:previous` | your `keybindings.json` | the newest open idea (`openIdea`) into the prompt box |
| ctrl+x n | `key-next` | `diff:back` | your `keybindings.json` | the next character (`stepCharacter`, 1) |
| ctrl+x b | `key-back` | `app:cycleDiffBase` | Claude Code's default | the previous character (`stepCharacter`, -1) |
| ctrl+x p | `key-pet` | `permission:toggleDebug` | your `keybindings.json` | pets it |
| ctrl+x q | `close` | `confirm:previousField` | your `keybindings.json` | folds the drawer (`toggleDrawer`) |

The five the engine does not bind are a block for `keybindings.json`, context `Global`, that the README's Shortcuts gives; without it only ctrl+x b and ctrl+x tab work.

Each action is one Claude Code handles only inside a panel or dialog: `pane:next` and `pane:previous` in a plugin's `Pane`, `diff:back` in the diff dialog, `app:cycleDiffBase` in the diff panel, `permission:toggleDebug` and `confirm:previousField` in a permission dialog. The engine presses a Button's action only with no dialog up and no engine handler of that action mounted, so while one of those is open its chord does Claude Code's thing, never the drawer's; and none is a chord Claude Code uses at the prompt, so the drawer takes nothing from it (`ctrl+x ctrl+k`, `ctrl+x ctrl+e`, `ctrl+x enter` and the rest are untouched).

## The talk tab: exactly what the buddy remembers

The talk tab is the session's feed (`src/feed.ts`), and the feed spans the same window as the buddy's memory ([chatTurnsToRead](./chatTurnsToRead.md)): the last `chatTurnsToRead` turns it read, a compaction counting as one, nothing before the last `/clear` (`pruneToMemory`).
Every text is whole: no entry is cut and the feed has no length cap, so the tab is as long as the memory, scrolled.

| Section | Opened by |
| --- | --- |
| `{hh:mm}  you → Claude: {prompt}` | a main turn's start; `· interrupted, {name} never read it` when the turn ended unanswered and was not filed (`markRead`) |
| `{hh:mm}  chat compacted · {name} read its summary: {summary}` | a compaction of the main chat, filed into the memory as a turn |
| `{hh:mm}  new conversation` | `/clear` |

Under each section, in order: your questions and the buddy's answers, its `commentAfterEachTurn`, its `suggestNextPrompt`, marked at its right `✓ you sent it` once your next prompt was that idea, `not sent` once it was passed over, and the newest open one `ctrl+x u uses it`, its canned lines, and every failure.
An interrupted turn stays inside the window but does not count toward it, as the memory never holds it.
The feed lives in `$.state` for the session, so a plugin reload keeps it; where it is gone (a resume, a restart) and the memory is not, it is drawn back from the memory (`feedOfMemory`, `seedFeed`).
The tab's hint names the window: `everything {name} remembers: your last {n} turns with Claude`.

## The personality tab: the groups

| Group | Rows | When there are none |
| --- | --- | --- |
| Shipped | the plugin's `characters/`, by id | `No shipped characters found.`, or why the folder could not be read |
| Yours | your original companion, twice (`{name} — native install`, `{name} — npm install`), when `{config}` or a backup of it holds one; then the files in `customCharactersDir`, by id | `None yet: set customCharactersDir to a folder of your own character files.`, or `No character files in customCharactersDir.` when it is set; why `{config}` or `customCharactersDir` could not be read is a line of its own. No companion is no line. `{config}` is `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` when that is set |

`*` marks the row drawn now (`rowLabel`, `currentKeyOf`); for your original, the roll you picked.
An invalid file is still a row, `{id} (invalid)`.
A character file taking the reserved id `original` is no row: its error, naming the file, is a line in Yours (`buildMenu`).
A shipped id your `customCharactersDir` overrides appears once, under Yours.
"Yours" is read afresh at every open (`findOriginals`), and a companion found in a backup adds `From the backup {name}.` above its rows ([Original companion](./original-companion.md)).

## The live preview

The right side shows the lit entry (`previewOf`): its `idle` animation in its color, its name, one line about it (the description, or an original's saved personality; never the persona prompt), its first greeting in quotes, and for an original the card: species, stars, shiny, five stat bars and the hatch date.

The preview runs on the drawer's clock, 500 ms a beat, one frame per beat, whatever is lit, hidden or not; a step starts the new entry at frame 0.
Folding the drawer stops the clock.

## Stepping and switching

| Chord | Does |
| --- | --- |
| ctrl+x n | lights the next entry, round the list, and switches to it at once: saves it, switches the band to it, which greets; the tab stays open, its `*` moved |
| ctrl+x b | the same, to the previous entry |
| ctrl+x t | back to the thread, scrolled to its end |

Either step opens the personality tab first when the talk tab shows.
An entry that will not draw is lit, its preview saying why (`Can't draw it: {why}`), and switches nothing; the next step moves on from it.
A "Yours" original with no soul behind it says `Can't pick {label}: its soul was not found` on the transcript and switches nothing.

## Persistence and restart

A switch saves the store's `character` key; the tab is the only thing that writes it. Going back to the `character` option's character is a step onto its entry, which stores that id: the same character is drawn, and nothing clears the key.
For an original it saves `character: "original"` and, under `original`, the roll and the soul, never the identity.
The choice survives `/reload` and restarts; at a start with the original chosen, `restoreOriginal` rolls it again from the saved soul, with no backup scan.
A save that fails still switches for this session and says so in the bubble: `{name} is here (not saved: {why})`, for 10 seconds.
`/reload` rebuilds the plugin with the drawer folded; `/buddy` opens it again.

## Error lines that never read as absence

Every failure to look is a line where the missing rows would be, and every entry that cannot draw says why in the preview:

| Condition | What the tab shows |
| --- | --- |
| a folder cannot be listed | `couldn't read {folder}: {why}` in its group, and in the bubble at each session start and `/buddy reload` |
| neither `CLAUDE_CONFIG_DIR` nor HOME is set | `couldn't find .claude.json: neither CLAUDE_CONFIG_DIR nor HOME is set` in Yours |
| the config cannot be read | `couldn't read {config}: {why}` in Yours |
| the config is not JSON | `couldn't parse {config}: not valid JSON ({kind})`, never the parser's text, which can quote the file |
| its companion is malformed | `{config} has a companion, but {why}` |
| a place for backups cannot be listed, or backups would not parse | a note under Yours: `Couldn't list {place} to look for backups: {why}`, `Skipped {n} backups that did not read or parse.` |
| an invalid character file | the row `{id} (invalid)`; the preview `Can't draw it: {error}` |
| a character file takes the reserved id `original` | `original.json ({source}): "original" is reserved for your original companion; rename the file and its id` in `customCharactersDir`; the band's bubble says it too, for 10 s, at each session start and `/buddy reload`, ending `; the personality tab in /buddy lists your characters` |
| an original whose art will not draw | its row; the preview `Can't draw it: {why}`, such as a hat `species/hats.json` lacks |
| nothing lit | `Nothing to preview`: `no entry is highlighted` |
| the drawer asked for before the buddy loaded | the reply `buddy is still starting; try again in a moment` |

## Decisions

- **One command.** Rejected: `/buddy-personality` and `/buddy-drawer` beside `/buddy`. Three names for one companion; `/buddy` alone opens the drawer, with words it asks, and ctrl+x p in the drawer pets.
- **The talk tab spans the memory, no more and no less.** Rejected: a feed capped at a count of entries and a text length. The drawer is where you check what the buddy knows, so it shows exactly the turns it reads, whole, and marks the one it never read.
- **The personality list in the band, not a pane.** Rejected: a focused pane opened beside the band. One surface, one set of chords, and no pane that can open unplaced.
- **Close is ctrl+x q, never ctrl+x x.** Rejected: `pane:close`, Claude Code's own ctrl+x x. It is the chord Claude Code closes things with, so with the drawer open it could fold the drawer where you meant to close something else.
- **Every act a ctrl+x chord, no buttons.** Rejected: buttons in the drawer walked with the arrows and pressed with Enter. The arrows could not reach the drawer without ctrl+x tab first, and every act under one prefix is one thing to learn; a chord works from the prompt, the drawer never taking the focus. A chord reaches a plugin only as an engine keybinding action, so each borrows one no engine handler holds at the prompt, four of them bound in `keybindings.json`.
- **A step switches at once.** Rejected: lighting an entry and confirming with a second key. With no focus to move there is no browse-then-pick, and the next step is the undo; an entry that cannot draw is lit, never picked, so stepping past it is safe.
- **A switch remembers, and the tab stays open.** Rejected: a switch that lasts one session, and a tab that closes on a switch: the `*` moving is the confirmation.
- **The personality tab is the one way to see and switch.** Rejected: `/buddy list` and `/buddy use {id}` beside it. Two ways to choose drift apart; the tab shows everything the list did, with a preview.
- **"Yours" read at every open of the tab.** Rejected: reading it once at start. A backup restored meanwhile shows at the next open, and a start never scans backups: with the original chosen it re-rolls from the saved soul.
- **Your additions live in a folder, never in `~/.claude.json`.** Rejected: storing characters or picks in that file. Claude Code rewrites it, so a key buddy added could be lost or race the engine's own write, and buddy treats it as read-only. Your characters live in `customCharactersDir`, your picks in `$.store`.

## Where it lives

| File | Symbols |
| --- | --- |
| [`hooks/drawer.tsx`](../../plugins/buddy/hooks/drawer.tsx) | `DrawerView`, `DrawerActs`, `MenuState`, `SHORTCUTS`, `openIdea`, `drawDrawer`; `guide`, `thread`, `personality` inside it |
| [`src/command.ts`](../../plugins/buddy/src/command.ts) | `DRAWER_KEYS` |
| [`src/feed.ts`](../../plugins/buddy/src/feed.ts) | `FeedEntry`, `pushEntry`, `markRead`, `pruneToMemory`, `feedOfMemory`, `answerSuggestions`, `statsOf` |
| [`src/menu.ts`](../../plugins/buddy/src/menu.ts) | `Menu`, `Item`, `Originals`, `buildMenu`, `itemKey`, `allItems`, `findItem`, `currentKeyOf`, `rowLabel`, `listWidth`, `previewOf` |
| [`hooks/buddy.tsx`](../../plugins/buddy/hooks/buddy.tsx) | `toggleDrawer`, `drawDrawerBand`, `drawerView`, `scrollDrawerToEnd`, `openPersonality`, `showTalk`, `stepCharacter`, `pickItem`, `changeFeed`, `seedFeed`, `save`, `findOriginals`, `restoreOriginal` |
| [`src/original.ts`](../../plugins/buddy/src/original.ts) | `originalLabel` |

## How it's tested

- Unit: [`tests/menu.test.ts`](../../tests/menu.test.ts): the two groups, a failure to look as a line, the current entry marked, the preview's frames, card and errors. [`tests/feed.test.ts`](../../tests/feed.test.ts): whole texts, the window cut to the memory, the feed drawn back from it.
- Hooks: "the drawer" checks it has no button but its shortcuts, each a ctrl+x chord on its engine action, their guide at the bottom-left before the ask box, and opens and folds it; it fits a 12-row band, the thread counting its older messages and the list windowed round the lit row; "the drawer's personality tab" steps with ctrl+x n and b, switching at once (saved, greeted, the tab open on it), lights a character that cannot be drawn without picking it, goes back to the thread with ctrl+x t, shows an original from an invented `~/.claude.json` or its newest backup, restores it at a restart, and turns every unreadable or invalid file into its line; "memory: whole messages, compactions, retries, and the drawer spanning it" checks the talk tab spans the memory, marks an interrupted turn, shows a compaction and is drawn back after a resume.
- Live: `npm run live:drawer` opens the drawer with `/buddy` in a real session, captures it, opens the personality tab with ctrl+x t, reaches the ask box with ctrl+x tab and folds it with ctrl+x q; the live proof switches characters through the personality tab with ctrl+x n and b, and pets with ctrl+x p. Both run with the Shortcuts block in their own config dir's `keybindings.json` (`live_isolate`).
