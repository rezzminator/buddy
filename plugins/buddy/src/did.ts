// What a main turn did, as the buddy remembers it: one short line per step,
// never a tool's output or a diff. A shell command is its own description
// (Claude writes one for nearly every Bash call); a file tool is its verb and
// the file's name, one entry per verb listing every file; bookkeeping tools
// (tasks, tool search, wakeups) are dropped. No I/O: the adapter hands each
// main-loop tool call to actionOf, the brain keeps the turn's actions, and
// didOf folds them when the turn is remembered. A failed or denied step says
// why in one redacted line (failureReason, denialReason), its own file step
// never gathered under the verb; background work says it reports back later.

/** The most steps kept of one turn: past it the first few and the last stay, the middle is counted. */
export const DID_MAX = 12;
/** The first steps kept when a turn has more than DID_MAX. */
export const DID_HEAD = 4;
/** How long one step may be. */
export const DID_TEXT_CAP = 80;
/** How many files one verb names before the rest are counted. */
export const DID_FILES_MAX = 6;
/** How long the reason of a failed or denied step may be. */
export const FAIL_REASON_CAP = 90;
/** How long one stored step may be: its text, then its failure marker whole. */
export const DID_LINE_CAP = DID_TEXT_CAP + FAIL_REASON_CAP + 12;
/** How long an undescribed shell command may be as a step. */
export const SHORT_COMMAND_CAP = 72;

/**
 * One step: a line of its own (`fail`, the rendered `failed: …` or `denied: …`,
 * kept outside the step's cap), or a file under a verb, gathered with the
 * turn's other files under that verb.
 */
export type Action = { text: string; fail?: string } | { verb: FileVerb; file: string };
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

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

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

/**
 * Why a failed tool call failed, from its output: colors gone, the first line
 * that names an error (else the last line), after `exit N: ` when the output
 * gave an exit code; one line, redacted, at most FAIL_REASON_CAP. Empty for
 * an empty output.
 */
export function failureReason(output: string): string {
  let exit: string | null = null;
  const lines = output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').split('\n').map((l) => l.trim()).filter((l) => {
    const m = /^exit code (\d+)$/i.exec(l);
    if (m) exit = m[1] ?? null;
    return l !== '' && !m;
  });
  const line = lines.find((l) => /error|fail|fatal|denied|not found|no such|cannot|can't|refused|invalid|exception|traceback|panic/i.test(l)) ?? lines.at(-1) ?? '';
  const reason = exit === null ? line : line ? `exit ${exit}: ${line}` : `exit ${exit}`;
  return cut(redact(oneSpaced(reason)), FAIL_REASON_CAP);
}

/**
 * A main-loop tool call as one step: `call` the tool.call event (its tool and
 * arguments, flat), `failure` why it errored or was denied, null when it did
 * its work. Null for a bookkeeping tool, or a file tool with no file.
 */
export function actionOf(call: { tool: string; [argument: string]: unknown }, failure: Failure | null): Action | null {
  const fail = failure ? (failure.reason ? `${failure.kind}: ${failure.reason}` : failure.kind) : undefined;
  const text = (t: string): Action | null => (t ? (fail === undefined ? { text: t } : { text: t, fail }) : null);
  const file = (verb: FileVerb, f: string): Action | null => (!f ? null : fail === undefined ? { verb, file: f } : text(`${INFINITIVE[verb]} ${f}`));
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
    case 'Task':
      if (background) return text(str(call.description) ? `agent in the background (reports back later): ${str(call.description)}` : 'ran an agent in the background');
      return text(str(call.description) ? `agent: ${str(call.description)}` : 'ran an agent');
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

/**
 * The turn's steps as the buddy reads them, in order: a file verb once, where
 * its first file came, naming each file once; a step said twice in a row
 * (its failure too) once; each at most DID_TEXT_CAP, a failure marker after
 * the cut, whole; past DID_MAX the first DID_HEAD and the last stay around a
 * count of the rest.
 */
export function didOf(actions: readonly Action[]): string[] {
  const files = new Map<FileVerb, string[]>();
  const order: Action[] = [];
  for (const a of actions) {
    if ('verb' in a) {
      const list = files.get(a.verb);
      if (!list) {
        files.set(a.verb, [a.file]);
        order.push(a);
      } else if (!list.includes(a.file)) list.push(a.file);
    } else {
      const last = order.at(-1);
      if (!last || !('text' in last) || last.text !== a.text || last.fail !== a.fail) order.push(a);
    }
  }
  const lines = order.map((o) => {
    if ('text' in o) return cut(o.text, DID_TEXT_CAP) + (o.fail ? ` (${o.fail})` : '');
    const list = files.get(o.verb) ?? [];
    const more = list.length > DID_FILES_MAX ? ` +${list.length - DID_FILES_MAX}` : '';
    return cut(`${o.verb} ${list.slice(0, DID_FILES_MAX).join(', ')}${more}`, DID_TEXT_CAP);
  });
  if (lines.length <= DID_MAX) return lines;
  const tail = DID_MAX - DID_HEAD - 1;
  return [...lines.slice(0, DID_HEAD), `… ${lines.length - DID_HEAD - tail} more`, ...lines.slice(-tail)];
}
