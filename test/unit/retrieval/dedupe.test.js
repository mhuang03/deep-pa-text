import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeBuckets } from '../../../src/retrieval/dedupe.js';

test('earlier arrays take precedence over later ones', () => {
  assert.deepEqual(dedupeBuckets([['a', 'b'], ['b', 'c'], ['a', 'c', 'd'], ['d', 'e']]), [
    ['a', 'b'], ['c'], ['d'], ['e'],
  ]);
});

test('removes duplicates within one array keeping the first occurrence', () => {
  assert.deepEqual(dedupeBuckets([['x', 'y', 'x', 'y', 'z']]), [['x', 'y', 'z']]);
});

test('handles empty arrays', () => {
  assert.deepEqual(dedupeBuckets([[], ['a'], []]), [[], ['a'], []]);
  assert.deepEqual(dedupeBuckets([]), []);
});

test('is case and whitespace sensitive', () => {
  assert.deepEqual(dedupeBuckets([['a'], ['A', 'a ']]), [['a'], ['A', 'a ']]);
});

test('does not mutate its input', () => {
  const input = [['a', 'a'], ['a', 'b']];
  const copy = structuredClone(input);
  const output = dedupeBuckets(input);
  assert.deepEqual(input, copy);
  assert.notEqual(output[0], input[0]);
});
