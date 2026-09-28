import { clockOf, mix, packCells, rgbOf, seconds, shimmerRule, short, statsOf, wrapText, type FeedEntry } from '../src/feed.ts';
import { findItem, listWidth, previewOf, rowLabel, type Menu } from '../src/menu.ts';
import type { Soul } from '../src/original.ts';

// The drawer /buddy opens: the band above the prompt opened full width into
// two tabs, talk (the buddy and its whole thread with you, src/feed.ts) and
// personality (every character to pick, with a live preview, src/menu.ts).
// It has no buttons: every act is a ctrl+x chord (SHORTCUTS), their guide the
// drawer's last row, at its left. No `$` here: buddy.tsx hands it the surface's elements, what to draw and
// the handlers.

/** A surface's element constructor, as buddy.tsx types it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Component = any;
export type Elements = { Box: Component; Text: Component; Button: Component; Input?: Component; Raster?: Component };

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


/** How long the light takes to run along the rule once. */
const SWEEP_MS = 3200;

/** The rule's cells at `now`: `width` cells in the ink `color`, dim, a light passing along it. */
function ruleCells(color: string, width: number, now: number): string {
  const ink = rgbOf(color);
  return packCells(shimmerRule(width, mix(ink, 0x000000, 0.7), ink, (now % SWEEP_MS) / SWEEP_MS));
}

/** A rule of light running along the drawer in the buddy's ink, or a plain one where there is no Raster. */
function Shimmer(E: Elements, v: DrawerView, width: number) {
  const { Raster, Text } = E;
  if (!Raster) return <Text color={v.color}>{'━'.repeat(Math.max(1, width))}</Text>;
  return <Raster key="rule" columns={Math.max(1, width)} rows={1} cells={ruleCells(v.color, width, v.now)} />;
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
 * while the drawer is open. ctrl+x b and ctrl+x x are the engine's own
 * defaults; the others are bound in keybindings.json (README: Shortcuts).
 */
export const SHORTCUTS = [
  { key: 'key-tab', chord: 'ctrl+x t', does: 'talk/personality', action: 'pane:next' },
  { key: 'key-use', chord: 'ctrl+x u', does: 'use the idea', action: 'pane:previous' },
  { key: 'key-next', chord: 'ctrl+x n', does: 'next character', action: 'diff:back' },
  { key: 'key-back', chord: 'ctrl+x b', does: 'previous character', action: 'app:cycleDiffBase' },
  { key: 'key-pet', chord: 'ctrl+x p', does: 'pet', action: 'permission:toggleDebug' },
  { key: 'close', chord: 'ctrl+x x', does: 'close', action: 'pane:close' },
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

/** The whole thread the buddy remembers, oldest first: a section per turn of yours or compaction, each message of yours and its under it. */
function thread(E: Elements, v: DrawerView, centerW: number) {
  const { Box, Text } = E;
  const textW = Math.max(10, centerW - LABEL_W - DRAWER_MARK - 1);
  // Messages only: its canned idle lines are the band's chatter, never a message.
  const messages = v.feed.filter((e) => e.kind !== 'line');
  // The newest idea still open is the one ctrl+x u uses.
  const idea = openIdea(messages)?.id;
  const rows = messages.map((e) => {
    if (e.kind === 'clear') return sectionRule(E, `d${e.id}`, centerW, `${clockOf(e.at)}  new conversation`, '');
    if (e.kind === 'compact') return sectionRule(E, `d${e.id}`, centerW, `${clockOf(e.at)}  chat compacted · ${v.name} read its summary: `, e.text);
    if (e.kind === 'you') return sectionRule(E, `d${e.id}`, centerW, `${clockOf(e.at)}  you → Claude: `, e.text, e.read === false ? `  · interrupted, ${v.name} never read it` : '');
    const who = speaker(e, v);
    const lines = wrapText(e.kind === 'failed' ? `couldn't answer: ${e.text}` : e.text, textW);
    const end = e.kind !== 'suggest'
      ? null
      : e.taken === true
        ? <Text color="green">✓ you sent it</Text>
        : e.taken === false
          ? <Text dimColor>not sent</Text>
          : e.id === idea
            ? <Text color="magenta">ctrl+x u uses it</Text>
            : null;
    return (
      <Box key={`d${e.id}`} flexDirection="row">
        <Box width={LABEL_W} flexShrink={0}>
          <Text wrap="truncate-end">
            <Text color={who.color}>{`${who.glyph} `}</Text>
            <Text color={who.color} bold={who.bold}>{who.label}</Text>
          </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {lines.map((l) => (who.text ? <Text color={who.text} italic={e.kind === 'suggest'}>{l}</Text> : <Text bold={who.bold}>{l}</Text>))}
        </Box>
        <Box width={DRAWER_MARK} flexShrink={0} justifyContent="flex-end">{end}</Box>
      </Box>
    );
  });
  return rows.length === 0 ? <Text dimColor>{`Nothing between you and ${v.name} yet: ask it below, or finish a turn with Claude.`}</Text> : rows;
}

/** The personality tab: every character as a row, the one ctrl+x n and b stepped to lit, beside its preview. */
function personality(E: Elements, v: DrawerView) {
  const { Box, Text } = E;
  const m = v.menu;
  if (!m) return <Text dimColor>Finding every character…</Text>;
  const p = previewOf(findItem(m.model, m.focused), v.frame, v.now);
  const groups = m.model.sections.map((s, n) => (
    <Box key={`group:${n}`} flexDirection="column" marginTop={n === 0 ? 0 : 1}>
      <Text bold>{s.title}</Text>
      {s.lines.map((line) => <Text wrap="wrap">{line}</Text>)}
      {s.items.map((item) => (
        <Box key={item.key}>
          <Text inverse={item.key === m.focused} wrap="truncate-end">{rowLabel(item, m.current)}</Text>
        </Box>
      ))}
    </Box>
  ));
  const preview =
    p.kind === 'error' ? (
      <Box key="preview" flexDirection="column">
        <Text bold>{p.label}</Text>
        <Text wrap="wrap">{`Can't draw it: ${p.error}`}</Text>
      </Box>
    ) : (
      <Box key="preview" flexDirection="column">
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

/** The last row, at the drawer's left: every shortcut, each pressed by its chord. */
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
    <Box key="guide" flexDirection="row" flexWrap="wrap">
      <Text dimColor>{E.Input ? 'ctrl+x tab ask · ' : ''}</Text>
      {SHORTCUTS.map((k, n) => (
        <Box key={`g${k.key}`} flexDirection="row">
          <Button key={k.key} label={`${k.chord} ${k.does}`} plain dimColor action={k.action} onPress={does[k.key]} />
          <Text dimColor>{n < SHORTCUTS.length - 1 ? ' · ' : ''}</Text>
        </Box>
      ))}
    </Box>
  );
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
  const left = (
    <Box key="left" flexDirection="column" width={DRAWER_LEFT} flexShrink={0} alignItems="center" {...frame}>
      {Sprite(E, v)}
      <Text bold color={v.color}>{v.name.toUpperCase().split('').join(' ')}</Text>
      <Text>
        <Text color={s.color}>{s.glyph}</Text>
        <Text dimColor>{` ${s.text}`}</Text>
      </Text>
      <Text dimColor>{`${st.comments + st.answers} replies`}</Text>
      <Text dimColor>{`${st.taken} of ${st.suggestions} ideas used`}</Text>
      <Text dimColor>{st.avgMs === null ? v.engine : `${seconds(st.avgMs)} · ${short(st.tokens)} tokens`}</Text>
      <Text color="red">{`♥ ${v.pets}`}</Text>
    </Box>
  );
  const askW = Math.max(30, Math.floor(W / 2));
  return (
    <Box flexDirection="column" width={W}>
      {Shimmer(E, v, W)}
      <Box key="frame" flexDirection="column" width={W} borderStyle="round" borderColor={v.color} paddingX={1}>
        <Box key="tabs" flexDirection="row" gap={2}>
          <Text key="tab-talk" bold={talking} inverse={talking} dimColor={!talking}>{' talk '}</Text>
          <Text key="tab-personality" bold={!talking} inverse={!talking} dimColor={talking}>{' personality '}</Text>
          <Text dimColor wrap="truncate-end">{talking ? `  everything ${v.name} remembers: your last ${v.turnsRemembered} turns with Claude` : `  who sits above your prompt: ctrl+x n and b switch`}</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          {left}
          <Box key="body" flexDirection="column" flexGrow={1} justifyContent="flex-end" paddingX={1} {...frame}>{talking ? thread(E, v, centerW) : personality(E, v)}</Box>
        </Box>
      </Box>
      {Input ? (
        <Box key="ask" flexDirection="row" justifyContent="center">
          <Box borderStyle="round" borderColor={v.status === 'thinking' ? 'yellow' : v.color} borderDimColor={v.status !== 'thinking'} paddingX={1} width={askW}>
            <Input key="ask-input" autoFocus placeholder={v.status === 'thinking' ? `${v.name} is thinking…` : `ask ${v.name}…`} submitLabel="ask" value={act.draft} onInput={(t: string) => act.setDraft(t)} onSubmit={(t: string) => act.ask(t)} />
          </Box>
        </Box>
      ) : null}
      {guide(E, v, act)}
    </Box>
  );
}
