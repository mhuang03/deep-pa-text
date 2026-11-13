import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonObject } from '../../../src/text/jsonObject.js';

test('parses a bare object', () => {
  assert.deepEqual(parseJsonObject('{"a": 1}'), { a: 1 });
});

test('parses the object inside surrounding prose and code fences', () => {
  assert.deepEqual(parseJsonObject('Sure! Here you go:\n```json\n{"usable": false}\n```\nHope that helps.'), { usable: false });
});

test('uses the first opening and last closing brace, so nested objects survive', () => {
  assert.deepEqual(parseJsonObject('x {"a": {"b": 2}} y'), { a: { b: 2 } });
});

test('returns null when there is no object, invalid JSON, or not a plain object', () => {
  ['', 'no braces', '} {', '{not json}', '{"a": }'].forEach((text) => assert.equal(parseJsonObject(text), null, text));
  assert.equal(parseJsonObject('[1, 2]'), null);
  assert.equal(parseJsonObject(undefined), null);
});
