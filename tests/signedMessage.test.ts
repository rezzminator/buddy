import { describe, expect, test } from 'vitest';
import { isSignedMessage, isStoredSignedMessage, signedOf } from '../plugins/buddy/src/signedMessage.ts';

describe('a signed cross-chat message', () => {
  const signature = '  — sid 0123abcd · to reply: chat_inject peer-name <message>';
  test.each([
    ['bare', `Please run the tests.\n${signature}`],
    ['wrapped', `<pasted_content id="x">Please run the tests.\n${signature}</pasted_content id="x">`],
    ['trailing whitespace', `Please run the tests.\n${signature}\n  `],
  ])('%s is signed', (_, text) => {
    expect(isSignedMessage(text)).toBe(true);
    expect(isSignedMessage(text)).toBe(true);
  });
  test.each([
    ['typed prompt', 'Please run the tests.'],
    ['quoting chat_inject', 'Explain how chat_inject peer-name <message> works.'],
    ['signature mid-text', `${signature}\nMore text after the signature.`],
    ['blank prompt', '  '],
  ])('%s is not signed', (_, text) => {
    expect(isSignedMessage(text)).toBe(false);
  });
  test('signedOf: the body before the signature, the session id and the peer', () => {
    expect(signedOf(`Please run the tests.\n${signature}`)).toEqual({ body: 'Please run the tests.\n ', sid: '0123abcd', peer: 'peer-name' });
    expect(signedOf(`<pasted_content id="x">Do it.${signature}</pasted_content id="x">\n`)).toEqual({ body: '<pasted_content id="x">Do it. ', sid: '0123abcd', peer: 'peer-name' });
  });
  test('signedOf: null wherever isSignedMessage is false', () => {
    for (const text of ['Please run the tests.', 'Explain how chat_inject peer-name <message> works.', `${signature}\nMore text after the signature.`, '  ']) {
      expect(signedOf(text)).toBeNull();
    }
  });
  test('a signed message quoting an earlier one is read by its own, last, signature: the quote stays in the body', () => {
    const quoted = `Re: Ship it.  — sid aaaaaaaa · to reply: chat_inject old-peer <message>\nNo, wait for CI.${signature}`;
    expect(isSignedMessage(quoted)).toBe(true);
    expect(signedOf(quoted)).toEqual({ body: 'Re: Ship it.  — sid aaaaaaaa · to reply: chat_inject old-peer <message>\nNo, wait for CI. ', sid: '0123abcd', peer: 'peer-name' });
  });
  test('isStoredSignedMessage: the raw form, or one stored with its <message> tag cleaned away; never a plain prompt', () => {
    expect(isStoredSignedMessage(`Please run the tests.\n${signature}`)).toBe(true);
    expect(isStoredSignedMessage('Please run the tests. — sid 0123abcd · to reply: chat_inject peer-name')).toBe(true);
    expect(isStoredSignedMessage('Please run the tests. — sid 0123abcd · to reply: chat_inject peer-name  ')).toBe(true);
    for (const text of ['Please run the tests.', 'Explain how chat_inject peer-name works.', 'x — sid 0123abcd · to reply: chat_inject peer-name\nMore after it.']) {
      expect(isStoredSignedMessage(text)).toBe(false);
    }
  });
});
