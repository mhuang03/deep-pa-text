import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyGifResults, findGifTokens, limitGifTokens } from '../../../src/gifs/gifTokens.js';

test('findGifTokens returns nothing when there is no token', () => {
  assert.deepEqual(findGifTokens('no gifs here', 50), []);
});

test('findGifTokens parses one token', () => {
  assert.deepEqual(findGifTokens('yo <gif! funny cat>', 50), [{ match: '<gif! funny cat>', query: 'funny cat' }]);
});

test('findGifTokens parses several tokens in text order', () => {
  assert.deepEqual(findGifTokens('<gif!a> x <gif! b >', 50), [
    { match: '<gif!a>', query: 'a' },
    { match: '<gif! b >', query: 'b' },
  ]);
});

test('findGifTokens keeps duplicate tokens', () => {
  assert.equal(findGifTokens('<gif! a> <gif! a>', 50).length, 2);
});

test('findGifTokens trims first, then cuts without re-trimming', () => {
  const term = `${'x'.repeat(48)} ${'y'.repeat(11)}`;
  const [token] = findGifTokens(`<gif!  ${term}  >`, 50);
  assert.equal(token.query.length, 50);
  assert.equal(token.query, `${'x'.repeat(48)} y`);
  const [spaced] = findGifTokens(`<gif! ${'x'.repeat(49)} ${'y'.repeat(5)}>`, 50);
  assert.equal(spaced.query, `${'x'.repeat(49)} `);
});

test('findGifTokens honours the max length argument', () => {
  assert.equal(findGifTokens('<gif! abcdef>', 3)[0].query, 'abc');
});

test('applyGifResults removes a resolved token', () => {
  assert.equal(applyGifResults('yo <gif! cat>', [{ match: '<gif! cat>', url: 'u' }]), 'yo ');
});

test('applyGifResults turns an unresolved token into a placeholder', () => {
  assert.equal(
    applyGifResults('yo <gif! funny cat>', [{ match: '<gif! funny cat>', url: '' }]),
    'yo <INSERT GIF:  funny cat>',
  );
  assert.equal(applyGifResults('<gif!cat>', [{ match: '<gif!cat>', url: '' }]), '<INSERT GIF: cat>');
});

test('applyGifResults replaces only the first occurrence per link', () => {
  const text = '<gif! a> and <gif! a>';
  assert.equal(applyGifResults(text, [{ match: '<gif! a>', url: 'u' }]), ' and <gif! a>');
  const both = [{ match: '<gif! a>', url: 'u' }, { match: '<gif! a>', url: '' }];
  assert.equal(applyGifResults(text, both), ' and <INSERT GIF:  a>');
});

test('applyGifResults inserts replacement text literally', () => {
  const match = '<gif! $& $1 $$>';
  assert.equal(applyGifResults(`x ${match}`, [{ match, url: '' }]), 'x <INSERT GIF:  $& $1 $$>');
});

test('applyGifResults returns the text when a match is absent or there are no links', () => {
  assert.equal(applyGifResults('text', []), 'text');
  assert.equal(applyGifResults('text', [{ match: '<gif! z>', url: 'u' }]), 'text');
});

test('findGifTokens cuts the query by code points, never inside an emoji', () => {
  const [token] = findGifTokens(`<gif! ${'x'.repeat(49)}\u{1F600}\u{1F600}>`, 50);
  assert.equal(token.query, `${'x'.repeat(49)}\u{1F600}`);
});

test('limitGifTokens keeps the first max tokens and removes the rest without a placeholder', () => {
  const text = 'a <gif! 1> b <gif! 2> c <gif! 3> d <gif! 4> e <gif! 5>';
  assert.equal(limitGifTokens(text, 2), 'a <gif! 1> b <gif! 2> c  d  e ');
});

test('limitGifTokens leaves text with fewer tokens alone and removes all at max 0', () => {
  assert.equal(limitGifTokens('x <gif! a>', 2), 'x <gif! a>');
  assert.equal(limitGifTokens('no tokens', 2), 'no tokens');
  assert.equal(limitGifTokens('x <gif! a>', 0), 'x ');
});
