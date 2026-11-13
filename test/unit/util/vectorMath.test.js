import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRowDot, normaliseRow } from '../../../src/util/vectorMath.js';

test('createRowDot multiplies a row of one array with a row of another', () => {
  const left = Float32Array.from([1, 2, 3, 4]);
  const right = Float32Array.from([10, 20]);
  const dot = createRowDot(left, right, 2);
  assert.equal(dot(0, 0), 50);
  assert.equal(dot(1, 0), 110);
});

test('normaliseRow scales a row to unit length in place and leaves the others alone', () => {
  const vector = Float32Array.from([3, 4, 9, 9]);
  assert.equal(normaliseRow(vector, 0, 2), true);
  assert.deepEqual([...vector.slice(0, 2)].map((x) => Number(x.toFixed(3))), [0.6, 0.8]);
  assert.deepEqual([...vector.slice(2)], [9, 9]);
});

test('normaliseRow reports a zero row and leaves it untouched', () => {
  const vector = Float32Array.from([0, 0]);
  assert.equal(normaliseRow(vector, 0, 2), false);
  assert.deepEqual([...vector], [0, 0]);
});
