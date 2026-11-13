import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMatrix } from '../../../src/topics/embeddingMatrix.js';

const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}` }));

const storeOf = (embeddings) => {
  const calls = [];
  return {
    calls,
    getEmbeddings: async (ids, options) => {
      calls.push({ ids, options });
      return new Map(ids.filter((id) => embeddings.has(id)).map((id) => [id, embeddings.get(id)]));
    },
  };
};

test('reads embeddings page by page with the batch option and normalises each row', async () => {
  const vectorStore = storeOf(new Map(rows(5).map((r, i) => [r.id, [3 * (i + 1), 4 * (i + 1)]])));
  const matrix = await buildMatrix({ rows: rows(5), vectorStore, pageSize: 2 });
  assert.deepEqual(vectorStore.calls.map((c) => c.ids.length), [2, 2, 1]);
  assert.ok(vectorStore.calls.every((c) => c.options.batch === true));
  assert.equal(matrix.dimensions, 2);
  assert.equal(matrix.rows.length, 5);
  assert.equal(matrix.dropped, 0);
  assert.ok(matrix.vectors instanceof Float32Array);
  assert.equal(matrix.vectors.length, 10);
  assert.ok(Math.abs(matrix.vectors[0] - 0.6) < 1e-6 && Math.abs(matrix.vectors[1] - 0.8) < 1e-6);
});

test('rows without a stored embedding are dropped and counted, and never embedded', async () => {
  const vectorStore = storeOf(new Map([['m0', [1, 0]], ['m2', [0, 1]]]));
  const matrix = await buildMatrix({ rows: rows(3), vectorStore, pageSize: 10 });
  assert.deepEqual(matrix.rows.map((r) => r.id), ['m0', 'm2']);
  assert.equal(matrix.dropped, 1);
  assert.equal(matrix.vectors.length, 4);
});

test('zero vectors and vectors of another dimension are dropped', async () => {
  const vectorStore = storeOf(new Map([['m0', [1, 0]], ['m1', [0, 0]], ['m2', [1, 0, 0]], ['m3', [0, 2]]]));
  const matrix = await buildMatrix({ rows: rows(4), vectorStore, pageSize: 10 });
  assert.deepEqual(matrix.rows.map((r) => r.id), ['m0', 'm3']);
  assert.equal(matrix.dropped, 2);
  assert.deepEqual([...matrix.vectors], [1, 0, 0, 1]);
});

test('takes the dimension from the first embedding found and handles an empty input', async () => {
  const empty = await buildMatrix({ rows: [], vectorStore: storeOf(new Map()), pageSize: 10 });
  assert.deepEqual([empty.rows.length, empty.dimensions, empty.vectors.length, empty.dropped], [0, 0, 0, 0]);
  const none = await buildMatrix({ rows: rows(2), vectorStore: storeOf(new Map()), pageSize: 10 });
  assert.deepEqual([none.rows.length, none.dimensions, none.dropped], [0, 0, 2]);
  const later = await buildMatrix({ rows: rows(2), vectorStore: storeOf(new Map([['m1', [0, 5, 0]]])), pageSize: 10 });
  assert.equal(later.dimensions, 3);
});

test('a failing vector store propagates', async () => {
  const vectorStore = { getEmbeddings: async () => { throw new Error('chroma down'); } };
  await assert.rejects(buildMatrix({ rows: rows(1), vectorStore, pageSize: 10 }), /chroma down/);
});
