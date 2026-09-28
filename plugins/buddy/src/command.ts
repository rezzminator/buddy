// `/buddy ...` parsed: alone it opens the drawer; a bare word is a command
// only when it stands alone, so "reload the page" is a question, not /buddy
// reload. Petting is the drawer's button, never typed.

export type Action =
  | { kind: 'drawer' }
  | { kind: 'pet' }
  | { kind: 'off' }
  | { kind: 'on' }
  | { kind: 'reload' }
  | { kind: 'help' }
  | { kind: 'log' }
  /** `/buddy list` or `/buddy use {id}`, from 0.1.0: switching lives in the drawer's personality tab now. */
  | { kind: 'moved' }
  | { kind: 'question'; text: string };

export const USAGE = [
  '/buddy               open or fold the drawer: your buddy, your thread with it, its personalities',
  '/buddy {question}    ask your buddy',
  '/buddy off | on      hide or show (remembered)',
  '/buddy reload        rescan the character files',
  '/buddy help          this text',
  '/buddy log           the log file\'s path and its last 20 lines, to paste into an issue',
  'In the drawer: ctrl+x tab steps in, ←→ move, ↑↓ scroll, Enter presses, ctrl+x x closes.',
].join('\n');

const WORDS: Record<string, Action> = {
  off: { kind: 'off' },
  on: { kind: 'on' },
  reload: { kind: 'reload' },
  help: { kind: 'help' },
  log: { kind: 'log' },
};

export function parseCommand(args: string): Action {
  const text = args.trim();
  if (text === '') return { kind: 'drawer' };
  const words = text.split(/\s+/);
  const first = words[0]!.toLowerCase();
  if (words.length === 1) {
    const action = WORDS[first];
    if (action) return action;
  }
  if ((first === 'list' && words.length === 1) || (first === 'use' && words.length === 2)) return { kind: 'moved' };
  return { kind: 'question', text };
}
