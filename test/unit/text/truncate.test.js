import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateForDiscord, truncateCodePoints } from '../../../src/text/truncate.js';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test('truncateCodePoints leaves shorter or equal input unchanged and adds no ellipsis', () => {
  assert.equal(truncateCodePoints('abc', 3, { ellipsis: '…' }), 'abc');
  assert.equal(truncateCodePoints('ab', 5, { ellipsis: '…' }), 'ab');
});

test('truncateCodePoints cuts ASCII to max code points', () => {
  assert.equal(truncateCodePoints('abcdef', 3), 'abc');
  assert.equal(truncateCodePoints('abcdef', 3, { ellipsis: '…' }), 'abc…');
  assert.equal(truncateCodePoints('abc', 0), '');
});

test('truncateCodePoints never splits an astral character at the boundary', () => {
  const text = `${'a'.repeat(299)}\u{1F600}${'b'.repeat(10)}`;
  const cut = truncateCodePoints(text, 300);
  assert.equal(Array.from(cut).length, 300);
  assert.equal(Array.from(cut).at(-1), '\u{1F600}');
  assert.equal(LONE_SURROGATE.test(cut), false);
  assert.equal(truncateCodePoints(text, 299), 'a'.repeat(299));
  assert.equal(LONE_SURROGATE.test(truncateCodePoints(`${'a'.repeat(300)}\u{1F600}`, 301)), false);
});

test('truncateCodePoints treats a missing limit as no limit', () => {
  assert.equal(truncateCodePoints('abc', undefined), 'abc');
});

const OPTIONS = { maxLength: 2000, lookback: 200 };

test('truncateForDiscord leaves short content unchanged', () => {
  assert.equal(truncateForDiscord('a'.repeat(2000), OPTIONS), 'a'.repeat(2000));
});

test('truncateForDiscord cuts to the limit when there is no whitespace', () => {
  assert.equal(truncateForDiscord('a'.repeat(2500), OPTIONS).length, 2000);
});

test('truncateForDiscord cuts at whitespace inside the lookback', () => {
  const text = `${'a'.repeat(1950)} ${'b'.repeat(549)}`;
  assert.equal(truncateForDiscord(text, OPTIONS), 'a'.repeat(1950));
});

test('truncateForDiscord ignores whitespace outside the lookback', () => {
  const text = `${'a'.repeat(1700)} ${'b'.repeat(799)}`;
  assert.equal(truncateForDiscord(text, OPTIONS).length, 2000);
});

test('truncateForDiscord does not split a surrogate pair', () => {
  const text = `${'a'.repeat(1999)}\u{1F600}${'b'.repeat(500)}`;
  const result = truncateForDiscord(text, OPTIONS);
  assert.equal(result.length, 1999);
  assert.equal(result, 'a'.repeat(1999));
});

test('truncateForDiscord does not cut at whitespace that would leave nothing', () => {
  const text = ` ${'a'.repeat(2500)}`;
  const result = truncateForDiscord(text, { maxLength: 2000, lookback: 2000 });
  assert.equal(result.length > 0, true);
});

test('truncateForDiscord trims trailing whitespace', () => {
  const text = `${'a'.repeat(1990)}     ${'b'.repeat(600)}`;
  assert.equal(truncateForDiscord(text, { maxLength: 1995, lookback: 0 }), 'a'.repeat(1990));
});
