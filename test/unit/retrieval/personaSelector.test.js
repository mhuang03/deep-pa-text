import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChroma } from '../../support/fakes/chroma.js';
import { createVectorStore } from '../../../src/storage/vectorStore.js';
import { openDatabase } from '../../../src/storage/database.js';
import { createMessageStore } from '../../../src/storage/messageStore.js';
import { createPersonaSelector } from '../../../src/retrieval/personaSelector.js';

const config = {
  chroma: { messagesCollection: 'message_embeddings', repliesCollection: 'message_reply_embeddings' },
  retrieval: { likelyRepliers: 3 },
  persona: { recencyHalfLifeMs: 15552000000, minRecencyWeight: 0.25 },
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
  const db = openDatabase(':memory:');
  const messageStore = createMessageStore({ db, config: { storage: { inferredReferenceWindowMs: 1 } } });
  const selector = createPersonaSelector({ vectorStore, messageStore, users, random, config });
  const seed = (rows) => fake.state.collection('message_reply_embeddings').seed(
    rows.map(([id, document, author, timestamp]) => ({ id, document, metadata: { author, timestamp } })),
  );
  return { selector, seed, state, fake, messageStore, db };
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

test('likelyReplierHits exposes the hits with distance and metadata', async () => {
  const { selector, seed } = await setup();
  seedReplies(seed);
  const hits = await selector.likelyReplierHits(record);
  assert.deepEqual(hits.map((h) => h.metadata.author), ['bob', 'bob', 'carol']);
  assert.ok(hits.every((h) => Number.isFinite(h.distance)));
});

test('pickReplier maps the roll onto the weighted authors with one roll', async () => {
  const first = await setup([0]);
  seedReplies(first.seed);
  assert.equal(await first.selector.pickReplier(record), 'bob');
  assert.equal(first.state.rolls, 1);
  const last = await setup([0.999999]);
  seedReplies(last.seed);
  assert.equal(await last.selector.pickReplier(record), 'carol');
});

test('pickReplier ignores hits by authors outside the user directory', async () => {
  const { selector, seed } = await setup([0.999999]);
  seed([['1', 'cats rule', 'bob', 10], ['2', 'cats rule', 'ghost', 20]]);
  assert.equal(await selector.pickReplier(record), 'bob');
});

test('pickReplier falls back with a second roll that excludes the message author', async () => {
  const { selector, state } = await setup([0, 0.99]);
  assert.equal(await selector.pickReplier(record), 'dave');
  assert.equal(state.rolls, 2);
});

test('the fallback never picks the message author', async () => {
  const { selector } = await setup([0, 0]);
  assert.equal(await selector.pickReplier(record), 'bob');
});

test('pickRandomUser uses one roll and no exclusion by default', async () => {
  const { selector, state } = await setup([0.5]);
  assert.equal(selector.pickRandomUser(), 'carol');
  assert.equal(state.rolls, 1);
});

test('pickRandomUser excludes the given username, keeping directory order', async () => {
  const { selector } = await setup([0, 0.5, 0.99]);
  assert.equal(selector.pickRandomUser({ exclude: 'alice' }), 'bob');
  assert.equal(selector.pickRandomUser({ exclude: 'bob' }), 'carol');
  assert.equal(selector.pickRandomUser({ exclude: 'dave' }), 'carol');
});

test('pickRandomUser uses everyone when the exclusion leaves nobody', async () => {
  const fake = createFakeChroma();
  const vectorStore = createVectorStore({
    client: new fake.ChromaClient({}),
    embeddingFunction: new fake.OpenAIEmbeddingFunction({}),
    config,
  });
  const selector = createPersonaSelector({
    vectorStore, users: [{ username: 'alice', name: 'Alice' }], random: () => 0, config,
  });
  assert.equal(selector.pickRandomUser({ exclude: 'alice' }), 'alice');
});

test('likelyReplierHits drops hits whose corpus row was deleted', async () => {
  const { selector, seed, messageStore } = await setup();
  seedReplies(seed);
  ['1', '3'].forEach((id) => messageStore.insertFiltered({
    id, author: 'bob', content: 'x', timestamp: 1, reference: null,
  }));
  messageStore.softDelete('1', 9);
  assert.deepEqual((await selector.likelyReplierHits(record)).map((hit) => hit.id).sort(), ['2', '3']);
  assert.deepEqual(await selector.likelyRepliers(record), ['bob', 'carol']);
});
