import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQueryText } from '../../../src/retrieval/queryText.js';

const options = { shortMessageChars: 25, queryContextMessages: 2 };
const transcript = ['one', 'two', 'three'].map((content) => ({ content }));

test('a message of exactly shortMessageChars is embedded alone', () => {
  const content = 'x'.repeat(25);
  assert.equal(buildQueryText({ content }, transcript, options), content);
});

test('a message one character shorter borrows the last transcript lines', () => {
  const content = 'x'.repeat(24);
  assert.equal(buildQueryText({ content }, transcript, options), `two\nthree\n${content}`);
});

test('uses fewer entries when the transcript is shorter than requested', () => {
  assert.equal(buildQueryText({ content: 'why' }, [{ content: 'only' }], options), 'only\nwhy');
});

test('an empty transcript or zero context messages leaves the content alone', () => {
  assert.equal(buildQueryText({ content: 'why' }, [], options), 'why');
  assert.equal(buildQueryText({ content: 'why' }, transcript, { ...options, queryContextMessages: 0 }), 'why');
});
