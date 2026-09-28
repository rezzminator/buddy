import type { On } from 'claude-code';
import { describe, expect, mock, test } from 'claude-code/testing';
import { SHORTCUTS, guideRows } from '../hooks/drawer.tsx';
import { roll } from '../src/hatch.ts';
import { CHARACTER_RULE, memoryRule } from '../src/prompts.ts';

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
    petted: ['Fixy purrs.'],
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
/** Files by absolute path (with their mtimes), whether listing the home folder is refused, whether writes of memory.json are refused (the first that many only), character files shipped beside FILES. */
type Disk = { files?: Record<string, string>; mtimes?: Record<string, number>; refuseHome?: boolean; refuseMemory?: boolean; refuseMemoryTimes?: number; env?: Record<string, string>; builtins?: Record<string, string> };

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
  on('prompt.submit', async (_$, e) => (submit.drop.has(e.text) ? { drop: 'dropped beneath' } : { text: e.text }));
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }));
  on('prompt.suggest', async (_$, e) => {
    suggested.push(e.text);
    origins.push(e.origin.kind);
    return { isShown: true };
  });
  on('env.get', async (_$, e) => ({ value: e.name === 'HOME' ? HOME : disk.env?.[e.name] }));
  on('fs.write', async (_$, e) => {
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
    if (e.path === HOME || e.path.startsWith(`${HOME}/`)) {
      // A thrown answer reaches the plugin as the kit's own rejection, not this message.
      if (disk.refuseHome && e.path === HOME) throw new Error(`EPERM: not allowed to list ${e.path}`);
      // A folder is listed by the files beneath it.
      const entries = new Map<string, 'file' | 'dir'>();
      for (const f of Object.keys(files)) if (f.startsWith(`${e.path}/`)) {
        const rest = f.slice(e.path.length + 1);
        entries.set(rest.split('/')[0]!, rest.includes('/') ? 'dir' : 'file');
      }
      return { value: [...entries].map(([name, kind]) => ({ name, kind, size: files[`${e.path}/${name}`]?.length ?? 0, isLink: false })) };
    }
    if (!e.path.endsWith('/characters')) throw new Error(`ENOENT: ${e.path}`);
    return { value: Object.entries(shipped).map(([name, text]) => ({ name, kind: 'file' as const, size: text.length, isLink: false })) };
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
  return { logs, completes, clock, commands, saved, writes, opens, closes, files, focuses, gets, slow, suggested, origins, submit };
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

/** The band's instance: the drawer scrolls it, the personality tab's focus names it. */
const BAND_ID = 'band';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function shows(ui: any, text: RegExp): Promise<boolean> {
  return (await ui.find({ type: 'Text', text })) !== undefined;
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
    expect(await shows(ui, /Couldn't[ \n]load[ \n]ghost:[ \n]no[ \n]such[ \n]character;[ \n]the[ \n]personality[ \n]tab[ \n]in[ \n]\/buddy[ \n]picks[ \n]another/)).toBe(true);
    await ui.unmount();
  });

  test('a character file taking the reserved id "original" is said in the first greeting, pointing at the personality tab', async ($, on) => {
    const w = world(on, {}, {}, { builtins: { 'original.json': fixture('original', 'Impostor', 'i_i') } });
    await $.session.start(START);
    const ui = await band($);
    expect(await shows(ui, /\(d_d\)/)).toBe(true);
    expect(await shows(ui, /^original\.json[ \n]\(builtin\):[ \n]"original"[ \n]is[ \n]reserved[ \n]for[ \n]your[ \n]original[ \n]companion;[ \n]rename[ \n]the[ \n]file[ \n]and[ \n]its[ \n]id;[ \n]the[ \n]personality[ \n]tab[ \n]in[ \n]\/buddy[ \n]lists[ \n]your[ \n]characters$/)).toBe(true);
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

  test('walks once the greeting ends', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($);
    await w.clock.advance(7000);
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

  test("ctrl+x p pets, counts and remembers", async ($, on) => {
    const w = world(on, { character: 'fixy', pets: 4 });
    await $.session.start(START);
    const ui = await band($);
    expect((await $.command.run(run(''))).text).toMatch(/^The drawer is open above your prompt/);
    await ui.press({ key: 'key-pet' });
    await w.clock.settle();
    expect(w.saved.get('pets')).toBe(5);
    expect(await shows(ui, /^♥ 5$/)).toBe(true);
    await fold(ui, w);
    expect(await shows(ui, /Fixy purrs\./)).toBe(true);
    await ui.unmount();
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
      expect(q.prompt).toContain(`The user asked Claude:\nask number ${n}`);
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
    expect(p).toContain('Turn 1. The user asked Claude:\nbuild the thing\nClaude answered:\nBuilt.\n- The user asked you: remember pineapple\n  You answered: Pineapple, noted.\n');
    expect(p.indexOf('Pineapple, noted.')).toBeLessThan(p.indexOf('The user asks you directly: which word?'));
  });

  test('a switched character never claims another one\'s words', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'Forty-two, friend.' } });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(run('remember the word pineapple'));
    await w.clock.settle();
    await personality($, w, ui);
    await pick(ui, w, 'use:duck');
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

  test("/buddy list and /buddy use {id}, from 0.1.0, point to the drawer's personality tab with no model call", async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    expect((await $.command.run(run('list'))).text).toBe("Switching characters moved to the drawer's personality tab: /buddy opens it.");
    expect((await $.command.run(run('use cat'))).text).toBe("Switching characters moved to the drawer's personality tab: /buddy opens it.");
    await w.clock.settle();
    expect(w.completes).toEqual([]);
  });

  test('a question asking for a prompt: the answer in the bubble, the prompt in the prompt box and the drawer as the idea ctrl+x u uses', async ($, on) => {
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
  test('a failed tool call: oops and the toolFail line', async ($, on) => {
    world(on, { character: 'fixy' });
    on('tool.call', async () => ({ result: { stdout: '', stderr: 'boom' }, text: 'boom', isError: true }) as never);
    await $.session.start(START);
    const ui = await band($);
    await $.tool.call({ tool: 'Bash', command: 'false' } as never);
    expect(await shows(ui, /\(F_F\)!/)).toBe(true);
    expect(await shows(ui, /Fixy: oh no\./)).toBe(true);
    await ui.unmount();
  });

  test('a passing test run: yay and the testPass line', async ($, on) => {
    world(on, { character: 'fixy' });
    on('tool.call', async () => ({ result: { stdout: 'Tests  12 passed (12)' }, text: 'Tests  12 passed (12)' }) as never);
    await $.session.start(START);
    const ui = await band($);
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never);
    expect(await shows(ui, /\\f_f\//)).toBe(true);
    expect(await shows(ui, /Fixy: green!/)).toBe(true);
    await ui.unmount();
  });

  test('a failing test run: oops and the testFail line', async ($, on) => {
    world(on, { character: 'fixy' });
    on('tool.call', async () => ({ result: { stdout: '3 failed, 9 passed' }, text: '3 failed, 9 passed', isError: true }) as never);
    await $.session.start(START);
    const ui = await band($);
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never);
    expect(await shows(ui, /Fixy: red!/)).toBe(true);
    await ui.unmount();
  });
});

// ---- the drawer's personality tab --------------------------------------------

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

/** /buddy opens the drawer on `ui`, the band, and its personality tab is pressed and built. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function personality($: any, w: { clock: { settle: () => Promise<void> } }, ui: any): Promise<void> {
  if (!(await ui.find({ key: 'key-tab' }))) await $.command.run(run(''));
  await ui.press({ key: 'key-tab' });
  await w.clock.settle();
}

/** ctrl+x n until `key`'s row is lit: each step switches to the character it lands on, one that cannot be drawn only lit. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pick(ui: any, w: { clock: { settle: () => Promise<void> } }, key: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (JSON.stringify((await ui.find({ key }))?.children ?? null).includes('"inverse":true')) return;
    await ui.press({ key: 'key-next' });
    await w.clock.settle();
  }
  throw new Error(`ctrl+x n never lit ${key}`);
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

describe("the drawer's personality tab", () => {
  test('the groups titled, the current one marked and previewed; no pane opens', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    const pane = await band($);
    await personality($, w, pane);
    expect(w.opens).toEqual([]);
    for (const title of [/^Shipped$/, /^Yours$/]) expect(await shows(pane, title)).toBe(true);
    expect(await shows(pane, /^customCharactersDir$/)).toBe(false);
    expect(await label(pane, 'use:fixy')).toBe('* Fixy (fixy)');
    expect(await label(pane, 'use:duck')).toBe('  Duck Fixture (duck)');
    expect(await label(pane, 'use:broken')).toBe('  broken (invalid)');
    expect(await shows(pane, /^Fixy$/)).toBe(true);
    expect(await shows(pane, /^Fixy, a test fixture\.$/)).toBe(true);
    expect(await shows(pane, /You are Fixy/)).toBe(false);
    expect(await shows(pane, /^“Fixy says hi\.”$/)).toBe(true);
    expect(await shows(pane, /^None yet: set customCharactersDir to a folder of your own character files\.$/)).toBe(true);
    await pane.unmount();
  });

  test('ctrl+x n lights the next character and switches to it at once, the preview following; the tab stays open on it', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    const ui = await band($);
    await personality($, w, ui);
    await pick(ui, w, 'use:duck');
    expect(await shows(ui, /^Duck Fixture$/)).toBe(true);
    expect(w.saved.get('character')).toBe('duck');
    expect(await label(ui, 'use:duck')).toBe('* Duck Fixture (duck)');
    expect(await label(ui, 'use:fixy')).toBe('  Fixy (fixy)');
    expect(await shows(ui, /^D U C K {3}F I X T U R E$/)).toBe(true);
    await fold(ui, w);
    expect(await shows(ui, /\(d_d\)/)).toBe(true);
    expect(await shows(ui, /Duck fixture here\./)).toBe(true);
    await ui.unmount();
  });

  test('ctrl+x b goes back; a character that cannot be drawn is lit, its preview saying why, and never picked', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    const ui = await band($);
    await personality($, w, ui);
    await pick(ui, w, 'use:broken');
    expect(await shows(ui, /^Can't draw it: persona: required$/)).toBe(true);
    expect(w.saved.get('character')).not.toBe('broken');
    expect(w.logs.filter((l) => /Can't pick/.test(l))).toEqual([]);
    await pick(ui, w, 'use:fixy');
    await ui.press({ key: 'key-back' });
    await w.clock.settle();
    const before = (await label(ui, 'use:fixy')) as string;
    expect(before.startsWith('  ')).toBe(true);
    await ui.press({ key: 'key-next' });
    await w.clock.settle();
    expect(w.saved.get('character')).toBe('fixy');
    expect(await label(ui, 'use:fixy')).toBe('* Fixy (fixy)');
    await ui.unmount();
  });

  test('ctrl+x t goes back to the thread', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    const ui = await band($);
    await personality($, w, ui);
    expect(await label(ui, 'use:fixy')).toBe('* Fixy (fixy)');
    await ui.press({ key: 'key-tab' });
    await w.clock.settle();
    expect(await ui.find({ key: 'use:fixy' })).toBeUndefined();
    expect(await shows(ui, /Nothing between you and Fixy yet/)).toBe(true);
    await ui.unmount();
  });

  test('a companion in ~/.claude.json: two Yours entries; ctrl+x n onto one draws it, saves soul and roll, and its preview animates with its card', async ($, on) => {
    const w = world(on, {}, {}, { files: { [CONFIG]: config(MOCHI) } });
    await $.session.start(START);
    const ui = await band($);
    await personality($, w, ui);
    const pane = ui;
    expect(await label(pane, 'original:native')).toBe('  Mochi — native install');
    expect(await label(pane, 'original:npm')).toBe('  Mochi — npm install');
    await pick(pane, w, 'original:npm');
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
    const pane = await band($);
    await personality($, w, pane);
    expect(await label(pane, 'original:native')).toBe('  Newest — native install');
    expect(await shows(pane, /^From the backup ~\/\.claude\/backups\/\.claude\.json\.backup\.1775\.$/)).toBe(true);
  });

  test('an unreadable ~/.claude.json is a plain line in Yours', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const pane = await band($);
    await personality($, w, pane);
    expect(await shows(pane, /^couldn't read ~\/\.claude\.json: \S/)).toBe(true);
    expect(await pane.find({ key: 'original:native' })).toBeUndefined();
  });

  test('an invalid ~/.claude.json is a plain line in Yours, never its contents', async ($, on) => {
    const w = world(on, {}, {}, { files: { [CONFIG]: '{"secretToken": oops' } });
    await $.session.start(START);
    const pane = await band($);
    await personality($, w, pane);
    expect(await shows(pane, /^couldn't parse ~\/\.claude\.json: not valid JSON \(SyntaxError\)$/)).toBe(true);
    expect(w.logs.join('\n')).not.toContain('secretToken');
  });

  test('no companion anywhere takes no line: Yours holds only your own characters, or says how to add some', async ($, on) => {
    const w = world(on, {}, {}, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    const pane = await band($);
    await personality($, w, pane);
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
    await personality($, w, ui);
    await pick(ui, w, 'use:duck');
    await w.clock.settle();
    await fold(ui, w);
    await w.clock.advance(5000);
    await w.clock.settle();
    expect(w.completes).toHaveLength(1);
    expect(await shows(ui, /A completed answer\./)).toBe(false);
    expect(w.logs).toContain("buddy: Fixy's answer was dropped: Duck Fixture is drawn now");
    await ui.unmount();
  });

  test('two sessions on one store: a pet counts on from the other one\'s count, and /buddy off there hides the band here', async ($, on) => {
    const w = world(on, { character: 'fixy', pets: 3 });
    await $.session.start(START);
    const ui = await band($);
    w.saved.set('pets', 10);
    await $.command.run(run(''));
    await ui.press({ key: 'key-pet' });
    await w.clock.settle();
    expect(w.saved.get('pets')).toBe(11);
    await fold(ui, w);
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
    const pane = await band($);
    await personality($, w, pane);
    expect({ native: await label(pane, 'original:native'), logs: w.logs }).toMatchObject({ native: expect.any(String) });
    expect(await label(pane, 'original:npm')).toBeDefined();
    await pane.unmount();
  });
});

describe('hook paths', () => {
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
    expect(w.completes[0]?.prompt).toContain('The user asked Claude:\nlist the files');
    expect(w.completes[0]?.prompt).toContain('Claude answered:\nT1');
    expect(w.completes[0]?.prompt).toContain('Tools used: Bash. Failures: 0. Last shell command: ls.');
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
    expect(p).toContain('Turn 1. The user asked Claude:\nfix the login bug\nClaude did: Run the tests; edited a.ts\nClaude answered:\nFixed\nIt works.');
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
    const p = w.completes.at(-1)!.prompt;
    // Turn 1 and its comment and suggestion are gone together; turn 2 is the oldest remembered, its own comment and suggestion under it.
    expect(p).not.toMatch(/ask number 1\b|comment on 1\.|next after 1\b/);
    expect(p).toContain("Turn 1. The user asked Claude:\nask number 2\nClaude answered:\nreply number 2\n- After this turn, you commented: comment on 2.\n  With it, you suggested the user's next prompt: next after 2\n\nTurn 2. The user asked Claude:\nask number 3");
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
    // Turn 2's comment came while the answer held the bubble: never shown, never filed.
    expect(blocks[2]!.characters.fixy ?? []).toEqual([]);
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
    expect(w.completes[0]?.prompt).toContain('Tools used: Bash. Failures: 0. Last shell command: ls.');
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
    expect(w.completes[0]!.prompt).toContain('The user asked Claude:\nask number 1');
    const last = w.completes[4]!.prompt;
    expect(last).not.toContain('ask number 1');
    expect(last).not.toContain('reply number 1');
    expect(last.indexOf('ask number 2')).toBeGreaterThan(-1);
    expect(last.indexOf('ask number 2')).toBeLessThan(last.indexOf('ask number 3'));
    expect(last.indexOf('ask number 3')).toBeLessThan(last.indexOf('reply number 5'));
    expect(last.endsWith('In the turn that just ended: Tools used: none. Failures: 0. Last shell command: none.')).toBe(true);
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
    await personality($, w, ui);
    await pick(ui, w, 'use:duck');
    await fold(ui, w);
    const drawn = JSON.stringify(await ui.drawn());
    expect(drawn).not.toContain('tab-personality');
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
    expect(asks[0]!.prompt).toContain('The user asked Claude:\nbuild the thing');
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

  test('WRONG is screamed in red over the comment, its stop prompt suggested; the drawer and the memory keep the comment, the warning and the suggestion', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: judged('WRONG', 'YOU ARE FORCE-PUSHING MAIN!', 'stop, never push main; open the release PR instead') });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Pushed.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    const scream = await ui.find({ type: 'Text', text: /YOU ARE FORCE-PUSHING MAIN!/ });
    expect(scream?.props.color).toBe('red');
    expect(scream?.props.bold).toBe(true);
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

  test('SHORTCUT is warned of in yellow over the comment', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: judged('SHORTCUT', 'called it done without running the suite', 'run the full suite before we call it done') });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect((await ui.find({ type: 'Text', text: /called it done without running the suite/ }))?.props.color).toBe('yellow');
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

describe("the buddy's own notes", () => {
  test('the reply\'s MEMORY lines are its notes: kept in the chat\'s memory.json, said in the drawer when they change, leading every later call; a reply without them keeps them, NONE forgets them', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [
      { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Nice.\nMEMORY: Wants main safe.\nMEMORY: Tests before tags.' },
      { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Again.\nMEMORY: Wants main safe.\nMEMORY: Tests before tags.' },
      { isAnswered: true, text: 'What do you keep?' },
      { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Quiet.' },
      { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Fresh.\nMEMORY: NONE' },
    ] });
    await $.session.start(START);
    const ui = await band($);
    await prompt($, 'one', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'One.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((memory(w) as any).notes).toEqual({ fixy: ['Wants main safe.', 'Tests before tags.'] });
    await prompt($, 'two', 't2');
    await $.turn.complete({ reason: 'answer', answer: 'Two.', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    expect(w.completes[1]!.prompt.startsWith('Your own notes on this chat, which you keep and rewrite yourself:\n- Wants main safe.\n- Tests before tags.\n\n')).toBe(true);
    expect(records(w).filter((r) => r.event === 'notes.outcome').map((r) => r.outcome)).toEqual(['rewritten', 'unchanged']);
    await $.command.run(run('what do you keep?'));
    await w.clock.settle();
    expect(w.completes[2]!.prompt).toContain('- Tests before tags.');
    await prompt($, 'three', 't3');
    await $.turn.complete({ reason: 'answer', answer: 'Three.', isAborted: false, turnId: 't3' } as never);
    await w.clock.settle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((memory(w) as any).notes).toEqual({ fixy: ['Wants main safe.', 'Tests before tags.'] });
    await $.command.run(run(''));
    await w.clock.settle();
    expect(await shows(ui, /Fixy's notes/)).toBe(true);
    expect(await shows(ui, /^• Tests before tags\.$/)).toBe(true);
    await fold(ui, w);
    await prompt($, 'four', 't4');
    await $.turn.complete({ reason: 'answer', answer: 'Four.', isAborted: false, turnId: 't4' } as never);
    await w.clock.settle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((memory(w) as any).notes).toEqual({ fixy: [] });
    expect(records(w).filter((r) => r.event === 'notes.outcome').map((r) => r.outcome)).toEqual(['rewritten', 'unchanged', 'cleared']);
    await ui.unmount();
  });
});

describe('the end-of-turn call, turn by turn', () => {
  test('two turns 5 s apart: both lines are drawn, and both remembered', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: First line.\nSUGGEST_NEXT_PROMPT: NONE' }, { isAnswered: true, text: 'COMMENT_AFTER_EACH_TURN: Second line.\nSUGGEST_NEXT_PROMPT: NONE' }] });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'One.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(await shows(ui, /First line\./)).toBe(true);
    await w.clock.advance(5_000);
    await $.turn.complete({ reason: 'answer', answer: 'Two.', isAborted: false, turnId: 't2' } as never);
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
    await personality($, w, ui);
    await pick(ui, w, 'use:duck');
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
    const last = w.completes.at(-1)!.prompt;
    expect(last).toContain('The user asked Claude:\nfirst ask\nClaude answered:\nfirst reply');
    expect(last).toContain('The user asked Claude:\nsecond ask\nClaude answered:\nsecond reply');
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
    const last = w.completes.at(-1)!.prompt;
    expect(last).toContain('The user asked Claude:\nsecond ask\nClaude answered:\nsecond reply');
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
    expect(w.completes[0]!.prompt).not.toContain('The user asked Claude:\nhello from a peer');
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
    const last = w.completes.at(-1)!.prompt;
    expect(last).toContain('The user asked Claude:\nnew ask\nClaude answered:\nnew reply');
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
  test('a write queued behind a hung read is never said failed while it waits, and lands once the read is abandoned', { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($);
    await w.clock.settle();
    w.slow.sessionIdMs = 1_000_000;
    void $.command.run(run('what is up'));
    await w.clock.settle();
    w.slow.sessionIdMs = 0;
    await $.command.run(run(''));
    await ui.press({ key: 'key-pet' });
    await w.clock.advance(61_000);
    await w.clock.settle();
    expect(w.logs.filter((l) => /remembering the line failed/.test(l))).toEqual([]);
    await w.clock.advance(60_000);
    await w.clock.settle();
    expect(ring(w, 'fixy')).toContainEqual({ kind: 'line', text: 'Fixy purrs.' });
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
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($);
    await w.clock.settle();
    w.slow.chatTurnsToReadSetMs = 70_000;
    await $.command.run(run(''));
    await ui.press({ key: 'key-pet' });
    await w.clock.advance(61_000);
    await w.clock.settle();
    w.slow.chatTurnsToReadSetMs = 0;
    await $.command.run(run('what is up'));
    await w.clock.advance(25_000);
    await w.clock.settle();
    expect(ring(w, 'fixy')).toContainEqual({ kind: 'line', text: 'Fixy purrs.' });
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
    expect(last).toContain('Claude was sent, from an unknown origin:\nthe expanded skill text');
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
    expect(w.completes.at(-1)!.prompt).toContain('The user asked Claude:\ncheck the build');
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
      ['key-tab', 'talk/personality', 'pane:next'],
      ['key-use', 'use the idea', 'pane:previous'],
      ['key-next', 'next character', 'diff:back'],
      ['key-back', 'previous character', 'app:cycleDiffBase'],
      ['key-pet', 'pet', 'permission:toggleDebug'],
      ['close', 'close', 'confirm:previousField'],
    ]);
    // Borrowed, never taken: each action one Claude Code handles only in a panel or dialog, each chord none it binds at the prompt.
    const panelOnly = ['pane:next', 'pane:previous', 'diff:back', 'app:cycleDiffBase', 'permission:toggleDebug', 'confirm:previousField'];
    const itsCtrlX = ['ctrl+x ctrl+k', 'ctrl+x enter', 'ctrl+x ctrl+s', 'ctrl+x ctrl+e', 'ctrl+x ctrl+b', 'ctrl+x ctrl+a', 'ctrl+x tab', 'ctrl+x x', 'ctrl+x left', 'ctrl+x up', 'ctrl+x right', 'ctrl+x down'];
    for (const k of SHORTCUTS) {
      expect(panelOnly).toContain(k.action);
      expect(itsCtrlX).not.toContain(k.chord);
    }
    // The bar under the body: the tabs and the guide at its left, the ask box last, at its right.
    const drawn = JSON.stringify(await ui.drawn());
    expect(drawn.indexOf('"bar"')).toBeGreaterThan(drawn.indexOf('"body"'));
    expect(drawn.indexOf('"guide"')).toBeGreaterThan(drawn.indexOf('"bar"'));
    expect(drawn.indexOf('ask-input')).toBeGreaterThan(drawn.lastIndexOf('"close"'));
    // Each shortcut its whole chord: none leans on a ctrl+x said once.
    expect((await ui.find({ key: 'guide' }))?.text).toMatch(/^ctrl\+x tab ask\s*ctrl\+x t talk\/personality\s*ctrl\+x u use the idea\s*ctrl\+x n next character/);
    expect(await shows(ui, /←|↑↓|Enter presses/)).toBe(false);
    await ui.unmount();
  });

  test('/buddy alone opens the band above the prompt into the drawer, full width: the thread, the idea with use, the ask box; again folds it back into the buddy', async ($, on) => {
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

  test('it fits the rows the band has: the thread its newest messages, saying how many older; the personality list round the lit character', async ($, on) => {
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
    // The guide wraps its shortcuts whole: one row wide, three narrow; the body gives up what it takes.
    expect([guideRows(160, true), guideRows(130, true), guideRows(60, true)]).toEqual([1, 2, 3]);
    await personality($, w, ui);
    // The list is taller than the body: a window round the lit row, the rest counted.
    expect(JSON.stringify((await ui.find({ key: 'use:fixy' }))?.children ?? null)).toContain('"inverse":true');
    expect(await shows(ui, /^[↑↓] \d+ more$/)).toBe(true);
    await pick(ui, w, 'use:duck');
    expect(await ui.find({ key: 'use:duck' })).toBeDefined();
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

  test('every model call logs call.cost: its tokens, and how much of the turns its memory kept and cut', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    await $.turn.start({ text: 'p'.repeat(20_000), turnId: 't1' } as never);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    const cost = records(w).filter((r) => r.event === 'call.cost');
    expect(cost).toHaveLength(1);
    expect(cost[0]).toMatchObject({ kind: 'endOfTurn', outcome: 'answered', inTok: 1, outTok: 1, memTurns: 1, memFull: 20_005, memKept: 4800 + 2400 + 3 + 5 });
  });
});
