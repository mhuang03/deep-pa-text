import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUERY_INCLUDE, hasEmbedding, dedupeById, toHits, buildQueryInput, toUpsertBody,
} from '../../../src/storage/vectorRecords.js';

test('hasEmbedding needs a non-empty array', () => {
  assert.deepEqual([[1], [], null, undefined, 'x'].map(hasEmbedding), [true, false, false, false, false]);
});

test('dedupeById keeps the last occurrence of an id at its first position', () => {
  const rows = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'a', v: 3 }];
  assert.deepEqual(dedupeById(rows, (r) => r.id), [{ id: 'a', v: 3 }, { id: 'b', v: 2 }]);
});

test('toHits flattens the first query result', () => {
  const result = { ids: [['1', '2']], documents: [['d1', 'd2']], metadatas: [[{ a: 1 }, { a: 2 }]], distances: [[0.1, 0.2]] };
  assert.deepEqual(toHits(result), [
    { id: '1', document: 'd1', metadata: { a: 1 }, distance: 0.1 },
    { id: '2', document: 'd2', metadata: { a: 2 }, distance: 0.2 },
  ]);
  assert.deepEqual(QUERY_INCLUDE, ['documents', 'metadatas', 'distances']);
});

test('buildQueryInput needs exactly one of embedding or text', () => {
  assert.deepEqual(buildQueryInput({ embedding: [1] }), { queryEmbeddings: [[1]] });
  assert.deepEqual(buildQueryInput({ text: 't' }), { queryTexts: ['t'] });
  assert.throws(() => buildQueryInput({}), /exactly one of embedding or text/);
  assert.throws(() => buildQueryInput({ embedding: [1], text: 't' }), /exactly one/);
});

test('toUpsertBody builds ids, documents and boolean has_gif metadata', () => {
  const body = toUpsertBody([
    { id: '1', content: 'x', author: 'a', timestamp: 5, hasGif: true, extra: 'ignored' },
    { id: '2', content: 'y', author: 'b', timestamp: 6 },
  ]);
  assert.deepEqual(body, {
    ids: ['1', '2'],
    documents: ['x', 'y'],
    metadatas: [{ author: 'a', timestamp: 5, has_gif: true }, { author: 'b', timestamp: 6, has_gif: false }],
  });
});
