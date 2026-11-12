import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChroma, fakeEmbed } from '../../support/fakes/chroma.js';
import { createVectorStore } from '../../../src/storage/vectorStore.js';

const config = { chroma: { messagesCollection: 'message_embeddings', repliesCollection: 'message_reply_embeddings' } };

const setup = () => {
  const fake = createFakeChroma();
  const client = new fake.ChromaClient({ port: 1 });
  const embeddingFunction = new fake.OpenAIEmbeddingFunction({});
  const store = createVectorStore({ client, embeddingFunction, config });
  return { fake, client, embeddingFunction, store };
};
const m = (id, content, extra = {}) => ({
  id, author: 'a', content, timestamp: 10, reference: null, ...extra,
});

test('connect calls heartbeat and creates both collections', async () => {
  const { fake, store } = setup();
  await store.connect();
  assert.equal(fake.state.collection('message_embeddings').name, 'message_embeddings');
  assert.equal(fake.state.collection('message_reply_embeddings').name, 'message_reply_embeddings');
});

test('connect propagates a heartbeat failure', async () => {
  const { fake, store } = setup();
  fake.state.failHeartbeat(new Error('down'));
  await assert.rejects(store.connect(), /down/);
});

test('collections are created once across concurrent calls', async () => {
  const { client, store } = setup();
  const calls = [];
  const original = client.getOrCreateCollection.bind(client);
  client.getOrCreateCollection = (args) => {
    calls.push(args.name);
    return original(args);
  };
  await Promise.all([store.upsertMessages([m('1', 'x')]), store.connect(), store.upsertMessages([m('2', 'y')])]);
  assert.deepEqual(calls, ['message_embeddings', 'message_reply_embeddings']);
});

test('a rejected attempt is retried on the next call', async () => {
  const { client, store } = setup();
  const original = client.getOrCreateCollection.bind(client);
  let failures = 1;
  client.getOrCreateCollection = (args) => {
    if (failures-- > 0) return Promise.reject(new Error('boom'));
    return original(args);
  };
  await assert.rejects(store.connect(), /boom/);
  await store.connect();
});

test('embed makes one generate call and returns the vector', async () => {
  const { embeddingFunction, store } = setup();
  const seen = [];
  const original = embeddingFunction.generate.bind(embeddingFunction);
  embeddingFunction.generate = (texts) => {
    seen.push(texts);
    return original(texts);
  };
  assert.deepEqual(await store.embed('hello there'), fakeEmbed('hello there'));
  assert.deepEqual(seen, [['hello there']]);
});

test('upsertMessages without references only writes the messages collection', async () => {
  const { fake, store } = setup();
  await store.connect();
  await store.upsertMessages([m('1', 'hi there', { hasGif: true })]);
  const row = fake.state.collection('message_embeddings').rows.get('1');
  assert.equal(row.document, 'hi there');
  assert.deepEqual(row.metadata, { author: 'a', timestamp: 10, has_gif: true });
  assert.equal(fake.state.collection('message_reply_embeddings').rows.size, 0);
});

test('upsertMessages with no parent found does not write replies', async () => {
  const { fake, store } = setup();
  await store.upsertMessages([m('2', 'reply', { reference: 'ghost' })]);
  assert.equal(fake.state.collection('message_reply_embeddings').rows.size, 0);
});

test('upsertMessages stores a reply under the parent embedding', async () => {
  const { fake, store } = setup();
  await store.upsertMessages([m('1', 'parent text')]);
  await store.upsertMessages([m('2', 'child text', { reference: '1', hasGif: false })]);
  const reply = fake.state.collection('message_reply_embeddings').rows.get('2');
  assert.deepEqual(reply.embedding, fakeEmbed('parent text'));
  assert.equal(reply.document, 'child text');
  assert.deepEqual(reply.metadata, { author: 'a', timestamp: 10, has_gif: false });
});

test('KNOWN BUG (spec 10): upserts every referencing message once one parent is found', async () => {
  const { fake, store } = setup();
  await store.upsertMessages([m('1', 'parent')]);
  const orphan = m('3', 'orphan', { reference: 'ghost' });
  await assert.rejects(store.upsertMessages([m('2', 'child', { reference: '1' }), orphan]));
  const [call] = fake.state.collection('message_reply_embeddings').upserts;
  assert.deepEqual(call.ids, ['2', '3']);
  assert.equal(call.embeddings[1], undefined);
});

test('KNOWN BUG (spec 10): metadata has_gif is undefined without hasGif', async () => {
  const { fake, store } = setup();
  await store.upsertMessages([m('1', 'plain')]);
  const [call] = fake.state.collection('message_embeddings').upserts;
  assert.equal(call.metadatas[0].has_gif, undefined);
  assert.ok('has_gif' in call.metadatas[0]);
  assert.equal('has_gif' in fake.state.collection('message_embeddings').rows.get('1').metadata, false);
});

const seeded = async () => {
  const ctx = setup();
  await ctx.store.upsertMessages([
    m('1', 'cats are great', { timestamp: 1 }),
    m('2', 'dogs are great', { timestamp: 2, author: 'b' }),
    m('3', 'cats cats cats', { timestamp: 3 }),
  ]);
  return ctx;
};

test('query returns Hits nearest first and passes where and limit', async () => {
  const { fake, store } = await seeded();
  const where = { author: 'a' };
  const hits = await store.query('messages', { embedding: await store.embed('cats'), where, limit: 1 });
  assert.equal(hits.length, 1);
  assert.deepEqual(Object.keys(hits[0]).sort(), ['distance', 'document', 'id', 'metadata']);
  assert.equal(hits[0].id, '3');
  assert.equal(hits[0].document, 'cats cats cats');
  assert.equal(hits[0].metadata.author, 'a');
  assert.equal(typeof hits[0].distance, 'number');
  const [call] = fake.state.collection('message_embeddings').queries;
  assert.deepEqual(call.where, where);
  assert.equal(call.nResults, 1);
});

test('query sends queryEmbeddings for an embedding and queryTexts for text', async () => {
  const { fake, store } = await seeded();
  const embedding = fakeEmbed('cats');
  await store.query('messages', { embedding, limit: 5 });
  await store.query('messages', { text: 'cats', limit: 5 });
  const [first, second] = fake.state.collection('message_embeddings').queries;
  assert.deepEqual(first.queryEmbeddings, [embedding]);
  assert.equal(first.queryTexts, undefined);
  assert.deepEqual(second.queryTexts, ['cats']);
  assert.equal(second.queryEmbeddings, undefined);
});

test('query targets the replies collection', async () => {
  const { fake, store } = await seeded();
  assert.deepEqual(await store.query('replies', { text: 'x', limit: 3 }), []);
  assert.equal(fake.state.collection('message_reply_embeddings').queries.length, 1);
});

test('query throws unless exactly one of embedding or text is given', async () => {
  const { store } = await seeded();
  await assert.rejects(store.query('messages', { limit: 1 }), /exactly one/);
  await assert.rejects(store.query('messages', { embedding: [1], text: 'x', limit: 1 }), /exactly one/);
});

test('query rejects an unknown collection name', async () => {
  const { store } = await seeded();
  await assert.rejects(store.query('nope', { text: 'x', limit: 1 }), /Unknown collection/);
});
