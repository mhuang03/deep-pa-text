import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBurst, burstDelay } from '../../../src/llm/burst.js';

const ON = { maxMessages: 3, enabled: true };

test('splits on the marker, case-insensitively, consuming surrounding whitespace', () => {
  assert.deepEqual(splitBurst('one \n<split>\n two <SPLIT> three', ON), ['one', 'two', 'three']);
});

test('without a marker the trimmed text is the only part', () => {
  assert.deepEqual(splitBurst('  hello  ', ON), ['hello']);
});

test('drops empty parts', () => {
  assert.deepEqual(splitBurst('<split>one<split> <split>two<split>', ON), ['one', 'two']);
  assert.deepEqual(splitBurst('<split>', ON), []);
});

test('extra parts are joined onto the last allowed part with newlines', () => {
  assert.deepEqual(splitBurst('a<split>b<split>c<split>d<split>e', ON), ['a', 'b', 'c\nd\ne']);
  assert.deepEqual(splitBurst('a<split>b', { maxMessages: 1, enabled: true }), ['a\nb']);
});

test('a disabled burst is one part with every marker replaced by a newline', () => {
  assert.deepEqual(splitBurst('a\n<split>\nb <split> c', { maxMessages: 3, enabled: false }), ['a\nb\nc']);
});

test('burstDelay scales with length and clamps to the bounds', () => {
  const options = { msPerChar: 40, minDelayMs: 800, maxDelayMs: 4000 };
  assert.equal(burstDelay('hi', options), 800);
  assert.equal(burstDelay('x'.repeat(50), options), 2000);
  assert.equal(burstDelay('x'.repeat(500), options), 4000);
  assert.equal(burstDelay('x'.repeat(20), options), 800);
  assert.equal(burstDelay('x'.repeat(100), options), 4000);
});
