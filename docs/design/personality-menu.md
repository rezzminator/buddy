# Personality menu

`/buddy-personality` picks the character from a menu instead of by id: every entry on the left, a live preview of the highlighted one on the right.
It is the only way to pick your original companion, and it changes nothing until you press Enter.

## The flow

```mermaid
sequenceDiagram
  participant You
  participant CC as Claude Code
  participant A as adapter
  You->>CC: /buddy-personality
  CC->>A: command.run
  A->>A: read the Yours group, build the menu, start the 500 ms clock
  A->>CC: $.ui.open, focused, closeOnEscape
  You->>CC: ↓ or ↑
  CC->>A: ui.focus, element = the row's key
  A->>CC: invalidate: the preview follows
  alt Enter
    CC->>A: the row's Button fires onPress
    A->>A: save the choice, switch, stop the clock
    A->>CC: $.ui.close
  else Esc
    CC->>A: ui.close
    A->>A: stop the clock; nothing saved
  end
```

The command opens a pane with `$.ui.open`, focused so it takes the arrow keys, with `closeOnEscape` so Esc closes it, and tall enough for every row or the preview, at most 30 rows (`menuRows`).
It replies `Pick a personality: ↑/↓ move, Enter picks, Esc closes.`
The pane's body is drawn by the adapter's `ui.render` hook for that pane (`drawMenu`), from a `Menu` that `buildMenu` makes as plain data.

## The probe: Buttons, not Select

A preview has to follow the highlight as it moves, before anything is picked.
A probe of the two ways to draw a list settled it: with one `Button` per row, Claude Code raises `ui.focus` on every arrow move, carrying the focused row's key; a `Select` raises nothing as its highlight moves.
So each entry is a plain `Button` keyed by its row (`use:{id}` or `original:{variant}`, `itemKey`), and the adapter's `ui.focus` hook, matched on the pane's id, moves the preview to `e.element` and restarts its animation.
The hook passes every move on unchanged with `next(e)`: Claude Code moves the ring, buddy only watches.
The row drawn now carries `autoFocus`, so the menu opens on it.

## The groups

| Group | Rows | When there are none |
| --- | --- | --- |
| Shipped | the plugin's `characters/`, by id | `No shipped characters found.`, or why the folder could not be read |
| Yours | your original companion, twice: `{name} — native install`, `{name} — npm install` | `No companion in {config} or its backups.`, or why the file could not be read; `{config}` is `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` when that is set |
| Your folder | the files in `customCharactersDir`, by id | `No folder set: the customCharactersDir option names one.`, `No character files in your folder.`, or why the folder could not be read |

`*` marks the row drawn now (`rowLabel`, `currentKeyOf`); for your original, the roll you picked.
An invalid file is still a row, `{id} (invalid)`.
A character file taking the reserved id `original` is no row: its error, naming the file, is a line in Your folder (`buildMenu`).
A shipped id your folder overrides appears once, under Your folder.
"Yours" is read afresh at every open (`findOriginals`), and a companion found in a backup adds `From the backup {name}.` above its rows ([Original companion](./original-companion.md)).

## The live preview

The right side shows the highlighted entry (`previewOf`): its `idle` animation in its color, its name, one line about it (the description, or an original's saved personality; never the persona prompt), its first greeting in quotes, and for an original the card: species, stars, shiny, five stat bars and the hatch date.

The preview has its own clock: `$.clock.every(PREVIEW_MS)`, 500 ms, one frame per beat.
It is separate from the band's clock, which stops while buddy is hidden and runs at the drawn character's period; the preview animates whatever you highlight, at one pace, hidden or not.
A focus move starts the new entry at frame 0.
Closing the menu in any way stops the clock (`stopMenu`).
A pane gone without a close event is never drawn again, so the clock also stops after 10 beats with no draw of the pane (`MENU_UNDRAWN_TICKS`), and the log says `menu.gone`.

## Enter and Esc

| Key | Does |
| --- | --- |
| ↑, ↓ | move the highlight; the preview follows; nothing is saved or switched |
| Enter | picks the row: saves it, switches the band to it, which greets, closes the pane |
| Esc | closes the pane; the character drawn and every saved choice stay as they were |

Enter on a row that will not draw writes the reason to the log and leaves the menu open.
Enter on a "Yours" row with no soul behind it does the same.

## Persistence and restart

Enter saves the store's `character` key; the menu is the only thing that writes it. Going back to the `character` option's character is a pick of its entry, which stores that id: the same character is drawn, and nothing clears the key.
For an original it saves `character: "original"` and, under `original`, the roll and the soul, never the identity.
The choice survives `/reload` and restarts; at a start with the original chosen, `restoreOriginal` rolls it again from the saved soul, with no backup scan.
A save that fails still switches for this session and says so in the bubble: `{name} is here (not saved: {why})`, for 10 seconds.
`/reload` rebuilds the plugin with no menu behind a pane left open, so that pane says `The menu closed; /buddy-personality opens it again.`

## Error lines that never read as absence

Every failure to look is a line where the missing rows would be, and every entry that cannot draw says why in the preview:

| Condition | What the menu shows |
| --- | --- |
| a folder cannot be listed | `couldn't read {folder}: {why}` in its group, and in the bubble at each session start and `/buddy reload` |
| neither `CLAUDE_CONFIG_DIR` nor HOME is set | `couldn't find .claude.json: neither CLAUDE_CONFIG_DIR nor HOME is set` in Yours |
| the config cannot be read | `couldn't read {config}: {why}` in Yours |
| the config is not JSON | `couldn't parse {config}: not valid JSON ({kind})`, never the parser's text, which can quote the file |
| its companion is malformed | `{config} has a companion, but {why}` |
| a place for backups cannot be listed, or backups would not parse | a note under Yours: `Couldn't list {place} to look for backups: {why}`, `Skipped {n} backups that did not read or parse.` |
| an invalid character file | the row `{id} (invalid)`; the preview `Can't draw it: {error}` |
| a character file takes the reserved id `original` | `original.json ({source}): "original" is reserved for your original companion; rename the file and its id` in Your folder; the band's bubble says it too, for 10 s, at each session start and `/buddy reload`, ending `; /buddy-personality lists your characters` |
| an original whose art will not draw | its row; the preview `Can't draw it: {why}`, such as a hat `species/hats.json` lacks |
| nothing highlighted | `Nothing to preview`: `no entry is highlighted` |
| the pane could not open | the reply `/buddy-personality couldn't open its pane: {why}` |
| the pane opened but is not placed | the reply `The menu is open but not drawn yet: {why}` |

## Decisions

- **Buttons with `ui.focus`.** Rejected: `Select`, which reports no highlight move, so no preview could follow it.
- **A focused pane.** Rejected: a list printed as the command's reply. A preview needs a surface that redraws, and a focused pane takes the keys.
- **A preview clock of its own.** Rejected: the band's clock, which stops while hidden and ticks at another character's pace.
- **Only Enter switches.** Rejected: switching as the highlight moves. Browsing stays free, and Esc is a clean cancel.
- **Enter remembers.** Rejected: a menu pick that lasts one session.
- **The menu is the one way to see and switch.** Rejected: `/buddy list` and `/buddy use {id}` beside it. Two ways to choose drift apart; the menu shows everything the list did, with a preview.
- **"Yours" read at every open.** Rejected: reading it once at start. A backup restored meanwhile shows at the next open, and a start never scans backups: with the original chosen it re-rolls from the saved soul.
- **Your additions live in a folder, never in `~/.claude.json`.** Rejected: storing characters or picks in that file. Claude Code rewrites it, so a key buddy added could be lost or race the engine's own write, and buddy treats it as read-only. Your characters live in `customCharactersDir`, your picks in `$.store`.

## Where it lives

| File | Symbols |
| --- | --- |
| [`src/menu.ts`](../../plugins/buddy/src/menu.ts) | `MENU_COMMAND`, `MENU_PANE`, `MENU_TITLE`, `PREVIEW_MS`, `MENU_MAX_ROWS`, `PREVIEW_ROWS`, `Menu`, `Item`, `Originals`, `buildMenu`, `itemKey`, `allItems`, `findItem`, `currentKeyOf`, `rowLabel`, `menuRows`, `previewOf` |
| [`hooks/buddy.tsx`](../../plugins/buddy/hooks/buddy.tsx) | `MenuState`, `openMenu`, `drawMenu`, `pickItem`, `stopMenu`, `save`, `findOriginals`, `restoreOriginal`; the `ui.focus` and `ui.close` hooks |
| [`src/original.ts`](../../plugins/buddy/src/original.ts) | `originalLabel`, `SHOWN_CONFIG` |

## How it's tested

- Unit: [`tests/menu.test.ts`](../../tests/menu.test.ts): the three groups, a failure to look as a line, the current row marked, the preview's frames, card and errors.
- Hooks: the `/buddy-personality` group opens the focused pane, moves the preview with `ui.focus`, picks with a press (saved, closed, greeted), shows an original from an invented `~/.claude.json` or its newest backup, restores it at a restart, and turns every unreadable or invalid file into its line.
- The testing kit cannot raise a person's Esc, so the hooks only check that the pane asks for `closeOnEscape`; the live proof presses the real key.
- Live: the six (i) rows open the menu, move with Down, close with Esc, pick with Enter, reopen it to check the `*` mark, and pick the default (duck) to return; rows (a) and (g) switch through it too, and row (c) reads its `*` mark.
