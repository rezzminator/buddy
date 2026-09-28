import { clockOf, mix, packCells, rgbOf, seconds, shimmerRule, short, statsOf, wrapText, type FeedEntry } from '../src/feed.ts';
import { findItem, listWidth, previewOf, rowLabel, type Item, type Menu } from '../src/menu.ts';
import type { Soul } from '../src/original.ts';

// The drawer /buddy opens: the band above the prompt opened full width into
// two tabs, talk (the buddy and its whole thread with you, src/feed.ts) and
// personality (every character to pick, with a live preview, src/menu.ts).
// No `$` here: buddy.tsx hands it the surface's elements, what to draw and
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

/** The drawer's left column, the buddy; the column of each idea's button at the right-most side. */
const DRAWER_LEFT = 22;
const DRAWER_BUTTON = 16;

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

/** What the drawer's buttons and ask box do. */
export type DrawerActs = {
  use: (text: string) => void;
  ask: (text: string) => void;
  draft: string;
  setDraft: (text: string) => void;
  close: () => void;
  pet: () => void;
  talk: () => void;
  personality: () => void;
  pick: (item: Item) => void;
};

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
function thread(E: Elements, v: DrawerView, act: DrawerActs, centerW: number) {
  const { Box, Text, Button } = E;
  const textW = Math.max(10, centerW - LABEL_W - DRAWER_BUTTON - 1);
  // Messages only: its canned idle lines are the band's chatter, never a message.
  const messages = v.feed.filter((e) => e.kind !== 'line');
  // The newest idea still open is drawn as the main action.
  const openIdea = [...messages].reverse().find((e) => e.kind === 'suggest' && e.taken === undefined)?.id;
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
          : <Button key={`use${e.id}`} label="use" variant={e.id === openIdea ? 'primary' : undefined} dimColor={e.id !== openIdea} onPress={() => act.use(e.text)} />;
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
        <Box width={DRAWER_BUTTON} flexShrink={0} justifyContent="flex-end">{end}</Box>
      </Box>
    );
  });
  return rows.length === 0 ? <Text dimColor>{`Nothing between you and ${v.name} yet: ask it below, or finish a turn with Claude.`}</Text> : rows;
}

/** The personality tab: every character as a row to pick, beside the preview of the one the focus is on. */
function personality(E: Elements, v: DrawerView, act: DrawerActs) {
  const { Box, Text, Button } = E;
  const m = v.menu;
  if (!m) return <Text dimColor>Finding every character…</Text>;
  const p = previewOf(findItem(m.model, m.focused), v.frame, v.now);
  const groups = m.model.sections.map((s, n) => (
    <Box key={`group:${n}`} flexDirection="column" marginTop={n === 0 ? 0 : 1}>
      <Text bold>{s.title}</Text>
      {s.lines.map((line) => <Text wrap="wrap">{line}</Text>)}
      {s.items.map((item) => <Button key={item.key} label={rowLabel(item, m.current)} plain onPress={() => act.pick(item)} />)}
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

export function drawDrawer(E: Elements, v: DrawerView, act: DrawerActs) {
  const { Box, Text, Button, Input } = E;
  const s = statusOf(v);
  const st = statsOf(v.feed);
  const W = Math.max(60, v.cols);
  const centerW = Math.max(24, W - DRAWER_LEFT - 2);
  const talking = v.tab === 'talk';
  const left = (
    <Box key="left" flexDirection="column" width={DRAWER_LEFT} flexShrink={0} alignItems="center">
      {Sprite(E, v)}
      <Text bold color={v.color}>{v.name.toUpperCase().split('').join(' ')}</Text>
      <Text>
        <Text color={s.color}>{s.glyph}</Text>
        <Text dimColor>{` ${s.text}`}</Text>
      </Text>
      <Text dimColor>{`${st.comments + st.answers} replies`}</Text>
      <Text dimColor>{`${st.taken} of ${st.suggestions} ideas used`}</Text>
      <Text dimColor>{st.avgMs === null ? v.engine : `${seconds(st.avgMs)} · ${short(st.tokens)} tokens`}</Text>
      <Button key="pet" label={`♥ pet · ${v.pets}`} plain onPress={act.pet} />
    </Box>
  );
  const askW = Math.max(30, Math.floor(W / 2));
  return (
    <Box flexDirection="column" width={W}>
      {Shimmer(E, v, W)}
      <Box key="tabs" flexDirection="row" gap={2}>
        <Button key="tab-talk" label="talk" variant={talking ? 'primary' : undefined} dimColor={!talking} onPress={act.talk} />
        <Button key="tab-personality" label="personality" variant={talking ? undefined : 'primary'} dimColor={talking} onPress={act.personality} />
        <Text dimColor wrap="truncate-end">{talking ? `  everything ${v.name} remembers: your last ${v.turnsRemembered} turns with Claude` : `  pick who sits above your prompt`}</Text>
      </Box>
      <Box flexDirection="row" gap={2}>
        {left}
        <Box key="body" flexDirection="column" flexGrow={1} justifyContent="flex-end">{talking ? thread(E, v, act, centerW) : personality(E, v, act)}</Box>
      </Box>
      <Box key="hint" flexDirection="row" justifyContent="space-between">
        <Text dimColor wrap="truncate-end">ctrl+x tab steps in · ←→ move · ↑↓ scroll · Enter presses · ctrl+x x closes</Text>
        {/* ctrl+x x, the chord that closes a pane, presses it from the prompt too, while no pane holds that chord. */}
        <Button key="close" label="✕ close" action="pane:close" dimColor onPress={act.close} />
      </Box>
      {Input ? (
        <Box key="ask" flexDirection="row" justifyContent="center">
          <Box borderStyle="round" borderColor={v.status === 'thinking' ? 'yellow' : v.color} borderDimColor={v.status !== 'thinking'} paddingX={1} width={askW}>
            <Input key="ask-input" placeholder={v.status === 'thinking' ? `${v.name} is thinking…` : `ask ${v.name}…`} submitLabel="ask" value={act.draft} onInput={(t: string) => act.setDraft(t)} onSubmit={(t: string) => act.ask(t)} />
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
