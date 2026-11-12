import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectionNames, createCollectionLoader, namedCollection } from '../../../src/storage/vectorCollections.js';

const config = { chroma: { messagesCollection: 'm', repliesCollection: 'r' } };
const passthrough = { timed: (name, ms, work) => work() };

test('collectionNames adds the generation suffix only when one is named', () => {
  assert.deepEqual(collectionNames(config, null), { messages: 'm', replies: 'r' });
  assert.deepEqual(collectionNames(config, 'g1'), { messages: 'm_g1', replies: 'r_g1' });
});

const clientOf = (failures = 0) => {
  const calls = [];
  let left = failures;
  return {
    calls,
    getOrCreateCollection: async ({ name }) => {
      calls.push(name);
      if (left > 0) { left -= 1; throw new Error('boom'); }
      return { name };
    },
  };
};

test('looks both collections up once and shares the promise', async () => {
  const client = clientOf();
  const { collections } = createCollectionLoader({ client, embeddingFunction: {}, config, generation: 'g2', guard: passthrough });
  const [a, b] = await Promise.all([collections(5), collections(5)]);
  assert.equal(a, b);
  assert.deepEqual(client.calls, ['m_g2', 'r_g2']);
  await collections(5);
  assert.equal(client.calls.length, 2);
});

test('a rejected lookup is dropped so the next call retries', async () => {
  const client = clientOf(1);
  const { collections } = createCollectionLoader({ client, embeddingFunction: {}, config, generation: null, guard: passthrough });
  await assert.rejects(collections(5), /boom/);
  assert.deepEqual(await collections(5), { messages: { name: 'm' }, replies: { name: 'r' } });
});

test('namedCollection returns the named collection or throws for an unknown name', async () => {
  const collections = async () => ({ messages: { name: 'm' } });
  assert.deepEqual(await namedCollection(collections, 'messages', 1), { name: 'm' });
  await assert.rejects(namedCollection(collections, 'bogus', 1), /Unknown collection: bogus/);
});
