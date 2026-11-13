import { test } from 'node:test';
import assert from 'node:assert/strict';
import { medianOf, medianTextLength, authorStats } from '../../../src/topics/clusterStats.js';

test('medianOf handles empty, odd and even lists without mutating the input', () => {
  assert.equal(medianOf([]), 0);
  assert.equal(medianOf([5]), 5);
  const input = [9, 1, 5];
  assert.equal(medianOf(input), 5);
  assert.deepEqual(input, [9, 1, 5]);
  assert.equal(medianOf([1, 2, 3, 10]), 2.5);
});

test('medianTextLength measures the text people wrote, not GIFs or emoji', () => {
  assert.equal(medianTextLength(['hello world <gif! cat>', 'hi :joy:', 'twelve chars']), 11);
  assert.equal(medianTextLength([]), 0);
});

test('authorStats gives each author their share and newest timestamp, largest share first', () => {
  const rows = [
    { author: 'bob', timestamp: 5 }, { author: 'alice', timestamp: 9 }, { author: 'alice', timestamp: 3 },
    { author: 'carol', timestamp: 1 },
  ];
  assert.deepEqual(authorStats(rows), [
    { author: 'alice', share: 0.5, newestTimestamp: 9 },
    { author: 'bob', share: 0.25, newestTimestamp: 5 },
    { author: 'carol', share: 0.25, newestTimestamp: 1 },
  ]);
});
