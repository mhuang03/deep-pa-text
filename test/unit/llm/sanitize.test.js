import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeResponse, unwrapQuotes } from '../../../src/llm/sanitize.js';

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

test('unwraps nested quotes of different kinds', () => {
  assert.equal(sanitizeResponse('"\'x\'"'), 'x');
  assert.equal(sanitizeResponse('“"x"”'), 'x');
});

test('a single-quoted text with an apostrophe is not unwrapped', () => {
  assert.equal(sanitizeResponse("'it's fine'"), "'it's fine'");
});

test('two quoted units are not one wrapped text', () => {
  assert.equal(sanitizeResponse('"yes" or "no"'), '"yes" or "no"');
  assert.equal(sanitizeResponse('“a” and “b”'), '“a” and “b”');
});

test('escaped inner quotes still count as one wrapped text', () => {
  assert.equal(sanitizeResponse('"she said \\"hi\\""'), 'she said "hi"');
});

test('a doubled backslash before a quote is settled to a fixed point', () => {
  assert.equal(sanitizeResponse('"a\\\\"b"'), 'a"b');
});

const FIXED_POINT_INPUTS = [
  '"a\\\\"b"', '"a\\\\"', '\\\\"', '\\\\\\"', '"\\"\\""', '"\'x\'"', '“"x"”', '""', '"""', '\\n\\n',
  '"\\\\n"', "''x''", '"a" "b"', '"a\\\\\\"b"', '\\"x\\"', '"\\\\"x\\\\""', "'\"x\"'", '"\\\\\\\\"',
];

for (const input of FIXED_POINT_INPUTS) {
  test(`sanitizeResponse is a fixed point for ${JSON.stringify(input)}`, () => {
    const once = sanitizeResponse(input);
    assert.equal(sanitizeResponse(once), once);
  });
}

test('unwrapQuotes only unwraps and does not replace stray escapes', () => {
  assert.equal(unwrapQuotes('"a"'), 'a');
  assert.equal(unwrapQuotes('no way\\nreally'), 'no way\\nreally');
  assert.equal(unwrapQuotes('"yes" or "no"'), '"yes" or "no"');
});

test('a double-quoted text that is not valid JSON is stripped of its outer quotes', () => {
  assert.equal(sanitizeResponse('"it is \\q ok"'), 'it is \\q ok');
});

test('text that only starts or ends with a quote is left alone', () => {
  assert.equal(sanitizeResponse('"hi" he said'), '"hi" he said');
  assert.equal(sanitizeResponse('he said "hi"'), 'he said "hi"');
});
