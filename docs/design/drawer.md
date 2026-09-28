# The drawer

`/buddy` alone opens the band above the prompt full width into the drawer; `/buddy` again, `✕ close`, or ctrl+x x from the prompt (while no pane is open) folds it back into the buddy.
It has two tabs: talk, everything the buddy remembers, and personality, where the character is picked from a list instead of by id, a live preview of the focused one beside it.
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
  You->>CC: ctrl+x tab, then personality, Enter
  CC->>A: the tab's Button fires onPress
  A->>A: read the Yours group, build the list
  You->>CC: → or ←
  CC->>A: ui.focus, element = the entry's key
  A->>CC: invalidate: the preview follows
  alt Enter on an entry
    CC->>A: the entry's Button fires onPress
    A->>A: save the choice, switch, move the *
  else Esc
    CC->>A: focus leaves for the prompt; nothing saved
  end
```

The drawer is the band's own tree (`drawDrawer` in `hooks/drawer.tsx`), drawn by the adapter's `ui.render` hook on `AbovePrompt`: no pane opens.
The band scrolls when the tree is taller than the rows Claude Code gives it; opening the drawer, or going back to talk, scrolls it to the end (`scrollDrawerToEnd`).
ctrl+x tab steps into it; ← and → (and Tab) move between its buttons and the ask box; Enter presses. ↑ and ↓ move too while the drawer fits the band, and scroll it once it is taller: Claude Code gives a scrollable band the vertical keys, so the hint says `←→ move · ↑↓ scroll`.
The personality tab's list comes from a `Menu` that `buildMenu` makes as plain data.

## The talk tab: exactly what the buddy remembers

The talk tab is the session's feed (`src/feed.ts`), and the feed spans the same window as the buddy's memory ([chatTurnsToRead](./chatTurnsToRead.md)): the last `chatTurnsToRead` turns it read, a compaction counting as one, nothing before the last `/clear` (`pruneToMemory`).
Every text is whole: no entry is cut and the feed has no length cap, so the tab is as long as the memory, scrolled.

| Section | Opened by |
| --- | --- |
| `{hh:mm}  you → Claude: {prompt}` | a main turn's start; `· interrupted, {name} never read it` when the turn ended unanswered and was not filed (`markRead`) |
| `{hh:mm}  chat compacted · {name} read its summary: {summary}` | a compaction of the main chat, filed into the memory as a turn |
| `{hh:mm}  new conversation` | `/clear` |

Under each section, in order: your questions and the buddy's answers, its `commentAfterEachTurn`, its `suggestNextPrompt` with a `use` button (`you sent it` once your next prompt was that idea), its canned lines, and every failure.
An interrupted turn stays inside the window but does not count toward it, as the memory never holds it.
The feed lives in `$.state` for the session, so a plugin reload keeps it; where it is gone (a resume, a restart) and the memory is not, it is drawn back from the memory (`feedOfMemory`, `seedFeed`).
The tab's hint names the window: `everything {name} remembers: your last {n} turns with Claude`.

## The probe: Buttons, not Select

A preview has to follow the focus as it moves, before anything is picked.
A probe of the two ways to draw a list settled it: with one `Button` per row, Claude Code raises `ui.focus` on every arrow move, carrying the focused row's key; a `Select` raises nothing as its highlight moves.
So each entry is a plain `Button` keyed by its row (`use:{id}` or `original:{variant}`, `itemKey`), and the adapter's `ui.focus` hook, matched on `AbovePrompt`, moves the preview to `e.element` and restarts its animation.
The hook passes every move on unchanged with `next(e)`: Claude Code moves the ring, buddy only watches.

## The personality tab: the groups

| Group | Rows | When there are none |
| --- | --- | --- |
| Shipped | the plugin's `characters/`, by id | `No shipped characters found.`, or why the folder could not be read |
| Yours | your original companion, twice: `{name} — native install`, `{name} — npm install` | `No companion in {config} or its backups.`, or why the file could not be read; `{config}` is `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` when that is set |
| `customCharactersDir` | the files in `customCharactersDir`, by id | `customCharactersDir is not set: point it at your own character files.`, `No character files in customCharactersDir.`, or why `customCharactersDir` could not be read |

`*` marks the row drawn now (`rowLabel`, `currentKeyOf`); for your original, the roll you picked.
An invalid file is still a row, `{id} (invalid)`.
A character file taking the reserved id `original` is no row: its error, naming the file, is a line in `customCharactersDir` (`buildMenu`).
A shipped id your `customCharactersDir` overrides appears once, under `customCharactersDir`.
"Yours" is read afresh at every open (`findOriginals`), and a companion found in a backup adds `From the backup {name}.` above its rows ([Original companion](./original-companion.md)).

## The live preview

The right side shows the focused entry (`previewOf`): its `idle` animation in its color, its name, one line about it (the description, or an original's saved personality; never the persona prompt), its first greeting in quotes, and for an original the card: species, stars, shiny, five stat bars and the hatch date.

The preview runs on the drawer's clock, 500 ms a beat, one frame per beat, whatever you focus, hidden or not; a focus move starts the new entry at frame 0.
Folding the drawer stops the clock.

## Enter and Esc

| Key | Does |
| --- | --- |
| ← or → | moves the focus; the preview follows; nothing is saved or switched |
| Enter on an entry | picks it: saves it, switches the band to it, which greets; the tab stays open, its `*` moved |
| Enter on `talk` | back to the thread, scrolled to its end |
| Esc | leaves the drawer for the prompt; the character drawn and every saved choice stay as they were |

Enter on an entry that will not draw says the reason on the transcript (`Can't pick {label}: {why}`) and switches nothing.
Enter on a "Yours" entry with no soul behind it does the same.

## Persistence and restart

Enter saves the store's `character` key; the tab is the only thing that writes it. Going back to the `character` option's character is a pick of its entry, which stores that id: the same character is drawn, and nothing clears the key.
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
| nothing focused | `Nothing to preview`: `no entry is highlighted` |
| the drawer asked for before the buddy loaded | the reply `buddy is still starting; try again in a moment` |

## Decisions

- **One command.** Rejected: `/buddy-personality` and `/buddy-drawer` beside `/buddy`. Three names for one companion; `/buddy` alone opens the drawer, with words it asks, and the pet is the drawer's `♥ pet` button.
- **The talk tab spans the memory, no more and no less.** Rejected: a feed capped at a count of entries and a text length. The drawer is where you check what the buddy knows, so it shows exactly the turns it reads, whole, and marks the one it never read.
- **The personality list in the band, not a pane.** Rejected: a focused pane opened beside the band. One surface, one set of keys (ctrl+x tab, ← →, ↑ ↓, Enter, ctrl+x x), and no pane that can open unplaced.
- **Buttons with `ui.focus`.** Rejected: `Select`, which reports no highlight move, so no preview could follow it.
- **Only Enter switches.** Rejected: switching as the focus moves. Browsing stays free, and Esc is a clean cancel.
- **Enter remembers, and the tab stays open.** Rejected: a pick that lasts one session, and a tab that closes on a pick: the `*` moving is the confirmation.
- **The personality tab is the one way to see and switch.** Rejected: `/buddy list` and `/buddy use {id}` beside it. Two ways to choose drift apart; the tab shows everything the list did, with a preview.
- **"Yours" read at every open of the tab.** Rejected: reading it once at start. A backup restored meanwhile shows at the next open, and a start never scans backups: with the original chosen it re-rolls from the saved soul.
- **Your additions live in a folder, never in `~/.claude.json`.** Rejected: storing characters or picks in that file. Claude Code rewrites it, so a key buddy added could be lost or race the engine's own write, and buddy treats it as read-only. Your characters live in `customCharactersDir`, your picks in `$.store`.

## Where it lives

| File | Symbols |
| --- | --- |
| [`hooks/drawer.tsx`](../../plugins/buddy/hooks/drawer.tsx) | `DrawerView`, `DrawerActs`, `MenuState`, `drawDrawer` |
| [`src/feed.ts`](../../plugins/buddy/src/feed.ts) | `FeedEntry`, `pushEntry`, `markRead`, `pruneToMemory`, `feedOfMemory`, `answerSuggestions`, `statsOf` |
| [`src/menu.ts`](../../plugins/buddy/src/menu.ts) | `Menu`, `Item`, `Originals`, `buildMenu`, `itemKey`, `allItems`, `findItem`, `currentKeyOf`, `rowLabel`, `listWidth`, `previewOf` |
| [`hooks/buddy.tsx`](../../plugins/buddy/hooks/buddy.tsx) | `toggleDrawer`, `drawDrawerBand`, `drawerView`, `scrollDrawerToEnd`, `openPersonality`, `showTalk`, `pickItem`, `changeFeed`, `seedFeed`, `save`, `findOriginals`, `restoreOriginal`; the `ui.focus` hook on `AbovePrompt` |
| [`src/original.ts`](../../plugins/buddy/src/original.ts) | `originalLabel`, `SHOWN_CONFIG` |

## How it's tested

- Unit: [`tests/menu.test.ts`](../../tests/menu.test.ts): the three groups, a failure to look as a line, the current entry marked, the preview's frames, card and errors. [`tests/feed.test.ts`](../../tests/feed.test.ts): whole texts, the window cut to the memory, the feed drawn back from it.
- Hooks: "the drawer" opens and folds it; "the drawer's personality tab" moves the preview with `ui.focus`, picks with a press (saved, greeted, the tab open on it), shows an original from an invented `~/.claude.json` or its newest backup, restores it at a restart, and turns every unreadable or invalid file into its line; "memory: whole messages, compactions, retries, and the drawer spanning it" checks the talk tab spans the memory, marks an interrupted turn, shows a compaction and is drawn back after a resume.
- Live: `npm run live:drawer` opens the drawer with `/buddy` in a real session, captures it and folds it with ctrl+x x; the live proof switches characters through the personality tab.
