// What a main turn did, as the buddy remembers it: one short line per step,
// never a tool's output or a diff. A shell command is its own description
// (Claude writes one for nearly every Bash call); a file tool is its verb and
// the file's name, one entry per verb listing every file; bookkeeping tools
// (tasks, tool search, wakeups) are dropped. No I/O: the adapter hands each
// main-loop tool call to actionOf, the brain keeps the turn's actions, and
// didOf folds them when the turn is remembered. A failed or denied step says
// why in one redacted line (failureReason, denialReason), its own file step
// never gathered under the verb; background work says it reports back later.
// Each step carries its call's and its output's size, as the user sees them
// scroll by; an agent's brief and report, cut, ride with its step. Every cut
// is marked `[cut]` (src/cuts.ts).

import { CUT, cutBrief, cutReport } from './cuts.ts';
import { count, span } from './stats.ts';

/** The most steps kept of one turn: past it the first few and the last stay, the middle is counted. */
export const DID_MAX = 12;
/** The first steps kept when a turn has more than DID_MAX. */
export const DID_HEAD = 4;
/** How long one step may be. */
export const DID_TEXT_CAP = 120;
/** How many files one verb names before the rest are counted. */
export const DID_FILES_MAX = 6;
/** How long the reason of a failed or denied step may be. */
export const FAIL_REASON_CAP = 90;
/** The longest size mark of a step: ` [call {count} · output {count} chars]`. */
export const SIZE_MARK_MAX = 40;
/** How long one stored step may be: its text, its size mark, then its failure marker whole. */
export const DID_LINE_CAP = DID_TEXT_CAP + SIZE_MARK_MAX + FAIL_REASON_CAP + 12;
/** How long an undescribed shell command may be as a step. */
export const SHORT_COMMAND_CAP = 110;

/** A tool call's size in characters: its arguments (callSize) and its whole output. */
export type Size = { call: number; output: number };

/**
 * One step: a line of its own (`fail`, the rendered `failed: …` or `denied: …`,
 * kept outside the step's cap; `brief`, an agent's brief, cutBrief; `returned`,
 * what a sync agent returned), or a file under a verb, gathered with the
 * turn's other files under that verb; either with its call's `size`.
 */
export type Action = { text: string; fail?: string; returned?: string; size?: Size; brief?: string } | { verb: FileVerb; file: string; size?: Size };
export type FileVerb = 'read' | 'edited' | 'wrote' | 'searched';
/** Why a step did not do its work: it errored (`failed`) or was refused (`denied`); `reason` one line, redacted, maybe empty. */
export type Failure = { kind: 'failed' | 'denied'; reason: string };

/** A failed or denied file tool's verb, in the infinitive: it did not happen. */
const INFINITIVE: Record<FileVerb, string> = { read: 'read', edited: 'edit', wrote: 'write', searched: 'search' };

/** Tools that say nothing of the work: the buddy never hears of them. */
const BOOKKEEPING: readonly string[] = [
  'ToolSearch', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop', 'TaskOutput', 'TodoWrite',
  'Monitor', 'ScheduleWakeup', 'ReadNotifications', 'ListAgents', 'EnterWorktree', 'ExitWorktree', 'EnterPlanMode', 'KillShell', 'BashOutput',
];

const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const fileName = (v: unknown): string => str(v).replace(/\/+$/, '').split('/').pop() ?? '';

/** `s` at most `n` characters: past it, its start and a ` [cut]` mark, `n` in all. */
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - CUT.length - 1)} ${CUT}` : s);

/**
 * A shell command without its leading `cd`s, every path cut to its last part
 * (a path starts at a word's start, so nothing before it is glued on; a URL
 * stays whole; a lone `/tmp` stays), at most SHORT_COMMAND_CAP characters.
 */
function shortCommand(command: string): string {
  const c = command
    .replace(/^(cd \S+ *(&&|;) *)+/, '')
    .replace(/(?<![\w.~:/-])[\w.~-]*(?:\/[\w.~-]+)+\/?/g, (path) => (/^\/[\w.~-]+\/?$/.test(path) ? path : (path.replace(/\/+$/, '').split('/').pop() ?? path)));
  return cut(c, SHORT_COMMAND_CAP);
}

/** Secrets a reason must never carry, each to `[redacted]`. */
const SECRETS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g, /gh[pousr]_[A-Za-z0-9]{20,}/g, /xox[baprs]-[A-Za-z0-9-]+/g, /AKIA[0-9A-Z]{16}/g, /eyJ[\w-]{10,}\.[\w-]+\.[\w-]+/g,
];

/** `text` with API keys, tokens and `password=`-style values replaced by `[redacted]`. */
export function redact(text: string): string {
  return SECRETS.reduce((t, re) => t.replace(re, '[redacted]'), text)
    .replace(/(password|passwd|token|secret|api[_-]?key)(\s*[:=]\s*)\S+/gi, '$1$2[redacted]');
}

const oneSpaced = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** A denial's reason (the hook's or the user's words) as a step carries it: one line, redacted, at most FAIL_REASON_CAP. */
export function denialReason(deny: string): string {
  return cut(redact(oneSpaced(deny)), FAIL_REASON_CAP);
}

/** A command's segments split at `&&`, `||`, `;`, `|` and newlines outside quotes, each with the separator before it. */
function segments(command: string): { sep: string; text: string }[] {
  const out: { sep: string; text: string }[] = [];
  let sep = '';
  let text = '';
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = '';
      text += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      text += c;
    } else {
      const two = command.slice(i, i + 2);
      const s = two === '&&' || two === '||' ? two : c === ';' || c === '|' || c === '\n' ? c : '';
      if (!s) text += c;
      else {
        out.push({ sep, text: text.trim() });
        sep = s;
        text = '';
        i += s.length - 1;
      }
    }
  }
  out.push({ sep, text: text.trim() });
  return out.filter((g) => g.text !== '');
}

const CHECK = /^(?:grep|test|diff|cmp|\[\[?)(?:\s|$)/;
const PRINTS = /^(?:echo|printf|cat|head|tail)(?:\s|$)/;

/**
 * The check a command ends on, whose exit 1 means "not found" or "not true"
 * rather than a failure: its last segment when that is `grep`, `test`,
 * `[ … ]`, `[[ … ]]`, `diff` or `cmp`, or such a check right before a final
 * `&&` that only prints (`[ $rc -ne 0 ] && tail log`). Null for any other command.
 */
function lastCheck(command: string): string | null {
  const g = segments(command);
  const last = g.at(-1);
  if (!last) return null;
  if (CHECK.test(last.text)) return last.text;
  const before = g.at(-2);
  return last.sep === '&&' && PRINTS.test(last.text) && before && CHECK.test(before.text) ? before.text : null;
}

/**
 * Why a failed tool call failed, from its output: colors gone, the first line
 * that names an error (else the last line), after `exit N: ` when the output
 * gave an exit code; one line, redacted, at most FAIL_REASON_CAP. Empty for
 * an empty output. Given the Bash `command`, an exit 1 from the check it ends
 * on (lastCheck) reads `exit 1 from its last check (`{check, cut to 40}`)`.
 */
export function failureReason(output: string, command = ''): string {
  let exit: string | null = null;
  const lines = output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').split('\n').map((l) => l.trim()).filter((l) => {
    const m = /^exit code (\d+)$/i.exec(l);
    if (m) exit = m[1] ?? null;
    return l !== '' && !m;
  });
  const line = lines.find((l) => /error|fail|fatal|denied|not found|no such|cannot|can't|refused|invalid|exception|traceback|panic/i.test(l)) ?? lines.at(-1) ?? '';
  const check = exit === '1' ? lastCheck(command) : null;
  const head = check === null ? (exit === null ? '' : `exit ${exit}`) : `exit 1 from its last check (\`${cut(oneSpaced(check), 40)}\`)`;
  const reason = !head ? line : line ? `${head}: ${line}` : head;
  return cut(redact(oneSpaced(reason)), FAIL_REASON_CAP);
}

/** The keys of a tool.call event that are not the tool's own arguments. */
const NOT_ARGUMENTS: readonly string[] = ['tool', 'tool_use_id', 'agentId'];

/** A tool call's size: the length of its arguments as JSON, without the event's own keys. */
export function callSize(call: Record<string, unknown>): number {
  return JSON.stringify(Object.fromEntries(Object.entries(call).filter(([k]) => !NOT_ARGUMENTS.includes(k)))).length;
}

/** What an agent's run cost, as far as it is known: its tokens, its tool uses, its time. */
export type AgentUsage = { tokens?: number; toolUses?: number; ms?: number };

const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const usage = (tokens?: number, toolUses?: number, ms?: number): AgentUsage | null => {
  const u: AgentUsage = { ...(tokens === undefined ? {} : { tokens }), ...(toolUses === undefined ? {} : { toolUses }), ...(ms === undefined ? {} : { ms }) };
  return Object.keys(u).length > 0 ? u : null;
};

/**
 * An agent's usage: the Agent tool result's typed `totalTokens`,
 * `totalToolUseCount` and `totalDurationMs` first; else the `<usage>` block of
 * its text, in the tag form (`<subagent_tokens>`, `<tool_uses>`,
 * `<duration_ms>`) or as `total_tokens: N` lines. Null when neither says.
 */
export function agentUsageOf(result: unknown, text: string): AgentUsage | null {
  const r = typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
  const typed = usage(finite(r.totalTokens), finite(r.totalToolUseCount), finite(r.totalDurationMs));
  if (typed) return typed;
  const block = /<usage>([\s\S]*?)<\/usage>/.exec(text)?.[1];
  if (block === undefined) return null;
  const field = (tag: string, line: string): number | undefined => {
    const m = new RegExp(`<${tag}>\\s*(\\d+)\\s*</${tag}>`).exec(block) ?? new RegExp(`\\b${line}:\\s*(\\d+)`).exec(block);
    return m ? Number(m[1]) : undefined;
  };
  return usage(field('subagent_tokens', 'total_tokens'), field('tool_uses', 'tool_uses'), field('duration_ms', 'duration_ms'));
}

/** An agent's usage as the buddy reads it: `{tokens} tokens · {n} tool uses · {span}`, the parts known; '' when none is. */
export function agentUsageText(u: AgentUsage | null): string {
  if (!u) return '';
  return [u.tokens === undefined ? '' : `${count(u.tokens)} tokens`, u.toolUses === undefined ? '' : `${u.toolUses} tool uses`, u.ms === undefined ? '' : span(u.ms)].filter(Boolean).join(' · ');
}

/** An agent's step text: its description after `agent: ` or the background form, '' for one launched without a description. */
const AGENT_STEP = /^agent(?: in the background \(reports back later\))?: (.*)$/;

/**
 * A main-loop tool call as one step: `call` the tool.call event (its tool and
 * arguments, flat), `failure` why it errored or was denied, null when it did
 * its work; `output` its text (an agent's whole report); `seen` its size
 * and its typed result. Null for a bookkeeping tool, or a file tool with no file.
 */
export function actionOf(call: { tool: string; [argument: string]: unknown }, failure: Failure | null, output = '', seen: { size?: Size; result?: unknown } = {}): Action | null {
  const fail = failure ? (failure.reason ? `${failure.kind}: ${failure.reason}` : failure.kind) : undefined;
  const sized = seen.size ? { size: seen.size } : {};
  const text = (t: string): Action | null => (t ? (fail === undefined ? { text: t, ...sized } : { text: t, fail, ...sized }) : null);
  const file = (verb: FileVerb, f: string): Action | null => (!f ? null : fail === undefined ? { verb, file: f, ...sized } : text(`${INFINITIVE[verb]} ${f}`));
  const background = call.run_in_background === true;
  switch (call.tool) {
    case 'Bash': {
      const t = str(call.description) || (str(call.command) ? `ran ${shortCommand(str(call.command))}` : '');
      return text(t && background ? `${t} (in the background, reports back later)` : t);
    }
    case 'Read':
      return file('read', fileName(call.file_path));
    case 'Edit':
    case 'MultiEdit':
      return file('edited', fileName(call.file_path));
    case 'NotebookEdit':
      return file('edited', fileName(call.notebook_path));
    case 'Write':
      return file('wrote', fileName(call.file_path));
    case 'Grep':
    case 'Glob':
      return file('searched', str(call.pattern).slice(0, 40));
    case 'Agent':
    case 'Task': {
      const name = str(call.description);
      // The brief keeps its lines: its first is the ask, its last what the agent must return.
      const brief = typeof call.prompt === 'string' ? cutBrief(call.prompt.trim()) : '';
      const briefed = (a: Action | null): Action | null => (a && brief && 'text' in a ? { ...a, brief } : a);
      // Launched async by its flag or by the harness: its result is only the launch acknowledgement, its report comes back as a task notification.
      if (background || /^Async agent launched/.test(output.trimStart())) return briefed(text(name ? `agent in the background (reports back later): ${name}` : 'ran an agent in the background'));
      const step = briefed(text(name ? `agent: ${name}` : 'ran an agent'));
      const report = fail === undefined ? agentReport(output) : '';
      if (!step || !report) return step;
      const used = agentUsageText(agentUsageOf(seen.result, output));
      return { ...step, returned: `“${name || 'an agent'}” returned (${used ? `${used} · ` : ''}report ${count(report.length)} chars): ${cutReport(report)}` };
    }
    case 'Skill':
      return text(`skill ${str(call.skill)}`.trim());
    case 'WebSearch':
      return text(`searched the web: ${str(call.query).slice(0, 60)}`);
    case 'WebFetch':
      return text(`fetched ${str(call.url).replace(/^https?:\/\/([^/]+).*$/, '$1')}`);
    case 'SendMessage':
      return text(`messaged ${str(call.to) || str(call.recipient) || 'an agent'}`);
    case 'AskUserQuestion':
      return text('asked the user');
  }
  if (BOOKKEEPING.includes(call.tool)) return null;
  // An MCP tool by its own name, its server dropped: mcp__professor__chat_new is "chat new".
  if (call.tool.startsWith('mcp__')) return text(call.tool.split('__').slice(2).join(' ').replace(/_/g, ' '));
  return text(call.tool);
}

/** An agent's report without the resume pointer and usage block the harness appends after it. */
function agentReport(output: string): string {
  const resume = output.search(/^agentId: /m);
  return (resume === -1 ? output : output.slice(0, resume)).replace(/<usage>[\s\S]*?<\/usage>/g, '').trim();
}

/** What the turn's agents returned, in order: the user sees it in the main chat, so the buddy does; their own calls it never hears of. */
export function returnedOf(actions: readonly Action[]): string[] {
  return actions.flatMap((a) => ('returned' in a && a.returned ? [a.returned] : []));
}

/** The briefs the turn's agents were given, in order, each `“{description}”: {brief}`. */
export function briefedOf(actions: readonly Action[]): string[] {
  return actions.flatMap((a) => ('brief' in a && a.brief ? [`“${AGENT_STEP.exec(a.text)?.[1] || 'an agent'}”: ${a.brief}`] : []));
}

/** A step's size mark: ` [call {count} · output {count} chars]`. */
function sizeMark(s: Size | undefined): string {
  return s ? ` [call ${count(s.call)} · output ${count(s.output)} chars]` : '';
}

/** Two sizes summed; either may be missing, both missing is none. */
function plus(a: Size | undefined, b: Size | undefined): Size | undefined {
  return a && b ? { call: a.call + b.call, output: a.output + b.output } : (a ?? b);
}

/**
 * The turn's steps as the buddy reads them, in order: a file verb once, where
 * its first file came, naming each file once; a step said twice in a row
 * (its failure too) once; each at most DID_TEXT_CAP, then its size mark (the
 * sum of its merged calls, when any had a size) and a failure marker after
 * the cut, whole; past DID_MAX the first DID_HEAD and the last stay around a
 * `[cut: N more steps]` count of the rest.
 */
export function didOf(actions: readonly Action[]): string[] {
  const files = new Map<FileVerb, { list: string[]; size?: Size }>();
  const order: ({ verb: FileVerb } | { text: string; fail?: string; size?: Size })[] = [];
  for (const a of actions) {
    if ('verb' in a) {
      const group = files.get(a.verb);
      if (!group) {
        files.set(a.verb, { list: [a.file], ...(a.size ? { size: a.size } : {}) });
        order.push({ verb: a.verb });
      } else {
        if (!group.list.includes(a.file)) group.list.push(a.file);
        group.size = plus(group.size, a.size);
      }
    } else {
      const last = order.at(-1);
      if (last && 'text' in last && last.text === a.text && last.fail === a.fail) last.size = plus(last.size, a.size);
      else order.push({ text: a.text, ...(a.fail === undefined ? {} : { fail: a.fail }), ...(a.size ? { size: a.size } : {}) });
    }
  }
  const lines = order.map((o) => {
    if ('text' in o) return cut(o.text, DID_TEXT_CAP) + sizeMark(o.size) + (o.fail ? ` (${o.fail})` : '');
    const group = files.get(o.verb)!;
    const more = group.list.length > DID_FILES_MAX ? ` +${group.list.length - DID_FILES_MAX}` : '';
    return cut(`${o.verb} ${group.list.slice(0, DID_FILES_MAX).join(', ')}${more}`, DID_TEXT_CAP) + sizeMark(group.size);
  });
  if (lines.length <= DID_MAX) return lines;
  const tail = DID_MAX - DID_HEAD - 1;
  const k = lines.length - DID_HEAD - tail;
  return [...lines.slice(0, DID_HEAD), `[cut: ${k} more step${k === 1 ? '' : 's'}]`, ...lines.slice(-tail)];
}
