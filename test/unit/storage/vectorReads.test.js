import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVectorReads } from '../../../src/storage/vectorReads.js';
import { createFakeChroma } from '../../support/fakes/chroma.js';

const guard = { timed: async (name, ms, work) => work(), limits: { interactive: 1, batch: 2, connect: 3 } };

const setup = async () => {
  const fake = createFakeChroma();
  const client = new fake.ChromaClient({});
  const embeddingFunction = new fake.OpenAIEmbeddingFunction({});
  const messages = await client.getOrCreateCollection({ name: 'm', embeddingFunction });
  const replies = await client.getOrCreateCollection({ name: 'r', embeddingFunction });
  const reads = createVectorReads({ guard, collections: async () => ({ messages, replies }), embeddingFunction });
  return { fake, messages, replies, reads };
};

test('embed returns one embedding for the text', async () => {
  const { reads, fake } = await setup();
  const embedding = await reads.embed('hello');
  assert.equal(Array.isArray(embedding), true);
  assert.equal(fake.state.embeddingCalls, 1);
});

test('getEmbeddings skips an empty request and omits rows without an embedding', async () => {
  const { reads, messages, fake } = await setup();
  assert.equal((await reads.getEmbeddings([])).size, 0);
  messages.seed([{ id: '1', document: 'one', metadata: { author: 'a', timestamp: 1 } }]);
  const found = await reads.getEmbeddings(['1', 'missing']);
  assert.deepEqual([...found.keys()], ['1']);
  assert.equal(fake.state.embeddingCalls, 0);
});

test('getRecords returns stored documents, metadata and embeddings unchanged', async () => {
  const { reads, replies } = await setup();
  replies.seed([{ id: 'r1', document: 'doc', metadata: { author: 'a', timestamp: 2, has_gif: false } }]);
  const records = await reads.getRecords('replies', ['r1', 'nope']);
  assert.equal(records.get('r1').document, 'doc');
  assert.deepEqual(records.get('r1').metadata, { author: 'a', timestamp: 2, has_gif: false });
  assert.equal(records.has('nope'), false);
  assert.equal((await reads.getRecords('replies', [])).size, 0);
  await assert.rejects(reads.getRecords('bogus', ['x']), /Unknown collection: bogus/);
});

test('query returns hits nearest first and needs exactly one of embedding or text', async () => {
  const { reads, messages } = await setup();
  messages.seed([
    { id: '1', document: 'alpha', metadata: { author: 'a', timestamp: 1 } },
    { id: '2', document: 'zzzzzz', metadata: { author: 'b', timestamp: 2 } },
  ]);
  const hits = await reads.query('messages', { text: 'alpha', limit: 2 });
  assert.equal(hits[0].id, '1');
  assert.equal(hits.length, 2);
  const filtered = await reads.query('messages', { text: 'alpha', where: { author: 'b' }, limit: 5 });
  assert.deepEqual(filtered.map((h) => h.id), ['2']);
  await assert.rejects(reads.query('messages', { limit: 1 }), /exactly one of embedding or text/);
});
