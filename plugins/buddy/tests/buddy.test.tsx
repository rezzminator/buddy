import type { On } from 'claude-code';
import { describe, expect, mock, test } from 'claude-code/testing';
import { roll } from '../src/hatch.ts';
import { CHARACTER_RULE } from '../src/prompts.ts';

// Run with `claude plugin test plugins/buddy` (CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1).
// The plugin loads from this folder; `on` here sits beneath it and answers
// `$.fs`, `$.store`, `$.clock`, `$.model` and the rest from memory, so these
// tests draw inline fixture characters, never the shipped characters/*.json.

const START = { cwd: '.', surface: null, isInteractive: true } as const;
const BAND = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100 };

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

type Answer = { isAnswered: boolean; text?: string; reason?: string; status?: number | null; usage?: object };
/** Files by absolute path (with their mtimes), whether listing the home folder is refused, a store key prefix whose writes are refused, character files shipped beside FILES. */
type Disk = { files?: Record<string, string>; mtimes?: Record<string, number>; refuseHome?: boolean; refuseStore?: string; env?: Record<string, string>; builtins?: Record<string, string> };

const HOME = '/test-home';
const SESSION = 'test-session';

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
  /** A read of `hidden` answers what the store held when asked, this long later: a read in flight; a write of it lands this long later. */
  const slow = { hiddenMs: 0, setHiddenMs: 0, sessionIdMs: 0, keysMs: 0 };
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
  on('turn.complete', async () => ({ text: '' }));
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
    return { value };
  });
  on('store.set', async (_$, e) => {
    if (disk.refuseStore && e.key.startsWith(disk.refuseStore)) throw new Error(`EACCES: not allowed to write ${e.key}`);
    if (e.key === 'hidden' && slow.setHiddenMs > 0) await clock.sleep(slow.setHiddenMs);
    saved.set(e.key, e.value);
    return { value: undefined };
  });
  on('store.keys', async () => {
    if (slow.keysMs > 0) await clock.sleep(slow.keysMs);
    return { value: [...saved.keys()] };
  });
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }));
  on('session.id', async () => {
    if (slow.sessionIdMs > 0) await clock.sleep(slow.sessionIdMs);
    return { value: SESSION };
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
      const names = Object.keys(files).filter((f) => f.startsWith(`${e.path}/`) && !f.slice(e.path.length + 1).includes('/'));
      return { value: names.map((f) => ({ name: f.slice(e.path.length + 1), kind: 'file' as const, size: files[f]!.length, isLink: false })) };
    }
    if (!e.path.endsWith('/characters')) throw new Error(`ENOENT: ${e.path}`);
    return { value: Object.entries(shipped).map(([name, text]) => ({ name, kind: 'file' as const, size: text.length, isLink: false })) };
  });
  on('fs.read', async (_$, e) => {
    if (files[e.path] !== undefined) return { value: files[e.path]! };
    const art = /\/species\/([a-z]+)\.json$/.exec(e.path);
    if (art) return { value: art[1] === 'hats' ? HAT_ART : speciesArt(art[1]!) };
    if (e.path.startsWith(`${HOME}/`)) throw new Error(`ENOENT: ${e.path}`);
    const text = shipped[e.path.split('/').pop() ?? ''];
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`);
    return { value: text };
  });
  on('model.complete', async (_$, e) => {
    completes.push({ model: e.model, effort: e.effort, system: e.system, prompt: e.prompt, timeoutMs: e.timeoutMs });
    if (answers.completeDelayMs) await clock.sleep(answers.completeDelayMs);
    return { value: { usage, ...(queue.shift() ?? answers.complete ?? { isAnswered: true, text: 'A completed answer.' }) } } as never;
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
  return $.ui.mount({ plugin: 'buddy', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, ...props } });
}

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
    expect(await shows(ui, /Couldn't[ \n]load[ \n]ghost:[ \n]no[ \n]such[ \n]character;[ \n]\/buddy-personality[ \n]picks[ \n]another/)).toBe(true);
    await ui.unmount();
  });

  test('a character file taking the reserved id "original" is said in the first greeting, pointing at /buddy-personality', async ($, on) => {
    const w = world(on, {}, {}, { builtins: { 'original.json': fixture('original', 'Impostor', 'i_i') } });
    await $.session.start(START);
    const ui = await band($);
    expect(await shows(ui, /\(d_d\)/)).toBe(true);
    expect(await shows(ui, /^original\.json[ \n]\(builtin\):[ \n]"original"[ \n]is[ \n]reserved[ \n]for[ \n]your[ \n]original[ \n]companion;[ \n]rename[ \n]the[ \n]file[ \n]and[ \n]its[ \n]id;[ \n]\/buddy-personality[ \n]lists[ \n]your[ \n]characters$/)).toBe(true);
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
    expect(w.commands).toEqual(['buddy', 'buddy-personality']);
  });

  test('pets, counts and remembers', async ($, on) => {
    const w = world(on, { character: 'fixy', pets: 4 });
    await $.session.start(START);
    const ui = await band($);
    expect((await $.command.run(run(''))).text).toBe('Fixy: 5 pets');
    expect(w.saved.get('pets')).toBe(5);
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

  test('an idle question: ONE completion on opus at low effort; the persona, then the character rule; only the last 3 turns', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: '"Forty-two, friend."\nand more' } });
    await $.session.start(START);
    const ui = await band($);
    for (let n = 1; n <= 4; n++) {
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
    expect(system).toContain('Answer in ONE line, at most 25 words, in character. Do not use tools. Do not think out loud.');
    expect(q.prompt).not.toContain('ask number 1');
    expect(q.prompt).not.toContain('reply number 1');
    for (const n of [2, 3, 4]) {
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
    expect(p).toContain('Recently (oldest first):\nFixy: Fixy says hi.\nYou: remember the word pineapple\nFixy: Forty-two, friend.\n');
    expect(p).not.toContain('Fixy ponders.');
    expect(p).toContain('you may refer back to it');
    expect(p.indexOf('Fixy: Forty-two, friend.')).toBeLessThan(p.indexOf('The user asks you directly: what word?'));
    expect(p).not.toContain('You: what word?');
    expect(w.saved.get(`memory:${SESSION}`)).toMatchObject({
      characters: {
        fixy: [
          { kind: 'line', text: 'Fixy says hi.' },
          { kind: 'question', question: 'remember the word pineapple', answer: 'Forty-two, friend.' },
          { kind: 'question', question: 'what word?', answer: 'Forty-two, friend.' },
        ],
      },
    });
    await ui.unmount();
  });

  test('a resumed session\'s question carries the stored memory too', async ($, on) => {
    const w = world(on, { character: 'fixy', [`memory:${SESSION}`]: { at: 1, characters: { fixy: [{ kind: 'question', question: 'remember pineapple', answer: 'Pineapple, noted.' }] } } });
    await $.session.start(START);
    await $.command.run(run('which word?'));
    await w.clock.settle();
    const p = w.completes[0]!.prompt;
    expect(p).toContain('You: remember pineapple\nFixy: Pineapple, noted.\n');
    expect(p.indexOf('Pineapple, noted.')).toBeLessThan(p.indexOf('The user asks you directly: which word?'));
  });

  test('a switched character never claims another one\'s words', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'Forty-two, friend.' } });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(run('remember the word pineapple'));
    await w.clock.settle();
    await $.command.run(menu());
    const pane = await paneOf($);
    await pane.press({ key: 'use:duck' });
    await w.clock.settle();
    await pane.unmount();
    await ui.unmount();
    const again = await band($);
    await $.command.run(run('what word?'));
    await w.clock.settle();
    expect(w.completes[1]!.prompt).toContain('Duck Fixture: Duck fixture here.');
    expect(w.completes[1]!.prompt).not.toMatch(/pineapple|Forty-two|Fixy/);
    await again.unmount();
  });

  test('a memory that cannot be saved is said in the next reply, never left out in silence', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { refuseStore: 'memory:' });
    await $.session.start(START);
    await $.command.run(run('first?'));
    await w.clock.settle();
    const out = (await $.command.run(run('second?'))).text;
    // The kit turns the refusal into its own rejection: the reply names what failed and the kit's reason.
    expect(out).toMatch(/^Asked Fixy\. \(Its memory: remembering the (question|answer|line) failed: .+\)$/);
    expect(w.logs.some((l) => /^buddy: remembering the (question|answer|line) failed: .+/.test(l))).toBe(true);
    expect(w.saved.has(`memory:${SESSION}`)).toBe(false);
  });

  test('a malformed stored memory is said in the reply, and what is sound is still remembered', async ($, on) => {
    const w = world(on, { character: 'fixy', [`memory:${SESSION}`]: { at: 1, characters: { fixy: [{ who: 'you', kind: 'question', text: 'old shape' }, { kind: 'line', text: 'Still here.' }] } } });
    await $.session.start(START);
    // The question reads its memory after the reply: the failure is said in the next question's reply.
    await $.command.run(run('anyone?'));
    await w.clock.settle();
    const out = (await $.command.run(run('still there?'))).text;
    await w.clock.settle();
    expect(out).toBe('Asked Fixy. (Its memory: reading the memory failed: the stored memory had 1 malformed exchange, dropped)');
    expect(w.logs).toContain('buddy: reading the memory failed: the stored memory had 1 malformed exchange, dropped');
    expect(w.completes[0]!.prompt).toContain('Fixy: Still here.');
    expect(w.completes[0]!.prompt).not.toContain('old shape');
  });

  test('/buddy list and /buddy use {id}, from 0.1.0, point to the menu with no model call', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    expect((await $.command.run(run('list'))).text).toBe('Switching characters moved to /buddy-personality.');
    expect((await $.command.run(run('use cat'))).text).toBe('Switching characters moved to /buddy-personality.');
    await w.clock.settle();
    expect(w.completes).toEqual([]);
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
    const ring = (w.saved.get(`memory:${SESSION}`) as { characters: Record<string, { answer?: string }[]> }).characters.fixy!;
    expect(ring.at(-1)).toMatchObject({ question: 'you like yourself!?', answer: 'Quack, I am here.' });
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
    const ring = (w.saved.get(`memory:${SESSION}`) as { characters: Record<string, { question?: string }[]> }).characters.fixy!;
    expect(ring.at(-1)).toMatchObject({ question: 'say hi' });
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

// ---- /buddy-personality ---------------------------------------------------

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

const PANE = 'buddy-personality';

function menu() {
  return { command: PANE, args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function paneOf($: any) {
  return $.ui.mount({ plugin: 'buddy', surface: 'terminal', component: 'Pane', requestId: PANE, props: { title: 'Pick a personality', isFocused: true, bodyColumns: 100, placement: 'inline' } });
}

/** The person's arrow (or Tab) moving the pane's focus ring onto `key`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function focus($: any, key: string): Promise<void> {
  await $.ui.focus({ component: 'Pane', requestId: PANE, element: key, origin: { kind: 'person' } });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function label(ui: any, key: string): Promise<unknown> {
  return (await ui.find({ key }))?.props.label;
}

describe('/buddy-personality', () => {
  test('opens a focused pane: the groups titled, the current one marked and previewed', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    expect(w.commands).toEqual(['buddy', PANE]);
    expect((await $.command.run(menu())).text).toBe('Pick a personality: ↑/↓ move, Enter picks, Esc closes.');
    expect(w.opens).toEqual([{ id: PANE, title: 'Pick a personality', focus: true, closeOnEscape: true, rows: expect.any(Number) }]);
    const pane = await paneOf($);
    for (const title of [/^Shipped$/, /^Yours$/, /^Your folder$/]) expect(await shows(pane, title)).toBe(true);
    expect(await label(pane, 'use:fixy')).toBe('* Fixy (fixy)');
    expect(await label(pane, 'use:duck')).toBe('  Duck Fixture (duck)');
    expect(await label(pane, 'use:broken')).toBe('  broken (invalid)');
    expect(await shows(pane, /^Fixy$/)).toBe(true);
    expect(await shows(pane, /^Fixy, a test fixture\.$/)).toBe(true);
    expect(await shows(pane, /You are Fixy/)).toBe(false);
    expect(await shows(pane, /^“Fixy says hi\.”$/)).toBe(true);
    expect(await shows(pane, /^No folder set: the customCharactersDir option names one\.$/)).toBe(true);
    await pane.unmount();
  });

  test('down moves the highlight and the preview follows; Enter picks, remembers, closes and greets', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(menu());
    const pane = await paneOf($);
    await focus($, 'use:duck');
    expect(await shows(pane, /^Duck Fixture$/)).toBe(true);
    expect(await shows(pane, /^Fixy$/)).toBe(false);
    await focus($, 'use:broken');
    expect(await shows(pane, /^Can't draw it: persona: required$/)).toBe(true);
    await pane.press({ key: 'use:duck' });
    await w.clock.settle();
    expect(w.saved.get('character')).toBe('duck');
    expect(await shows(ui, /\(d_d\)/)).toBe(true);
    expect(await shows(ui, /Duck fixture here\./)).toBe(true);
    expect(w.closes).toEqual([PANE]);
    await pane.unmount();
    await $.command.run(menu());
    const again = await paneOf($);
    expect(await label(again, 'use:duck')).toBe('* Duck Fixture (duck)');
    expect(await label(again, 'use:fixy')).toBe('  Fixy (fixy)');
    await again.unmount();
    await ui.unmount();
  });

  test('an invalid entry cannot be picked; picking the configured default goes back to it', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(menu());
    const pane = await paneOf($);
    await pane.press({ key: 'use:broken' });
    await w.clock.settle();
    expect(w.logs).toContain("buddy: /buddy-personality: can't pick broken (invalid): persona: required");
    expect(w.saved.get('character')).toBe('fixy');
    expect(await shows(ui, /\(f_f\)/)).toBe(true);
    await pane.press({ key: 'use:duck' });
    await w.clock.settle();
    expect(w.saved.get('character')).toBe('duck');
    expect(await shows(ui, /\(d_d\)/)).toBe(true);
    await pane.unmount();
    await ui.unmount();
  });

  // The kit cannot raise the person's Esc (ui.close, origin person): the open
  // asks closeOnEscape, and live-proof (i) watches Esc close it for real.
  test('Esc: asked for at the open; a highlight alone changes nothing', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(menu());
    const pane = await paneOf($);
    await focus($, 'use:duck');
    expect(await shows(pane, /^Duck Fixture$/)).toBe(true);
    expect(w.opens).toMatchObject([{ closeOnEscape: true }]);
    expect(w.closes).toEqual([]);
    expect(w.saved.get('character')).toBe('fixy');
    expect(await shows(ui, /\(f_f\)/)).toBe(true);
    expect(await label(pane, 'use:fixy')).toBe('* Fixy (fixy)');
    await pane.unmount();
    await ui.unmount();
  });

  test('a companion in ~/.claude.json: two Yours entries; the preview animates and shows its card; Enter draws it and saves soul and roll', async ($, on) => {
    const w = world(on, {}, {}, { files: { [CONFIG]: config(MOCHI) } });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(menu());
    const pane = await paneOf($);
    expect(await label(pane, 'original:native')).toBe('  Mochi — native install');
    expect(await label(pane, 'original:npm')).toBe('  Mochi — npm install');
    await focus($, 'original:npm');
    expect(await shows(pane, /^Mochi$/)).toBe(true);
    expect(await shows(pane, eyesOf('npm'))).toBe(true);
    expect(await shows(pane, /^hatched 2026-04-01$/)).toBe(true);
    expect(await shows(pane, /^A round little creature who hums at green tests\.$/)).toBe(true);
    expect(await shows(pane, /You are Mochi/)).toBe(false);
    expect(await shows(pane, /^SNARK +[█░]{10} \d+$/)).toBe(true);
    expect(await shows(pane, /<-->/)).toBe(false);
    await w.clock.advance(1000);
    expect(await shows(pane, /<-->/)).toBe(true);
    await pane.press({ key: 'original:npm' });
    await w.clock.settle();
    expect(w.saved.get('character')).toBe('original');
    expect(w.saved.get('original')).toEqual({ variant: 'npm', soul: MOCHI });
    expect(await shows(ui, eyesOf('npm'))).toBe(true);
    expect(await shows(ui, /Mochi says hello\./)).toBe(true);
    await pane.unmount();
    await $.command.run(menu());
    const again = await paneOf($);
    expect(await label(again, 'original:npm')).toBe('* Mochi — npm install');
    await again.unmount();
    // The plugin's own log is its only file write, and it never holds the identity.
    expect(w.writes.filter((p) => !p.endsWith('/.claude/buddy/buddy.log'))).toEqual([]);
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
    world(on, {}, {}, { files, mtimes });
    await $.session.start(START);
    await $.command.run(menu());
    const pane = await paneOf($);
    expect(await label(pane, 'original:native')).toBe('  Newest — native install');
    expect(await shows(pane, /^From the backup ~\/\.claude\/backups\/\.claude\.json\.backup\.1775\.$/)).toBe(true);
  });

  test('an unreadable ~/.claude.json is a plain line in Yours', async ($, on) => {
    world(on);
    await $.session.start(START);
    await $.command.run(menu());
    const pane = await paneOf($);
    expect(await shows(pane, /^couldn't read ~\/\.claude\.json: \S/)).toBe(true);
    expect(await pane.find({ key: 'original:native' })).toBeUndefined();
  });

  test('an invalid ~/.claude.json is a plain line in Yours, never its contents', async ($, on) => {
    const w = world(on, {}, {}, { files: { [CONFIG]: '{"secretToken": oops' } });
    await $.session.start(START);
    await $.command.run(menu());
    const pane = await paneOf($);
    expect(await shows(pane, /^couldn't parse ~\/\.claude\.json: not valid JSON \(SyntaxError\)$/)).toBe(true);
    expect(w.logs.join('\n')).not.toContain('secretToken');
  });

  test('no companion anywhere says so in one line', async ($, on) => {
    world(on, {}, {}, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    await $.command.run(menu());
    const pane = await paneOf($);
    expect(await shows(pane, /^No companion in ~\/\.claude\.json or its backups\.$/)).toBe(true);
  });
});

describe('core fixes', () => {
  test('a session whose band never draws (claude -p, the SDK) remembers no line; once drawn, the lines it shows are kept', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    await $.command.run(run(''));
    await w.clock.advance(5000);
    const memory = () => JSON.stringify([...w.saved.entries()].filter(([k]) => k.startsWith('memory')));
    expect(memory()).not.toMatch(/Fixy (says hi|purrs)/);
    const ui = await band($);
    await $.command.run(run(''));
    await w.clock.settle();
    expect(memory()).toMatch(/Fixy purrs\./);
    await ui.unmount();
  });

  test('an answer in flight is dropped, and the log says so, when another character was picked meanwhile', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { completeDelayMs: 5000 }, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(run('what is up'));
    await $.command.run(menu());
    const pane = await paneOf($);
    await pane.press({ key: 'use:duck' });
    await w.clock.settle();
    await pane.unmount();
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
    expect((await $.command.run(run(''))).text).toBe('Fixy: 11 pets');
    expect(await shows(ui, /f_f/)).toBe(true);
    w.saved.set('hidden', true);
    await w.clock.advance(20_000);
    await w.clock.settle();
    expect((await $.command.run(run('what now'))).text).toBe('Fixy is hidden; /buddy on first');
    await ui.unmount();
  });

  test('a menu pane gone without ui.close stops its preview clock', async ($, on) => {
    const w = world(on, { character: 'fixy' }, {}, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    await $.command.run(menu());
    await w.clock.advance(10_000);
    const pane = await paneOf($);
    expect(await shows(pane, /^The menu closed; \/buddy-personality opens it again\.$/)).toBe(true);
    await pane.unmount();
  });

  test('with CLAUDE_CONFIG_DIR set, the companion is read from its .claude.json, not from HOME', async ($, on) => {
    const ccd = '/test-ccd';
    const w = world(on, { character: 'fixy' }, {}, { files: { [`${ccd}/.claude.json`]: config(MOCHI) }, env: { CLAUDE_CONFIG_DIR: ccd } });
    await $.session.start(START);
    await $.command.run(menu());
    const pane = await paneOf($);
    expect({ native: await label(pane, 'original:native'), logs: w.logs }).toMatchObject({ native: expect.any(String) });
    expect(await label(pane, 'original:npm')).toBeDefined();
    await pane.unmount();
  });
});

describe('hook paths', () => {
  test('turn.complete (commentAfterEachTurn and suggestNextPrompt on by default): one call on the quip model reads the prompt, the answer and the tally', async ($, on) => {
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
    // An untagged reply is the line alone.
    expect(await shows(ui, /A completed answer\./)).toBe(true);
    const records = (w.files[`${HOME}/.claude/buddy/buddy.log`] ?? '').trim().split('\n').map((l) => JSON.parse(l));
    expect(records.find((r) => r.event === 'turn.call')).toMatchObject({ line: true, next: true });
    expect(records.find((r) => r.event === 'quip.outcome')).toMatchObject({ outcome: 'answered', inTok: 1, outTok: 1, cacheRead: 0, cachePct: 0 });
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

  test('the line\'s and the suggestion\'s outcomes carry ms, from the turn\'s end to the reply, as an ask\'s does', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'LINE: Fixy likes that.\nNEXT: run the tests' } });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    const records = (w.files[`${HOME}/.claude/buddy/buddy.log`] ?? '').trim().split('\n').map((l) => JSON.parse(l));
    expect(typeof records.find((r) => r.event === 'quip.outcome')?.ms).toBe('number');
    expect(typeof records.find((r) => r.event === 'suggest.outcome')?.ms).toBe('number');
    await ui.unmount();
  });

  test('a headless session (-p, the SDK) makes no end-of-turn call: nobody sees the line, and there is no prompt box to suggest into', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start({ ...START, isInteractive: false });
    await prompt($, 'list the files', 't1');
    await $.turn.complete({ reason: 'answer', answer: 'T1', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.completes).toHaveLength(0);
    const records = (w.files[`${HOME}/.claude/buddy/buddy.log`] ?? '').trim().split('\n').map((l) => JSON.parse(l));
    expect(records.find((r) => r.event === 'turn.skipped')).toMatchObject({ why: 'headless' });
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

  test('the end-of-turn call runs on opus at low effort, its LINE told the character rule, and reads only the last 3 turns, oldest first', async ($, on) => {
    const w = world(on, { character: 'fixy' });
    await $.session.start(START);
    const ui = await band($);
    for (let n = 1; n <= 4; n++) {
      await prompt($, `ask number ${n}`, `t${n}`);
      await $.turn.complete({ reason: 'answer', answer: `reply number ${n}`, isAborted: false, turnId: `t${n}` } as never);
      await w.clock.settle();
    }
    expect(w.completes).toHaveLength(4);
    for (const c of w.completes) expect(c).toMatchObject({ model: 'opus', effort: 'low' });
    expect(w.completes[0]!.system).toContain(`You are Fixy, a test fixture.\n\n${CHARACTER_RULE}\n\n`);
    expect(w.completes[0]!.prompt).toContain('The user asked Claude:\nask number 1');
    const last = w.completes[3]!.prompt;
    expect(last).not.toContain('ask number 1');
    expect(last).not.toContain('reply number 1');
    expect(last.indexOf('ask number 2')).toBeGreaterThan(-1);
    expect(last.indexOf('ask number 2')).toBeLessThan(last.indexOf('ask number 3'));
    expect(last.indexOf('ask number 3')).toBeLessThan(last.indexOf('reply number 4'));
    await ui.unmount();
  });

  test('/buddy reload reads the roster again and keeps drawing the stored choice', async ($, on) => {
    world(on, { character: 'fixy' });
    await $.session.start(START);
    expect((await $.command.run(run('reload'))).text).toBe('Reloaded 3 characters (1 invalid); drawing Fixy');
  });

  // The kit cannot raise the person's Esc: the menu closes here by a pick, the plugin's own ui.close.
  test('/buddy off stops the band clock; a closed menu stops its preview clock', async ($, on) => {
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
    await $.command.run(menu());
    const open = await paneOf($);
    await open.press({ key: 'use:duck' });
    await w.clock.settle();
    await open.unmount();
    await w.clock.advance(5000);
    const pane = await paneOf($);
    expect(await shows(pane, /^The menu closed; \/buddy-personality opens it again\.$/)).toBe(true);
    await pane.unmount();
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
    const ring = JSON.stringify(w.saved.get(`memory:${SESSION}`) ?? null);
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

describe('prompt suggestions', () => {
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
    // The running turn is not answered yet: its prompt is not in the window.
    expect(asks[0]!.prompt).not.toContain('now list it');
    await ui.unmount();
  });
  test('one answered turn: ONE call writes the line for the band and the suggestion for the prompt box, as a plugin\'s', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'LINE: Fixy likes that.\nNEXT: run the tests' } });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.completes.length).toBe(1);
    expect(w.completes[0]?.system).toContain('You are Fixy, a test fixture.');
    expect(w.completes[0]?.system).toContain('LINE:');
    expect(w.completes[0]?.system).toContain('NEXT:');
    expect(await shows(ui, /Fixy likes that\./)).toBe(true);
    expect(w.suggested).toEqual(['run the tests']);
    expect(w.origins).toEqual(['plugin']);
    await ui.unmount();
  });
  test('a shown suggestion is remembered as one: the next question\'s prompt carries it, kept in the store', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: 'LINE: Fixy likes that.\nNEXT: run the tests' }, { isAnswered: true, text: 'I said run the tests.' }] });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.suggested).toEqual(['run the tests']);
    await $.command.run(run('what was your last suggestion?'));
    await w.clock.settle();
    expect(w.completes).toHaveLength(2);
    expect(w.completes[1]!.prompt).toContain('Fixy: Fixy likes that.\nFixy suggested your next prompt: run the tests\n');
    const stored = w.saved.get(`memory:${SESSION}`) as { characters: Record<string, unknown[]> };
    expect(stored.characters.fixy).toContainEqual({ kind: 'suggestion', text: 'run the tests' });
    await ui.unmount();
  });
  test('the engine\'s own suggestion is held while the call runs; with NEXT: NONE it is shown after all, and a later one passes', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'LINE: All done here.\nNEXT: NONE' }, completeDelayMs: 5_000 });
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
  test('a held /buddy answer keeps the bubble over the turn\'s line, and the suggestion still goes out', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: 'Forty-two, friend.' }, { isAnswered: true, text: 'LINE: Should not show.\nNEXT: commit this' }] });
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ring(w: { saved: Map<string, unknown> }, id: string): any[] {
  return (w.saved.get(`memory:${SESSION}`) as { characters: Record<string, unknown[]> } | undefined)?.characters[id] ?? [];
}

describe('the end-of-turn call, turn by turn', () => {
  test('two turns 5 s apart: both lines are drawn, and both remembered', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: 'LINE: First line.\nNEXT: NONE' }, { isAnswered: true, text: 'LINE: Second line.\nNEXT: NONE' }] });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'One.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(await shows(ui, /First line\./)).toBe(true);
    await w.clock.advance(5_000);
    await $.turn.complete({ reason: 'answer', answer: 'Two.', isAborted: false, turnId: 't2' } as never);
    await w.clock.settle();
    expect(await shows(ui, /Second line\./)).toBe(true);
    expect(ring(w, 'fixy')).toContainEqual({ kind: 'quip', text: 'First line.' });
    expect(ring(w, 'fixy')).toContainEqual({ kind: 'quip', text: 'Second line.' });
    expect(records(w).filter((r) => r.event === 'quip.outcome').map((r) => r.outcome)).toEqual(['answered', 'answered']);
    await ui.unmount();
  });

  test('a character picked while the call runs never says the line nor files it; the suggestion stays the asker\'s', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'LINE: Fixy likes that.\nNEXT: run the tests' }, completeDelayMs: 5_000 }, { files: { [CONFIG]: config() } });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await $.command.run(menu());
    const pane = await paneOf($);
    await pane.press({ key: 'use:duck' });
    await w.clock.settle();
    await pane.unmount();
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect(w.completes[0]?.system).toContain('You are Fixy, a test fixture.');
    expect(await shows(ui, /Fixy likes that\./)).toBe(false);
    expect(ring(w, 'duck')).not.toContainEqual({ kind: 'quip', text: 'Fixy likes that.' });
    expect(ring(w, 'fixy')).toContainEqual({ kind: 'suggestion', text: 'run the tests' });
    expect(records(w).find((r) => r.event === 'quip.outcome')).toMatchObject({ outcome: 'dropped', asker: 'fixy', drawn: 'duck' });
    await ui.unmount();
  });

  test('/clear forgets the chat: the next call reads none of it, and a call in flight shows nothing', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'LINE: Old news.\nNEXT: old step' }, completeDelayMs: 5_000 });
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
    expect(last).toContain('The user asked Claude:\nfirst ask\n\nClaude answered:\nfirst reply');
    expect(last).toContain('The user asked Claude:\nsecond ask\n\nClaude answered:\nsecond reply');
    await ui.unmount();
  });

  test('a next turn that ends aborted makes the call in flight stale: no line, no suggestion, and the engine\'s own passes', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'LINE: Late line.\nNEXT: late step' }, completeDelayMs: 5_000 });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await $.turn.complete({ reason: 'aborted', answer: '', isAborted: true, turnId: 't2' } as never);
    expect(await $.prompt.suggest({ text: 'engine step', origin: { kind: 'suggestion' } } as never)).toMatchObject({ isShown: true });
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect(await shows(ui, /Late line\./)).toBe(false);
    expect(w.suggested).toEqual(['engine step']);
    expect(records(w).filter((r) => r.event === 'quip.outcome' || r.event === 'suggest.outcome').map((r) => r.outcome)).toEqual(['stale', 'stale']);
    await ui.unmount();
  });

  test('after a turn that makes no call (an error), the engine\'s own suggestion passes, even after the buddy\'s was shown', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'LINE: Fine.\nNEXT: run the tests' } });
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

  test('before the band ever drew, a turn pays for no line and remembers none; the suggestion still comes, carrying the call\'s usage', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'LINE: Unseen.\nNEXT: run the tests' } });
    await $.session.start(START);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await w.clock.settle();
    expect(w.completes).toHaveLength(1);
    expect(w.completes[0]!.system).not.toContain('LINE:');
    expect(w.suggested).toEqual(['run the tests']);
    expect(ring(w, 'fixy')).not.toContainEqual({ kind: 'quip', text: 'Unseen.' });
    expect(records(w).find((r) => r.event === 'turn.call')).toMatchObject({ line: false, next: true });
    expect(records(w).find((r) => r.event === 'quip.outcome')).toBeUndefined();
    expect(records(w).find((r) => r.event === 'suggest.outcome')).toMatchObject({ outcome: 'shown', inTok: 1, outTok: 1 });
  });
});

describe('a question\'s one deadline', () => {
  test('the thinking line shows at once, while the memory read still waits', async ($, on) => {
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

  test('a memory read that never ends still ends the question at 90 s, frees the slot, and no longer blocks later reads', { timeoutMs: 20_000 }, async ($, on) => {
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
    expect(w.logs.filter((l) => l.includes('reading the memory failed: no answer in 90 s'))).toHaveLength(1);
    w.slow.sessionIdMs = 0;
    await $.command.run(run('and after it?'));
    // Behind it only the last question's write, itself hung, abandoned at its own 30 s.
    await w.clock.advance(31_000);
    await w.clock.settle();
    expect(w.completes).toHaveLength(1);
    expect(await shows(ui, /A completed answer\./)).toBe(true);
    await ui.unmount();
  });

  test('old sessions\' memory is pruned beside the first read, never on its path', async ($, on) => {
    const w = world(on, { character: 'fixy', 'memory:old-session': { at: 1, characters: {} } });
    // Listing the store never ends: the first memory read (the greeting's, once the band draws) must not wait on it.
    w.slow.keysMs = 1_000_000;
    await $.session.start(START);
    const ui = await band($);
    await $.command.run(run('what is up'));
    await w.clock.settle();
    expect(w.completes).toHaveLength(1);
    expect(await shows(ui, /A completed answer\./)).toBe(true);
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
    expect(last).toContain('The user asked Claude:\nsecond ask\n\nClaude answered:\nsecond reply');
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
    expect(last).toContain('The user asked Claude:\nnew ask\n\nClaude answered:\nnew reply');
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
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: 'Still here.' }, { isAnswered: true, text: 'LINE: ok\nNEXT: NONE' }], completeDelayMs: 5_000 });
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

  test('a suggestion overtaken by a started turn is logged stale, never proposed', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'LINE: Nice.\nNEXT: run the tests' }, completeDelayMs: 5_000 });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await $.turn.start({ text: 'go on', turnId: 't2' } as never);
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect(w.suggested).toEqual([]);
    expect(records(w).find((r) => r.event === 'suggest.outcome')).toMatchObject({ outcome: 'stale' });
    await ui.unmount();
  });

  test('the engine\'s suggestion held before the turn\'s end is shown when the end-of-turn call fails, never erased', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { queue: [{ isAnswered: true, text: 'LINE: Fine.\nNEXT: run the tests' }, { isAnswered: false, reason: 'api-error', status: 529 }] });
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
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'LINE: Late.\nNEXT: late step' }, completeDelayMs: 40_000 });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    expect(await $.prompt.suggest({ text: 'engine step', origin: { kind: 'suggestion' } } as never)).toMatchObject({ isShown: false });
    await w.clock.advance(30_000);
    await w.clock.settle();
    expect(w.suggested).toEqual(['engine step']);
    expect(records(w).find((r) => r.event === 'suggest.outcome')).toMatchObject({ outcome: 'failed', reason: 'timeout' });
    await w.clock.advance(10_000);
    await w.clock.settle();
    await ui.unmount();
  });

  test('/buddy off during the end-of-turn call: the line is not shown nor remembered, the suggestion not proposed', async ($, on) => {
    const w = world(on, { character: 'fixy' }, { complete: { isAnswered: true, text: 'LINE: Unseen line.\nNEXT: run the tests' }, completeDelayMs: 5_000 });
    await $.session.start(START);
    const ui = await band($);
    await $.turn.complete({ reason: 'answer', answer: 'Done.', isAborted: false, turnId: 't1' } as never);
    await $.command.run(run('off'));
    await w.clock.advance(5_000);
    await w.clock.settle();
    expect(w.suggested).toEqual([]);
    expect(ring(w, 'fixy')).not.toContainEqual({ kind: 'quip', text: 'Unseen line.' });
    expect(records(w).filter((r) => r.event === 'quip.outcome' || r.event === 'suggest.outcome').map((r) => r.outcome)).toEqual(['hidden', 'stale']);
    await ui.unmount();
  });
});
