import type { On } from 'claude-code';
import { describe, expect, mock, test } from 'claude-code/testing';
import { ITEMS_HEAD } from '../src/memoryItems.ts';
import { RULES_CONTEXT_HEAD } from '../src/steering.ts';
import { AWAY_IDLE_MS, AWAY_SYSTEM, awayBody } from '../src/away.ts';
import { BUDDY_PROMPT } from '../src/chatTurnsToRead.ts';
import { SHORTCUTS, guideRows } from '../hooks/drawer.tsx';
import { roll } from '../src/hatch.ts';
import { BUDDY_PROMPT_CONTEXT, CHARACTER_RULE, EXTENDED_SUGGESTION_CONTEXT, JUST_ENDED, TAKEN_SUGGESTION_CONTEXT, memoryRule } from '../src/prompts.ts';

// Run with `claude plugin test plugins/buddy` (CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1).
// The plugin loads from this folder; `on` here sits beneath it and answers
// `$.fs`, `$.store`, `$.clock`, `$.model` and the rest from memory, so these
// tests draw inline fixture characters, never the shipped characters/*.json.

const START = { cwd: '.', surface: null, isInteractive: true } as const;
const BAND = { hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns: 100 };

function fixture(id: string, name: string, face: string, lines: Record<string, string[]> = {}) {
  return JSON.stringify({
    id,
    name,
    description: `${name}, a test fixture.`,
    persona: `You are ${name}, a test fixture.`,
    poses: {
      idle: [[` (${face}) `, ' /| |\\ ']],
      walkRight: [[` (${face})>`, ' /| |\\ '], [` (${face})>`, ' /|_|\\ ']],
      oops: [[` (${face.toUpperCase()})!`, ' /| |\\ ']],
      yay: [[` \\${face}/ `, '  | |  ']],
      thinking: [[` (${face})?`, ' /| |\\ ']],
    },
    lines,
    // No random rests: a test that waits for a step must see one.
    motion: { restChance: 0 },
  });
}

const FILES: Record<string, string> = {
  'duck.json': fixture('duck', 'Duck Fixture', 'd_d', { greeting: ['Duck fixture here.'] }),
  'fixy.json': fixture('fixy', 'Fixy', 'f_f', {
    greeting: ['Fixy says hi.'],
    toolFail: ['Fixy: oh no.'],
    testPass: ['Fixy: green!'],
    testFail: ['Fixy: red!'],
    thinking: ['Fixy ponders.'],
    farewell: ['Fixy waves.'],
  }),
  'broken.json': JSON.stringify({ id: 'broken', name: 'Broken', description: 'no persona', poses: { idle: [['x']] }, motion: { walk: false } }),
  'notes.txt': 'not a character',
};

/** `delayMs`: this answer alone comes that long later; `error`: the completion rejects with it instead. */
type Answer = { isAnswered: boolean; text?: string; reason?: string; status?: number | null; usage?: object; delayMs?: number; error?: string };
/** Files by absolute path (with their mtimes), whether listing the home folder is refused, whether writes of memory.json are refused (the first that many only), whether writes of memory.md are, character files shipped beside FILES. */
type Disk = { files?: Record<string, string>; mtimes?: Record<string, number>; refuseHome?: boolean; refuseMemory?: boolean; refuseMemoryTimes?: number; refuseMemoryText?: boolean; env?: Record<string, string>; builtins?: Record<string, string>; messages?: unknown[] | Error };

const HOME = '/test-home';
const SESSION = 'test-session';
/** The session's project root, and the buddy's folder in each session's own chat folder beside its transcript. */
const ROOT = '/work/app';
const chatDir = (session = SESSION) => `${HOME}/.claude/projects/-work-app/${session}/buddy`;

function world(on: On, store: Record<string, unknown> = {}, answers: { complete?: Answer; queue?: Answer[]; completeDelayMs?: number } = {}, disk: Disk = {}) {
  const logs: string[] = [];
  const completes: { model: string; effort?: string; system?: string; prompt: string; timeoutMs?: number }[] = [];
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const commands: string[] = [];
  const writes: string[] = [];
  const queue = [...(answers.queue ?? [])];
  const saved = new Map(Object.entries(store));
  const files = disk.files ?? {};
  const shipped: Record<string, string> = { ...FILES, ...disk.builtins };
  const opens: object[] = [];
  const closes: string[] = [];
  const focuses: string[] = [];
  const gets: string[] = [];
  let refused = 0;
  /** A read of `hidden` answers what the store held when asked, this long later: a read in flight; a write of it lands this long later. */
  const slow = { hiddenMs: 0, setHiddenMs: 0, sessionIdMs: 0, keysMs: 0, chatTurnsToReadGetMs: 0, chatTurnsToReadSetMs: 0 };
  /** The texts that reached the prompt box's suggestion beneath the plugin, and who proposed each. */
  const suggested: string[] = [];
  const origins: string[] = [];
  /** Every prompt as it reached the engine beneath the plugin, with the context attached on the way down. */
  const submitted: { text: string; context?: readonly string[] }[] = [];
  on('ui.open', async (_$, e) => {
    opens.push(e);
    return { value: { isPlaced: true as const } };
  });
  on('ui.close', async (_$, e) => {
    closes.push(e.id);
    return { value: undefined };
  });
  // Beneath the plugins, the ring lands where it was asked to.
  on('ui.focus', async (_$, e) => {
    // The person's ring moves (the event) and the plugin's own $.ui.focus({ requestId, key }) (the call) both land.
    const call = e as { element?: string; key?: string };
    focuses.push(String(call.element ?? call.key));
    return (call.key !== undefined ? { value: {} } : {}) as never;
  });
  // A lower turn.complete hook that throws, for the turn id `boom`.
  on('turn.complete', async (_$, e) => {
    if (e.turnId === 'boom') throw new Error('a lower turn.complete hook failed');
    return { text: '' };
  });
  /** Prompts a hook beneath the plugin drops: the engine never enters them. */
  const submit = { drop: new Set<string>() };
  on('prompt.submit', async (_$, e) => {
    submitted.push(e.context === undefined ? { text: e.text } : { text: e.text, context: e.context });
    return submit.drop.has(e.text) ? { drop: 'dropped beneath' } : { text: e.text };
  });
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }));
  on('prompt.suggest', async (_$, e) => {
    suggested.push(e.text);
    origins.push(e.origin.kind);
    return { isShown: true };
  });
  on('env.get', async (_$, e) => ({ value: e.name === 'HOME' ? HOME : disk.env?.[e.name] }));
  // The main conversation's rows as $.session.messages() reads them: none by default; an Error is a read that fails.
  const messageReads: number[] = [];
  on('session.messages', async () => {
    messageReads.push(Date.now());
    if (disk.messages instanceof Error) throw disk.messages;
    return { value: (disk.messages ?? []) as never };
  });
  on('fs.write', async (_$, e) => {
    if (disk.refuseMemoryText && e.path.endsWith('/memory.md')) throw new Error('EACCES');
    if (e.path.endsWith('/memory.json')) {
      // refuseMemoryTimes: only the first that many writes are refused.
      if (disk.refuseMemory && (disk.refuseMemoryTimes === undefined || refused++ < disk.refuseMemoryTimes)) throw new Error(`EACCES: not allowed to write ${e.path}`);
      // A memory write in flight lands that long later.
      if (slow.chatTurnsToReadSetMs > 0) await clock.sleep(slow.chatTurnsToReadSetMs);
    }
    writes.push(e.path);
    files[e.path] = e.text;
    return { value: undefined };
  });
  on('fs.stat', async (_$, e) => {
    if (files[e.path] === undefined) throw new Error(`ENOENT: ${e.path}`);
    return { value: { kind: 'file' as const, size: files[e.path]!.length, mtimeMs: disk.mtimes?.[e.path] ?? 0, isLink: false } };
  });
  on('store.get', async (_$, e) => {
    gets.push(e.key);
    const value = saved.get(e.key);
    if (e.key === 'hidden' && slow.hiddenMs > 0) await clock.sleep(slow.hiddenMs);
    // A chatTurnsToRead read in flight (one kept in the store before 1.0.0) answers what the store held when asked.
    if (e.key.startsWith('chatTurnsToRead:') && slow.chatTurnsToReadGetMs > 0) await clock.sleep(slow.chatTurnsToReadGetMs);
    return { value };
  });
  on('store.set', async (_$, e) => {
    if (e.key === 'hidden' && slow.setHiddenMs > 0) await clock.sleep(slow.setHiddenMs);
    saved.set(e.key, e.value);
    return { value: undefined };
  });
  on('store.keys', async () => {
    if (slow.keysMs > 0) await clock.sleep(slow.keysMs);
    return { value: [...saved.keys()] };
  });
  // As Claude Code does: after a /clear or a resume the process goes on under another session id.
  let sessionId: string = SESSION;
  on('session.end', async (_$, e) => {
    if (e.reason === 'clear' || e.reason === 'resume') sessionId = `${SESSION}-after-${e.reason}`;
    return { sessionId: e.sessionId };
  });
  on('session.root', async () => ({ value: ROOT }));
  on('session.cwd', async () => ({ value: ROOT }));
  on('session.id', async () => {
    if (slow.sessionIdMs > 0) await clock.sleep(slow.sessionIdMs);
    return { value: sessionId };
  });
  on('store.delete', async (_$, e) => {
    saved.delete(e.key);
    return { value: undefined };
  });
  const clock = mock.clock(on);
  on('ui.log', async (_$, e) => {
    logs.push(e.text);
    return { value: undefined };
  });
  on('command.register', async (_$, e) => {
    commands.push(e.name);
    return { value: { command: e.name } };
  });
  on('session.start', async (_$, e) => ({ cwd: e.cwd }));
  on('fs.exists', async (_$, e) => ({ value: Object.keys(files).some((f) => f === e.path || f.startsWith(`${e.path}/`)) }));
  on('fs.list', async (_$, e) => {
    if (e.path === HOME || e.path.startsWith(`${HOME}/`) || Object.keys(files).some((f) => f.startsWith(`${e.path}/`))) {
      // A thrown answer reaches the plugin as the kit's own rejection, not this message.
      if (disk.refuseHome && e.path === HOME) throw new Error(`EPERM: not allowed to list ${e.path}`);
      // A folder is listed by the files beneath it.
      const entries = new Map<string, 'file' | 'dir'>();
      for (const f of Object.keys(files)) if (f.startsWith(`${e.path}/`)) {
        const rest = f.slice(e.path.length + 1);
        entries.set(rest.split('/')[0]!, rest.includes('/') ? 'dir' : 'file');
      }
      return { value: [...entries].map(([name, kind]) => ({ name, kind, size: files[`${e.path}/${name}`]?.length ?? 0, mtimeMs: disk.mtimes?.[`${e.path}/${name}`] ?? 0, isLink: false })) };
    }
    if (!e.path.endsWith('/characters')) throw new Error(`ENOENT: ${e.path}`);
    return { value: Object.entries(shipped).map(([name, text]) => ({ name, kind: 'file' as const, size: text.length, mtimeMs: 0, isLink: false })) };
  });
  on('fs.read', async (_$, e) => {
    // A chatTurnsToRead read in flight answers what the file held when asked.
    const held = files[e.path];
    if (e.path.endsWith('/memory.json') && slow.chatTurnsToReadGetMs > 0) await clock.sleep(slow.chatTurnsToReadGetMs);
    if (held !== undefined) return { value: held };
    const art = /\/species\/([a-z]+)\.json$/.exec(e.path);
    if (art) return { value: art[1] === 'hats' ? HAT_ART : speciesArt(art[1]!) };
    if (e.path.startsWith(`${HOME}/`)) throw new Error(`ENOENT: ${e.path}`);
    const text = shipped[e.path.split('/').pop() ?? ''];
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`);
    return { value: text };
  });
  on('model.complete', async (_$, e) => {
    completes.push({ model: e.model, effort: e.effort, system: e.system, prompt: e.prompt, timeoutMs: e.timeoutMs });
    const a = queue.shift() ?? answers.complete ?? { isAnswered: true, text: 'A completed answer.' };
    const delayMs = a.delayMs ?? answers.completeDelayMs;
    if (delayMs) await clock.sleep(delayMs);
    if (a.error !== undefined) throw new Error(a.error);
    const { delayMs: _d, error: _e, ...answer } = a;
    return { value: { usage, ...answer } } as never;
  });
  return { logs, completes, clock, commands, saved, writes, opens, closes, files, focuses, gets, slow, suggested, origins, submit, submitted, messageReads };
}

/** A prompt without its turns' numbers lines: for a test of what is filed, not of the numbers. */
function withoutNumbers(p: string): string {
  return p.replace(/^Numbers: .*\n/gm, '');
}

/** `p` without the size marks of its steps (` [call 30 · output 2 chars]`), whose call sizes depend on the event's own fields. */
function withoutSizes(p: string): string {
  return p.replace(/ \[call [\d.]+[kM]? · output [\d.]+[kM]? chars\]/g, '');
}

/** The user's prompt entering while idle, and the main turn `turnId` it starts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function prompt($: any, text: string, turnId: string): Promise<void> {
  await $.prompt.submit({ text, origin: { kind: 'composer' } } as never);
  await $.turn.start({ text, turnId } as never);
}

function run(args: string) {
  return { command: 'buddy', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function band($: any, props: Partial<typeof BAND> = {}) {
  return $.ui.mount({ plugin: 'buddy', surface: 'terminal', component: 'AbovePrompt', requestId: BAND_ID, props: { ...BAND, ...props } });
}

/** The band's instance: the drawer scrolls it. */
const BAND_ID = 'band';

/** The rows a drawn tree takes on the terminal: a Box its height when set, else its children stacked (a column) or side by side (a row, Ink's default) and its border's two; a Text, Button or Input one. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowsOf(el: any): number {
  if (typeof el !== 'object' || el === null) return 0;
  if (el.type !== 'Box') return 1;
  const p = el.props ?? {};
  if (typeof p.height === 'number') return p.height;
  const kids: number[] = [el.children ?? []].flat(Infinity).map(rowsOf);
  return (p.flexDirection === 'column' ? kids.reduce((a, b) => a + b, 0) : Math.max(0, ...kids)) + (p.borderStyle ? 2 : 0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function shows(ui: any, text: RegExp): Promise<boolean> {
  return (await ui.find({ type: 'Text', text })) !== undefined;
}

/** The bubble's Text showing `text`: the hover card, its lines cut at their end, shows the same words. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function bubbleText(ui: any, text: RegExp): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await ui.findAll({ type: 'Text', text })).find((t: any) => t.props.wrap !== 'truncate-end');
}

describe('the band', () => {
  test('draws the stored character and its greeting', async ($, on) => {
    world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($);
    expect(await shows(ui, /\(f_f\)/)).toBe(true);
    expect(await shows(ui, /Fixy says hi\./)).toBe(true);
    await ui.unmount();
  });

  test('defaults to the duck', async ($, on) => {
    world(on);
    await $.session.start(START);
    const ui = await band($);
    expect(await shows(ui, /\(d_d\)/)).toBe(true);
    expect(await shows(ui, /Duck fixture here\./)).toBe(true);
    await ui.unmount();
  });

  test('hovering the band shows the last message to you: none before the first, then the answer, kept once its bubble is gone', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'Forty-two, friend.' } });
    await $.session.start(START);
    const ui = await band($);
    // The greeting is a canned line: never the card's.
    expect(await shows(ui, /^Nothing said to you yet\.$/)).toBe(true);
    await $.command.run(run('what is it?'));
    await w.clock.settle();
    await w.clock.advance(20_000);
    expect(await shows(ui, /^Forty-two, friend\.$/)).toBe(true);
    expect(await shows(ui, /Nothing said to you yet/)).toBe(false);
    await ui.unmount();
  });

  test('after a reload, the card says the last message to you the memory holds', async ($, on) => {
    const said = { at: 1, blocks: [{ characters: { fixy: [{ kind: 'question', question: 'why?', answer: 'Because, friend.' }] } }] };
    const w = world(on, { character: 'fixy' }, {}, { files: { [`${chatDir()}/memory.json`]: JSON.stringify(said) } });
    await $.session.start(START);
    const ui = await band($);
    await w.clock.settle();
    await w.clock.advance(1000);
    expect(await shows(ui, /^Because, friend\.$/)).toBe(true);
    await ui.unmount();
  });

  test('an invalid choice draws the duck and says why, in the bubble and the log', async ($, on) => {
    const w = world(on, { character: 'broken' });
    await $.session.start(START);
    const ui = await band($);
    expect(await shows(ui, /\(d_d\)/)).toBe(true);
    expect(await shows(ui, /Couldn't load broken: persona: required/)).toBe(true);
    expect(w.logs).toContain('buddy: character broken (builtin) is invalid: persona: required');
    // Claude Code names the plugin only in the debug log: every transcript notice names it itself.
    expect(w.logs.filter((l) => !l.startsWith('buddy: '))).toEqual([]);
    await ui.unmount();
  });

  test('an unknown choice says so', async ($, on) => {
    world(on, { character: 'ghost' });
    await $.session.start(START);
    const ui = await band($);
    // A long bubble wraps to its inner width: the same words, a line break where a space was.
    expect(await shows(ui, /Couldn't[ \n]load[ \n]ghost:[ \n]no[ \n]such[ \n]character;[ \n]ctrl\+x[ \n]t[ \n]in[ \n]\/buddy[ \n]picks[ \n]another/)).toBe(true);
    await ui.unmount();
  });

  test('a character file taking the reserved id "original" is said in the first greeting, pointing at the personality picker', async ($, on) => {
    const w = world(on, {}, {}, { builtins: { 'original.json': fixture('original', 'Impostor', 'i_i') } });
    await $.session.start(START);
    const ui = await band($);
    expect(await shows(ui, /\(d_d\)/)).toBe(true);
    expect(await shows(ui, /^original\.json[ \n]\(builtin\):[ \n]"original"[ \n]is[ \n]reserved[ \n]for[ \n]your[ \n]original[ \n]companion;[ \n]rename[ \n]the[ \n]file[ \n]and[ \n]its[ \n]id;[ \n]ctrl\+x[ \n]t[ \n]in[ \n]\/buddy[ \n]lists[ \n]your[ \n]characters$/)).toBe(true);
    expect(w.logs).toContain('buddy: original.json (builtin): "original" is reserved for your original companion; rename the file and its id');
    await ui.unmount();
  });

  test('yields to a survey and hides below its width', async ($, on) => {
    world(on, { character: 'fixy' });
    on('ui.render', { component: 'AbovePrompt' }, async ($$, e) => {
      const { Text } = $$.ui.resolve(e);
      return <Text>the engine's band</Text>;
    });
    await $.session.start(START);
    const survey = await band($, { hasSurvey: true });
    expect(await shows(survey, /\(f_f\)/)).toBe(false);
    expect(await shows(survey, /the engine's band/)).toBe(true);
    await survey.unmount();
    const narrow = await band($, { bodyColumns: 8 });
    expect(await shows(narrow, /\(f_f\)/)).toBe(false);
    await narrow.unmount();
  });

  test('walks once the greeting ends, after its 10 s', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($);
    await w.clock.advance(9_000);
    expect(await shows(ui, /Fixy says hi\./)).toBe(true);
    await w.clock.advance(2_000);
    expect(await shows(ui, /Fixy says hi\./)).toBe(false);
    const before = JSON.stringify(await ui.drawn());
    await w.clock.advance(1000);
    expect(JSON.stringify(await ui.drawn())).not.toBe(before);
    await ui.unmount();
  });
});

describe('/buddy', () => {
  test('is registered at session start', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    expect(w.commands).toEqual(['buddy']);
  });

  test('off hides and persists; on shows again', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    on('ui.render', { component: 'AbovePrompt' }, async ($$, e) => {
      const { Text } = $$.ui.resolve(e);
      return <Text>the engine's band</Text>;
    });
    await $.session.start(START);
    const ui = await band($);
    expect((await $.command.run(run('off'))).text).toBe('Fixy: "Fixy waves." (hidden; /buddy on brings Fixy back)');
    expect(w.saved.get('hidden')).toBe(true);
    expect(await shows(ui, /\(f_f\)/)).toBe(false);
    expect(await shows(ui, /the engine's band/)).toBe(true);
    expect((await $.command.run(run('on'))).text).toBe('Fixy is back');
    expect(await shows(ui, /\(f_f\)/)).toBe(true);
    await ui.unmount();
  });

  test('an idle question: ONE completion on opus at low effort; the persona, then the character rule and the memory rule; only the last 4 turns', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: '"Forty-two, friend."\nand more' } });
    await $.session.start(START);
    const ui = await band($);
    for (let n = 1; n <= 5; n++) {
      await prompt($, `ask number ${n}`, `t${n}`);
      await $.turn.complete({ reason: 'answer', answer: `reply number ${n}`, isAborted: false, turnId: `t${n}` } as never);
      await w.clock.settle();
    }
    const turnCalls = w.completes.length;
    expect((await $.command.run(run('what is up'))).text).toBe('Asked Fixy.');
    await w.clock.settle();
    expect(w.completes).toHaveLength(turnCalls + 1);
    const q = w.completes.at(-1)!;
    expect(q).toMatchObject({ model: 'opus', effort: 'low' });
    const system = q.system ?? '';
    expect(system.startsWith(`You are Fixy, a test fixture.\n\n${CHARACTER_RULE}\n\n`)).toBe(true);
    expect(system).toContain(memoryRule(4));
    expect(system).toContain('Answer in ONE line, at most 25 words, in character. Do not use tools. Do not think out loud.');
    expect(q.prompt).not.toContain('ask number 1');
    expect(q.prompt).not.toContain('reply number 1');
    for (const n of [2, 3, 4, 5]) {
      expect(q.prompt).toContain(`The user asked Claude:\nsuggested: none\nsent: ask number ${n}`);
      expect(q.prompt).toContain(`Claude answered:\nreply number ${n}`);
    }
    expect(q.prompt.endsWith('The user asks you directly: what is up')).toBe(true);
    expect(await shows(ui, /^Forty-two, friend\.$/)).toBe(true);
    await ui.unmount();
  });



  test('the second question remembers the first answer, before the question; kept per session in the store', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'Forty-two, friend.' } });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(run('remember the word pineapple'));
    await w.clock.settle();
    expect(w.completes[0]!.prompt).not.toContain('Forty-two');
    await $.command.run(run('what word?'));
    await w.clock.settle();
    const p = w.completes[1]!.prompt;
    // One exchange for the question with its answer; the thinking filler (Fixy ponders.) is never remembered.
    expect(p).toContain('What you remember, oldest first:\n\nBefore any turn of the main chat:\n- You said: Fixy says hi.\n- The user asked you: remember the word pineapple\n  You answered: Forty-two, friend.\n\n');
    expect(p).not.toContain('Fixy ponders.');
    expect(p.indexOf('You answered: Forty-two, friend.')).toBeLessThan(p.indexOf('The user asks you directly: what word?'));
    expect(p).not.toContain('The user asked you: what word?');
    expect(memory(w)).toMatchObject({
      blocks: [
        {
          characters: {
            fixy: [
              { kind: 'line', text: 'Fixy says hi.' },
              { kind: 'question', question: 'remember the word pineapple', answer: 'Forty-two, friend.' },
              { kind: 'question', question: 'what word?', answer: 'Forty-two, friend.' },
            ],
          },
        },
      ],
    });
    await ui.unmount();
  });

  test('a resumed session\'s question carries the stored chatTurnsToRead too: its turns and what was said after them', async ($, on) => {
    const w = world(on, { character: 'fixy', [`chatTurnsToRead:${SESSION}`]: { at: 1, blocks: [{ turnId: 'old', turn: { prompt: 'build the thing', answer: 'Built.' }, characters: { fixy: [{ kind: 'question', question: 'remember pineapple', answer: 'Pineapple, noted.' }] } }] } });
    await $.session.start(START);
    await $.command.run(run('which word?'));
    await w.clock.settle();
    const p = w.completes[0]!.prompt;
    expect(p).toContain('Turn 1. The user asked Claude:\nsuggested: none\nsent: build the thing\nClaude answered:\nBuilt.\n- The user asked you: remember pineapple\n  You answered: Pineapple, noted.\n');
    expect(p.indexOf('Pineapple, noted.')).toBeLessThan(p.indexOf('The user asks you directly: which word?'));
  });

  test('a switched character never claims another one\'s words', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'Forty-two, friend.' } });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(run('remember the word pineapple'));
    await w.clock.settle();
    await pick($, await personality($, w, ui), w, 'use:duck');
    await w.clock.settle();
    await ui.unmount();
    const again = await band($);
    await $.command.run(run('what word?'));
    await w.clock.settle();
    expect(w.completes[1]!.prompt).toContain('- You said: Duck fixture here.');
    expect(w.completes[1]!.prompt).not.toMatch(/pineapple|Forty-two|Fixy/);
    await again.unmount();
  });

  test('a chatTurnsToRead that cannot be saved is said in the next reply, never left out in silence', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { refuseMemory: true });
    await $.session.start(START);
    await $.command.run(run('first?'));
    await w.clock.settle();
    const out = (await $.command.run(run('second?'))).text;
    // The kit turns the refusal into its own rejection: the reply names what failed and the kit's reason.
    expect(out).toMatch(/^Asked Fixy\. \(Its chatTurnsToRead: remembering the (question|answer|line) failed: .+\)$/);
    expect(w.logs.some((l) => /^buddy: remembering the (question|answer|line) failed: .+/.test(l))).toBe(true);
    expect(memory(w)).toBeUndefined();
  });

  test('a malformed stored chatTurnsToRead is said in the reply, and what is sound is still remembered', async ($, on) => {
    const w = world(on, { character: 'fixy', [`chatTurnsToRead:${SESSION}`]: { at: 1, blocks: [{ characters: { fixy: [{ who: 'you', kind: 'question', text: 'old shape' }, { kind: 'line', text: 'Still here.' }] } }] } });
    await $.session.start(START);
    // The question reads its chatTurnsToRead after the reply: the failure is said in the next question's reply.
    await $.command.run(run('anyone?'));
    await w.clock.settle();
    const out = (await $.command.run(run('still there?'))).text;
    await w.clock.settle();
    expect(out).toBe('Asked Fixy. (Its chatTurnsToRead: reading the chatTurnsToRead failed: the stored chatTurnsToRead had 1 malformed entry, dropped)');
    expect(w.logs).toContain('buddy: reading the chatTurnsToRead failed: the stored chatTurnsToRead had 1 malformed entry, dropped');
    expect(w.completes[0]!.prompt).toContain('- You said: Still here.');
    expect(w.completes[0]!.prompt).not.toContain('old shape');
  });

  test("/buddy list and /buddy use {id}, from 0.1.0, point to the personality picker with no model call", async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    expect((await $.command.run(run('list'))).text).toBe("Switching characters moved to the personality picker: ctrl+x t in /buddy.");
    expect((await $.command.run(run('use cat'))).text).toBe("Switching characters moved to the personality picker: ctrl+x t in /buddy.");
    await w.clock.settle();
    expect(w.completes).toEqual([]);
  });

  test('a question asking for a prompt: the answer in the bubble, the prompt in the prompt box and the drawer as the suggested prompt ctrl+x u uses', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'Quote every evicted turn verbatim.\nSUGGEST_NEXT_PROMPT: design the memory ledger extractive, quotes checked as substrings' } });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(run('how should your memory work? put it in a prompt for me'));
    await w.clock.settle();
    expect(await shows(ui, /^Quote every evicted turn verbatim\.$/)).toBe(true);
    expect(w.suggested).toEqual(['design the memory ledger extractive, quotes checked as substrings']);
    await $.command.run(run(''));
    await w.clock.settle();
    expect(await shows(ui, /^ctrl\+x u uses it$/)).toBe(true);
    await ui.unmount();
  });

  test('a failed completion says so in the bubble with its reason and status', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: false, reason: 'api-error', status: 529 } });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(run('why?'));
    await w.clock.settle();
    expect(await shows(ui, /^Fixy couldn't answer: api-error 529$/)).toBe(true);
    expect(w.logs).toContain('buddy: a /buddy question got no answer: api-error 529');
    expect(w.completes).toHaveLength(1);
    await ui.unmount();
  });

  test('a completion with an empty reply is asked once more, then fails as empty-reply', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: false, reason: 'empty-reply' } });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(run('you there?'));
    await w.clock.settle();
    expect(w.completes).toHaveLength(2);
    expect(await shows(ui, /^Fixy couldn't answer: empty-reply$/)).toBe(true);
    await ui.unmount();
  });

  test('an empty reply followed by words: the retry answers, and the outcome counts both calls', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: false, reason: 'empty-reply' }, { isAnswered: true, text: 'Tangerine, noted.' }] });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(run('remember the word tangerine'));
    await w.clock.settle();
    expect(w.completes).toHaveLength(2);
    expect(w.completes[1]?.prompt).toBe(w.completes[0]?.prompt);
    expect(await shows(ui, /Tangerine, noted\./)).toBe(true);
    const one = records(w).find((r) => r.event === 'ask.outcome');
    expect(one).toMatchObject({ outcome: 'answered', inTok: 2, outTok: 2 });
    await ui.unmount();
  });

  test('a question asked while the main turn runs answers at once through one completion', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'Quack, I am here.' } });
    await $.session.start(START);
    const ui = await band($, { isWorking: true });
    await $.command.run(run('you like yourself!?'));
    await w.clock.settle();
    expect(w.completes).toHaveLength(1);
    expect(w.completes[0]).toMatchObject({ model: 'opus', effort: 'low' });
    expect(await shows(ui, /^Quack, I am here\.$/)).toBe(true);
    const exchanges: { answer?: string }[] = ring(w, 'fixy');
    expect(exchanges.at(-1)).toMatchObject({ question: 'you like yourself!?', answer: 'Quack, I am here.' });
    const records = (w.files[`${HOME}/.claude/buddy/buddy.log`] ?? '').trim().split('\n').map((l) => JSON.parse(l));
    expect(records.find((r) => r.event === 'ask.outcome')).toMatchObject({ outcome: 'answered' });
    await ui.unmount();
  });

  test('an answer stays in the bubble while tool calls go by', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    on('tool.call', async () => ({ result: { stdout: '', stderr: 'boom' }, text: 'boom', isError: true }) as never);
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(run('say hi'));
    await w.clock.settle();
    await $.tool.call({ tool: 'Bash', command: 'false' } as never);
    await w.clock.settle();
    expect(await shows(ui, /^A completed answer\.$/)).toBe(true);
    await ui.unmount();
  });

  test('a second ask while one is pending is refused out loud; the first still ends visibly', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { character: 'fixy' }, { completeDelayMs: 10 * 60 * 1000 });
    await $.session.start(START);
    const ui = await band($);
    expect((await $.command.run(run('say hi'))).text).toBe('Asked Fixy.');
    await w.clock.settle();
    const second = (await $.command.run(run('say ack'))).text;
    expect(second).toMatch(/still thinking about your last question/);
    expect(await shows(ui, /still thinking about your last question/)).toBe(true);
    // The completion's 90 s deadline ends the first ask.
    await w.clock.advance(91 * 1000);
    expect(await shows(ui, /^Fixy couldn't answer: /)).toBe(true);
    await w.clock.settle();
    const exchanges: { question?: string }[] = ring(w, 'fixy');
    expect(exchanges.at(-1)).toMatchObject({ question: 'say hi' });
    expect((await $.command.run(run('say ack'))).text).toBe('Asked Fixy.');
    await ui.unmount();
  });

  test('a completion past its 90 s: the bubble says so, the ask ends, and the next question is taken', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'Far too late.' }, completeDelayMs: 10 * 60 * 1000 });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(run('slow one?'));
    await w.clock.settle();
    await w.clock.advance(89_000);
    expect(await shows(ui, /^Fixy ponders\.$/)).toBe(true);
    await w.clock.advance(1_000);
    expect(await shows(ui, /^Fixy couldn't answer: no answer in 90 s$/)).toBe(true);
    expect(w.logs).toContain('buddy: a /buddy question got no answer: no answer in 90 s');
    await w.clock.settle();
    const records = (w.files[`${HOME}/.claude/buddy/buddy.log`] ?? '').trim().split('\n').map((l) => JSON.parse(l));
    expect(records.find((r) => r.event === 'ask.outcome')).toMatchObject({ outcome: 'failed', reason: 'no answer in 90 s' });
    // The ask is over: the next question is taken, not refused.
    expect((await $.command.run(run('again?'))).text).toBe('Asked Fixy.');
    await ui.unmount();
  });


  test('the thinking line stays up while the question is pending, past 60 s, and ends when the answer arrives', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'Late but here.' }, completeDelayMs: 81_000 });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(run('take your time'));
    await w.clock.settle();
    expect(await shows(ui, /^Fixy ponders\.$/)).toBe(true);
    await w.clock.advance(75_000);
    expect(await shows(ui, /^Fixy ponders\.$/)).toBe(true);
    await w.clock.advance(6_000);
    expect(await shows(ui, /^Late but here\.$/)).toBe(true);
    expect(await shows(ui, /Fixy ponders/)).toBe(false);
    await ui.unmount();
  });

  test('an ask writes its start and outcome to the log file; /buddy log shows the path and the last lines', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    await $.command.run(run('what is up'));
    await w.clock.settle();
    await w.clock.settle();
    const file = `${HOME}/.claude/buddy/buddy.log`;
    const records = (w.files[file] ?? '').trim().split('\n').map((l) => JSON.parse(l));
    expect(records.some((r) => r.event === 'ask.start' && r.level === 'info' && r.session === SESSION)).toBe(true);
    expect(records.some((r) => r.event === 'ask.outcome' && r.outcome === 'answered' && typeof r.ms === 'number')).toBe(true);
    expect(JSON.stringify(records.filter((r) => r.level === 'info'))).not.toContain('what is up');
    const out = (await $.command.run(run('log'))).text;
    expect(out!.split('\n')[0]).toBe(`Log: ${file}`);
    expect(out).toContain('"event":"ask.outcome"');
  });
});

describe('reactions', () => {
  /**
   * Calls the tool until its line shows, its pose drawn after every call: the
   * words come at TOOL_LINE_CHANCE on Math.random, which the kit cannot pin
   * (the chance itself is proven in the brain's tests); 60 calls all miss once
   * in 10^10 runs. Returns the calls it took, 0 when the line never showed.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function reactsUntil(ui: any, call: () => Promise<unknown>, pose: RegExp, line: RegExp): Promise<number> {
    for (let i = 1; i <= 60; i++) {
      await call();
      expect(await shows(ui, pose)).toBe(true);
      if (await shows(ui, line)) return i;
    }
    return 0;
  }

  test('a failed tool call: oops every time, the toolFail line at its chance', async ($, on) => {
    world(on, { character: 'fixy' });
    on('tool.call', async () => ({ result: { stdout: '', stderr: 'boom' }, text: 'boom', isError: true }) as never);
    await $.session.start(START);
    const ui = await band($);
    expect(await reactsUntil(ui, () => $.tool.call({ tool: 'Bash', command: 'false' } as never), /\(F_F\)!/, /Fixy: oh no\./)).toBeGreaterThan(0);
    await ui.unmount();
  });

  test('a passing test run: yay every time, the testPass line at its chance', async ($, on) => {
    world(on, { character: 'fixy' });
    on('tool.call', async () => ({ result: { stdout: 'Tests  12 passed (12)' }, text: 'Tests  12 passed (12)' }) as never);
    await $.session.start(START);
    const ui = await band($);
    expect(await reactsUntil(ui, () => $.tool.call({ tool: 'Bash', command: 'npm test' } as never), /\\f_f\//, /Fixy: green!/)).toBeGreaterThan(0);
    await ui.unmount();
  });

  test('a failing test run: oops every time, the testFail line at its chance', async ($, on) => {
    world(on, { character: 'fixy' });
    on('tool.call', async () => ({ result: { stdout: '3 failed, 9 passed' }, text: '3 failed, 9 passed', isError: true }) as never);
    await $.session.start(START);
    const ui = await band($);
    expect(await reactsUntil(ui, () => $.tool.call({ tool: 'Bash', command: 'npm test' } as never), /\(F_F\)!/, /Fixy: red!/)).toBeGreaterThan(0);
    await ui.unmount();
  });
});

// ---- the personality pane -----------------------------------------------------

// An invented account and companion: never a real ~/.claude.json.
const UUID = '7e57ab1e-0000-4c0d-9e11-5eedf00dcafe';
const MOCHI = { name: 'Mochi', personality: 'A round little creature who hums at green tests.', hatchedAt: 1775001600000 };
const CONFIG = `${HOME}/.claude.json`;
const HAT_ART = JSON.stringify({ crown: 'www', tophat: '_|_', propeller: '-+-', halo: '(_)', wizard: '/^\\', beanie: '(__)', tinyduck: '<o)' });
const B = '        ';

function speciesArt(species: string): string {
  const eyes = '  <{E}{E}>  ';
  const body = '  /__\\  ';
  return JSON.stringify({
    species,
    width: 8,
    hatCol: 3,
    poses: {
      idle: [[B, eyes, body], [B, eyes, body], [B, '  <-->  ', body]],
      walkRight: [[B, eyes, body], [B, eyes, '  /  \\  ']],
      oops: [[B, eyes, '  /!!\\  ']],
      yay: [[B, eyes, '  \\__/  ']],
      sleep: [[B, '  <-->  ', body]],
    },
    lines: { greeting: ['{name} says hello.'] },
  });
}

function config(companion?: object): string {
  return JSON.stringify({ userID: 'an-invented-user-id', oauthAccount: { accountUuid: UUID }, ...(companion ? { companion } : {}) });
}

function eyesOf(variant: 'native' | 'npm'): RegExp {
  const e = roll(UUID, variant).bones.eye.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<${e}${e}>`);
}

/** The personality pane's id, and its props as the terminal draws it inline above the prompt, holding the keyboard (the composer empty). */
const PICKER = 'personality';
const PANE = { title: 'personality', isFocused: true, bodyColumns: 100, placement: 'inline' as 'inline' | 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} };

/** /buddy opens the drawer on `ui`, the band; ctrl+x t opens the personality pane, drawn here with `props`, its list built. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function personality($: any, w: { clock: { settle: () => Promise<void> } }, ui: any, props: Partial<typeof PANE> = {}): Promise<any> {
  if (!(await ui.find({ key: 'key-personality' }))) await $.command.run(run(''));
  await ui.press({ key: 'key-personality' });
  await w.clock.settle();
  return $.ui.mount({ plugin: 'buddy', surface: 'terminal', component: 'Pane', requestId: PICKER, props: { ...PANE, ...props } });
}

/** ↓ or ↑ in the focused pane: the ring moving onto `key`'s row, as the engine raises it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function arrow($: any, w: { clock: { settle: () => Promise<void> } }, key: string): Promise<void> {
  await $.ui.focus({ component: 'Pane', requestId: PICKER, plugin: 'buddy', element: key, origin: { kind: 'person' } });
  await w.clock.settle();
}

/** The ring onto `key`'s row, then Enter on it: a character that can be drawn is switched to, one that cannot only lit. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pick($: any, pane: any, w: { clock: { settle: () => Promise<void> } }, key: string): Promise<void> {
  await arrow($, w, key);
  await pane.press({ key });
  await w.clock.settle();
}

/** The drawer's close button: the band draws the buddy and its bubble again. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fold(ui: any, w: { clock: { settle: () => Promise<void> } }): Promise<void> {
  await ui.press({ key: 'close' });
  await w.clock.settle();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function label(ui: any, key: string): Promise<unknown> {
  const found = await ui.find({ key });
  return found?.props.label ?? found?.text;
}

describe('the personality pane', () => {
  test('the picker keeps its requested content height while the surface measures a short first body', async ($, on) => {
    const w = world(on, { character: 'duck' });
    await $.session.start(START);
    const ui = await band($);
    const pane = await personality($, w, ui, { scroll: { offset: 0, bodyRows: 0 } });
    const wanted = (w.opens.at(-1) as { rows: number }).rows;
    expect(rowsOf(await pane.drawn())).toBe(wanted);
    expect(await shows(pane, /^Shipped$/)).toBe(true);
    await pane.unmount();
    await ui.unmount();
  });

  test('the inline picker leaves room above the drawer; closing and reopening the drawer restores its full height', async ($, on) => {
    const w = world(on, { character: 'duck' });
    await $.session.start(START);
    const ui = await band($, { bodyColumns: 160, maxRows: 50 });
    const pane = await personality($, w, ui);
    const wanted = (w.opens.at(-1) as { rows: number }).rows;
    expect(rowsOf(await ui.drawn())).toBe(50 - wanted - 2 - 6);
    expect(await pane.find({ key: 'use:duck' })).toBeDefined();
    await fold(ui, w);
    expect(w.closes).toEqual(['personality']);
    await $.command.run(run(''));
    await w.clock.settle();
    expect(rowsOf(await ui.drawn())).toBe(50);
    await pane.unmount();
    await ui.unmount();
  });

  test('a fullscreen dock leaves the drawer its full band', async ($, on) => {
    const w = world(on, { character: 'duck' });
    await $.session.start(START);
    const ui = await $.ui.mount({ plugin: 'buddy', surface: 'terminal', component: 'AbovePrompt', requestId: BAND_ID, viewport: { columns: 160, rows: 80, isFullscreen: true }, props: { ...BAND, bodyColumns: 160, scroll: { offset: 0, bodyRows: 40 }, view: {} } });
    const pane = await personality($, w, ui, { placement: 'dock' });
    expect(rowsOf(await ui.drawn())).toBe(40);
    await pane.unmount();
    await ui.unmount();
  });

  test('an earlier open left unplaced after the taller rebuilt list was placed keeps the drawer clear of the picker', async ($, on) => {
    // The first, shorter open answers last, and unplaced; the taller one the rebuilt list asks for is placed.
    let release = (): void => {};
    const held = new Promise<void>((r) => (release = r));
    let seen = 0;
    on('ui.open', { id: PICKER }, async (_$, e, next) => {
      if (++seen === 1) {
        await held;
        return { value: { isPlaced: false as const } } as never;
      }
      const placed = await next(e);
      release();
      return placed;
    });
    const w = world(on, {}, {}, { files: { [CONFIG]: config(MOCHI) } });
    await $.session.start(START);
    const ui = await band($, { bodyColumns: 160, maxRows: 50 });
    const pane = await personality($, w, ui);
    await w.clock.settle();
    expect(w.opens).toHaveLength(1);
    const wanted = (w.opens.at(-1) as { rows: number }).rows;
    expect(rowsOf(await ui.drawn())).toBe(50 - wanted - 2 - 6);
    await pane.unmount();
    await ui.unmount();
  });

  test('ctrl+x t opens it holding the keyboard, Esc closing it: the groups titled, each character a Button, the current one marked, ringed and previewed', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    const ui = await band($);
    const pane = await personality($, w, ui);
    // Shipped, its three characters, a gap, Yours and its line: taller than Fixy's preview.
    expect(w.opens).toMatchObject([{ id: 'personality', title: 'personality', focus: true, closeOnEscape: true, rows: 7 }]);
    for (const title of [/^Shipped$/, /^Yours$/]) expect(await shows(pane, title)).toBe(true);
    expect(await shows(pane, /^customCharactersDir$/)).toBe(false);
    const rows = (await pane.findAll({ type: 'Button' })) as { key: string; props: { label: string; autoFocus?: boolean } }[];
    expect(rows.map((r) => [r.key, r.props.label, r.props.autoFocus === true])).toEqual([
      ['use:broken', '  broken (invalid)', false],
      ['use:duck', '  Duck Fixture (duck)', false],
      ['use:fixy', '* Fixy (fixy)', true],
    ]);
    expect(await shows(pane, /^Fixy$/)).toBe(true);
    expect(await shows(pane, /^Fixy, a test fixture\.$/)).toBe(true);
    expect(await shows(pane, /You are Fixy/)).toBe(false);
    expect(await shows(pane, /^“Fixy says hi\.”$/)).toBe(true);
    expect(await shows(pane, /^None yet: set customCharactersDir to a folder of your own character files\.$/)).toBe(true);
    expect(await shows(pane, /clear your prompt/)).toBe(false);
    await pane.unmount();
    await ui.unmount();
  });

  test('the ring moved onto another row lights it, the preview following; Enter on it switches, saved and greeted, the * moved and the pane still open; folding the drawer closes it', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    const ui = await band($);
    const pane = await personality($, w, ui);
    await arrow($, w, 'use:duck');
    expect(await shows(pane, /^Duck Fixture$/)).toBe(true);
    expect(await shows(pane, /^Fixy$/)).toBe(false);
    expect(w.saved.get('character')).toBe('fixy');
    await pane.press({ key: 'use:duck' });
    await w.clock.settle();
    expect(w.saved.get('character')).toBe('duck');
    expect(await label(pane, 'use:duck')).toBe('* Duck Fixture (duck)');
    expect(await label(pane, 'use:fixy')).toBe('  Fixy (fixy)');
    expect(await shows(ui, /^D U C K {3}F I X T U R E$/)).toBe(true);
    expect(w.closes).toEqual([]);
    await fold(ui, w);
    expect(w.closes).toEqual(['personality']);
    expect(await shows(ui, /\(d_d\)/)).toBe(true);
    expect(await shows(ui, /Duck fixture here\./)).toBe(true);
    await ui.unmount();
  });

  test('a character that cannot be drawn is lit, its preview saying why, and Enter never picks it', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    const ui = await band($);
    const pane = await personality($, w, ui);
    await pick($, pane, w, 'use:broken');
    expect(await shows(pane, /^Can't draw it: persona: required$/)).toBe(true);
    expect(w.saved.get('character')).toBe('fixy');
    expect(await label(pane, 'use:fixy')).toBe('* Fixy (fixy)');
    expect(w.logs.filter((l) => /Can't pick/.test(l))).toEqual([]);
    await ui.unmount();
  });

  test('with text in the composer the pane does not hold the keyboard: its first row says how to reach it', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    const ui = await band($);
    const pane = await personality($, w, ui, { isFocused: false });
    expect(await shows(pane, /^clear your prompt, then ctrl\+x t to choose with ↑ ↓ and Enter$/)).toBe(true);
    const drawn = JSON.stringify(await pane.drawn());
    expect(drawn.indexOf('clear your prompt')).toBeLessThan(drawn.indexOf('Shipped'));
    await ui.unmount();
  });

  test('a list taller than the pane: a window round the lit row, the rows before and after it drawn, the rest counted', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    const ui = await band($);
    const pane = await personality($, w, ui, { scroll: { offset: 0, bodyRows: 5 } });
    expect(await pane.find({ key: 'use:duck' })).toBeDefined();
    expect(await pane.find({ key: 'use:broken' })).toBeUndefined();
    expect(await shows(pane, /^↑ 2 more$/)).toBe(true);
    expect(await shows(pane, /^↓ 2 more$/)).toBe(true);
    // The ring onto duck: broken, the row above it, is drawn for the ring to move onto next.
    await arrow($, w, 'use:duck');
    expect(await pane.find({ key: 'use:broken' })).toBeDefined();
    await ui.unmount();
  });

  test('a companion in ~/.claude.json: two Yours entries; Enter on one draws it, saves soul and roll, and its preview animates with its card', async ($, on) => {
    const w = world(on, {}, {}, { files: { [CONFIG]: config(MOCHI) } });
    await $.session.start(START);
    const ui = await band($);
    const pane = await personality($, w, ui);
    expect(await label(pane, 'original:native')).toBe('  Mochi — native install');
    expect(await label(pane, 'original:npm')).toBe('  Mochi — npm install');
    await pick($, pane, w, 'original:npm');
    expect(await shows(pane, /^Mochi$/)).toBe(true);
    expect(await shows(pane, eyesOf('npm'))).toBe(true);
    expect(await shows(pane, /^hatched 2026-04-01$/)).toBe(true);
    expect(await shows(pane, /^A round little creature who hums at green tests\.$/)).toBe(true);
    expect(await shows(pane, /You are Mochi/)).toBe(false);
    expect(await shows(pane, /^SNARK +[█░]{10} \d+$/)).toBe(true);
    // The preview's idle frames turn with the drawer's clock: a blink shows within a few ticks.
    let blinked = false;
    for (let i = 0; i < 6 && !blinked; i++) {
      await w.clock.advance(500);
      blinked = await shows(pane, /<-->/);
    }
    expect(blinked).toBe(true);
    expect(w.saved.get('character')).toBe('original');
    expect(w.saved.get('original')).toEqual({ variant: 'npm', soul: MOCHI });
    expect(await label(pane, 'original:npm')).toBe('* Mochi — npm install');
    await fold(ui, w);
    expect(await shows(ui, eyesOf('npm'))).toBe(true);
    expect(await shows(ui, /Mochi says hello\./)).toBe(true);
    // The plugin writes only its own log and the chat's buddy folder, and none of it holds the identity.
    expect(w.writes.filter((p) => !p.endsWith('/.claude/buddy/buddy.log') && !p.startsWith(`${chatDir()}/`))).toEqual([]);
    expect(w.writes.filter((p) => w.files[p]!.includes(UUID) || w.files[p]!.includes('an-invented-user-id'))).toEqual([]);
    expect(w.files[`${HOME}/.claude/buddy/buddy.log`] ?? '').not.toContain(UUID);
    expect(w.logs.join('\n')).not.toContain(UUID);
    expect(JSON.stringify([...w.saved.entries()])).not.toContain(UUID);
    await ui.unmount();
  });

  test('a restart draws the saved original with no backup scan; without the file it says why', async ($, on) => {
    world(on, { character: 'original', original: { variant: 'npm', soul: MOCHI } }, {}, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    const ui = await band($);
    expect(await shows(ui, eyesOf('npm'))).toBe(true);
    expect(await shows(ui, /Mochi says hello\./)).toBe(true);
    await ui.unmount();
  });

  test('a restart without ~/.claude.json draws the duck and says why', async ($, on) => {
    world(on, { character: 'original', original: { variant: 'native', soul: MOCHI } });
    await $.session.start(START);
    const ui = await band($);
    expect(await shows(ui, /\(d_d\)/)).toBe(true);
    expect(await shows(ui, /Couldn't load original: couldn't read ~\/\.claude\.json/)).toBe(true);
    await ui.unmount();
  });

  test('no companion in the file: the newest backup holding one, named', async ($, on) => {
    const files = {
      [CONFIG]: config(),
      [`${HOME}/.claude.json.bak-20260401`]: config({ ...MOCHI, name: 'Oldie' }),
      [`${HOME}/.claude/backups/.claude.json.backup.1775`]: config({ ...MOCHI, name: 'Newest' }),
      [`${HOME}/.claude.json.lock`]: 'not json',
    };
    const mtimes = { [`${HOME}/.claude.json.bak-20260401`]: 1, [`${HOME}/.claude/backups/.claude.json.backup.1775`]: 4, [`${HOME}/.claude.json.lock`]: 5 };
    const w = world(on, {}, {}, { files, mtimes });
    await $.session.start(START);
    const pane = await personality($, w, await band($));
    expect(await label(pane, 'original:native')).toBe('  Newest — native install');
    expect(await shows(pane, /^From the backup ~\/\.claude\/backups\/\.claude\.json\.backup\.1775\.$/)).toBe(true);
  });

  test('an unreadable ~/.claude.json is a plain line in Yours', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const pane = await personality($, w, await band($));
    expect(await shows(pane, /^couldn't read ~\/\.claude\.json: \S/)).toBe(true);
    expect(await pane.find({ key: 'original:native' })).toBeUndefined();
  });

  test('an invalid ~/.claude.json is a plain line in Yours, never its contents', async ($, on) => {
    const w = world(on, {}, {}, { files: { [CONFIG]: '{"secretToken": oops' } });
    await $.session.start(START);
    const pane = await personality($, w, await band($));
    expect(await shows(pane, /^couldn't parse ~\/\.claude\.json: not valid JSON \(SyntaxError\)$/)).toBe(true);
    expect(w.logs.join('\n')).not.toContain('secretToken');
  });

  test('no companion anywhere takes no line: Yours holds only your own characters, or says how to add some', async ($, on) => {
    const w = world(on, {}, {}, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    const pane = await personality($, w, await band($));
    expect(await shows(pane, /No companion/)).toBe(false);
    expect(await shows(pane, /^None yet: set customCharactersDir to a folder of your own character files\.$/)).toBe(true);
  });
});

describe('core fixes', () => {
  test('a session whose band never draws (claude -p, the SDK) remembers no line; once drawn, the lines it shows are kept', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    await $.command.run(run('on'));
    await w.clock.advance(5000);
    const chatTurnsToRead = () => JSON.stringify(memory(w) ?? null);
    expect(chatTurnsToRead()).not.toMatch(/Fixy says hi/);
    const ui = await band($);
    await $.command.run(run('on'));
    await w.clock.settle();
    expect(chatTurnsToRead()).toMatch(/Fixy says hi\./);
    await ui.unmount();
  });

  test('an answer in flight is dropped, and the log says so, when another character was picked meanwhile', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { completeDelayMs: 5000 }, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(run('what is up'));
    await pick($, await personality($, w, ui), w, 'use:duck');
    await w.clock.settle();
    await fold(ui, w);
    await w.clock.advance(5000);
    await w.clock.settle();
    expect(w.completes).toHaveLength(1);
    expect(await shows(ui, /A completed answer\./)).toBe(false);
    expect(w.logs).toContain("buddy: Fixy's answer was dropped: Duck Fixture is drawn now");
    await ui.unmount();
  });

  test('two sessions on one store: /buddy off there hides the band here', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($);
    expect(await shows(ui, /f_f/)).toBe(true);
    w.saved.set('hidden', true);
    await w.clock.advance(20_000);
    await w.clock.settle();
    expect((await $.command.run(run('what now'))).text).toBe('Fixy is hidden; /buddy on first');
    await ui.unmount();
  });

  test('with CLAUDE_CONFIG_DIR set, the companion is read from its .claude.json, not from HOME', async ($, on) => {
    const ccd = '/test-ccd';
    const w = world(on, { character: 'fixy' }, {}, { files: { [`${ccd}/.claude.json`]: config(MOCHI) }, env: { CLAUDE_CONFIG_DIR: ccd } });
    await $.session.start(START);
    const pane = await personality($, w, await band($));
    expect({ native: await label(pane, 'original:native'), logs: w.logs }).toMatchObject({ native: expect.any(String) });
    expect(await label(pane, 'original:npm')).toBeDefined();
    await pane.unmount();
  });
});

describe('hook paths', () => {
  test("a failed tool call's step in the end-of-turn prompt says why it failed, redacted", async ($, on) => {
    const w = world(on, { character: 'fixy' });
    on('tool.call', async () => ({ result: { stdout: '', stderr: '' }, text: "Exit code 1\n\nsome log\nError: ENOENT: no such file, open 'x.json' token=abc123", isError: true }) as never);
    await $.session.start(START);
    await band($);
    await prompt($, 'run the tests', 't1');
    await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'T1', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.completes[0]?.prompt).toMatch(/Claude did: Run the tests \[call \d+ · output \d+ chars\] \(failed: exit 1: Error: ENOENT: no such file, open 'x\.json' token=\[redacted\]\)\n/);
    expect(w.completes[0]?.prompt).not.toContain('abc123');
  });
  test('turn.complete (commentAfterEachTurn and suggestNextPrompt on by default): one call on `model` reads the prompt, the answer and the tally', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    on('tool.call', async () => ({ result: { stdout: 'ok', stderr: '' }, text: 'ok', isError: false }) as never);
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'list the files', 't1');
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'T1', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.completes.length).toBe(1);
    expect(w.completes[0]).toMatchObject({ model: 'opus', effort: 'low' });
    // Past the buddy's own 30 s deadline, so that deadline decides, and the engine still abandons the request.
    expect(w.completes[0]?.timeoutMs).toBeLessThanOrEqual(35_000);
    expect(w.completes[0]?.timeoutMs).toBeGreaterThan(34_900);
    expect(w.completes[0]?.prompt).toContain('The user asked Claude:\nsuggested: none\nsent: list the files');
    expect(w.completes[0]?.prompt).toContain('Claude answered:\nT1');
    // The memory holds the turn just ended, its numbers under what it did, and the prompt points there.
    expect(w.completes[0]?.prompt).toMatch(/Claude did: ran ls \[call \d+ · output 2 chars\]\nNumbers: \d+s · 1 tool call \(Bash 1\)\nClaude answered:\nT1\n/);
    expect(w.completes[0]?.prompt.endsWith(`\n\n${JUST_ENDED}`)).toBe(true);
    // An untagged reply is the commentAfterEachTurn alone.
    expect(await shows(ui, /A completed answer\./)).toBe(true);
    const records = (w.files[`${HOME}/.claude/buddy/buddy.log`] ?? '').trim().split('\n').map((l) => JSON.parse(l));
    expect(records.find((r) => r.event === 'turn.call')).toMatchObject({ commentAfterEachTurn: true, suggestNextPrompt: true });
    expect(records.find((r) => r.event === 'commentAfterEachTurn.outcome')).toMatchObject({ outcome: 'answered', inTok: 1, outTok: 1, cacheRead: 0, cachePct: 0 });
    await ui.unmount();
  });

  test('turn.step streams through untouched, main loop or subagent; a named effort still wins at the turn\'s end', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    const beneath: { effort?: unknown; agentId?: unknown }[] = [];
    on('turn.step', async function* (_$, e) {
      beneath.push({ effort: e.effort, agentId: e.agentId });
      yield { kind: 'text', index: 0, text: 'streamed' } as never;
      return { turnId: e.turnId, index: e.index, answer: 'streamed', toolUses: [], stopReason: 'end_turn', usage: null } as never;
    });
    await $.session.start(START);
    const ui = await band($);
    for (const input of [
      { turnId: 't1', index: 0, model: 'opus', effort: 'medium', messageCount: 1 },
      { turnId: 's1', index: 0, model: 'opus', effort: 'max', messageCount: 1, agentId: 'sub1' },
    ]) {
      const stream = $.turn.step(input as never);
      const chunks: unknown[] = [];
      let step = await stream.next();
      for (; !step.done; step = await stream.next()) chunks.push(step.value);
      expect(chunks).toMatchObject([{ kind: 'text', index: 0, text: 'streamed' }]);
      expect(step.value).toMatchObject({ turnId: input.turnId, answer: 'streamed' });
    }
    expect(beneath).toEqual([{ effort: 'medium', agentId: undefined }, { effort: 'max', agentId: 'sub1' }]);
    // effort inherit takes the main step's 'medium' (observeEffort, resolveEffort: the kit cannot set a plugin option); the default low is sent as set.
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.completes[0]).toMatchObject({ model: 'opus', effort: 'low' });
    expect(w.logs.filter((l) => /failed:/.test(l))).toEqual([]);
    await ui.unmount();
  });

  test('a prompt typed over the running turn and delivered at its next main request is read with that turn; a subagent\'s request delivers none', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    on('turn.step', async function* (_$, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never;
    });
    on('session.usage', async () => ({ value: { startedAt: 0, context: { tokens: 1_000, window: 200_000 }, rateLimits: [], cost: { usd: 0 } } }) as never);
    const step = async (input: object) => {
      const s = $.turn.step(input as never);
      for (let x = await s.next(); !x.done; x = await s.next());
    };
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'run the sleep', 't1');
    await $.prompt.submit({ text: 'also end with BANANA', origin: { kind: 'composer' }, turnId: 't1' } as never);
    await step({ turnId: 't1', index: 1, model: 'opus', messageCount: 3 });
    await $.turn.complete({ reason: 'answer', answer: 'Done. BANANA', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.completes[0]!.prompt).toContain('run the sleep\nThe user added while Claude worked, before any tool call: also end with BANANA\n');
    await prompt($, 'spawn a helper', 't2');
    await $.prompt.submit({ text: 'and stop after it', origin: { kind: 'composer' }, turnId: 't2' } as never);
    await step({ turnId: 't2', index: 1, model: 'opus', messageCount: 3, agentId: 'sub1' });
    await $.turn.complete({ reason: 'answer', answer: 'Helped.', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    const turns = (memory(w) as { blocks: { turnId?: string; turn?: { added?: string[] } }[] }).blocks.filter((b) => b.turn);
    expect(turns.map((b) => [b.turnId, b.turn!.added])).toEqual([['t1', ['also end with BANANA']], ['t2', undefined]]);
    expect((turns[0]!.turn as { addedAfter?: number[] }).addedAfter).toEqual([0]);
    expect(w.logs.filter((l) => /failed:/.test(l))).toEqual([]);
    await ui.unmount();
  });

  test("what Claude wrote mid-turn and a prompt typed over the turn are read with it, each with where in the turn it came; a subagent's text is not; the final answer once", async ($, on) => {
    const w = world(on, { character: 'fixy' });
    let says = '';
    on('turn.step', async function* (_$, e) {
      return { turnId: e.turnId, index: e.index, answer: says, toolUses: [], stopReason: 'end_turn', usage: null } as never;
    });
    on('tool.call', async () => ({ result: { stdout: 'ok' }, text: 'ok', isError: false }) as never);
    on('session.usage', async () => ({ value: { startedAt: 0, context: { tokens: 1_000, window: 200_000 }, rateLimits: [], cost: { usd: 0 } } }) as never);
    // Each step's result passes through unchanged, its text recorded or not.
    const step = async (input: object, text: string) => {
      says = text;
      const s = $.turn.step(input as never);
      let x = await s.next();
      for (; !x.done; x = await s.next());
      expect(x.value).toMatchObject({ answer: text, stopReason: 'end_turn' });
    };
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'will every row carry the account?', 't1');
    await step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 }, 'Yes, every row will carry the account.');
    await $.tool.call({ tool: 'Bash', command: 'a', description: 'Add the column' } as never);
    await $.tool.call({ tool: 'Bash', command: 'b', description: 'Fill the column' } as never);
    await $.prompt.submit({ text: 'and check the totals', origin: { kind: 'composer' }, turnId: 't1' } as never);
    await step({ turnId: 's1', index: 0, model: 'opus', messageCount: 1, agentId: 'sub1' }, 'SUBAGENT_TEXT');
    await step({ turnId: 't1', index: 1, model: 'opus', messageCount: 3 }, '');
    await $.tool.call({ tool: 'Bash', command: 'c', description: 'Check the totals' } as never);
    await step({ turnId: 't1', index: 2, model: 'opus', messageCount: 5 }, 'Every row carries the account; totals match.');
    await $.turn.complete({ reason: 'answer', answer: 'Every row carries the account; totals match.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    const p = w.completes[0]!.prompt;
    expect(withoutSizes(p)).toContain(
      'sent: will every row carry the account?\nClaude wrote mid-turn, before any tool call: Yes, every row will carry the account.\n' +
        'The user added while Claude worked, after 2 tool calls: and check the totals\nClaude did: Add the column; Fill the column; Check the totals\n',
    );
    expect(p.split('Every row carries the account; totals match.')).toHaveLength(2);
    expect(p).not.toContain('SUBAGENT_TEXT');
    const filed = (memory(w) as { blocks: { turnId?: string; turn?: Record<string, unknown> }[] }).blocks.find((b) => b.turnId === 't1')!.turn!;
    expect(filed).toMatchObject({ added: ['and check the totals'], addedAfter: [2], said: [{ after: 0, text: 'Yes, every row will carry the account.' }] });
    expect(w.logs.filter((l) => /failed:/.test(l))).toEqual([]);
    await ui.unmount();
  });

  test("an agent's brief, and what it returned with its usage and its report's size, are read with the turn and filed with it", async ($, on) => {
    const w = world(on, { character: 'fixy' });
    const brief = Array.from({ length: 10 }, (_, i) => `brief line ${i}`).join('\n');
    const report = `${'R'.repeat(2000)}${'S'.repeat(2000)}`;
    on('tool.call', async (_$, e) => ((e as { tool: string }).tool === 'Agent'
      ? { result: { totalTokens: 15166, totalToolUseCount: 5, totalDurationMs: 15512, content: [] }, text: report, isError: false }
      : { result: { stdout: 'ok' }, text: 'ok', isError: false }) as never);
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'audit it', 't1');
    await $.tool.call({ tool: 'Agent', description: 'Audit', prompt: brief } as never);
    await $.turn.complete({ reason: 'answer', answer: 'Audited.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    const cut = `${report.slice(0, 600)} [cut] ${report.slice(-200)}`;
    expect(w.completes[0]!.prompt).toMatch(/Claude did: agent: Audit \[call \d+ · output 4k chars\]\n/);
    expect(w.completes[0]!.prompt).toContain(
      `\nClaude briefed its agent “Audit”: brief line 0\n[cut]\nbrief line 7\nbrief line 8\nbrief line 9\nIts agent “Audit” returned (15k tokens · 5 tool uses · 16s · report 4k chars): ${cut}\n`,
    );
    const filed = (memory(w) as { blocks: { turnId?: string; turn?: Record<string, unknown> }[] }).blocks.find((b) => b.turnId === 't1')!.turn!;
    expect(filed.briefed).toEqual(['“Audit”: brief line 0\n[cut]\nbrief line 7\nbrief line 8\nbrief line 9']);
    expect(filed.returned).toEqual([`“Audit” returned (15k tokens · 5 tool uses · 16s · report 4k chars): ${cut}`]);
    await ui.unmount();
  });

  test('commentAfterEachTurn\'s and suggestNextPrompt\'s outcomes carry ms, from the turn\'s end to the reply, as an ask\'s does', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Fixy likes that.\nSUGGEST_NEXT_PROMPT: run the tests' } });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    const records = (w.files[`${HOME}/.claude/buddy/buddy.log`] ?? '').trim().split('\n').map((l) => JSON.parse(l));
    expect(typeof records.find((r) => r.event === 'commentAfterEachTurn.outcome')?.ms).toBe('number');
    expect(typeof records.find((r) => r.event === 'suggestNextPrompt.outcome')?.ms).toBe('number');
    await ui.unmount();
  });

  test('a headless session (-p, the SDK) makes no end-of-turn call: nobody sees commentAfterEachTurn, and there is no prompt box to suggest into', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start({ ...START, isInteractive: false });
    await prompt($, 'list the files', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'T1', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.completes).toHaveLength(0);
    const records = (w.files[`${HOME}/.claude/buddy/buddy.log`] ?? '').trim().split('\n').map((l) => JSON.parse(l));
    expect(records.find((r) => r.event === 'turn.skipped')).toMatchObject({ why: 'headless' });
  });

  test('a headless session files no turn into the chatTurnsToRead: it never pushes an interactive session\'s memory out of the store', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start({ ...START, isInteractive: false });
    await prompt($, 'list the files', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'T1', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(memory(w)).toBeUndefined();
  });

  test('a turn is remembered with what it did, one line per step, never a tool\'s output; a subagent\'s steps are not the turn\'s', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: 'I saw it.' }] });
    on('tool.call', async () => ({ result: { stdout: 'SECRET_OUTPUT', stderr: '' }, text: 'SECRET_OUTPUT', isError: false }) as never);
    await $.session.start(START);
    await prompt($, 'fix the <system-reminder>rules</system-reminder>login bug', 't1');
    await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' } as never);
    await $.tool.call({ tool: 'Edit', file_path: 'src/a.ts', old_string: 'x', new_string: 'y' } as never);
    await $.tool.call({ tool: 'Grep', pattern: 'SUBAGENT_STEP', agentId: 'sub1' } as never);
    await $.tool.call({ tool: 'Edit', file_path: 'src/a.ts', old_string: 'y', new_string: 'z' } as never);
    await $.turn.complete({ reason: 'answer', answer: '## Fixed\n\n**It** works.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    await $.command.run(run('what did Claude do?'));
    await w.clock.settle();
    const p = w.completes.at(-1)!.prompt;
    expect(withoutSizes(withoutNumbers(p))).toContain('Turn 1. The user asked Claude:\nsuggested: none\nsent: fix the login bug\nClaude did: Run the tests; edited a.ts\nClaude answered:\nFixed\nIt works.');
    expect(p).not.toMatch(/SECRET_OUTPUT|SUBAGENT_STEP|rules/);
  });

  // saveRounds off is proven live (live-configs): the testing kit sets no plugin options.
  test("each round is written into the chat's own folder beside its transcript, next to its memory", async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: 'Hi.' }] });
    await $.session.start(START);
    await prompt($, 'go', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'ok', isAborted: false, turnId: 't1' } as never);
    await $.command.run(run('hello?'));
    await w.clock.settle();
    const rounds = Object.keys(w.files).filter((f) => f.endsWith('.txt')).sort();
    expect(rounds.length).toBeGreaterThan(0);
    expect(rounds.every((f) => f.startsWith(`${chatDir()}/round-`))).toBe(true);
    expect(rounds.some((f) => w.files[f]!.includes(`session ${SESSION} · turn t1`) && w.files[f]!.includes('hello?'))).toBe(true);
    expect(memory(w)).toBeDefined();
  });

  test("a chat whose project folder is named otherwise keeps its buddy folder beside its transcript, wherever that is", async ($, on) => {
    const other = `${HOME}/.claude/projects/-work-app-named-otherwise`;
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: 'Hi.' }] }, { files: { [`${other}/${SESSION}.jsonl`]: '{}' } });
    await $.session.start(START);
    await prompt($, 'go', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'ok', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.files[`${other}/${SESSION}/buddy/memory.json`]).toContain('"t1"');
    expect(Object.keys(w.files).filter((f) => f.startsWith(`${HOME}/.claude/projects/`) && !f.startsWith(`${other}/`))).toEqual([]);
  });

  test('the buddy remembers of itself exactly as far back as of the chat: a turn and what it said after it leave together', async ($, on) => {
    const queue = [1, 2, 3, 4, 5].map((n) => ({ isAnswered: true, text: `COMMENT_AFTER_EACH_TURN: comment on ${n}.\nSUGGEST_NEXT_PROMPT: next after ${n}` }));
    const w = world(on, { character: 'fixy' }, { queue: [...queue, { isAnswered: true, text: 'I recall.' }] });
    await $.session.start(START);
    const ui = await band($);
    for (let n = 1; n <= 5; n++) {
      await prompt($, `ask number ${n}`, `t${n}`);
      await $.turn.complete({ reason: 'answer', answer: `reply number ${n}`, isAborted: false, turnId: `t${n}` } as never);
      await w.clock.settle();
    }
    await $.command.run(run('what did you say about the first turn?'));
    await w.clock.settle();
    const p = withoutNumbers(w.completes.at(-1)!.prompt);
    // Turn 1 and its comment and suggestion are gone together; turn 2 is the oldest remembered, its own comment and suggestion under it.
    // Turn 1's suggestion stays only as what was in the box when turn 2 was sent.
    expect(p).not.toMatch(/ask number 1\b|comment on 1\.|you suggested the user's next prompt: next after 1\b/);
    expect(p).toContain("Turn 2. The user asked Claude:\nsuggested: (not taken; Claude saw only sent) next after 1\nsent: ask number 2\nClaude answered:\nreply number 2\n- After this turn, you commented: comment on 2.\n  With it, you suggested the user's next prompt: next after 2\n\nTurn 3. The user asked Claude:\nsuggested: (not taken; Claude saw only sent) next after 2\nsent: ask number 3");
    expect(p.endsWith("- After this turn, you commented: comment on 5.\n  With it, you suggested the user's next prompt: next after 5\n\nThe user asks you directly: what did you say about the first turn?")).toBe(true);
    // The store holds the same four turns, never more.
    expect((memory(w) as { blocks: { turnId?: string }[] }).blocks.map((b) => b.turnId)).toEqual(['t2', 't3', 't4', 't5']);
    await ui.unmount();
  });

  test('a question asked during a turn is filed under the turn before it, however late its answer lands', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'Noted.' }, completeDelayMs: 5_000 });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'first ask', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'first reply', isAborted: false, turnId: 't1' } as never);
    await w.clock.advance(5_000);
    await w.clock.settle();
    await prompt($, 'second ask', 't2');
    await $.command.run(run('remember pineapple'));
    await $.turn.complete({ reason: 'answer', answer: 'second reply', isAborted: false, turnId: 't2' } as never);
    await w.clock.advance(5_000);
    await w.clock.settle();
    const blocks = (memory(w) as { blocks: { turnId?: string; characters: Record<string, { kind: string }[]> }[] }).blocks;
    // The first block holds the greeting, said before any turn.
    expect(blocks.map((b) => b.turnId)).toEqual([undefined, 't1', 't2']);
    expect(blocks[1]!.characters.fixy!.map((x) => x.kind)).toEqual(['endOfTurn', 'question']);
    // Turn 2's comment came while the answer held the bubble: it waits its turn behind it, and is filed.
    expect(blocks[2]!.characters.fixy ?? []).toEqual([{ kind: 'endOfTurn', commentAfterEachTurn: 'Noted.' }]);
    await ui.unmount();
  });

  test('a subagent\'s tool calls and turn end are not the main turn: no call, and the main turn keeps its tally', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    on('tool.call', async () => ({ result: { stdout: 'ok', stderr: '' }, text: 'ok', isError: false }) as never);
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'list the files', 't1');
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never);
    await $.tool.call({ tool: 'Grep', agentId: 'sub1' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'sub done', isAborted: false, turnId: 's1', agentId: 'sub1' } as never);
    await w.clock.settle();
    expect(w.completes).toHaveLength(0);
    await $.turn.complete({ reason: 'answer', answer: 'T1', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.completes).toHaveLength(1);
    // The subagent's call counts toward nothing: the turn's numbers are the main loop's own.
    expect(w.completes[0]?.prompt).toMatch(/\nNumbers: \d+s · 1 tool call \(Bash 1\)\n/);
    await ui.unmount();
  });

  test('the end-of-turn call runs on opus at low effort, its LINE told the character rule, and reads only the last 4 turns, oldest first', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($);
    for (let n = 1; n <= 5; n++) {
      await prompt($, `ask number ${n}`, `t${n}`);
      await $.turn.complete({ reason: 'answer', answer: `reply number ${n}`, isAborted: false, turnId: `t${n}` } as never);
      await w.clock.settle();
    }
    expect(w.completes).toHaveLength(5);
    for (const c of w.completes) expect(c).toMatchObject({ model: 'opus', effort: 'low' });
    expect(w.completes[0]!.system).toContain(`You are Fixy, a test fixture.\n\n${CHARACTER_RULE}\n\n`);
    expect(w.completes[0]!.prompt).toContain('The user asked Claude:\nsuggested: none\nsent: ask number 1');
    const last = w.completes[4]!.prompt;
    expect(last).not.toContain('ask number 1');
    expect(last).not.toContain('reply number 1');
    expect(last.indexOf('ask number 2')).toBeGreaterThan(-1);
    expect(last.indexOf('ask number 2')).toBeLessThan(last.indexOf('ask number 3'));
    expect(last.indexOf('ask number 3')).toBeLessThan(last.indexOf('reply number 5'));
    expect(last.endsWith(`\n\n${JUST_ENDED}`)).toBe(true);
    await ui.unmount();
  });

  test('/buddy reload reads the roster again and keeps drawing the stored choice', async ($, on) => {
    world(on, { character: 'fixy' });
    await $.session.start(START);
    expect((await $.command.run(run('reload'))).text).toBe('Reloaded 3 characters (1 invalid); drawing Fixy');
  });

  test('/buddy off stops the band clock; the drawer folded stops its clock', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    const reads = () => w.gets.filter((k) => k === 'hidden').length;
    const before = reads();
    await w.clock.advance(30_000);
    expect(reads()).toBeGreaterThan(before);
    await $.command.run(run('off'));
    const off = reads();
    await w.clock.advance(30_000);
    expect(reads()).toBe(off);
    await $.command.run(run('on'));
    const ui = await band($);
    await pick($, await personality($, w, ui), w, 'use:duck');
    await fold(ui, w);
    const drawn = JSON.stringify(await ui.drawn());
    expect(drawn).not.toContain('"guide"');
    expect(await shows(ui, /\(d_d\)/)).toBe(true);
    await ui.unmount();
  });
});

describe('pre-release fixes', () => {
  test('the default log follows CLAUDE_CONFIG_DIR: $CLAUDE_CONFIG_DIR/buddy/buddy.log, never under HOME', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { env: { CLAUDE_CONFIG_DIR: '/test-ccd' } });
    await $.session.start(START);
    await w.clock.settle();
    expect(w.writes).toContain('/test-ccd/buddy/buddy.log');
    expect(w.writes.filter((p) => p.startsWith(`${HOME}/`))).toEqual([]);
    expect((await $.command.run(run('log'))).text).toMatch(/^Log: \/test-ccd\/buddy\/buddy\.log\n/);
  });

  test('without CLAUDE_CONFIG_DIR the default log is ~/.claude/buddy/buddy.log', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    await w.clock.settle();
    expect(w.writes).toContain(`${HOME}/.claude/buddy/buddy.log`);
  });

  test('an answer arriving after /buddy off is never remembered as said; the question alone is', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { completeDelayMs: 5000 });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(run('what is up'));
    await $.command.run(run('off'));
    await w.clock.advance(5000);
    await w.clock.settle();
    await $.command.run(run('on'));
    await w.clock.settle();
    expect(w.completes).toHaveLength(1);
    const ring = JSON.stringify(memory(w) ?? null);
    expect(ring).toContain('what is up');
    expect(ring).not.toContain('A completed answer.');
    await ui.unmount();
  });

  test('a read of the shared `hidden` in flight across /buddy off never undoes it', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($);
    w.slow.hiddenMs = 2000;
    const reads = () => w.gets.filter((k) => k === 'hidden').length;
    const before = reads();
    for (let i = 0; i < 200 && reads() === before; i++) await w.clock.advance(100);
    expect(reads()).toBeGreaterThan(before);
    await $.command.run(run('off'));
    await w.clock.advance(2000);
    await w.clock.settle();
    expect((await $.command.run(run('what now'))).text).toBe('Fixy is hidden; /buddy on first');
    await ui.unmount();
  });

  test('a read of the shared `hidden` begun while /buddy off saves it never undoes the off', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($);
    w.slow.setHiddenMs = 30_000;
    const reads = () => w.gets.filter((k) => k === 'hidden').length;
    const before = reads();
    const off = $.command.run(run('off'));
    for (let i = 0; i < 200 && reads() === before; i++) await w.clock.advance(100);
    await w.clock.advance(30_000);
    await off;
    await w.clock.settle();
    expect(w.saved.get('hidden')).toBe(true);
    expect((await $.command.run(run('what now'))).text).toBe('Fixy is hidden; /buddy on first');
    await ui.unmount();
  });

  test('/buddy with arguments that are not text answers a failure line, never a thrown hook', async ($, on) => {
    world(on, { character: 'fixy' });
    await $.session.start(START);
    let out: unknown;
    try {
      out = await $.command.run({ ...run(''), args: undefined as never });
    } catch (error) {
      out = { threw: String(error) };
    }
    expect(out).toMatchObject({ text: expect.stringMatching(/^\/buddy failed: /) });
  });
});

describe('suggestNextPrompt', () => {
  test('a question asked after a tool ran in this turn answers at once, seeing the turns answered so far', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    on('tool.call', async () => ({ result: { stdout: 'ok', stderr: '' }, text: 'ok', isError: false }) as never);
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'build the thing', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'Built it.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    await prompt($, 'now list it', 't2');
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never);
    await $.command.run(run('can you see the main chat?'));
    await w.clock.settle();
    const asks = w.completes.filter((c) => c.prompt.includes('The user asks you directly: can you see the main chat?'));
    expect(asks).toHaveLength(1);
    expect(asks[0]!.prompt).toContain('The user asked Claude:\nsuggested: none\nsent: build the thing');
    expect(asks[0]!.prompt).toContain('Claude answered:\nBuilt it.');
    // The running turn is not answered yet: its prompt is not in the chatTurnsToRead turns.
    expect(asks[0]!.prompt).not.toContain('now list it');
    await ui.unmount();
  });
  test('one answered turn: ONE call writes commentAfterEachTurn for the band and suggestNextPrompt for the prompt box, as a plugin\'s', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Fixy likes that.\nSUGGEST_NEXT_PROMPT: run the tests' } });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.completes.length).toBe(1);
    expect(w.completes[0]?.system).toContain('You are Fixy, a test fixture.');
    expect(w.completes[0]?.system).toContain('COMMENT_AFTER_EACH_TURN:');
    expect(w.completes[0]?.system).toContain('SUGGEST_NEXT_PROMPT:');
    expect(await shows(ui, /Fixy likes that\./)).toBe(true);
    expect(w.suggested).toEqual(['run the tests']);
    expect(w.origins).toEqual(['plugin']);
    await ui.unmount();
  });
  test('a shown suggestNextPrompt is remembered with the commentAfterEachTurn it came with, as one exchange: the next question\'s prompt carries both, told apart, kept in the store', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Fixy likes that.\nSUGGEST_NEXT_PROMPT: run the tests' }, { isAnswered: true, text: 'I said run the tests.' }] });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.suggested).toEqual(['run the tests']);
    await $.command.run(run('what was your last suggestion?'));
    await w.clock.settle();
    expect(w.completes).toHaveLength(2);
    expect(w.completes[1]!.prompt).toContain("- After this turn, you commented: Fixy likes that.\n  With it, you suggested the user's next prompt: run the tests\n");
    expect(ring(w, 'fixy')).toEqual([{ kind: 'line', text: 'Fixy says hi.' }, { kind: 'endOfTurn', commentAfterEachTurn: 'Fixy likes that.', suggestNextPrompt: 'run the tests' }, { kind: 'question', question: 'what was your last suggestion?', answer: 'I said run the tests.' }]);
    await ui.unmount();
  });
  test('the engine\'s own suggestion is held while the call runs; with SUGGEST_NEXT_PROMPT: NONE it is shown after all, and a later one passes', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: All done here.\nSUGGEST_NEXT_PROMPT: NONE' }, completeDelayMs: 5_000 });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    expect(await $.prompt.suggest({ text: 'run the tests', origin: { kind: 'suggestion' } } as never)).toMatchObject({ isShown: false });
    expect(w.suggested).toEqual([]);
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect(w.completes.length).toBe(1);
    expect(w.suggested).toEqual(['run the tests']);
    expect(await $.prompt.suggest({ text: 'commit', origin: { kind: 'suggestion' } } as never)).toMatchObject({ isShown: true });
    expect(w.suggested).toEqual(['run the tests', 'commit']);
    await ui.unmount();
  });
  test('an aborted turn, or a subagent\'s, makes no call', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'aborted', answer: '', isAborted: true, turnId: 't1' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'Sub done.', isAborted: false, turnId: 't2', agentId: 'agent-1' } as never);
    await w.clock.settle();
    expect(w.completes).toEqual([]);
    expect(w.suggested).toEqual([]);
    await ui.unmount();
  });
  test('an interrupted turn is remembered as interrupted, and still makes no call', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    await prompt($, 'refactor the store', 't1');
    await $.turn.complete({ reason: 'aborted', answer: 'Starting on the', isAborted: true, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.completes).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocks = (memory(w) as any).blocks;
    expect(blocks.at(-1)).toMatchObject({ turnId: 't1', turn: { prompt: 'refactor the store', answer: 'Starting on the', interrupted: true } });
  });
  test('a turn an API error or a refusal ended is remembered with its steps and how it ended, and makes no call', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    on('tool.call', async () => ({ result: { stdout: 'ok', stderr: '' }, text: 'ok' }) as never);
    await $.session.start(START);
    await prompt($, 'add a bulk tier', 't1');
    await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' } as never);
    await $.turn.complete({ reason: 'error', answer: '', turnId: 't1' } as never);
    await prompt($, 'why not?', 't2');
    await $.turn.complete({ reason: 'refusal', refusal: { category: null, explanation: null }, answer: '', turnId: 't2' } as never);
    await w.clock.settle();
    expect(w.completes).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocks = (memory(w) as any).blocks;
    expect(blocks.at(-2)).toMatchObject({ turnId: 't1', turn: { prompt: 'add a bulk tier', did: [expect.stringMatching(/^Run the tests \[call \d+ · output \d+ chars\]$/)], ended: 'error' } });
    expect(blocks.at(-1)).toMatchObject({ turnId: 't2', turn: { prompt: 'why not?', ended: 'refusal' } });
  });
  test('an interrupted turn in a headless session files nothing', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start({ ...START, isInteractive: false });
    await prompt($, 'refactor the store', 't1');
    await $.turn.complete({ reason: 'aborted', answer: 'Starting', isAborted: true, turnId: 't1' } as never);
    await w.clock.settle();
    expect(memory(w)).toBeUndefined();
  });
  test('a held /buddy answer keeps the bubble over the turn\'s commentAfterEachTurn, and suggestNextPrompt still goes out', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: 'Forty-two, friend.' }, { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Should not show.\nSUGGEST_NEXT_PROMPT: commit this' }] });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(run('what is up'));
    await w.clock.settle();
    expect(await shows(ui, /Forty-two, friend\./)).toBe(true);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.completes.length).toBe(2);
    expect(await shows(ui, /Forty-two, friend\./)).toBe(true);
    expect(await shows(ui, /Should not show/)).toBe(false);
    expect(w.suggested).toEqual(['commit this']);
    await ui.unmount();
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function records(w: { files: Record<string, string> }): any[] {
  return (w.files[`${HOME}/.claude/buddy/buddy.log`] ?? '').trim().split('\n').map((l) => JSON.parse(l));
}

/** The buddy's memory of session `session` as its chat folder's memory.json holds it; undefined when none was written. */
function memory(w: { files: Record<string, string> }, session = SESSION): unknown {
  const text = w.files[`${chatDir(session)}/memory.json`];
  return text === undefined ? undefined : JSON.parse(text);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ring(w: { files: Record<string, string> }, id: string): any[] {
  // Every exchange of `id` in the stored timeline, oldest first, whatever turn it was filed under.
  return ((memory(w) as { blocks: { characters: Record<string, unknown[]> }[] } | undefined)?.blocks ?? []).flatMap((b) => b.characters[id] ?? []);
}

describe('a taken suggestion', () => {
  test("sent unedited, a peer's message between: Claude reads that its claims are the buddy's, and the buddy files it as its own words the user chose", async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Fixy likes that.\nSUGGEST_NEXT_PROMPT: token saved, run the proof' }, { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Hm.\nSUGGEST_NEXT_PROMPT: NONE' }] });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'make the proof', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'Save a token first.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.suggested).toEqual(['token saved, run the proof']);
    // Not the user's: it leaves the suggestion in the box.
    await $.prompt.submit({ text: 'hello from a peer', origin: { kind: 'peer' } } as never);
    expect(w.submitted.at(-1)).toEqual({ text: 'hello from a peer' });
    await prompt($, 'token saved,  run the proof', 't2');
    expect(w.submitted.at(-1)).toEqual({ text: 'token saved,  run the proof', context: [TAKEN_SUGGESTION_CONTEXT] });
    await $.turn.complete({ reason: 'answer', answer: 'No file there.', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    expect(w.completes).toHaveLength(2);
    // Filed cleaned, as every prompt is: the suggestion beside what was sent, the same words.
    expect(w.completes[1]!.prompt).toContain('Turn 2. The user asked Claude:\nsuggested: token saved, run the proof\nsent: token saved, run the proof\n');
    expect(w.completes[1]!.prompt).not.toContain('your own suggested prompt, unedited');
    expect(records(w).filter((r) => r.event === 'suggestNextPrompt.taken')).toEqual([expect.objectContaining({ length: 27, use: 'unedited' })]);
    await ui.unmount();
  });
  test("extended, the user's words after it: Claude reads that only the added words are the user's, the turn is the user's with the suggestion beside it, and the drawer counts it used", async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Fixy likes that.\nSUGGEST_NEXT_PROMPT: run the tests' } });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'build it', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'Built.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.suggested).toEqual(['run the tests']);
    await prompt($, 'run the tests and commit', 't2');
    expect(w.submitted.at(-1)).toEqual({ text: 'run the tests and commit', context: [EXTENDED_SUGGESTION_CONTEXT] });
    await $.turn.complete({ reason: 'answer', answer: 'Committed.', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    expect(w.completes[1]!.prompt).toContain('Turn 2. The user asked Claude:\nsuggested: run the tests\nsent: run the tests and commit\n');
    const filed = (memory(w) as { blocks: { turn?: Record<string, unknown> }[] }).blocks.map((b) => b.turn).filter((t) => t !== undefined);
    expect(filed.at(-1)).toMatchObject({ prompt: 'run the tests and commit', suggested: 'run the tests' });
    expect(filed.at(-1)).not.toHaveProperty('from');
    expect(records(w).filter((r) => r.event === 'suggestNextPrompt.taken')).toEqual([expect.objectContaining({ length: 24, use: 'extended' })]);
    await $.command.run(run(''));
    await w.clock.settle();
    expect(await shows(ui, /1 of 2 suggested prompts used/)).toBe(true);
    await ui.unmount();
  });
  test("a peer's prompt while a suggestion shows: the suggestion stays, and the peer's turn files none", async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Fixy likes that.\nSUGGEST_NEXT_PROMPT: run the tests' }, { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Hm.\nSUGGEST_NEXT_PROMPT: NONE' }, { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Ok.\nSUGGEST_NEXT_PROMPT: NONE' }] });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'build it', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'Built.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    await $.prompt.submit({ text: 'run the tests', origin: { kind: 'peer' } } as never);
    await $.turn.start({ text: 'run the tests', turnId: 'tp' } as never);
    expect(w.submitted.at(-1)).toEqual({ text: 'run the tests' });
    await $.turn.complete({ reason: 'answer', answer: 'Ran.', isAborted: false, turnId: 'tp' } as never);
    await w.clock.settle();
    expect(w.completes[1]!.prompt).toContain('Turn 2. Claude was sent, not by the user (peer):\nrun the tests\n');
    const filed = (memory(w) as { blocks: { turn?: Record<string, unknown> }[] }).blocks.map((b) => b.turn).filter((t) => t !== undefined);
    expect(filed.at(-1)).toMatchObject({ prompt: 'run the tests', from: 'peer' });
    expect(filed.at(-1)).not.toHaveProperty('suggested');
    await prompt($, 'run the tests', 't3');
    expect(w.submitted.at(-1)).toEqual({ text: 'run the tests', context: [TAKEN_SUGGESTION_CONTEXT] });
    await ui.unmount();
  });
  test("edited, it is the user's own: no context, filed as asked beside the suggestion, and the next prompt is nobody's suggestion", async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Fixy likes that.\nSUGGEST_NEXT_PROMPT: run the tests' } });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'build it', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'Built.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.suggested).toEqual(['run the tests']);
    await prompt($, 'please run the tests', 't2');
    expect(w.submitted.at(-1)).toEqual({ text: 'please run the tests' });
    // The box's suggestion was answered: the same words typed later are the user's.
    await $.turn.complete({ reason: 'answer', answer: 'Green.', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    expect(w.completes[1]!.prompt).toContain('Turn 2. The user asked Claude:\nsuggested: (not taken; Claude saw only sent) run the tests\nsent: please run the tests\n');
    expect(records(w).filter((r) => r.event === 'suggestNextPrompt.taken')).toHaveLength(0);
    await ui.unmount();
  });
});

describe('a repeated suggestion', () => {
  test('a near-repeat of one the user passed over is held back and logged; a distinct one shows, and one the user took may come again', async ($, on) => {
    const close = 'Stop the flight-watch timer now, then tell me what else must close before a runbook relaunch';
    const list = 'Stop the flight-watch timer, then list every chat that must close before the M7 runbook relaunch';
    const reply = (s: string) => ({ isAnswered: true, text: `COMMENT_AFTER_EACH_TURN: Hm.\nSUGGEST_NEXT_PROMPT: ${s}` });
    const w = world(on, { character: 'fixy' }, { queue: [reply(close), reply(list), reply('run the tests'), reply('run the tests')] });
    await $.session.start(START);
    const ui = await band($);
    const turn = async (text: string, id: string) => {
      await prompt($, text, id);
      await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: id } as never);
      await w.clock.settle();
    };
    await turn('watch the flight', 't1');
    expect(w.suggested).toEqual([close]);
    // Passed over: the next suggestion asks nearly the same, and never reaches the prompt box.
    await turn('how is the flight going?', 't2');
    expect(w.suggested).toEqual([close]);
    expect(records(w).filter((r) => r.event === 'suggestNextPrompt.outcome').map((r) => r.outcome)).toEqual(['shown', 'repeat']);
    // A distinct one shows; taken, the same again shows too.
    await turn('and now?', 't3');
    await turn('run the tests', 't4');
    expect(w.suggested).toEqual([close, 'run the tests', 'run the tests']);
    expect(records(w).filter((r) => r.event === 'suggestNextPrompt.outcome').map((r) => r.outcome)).toEqual(['shown', 'repeat', 'shown', 'shown']);
    await ui.unmount();
  });
});

describe('the second brain: one call, the character and the suggestion combined', () => {
  const judged = (verdict: string, why: string, next: string, comment = 'Fixy likes that.') => ({
    isAnswered: true,
    text: `DESIRE: a release nobody has to roll back\nVERDICT: ${verdict}\nWHY: ${why}\nCOMMENT_AFTER_EACH_TURN: ${comment}\nSUGGEST_NEXT_PROMPT: ${next}`,
  });

  test('one call asks for the judgement, then the comment knowing it, then the suggestion that follows it', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: judged('RIGHT', 'tests ran green before the claim', 'yes, go on and tag the release') });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.completes).toHaveLength(1);
    const sys = w.completes[0]!.system!;
    expect(sys).toContain("the user's second brain");
    const order = ['DESIRE:', 'VERDICT:', 'WHY:', 'COMMENT_AFTER_EACH_TURN:', 'SUGGEST_NEXT_PROMPT:'].map((t) => sys.indexOf(t));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!))).toBe(true);
    expect(sys).toContain('knowing your verdict, never repeating WHY');
    await ui.unmount();
  });

  test('WRONG is screamed in a red frame over the comment, its words bold in the user\'s blue, its stop prompt suggested; the drawer and the memory keep the comment, the warning and the suggestion', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: judged('WRONG', 'YOU ARE FORCE-PUSHING MAIN!', 'stop, never push main; open the release PR instead') });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Pushed.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    const scream = await bubbleText(ui, /YOU ARE FORCE-PUSHING MAIN!/);
    expect(scream?.props.color).toBe('blue');
    expect(scream?.props.bold).toBe(true);
    expect((await ui.find({ type: 'Box', key: 'bubble' }))?.props.borderColor).toBe('red');
    expect(await shows(ui, /Fixy likes that\./)).toBe(false);
    expect(w.suggested).toEqual(['stop, never push main; open the release PR instead']);
    expect(records(w).find((r) => r.event === 'verdict.outcome')).toMatchObject({ outcome: 'said', verdict: 'WRONG' });
    expect(records(w).find((r) => r.event === 'commentAfterEachTurn.outcome')).toMatchObject({ outcome: 'outranked' });
    expect(ring(w, 'fixy')).toContainEqual({ kind: 'endOfTurn', commentAfterEachTurn: 'Fixy likes that.', warned: 'YOU ARE FORCE-PUSHING MAIN!', suggestNextPrompt: 'stop, never push main; open the release PR instead' });
    // The drawer: the verdict under its judgement, with what it judged against.
    await $.command.run(run(''));
    await w.clock.settle();
    expect(await shows(ui, /Fixy: WRONG/)).toBe(true);
    expect(await shows(ui, /^wants: a release nobody has to/)).toBe(true);
    await ui.unmount();
  });

  test('SHORTCUT is warned of in a yellow frame over the comment, its words in the user\'s blue', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: judged('SHORTCUT', 'called it done without running the suite', 'run the full suite before we call it done') });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect((await bubbleText(ui, /called it done without running the suite/))?.props.color).toBe('blue');
    expect((await ui.find({ type: 'Box', key: 'bubble' }))?.props.borderColor).toBe('yellow');
    expect(await shows(ui, /Fixy likes that\./)).toBe(false);
    expect(w.suggested).toEqual(['run the full suite before we call it done']);
    await ui.unmount();
  });

  test('RIGHT says nothing over the comment: its suggestion is the go-ahead, the verdict logged quiet', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: judged('RIGHT', 'tests ran green before the claim', 'yes, go on and tag the release') });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(await shows(ui, /Fixy likes that\./)).toBe(true);
    expect(await shows(ui, /tests ran green/)).toBe(false);
    expect(w.suggested).toEqual(['yes, go on and tag the release']);
    expect(records(w).find((r) => r.event === 'verdict.outcome')).toMatchObject({ outcome: 'quiet', verdict: 'RIGHT' });
    expect(ring(w, 'fixy')).toContainEqual({ kind: 'endOfTurn', commentAfterEachTurn: 'Fixy likes that.', suggestNextPrompt: 'yes, go on and tag the release' });
    await ui.unmount();
  });

  test('the deepest desire is carried to the next turn\'s call, and /clear forgets it', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: judged('RIGHT', 'fine', 'go on') });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'one', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'One.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    await prompt($, 'two', 't2');
    await $.turn.complete({ reason: 'answer', answer: 'Two.', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    await $.session.end({ reason: 'clear', sessionId: SESSION, resume: {} } as never);
    await prompt($, 'three', 't3');
    await $.turn.complete({ reason: 'answer', answer: 'Three.', isAborted: false, turnId: 't3' } as never);
    await w.clock.settle();
    expect(w.completes).toHaveLength(3);
    expect(w.completes[0]!.system).not.toContain("you named the user's deepest desire");
    expect(w.completes[1]!.system).toContain("At the last turn's end you named the user's deepest desire: a release nobody has to roll back");
    expect(w.completes[2]!.system).not.toContain("you named the user's deepest desire");
    await ui.unmount();
  });
});

describe('the chat memory items', () => {
  test('items saved at turn end, the next call and a question read them first', async ($, on) => {
    const raw = '{"rule.main-safe":{"words":"keep main safe","covers":"the repo"},"fact.tests-green":{"text":"Tests passed.","from":"shown"}}';
    const w = world(on, { character: 'fixy' }, { queue: [
      { isAnswered: true, text: `COMMENT_AFTER_EACH_TURN: Nice.\nMEMORY: ${raw}` },
      { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Still nice.' },
      { isAnswered: true, text: 'I remember.' },
    ] });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'please keep main safe', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'Tests passed.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    const saved = memory(w) as any;
    expect(saved.version).toBe(2);
    expect(saved.turnNo).toBe(1);
    expect(saved.items).toEqual({
      'rule.main-safe': { words: 'keep main safe', covers: 'the repo', from: 'user', turn: 1, at: expect.any(Number) },
      'fact.tests-green': { text: 'Tests passed.', from: 'shown', turn: 1, at: expect.any(Number) },
    });
    expect(Object.keys(saved).sort()).toEqual(['at', 'blocks', 'ended', 'items', 'strikes', 'turnNo', 'version']);
    expect(records(w).filter((r) => r.event === 'memory.op').map(({ key, op, why, turn }) => ({ key, op, why, turn }))).toEqual([
      { key: 'rule.main-safe', op: 'add', why: expect.any(String), turn: 1 },
      { key: 'fact.tests-green', op: 'add', why: expect.any(String), turn: 1 },
    ]);
    await prompt($, 'two', 't2');
    await $.turn.complete({ reason: 'answer', answer: 'Two.', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    await $.command.run(run('what do you keep?'));
    await w.clock.settle();
    const first = `${ITEMS_HEAD}\nrule.main-safe · keep main safe · user · 1\nfact.tests-green · Tests passed. · shown · 1\n\nWhat you remember, oldest first:`;
    expect(w.completes[1]!.prompt.startsWith(first)).toBe(true);
    expect(w.completes[2]!.prompt.startsWith(first)).toBe(true);
    expect((memory(w) as any).items).toEqual(saved.items);
    expect(records(w).filter((r) => r.event === 'memory.op')).toHaveLength(2);
    await ui.unmount();
  });
  test("Claude's words cannot become a rule, while other ops apply", async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Nice.\nMEMORY: {"rule.main-safe":{"words":"keep main safe","covers":"the repo"},"fact.tests-green":{"text":"Tests passed.","from":"shown"}}' } });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'run tests', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'keep main safe', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(Object.keys((memory(w) as any).items)).toEqual(['fact.tests-green']);
    expect(records(w).filter((r) => r.event === 'memory.op').map(({ key, op, why, turn }) => ({ key, op, why, turn }))).toContainEqual({ key: 'rule.main-safe', op: 'drop', why: 'words not typed by the user', turn: 1 });
    await ui.unmount();
  });
  test('broken JSON keeps the comment and existing items, with one dropped op', async ($, on) => {
    const item = { text: 'Kept.', from: 'shown', turn: 0, at: 0 };
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Nice.\nMEMORY: {oops' } }, { files: { [`${chatDir()}/memory.json`]: JSON.stringify({ version: 2, blocks: [], items: { 'fact.kept': item }, ended: {}, turnNo: 0, at: 0 }) } });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'one', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'One.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(await shows(ui, /Nice\./)).toBe(true);
    expect((memory(w) as any).items).toEqual({ 'fact.kept': item });
    expect(records(w).filter((r) => r.event === 'memory.op').map(({ key, op, why, turn }) => ({ key, op, why, turn }))).toEqual([{ key: '*', op: 'drop', why: 'not a JSON object', turn: 1 }]);
    await ui.unmount();
  });
  test('items belong to the chat across a personality switch and memory.md follows the drawn character', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [
      { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Nice.\nMEMORY: {"fact.tests-green":{"text":"Tests passed.","from":"shown"}}' },
      { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Quack.' },
    ] });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'one', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'One.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    const items = (memory(w) as any).items;
    await pick($, await personality($, w, ui), w, 'use:duck');
    await w.clock.settle();
    expect((memory(w) as any).items).toEqual(items);
    expect(w.files[`${chatDir()}/memory.md`]!.startsWith('# What Duck Fixture remembers\n')).toBe(true);
    expect(w.files[`${chatDir()}/memory.md`]).toContain('- fact.tests-green · Tests passed. · from shown · age 0');
    await prompt($, 'two', 't2');
    await $.turn.complete({ reason: 'answer', answer: 'Two.', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    expect(w.completes[1]!.prompt.startsWith(`${ITEMS_HEAD}\nfact.tests-green · Tests passed. · shown · 1\n\n`)).toBe(true);
    await ui.unmount();
  });
  for (const source of ['file', 'store']) test(`v1 memory from ${source} migrates once on first load, numbering turns and logging every op`, async ($, on) => {
    const path = `${chatDir()}/memory.json`;
    const old = { at: 1, blocks: [{ turnId: 'old', turn: { prompt: 'please keep main safe', answer: 'Done.' }, characters: {} }], notes: { fixy: ['rule: keep main safe', 'doubt: flaky'], duck: ['rule: keep main safe'] } };
    const w = world(on, { character: 'fixy', ...(source === 'store' ? { [`chatTurnsToRead:${SESSION}`]: old } : {}) }, {}, { files: source === 'file' ? { [path]: JSON.stringify(old) } : {} });
    await $.session.start(START);
    await w.clock.settle();
    const saved = memory(w) as any;
    expect(saved.version).toBe(2);
    expect(saved.turnNo).toBe(1);
    expect(saved.items).toEqual({
      'rule.keep-main-safe': { words: 'keep main safe', covers: 'the chat', from: 'user', turn: 1, at: expect.any(Number), migrated: true },
      'doubt.flaky': { text: 'flaky', from: 'buddy', turn: 1, at: expect.any(Number), migrated: true },
    });
    expect(Object.keys(saved).sort()).toEqual(['at', 'blocks', 'ended', 'items', 'strikes', 'turnNo', 'version']);
    expect(w.writes.filter((p) => p === path)).toHaveLength(1);
    expect(records(w).filter((r) => r.event === 'memory.op').map((r) => r.op)).toEqual(['migrate', 'migrate', 'drop']);
    const ui = await band($);
    await $.command.run(run('what do you keep?'));
    await w.clock.settle();
    expect(records(w).filter((r) => r.event === 'memory.op')).toHaveLength(3);
    expect(w.completes[0]!.prompt.startsWith(`${ITEMS_HEAD}\nrule.keep-main-safe · keep main safe · user · 0\ndoubt.flaky · flaky · buddy · 0\n\n`)).toBe(true);
    await ui.unmount();
  });

  test('a late reply keeps its memory when the next turn ended aborted without a call', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Late line.\nMEMORY: {"fact.late":{"text":"Kept late.","from":"shown"}}', delayMs: 5_000 } });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'one', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'One.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.completes).toHaveLength(1);
    await $.turn.complete({ reason: 'aborted', answer: '', isAborted: true, turnId: 't2' } as never);
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect(await shows(ui, /Late line\./)).toBe(false);
    expect((memory(w) as any).items['fact.late']).toMatchObject({ text: 'Kept late.', from: 'shown' });
    expect(records(w).filter((r) => r.event === 'memory.op').map((r) => r.op)).toEqual(['add']);
    expect(records(w).filter((r) => r.event === 'commentAfterEachTurn.outcome').map((r) => r.outcome)).toEqual(['stale']);
    await ui.unmount();
  });
  test('a late reply loses to a newer memory save', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [
      { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Late line.\nMEMORY: {"fact.late":{"text":"Kept late.","from":"shown"}}', delayMs: 5_000 },
      { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: New line.\nMEMORY: {"fact.new":{"text":"Kept new.","from":"shown"}}' },
    ] });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'one', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'One.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.completes).toHaveLength(1);
    await prompt($, 'two', 't2');
    await $.turn.complete({ reason: 'answer', answer: 'Two.', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    const items = (memory(w) as any).items;
    expect(Object.keys(items)).toEqual(['fact.new']);
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect((memory(w) as any).items).toEqual(items);
    expect(records(w).filter((r) => r.event === 'memory.op').map(({ key, op, why, turn }) => ({ key, op, why, turn }))).toContainEqual({ key: '*', op: 'drop', why: 'late reply: a newer memory save came first', turn: 2 });
    expect(await shows(ui, /Late line\./)).toBe(false);
    await ui.unmount();
  });
  test('a late reply keeps its edits when the newer reply saved nothing: stamped with its own turn, proven only by what was typed by then', async ($, on) => {
    const late = 'COMMENT_AFTER_EACH_TURN: Late line.\nMEMORY: {"fact.late":{"text":"Kept late.","from":"shown"},"rule.main-safe":{"words":"keep main safe","covers":"the repo"}}';
    const w = world(on, { character: 'fixy' }, { queue: [
      { isAnswered: true, text: late, delayMs: 5_000 },
      { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: New line.' },
    ] });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'one', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'One.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    // The rule's words are typed only in turn 2, which turn 1's reply never saw.
    await prompt($, 'please keep main safe', 't2');
    await $.turn.complete({ reason: 'answer', answer: 'Two.', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect((memory(w) as any).items).toEqual({ 'fact.late': { text: 'Kept late.', from: 'shown', turn: 1, at: expect.any(Number) } });
    expect(records(w).filter((r) => r.event === 'memory.op').map(({ key, op, why, turn }) => ({ key, op, why, turn }))).toEqual([
      { key: 'fact.late', op: 'add', why: 'added', turn: 1 },
      { key: 'rule.main-safe', op: 'drop', why: 'words not typed by the user', turn: 1 },
    ]);
    await ui.unmount();
  });
  test('a late reply after clear cannot reach the new conversation memory', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Late line.\nMEMORY: {"fact.late":{"text":"Kept late.","from":"shown"}}', delayMs: 5_000 } });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'one', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'One.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.completes).toHaveLength(1);
    await $.session.end({ reason: 'clear', sessionId: SESSION, resume: {} } as never);
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect(memory(w, `${SESSION}-after-clear`)).toBeUndefined();
    expect((memory(w) as any).items).toEqual({});
    expect(records(w).filter((r) => r.event === 'memory.op').map(({ key, op, why, turn }) => ({ key, op, why, turn }))).toEqual([{ key: '*', op: 'drop', why: 'late reply: the conversation changed', turn: 1 }]);
    expect(await shows(ui, /Late line\./)).toBe(false);
    await ui.unmount();
  });

  test('no MEMORY line keeps stored items without any op row', async ($, on) => {
    const item = { text: 'Kept.', from: 'shown', turn: 0, at: 0 };
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Nice.' } }, { files: { [`${chatDir()}/memory.json`]: JSON.stringify({ version: 2, blocks: [], items: { 'fact.kept': item }, ended: {}, turnNo: 0, at: 0 }) } });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'one', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'One.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect((memory(w) as any).items).toEqual({ 'fact.kept': item });
    expect(records(w).filter((r) => r.event === 'memory.op')).toEqual([]);
    expect(await shows(ui, /Nice\./)).toBe(true);
    await ui.unmount();
  });
  test('a reply that changes nothing rewrites neither memory.json nor memory.md', { options: { commentAfterEachTurn: false, suggestNextPrompt: false, promptToMainChat: true } }, async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'PROMPT_TO_MAIN_CHAT: NONE\nMEMORY: {}', delayMs: 5_000 } });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'one', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'One.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    const filed = w.writes.filter((p) => p === `${chatDir()}/memory.json` || p === `${chatDir()}/memory.md`).length;
    expect(filed).toBeGreaterThan(0);
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect(w.completes).toHaveLength(1);
    expect(w.writes.filter((p) => p === `${chatDir()}/memory.json` || p === `${chatDir()}/memory.md`)).toHaveLength(filed);
    await ui.unmount();
  });
  test('a memory.json of a newer version is left untouched: read as empty, its error said, never rewritten', async ($, on) => {
    const newer = JSON.stringify({ version: 3, at: 0, turnNo: 4, blocks: [], items: { 'fact.kept': { text: 'Kept.', from: 'shown', turn: 0, at: 0 } }, ended: {} });
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Nice.\nMEMORY: {"fact.x":{"text":"X.","from":"shown"}}' } }, { files: { [`${chatDir()}/memory.json`]: newer } });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'one', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'One.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.files[`${chatDir()}/memory.json`]).toBe(newer);
    expect(w.writes.filter((p) => p === `${chatDir()}/memory.json` || p === `${chatDir()}/memory.md`)).toEqual([]);
    expect(w.logs).toContain('buddy: reading the chatTurnsToRead failed: the stored chatTurnsToRead is version 3, newer than this release reads: left untouched, read as empty');
    expect(await shows(ui, /Nice\./)).toBe(true);
    await ui.unmount();
  });
  test('five turns with four remembered keep chat numbers 2 through 5 in the fifth call', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Nice.' } });
    await $.session.start(START);
    const ui = await band($);
    for (let n = 1; n <= 5; n++) {
      await prompt($, `ask ${n}`, `t${n}`);
      await $.turn.complete({ reason: 'answer', answer: `answer ${n}`, isAborted: false, turnId: `t${n}` } as never);
      await w.clock.settle();
    }
    expect(w.completes[4]!.prompt.match(/^Turn \d+\./gm)).toEqual(['Turn 2.', 'Turn 3.', 'Turn 4.', 'Turn 5.']);
    expect((memory(w) as any).turnNo).toBe(5);
    await ui.unmount();
  });
  test('a refused memory write is logged as remembering the memory failed and the comment still shows', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Nice.\nMEMORY: {"fact.tests-green":{"text":"Tests passed.","from":"shown"}}' } }, { refuseMemory: true });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'one', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'One.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(await shows(ui, /Nice\./)).toBe(true);
    expect(w.logs.some((text) => /^buddy: remembering the memory failed: .+/.test(text))).toBe(true);
    expect(records(w).filter((r) => r.event === 'remembering the memory')).toContainEqual(expect.objectContaining({ level: 'error', error: expect.objectContaining({ message: expect.any(String) }) }));
    await ui.unmount();
  });
  test('loading items without turns writes memory.md and rewrites it after a character switch', async ($, on) => {
    const item = { text: 'Kept.', from: 'shown', turn: 0, at: 0 };
    const w = world(on, { character: 'fixy' }, {}, { files: { [`${chatDir()}/memory.json`]: JSON.stringify({ version: 2, blocks: [], items: { 'fact.kept': item }, ended: {}, turnNo: 0, at: 0 }) } });
    await $.session.start(START);
    await w.clock.settle();
    const md = `${chatDir()}/memory.md`;
    expect(w.files[md]!.startsWith('# What Fixy remembers\n')).toBe(true);
    expect(w.files[md]).toContain('- fact.kept · Kept. · from shown · age 0');
    expect(w.files[md]!.endsWith('\n\nNothing yet.\n')).toBe(true);
    const ui = await band($);
    await pick($, await personality($, w, ui), w, 'use:duck');
    await w.clock.settle();
    expect(w.files[md]!.startsWith('# What Duck Fixture remembers\n')).toBe(true);
    expect((memory(w) as any).items).toEqual({ 'fact.kept': item });
    await ui.unmount();
  });

});

describe('the end-of-turn call, turn by turn', () => {
  test('two turns 5 s apart: the second line waits until the first has had its 10 s; both drawn, both remembered', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: First line.\nSUGGEST_NEXT_PROMPT: NONE' }, { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Second line.\nSUGGEST_NEXT_PROMPT: NONE' }] });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'One.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(await shows(ui, /First line\./)).toBe(true);
    await w.clock.advance(5_000);
    await $.turn.complete({ reason: 'answer', answer: 'Two.', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    expect(await shows(ui, /First line\./)).toBe(true);
    expect(await shows(ui, /Second line\./)).toBe(false);
    await w.clock.advance(5_200);
    await w.clock.settle();
    expect(await shows(ui, /Second line\./)).toBe(true);
    expect(ring(w, 'fixy')).toContainEqual({ kind: 'endOfTurn', commentAfterEachTurn: 'First line.' });
    expect(ring(w, 'fixy')).toContainEqual({ kind: 'endOfTurn', commentAfterEachTurn: 'Second line.' });
    expect(records(w).filter((r) => r.event === 'commentAfterEachTurn.outcome').map((r) => r.outcome)).toEqual(['answered', 'answered']);
    await ui.unmount();
  });

  test('a character picked while the call runs never says the commentAfterEachTurn nor files it; suggestNextPrompt stays the asker\'s', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Fixy likes that.\nSUGGEST_NEXT_PROMPT: run the tests' }, completeDelayMs: 5_000 }, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await pick($, await personality($, w, ui), w, 'use:duck');
    await w.clock.settle();
    await fold(ui, w);
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect(w.completes[0]?.system).toContain('You are Fixy, a test fixture.');
    expect(await shows(ui, /Fixy likes that\./)).toBe(false);
    expect(JSON.stringify(ring(w, 'duck'))).not.toContain('Fixy likes that.');
    expect(ring(w, 'fixy')).toContainEqual({ kind: 'endOfTurn', suggestNextPrompt: 'run the tests' });
    expect(records(w).find((r) => r.event === 'commentAfterEachTurn.outcome')).toMatchObject({ outcome: 'dropped', asker: 'fixy', drawn: 'duck' });
    await ui.unmount();
  });

  test('/clear forgets the chat: the next call reads none of it, and a call in flight shows nothing', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Old news.\nSUGGEST_NEXT_PROMPT: old step' }, completeDelayMs: 5_000 });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'the secret plan', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'Planned.', isAborted: false, turnId: 't1' } as never);
    await $.session.end({ reason: 'clear', sessionId: SESSION, resume: {} } as never);
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect(await shows(ui, /Old news\./)).toBe(false);
    expect(w.suggested).toEqual([]);
    await prompt($, 'a fresh start', 't2');
    await $.turn.complete({ reason: 'answer', answer: 'Fresh.', isAborted: false, turnId: 't2' } as never);
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect(w.completes).toHaveLength(2);
    expect(w.completes[1]!.prompt).toContain('a fresh start');
    expect(w.completes[1]!.prompt).not.toContain('the secret plan');
    await ui.unmount();
  });

  test('a prompt typed over a running turn is filed with the turn it starts, never the running one', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'first ask', 't1');
    await $.prompt.submit({ text: 'second ask', origin: { kind: 'composer' }, turnId: 't1' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'first reply', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    await $.turn.start({ text: 'second ask', turnId: 't2' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'second reply', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    const last = withoutNumbers(w.completes.at(-1)!.prompt);
    expect(last).toContain('The user asked Claude:\nsuggested: none\nsent: first ask\nClaude answered:\nfirst reply');
    expect(last).toContain('The user asked Claude:\nsuggested: none\nsent: second ask\nClaude answered:\nsecond reply');
    await ui.unmount();
  });

  test('a next turn that ends aborted makes the call in flight stale: no commentAfterEachTurn, no suggestNextPrompt, and the engine\'s own suggestion passes', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Late line.\nSUGGEST_NEXT_PROMPT: late step' }, completeDelayMs: 5_000 });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await $.turn.complete({ reason: 'aborted', answer: '', isAborted: true, turnId: 't2' } as never);
    expect(await $.prompt.suggest({ text: 'engine step', origin: { kind: 'suggestion' } } as never)).toMatchObject({ isShown: true });
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect(await shows(ui, /Late line\./)).toBe(false);
    expect(w.suggested).toEqual(['engine step']);
    expect(records(w).filter((r) => r.event === 'commentAfterEachTurn.outcome' || r.event === 'suggestNextPrompt.outcome').map((r) => r.outcome)).toEqual(['stale', 'stale']);
    await ui.unmount();
  });

  test('after a turn that makes no call (an error), the engine\'s own suggestion passes, even after the buddy\'s was shown', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Fine.\nSUGGEST_NEXT_PROMPT: run the tests' } });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.suggested).toEqual(['run the tests']);
    await $.turn.complete({ reason: 'error', answer: '', isAborted: false, turnId: 't2' } as never);
    expect(await $.prompt.suggest({ text: 'retry', origin: { kind: 'suggestion' } } as never)).toMatchObject({ isShown: true });
    expect(w.suggested).toEqual(['run the tests', 'retry']);
    await ui.unmount();
  });

  test('before the band ever drew, a turn pays for no commentAfterEachTurn and remembers none; suggestNextPrompt still comes, the call\'s usage on its verdict', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Unseen.\nSUGGEST_NEXT_PROMPT: run the tests' } });
    await $.session.start(START);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.completes).toHaveLength(1);
    expect(w.completes[0]!.system).not.toContain('COMMENT_AFTER_EACH_TURN:');
    expect(w.suggested).toEqual(['run the tests']);
    expect(ring(w, 'fixy')).toContainEqual({ kind: 'endOfTurn', suggestNextPrompt: 'run the tests' });
    expect(JSON.stringify(ring(w, 'fixy'))).not.toContain('Unseen.');
    expect(records(w).find((r) => r.event === 'turn.call')).toMatchObject({ commentAfterEachTurn: false, suggestNextPrompt: true });
    expect(records(w).find((r) => r.event === 'commentAfterEachTurn.outcome')).toBeUndefined();
    expect(records(w).find((r) => r.event === 'verdict.outcome')).toMatchObject({ outcome: 'none', inTok: 1, outTok: 1 });
    expect(records(w).find((r) => r.event === 'suggestNextPrompt.outcome')).toMatchObject({ outcome: 'shown' });
  });
});

describe('a question\'s one deadline', () => {
  test('the thinking line shows at once, while the chatTurnsToRead read still waits', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($);
    w.slow.sessionIdMs = 5_000;
    expect((await $.command.run(run('what is up'))).text).toBe('Asked Fixy.');
    expect(await shows(ui, /Fixy ponders\./)).toBe(true);
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect(w.completes).toHaveLength(1);
    // Sent 5 s into its 90 s: abandoned 5 s past what is left, never 95 s after it was sent
    // (a millisecond or so of real time may pass between the two clock reads).
    expect(w.completes[0]?.timeoutMs).toBeLessThanOrEqual(90_000);
    expect(w.completes[0]?.timeoutMs).toBeGreaterThan(89_900);
    await ui.unmount();
  });

  test('a chatTurnsToRead read that never ends still ends the question at 90 s, frees the slot, and no longer blocks later reads', { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($);
    w.slow.sessionIdMs = 1_000_000;
    void $.command.run(run('what is up'));
    await w.clock.advance(90_000);
    await w.clock.settle();
    expect(await shows(ui, /no[ \n]answer[ \n]in[ \n]90[ \n]s/)).toBe(true);
    expect(w.completes).toHaveLength(0);
    expect((await $.command.run(run('and now?'))).text).toMatch(/^Asked Fixy\./);
    await w.clock.advance(90_000);
    await w.clock.settle();
    // The hung link is abandoned at the deadline: said once, however many reads it cost.
    expect(w.logs.filter((l) => l.includes('reading the chatTurnsToRead failed: no answer in 90 s'))).toHaveLength(1);
    w.slow.sessionIdMs = 0;
    await $.command.run(run('and after it?'));
    // Behind it only the last question's write, itself hung, abandoned at its own 60 s.
    await w.clock.advance(61_000);
    await w.clock.settle();
    expect(w.completes).toHaveLength(1);
    expect(await shows(ui, /A completed answer\./)).toBe(true);
    await ui.unmount();
  });

  test("a chatTurnsToRead kept in the store before 1.0.0 moves into the chat's folder at its first read; another chat's stays", async ($, on) => {
    const old = { at: 1, blocks: [{ turnId: 'old', at: 1, turn: { prompt: 'build the thing', answer: 'Built.' }, characters: { fixy: [{ kind: 'question', question: 'remember pineapple', answer: 'Pineapple, noted.' }] } }] };
    const w = world(on, { character: 'fixy', [`chatTurnsToRead:${SESSION}`]: old, 'chatTurnsToRead:another-chat': old });
    await $.session.start(START);
    await w.clock.settle();
    expect(memory(w)).toMatchObject({ blocks: old.blocks });
    expect(w.saved.has(`chatTurnsToRead:${SESSION}`)).toBe(false);
    expect(w.saved.has('chatTurnsToRead:another-chat')).toBe(true);
    const ui = await band($);
    await $.command.run(run('what is up'));
    await w.clock.settle();
    expect(w.completes.at(-1)!.prompt).toContain('remember pineapple');
    expect(ring(w, 'fixy')).toContainEqual(expect.objectContaining({ kind: 'question', question: 'what is up' }));
    await ui.unmount();
  });
});

describe('the re-audit fixes', () => {
  test('a peer message delivered into a running turn never takes the next turn\'s prompt, and is never filed as the user\'s', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'first ask', 't1');
    await $.prompt.submit({ text: 'peer says hi', origin: { kind: 'peer' }, turnId: 't1' } as never);
    await $.prompt.submit({ text: 'second ask', origin: { kind: 'composer' }, turnId: 't1' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'first reply', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    await $.turn.start({ text: 'second ask', turnId: 't2' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'second reply', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    const last = withoutNumbers(w.completes.at(-1)!.prompt);
    expect(last).toContain('The user asked Claude:\nsuggested: none\nsent: second ask\nClaude answered:\nsecond reply');
    expect(last).not.toContain('peer says hi');
    await ui.unmount();
  });

  test('a turn a peer started is filed under its origin, never as what the user asked', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($);
    await $.prompt.submit({ text: 'hello from a peer', origin: { kind: 'peer' } } as never);
    await $.turn.start({ text: 'hello from a peer', turnId: 't1' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'Hi, peer.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.completes[0]!.prompt).toContain('Claude was sent, not by the user (peer):\nhello from a peer');
    expect(w.completes[0]!.prompt).not.toContain('The user asked Claude:\nsuggested: none\nsent: hello from a peer');
    await ui.unmount();
  });

  test('a prompt a lower hook dropped is never filed as a turn\'s', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'kept ask', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'kept reply', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    w.submit.drop.add('dropped ask');
    await $.prompt.submit({ text: 'dropped ask', origin: { kind: 'composer' } } as never);
    await $.turn.start({ text: '', turnId: 't2' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'went on', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    expect(w.completes.at(-1)!.prompt).not.toContain('dropped ask');
    await ui.unmount();
  });

  test('/clear mid-turn: the next turn is filed with its own prompt, nothing of the old one', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'old ask', 't1');
    await $.prompt.submit({ text: 'queued old', origin: { kind: 'composer' }, turnId: 't1' } as never);
    await $.session.end({ reason: 'clear', sessionId: SESSION, resume: {} } as never);
    await prompt($, 'new ask', 't2');
    await $.turn.complete({ reason: 'answer', answer: 'new reply', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    const last = withoutNumbers(w.completes.at(-1)!.prompt);
    expect(last).toContain('The user asked Claude:\nsuggested: none\nsent: new ask\nClaude answered:\nnew reply');
    expect(last).not.toContain('old ask');
    expect(last).not.toContain('queued old');
    await ui.unmount();
  });

  test('a resume forgets the chat as /clear does', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'the secret plan', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'Planned.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    await $.session.end({ reason: 'resume', sessionId: SESSION, resume: {} } as never);
    await prompt($, 'a fresh start', 't2');
    await $.turn.complete({ reason: 'answer', answer: 'Fresh.', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    expect(w.completes).toHaveLength(2);
    expect(w.completes[1]!.prompt).not.toContain('the secret plan');
    expect(records(w).find((r) => r.event === 'session.forget')).toMatchObject({ reason: 'resume' });
    await ui.unmount();
  });

  test('a /buddy question in flight at /clear is neither shown as an answer nor remembered: it is said dropped', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'About the old chat.' }, completeDelayMs: 5_000 });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(run('what did we do'));
    await w.clock.settle();
    await $.session.end({ reason: 'clear', sessionId: SESSION, resume: {} } as never);
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect(await shows(ui, /About the old chat\./)).toBe(false);
    expect(ring(w, 'fixy').filter((x: { kind: string }) => x.kind === 'question')).toEqual([]);
    expect(records(w).find((r) => r.event === 'ask.outcome')).toMatchObject({ outcome: 'dropped', reason: 'the conversation it was asked in ended' });
    await ui.unmount();
  });

  test('a /buddy question spanning an ordinary turn end still answers', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: 'Still here.' }, { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: ok\nSUGGEST_NEXT_PROMPT: NONE' }], completeDelayMs: 5_000 });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(run('you there'));
    await w.clock.settle();
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect(records(w).find((r) => r.event === 'ask.outcome')).toMatchObject({ outcome: 'answered' });
    await ui.unmount();
  });

  test('a suggestNextPrompt overtaken by a started turn is logged stale, never proposed', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Nice.\nSUGGEST_NEXT_PROMPT: run the tests' }, completeDelayMs: 5_000 });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await $.turn.start({ text: 'go on', turnId: 't2' } as never);
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect(w.suggested).toEqual([]);
    expect(records(w).find((r) => r.event === 'suggestNextPrompt.outcome')).toMatchObject({ outcome: 'stale' });
    await ui.unmount();
  });

  test('the engine\'s suggestion held before the turn\'s end is shown when the end-of-turn call fails, never erased', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Fine.\nSUGGEST_NEXT_PROMPT: run the tests' }, { isAnswered: false, reason: 'api-error', status: 529 }] });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.suggested).toEqual(['run the tests']);
    // The engine suggests for t2 before the plugin's turn.complete code runs.
    expect(await $.prompt.suggest({ text: 'engine step', origin: { kind: 'suggestion' } } as never)).toMatchObject({ isShown: false });
    await $.turn.complete({ reason: 'answer', answer: 'Again.', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    expect(w.suggested).toEqual(['run the tests', 'engine step']);
    await ui.unmount();
  });

  test('an end-of-turn call that times out shows the engine\'s held suggestion', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Late.\nSUGGEST_NEXT_PROMPT: late step' }, completeDelayMs: 40_000 });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    expect(await $.prompt.suggest({ text: 'engine step', origin: { kind: 'suggestion' } } as never)).toMatchObject({ isShown: false });
    await w.clock.advance(30_000);
    await w.clock.settle();
    expect(w.suggested).toEqual(['engine step']);
    expect(records(w).find((r) => r.event === 'suggestNextPrompt.outcome')).toMatchObject({ outcome: 'failed', reason: 'timeout' });
    await w.clock.advance(10_000);
    await w.clock.settle();
    await ui.unmount();
  });

  test('/buddy off during the end-of-turn call: commentAfterEachTurn is not shown nor remembered, suggestNextPrompt not proposed', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Unseen line.\nSUGGEST_NEXT_PROMPT: run the tests' }, completeDelayMs: 5_000 });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await $.command.run(run('off'));
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect(w.suggested).toEqual([]);
    expect(JSON.stringify(ring(w, 'fixy'))).not.toContain('Unseen line.');
    expect(records(w).filter((r) => r.event === 'commentAfterEachTurn.outcome' || r.event === 'suggestNextPrompt.outcome').map((r) => r.outcome)).toEqual(['hidden', 'stale']);
    await ui.unmount();
  });
});

describe('the round-3 audit fixes', () => {
  /** Fixy with two greetings: /buddy on says the one it did not say last, a canned line the memory has not got yet. */
  const TWO_GREETINGS = { builtins: { 'fixy.json': fixture('fixy', 'Fixy', 'f_f', { greeting: ['Fixy says hi.', 'Fixy says hello.'] }) } };
  const greetings = (w: { files: Record<string, string> }): string[] => ring(w, 'fixy').filter((x: { kind: string }) => x.kind === 'line').map((x: { text: string }) => x.text).sort();

  test('a write queued behind a hung read is never said failed while it waits, and lands once the read is abandoned', { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, TWO_GREETINGS);
    await $.session.start(START);
    const ui = await band($);
    await w.clock.settle();
    w.slow.sessionIdMs = 1_000_000;
    void $.command.run(run('what is up'));
    await w.clock.settle();
    w.slow.sessionIdMs = 0;
    await $.command.run(run('off'));
    await $.command.run(run('on'));
    await w.clock.advance(61_000);
    await w.clock.settle();
    expect(w.logs.filter((l) => /remembering the line failed/.test(l))).toEqual([]);
    await w.clock.advance(60_000);
    await w.clock.settle();
    expect(greetings(w)).toEqual(['Fixy says hello.', 'Fixy says hi.']);
    expect(w.logs.filter((l) => /remembering the line failed/.test(l))).toEqual([]);
    await ui.unmount();
  });

  test('a chatTurnsToRead read abandoned at its deadline and landing late never replaces the book a later write stored', { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, { character: 'fixy' });
    // The session's first load, at its start: it hangs, is abandoned at 60 s, and lands at 120 s; every read after it answers at once.
    w.slow.chatTurnsToReadGetMs = 120_000;
    await $.session.start(START);
    await w.clock.settle();
    w.slow.chatTurnsToReadGetMs = 0;
    const ui = await band($);
    await w.clock.settle();
    await w.clock.advance(61_000);
    await w.clock.settle();
    await $.command.run(run('what is up'));
    await w.clock.settle();
    expect(ring(w, 'fixy')).toContainEqual(expect.objectContaining({ kind: 'question', question: 'what is up' }));
    await w.clock.advance(60_000);
    await w.clock.settle();
    expect(ring(w, 'fixy')).toContainEqual(expect.objectContaining({ kind: 'question', question: 'what is up' }));
    await ui.unmount();
  });

  test('a chatTurnsToRead write abandoned at its deadline and landing late never overwrites a later one', { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, TWO_GREETINGS);
    await $.session.start(START);
    const ui = await band($);
    await w.clock.settle();
    w.slow.chatTurnsToReadSetMs = 70_000;
    await $.command.run(run('off'));
    await $.command.run(run('on'));
    await w.clock.advance(61_000);
    await w.clock.settle();
    w.slow.chatTurnsToReadSetMs = 0;
    await $.command.run(run('what is up'));
    await w.clock.advance(25_000);
    await w.clock.settle();
    expect(greetings(w)).toEqual(['Fixy says hello.', 'Fixy says hi.']);
    expect(ring(w, 'fixy')).toContainEqual(expect.objectContaining({ kind: 'question', question: 'what is up' }));
    await ui.unmount();
  });

  test('a /buddy question whose completion throws after /clear is dropped and never remembered', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, error: 'the request was refused', delayMs: 5_000 } });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(run('what did we do'));
    await w.clock.settle();
    await $.session.end({ reason: 'clear', sessionId: SESSION, resume: {} } as never);
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect(ring(w, 'fixy').filter((x: { kind: string }) => x.kind === 'question')).toEqual([]);
    expect(records(w).find((r) => r.event === 'ask.outcome')).toMatchObject({ outcome: 'dropped', reason: 'the conversation it was asked in ended' });
    await ui.unmount();
  });

  test('an empty reply retried past the deadline: ask.outcome still carries the first call\'s usage', { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: '' }, { isAnswered: true, text: 'Too late.', delayMs: 200_000 }] });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(run('you there'));
    await w.clock.advance(90_000);
    await w.clock.settle();
    expect(w.completes).toHaveLength(2);
    expect(records(w).find((r) => r.event === 'ask.outcome')).toMatchObject({ outcome: 'failed', inTok: 1, outTok: 1 });
    await ui.unmount();
  });

  test('an empty reply whose retry throws: ask.outcome still carries the first call\'s usage', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: '' }, { isAnswered: true, error: 'the request was refused' }] });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(run('you there'));
    await w.clock.settle();
    expect(w.completes).toHaveLength(2);
    expect(records(w).find((r) => r.event === 'ask.outcome')).toMatchObject({ outcome: 'failed', inTok: 1, outTok: 1 });
    await ui.unmount();
  });

  test('a turn that ends before the character is loaded clears the running-turn marker: the next turn\'s suggestNextPrompt is shown, not stale', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Nice.\nSUGGEST_NEXT_PROMPT: run the tests' } });
    await $.turn.start({ text: 'early', turnId: 't0' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'Early.', isAborted: false, turnId: 't0' } as never);
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.suggested).toEqual(['run the tests']);
    await ui.unmount();
  });

  test('a turn whose lower turn.complete hook throws still clears the running-turn marker', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Nice.\nSUGGEST_NEXT_PROMPT: run the tests' } });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'first', 'boom');
    await $.turn.complete({ reason: 'answer', answer: 'First.', isAborted: false, turnId: 'boom' } as never).catch(() => undefined);
    await w.clock.settle();
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.suggested).toContain('run the tests');
    await ui.unmount();
  });

  test('turn.start then turn.complete: the turn\'s own suggestNextPrompt is shown, never stale', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Nice.\nSUGGEST_NEXT_PROMPT: run the tests' } });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'build it', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'Built.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.suggested).toEqual(['run the tests']);
    expect(records(w).find((r) => r.event === 'suggestNextPrompt.outcome')).toMatchObject({ outcome: 'shown' });
    await ui.unmount();
  });

  test('a turn.start whose text differs from its submission is filed with its own text, of unknown origin, never as not the user\'s', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.start({ text: 'the expanded skill text', turnId: 't1' } as never);
    await $.prompt.submit({ text: '/skill', origin: { kind: 'composer' } } as never);
    await $.turn.complete({ reason: 'answer', answer: 'Skilled.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    const last = w.completes.at(-1)!.prompt;
    expect(last).toContain("Claude was sent, by a sender you did not see (most often the user's own slash command or skill, or a prompt sent while you restarted):\nthe expanded skill text");
    expect(last).not.toContain('not by the user');
    await ui.unmount();
  });

  test('the owner\'s Slack ping is filed as the user\'s', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.start({ text: 'check the build', turnId: 't1' } as never);
    await $.prompt.submit({ text: 'check the build', origin: { kind: 'slack-ping' } } as never);
    await $.turn.complete({ reason: 'answer', answer: 'Green.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.completes.at(-1)!.prompt).toContain('The user asked Claude:\nsuggested: none\nsent: check the build');
    await ui.unmount();
  });

  test('the engine\'s held suggestion, beaten by the buddy\'s shown one, is logged replaced at once, never stale later', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Nice.\nSUGGEST_NEXT_PROMPT: run the tests' }, completeDelayMs: 5_000 });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await $.prompt.suggest({ text: 'commit', origin: { kind: 'suggestion' } } as never);
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect(w.suggested).toEqual(['run the tests']);
    await $.turn.start({ text: 'next', turnId: 't2' } as never);
    await w.clock.settle();
    const outcomes = records(w).filter((r) => r.event === 'suggestNextPrompt.outcome').map((r) => r.outcome);
    expect(outcomes).toEqual(['shown', 'harness-replaced']);
    await ui.unmount();
  });

  test('the engine\'s held suggestion released while the buddy is hidden is logged, never dropped in silence', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Nice.\nSUGGEST_NEXT_PROMPT: NONE' }, completeDelayMs: 5_000 });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await $.prompt.suggest({ text: 'commit', origin: { kind: 'suggestion' } } as never);
    await $.command.run(run('off'));
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect(w.suggested).toEqual([]);
    expect(records(w).filter((r) => r.event === 'suggestNextPrompt.outcome').map((r) => r.outcome)).toContain('harness-hidden');
    await ui.unmount();
  });
});

describe('the drawer', () => {
  test('the drawer has no button but its shortcuts: each a whole ctrl+x chord on an action Claude Code handles only in a panel or dialog, their guide at the bottom-left, the ask box at the bottom-right', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($, { bodyColumns: 140, maxRows: 40 });
    await $.command.run(run(''));
    await w.clock.settle();
    const buttons = (await ui.findAll({ type: 'Button' })) as { key: string; props: { label: string; action?: string } }[];
    expect(buttons.map((b) => [b.key, b.props.label, b.props.action])).toEqual([
      ['key-personality', 'personality', 'pane:next'],
      ['key-use', 'use suggested prompt', 'pane:previous'],
      ['close', 'close', 'confirm:previousField'],
    ]);
    // Borrowed, never taken: each action one Claude Code handles only in a panel or dialog, each chord none it binds at the prompt.
    const panelOnly = ['pane:next', 'pane:previous', 'confirm:previousField'];
    const itsCtrlX = ['ctrl+x ctrl+k', 'ctrl+x enter', 'ctrl+x ctrl+s', 'ctrl+x ctrl+e', 'ctrl+x ctrl+b', 'ctrl+x ctrl+a', 'ctrl+x tab', 'ctrl+x x', 'ctrl+x left', 'ctrl+x up', 'ctrl+x right', 'ctrl+x down'];
    for (const k of SHORTCUTS) {
      expect(panelOnly).toContain(k.action);
      expect(itsCtrlX).not.toContain(k.chord);
    }
    // The bar under the body: its numbers and the guide at its left, the ask box last, at its right.
    const drawn = JSON.stringify(await ui.drawn());
    expect(drawn.indexOf('"bar"')).toBeGreaterThan(drawn.indexOf('"body"'));
    expect(drawn.indexOf('"guide"')).toBeGreaterThan(drawn.indexOf('"bar"'));
    expect(drawn.indexOf('ask-input')).toBeGreaterThan(drawn.lastIndexOf('"close"'));
    // Each shortcut its whole chord: none leans on a ctrl+x said once.
    expect((await ui.find({ key: 'guide' }))?.text).toMatch(/^ctrl\+x tab ask\s*ctrl\+x t personality\s*ctrl\+x u use suggested prompt\s*ctrl\+x q close$/);
    expect(await shows(ui, /←|↑↓|Enter presses/)).toBe(false);
    await ui.unmount();
  });

  test('/buddy alone opens the band above the prompt into the drawer, full width: the thread, the suggested prompt with use, the ask box; again folds it back into the buddy', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Fixy likes that.\nSUGGEST_NEXT_PROMPT: run the tests' }, { isAnswered: true, text: 'Because it passed.' }] });
    const filled: string[] = [];
    on('prompt.fill', async (_$, e) => {
      filled.push(e.text);
      return { isFilled: true, box: { text: e.text, cursor: e.text.length } } as never;
    });
    await $.session.start(START);
    const ui = await band($, { bodyColumns: 140, maxRows: 20 });
    await $.turn.start({ text: 'fix the build', turnId: 't1' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect((await $.command.run(run(''))).text).toMatch(/^The drawer is open above your prompt/);
    await w.clock.settle();
    expect(await shows(ui, /^F I X Y$/)).toBe(true);
    expect(await shows(ui, /^Fixy likes that\.$/)).toBe(true);
    expect(await shows(ui, /^fix the build$/)).toBe(true);
    expect(await shows(ui, /^run the tests$/)).toBe(true);
    await ui.press({ key: 'key-use' });
    await w.clock.settle();
    expect(filled).toEqual(['run the tests']);
    // The ask box asks whatever it says, `off` included: never a /buddy subcommand.
    await ui.input({ key: 'ask-input', text: 'off', kind: 'submit' });
    await w.clock.settle();
    expect(w.completes.at(-1)!.prompt).toContain('off');
    expect(await shows(ui, /^off$/)).toBe(true);
    expect(await shows(ui, /^Because it passed\.$/)).toBe(true);
    // ctrl+x q folds it back, as the command again does.
    await ui.press({ key: 'close' });
    await w.clock.settle();
    expect(await shows(ui, /^F I X Y$/)).toBe(false);
    expect(await shows(ui, /\(f_f\)/)).toBe(true);
    await ui.unmount();
  });

  test('it fills the rows the band has, a short thread too, its last row saying where memory.md is once it is written', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($, { bodyColumns: 140, maxRows: 20 });
    await $.command.run(run(''));
    await w.clock.settle();
    // The greeting alone is remembered: memory.json and memory.md are written.
    expect(rowsOf(await ui.drawn())).toBe(20);
    expect(await shows(ui, new RegExp(`^memory {2}${chatDir()}/memory\\.md$`))).toBe(true);
    await prompt($, 'one', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'One.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(rowsOf(await ui.drawn())).toBe(20);
    await ui.unmount();
  });

  test('a newest message taller than the body keeps the band\'s rows: its first lines, how many more, and the memory row under it', async ($, on) => {
    const tall = `Start ${'of a very long comment '.repeat(120)}end.`;
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: `COMMENT_AFTER_EACH_TURN: ${tall}` }] });
    await $.session.start(START);
    const ui = await band($, { bodyColumns: 140, maxRows: 20 });
    await $.turn.start({ text: 'fix the build', turnId: 't1' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    await $.command.run(run(''));
    await w.clock.settle();
    expect(rowsOf(await ui.drawn())).toBe(20);
    expect(await shows(ui, /^Start of a very long comment/)).toBe(true);
    expect(await shows(ui, /^… \d+ more lines$/)).toBe(true);
    expect(await shows(ui, /^memory {2}/)).toBe(true);
    await ui.unmount();
  });

  test('before memory.md is written, its row says who writes it and when; a refused write is said, memory.json kept', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { refuseMemoryText: true });
    await $.session.start(START);
    const ui = await band($, { bodyColumns: 140, maxRows: 20 });
    await $.command.run(run(''));
    await w.clock.settle();
    expect(rowsOf(await ui.drawn())).toBe(20);
    expect(await shows(ui, /^memory {2}not written yet: Fixy writes it at its first turn$/)).toBe(true);
    // A thrown answer reaches the plugin as the kit's own rejection: its words are the kit's.
    expect(w.logs.some((l) => l.startsWith('buddy: writing memory.md failed: '))).toBe(true);
    expect(memory(w)).toBeDefined();
    await ui.unmount();
  });

  test('it fits the rows the band has: the thread its newest messages, saying how many older', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($, { bodyColumns: 140, maxRows: 12 });
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];
    for (const [n, word] of words.entries()) {
      await $.turn.start({ text: `do ${word}`, turnId: `t${n}` } as never);
      await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: `t${n}` } as never);
      await w.clock.settle();
    }
    await $.command.run(run(''));
    await w.clock.settle();
    const drawn = JSON.stringify(await ui.drawn());
    expect(drawn).toContain('do lima');
    expect(drawn).not.toContain('do alpha');
    expect(await shows(ui, /^↑ \d+ older messages$/)).toBe(true);
    expect(rowsOf(await ui.drawn())).toBe(12);
    // The guide wraps its shortcuts whole: one row wide, three narrow; the body gives up what it takes.
    expect([guideRows(100, true), guideRows(60, true), guideRows(40, true)]).toEqual([1, 2, 3]);
    await ui.unmount();
  });
});

describe('memory: whole messages, compactions, retries, and the drawer spanning it', () => {
  test('what you and the buddy say is kept whole, however long, and handed back whole', async ($, on) => {
    const long = `${'why '.repeat(200)}?`.trim();
    const answer = `First: ${'because '.repeat(150)}`.trim();
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: answer }] });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(run(long));
    await w.clock.settle();
    expect(ring(w, 'fixy')).toContainEqual({ kind: 'question', question: long, answer });
    await $.command.run(run('and?'));
    await w.clock.settle();
    expect(w.completes[1]!.prompt).toContain(long);
    expect(w.completes[1]!.prompt).toContain(`because ${'because '.repeat(148)}because`);
    await ui.unmount();
  });

  test('a compaction of the main chat is remembered as a turn: its summary reaches the next call and the drawer', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    on('session.compact', async (_$, e) => ({ messages: [{ role: 'user', text: 'Summary: we built the drawer; tests are next.', toolUses: [] }, ...e.messages.slice(-1)] }) as never);
    await $.session.start(START);
    const ui = await band($);
    await $.turn.start({ text: 'build the drawer', turnId: 't1' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'Built.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'build the drawer', toolUses: [], handle: 'h1' }, { role: 'assistant', text: 'Built.', toolUses: [], handle: 'h2' }] } as never);
    await w.clock.settle();
    const blocks = (memory(w) as { blocks: { turnId?: string; turn?: { answer: string; from?: string } }[] }).blocks;
    expect(blocks.at(-1)).toMatchObject({ turn: { answer: 'Summary: we built the drawer; tests are next.', from: 'compaction' } });
    await $.command.run(run('where are we?'));
    await w.clock.settle();
    expect(w.completes.at(-1)!.prompt).toContain('The main chat was compacted: Claude now holds only this summary of everything before it:\nSummary: we built the drawer; tests are next.');
    await $.command.run(run(''));
    await w.clock.settle();
    expect(await shows(ui, /chat compacted/)).toBe(true);
    await ui.unmount();
  });

  test('a precomputed compaction, or a subagent\'s, is never filed', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    on('session.compact', async () => ({ messages: [{ role: 'user', text: 'Summary.', toolUses: [] }] }) as never);
    await $.session.start(START);
    await $.session.compact({ trigger: 'precompute', messages: [] } as never);
    await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: [] } as never);
    await w.clock.settle();
    expect(JSON.stringify(memory(w) ?? null)).not.toContain('Summary.');
  });

  test('a memory write refused once is made again and lands; the failure is no longer said', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { refuseMemory: true, refuseMemoryTimes: 1 });
    await $.session.start(START);
    await $.turn.start({ text: 'ship it', turnId: 't1' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'Shipped.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    await w.clock.advance(6_000);
    await w.clock.settle();
    const blocks = (memory(w) as { blocks: { turnId?: string }[] }).blocks;
    expect(blocks.map((b) => b.turnId)).toContain('t1');
    expect(records(w).filter((r) => r.event === 'chatTurnsToRead.retry').map((r) => r.outcome)).toContain('landed');
    expect((await $.command.run(run('ok?'))).text).toBe('Asked Fixy.');
  });

  test('a failed memory write is not tried again once the next turn has started', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { refuseMemory: true, refuseMemoryTimes: 1 });
    await $.session.start(START);
    await $.turn.start({ text: 'ship it', turnId: 't1' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'Shipped.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    await $.turn.start({ text: 'next', turnId: 't2' } as never);
    await w.clock.advance(6_000);
    await w.clock.settle();
    expect(records(w).filter((r) => r.event === 'chatTurnsToRead.retry')).toMatchObject([{ outcome: 'skipped', reason: 'the next turn started' }]);
  });

  test('the drawer names how a turn it never read ended: an API error or a refusal, not an interruption', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Noted.\nSUGGEST_NEXT_PROMPT: NONE' } });
    await $.session.start(START);
    const ui = await band($, { bodyColumns: 140, maxRows: 40 });
    await $.turn.start({ text: 'task one', turnId: 't1' } as never);
    await $.turn.complete({ reason: 'error', answer: '', isAborted: false, turnId: 't1' } as never);
    await $.turn.start({ text: 'task two', turnId: 't2' } as never);
    await $.turn.complete({ reason: 'refusal', refusal: { category: null, explanation: null }, answer: '', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    await $.command.run(run(''));
    await w.clock.settle();
    const drawn = JSON.stringify(await ui.drawn());
    expect(drawn).toContain('ended by an error, Fixy never read it');
    expect(drawn).toContain('refused, Fixy never read it');
    expect(drawn).not.toContain('interrupted, Fixy');
  });
  test('the drawer spans exactly what the buddy remembers: the last 4 turns it read; an interrupted one is marked', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Noted.\nSUGGEST_NEXT_PROMPT: NONE' } });
    await $.session.start(START);
    const ui = await band($, { bodyColumns: 140, maxRows: 40 });
    for (const n of [1, 2, 3, 4, 5]) {
      await $.turn.start({ text: `task number ${n}`, turnId: `t${n}` } as never);
      await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: n === 3, turnId: `t${n}` } as never);
      await w.clock.settle();
    }
    await $.command.run(run(''));
    await w.clock.settle();
    const drawn = JSON.stringify(await ui.drawn());
    // t3 was interrupted: remembered turns are 1, 2, 4, 5; four kept: all of them, t3 marked inside.
    expect(drawn).toContain('task number 1');
    expect(drawn).toContain("interrupted, Fixy never read it");
    await $.command.run(run(''));
    await $.turn.start({ text: 'task number 6', turnId: 't6' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't6' } as never);
    await w.clock.settle();
    await $.command.run(run(''));
    await w.clock.settle();
    const after = JSON.stringify(await ui.drawn());
    expect(after).not.toContain('task number 1');
    expect(after).toContain('task number 2');
    expect(after).toContain('task number 6');
    await ui.unmount();
  });

  test('a resumed session with no feed draws its memory back into the drawer', async ($, on) => {
    const w = world(on, { character: 'fixy', [`chatTurnsToRead:${SESSION}`]: { at: 1, blocks: [{ turnId: 'old', at: 1, turn: { prompt: 'build the thing', answer: 'Built.' }, characters: { fixy: [{ kind: 'question', question: 'remember pineapple', answer: 'Pineapple, noted.' }] } }] } });
    await $.session.start(START);
    const ui = await band($, { bodyColumns: 140, maxRows: 40 });
    await $.command.run(run('still there?'));
    await w.clock.settle();
    await $.command.run(run(''));
    await w.clock.settle();
    expect(await shows(ui, /^build the thing$/)).toBe(true);
    expect(await shows(ui, /^remember pineapple$/)).toBe(true);
    expect(await shows(ui, /^Pineapple, noted\.$/)).toBe(true);
    await ui.unmount();
  });

  test('a reopened chat draws its memory into the drawer at once: no turn or question needed first', async ($, on) => {
    const w = world(on, { character: 'fixy', [`chatTurnsToRead:${SESSION}`]: { at: 1, blocks: [{ turnId: 'old', at: 1, turn: { prompt: 'build the thing', answer: 'Built.' }, characters: { fixy: [{ kind: 'question', question: 'remember pineapple', answer: 'Pineapple, noted.' }] } }] } });
    await $.session.start(START);
    await w.clock.settle();
    const ui = await band($, { bodyColumns: 140, maxRows: 40 });
    await $.command.run(run(''));
    await w.clock.settle();
    expect(await shows(ui, /^build the thing$/)).toBe(true);
    expect(await shows(ui, /^Pineapple, noted\.$/)).toBe(true);
    await ui.unmount();
  });

  test('a reopened chat with the buddy hidden still draws its memory into the drawer: the load never waits on a greeting', async ($, on) => {
    const w = world(on, { character: 'fixy', hidden: true, [`chatTurnsToRead:${SESSION}`]: { at: 1, blocks: [{ turnId: 'old', at: 1, turn: { prompt: 'build the thing', answer: 'Built.' }, characters: { fixy: [{ kind: 'question', question: 'remember pineapple', answer: 'Pineapple, noted.' }] } }] } });
    await $.session.start(START);
    await w.clock.settle();
    await $.command.run(run(''));
    await w.clock.settle();
    const ui = await band($, { bodyColumns: 140, maxRows: 40 });
    expect(await shows(ui, /^build the thing$/)).toBe(true);
    expect(await shows(ui, /^Pineapple, noted\.$/)).toBe(true);
    await ui.unmount();
  });

  test('every model call logs call.cost: its tokens, its price in dollars, and how much of the turns its memory kept and cut', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    await $.turn.start({ text: 'p'.repeat(20_000), turnId: 't1' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    const cost = records(w).filter((r) => r.event === 'call.cost');
    expect(cost).toHaveLength(1);
    // usd: opus lists $4 in and $20 out per million tokens, and the mock call spent one token each way.
    expect(cost[0]).toMatchObject({ kind: 'endOfTurn', outcome: 'answered', inTok: 1, outTok: 1, usd: (4 + 20) / 1e6, memTurns: 1, memFull: 20_005, memKept: 4800 + 2400 + 7 + 5 });
  });

  test('a call on a model with no price logs call.cost with no usd at all: never 0, never null', { options: { model: 'gpt-x' } }, async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    await $.turn.start({ text: 'hello', turnId: 't1' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    const cost = records(w).filter((r) => r.event === 'call.cost');
    expect(cost).toHaveLength(1);
    expect(cost[0]).toMatchObject({ kind: 'endOfTurn', outcome: 'answered', model: 'gpt-x', inTok: 1, outTok: 1 });
    expect('usd' in cost[0]!).toBe(false);
  });
});

describe("a turn's numbers", () => {
  test("a shell command's own edits count: the files it names are read before and after it runs, only a real change counted; a subagent's never measured", async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Counted.\nSUGGEST_NEXT_PROMPT: NONE' } }, { files: { [`${ROOT}/src/a.ts`]: 'one\ntwo\n', [`${ROOT}/README.md`]: 'same\n' } });
    on('tool.call', async (_$, e) => {
      const c = e as { command?: string; agentId?: string };
      if (c.command?.startsWith('sed')) {
        w.files[`${ROOT}/src/a.ts`] = 'one\n2\nthree\n';
        w.files[`${ROOT}/notes.txt`] = 'x\ny\n';
      }
      if (c.agentId) w.files[`${ROOT}/README.md`] = 'changed by a subagent\n';
      return { result: { stdout: '' }, text: '', isError: false } as never;
    });
    await $.session.start(START);
    await prompt($, 'fix it', 't1');
    await $.tool.call({ tool: 'Bash', command: "sed -i '' s/two/2/ src/a.ts && printf 'x\\ny\\n' > notes.txt && cat README.md" } as never);
    await $.tool.call({ tool: 'Bash', command: 'echo more >> README.md', agentId: 'sub1' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'Fixed.', isAborted: false, turnId: 't1', durationMs: 5_000 } as never);
    await w.clock.settle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filed = (memory(w) as any).blocks.find((b: { turnId?: string }) => b.turnId === 't1').turn.stats;
    expect(filed).toMatchObject({ files: { read: 0, edited: 1, wrote: 1 }, lines: { added: 4, removed: 1 } });
    expect(w.completes[0]!.prompt).toContain('lines +4 −1');
  });
  test("a script's edits count too: a tree sweep of the command's folders finds the files it changed without naming them, lines exact where read before, else unmeasured; dependencies and dot-folders never swept", async ($, on) => {
    const mtimes: Record<string, number> = {};
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Counted.\nSUGGEST_NEXT_PROMPT: NONE' } }, {
      files: { [`${ROOT}/fix.py`]: 'import pathlib\n', [`${ROOT}/src/calc.js`]: 'a\nb\n', [`${ROOT}/src/same.js`]: 'k\n', [`${ROOT}/logo.png`]: '\u0000PNG1', [`${ROOT}/node_modules/x/index.js`]: 'q\n', [`${ROOT}/.cache/t.txt`]: 'q\n' },
      mtimes,
    });
    on('tool.call', async (_$, e) => {
      if ((e as { command?: string }).command === 'python3 fix.py') {
        w.files[`${ROOT}/src/calc.js`] = 'a\nB\n';
        mtimes[`${ROOT}/src/calc.js`] = 5;
        mtimes[`${ROOT}/src/same.js`] = 7;
        w.files[`${ROOT}/src/out.js`] = 'x\ny\nz\n';
        w.files[`${ROOT}/logo.png`] = '\u0000PNG22';
        w.files[`${ROOT}/node_modules/x/index.js`] = 'Q\n';
        w.files[`${ROOT}/.cache/t.txt`] = 'Q\n';
      }
      return { result: { stdout: '' }, text: '', isError: false } as never;
    });
    await $.session.start(START);
    await prompt($, 'rename it', 't1');
    await $.tool.call({ tool: 'Bash', command: 'python3 fix.py' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'Renamed.', isAborted: false, turnId: 't1', durationMs: 5_000 } as never);
    await w.clock.settle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filed = (memory(w) as any).blocks.find((b: { turnId?: string }) => b.turnId === 't1').turn.stats;
    expect(filed).toMatchObject({ files: { read: 0, edited: 2, wrote: 1 }, lines: { added: 4, removed: 1, unmeasured: 1 } });
    expect(w.completes[0]!.prompt).toContain('lines +4 −1, unmeasured in 1 file');
  });
  test('counted as the turn runs, filed with it in memory.json, read by the end-of-turn call under what Claude did, and shown in brief on its row in the drawer', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Counted.\nSUGGEST_NEXT_PROMPT: NONE' } });
    let usageReads = 0;
    on('session.usage', async () => {
      usageReads++;
      return { value: usageReads === 1
        ? { startedAt: 0, context: { tokens: 20_000, window: 200_000 }, rateLimits: [], cost: { usd: 1 } }
        : { startedAt: 0, context: { tokens: 50_000, window: 200_000, percent: 25 }, rateLimits: [{ kind: 'five_hour', percentUsed: 71 }], cost: { usd: 1.42 } } } as never;
    });
    on('turn.step', async function* (_$, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: e.index === 1 ? 'max_tokens' : 'tool_use', usage: null } as never;
    });
    on('tool.call', async (_$, e) => ((e as { command?: string }).command === 'npm test'
      ? { result: { stdout: 'Tests  3 passed (3)' }, text: 'Tests  3 passed (3)', isError: false }
      : { result: { stdout: 'ok' }, text: 'ok', isError: false }) as never);
    await $.session.start(START);
    const ui = await band($, { bodyColumns: 160, maxRows: 40 });
    await prompt($, 'ship it', 't1');
    for (const input of [{ turnId: 't1', index: 0, model: 'opus', effort: 'medium', messageCount: 1 }, { turnId: 't1', index: 1, model: 'opus', effort: 'medium', messageCount: 3 }, { turnId: 's1', index: 0, model: 'opus', messageCount: 1, agentId: 'sub1' }]) {
      const stream = $.turn.step(input as never);
      for (let s = await stream.next(); !s.done; s = await stream.next());
    }
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never);
    await $.tool.call({ tool: 'Edit', file_path: 'src/a.ts', old_string: 'x', new_string: 'y' } as never);
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "ship"' } as never);
    // A subagent's own work (a test run, an edit, a commit) is never the main turn's: the buddy sees only what the agent returns.
    await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'sub1' } as never);
    await $.tool.call({ tool: 'Edit', file_path: 'src/b.ts', old_string: 'x', new_string: 'y', agentId: 'sub1' } as never);
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "sub"', agentId: 'sub1' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'sub done', isAborted: false, turnId: 's1', agentId: 'sub1', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-5' } } as never);
    await $.turn.complete({ reason: 'answer', answer: 'Shipped.', isAborted: false, turnId: 't1', durationMs: 134_000, usage: { input_tokens: 1_000, output_tokens: 2_000, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 0, model: 'claude-opus-5' } } as never);
    await w.clock.settle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filed = (memory(w) as any).blocks.find((b: { turnId?: string }) => b.turnId === 't1').turn.stats;
    expect(filed).toMatchObject({
      ms: 134_000, requests: 2, tools: { Bash: 2, Edit: 1 }, files: { read: 0, edited: 1, wrote: 0 }, lines: { added: 1, removed: 1 },
      tests: { passed: 1, failed: 0, seq: 'p' }, git: { commits: 1, pushes: 0 }, stops: { maxTokens: 1, contextFull: 0 }, tokens: { in: 1_000, out: 2_000, cacheRead: 9_000, cacheWrite: 0 },
      model: 'claude-opus-5', effort: 'medium', context: { percent: 25, window: 200_000 }, limits: { fiveHour: 71 },
    });
    expect(filed.agents).toBeUndefined();
    expect(filed.usd.toFixed(2)).toBe('0.42');
    expect(usageReads).toBe(2);
    expect(withoutSizes(w.completes[0]!.prompt)).toContain(
      'Turn 1. The user asked Claude:\nsuggested: none\nsent: ship it\nClaude did: ran npm test; edited a.ts; ran git commit -m "ship"\n' +
        'Numbers: 2m14s · 2 model requests · 3 tool calls (Bash 2, Edit 1) · files 1 edited · lines +1 −1 · test runs 1 passed · 1 commit · ' +
        'cut at max tokens 1× · tokens 10k in (90% cached), 2k out · $0.42 · context 25% full of 200k · 5-hour limit 71% used · on opus-5 at medium effort\nClaude answered:\nShipped.',
    );
    expect(w.completes[0]!.prompt.endsWith(`\n\n${JUST_ENDED}`)).toBe(true);
    expect(records(w).find((r) => r.event === 'turn.numbers')).toMatchObject({ ms: 134_000, requests: 2, tools: 3, context: 25 });
    expect(records(w).find((r) => r.event === 'turn.numbers')).not.toHaveProperty('agentRuns');
    await $.command.run(run(''));
    await w.clock.settle();
    expect(JSON.stringify(await ui.drawn())).toContain('2m14s · 3 tools · $0.42');
    // A subagent still running after the turn ended counts toward no turn.
    await $.tool.call({ tool: 'Grep', pattern: 'late', agentId: 'sub2' } as never);
    await prompt($, 'next', 't2');
    await $.turn.complete({ reason: 'answer', answer: 'Next.', isAborted: false, turnId: 't2', durationMs: 1_000 } as never);
    await w.clock.settle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = (memory(w) as any).blocks.find((b: { turnId?: string }) => b.turnId === 't2').turn.stats;
    expect(second.agents).toBeUndefined();
    expect(typeof second.gapMs).toBe('number');
    // The kit has no ui.scroll for the open drawer; nothing else failed.
    expect(w.logs.filter((l) => /failed:/.test(l) && !/no implementation for ui\.scroll/.test(l))).toEqual([]);
    await ui.unmount();
  });

  test("a session usage that comes back malformed is said once: the turn is still filed, with its numbers and without the cost, context and limits", async ($, on) => {
    const w = world(on, { character: 'fixy' });
    on('session.usage', async () => ({ value: 'offline' }) as never);
    await $.session.start(START);
    const ui = await band($);
    for (const n of [1, 2]) {
      await prompt($, `ask ${n}`, `t${n}`);
      await $.turn.complete({ reason: 'answer', answer: `reply ${n}`, isAborted: false, turnId: `t${n}`, durationMs: 5_000 } as never);
      await w.clock.settle();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = (memory(w) as any).blocks.filter((b: { turn?: unknown }) => b.turn).map((b: { turn: { stats: unknown } }) => b.turn.stats);
    expect(stats).toHaveLength(2);
    for (const s of stats) {
      expect(s.ms).toBe(5_000);
      expect(s.usd).toBeUndefined();
      expect(s.context).toBeUndefined();
    }
    expect(w.logs.filter((l) => /reading the session's usage at the turn's (start|end) failed: it came back as string, not the usage/.test(l))).toHaveLength(1);
    expect(records(w).filter((r) => r.event === "reading the session's usage at the turn's start" || r.event === "reading the session's usage at the turn's end").length).toBeGreaterThanOrEqual(4);
    await ui.unmount();
  });

  test('a session usage that never answers holds the turn USAGE_DEADLINE_MS at most: filed without the cost, the timeout logged', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    on('session.usage', () => new Promise(() => undefined) as never);
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'ask', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'reply', isAborted: false, turnId: 't1', durationMs: 7_000 } as never);
    await w.clock.advance(2_000);
    await w.clock.settle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((memory(w) as any).blocks.find((b: { turnId?: string }) => b.turnId === 't1').turn.stats).toEqual({ ms: 7_000 });
    expect(records(w).filter((r) => r.event === 'usage.read').map((r) => r.outcome)).toEqual(['timeout', 'timeout']);
    expect(w.completes).toHaveLength(1);
    await ui.unmount();
  });
});

/**
 * The kit loads the plugin under test with its manifest's defaults, so
 * promptToMainChat is on here unless a test gives `options`, and an inline
 * plugin cannot import buddy's code. What the kit shows: a plugin's own submission reaches its own prompt.submit hook
 * without the `{ kind: 'plugin', name }` origin the engine docs promise, so
 * buddy's hook, which knows its own prompt by that origin, is proven here on
 * a submission that carries it.
 */
const TO_CLAUDE = 'run the tests and show their output: you said they pass, and none ran';
const PROMPTS_CLAUDE = `VERDICT: SHORTCUT\nWHY: claimed green, ran nothing.\nCOMMENT_AFTER_EACH_TURN: Green, you say?\nPROMPT_TO_MAIN_CHAT: ${TO_CLAUDE}\nSUGGEST_NEXT_PROMPT: NONE`;
const asksToPrompt = (c: { system?: string }) => (c.system ?? '').includes('PROMPT_TO_MAIN_CHAT:');
/** A plugin that submits a prompt at every turn's end, a context given at the call, and whose own prompt.submit hook says what origin it saw. */
const SUBMITTER = {
  plugins: [
    {
      name: 'submitter',
      register(on: On) {
        on('turn.complete', async ($, e, next) => {
          const r = await next(e);
          void $.prompt.submit({ text: 'from the submitter', context: ['attached at the call'] } as never);
          return r;
        });
        on('prompt.submit', async ($, e, next) => {
          return next(e.text === 'from the submitter' ? { ...e, context: [...(e.context ?? []), `seen by its own hook: ${JSON.stringify({ origin: e.origin, self: $.plugin.name })}`] } : e);
        });
      },
    },
  ],
};

describe('promptToMainChat', () => {
  test("the kit hands a plugin's own $.prompt.submit to its own prompt.submit hook with that plugin as its origin, and drops a context given at the call", SUBMITTER, async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.submitted.filter((x) => x.text === 'from the submitter')).toEqual([{ text: 'from the submitter', context: ['seen by its own hook: {"origin":{"kind":"plugin","name":"submitter"},"self":"submitter"}'] }]);
  });
  test("buddy's own prompt carries, for Claude alone, whose it is; another plugin's does not; the turn it starts is filed as the buddy's own", async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Hm.\nSUGGEST_NEXT_PROMPT: NONE' } });
    await $.session.start(START);
    await $.prompt.submit({ text: 'from another plugin', origin: { kind: 'plugin', name: 'another' } } as never);
    expect(w.submitted.at(-1)).toEqual({ text: 'from another plugin' });
    await $.prompt.submit({ text: TO_CLAUDE, origin: { kind: 'plugin', name: 'buddy' } } as never);
    expect(w.submitted.at(-1)).toEqual({ text: TO_CLAUDE, context: [BUDDY_PROMPT_CONTEXT] });
    await $.turn.start({ text: TO_CLAUDE, turnId: 't2' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'Ran them: two fail.', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    expect(w.completes.at(-1)!.prompt).toContain(`From the buddy (you), sent to Claude:\n${TO_CLAUDE}\n`);
  });
  test('on: the prompt the buddy sent Claude shows in the bubble in yellow, addressed to Claude, once the turn\'s own bubble has had its 10 s', { options: { promptToMainChat: true } }, async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: PROMPTS_CLAUDE } });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'fix the login bug', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'Fixed; the tests pass.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.submitted.map((x) => x.text)).toEqual(['fix the login bug', TO_CLAUDE]);
    // The turn's warning, to the user, keeps the bubble first: the steer waits its turn, never dropped.
    expect((await bubbleText(ui, /claimed green, ran nothing/))?.props.color).toBe('blue');
    expect(await shows(ui, /run the tests and show their output/)).toBe(false);
    await w.clock.advance(10_200);
    await w.clock.settle();
    const steer = await ui.find({ type: 'Text', text: /run the tests and show their output/ });
    expect(steer?.props.color).toBe('yellow');
    expect(steer?.props.italic).toBe(true);
    // A plain frame: the yellow words, not the frame, tell a steer from a SHORTCUT warning.
    expect((await ui.find({ type: 'Box', key: 'bubble' }))?.props.borderColor).toBeUndefined();
    await ui.unmount();
  });
  test('off: no PROMPT_TO_MAIN_CHAT line is asked for and nothing is sent, though the reply writes one', { options: { promptToMainChat: false } }, async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: PROMPTS_CLAUDE } });
    await $.session.start(START);
    await prompt($, 'fix the login bug', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'Fixed; the tests pass.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.completes).toHaveLength(1);
    expect(w.completes.filter(asksToPrompt)).toHaveLength(0);
    expect(w.submitted).toEqual([{ text: 'fix the login bug' }]);
    expect(records(w).filter((r) => r.event === 'promptToMainChat.sent')).toHaveLength(0);
  });

  /** memory.json holding the user's rule `rule.main-safe` and a fact, and `strikes` when given. */
  const ruled = (extra: object = {}, items: object = { 'rule.main-safe': RULE, 'fact.kept': { text: 'Kept.', from: 'shown', turn: 0, at: 0 } }) => ({
    files: { [`${chatDir()}/memory.json`]: JSON.stringify({ version: 2, at: 0, turnNo: 0, blocks: [], items, ended: {}, ...extra }) },
  });
  const RULE = { words: 'keep main safe', covers: 'the repo', from: 'user', turn: 0, at: 0 };
  const RULES = `${RULES_CONTEXT_HEAD}\n- "keep main safe" (the buddy's reading: covers the repo)`;
  const STEER = 'Keep main safe: you pushed.';
  const BROKE = `COMMENT_AFTER_EACH_TURN: Pushed again?\nPROMPT_TO_MAIN_CHAT: ${STEER}\nRULE_BROKEN: rule.main-safe`;
  const QUIET = 'COMMENT_AFTER_EACH_TURN: Hm.\nPROMPT_TO_MAIN_CHAT: NONE\nRULE_BROKEN: NONE';
  const PEER = { kind: 'plugin', name: 'another' };
  /** What the buddy submitted itself: every submission but the user's and a peer's. */
  const steers = (w: { submitted: { text: string }[] }, mine: readonly string[]) => w.submitted.map((x) => x.text).filter((t) => !mine.includes(t));

  test("on: the user's live rules ride every prompt, the user's, a peer's and the buddy's own after its context; none before the memory is loaded", { options: { promptToMainChat: true } }, async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, ruled());
    w.slow.chatTurnsToReadGetMs = 1_000;
    await $.session.start(START);
    await $.prompt.submit({ text: 'too early', origin: { kind: 'composer' } } as never);
    expect(w.submitted.at(-1)).toEqual({ text: 'too early' });
    await w.clock.advance(1_100);
    await w.clock.settle();
    await $.prompt.submit({ text: 'fix the login bug', origin: { kind: 'composer' } } as never);
    expect(w.submitted.at(-1)).toEqual({ text: 'fix the login bug', context: [RULES] });
    await $.prompt.submit({ text: 'from another plugin', origin: PEER } as never);
    expect(w.submitted.at(-1)).toEqual({ text: 'from another plugin', context: [RULES] });
    await $.prompt.submit({ text: TO_CLAUDE, origin: { kind: 'plugin', name: 'buddy' } } as never);
    expect(w.submitted.at(-1)).toEqual({ text: TO_CLAUDE, context: [BUDDY_PROMPT_CONTEXT, RULES] });
  });
  test('off: a live rule rides no prompt', { options: { promptToMainChat: false } }, async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, ruled());
    await $.session.start(START);
    await w.clock.settle();
    await $.prompt.submit({ text: 'fix the login bug', origin: { kind: 'composer' } } as never);
    await $.prompt.submit({ text: 'from another plugin', origin: PEER } as never);
    expect(w.submitted).toEqual([{ text: 'fix the login bug' }, { text: 'from another plugin' }]);
  });
  test('on with no live rule: the context is as before', { options: { promptToMainChat: true } }, async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, ruled({}, { 'fact.kept': { text: 'Kept.', from: 'shown', turn: 0, at: 0 } }));
    await $.session.start(START);
    await w.clock.settle();
    await $.prompt.submit({ text: 'fix the login bug', origin: { kind: 'composer' } } as never);
    await $.prompt.submit({ text: TO_CLAUDE, origin: { kind: 'plugin', name: 'buddy' } } as never);
    expect(w.submitted).toEqual([{ text: 'fix the login bug' }, { text: TO_CLAUDE, context: [BUDDY_PROMPT_CONTEXT] }]);
  });
  test('the ladder: a rule broken again is sent, then sent again, then warned of in the bubble instead; each strike logged and kept', { options: { promptToMainChat: true } }, async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: BROKE } }, ruled());
    await $.session.start(START);
    const ui = await band($);
    await w.clock.settle();
    const mine = ['push it 1', 'push it 2', 'push it 3'];
    for (const [i, text] of mine.entries()) {
      await prompt($, text, `t${i + 1}`);
      await $.turn.complete({ reason: 'answer', answer: 'Pushed.', isAborted: false, turnId: `t${i + 1}` } as never);
      await w.clock.settle();
      if (i < 2) {
        await w.clock.advance(20_000);
        await w.clock.settle();
      }
    }
    expect(steers(w, mine)).toEqual([STEER, `Again: ${STEER}`]);
    const warning = await bubbleText(ui, /Claude broke your rule again: "keep main safe"/);
    expect(warning).toBeDefined();
    expect((await ui.find({ type: 'Box', key: 'bubble' }))?.props.borderColor).toBe('yellow');
    expect(records(w).filter((r) => r.event === 'rule.strike').map((r) => [r.key, r.count, r.step])).toEqual([['rule.main-safe', 1, 'prompt'], ['rule.main-safe', 2, 'again'], ['rule.main-safe', 3, 'warn']]);
    expect((memory(w) as { strikes: object }).strikes).toEqual({ 'rule.main-safe': 3 });
    expect(ring(w, 'fixy').at(-1)).toMatchObject({ kind: 'endOfTurn', warned: 'Claude broke your rule again: "keep main safe"' });
    await ui.unmount();
  });
  test("the ladder's first strike with no prompt of the buddy's: the rule's own is sent", { options: { promptToMainChat: true } }, async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'PROMPT_TO_MAIN_CHAT: NONE\nRULE_BROKEN: rule.main-safe' } }, ruled());
    await $.session.start(START);
    await w.clock.settle();
    await prompt($, 'push it', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'Pushed.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(steers(w, ['push it'])).toEqual(['The user\'s rule, in their words: "keep main safe" (the buddy\'s reading: covers the repo). This turn did not follow it.']);
  });
  test('a rule ended by a MEMORY op takes its strikes with it, and naming it later strikes nothing', { options: { promptToMainChat: true } }, async ($, on) => {
    const ended = 'COMMENT_AFTER_EACH_TURN: Hm.\nPROMPT_TO_MAIN_CHAT: NONE\nMEMORY: {"rule.main-safe": {"end": "lifted: the user lifted it"}}';
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: ended }, { isAnswered: true, text: BROKE }] }, ruled({ strikes: { 'rule.main-safe': 2 } }));
    await $.session.start(START);
    await w.clock.settle();
    await prompt($, 'you may push now', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'Noted.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect((memory(w) as { strikes: object }).strikes).toEqual({});
    await prompt($, 'push it', 't2');
    await $.turn.complete({ reason: 'answer', answer: 'Pushed.', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    expect(records(w).filter((r) => r.event === 'rule.strike')).toEqual([]);
    expect(steers(w, ['you may push now', 'push it'])).toEqual([STEER]);
    expect((memory(w) as { strikes: object }).strikes).toEqual({});
  });
  test('a stale reply naming a broken rule still counts its strike, though its prompt is never sent', { options: { promptToMainChat: true } }, async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: BROKE, delayMs: 5_000 }, { isAnswered: true, text: QUIET }] }, ruled());
    await $.session.start(START);
    await w.clock.settle();
    await prompt($, 'push it', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'Pushed.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    await prompt($, 'next thing', 't2');
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    await w.clock.advance(5_100);
    await w.clock.settle();
    expect(steers(w, ['push it', 'next thing'])).toEqual([]);
    expect(records(w).filter((r) => r.event === 'rule.strike').map((r) => [r.key, r.count, r.step])).toEqual([['rule.main-safe', 1, 'prompt']]);
    expect((memory(w) as { strikes: object }).strikes).toEqual({ 'rule.main-safe': 1 });
  });
  test("moved on: a peer's turn started and ended while the call ran, so its prompt is never sent, and remembered unsent", { options: { promptToMainChat: true } }, async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: PROMPTS_CLAUDE, delayMs: 5_000 }, { isAnswered: true, text: QUIET }] });
    await $.session.start(START);
    await w.clock.settle();
    await prompt($, 'fix the login bug', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'Fixed.', isAborted: false, turnId: 't1' } as never);
    await $.prompt.submit({ text: 'from another plugin', origin: PEER } as never);
    await $.turn.start({ text: 'from another plugin', turnId: 't2' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't2' } as never);
    await w.clock.advance(5_100);
    await w.clock.settle();
    expect(steers(w, ['fix the login bug', 'from another plugin'])).toEqual([]);
    expect(records(w).filter((r) => r.event === 'promptToMainChat.movedOn')).toHaveLength(1);
    expect(ring(w, 'fixy')).toContainEqual({ kind: 'endOfTurn', unsentPrompt: TO_CLAUDE });
  });
  test('a main turn running when the reply comes: as moved on', { options: { promptToMainChat: true } }, async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: `PROMPT_TO_MAIN_CHAT: ${TO_CLAUDE}`, delayMs: 5_000 }] });
    await $.session.start(START);
    await w.clock.settle();
    await prompt($, 'fix the login bug', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'Fixed.', isAborted: false, turnId: 't1' } as never);
    await $.prompt.submit({ text: 'from another plugin', origin: PEER } as never);
    await $.turn.start({ text: 'from another plugin', turnId: 't2' } as never);
    await w.clock.advance(5_100);
    await w.clock.settle();
    expect(steers(w, ['fix the login bug', 'from another plugin'])).toEqual([]);
    expect(records(w).filter((r) => r.event === 'promptToMainChat.movedOn')).toHaveLength(1);
    expect(ring(w, 'fixy')).toContainEqual({ kind: 'endOfTurn', unsentPrompt: TO_CLAUDE });
  });
  test('the user prompted while the call ran: nothing sent, logged stale, and remembered unsent', { options: { promptToMainChat: true } }, async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: `PROMPT_TO_MAIN_CHAT: ${TO_CLAUDE}`, delayMs: 5_000 }] });
    await $.session.start(START);
    await w.clock.settle();
    await prompt($, 'fix the login bug', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'Fixed.', isAborted: false, turnId: 't1' } as never);
    await prompt($, 'and the signup one', 't2');
    await w.clock.advance(5_100);
    await w.clock.settle();
    expect(steers(w, ['fix the login bug', 'and the signup one'])).toEqual([]);
    expect(records(w).filter((r) => r.event === 'promptToMainChat.stale')).toHaveLength(1);
    expect(records(w).filter((r) => r.event === 'promptToMainChat.movedOn')).toHaveLength(0);
    expect(ring(w, 'fixy')).toContainEqual({ kind: 'endOfTurn', unsentPrompt: TO_CLAUDE });
  });
  test('a strike that cannot be saved is said, and the comment still shows', { options: { promptToMainChat: true } }, async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: BROKE } }, { ...ruled(), refuseMemory: true });
    await $.session.start(START);
    const ui = await band($);
    await w.clock.settle();
    await prompt($, 'push it', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'Pushed.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.logs.some((l) => /^buddy: remembering the strike failed: .+/.test(l))).toBe(true);
    expect(await bubbleText(ui, /Pushed again\?/)).toBeDefined();
    await ui.unmount();
  });
});

describe('a turn whose prompt the ledger lost (a hot reload empties it)', () => {
  /** The transcript of the turn: its prompt, a tool call and its result, local command output filed as the user's, the answer. */
  const rows = [
    { role: 'user', text: 'an earlier ask', toolUses: [] },
    { role: 'assistant', text: 'Earlier.', toolUses: [] },
    { role: 'user', text: 'fix the flaky test', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Bash', input: { command: 'npm test', description: 'Run the tests' }, text: 'ok' }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u1', text: 'ok', isError: false }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u2', tool: 'Bash', input: { command: 'npm run lint', description: 'Run the linter' }, text: 'Exit code 1\nlint: 3 errors', isError: true }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u2', text: 'Exit code 1\nlint: 3 errors', isError: true }] },
    { role: 'user', text: '<local-command-caveat>Caveat: the messages below were generated by a local command.</local-command-caveat>', toolUses: [] },
    { role: 'assistant', text: 'Fixed.', toolUses: [] },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lastTurn = (w: { files: Record<string, string> }): any => (memory(w) as { blocks: { turn?: unknown }[] }).blocks.at(-1)!.turn;

  test('is filed with the last prompt the transcript holds, neither a tool result nor command output, its origin still unknown, and the steps the transcript holds after it', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { messages: rows });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Fixed.', isAborted: false, turnId: 'lost' } as never);
    await w.clock.settle();
    expect(lastTurn(w)).toMatchObject({ prompt: 'fix the flaky test', from: 'unknown', did: ['Run the tests', expect.stringMatching(/^Run the linter \(failed: .*3 errors/)] });
    expect(records(w).find((r) => r.event === 'prompt.backfill')).toMatchObject({ outcome: 'found', turnId: 'lost', steps: 2 });
    // A turn whose prompt the ledger holds never reads the transcript.
    const reads = w.messageReads.length;
    await prompt($, 'the next ask', 't2');
    await $.turn.complete({ reason: 'answer', answer: 'Next.', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    expect(w.messageReads).toHaveLength(reads);
    expect(lastTurn(w)).toMatchObject({ prompt: 'the next ask' });
    await ui.unmount();
  });

  test('none there: the turn stays unseen, and the log says the transcript was read and held none', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { messages: rows.slice(3) });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Fixed.', isAborted: false, turnId: 'lost' } as never);
    await w.clock.settle();
    expect(lastTurn(w)).toMatchObject({ prompt: '', from: 'unknown' });
    expect(records(w).find((r) => r.event === 'prompt.backfill')).toMatchObject({ outcome: 'none', turnId: 'lost', rows: 6 });
    await ui.unmount();
  });

  test('a failed read: the turn stays unseen, and the failure is said and logged with its turn, never read as none there', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { messages: new Error('transcript unreadable') });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Fixed.', isAborted: false, turnId: 'lost' } as never);
    await w.clock.settle();
    expect(lastTurn(w)).toMatchObject({ prompt: '', from: 'unknown' });
    const failure = records(w).find((r) => r.level === 'error' && r.event === 'reading the transcript for a lost prompt');
    // A thrown answer reaches the plugin as the kit's own rejection, not this message.
    expect(failure).toMatchObject({ turnId: 'lost', error: { message: expect.stringContaining('session.messages') } });
    expect(records(w).find((r) => r.event === 'prompt.backfill')).toBeUndefined();
    expect(w.logs.some((l) => l.includes('reading the transcript for a lost prompt failed:'))).toBe(true);
    await ui.unmount();
  });
});

describe('promptWhenIdle', () => {
  /** Half an hour of the band's clock is thousands of ticks: each test has time for its stretches. */
  const SLOW = { timeoutMs: 60_000 };
  /** On, with no end-of-turn call: every completion is the away call's. */
  const ON = { ...SLOW, options: { promptWhenIdle: true, commentAfterEachTurn: false, suggestNextPrompt: false, promptToMainChat: false } };
  /** A character whose clock ticks as seldom as a character may (stepMs 1000), so 30 minutes pass in 1800 ticks. */
  const SLOW_FIXTURE = { builtins: { 'idler.json': JSON.stringify({ ...JSON.parse(fixture('idler', 'Idler', 'i_i')), motion: { restChance: 0, stepMs: 1000 } }) } };
  const PUSHED = 'Run the remaining replay and report.';
  const away = <C extends { system?: string }>(w: { completes: C[] }) => w.completes.filter((c) => c.system === AWAY_SYSTEM);
  const events = (w: { files: Record<string, string> }, event: string) => records(w).filter((r) => r.event === event);
  /** A main turn `turnId` answered `answer`, started by the user's prompt `text`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const answered = async ($: any, text: string, turnId: string, answer = 'A') => {
    await prompt($, text, turnId);
    await $.turn.complete({ reason: 'answer', answer, isAborted: false, turnId } as never);
  };
  const idle = async (w: { clock: { advance: (ms: number) => Promise<void>; settle: () => Promise<void> } }, ms = AWAY_IDLE_MS) => {
    await w.clock.advance(ms);
    await w.clock.settle();
  };

  test('off (the default): a turn ends and 31 minutes pass, and no away call is made', SLOW, async ($, on) => {
    const w = world(on, { character: 'idler' }, {}, SLOW_FIXTURE);
    await $.session.start(START);
    await answered($, 'fix it', 't1');
    await idle(w, 31 * 60_000);
    expect(away(w)).toEqual([]);
    expect(records(w).filter((r) => String(r.event).startsWith('away.'))).toEqual([]);
  });

  test('pause: 30 idle minutes after an answered turn, one call on opus low with its own system and the answer verbatim; the end-of-turn call stays its own; nothing sent', { ...SLOW, options: { promptWhenIdle: true } }, async ($, on) => {
    const w = world(on, { character: 'idler' }, { queue: [{ isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Hm.\nSUGGEST_NEXT_PROMPT: NONE' }, { isAnswered: true, text: 'PAUSE' }] }, SLOW_FIXTURE);
    await $.session.start(START);
    await answered($, 'fix it', 't1');
    await w.clock.settle();
    expect(w.completes).toHaveLength(1);
    await idle(w, AWAY_IDLE_MS - 1_000);
    expect(away(w)).toEqual([]);
    await idle(w, 1_000);
    expect(away(w)).toEqual([{ model: 'opus', effort: 'low', system: AWAY_SYSTEM, prompt: awayBody('A'), timeoutMs: 30_000 }]);
    // The user's prompt, the persona and the end-of-turn tags never reach it.
    expect(away(w)[0]!.prompt).not.toContain('fix it');
    expect(events(w, 'away.decision')).toMatchObject([{ decision: 'pause', length: 0 }]);
    expect(w.submitted.map((x) => x.text)).toEqual(['fix it']);
  });

  test('once per stretch: a PAUSE, then 60 more idle minutes, and still one call', ON, async ($, on) => {
    const w = world(on, { character: 'idler' }, { complete: { isAnswered: true, text: 'PAUSE' } }, SLOW_FIXTURE);
    await $.session.start(START);
    await answered($, 'fix it', 't1');
    await idle(w);
    await idle(w, 60 * 60_000);
    expect(away(w)).toHaveLength(1);
  });

  test("push: the line reaches Claude as the buddy's own prompt, shown as one sent, and the turn it starts is filed as the buddy's", ON, async ($, on) => {
    const w = world(on, { character: 'idler' }, { complete: { isAnswered: true, text: `PUSH: ${PUSHED}` } }, SLOW_FIXTURE);
    await $.session.start(START);
    const ui = await band($);
    await answered($, 'replay the captured calls', 't1', 'Replayed 10 of 20; continuing.');
    await idle(w);
    expect(away(w)[0]!.prompt).toBe(awayBody('Replayed 10 of 20; continuing.'));
    expect(w.submitted.map((x) => x.text)).toEqual(['replay the captured calls', PUSHED]);
    expect(events(w, 'away.decision')).toMatchObject([{ decision: 'push', length: PUSHED.length }]);
    expect((await bubbleText(ui, /Run the remaining replay/))?.props.color).toBe('yellow');
    // The kit hands a plugin's own submission beneath its own hook (see the note above describe('promptToMainChat')): the engine's delivery of it, with its origin, is replayed here.
    await $.prompt.submit({ text: PUSHED, origin: { kind: 'plugin', name: 'buddy' } } as never);
    expect(w.submitted.at(-1)).toEqual({ text: PUSHED, context: [BUDDY_PROMPT_CONTEXT] });
    await $.turn.start({ text: PUSHED, turnId: 't2' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'Replayed all 20.', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((memory(w) as any).blocks.find((b: { turnId?: string }) => b.turnId === 't2').turn).toMatchObject({ prompt: PUSHED, from: BUDDY_PROMPT });
    await ui.unmount();
  });

  test('a malformed or refused reply sends nothing, and is logged as such', ON, async ($, on) => {
    const w = world(on, { character: 'idler' }, { queue: [{ isAnswered: true, text: 'PAUSE because the request is finished' }, { isAnswered: true, text: 'PUSH: git push the branch' }] }, SLOW_FIXTURE);
    await $.session.start(START);
    await answered($, 'fix it', 't1');
    await idle(w);
    await answered($, 'and the next', 't2');
    await idle(w);
    expect(away(w)).toHaveLength(2);
    expect(events(w, 'away.decision').map((r) => r.decision)).toEqual(['malformed', 'refused']);
    expect(w.submitted.map((x) => x.text)).toEqual(['fix it', 'and the next']);
  });

  test('a prompt within the 30 minutes: no away call for that stretch', ON, async ($, on) => {
    const w = world(on, { character: 'idler' }, { complete: { isAnswered: true, text: `PUSH: ${PUSHED}` } }, SLOW_FIXTURE);
    await $.session.start(START);
    await answered($, 'fix it', 't1');
    await idle(w, 20 * 60_000);
    await prompt($, 'one more thing', 't2');
    await idle(w, 15 * 60_000);
    expect(away(w)).toEqual([]);
  });

  test('stale: the user prompts while the call is in flight, so nothing is sent, logged stale', ON, async ($, on) => {
    const w = world(on, { character: 'idler' }, { complete: { isAnswered: true, text: `PUSH: ${PUSHED}`, delayMs: 5_000 } }, SLOW_FIXTURE);
    await $.session.start(START);
    await answered($, 'fix it', 't1');
    await idle(w);
    expect(away(w)).toHaveLength(1);
    await prompt($, 'back now', 't2');
    await idle(w, 5_100);
    expect(w.submitted.map((x) => x.text)).toEqual(['fix it', 'back now']);
    expect(events(w, 'away.stale')).toHaveLength(1);
    expect(events(w, 'away.decision')).toEqual([]);
  });

  test('off while the call is in flight: the buddy hidden meanwhile sends nothing, logged stale', ON, async ($, on) => {
    const w = world(on, { character: 'idler' }, { complete: { isAnswered: true, text: `PUSH: ${PUSHED}`, delayMs: 5_000 } }, SLOW_FIXTURE);
    await $.session.start(START);
    await answered($, 'fix it', 't1');
    await idle(w);
    expect(away(w)).toHaveLength(1);
    await $.command.run(run('off'));
    await idle(w, 5_100);
    expect(w.submitted.map((x) => x.text)).toEqual(['fix it']);
    expect(events(w, 'away.stale')).toMatchObject([{ reason: 'the buddy is off' }]);
    expect(events(w, 'away.decision')).toEqual([]);
  });

  test('a cut last turn arms no call: interrupted, errored, refused or with no answer, each skipped with its reason', ON, async ($, on) => {
    const w = world(on, { character: 'idler' }, {}, SLOW_FIXTURE);
    await $.session.start(START);
    const ends = [
      { reason: 'aborted', answer: 'Half.', isAborted: true },
      { reason: 'error', answer: 'Half.', isAborted: false },
      { reason: 'refusal', answer: 'No.', isAborted: false },
      { reason: 'answer', answer: '  ', isAborted: false },
    ];
    for (const [n, end] of ends.entries()) {
      await prompt($, `ask ${n}`, `t${n}`);
      await $.turn.complete({ ...end, turnId: `t${n}` } as never);
    }
    await idle(w, 31 * 60_000);
    expect(away(w)).toEqual([]);
    expect(events(w, 'away.skipped').map((r) => r.reason)).toEqual(['the turn was interrupted', 'the turn ended in an error', 'the model refused', 'no answer']);
  });

  test('the push cap: three pushes, each starting a turn that idles, and the fourth stretch makes no call; a user prompt resets the count', ON, async ($, on) => {
    const w = world(on, { character: 'idler' }, { complete: { isAnswered: true, text: `PUSH: ${PUSHED}` } }, SLOW_FIXTURE);
    await $.session.start(START);
    await answered($, 'replay them all', 't0');
    for (const n of [1, 2, 3, 4]) {
      await idle(w);
      await $.turn.start({ text: PUSHED, turnId: `p${n}` } as never);
      await $.turn.complete({ reason: 'answer', answer: `Replayed batch ${n}.`, isAborted: false, turnId: `p${n}` } as never);
    }
    expect(away(w)).toHaveLength(3);
    expect(w.submitted.filter((x) => x.text === PUSHED)).toHaveLength(3);
    expect(events(w, 'away.skipped').map((r) => r.reason)).toEqual(['3 pushes without a user prompt']);
    await answered($, 'keep going', 'u1');
    await idle(w);
    expect(away(w)).toHaveLength(4);
  });

  /** A kept wait, as the adapter writes it beside the memory. The kit's clock answers `$.clock` only: the adapter's Date.now() is the real one, and so is this. */
  const kept = (wait: { at: number; answer: string } | null, pushes = 0) => ({ files: { [`${chatDir()}/away.json`]: JSON.stringify({ version: 1, wait, pushes }) } });

  test('the wait is kept beside the memory: an answered turn writes it, the next prompt clears it', ON, async ($, on) => {
    const w = world(on, { character: 'idler' }, {}, SLOW_FIXTURE);
    await $.session.start(START);
    await answered($, 'fix it', 't1');
    await w.clock.settle();
    expect(JSON.parse(w.files[`${chatDir()}/away.json`]!)).toMatchObject({ version: 1, wait: { at: expect.any(Number), answer: 'A' }, pushes: 0 });
    await prompt($, 'one more thing', 't2');
    await w.clock.settle();
    expect(JSON.parse(w.files[`${chatDir()}/away.json`]!)).toEqual({ version: 1, wait: null, pushes: 0 });
  });

  test('a reload re-arms a kept wait for what remains of the 30 minutes', ON, async ($, on) => {
    const w = world(on, { character: 'idler' }, { complete: { isAnswered: true, text: 'PAUSE' } }, { ...SLOW_FIXTURE, ...kept({ at: Date.now() - 20 * 60_000, answer: 'Halfway; continuing.' }) });
    await $.session.start(START);
    await w.clock.settle();
    await idle(w, 10 * 60_000 - 5_000);
    expect(away(w)).toEqual([]);
    await idle(w, 10_000);
    expect(away(w)).toHaveLength(1);
    expect(away(w)[0]!.prompt).toBe(awayBody('Halfway; continuing.'));
    expect(events(w, 'away.rearm')).toMatchObject([{ outcome: 'armed' }]);
    // The wait is spent: the file says none, and more idle time makes no second call.
    expect(JSON.parse(w.files[`${chatDir()}/away.json`]!)).toMatchObject({ wait: null });
    await idle(w, 60 * 60_000);
    expect(away(w)).toHaveLength(1);
  });

  test('a kept wait past due fires 1 to 5 minutes after the load, never at once', ON, async ($, on) => {
    const w = world(on, { character: 'idler' }, { complete: { isAnswered: true, text: 'PAUSE' } }, { ...SLOW_FIXTURE, ...kept({ at: Date.now() - 90 * 60_000, answer: 'Long ago.' }) });
    await $.session.start(START);
    await w.clock.settle();
    expect(away(w)).toEqual([]);
    await idle(w, 59_000);
    expect(away(w)).toEqual([]);
    await idle(w, 4 * 60_000 + 5_000);
    expect(away(w)).toHaveLength(1);
    expect(away(w)[0]!.prompt).toBe(awayBody('Long ago.'));
  });

  test('a spent wait is never re-armed', ON, async ($, on) => {
    const w = world(on, { character: 'idler' }, { complete: { isAnswered: true, text: 'PAUSE' } }, { ...SLOW_FIXTURE, ...kept(null) });
    await $.session.start(START);
    await w.clock.settle();
    await idle(w, 31 * 60_000);
    expect(away(w)).toEqual([]);
    expect(events(w, 'away.rearm')).toMatchObject([{ outcome: 'none' }]);
  });

  test('a kept wait whose turn ended over 2 hours ago is dropped: never armed, its file left spent', ON, async ($, on) => {
    const w = world(on, { character: 'idler' }, { complete: { isAnswered: true, text: `PUSH: ${PUSHED}` } }, { ...SLOW_FIXTURE, ...kept({ at: Date.now() - 3 * 3_600_000, answer: 'Yesterday.' }) });
    await $.session.start(START);
    await w.clock.settle();
    await idle(w, 31 * 60_000);
    expect(away(w)).toEqual([]);
    expect(events(w, 'away.rearm')).toMatchObject([{ outcome: 'stale' }]);
    expect(JSON.parse(w.files[`${chatDir()}/away.json`]!)).toEqual({ version: 1, wait: null, pushes: 0 });
  });

  test('/clear during the wait: no call', ON, async ($, on) => {
    const w = world(on, { character: 'idler' }, { complete: { isAnswered: true, text: `PUSH: ${PUSHED}` } }, SLOW_FIXTURE);
    await $.session.start(START);
    await answered($, 'fix it', 't1');
    await idle(w, 10 * 60_000);
    await $.session.end({ reason: 'clear', sessionId: SESSION, resume: {} } as never);
    await idle(w, 30 * 60_000);
    expect(away(w)).toEqual([]);
  });

  test('the call is saved in the round file as an away call', ON, async ($, on) => {
    const w = world(on, { character: 'idler' }, { complete: { isAnswered: true, text: 'PAUSE' } }, SLOW_FIXTURE);
    await $.session.start(START);
    await answered($, 'fix it', 't1', 'All done here.');
    await idle(w);
    const rounds = Object.keys(w.files).filter((f) => f.endsWith('.txt'));
    const text = rounds.map((f) => w.files[f]!).find((t) => t.includes('· away call ·'));
    expect(text).toContain(AWAY_SYSTEM);
    expect(text).toContain(awayBody('All done here.'));
  });

  test('a call that throws is logged, sends nothing, and leaves the band drawn', ON, async ($, on) => {
    const w = world(on, { character: 'idler' }, { complete: { isAnswered: true, error: 'the model is down' } }, SLOW_FIXTURE);
    await $.session.start(START);
    const ui = await band($);
    await answered($, 'fix it', 't1');
    await idle(w);
    expect(w.logs.some((l) => /asking whether the idle chat needs a push failed: /.test(l))).toBe(true);
    expect(w.submitted.map((x) => x.text)).toEqual(['fix it']);
    expect(await shows(ui, /i_i/)).toBe(true);
    await ui.unmount();
  });
});


describe('a call a reload abandoned', () => {
  const callsFile = () => `${chatDir()}/calls.json`;
  const outcomes = (w: { files: Record<string, string> }) => records(w).filter((r) => r.event === 'call.outcome');
  const kept = (w: { files: Record<string, string> }) => JSON.parse(w.files[callsFile()]!);

  test('a call kept from before the load logs one abandoned outcome, and a second load logs none', async ($, on) => {
    // The kit's clock answers `$.clock` only: the adapter's Date.now() is the real one, and so is this.
    const at = Date.now() - 8_000;
    const w = world(on, {}, {}, { files: { [callsFile()]: JSON.stringify({ version: 1, calls: [{ id: 'old', kind: 'endOfTurn', at, turnId: 't9' }] }) } });
    await $.session.start(START);
    await w.clock.settle();
    expect(outcomes(w)).toMatchObject([{ outcome: 'abandoned', kind: 'endOfTurn', turnId: 't9' }]);
    expect(outcomes(w)[0].ms).toBeGreaterThanOrEqual(8_000);
    expect(kept(w)).toEqual({ version: 1, calls: [] });
    await $.session.start(START);
    await w.clock.settle();
    expect(outcomes(w)).toHaveLength(1);
  });

  test('an end-of-turn call is kept while it runs, never abandoned by a load meanwhile, and dropped when it ends', async ($, on) => {
    const w = world(on, {}, { completeDelayMs: 5_000 });
    await $.session.start(START);
    await prompt($, 'fix it', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'A', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.completes).toHaveLength(1);
    expect(kept(w).calls).toMatchObject([{ kind: 'endOfTurn', turnId: 't1' }]);
    // A load while it runs: the call is this load's own, still running.
    await $.session.start(START);
    await w.clock.settle();
    expect(kept(w).calls).toHaveLength(1);
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect(kept(w)).toEqual({ version: 1, calls: [] });
    await $.session.start(START);
    await w.clock.settle();
    expect(outcomes(w)).toEqual([]);
  });
});
