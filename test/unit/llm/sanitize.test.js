import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeResponse, truncateForDiscord } from '../../../src/llm/sanitize.js';

const TABLE = [
  ['"hello there"', 'hello there'],
  ['"line one\\nline two"', 'line one\nline two'],
  ["'yo'", 'yo'],
  ['“fancy”', 'fancy'],
  ['"unterminated', '"unterminated'],
  ['"\\"hi\\""', 'hi'],
  ['"a\\\\nb"', 'a\nb'],
  ['he said "hi" ok', 'he said "hi" ok'],
  ['no way\\nreally', 'no way\nreally'],
  ['"', '"'],
  ['   ', ''],
  ['  plain text  ', 'plain text'],
  ['say \\"hi\\"\\tthere', 'say "hi"\tthere'],
];

for (const [input, expected] of TABLE) {
  test(`sanitizeResponse(${JSON.stringify(input)}) -> ${JSON.stringify(expected)}`, () => {
    assert.equal(sanitizeResponse(input), expected);
  });

  test(`sanitizeResponse is idempotent for ${JSON.stringify(input)}`, () => {
    const once = sanitizeResponse(input);
    assert.equal(sanitizeResponse(once), once);
  });
}

test('unwraps at most three layers of quotes', () => {
  assert.equal(sanitizeResponse('\'\'\'\'x\'\'\'\''), "'x'");
});

test('a double-quoted text that is not valid JSON is stripped of its outer quotes', () => {
  assert.equal(sanitizeResponse('"it is \\q ok"'), 'it is \\q ok');
});

test('text that only starts or ends with a quote is left alone', () => {
  assert.equal(sanitizeResponse('"hi" he said'), '"hi" he said');
  assert.equal(sanitizeResponse('he said "hi"'), 'he said "hi"');
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
