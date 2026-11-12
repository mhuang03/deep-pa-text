import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRaw, fetchLimit } from '../../../src/retrieval/retrieverFetch.js';
import { loadConfig } from '../../../src/config.js';

const { retrieval } = loadConfig({});

const setup = ({ hidden = [] } = {}) => {
  const queries = [];
  const randoms = [];
  const hit = (id) => ({ id, document: `doc ${id}`, metadata: {}, distance: 0.1 });
  const ctx = {
    retrieval,
    vectorStore: { query: async (collection, options) => { queries.push([collection, options]); return [hit(`${collection}-1`), hit(`${collection}-2`)]; } },
    messageStore: {
      hiddenIds: () => new Set(hidden),
      randomMessages: (options) => { randoms.push(options); return [{ id: 'o1', content: 'random one' }]; },
    },
  };
  return { ctx, queries, randoms };
};
const record = { timestamp: 500 };

test('fetchLimit multiplies by the over-fetch factor', () => {
  assert.equal(fetchLimit({ overFetchFactor: 3 }, 10), 30);
});

test('queries similar, reply and gif buckets before the record, each over-fetched', async () => {
  const { ctx, queries } = setup();
  await fetchRaw(ctx, { author: 'alice', record, embedding: [1] });
  assert.deepEqual(queries.map(([collection, options]) => [collection, options.limit]), [
    ['messages', retrieval.similarResults * retrieval.overFetchFactor],
    ['replies', retrieval.replyResults * retrieval.overFetchFactor],
    ['messages', retrieval.gifResults * retrieval.overFetchFactor],
  ]);
  const base = [{ author: 'alice' }, { timestamp: { $lt: 500 } }];
  assert.deepEqual(queries[0][1].where, { $and: base });
  assert.deepEqual(queries[2][1].where, { $and: [...base, { has_gif: true }] });
});

test('maps hits to candidates without embeddings and drops hidden rows', async () => {
  const { ctx } = setup({ hidden: ['replies-2'] });
  const raw = await fetchRaw(ctx, { author: 'alice', record, embedding: [1] });
  assert.deepEqual(raw.replies, [{ id: 'replies-1', text: 'doc replies-1', embedding: null }]);
  assert.equal(raw.similar.length, 2);
  assert.equal(raw.gifs.length, 2);
});

test('other candidates are random earlier messages of the author', async () => {
  const { ctx, randoms } = setup();
  const raw = await fetchRaw(ctx, { author: 'alice', record, embedding: [1] });
  assert.deepEqual(raw.other, [{ id: 'o1', text: 'random one', embedding: null }]);
  assert.deepEqual(randoms, [{ author: 'alice', before: 500, limit: retrieval.otherResults * retrieval.overFetchFactor }]);
});
