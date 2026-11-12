import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChroma } from '../../support/fakes/chroma.js';
import { createVectorStore } from '../../../src/storage/vectorStore.js';
import { createPersonaSelector } from '../../../src/retrieval/personaSelector.js';

const config = {
  chroma: { messagesCollection: 'message_embeddings', repliesCollection: 'message_reply_embeddings' },
  retrieval: { likelyRepliers: 3 },
};
const users = [
  { username: 'alice', name: 'Alice' }, { username: 'bob', name: 'Bob' },
  { username: 'carol', name: 'Carol' }, { username: 'dave', name: 'Dave' },
];

const setup = async (rolls = []) => {
  const fake = createFakeChroma();
  const vectorStore = createVectorStore({
    client: new fake.ChromaClient({}),
    embeddingFunction: new fake.OpenAIEmbeddingFunction({}),
    config,
  });
  await vectorStore.connect();
  const queue = [...rolls];
  const state = { rolls: 0 };
  const random = () => {
    state.rolls += 1;
    return queue.shift();
  };
  const selector = createPersonaSelector({ vectorStore, users, random, config });
  const seed = (rows) => fake.state.collection('message_reply_embeddings').seed(
    rows.map(([id, document, author, timestamp]) => ({ id, document, metadata: { author, timestamp } })),
  );
  return { selector, seed, state, fake };
};
const record = { author: 'alice', content: 'cats rule', timestamp: 100 };
const seedReplies = (seed) => seed([
  ['1', 'cats rule', 'bob', 10], ['2', 'cats', 'carol', 20], ['3', 'cats cats rule', 'bob', 30],
  ['4', 'cats rule', 'alice', 40], ['5', 'cats rule', 'dave', 200], ['6', 'unrelated words', 'dave', 5],
]);

test('likelyRepliers returns nearest authors with duplicates, excluding self and later rows', async () => {
  const { selector, seed } = await setup();
  seedReplies(seed);
  assert.deepEqual(await selector.likelyRepliers(record), ['bob', 'bob', 'carol']);
});

test('likelyRepliers honours the limit and the legacy where shape', async () => {
  const { selector, seed, fake } = await setup();
  seedReplies(seed);
  await selector.likelyRepliers(record);
  const [query] = fake.state.collection('message_reply_embeddings').queries;
  assert.equal(query.nResults, 3);
  assert.deepEqual(query.queryTexts, ['cats rule']);
  assert.deepEqual(query.where, {
    $and: [{ author: { $ne: 'alice' } }, { timestamp: { $lt: 100 } }],
  });
});

test('likelyRepliers is empty for an empty collection', async () => {
  const { selector } = await setup();
  assert.deepEqual(await selector.likelyRepliers(record), []);
});

test('pickReplier maps the roll to a list index with one roll', async () => {
  const first = await setup([0]);
  seedReplies(first.seed);
  assert.equal(await first.selector.pickReplier(record), 'bob');
  assert.equal(first.state.rolls, 1);
  const last = await setup([0.99]);
  seedReplies(last.seed);
  assert.equal(await last.selector.pickReplier(record), 'carol');
  const mid = await setup([0.34]);
  seedReplies(mid.seed);
  assert.equal(await mid.selector.pickReplier(record), 'bob');
  const third = await setup([0.67]);
  seedReplies(third.seed);
  assert.equal(await third.selector.pickReplier(record), 'carol');
});

test('pickReplier falls back to a random user with a second roll when the list is empty', async () => {
  const { selector, state } = await setup([0, 0.99]);
  assert.equal(await selector.pickReplier(record), 'dave');
  assert.equal(state.rolls, 2);
});

test('the fallback may pick the message author', async () => {
  const { selector } = await setup([0, 0]);
  assert.equal(await selector.pickReplier(record), 'alice');
});

test('pickRandomUser uses one roll', async () => {
  const { selector, state } = await setup([0.5]);
  assert.equal(selector.pickRandomUser(), 'carol');
  assert.equal(state.rolls, 1);
});
