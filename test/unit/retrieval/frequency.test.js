import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFrequent } from '../../../src/retrieval/frequency.js';

const OPTIONS = { frequentMinCount: 3, frequentLimit: 2 };
const item = (text, variants = [text]) => ({ text, variants });

test('sums counts over variants and reports the kept text', () => {
  const counts = new Map([['lol', 4], ['LOL', 2]]);
  assert.deepEqual(buildFrequent([item('lol', ['lol', 'LOL'])], counts, OPTIONS), [{ text: 'lol', times: 6 }]);
});

test('drops items below the minimum, sorts descending, ties by first appearance, applies the limit', () => {
  const counts = new Map([['a', 3], ['b', 5], ['c', 3], ['d', 2], ['e', 9]]);
  const items = ['a', 'b', 'c', 'd', 'e'].map((t) => item(t));
  assert.deepEqual(buildFrequent(items, counts, OPTIONS), [{ text: 'e', times: 9 }, { text: 'b', times: 5 }]);
  assert.deepEqual(
    buildFrequent(items, counts, { ...OPTIONS, frequentLimit: 10 }).map((f) => f.text),
    ['e', 'b', 'a', 'c'],
  );
});

test('unknown variants count as zero', () => {
  assert.deepEqual(buildFrequent([item('x')], new Map(), OPTIONS), []);
});
