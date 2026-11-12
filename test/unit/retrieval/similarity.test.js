import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity } from '../../../src/retrieval/similarity.js';

test('identical and scaled vectors have similarity 1', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-12);
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [2, 4, 6]) - 1) < 1e-12);
});

test('orthogonal and opposite vectors', () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-12);
});

test('missing, empty, mismatched or zero vectors give 0', () => {
  assert.equal(cosineSimilarity(null, [1]), 0);
  assert.equal(cosineSimilarity([1], undefined), 0);
  assert.equal(cosineSimilarity([], []), 0);
  assert.equal(cosineSimilarity([1, 2], [1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.equal(cosineSimilarity([1, 1], [0, 0]), 0);
});
