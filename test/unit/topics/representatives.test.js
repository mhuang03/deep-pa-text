import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRepresentatives } from '../../../src/topics/representatives.js';

const rows = (specs) => specs.map(([author, content]) => ({ author, content }));

test('orders by similarity to the centre, highest first, ties by row index', () => {
  const data = rows([['a', 'one'], ['b', 'two'], ['c', 'three'], ['d', 'four']]);
  const similarity = (row) => [0.5, 0.9, 0.9, 0.1][row];
  const picked = pickRepresentatives({ members: [0, 1, 2, 3], rows: data, similarity, limit: 10 });
  assert.deepEqual(picked.map((r) => r.content), ['two', 'three', 'one', 'four']);
});

test('drops a repeated phrase by normalised key, keeping the closest', () => {
  const data = rows([['a', 'Same phrase!'], ['b', 'same phrase'], ['c', 'other thing']]);
  const picked = pickRepresentatives({ members: [0, 1, 2], rows: data, similarity: (row) => 1 - row * 0.1, limit: 10 });
  assert.deepEqual(picked.map((r) => r.content), ['Same phrase!', 'other thing']);
});

test('takes at most ceil(limit / 2) from any one author', () => {
  const data = rows([['a', 'one'], ['a', 'two'], ['a', 'three'], ['b', 'four'], ['c', 'five']]);
  const picked = pickRepresentatives({ members: [0, 1, 2, 3, 4], rows: data, similarity: (row) => 1 - row * 0.1, limit: 5 });
  assert.deepEqual(picked.map((r) => r.content), ['one', 'two', 'three', 'four', 'five']);
  const capped = pickRepresentatives({ members: [0, 1, 2, 3, 4], rows: data, similarity: (row) => 1 - row * 0.1, limit: 3 });
  assert.deepEqual(capped.map((r) => r.content), ['one', 'two', 'four']);
});

test('cuts to the limit and only looks at the given members', () => {
  const data = rows([['a', 'one'], ['b', 'two'], ['c', 'three']]);
  const picked = pickRepresentatives({ members: [2, 1], rows: data, similarity: () => 1, limit: 1 });
  assert.deepEqual(picked.map((r) => r.content), ['two']);
});
