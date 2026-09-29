import { clockOf, seconds, short, statsOf, wrapText, type FeedEntry, type TurnEnding } from '../src/feed.ts';
import { findItem, listWidth, previewOf, rowLabel, type Menu } from '../src/menu.ts';
import type { Soul } from '../src/original.ts';

/** What a turn row says of a turn the buddy never read, by how it ended; `unanswered` when that was not kept. */
const UNREAD: Record<TurnEnding | 'unanswered', string> = { interrupted: 'interrupted', error: 'ended by an error', refusal: 'refused', unanswered: 'unanswered' };

// The drawer /buddy opens: the band above the prompt opened full width into
// two tabs, talk (the buddy and its whole thread with you, src/feed.ts) and
// personality (every character to pick, with a live preview, src/menu.ts).
// It has no buttons: every act is a ctrl+x chord (SHORTCUTS), their guide the
// drawer's bottom-left, beside the ask box at its bottom-right. No `$` here: buddy.tsx hands it the surface's elements, what to draw and
// the handlers.

/** A surface's element constructor, as buddy.tsx types it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Component = any;
export type Elements = { Box: Component; Text: Component; Button: Component; Input?: Component };

/** The personality tab: its characters, the one drawn now and the one the preview shows (keys), the soul an original is rolled from. */
export type MenuState = { model: Menu; current: string; focused: string; soul: Soul | null };

/** What the drawer draws from. `frame`: the animation's tick. `status`: what the buddy is doing now. `menu`: the personality tab's, null while it is built or the talk tab shows. */
export type DrawerView = {
  feed: readonly FeedEntry[];
  now: number;
  frame: number;
  name: string;
  /** The sprite's ink now (a shiny one's changes per tick). */
  color: string;
  sprite: readonly string[];
  status: 'thinking' | 'idle' | 'asleep' | 'hidden';
  /** Model and effort, as the buddy's calls are sent: `opus · low`. */
  engine: string;
  pets: number;
  /** How many of the main chat's turns the buddy remembers: the drawer spans the same. */
  turnsRemembered: number;
  tab: 'talk' | 'personality';
  menu: MenuState | null;
  /** Columns and rows the drawer draws into. */
  cols: number;
  rows: number;
};

const STATUS: Record<DrawerView['status'], { glyph: string; text: string; color: string }> = {
  thinking: { glyph: '◐', text: 'thinking…', color: 'yellow' },
  idle: { glyph: '●', text: 'listening', color: 'green' },
  asleep: { glyph: '☾', text: 'napping', color: 'blue' },
  hidden: { glyph: '○', text: 'hidden · /buddy on', color: 'gray' },
};

/** The spinner the thinking status turns through, a quarter per tick. */
const SPIN = ['◐', '◓', '◑', '◒'];

function statusOf(v: DrawerView): { glyph: string; text: string; color: string } {
  const s = STATUS[v.status];
  return v.status === 'thinking' ? { ...s, glyph: SPIN[v.frame % SPIN.length]! } : s;
}


/** The sprite, each row in the buddy's ink. */
function Sprite(E: Elements, v: DrawerView) {
  const { Box, Text } = E;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {v.sprite.map((row) => <Text color={v.color}>{row}</Text>)}
    </Box>
  );
}

const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim();
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t);


// ---- the drawer -------------------------------------------------------------

/** The drawer's left column, the buddy; the column at the right-most side saying what became of each idea. */
const DRAWER_LEFT = 22;
const DRAWER_MARK = 16;

/**
 * The drawer's shortcuts, each a ctrl+x chord. A plugin hears a chord only
 * through an engine keybinding action no engine handler holds at the prompt:
 * each is drawn as a plain Button naming its action, which the chord presses
 * while the drawer is open. Each action is one the engine handles only inside
 * a panel or dialog, so none is a chord it uses at the prompt, and with that
 * panel or dialog open the engine's handler wins. ctrl+x b is the engine's own
 * default; the others are bound in keybindings.json (README: Shortcuts).
 */
export const SHORTCUTS = [
  { key: 'key-tab', chord: 'ctrl+x t', does: 'talk/personality', action: 'pane:next' },
  { key: 'key-use', chord: 'ctrl+x u', does: 'use the idea', action: 'pane:previous' },
  { key: 'key-next', chord: 'ctrl+x n', does: 'next character', action: 'diff:back' },
  { key: 'key-back', chord: 'ctrl+x b', does: 'previous character', action: 'app:cycleDiffBase' },
  { key: 'key-pet', chord: 'ctrl+x p', does: 'pet', action: 'permission:toggleDebug' },
  { key: 'close', chord: 'ctrl+x q', does: 'close', action: 'confirm:previousField' },
] as const;
export type Shortcut = (typeof SHORTCUTS)[number]['key'];

/** How a drawer row says who spoke and how: a glyph, a label, their color, the text's own. */
function speaker(e: FeedEntry, v: DrawerView): { glyph: string; label: string; color: string; text: string; bold: boolean } {
  const name = e.who ?? v.name;
  const ink = e.color ?? v.color;
  switch (e.kind) {
    case 'ask':
      return { glyph: '❯', label: `you asked ${name}`, color: 'cyan', text: 'cyan', bold: true };
    case 'answer':
      return { glyph: '↳', label: `${name} answered`, color: ink, text: '', bold: true };
    case 'comment':
      return { glyph: '◆', label: `${name} commented`, color: ink, text: '', bold: false };
    case 'verdict':
      if (e.verdict === 'WRONG') return { glyph: '✗', label: `${name}: WRONG`, color: 'red', text: 'red', bold: true };
      if (e.verdict === 'SHORTCUT') return { glyph: '!', label: `${name}: shortcut`, color: 'yellow', text: 'yellow', bold: false };
      return { glyph: '✓', label: `${name}: right call`, color: 'green', text: 'green', bold: false };
    case 'memory':
      return { glyph: '✎', label: `${name}'s notes`, color: ink, text: '', bold: false };
    case 'suggest':
      return { glyph: '✦', label: `${name} suggested`, color: 'magenta', text: 'magenta', bold: false };
    case 'failed':
      return { glyph: '✗', label: `${name} failed`, color: 'red', text: 'red', bold: false };
    default:
      return { glyph: '·', label: name, color: 'gray', text: '', bold: false };
  }
}

/** The drawer's label column: the glyph, a space, the longest label it cuts to. */
const LABEL_W = 20;

/** What the drawer's shortcuts and ask box do. `step`: the next (1) or previous (-1) character, switched to at once. */
export type DrawerActs = {
  use: (text: string) => void;
  ask: (text: string) => void;
  draft: string;
  setDraft: (text: string) => void;
  close: () => void;
  pet: () => void;
  tab: () => void;
  step: (by: 1 | -1) => void;
};

/** The newest idea you have neither sent nor passed over: what ctrl+x u puts in the prompt box. */
export function openIdea(feed: readonly FeedEntry[]): FeedEntry | undefined {
  return [...feed].reverse().find((e) => e.kind === 'suggest' && e.taken === undefined);
}

/** A section rule across the thread: `head` dim, `body` bright, `tail` dim after it. */
function sectionRule(E: Elements, key: string, width: number, head: string, body: string, tail = '') {
  const { Text } = E;
  const room = Math.max(8, width - head.length - tail.length - 6);
  const shown = clip(oneLine(body), room);
  return (
    <Text key={key} wrap="truncate-end">
      <Text dimColor>{`── ${head}`}</Text>
      <Text color="white">{shown}</Text>
      <Text dimColor>{`${tail} ${'─'.repeat(Math.max(2, width - head.length - shown.length - tail.length - 4))}`}</Text>
    </Text>
  );
}

/** The thread the buddy remembers, oldest first: a section per turn of yours or compaction, each message of yours and its under it; the newest `height` rows of it, the first then saying how many messages are older. */
function thread(E: Elements, v: DrawerView, centerW: number, height: number) {
  const { Box, Text } = E;
  const textW = Math.max(10, centerW - LABEL_W - DRAWER_MARK - 1);
  // Messages only: its canned idle lines are the band's chatter, never a message.
  const messages = v.feed.filter((e) => e.kind !== 'line');
  // The newest idea still open is the one ctrl+x u uses.
  const idea = openIdea(messages)?.id;
  const drawn = messages.map((e) => {
    if (e.kind === 'clear') return { tall: 1, node: sectionRule(E, `d${e.id}`, centerW, `${clockOf(e.at)}  new conversation`, '') };
    if (e.kind === 'compact') return { tall: 1, node: sectionRule(E, `d${e.id}`, centerW, `${clockOf(e.at)}  chat compacted · ${v.name} read its summary: `, e.text) };
    if (e.kind === 'you') {
      // The turn's numbers in brief once it ended, and whether the buddy never read it.
      const notes = [e.numbers ?? '', e.read === false ? `${UNREAD[e.ended ?? 'unanswered']}, ${v.name} never read it` : ''].filter(Boolean);
      return { tall: 1, node: sectionRule(E, `d${e.id}`, centerW, `${clockOf(e.at)}  you → Claude: `, e.text, notes.length > 0 ? `  · ${notes.join(' · ')}` : '') };
    }
    const who = speaker(e, v);
    // Its notes one bullet each; anything else as it was said.
    const lines = e.kind === 'memory' ? e.text.split('\n').flatMap((n) => wrapText(`• ${n}`, textW)) : wrapText(e.kind === 'failed' ? `couldn't answer: ${e.text}` : e.text, textW);
    // A verdict says, under its why, what it judged against.
    const wants = e.kind === 'verdict' && e.desire ? wrapText(`wants: ${e.desire}`, textW) : [];
    const tall = Math.max(1, lines.length + wants.length);
    const end = e.kind !== 'suggest'
      ? null
      : e.taken === true
        ? <Text color="green">✓ you sent it</Text>
        : e.taken === false
          ? <Text dimColor>not sent</Text>
          : e.id === idea
            ? <Text color="magenta">ctrl+x u uses it</Text>
            : null;
    return { tall, node: (
      <Box key={`d${e.id}`} flexDirection="row">
        <Box width={LABEL_W} flexShrink={0}>
          <Text wrap="truncate-end">
            <Text color={who.color}>{`${who.glyph} `}</Text>
            <Text color={who.color} bold={who.bold}>{who.label}</Text>
          </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {lines.map((l) => (who.text ? <Text color={who.text} italic={e.kind === 'suggest'} bold={e.kind === 'verdict' && who.bold}>{l}</Text> : <Text bold={who.bold}>{l}</Text>))}
          {wants.map((l) => <Text dimColor>{l}</Text>)}
        </Box>
        <Box width={DRAWER_MARK} flexShrink={0} justifyContent="flex-end">{end}</Box>
      </Box>
    ) };
  });
  if (drawn.length === 0) return <Text dimColor>{`Nothing between you and ${v.name} yet: ask it below, or finish a turn with Claude.`}</Text>;
  let from = drawn.length;
  let used = 0;
  while (from > 0 && used + drawn[from - 1]!.tall <= height) used += drawn[--from]!.tall;
  // Past the height, the oldest go, a row left to say so; the newest is drawn whole even when it is taller.
  if (from > 0 && used + 1 > height && from < drawn.length - 1) used -= drawn[from++]!.tall;
  if (from === drawn.length) from = drawn.length - 1;
  const shown = drawn.slice(from).map((d) => d.node);
  return from === 0 ? shown : [<Text key="older" dimColor>{`↑ ${from} older message${from === 1 ? '' : 's'}`}</Text>, ...shown];
}

/** The personality tab: every character as a row, the one ctrl+x n and b stepped to lit, beside its preview; `height` rows of the list, round the lit one. */
function personality(E: Elements, v: DrawerView, height: number) {
  const { Box, Text } = E;
  const m = v.menu;
  if (!m) return <Text dimColor>Finding every character…</Text>;
  const p = previewOf(findItem(m.model, m.focused), v.frame, v.now);
  // One row each: a group's gap, title and lines, then its characters.
  const rows: { key: string; node: unknown }[] = m.model.sections.flatMap((s, n) => [
    ...(n === 0 ? [] : [{ key: `gap:${n}`, node: <Text key={`gap:${n}`}> </Text> }]),
    { key: `group:${n}`, node: <Text key={`group:${n}`} bold>{s.title}</Text> },
    ...s.lines.map((line, i) => ({ key: `line:${n}:${i}`, node: <Text key={`line:${n}:${i}`} wrap="truncate-end">{line}</Text> })),
    ...s.items.map((item) => ({
      key: item.key,
      node: (
        <Box key={item.key}>
          <Text inverse={item.key === m.focused} wrap="truncate-end">{rowLabel(item, m.current)}</Text>
        </Box>
      ),
    })),
  ]);
  const at = Math.max(0, rows.findIndex((r) => r.key === m.focused));
  const { from, to } = windowAround(rows.length, at, Math.max(3, height));
  const groups = rows.slice(from, to).map((r) => r.node);
  if (from > 0) groups[0] = <Text key="up" dimColor>{`↑ ${from + 1} more`}</Text>;
  if (to < rows.length) groups[groups.length - 1] = <Text key="down" dimColor>{`↓ ${rows.length - to + 1} more`}</Text>;
  const preview =
    p.kind === 'error' ? (
      <Box key="preview" flexDirection="column">
        <Text bold>{p.label}</Text>
        <Text wrap="wrap">{`Can't draw it: ${p.error}`}</Text>
      </Box>
    ) : (
      <Box key="preview" flexDirection="column" height={height} overflow="hidden">
        {p.rows.map((row) => <Text color={p.color}>{row}</Text>)}
        <Text bold>{p.name}</Text>
        <Text dimColor wrap="wrap">{p.about}</Text>
        <Text italic wrap="wrap">{`“${p.sample}”`}</Text>
        {p.card.map((row) => <Text wrap="truncate-end">{row}</Text>)}
      </Box>
    );
  return (
    <Box flexDirection="row" gap={3}>
      <Box flexDirection="column" flexShrink={0} width={listWidth(m.model)}>{groups}</Box>
      <Box flexDirection="column" flexGrow={1}>{preview}</Box>
    </Box>
  );
}

/** The drawer's bottom-left: every shortcut, its whole chord bright and what it does dim, each pressed by its chord. */
function guide(E: Elements, v: DrawerView, act: DrawerActs) {
  const { Box, Text, Button } = E;
  const idea = openIdea(v.feed);
  const does: Record<Shortcut, () => void> = {
    'key-tab': act.tab,
    'key-use': () => {
      if (idea) act.use(idea.text);
    },
    'key-next': () => act.step(1),
    'key-back': () => act.step(-1),
    'key-pet': act.pet,
    close: act.close,
  };
  return (
    <Box key="guide" flexDirection="row" flexWrap="wrap" columnGap={GUIDE_GAP}>
      {E.Input ? (
        <Text key="g-ask">
          <Text bold color={v.color}>ctrl+x tab</Text>
          <Text dimColor> ask</Text>
        </Text>
      ) : null}
      {SHORTCUTS.map((k) => (
        <Box key={`g${k.key}`} flexDirection="row">
          <Text bold color={v.color}>{`${k.chord} `}</Text>
          <Button key={k.key} label={k.does} plain dimColor action={k.action} onPress={does[k.key]} />
        </Box>
      ))}
    </Box>
  );
}

/** The gap between the guide's shortcuts. */
const GUIDE_GAP = 3;

/** How many rows the guide wraps to in `width` cells: its shortcuts packed whole, a row at a time. */
export function guideRows(width: number, withAsk: boolean): number {
  const items = [...(withAsk ? ['ctrl+x tab ask'] : []), ...SHORTCUTS.map((k) => `${k.chord} ${k.does}`)];
  let rows = 1;
  let used = 0;
  for (const item of items) {
    const need = used === 0 ? item.length : used + GUIDE_GAP + item.length;
    if (need <= width || used === 0) used = need;
    else {
      rows++;
      used = item.length;
    }
  }
  return rows;
}

/** The rows [from, to) of `count` a window of `size` shows with row `at` in it. */
export function windowAround(count: number, at: number, size: number): { from: number; to: number } {
  if (count <= size) return { from: 0, to: count };
  const from = Math.min(Math.max(0, at - Math.floor(size / 2)), count - size);
  return { from, to: from + size };
}

export function drawDrawer(E: Elements, v: DrawerView, act: DrawerActs) {
  const { Box, Text, Input } = E;
  const s = statusOf(v);
  const st = statsOf(v.feed);
  const W = Math.max(60, v.cols);
  // Inside the frame (a border and a column of padding each side), the body's own border and padding, and the gap to the card.
  const innerW = W - 4;
  const centerW = Math.max(24, innerW - DRAWER_LEFT - 1 - 4);
  const frame = { borderStyle: 'single', borderColor: 'gray', borderDimColor: true };
  const talking = v.tab === 'talk';
  // The drawer fits the band's rows: the frame's border and the body's (4), the bar under them (the tabs over the guide, beside the ask box's 3); the body takes the rest, the card's sprite left out when it would not fit.
  const askW = Math.min(64, Math.max(30, Math.floor(innerW * 0.4)));
  const barRows = Math.max(Input ? 3 : 0, 1 + guideRows(innerW - (Input ? askW + 2 : 0), Boolean(Input)));
  const bodyRows = Math.max(2, v.rows - 4 - barRows);
  const withSprite = v.sprite.length + 2 <= bodyRows;
  const left = (
    <Box key="left" flexDirection="column" width={DRAWER_LEFT} flexShrink={0} alignItems="center" {...frame}>
      {withSprite ? Sprite(E, v) : null}
      <Text bold color={v.color}>{v.name.toUpperCase().split('').join(' ')}</Text>
      <Text>
        <Text color={s.color}>{s.glyph}</Text>
        <Text dimColor>{` ${s.text}  `}</Text>
        <Text color="red">{`♥ ${v.pets}`}</Text>
      </Text>
    </Box>
  );
  return (
    <Box key="frame" flexDirection="column" width={W} borderStyle="round" borderColor={v.color} paddingX={1}>
      <Box flexDirection="row" gap={1}>
        {left}
        <Box key="body" flexDirection="column" flexGrow={1} justifyContent="flex-end" paddingX={1} {...frame}>{talking ? thread(E, v, centerW, bodyRows) : personality(E, v, bodyRows)}</Box>
      </Box>
      <Box key="bar" flexDirection="row" gap={2}>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} justifyContent="flex-end">
          <Box key="tabs" flexDirection="row" gap={2}>
            <Text key="tab-talk" bold={talking} inverse={talking} dimColor={!talking}>{' talk '}</Text>
            <Text key="tab-personality" bold={!talking} inverse={!talking} dimColor={talking}>{' personality '}</Text>
            <Text dimColor wrap="truncate-end">{`${talking ? `${v.name} remembers your last ${v.turnsRemembered} turns with Claude` : 'who sits above your prompt'} · ${st.comments + st.answers} replies · ${st.taken} of ${st.suggestions} ideas used · ${st.avgMs === null ? v.engine : `${seconds(st.avgMs)} · ${short(st.tokens)} tokens`}`}</Text>
          </Box>
          {guide(E, v, act)}
        </Box>
        {Input ? (
          <Box key="ask" borderStyle="round" borderColor={v.status === 'thinking' ? 'yellow' : v.color} borderDimColor={v.status !== 'thinking'} paddingX={1} width={askW} flexShrink={0}>
            <Input key="ask-input" autoFocus placeholder={v.status === 'thinking' ? `${v.name} is thinking…` : `ask ${v.name}…`} submitLabel="ask" value={act.draft} onInput={(t: string) => act.setDraft(t)} onSubmit={(t: string) => act.ask(t)} />
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
