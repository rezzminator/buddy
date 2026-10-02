# The drawer

`/buddy` alone opens the band above the prompt full width into the drawer; `/buddy` again, or ctrl+x q from the prompt, folds it back into the buddy.
The drawer is the conversation: the buddy beside everything it remembers of the chat, what it told you and what you asked it, and on its last row the path of its memory as a file you can read.
ctrl+x t opens the personality picker from it, a focused pane where the character is picked from a list with ↑ ↓ and Enter, a live preview of the lit one beside it.
It is the one command: `/buddy {question}` asks, and every other surface of the plugin lives in the drawer or its picker.

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
  CC->>A: the key-personality Button (pane:next) fires onPress
  A->>CC: $.ui.open personality, focus, closeOnEscape, rows (openPicker)
  A->>A: read the Yours group, build the list (buildPicker)
  You->>CC: ↓ or ↑
  CC->>A: ui.focus, the element the row's key
  A->>A: light the row, its preview from frame 0, draw the pane again (lightRow)
  You->>CC: Enter
  CC->>A: ui.press, the row's onPress (pressRow)
  alt the entry draws
    A->>A: pickItem: save the choice, switch, greet, move the *
  else it cannot be drawn
    A->>A: lit only; its preview says why
  end
  You->>CC: Esc
  CC->>A: ui.close; the keys back to the prompt
```

## The drawer

The drawer is the band's own tree (`drawDrawer` in `hooks/drawer.tsx`), drawn by the adapter's `ui.render` hook on `AbovePrompt`.
A round border in the character's ink holds it; inside, the left card (sprite, name in spaced capitals, status) and the body (the thread) each sit in a single gray border; under them one bar, its numbers row over the guide at the left and the ask box at the right; last, the memory row.

The drawer fills the band's `maxRows` while the personality picker is closed or docked beside the transcript. For an inline picker, `drawerRows` leaves its requested body rows, its frame's 2 rows and 6 rows for the prompt and footer; the drawer keeps at least 10 rows, within `maxRows`. The frame's border takes 2 rows, the bar the numbers row and the guide's rows or the ask box's 3, whichever is taller, the memory row 1, and the body the rest, at least 4, its own border within; the card leaves its sprite out when it would not fit.
`maxRows` is set by Claude Code, and no plugin can draw taller: in fullscreen, what the bottom slot has left above the prompt, at most half the terminal; otherwise the terminal's height.
The thread draws the newest messages that fit, a first row `↑ N older messages` counting the rest; a newest message taller than the body stretches it, drawn whole, and the band scrolls. Opening the drawer scrolls it to the end (`scrollDrawerToEnd`).

The numbers row: `{name} remembers your last {n} turns with Claude · {r} replies · {t} of {s} suggested prompts used · {avg} · {tokens} tokens` (`statsOf`), the model and effort (`opus · low`) in place of the last two before any reply was timed.

## The shortcuts: ctrl+x chords

The drawer has nothing to press or step through. Every act is a ctrl+x chord pressed from the prompt, and their guide (`guide`) sits at the drawer's bottom-left, each chord spelled whole and bright: `ctrl+x tab` ask · `ctrl+x t` personality · `ctrl+x u` use suggested prompt · `ctrl+x q` close (`DRAWER_KEYS` in `src/command.ts` says them in full in `/buddy help` and the reply to `/buddy`: `ctrl+x t personality (↑ ↓ and Enter pick, Esc closes)`).

A plugin hears a chord only through a `Button` naming a Claude Code keybinding action that no engine handler holds at the prompt: the engine runs the Button's `onPress` when the action's chord is pressed.
So each chord is a plain `Button` in the guide (`SHORTCUTS`), drawn as its dim label, its `action` borrowed:

| Chord | Button key | Action | Bound by | Does |
| --- | --- | --- | --- | --- |
| ctrl+x tab | | | Claude Code's own step-in | into the ask box (`autoFocus`) |
| ctrl+x t | `key-personality` | `pane:next` | your `keybindings.json` | opens the personality picker (`openPicker`) |
| ctrl+x u | `key-use` | `pane:previous` | your `keybindings.json` | the newest open suggested prompt (`openSuggestion`) into the prompt box |
| ctrl+x q | `close` | `confirm:previousField` | your `keybindings.json` | folds the drawer, closing the picker with it (`toggleDrawer`, `closePicker`) |

The three the engine does not bind are a block for `keybindings.json`, context `Global`, that the README's Shortcuts gives; without it only ctrl+x tab works.

Each action is one Claude Code handles only inside a panel or dialog: `pane:next` and `pane:previous` in a plugin's `Pane`, `confirm:previousField` in a permission dialog. The engine presses a Button's action only with no dialog up and no engine handler of that action mounted, so while one of those is open its chord does Claude Code's thing, never the drawer's; and none is a chord Claude Code uses at the prompt, so the drawer takes nothing from it (`ctrl+x ctrl+k`, `ctrl+x ctrl+e`, `ctrl+x enter` and the rest are untouched).

## The thread: the conversation, exactly as long as the memory

The thread is the session's feed (`src/feed.ts`), and the feed spans the same window as the buddy's memory ([chatTurnsToRead](./chatTurnsToRead.md)): the last `chatTurnsToRead` turns it read, a compaction counting as one, nothing before the last `/clear` (`pruneToMemory`).
Every text is whole: no entry is cut and the feed has no length cap, so the thread is as long as the memory, scrolled.

| Section | Opened by |
| --- | --- |
| `{hh:mm}  you → Claude: {prompt}` | a main turn's start; once it ends, its numbers in brief, `· 4m12s · 104 tools · $0.42` (`markNumbers`, `statsBrief`); `· interrupted, {name} never read it` when the turn ended unanswered, `ended by an error` or `refused` in its place when an API error or a refusal ended it (`markRead`, and `feedOfMemory` from the memory's marks) |
| `{hh:mm}  chat compacted · {name} read its summary: {summary}` | a compaction of the main chat, filed into the memory as a turn |
| `{hh:mm}  new conversation` | `/clear` |

Under each section, in order: your questions and the buddy's answers, its `commentAfterEachTurn`, its second brain's verdict (`✓ {name}: right call` in green, `! {name}: shortcut` in yellow, `✗ {name}: WRONG` in red and bold, its why, and under it `wants: {desire}` dim), its `suggestNextPrompt`, marked at its right `✓ you sent it` once your next prompt was that suggested prompt, `not sent` once it was passed over, and the newest open one `ctrl+x u uses it`, and every failure.
The buddy's canned lines are the band's chatter and its memory items are its memory's, so neither is in the thread; the items are in `memory.md`.
A turn the buddy never read (interrupted, or ended by an error or a refusal) stays inside the window but does not count toward it.
The feed lives in `$.state` for the session, so a plugin reload keeps it; where it is gone (a resume, a restart) and the memory is not, it is drawn back from the memory (`feedOfMemory`, `seedFeed`).
With nothing in it, the thread says `Nothing between you and {name} yet: ask it below, or finish a turn with Claude.`

## The memory row

The drawer's last row, dim and cut in the middle when too long, is `memory  {path}`: the absolute path of the chat's `memory.md`, beside its `memory.json` in `{CLAUDE_CONFIG_DIR | $HOME/.claude}/projects/{project}/{session id}/buddy/`.
Before the file is written it says `memory  not written yet: {name} writes it at its first turn`.
`memory.md` is the chat's memory items by kind, the newest ended ones, then the turns as the character drawn now reads them, under the heading `# What {name} remembers` (`memoryText`); the adapter rewrites it with every write of `memory.json` and whenever the drawn character changes (a pick, `/buddy reload`, a session start), since the items are the chat's but the heading and the exchanges are the drawn character's ([chatTurnsToRead](./chatTurnsToRead.md#where-it-is-kept)).

## The personality picker: a focused pane

ctrl+x t runs `openPicker`: `$.ui.open({ id: 'personality', title: 'personality', focus: true, closeOnEscape: true, rows })`, `rows` the list's rows as last found or the lit entry's preview when that is taller, at most 20 (`paneRows`); outside fullscreen the pane sits above the band. `openPane` reserves those rows in `drawer.pickerRows` before asking the surface to measure the pane; closing it through `ui.close`, or an opening that fails or is not placed, clears the reservation and redraws the full drawer. In fullscreen the picker docks beside the transcript and takes no drawer rows.
The list is then built afresh (`buildPicker`, reading "Yours" with `findOriginals`), the pane asked for more rows when the new list needs them; meanwhile it says `Finding every character…`.
The adapter's `ui.render` hook for that `Pane` draws it (`drawPickerPane`, `drawPicker`). Its root height is `pickerContentRows(paneRows(model, focused), bodyRows)`: at least the requested list or preview height, even when the first measured body is zero or short, including the initial `Finding every character…` placeholder. The surface can then measure the full content instead of keeping a three-row window short forever. `pickerBodyRows` uses the requested rows before the first measurement, then the granted body rows, so the group titles and Buttons keep their positions as the pane first appears. Inside that height: each character a `Button` keyed by its item key, labelled `rowLabel`, the lit one `autoFocus`; group titles and lines as text; beside the list, the lit row's preview.
A list taller than the pane's body is a window round the lit row (`listWindow`), so the rows before and after it are always drawn Buttons, `↑ N more` and `↓ N more` at its ends.

| Key | Does |
| --- | --- |
| ↓ / ↑ | the engine moves the ring to the next or previous Button and raises one `ui.focus` hook, its element the row's key; the adapter lights that row (`lightRow`), starts its preview at frame 0 and draws the pane again, since the engine moves the ring without drawing |
| Enter | presses the lit Button (`pressRow`): `pickItem` saves the choice, switches the band to it, which greets; the pane stays open, its `*` moved |
| Esc | closes the pane (`closeOnEscape`); the keys go back to the prompt |
| ctrl+x q, or `/buddy` | folds the drawer, which closes the pane (`closePicker`) |

With text in the composer the pane opens without the keyboard, and its first row, dim, says `clear your prompt, then ctrl+x t to choose with ↑ ↓ and Enter`; ctrl+x t once the prompt is empty focuses the open pane.
An entry that will not draw is lit, its preview saying why (`Can't draw it: {why}`), and Enter on it switches nothing.
A "Yours" original with no soul behind it says `Can't pick {label}: its soul was not found` on the transcript and switches nothing.

## The picker's groups

| Group | Rows | When there are none |
| --- | --- | --- |
| Shipped | the plugin's `characters/`, by id | `No shipped characters found.`, or why the folder could not be read |
| Yours | your original companion, twice (`{name} — native install`, `{name} — npm install`), when `{config}` or a backup of it holds one; then the files in `customCharactersDir`, by id | `None yet: set customCharactersDir to a folder of your own character files.`, or `No character files in customCharactersDir.` when it is set; why `{config}` or `customCharactersDir` could not be read is a line of its own. No companion is no line. `{config}` is `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` when that is set |

`*` marks the row drawn now (`rowLabel`, `currentKeyOf`); for your original, the roll you picked.
An invalid file is still a row, `{id} (invalid)`.
A character file taking the reserved id `original` is no row: its error, naming the file, is a line in Yours (`buildMenu`).
A shipped id your `customCharactersDir` overrides appears once, under Yours.
"Yours" is read afresh at every open (`findOriginals`), and a companion found in a backup adds `From the backup {name}.` above its rows ([Original companion](./original-companion.md)).
The rows come from a `Menu` that `buildMenu` makes as plain data (`menuRows`).

## The live preview

The right side shows the lit entry (`previewOf`): its `idle` animation in its color, its name, one line about it (the description, or an original's saved personality; never the persona prompt), its first greeting in quotes, and for an original the card: species, stars, shiny, five stat bars and the hatch date.

The preview runs on the drawer's clock, 500 ms a beat, one frame per beat, whatever is lit; lighting a row starts it at frame 0.
Folding the drawer stops the clock and closes the pane.

## Persistence and restart

A pick saves the store's `character` key; the picker is the only thing that writes it. Going back to the `character` option's character is a pick of its entry, which stores that id: the same character is drawn, and nothing clears the key.
For an original it saves `character: "original"` and, under `original`, the roll and the soul, never the identity.
The choice survives `/reload` and restarts; at a start with the original chosen, `restoreOriginal` rolls it again from the saved soul, with no backup scan.
A save that fails still switches for this session and says so in the bubble: `{name} is here (not saved: {why})`, for 10 seconds.
`/reload` rebuilds the plugin with the drawer folded; `/buddy` opens it again.

## Error lines that never read as absence

Every failure to look is a line where the missing rows would be, and every entry that cannot draw says why in the preview:

| Condition | What the picker shows |
| --- | --- |
| a folder cannot be listed | `couldn't read {folder}: {why}` in its group, and in the bubble at each session start and `/buddy reload` |
| neither `CLAUDE_CONFIG_DIR` nor HOME is set | `couldn't find .claude.json: neither CLAUDE_CONFIG_DIR nor HOME is set` in Yours |
| the config cannot be read | `couldn't read {config}: {why}` in Yours |
| the config is not JSON | `couldn't parse {config}: not valid JSON ({kind})`, never the parser's text, which can quote the file |
| its companion is malformed | `{config} has a companion, but {why}` |
| a place for backups cannot be listed, or backups would not parse | a note under Yours: `Couldn't list {place} to look for backups: {why}`, `Skipped {n} backups that did not read or parse.` |
| an invalid character file | the row `{id} (invalid)`; the preview `Can't draw it: {error}` |
| a character file takes the reserved id `original` | `original.json ({source}): "original" is reserved for your original companion; rename the file and its id` in `customCharactersDir`; the band's bubble says it too, for 10 s, at each session start and `/buddy reload`, ending `; ctrl+x t in /buddy lists your characters` |
| an original whose art will not draw | its row; the preview `Can't draw it: {why}`, such as a hat `species/hats.json` lacks |
| nothing lit | `Nothing to preview`: `no entry is highlighted` |
| the drawer asked for before the buddy loaded | the reply `buddy is still starting; try again in a moment` |

## Decisions

- **One command.** Rejected: `/buddy-personality` and `/buddy-drawer` beside `/buddy`. Three names for one companion; `/buddy` alone opens the drawer, and with words it asks.
- **The thread spans the memory, no more and no less.** Rejected: a feed capped at a count of entries and a text length. The drawer is where you check what the buddy knows, so it shows exactly the turns it reads, whole, and marks the one it never read.
- **The conversation in the thread, the memory items in a file.** Rejected: each change of the buddy's memory in the thread. It is its own shorthand, and a change taller than the body pushed the conversation out; `memory.md` holds the items with their keys, its path on the drawer's last row.
- **The drawer fills the band.** With an inline picker it leaves room for that pane and the prompt; otherwise it fills the band. Rejected: a drawer as tall as its content. `maxRows` is Claude Code's ceiling and no plugin gets past it; filling it gives the thread every row there is.
- **The picker is a focused pane.** Rejected: the list in the band, stepped by chords. Only a pane opened from a Button's press takes the keyboard; the band takes it only after ctrl+x tab or a click, so the arrows could not reach a list there.
- **Rows are Buttons, not a `Select`.** A `Select` moves with the arrows silently, with no hook until Enter, so the preview could not follow the ring; a Button raises `ui.focus` at each move.
- **Arrows light, Enter picks.** Rejected: a switch at every step. The ring moves freely, the preview following, and only Enter switches; an entry that cannot draw is lit, never picked.
- **A pick remembers, and the pane stays open.** Rejected: a pick that lasts one session, and a pane that closes on a pick: the `*` moving is the confirmation, and Esc closes it.
- **Close is ctrl+x q, never ctrl+x x.** Rejected: `pane:close`, Claude Code's own ctrl+x x. It is the chord Claude Code closes things with, so with the drawer open it could fold the drawer where you meant to close something else.
- **Every act on the drawer a ctrl+x chord, no buttons.** Rejected: buttons in the drawer walked with the arrows and pressed with Enter. The arrows could not reach the drawer without ctrl+x tab first, and every act under one prefix is one thing to learn; a chord works from the prompt. A chord reaches a plugin only as an engine keybinding action, so each borrows one no engine handler holds at the prompt, three of them bound in `keybindings.json`.
- **The picker is the one way to see and switch.** Rejected: `/buddy list` and `/buddy use {id}` beside it. Two ways to choose drift apart; the picker shows everything the list did, with a preview.
- **"Yours" read at every open of the picker.** Rejected: reading it once at start. A backup restored meanwhile shows at the next open, and a start never scans backups: with the original chosen it re-rolls from the saved soul.
- **Your additions live in a folder, never in `~/.claude.json`.** Rejected: storing characters or picks in that file. Claude Code rewrites it, so a key buddy added could be lost or race the engine's own write, and buddy treats it as read-only. Your characters live in `customCharactersDir`, your picks in `$.store`.

## Where it lives

| File | Symbols |
| --- | --- |
| [`hooks/drawer.tsx`](../../plugins/buddy/hooks/drawer.tsx) | `DrawerView`, `DrawerActs`, `MenuState`, `PickerView`, `SHORTCUTS`, `openSuggestion`, `guideRows`, `drawDrawer`, `drawPicker`; `guide`, `thread` inside it |
| [`src/drawer.ts`](../../plugins/buddy/src/drawer.ts) | `drawerRows`, `pickerContentRows`, `pickerBodyRows` |
| [`src/command.ts`](../../plugins/buddy/src/command.ts) | `DRAWER_KEYS` |
| [`src/feed.ts`](../../plugins/buddy/src/feed.ts) | `FeedEntry`, `pushEntry`, `markRead`, `pruneToMemory`, `feedOfMemory`, `answerSuggestions`, `isTaken`, `statsOf` |
| [`src/menu.ts`](../../plugins/buddy/src/menu.ts) | `Menu`, `Item`, `Originals`, `buildMenu`, `itemKey`, `allItems`, `findItem`, `currentKeyOf`, `rowLabel`, `menuRows`, `listWindow`, `paneRows`, `listWidth`, `previewOf` |
| [`src/chatFolder.ts`](../../plugins/buddy/src/chatFolder.ts) | `MEMORY_FILE`, `MEMORY_TEXT_FILE` |
| [`src/chatTurnsToRead.ts`](../../plugins/buddy/src/chatTurnsToRead.ts) | `memoryText` |
| [`hooks/buddy.tsx`](../../plugins/buddy/hooks/buddy.tsx) | `toggleDrawer`, `drawDrawerBand`, `drawerView`, `scrollDrawerToEnd`, `openPicker`, `openPane`, `buildPicker`, `lightRow`, `pressRow`, `closePicker`, `drawPickerPane`, `pickItem`, `writeMemoryText`, `changeFeed`, `seedFeed`, `save`, `findOriginals`, `restoreOriginal` |
| [`src/original.ts`](../../plugins/buddy/src/original.ts) | `originalLabel` |

## How it's tested

- Unit: [`tests/drawer.test.ts`](../../tests/drawer.test.ts): space for the inline picker at both terminal heights, a full drawer with no picker or a dock, and intrinsic content and stable button positions through the first measurement. [`tests/menu.test.ts`](../../tests/menu.test.ts): the two groups, a failure to look as a line, the current entry marked, the list's window, the preview's frames, card and errors. [`tests/feed.test.ts`](../../tests/feed.test.ts): whole texts, the window cut to the memory, the feed drawn back from it.
- Hooks: "the drawer" checks it has no button but its three shortcuts, each a ctrl+x chord on its engine action, their guide at the bottom-left before the ask box, and opens and folds it; it fills the band's rows with a short thread too, its last row naming `memory.md` once it is written and saying who writes it before; it fits the band, the thread counting its older messages. "the personality pane" checks ctrl+x t opens it holding the keyboard, Esc closing it, each character a Button, the current one marked and ringed; a ring moved onto another row lights it and the preview follows; Enter switches (saved, greeted, the `*` moved, the pane still open); folding the drawer closes it; a character that cannot be drawn is lit and never picked; text in the composer gets the hint row; a long list is windowed round the lit row; it shows an original from an invented `~/.claude.json` or its newest backup, restores it at a restart, and turns every unreadable or invalid file into its line. "the chat memory items" checks `memory.md` beside `memory.json`, written for items without turns too, and rewritten for whichever character is drawn while the items stay the chat's. "memory: whole messages, compactions, retries, and the drawer spanning it" checks the thread spans the memory, marks an interrupted turn, shows a compaction and is drawn back after a resume.
- Live: `npm run live:drawer` opens the drawer with `/buddy` in a real session, captures it, opens the personality picker with ctrl+x t, moves the ring with Down, switches with Enter, closes the picker with Esc, reaches the ask box with ctrl+x tab and folds the drawer with ctrl+x q; the live proof switches characters through the picker with Down, Up and Enter. Both run with the Shortcuts block in their own config dir's `keybindings.json` (`live_isolate`).
