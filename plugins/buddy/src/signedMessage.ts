// Cross-chat messages end with “ — sid <8 hex digits> · to reply: chat_inject <peer> <message>”,
// optionally followed by a pasted_content closing tag; matched 183 of 183 signed messages and no typed prompt.
// The peer never spans another signature: a message quoting an earlier signed one is read by its own, last, signature.
export const SIGNED_MESSAGE = / — sid [0-9a-f]{8} · to reply: chat_inject (?:(?! — sid )[\s\S])*? <message>\s*(?:<\/pasted_content[^>]*>\s*)?$/;

export function isSignedMessage(text: string): boolean {
  return SIGNED_MESSAGE.test(text);
}

/** A signed message as release 1.1.0 stored it: its markup cleaned away, so the signature ends with the peer, `<message>` gone. */
const CLEANED_SIGNED_MESSAGE = / — sid [0-9a-f]{8} · to reply: chat_inject (?:(?! — sid )[^\n<>])+$/;

/** A signed message raw, or as an earlier release stored it with its `<message>` tag cleaned away: never text the user typed. */
export function isStoredSignedMessage(text: string): boolean {
  return isSignedMessage(text) || CLEANED_SIGNED_MESSAGE.test(text.trim());
}

/** SIGNED_MESSAGE's shape with its parts in groups: the session id, then the peer to reply to. */
const SIGNED_PARTS = / — sid ([0-9a-f]{8}) · to reply: chat_inject ((?:(?! — sid )[\s\S])*?) <message>\s*(?:<\/pasted_content[^>]*>\s*)?$/;

/** A signed cross-chat message's parts: its body (the text before the signature, raw), its session id and the peer it came from; null for any other text. */
export function signedOf(text: string): { body: string; sid: string; peer: string } | null {
  const m = SIGNED_PARTS.exec(text);
  return m ? { body: text.slice(0, m.index), sid: m[1]!, peer: m[2]!.trim() } : null;
}
