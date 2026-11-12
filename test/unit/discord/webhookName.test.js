import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toWebhookName } from '../../../src/discord/webhookName.js';

const MAX = 80;

const CASES = [
  ['a plain display name', ['Bobbo', 'bob'], 'Bobbo'],
  ['an empty display name falls back to the username', ['', 'bob'], 'bob'],
  ['a blank display name falls back to the username', ['   ', 'bob'], 'bob'],
  ['a forbidden word, any case', ['Discord Dan', 'dan'], 'dan'],
  ['clyde in the middle', ['xxCLYDExx', 'cly'], 'cly'],
  ['both forbidden', ['Clyde', 'discordguy'], null],
  ['both empty', ['', ''], null],
  ['a missing display name', [undefined, 'bob'], 'bob'],
];

CASES.forEach(([title, [display, username], expected]) => {
  test(`toWebhookName: ${title}`, () => {
    assert.equal(toWebhookName(display, username, MAX), expected);
  });
});

test('cuts to the maximum number of code points and never splits a surrogate pair', () => {
  assert.equal(toWebhookName('a'.repeat(100), 'x', MAX), 'a'.repeat(80));
  const emoji = '😀'.repeat(100);
  const cut = toWebhookName(emoji, 'x', MAX);
  assert.equal(Array.from(cut).length, 80);
  assert.equal(cut, '😀'.repeat(80));
});

test('a forbidden word that only appears after the cut is allowed', () => {
  assert.equal(toWebhookName(`${'a'.repeat(5)}discord`, 'x', 5), 'aaaaa');
});

test('a username is cut the same way', () => {
  assert.equal(toWebhookName('', 'u'.repeat(10), 4), 'uuuu');
});

test('toWebhookName cuts by code points and never leaves half an emoji', () => {
  const name = toWebhookName(`${'a'.repeat(79)}\u{1F600}\u{1F600}`, 'bob', MAX);
  assert.equal(name, `${'a'.repeat(79)}\u{1F600}`);
});
