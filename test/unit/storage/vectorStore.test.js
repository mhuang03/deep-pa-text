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

test('only messages whose parent embedding exists get a reply row, with no undefined embedding', async () => {
  const { fake, store } = setup();
  await store.upsertMessages([m('1', 'parent')]);
  await store.upsertMessages([m('2', 'child', { reference: '1' }), m('3', 'orphan', { reference: 'ghost' })]);
  const replies = fake.state.collection('message_reply_embeddings');
  assert.deepEqual(replies.upserts.map((c) => c.ids), [['2']]);
  assert.ok(replies.upserts.every((c) => c.embeddings.every((e) => Array.isArray(e))));
  assert.deepEqual([...replies.rows.keys()], ['2']);
});

test('metadata has_gif is always a boolean', async () => {
  const { fake, store } = setup();
  await store.upsertMessages([m('1', 'plain'), m('2', 'gif', { hasGif: true })]);
  const [call] = fake.state.collection('message_embeddings').upserts;
  assert.deepEqual(call.metadatas.map((x) => x.has_gif), [false, true]);
  assert.equal(fake.state.collection('message_embeddings').rows.get('1').metadata.has_gif, false);
});

test('a child whose parent is new in the same batch uses the parent embedding', async () => {
  const { fake, store } = setup();
  await store.upsertMessages([m('1', 'parent text'), m('2', 'child text', { reference: '1' })]);
  assert.deepEqual(fake.state.collection('message_reply_embeddings').rows.get('2').embedding, fakeEmbed('parent text'));
});

test('a parent with an empty embedding is treated as missing', async () => {
  const { fake, store } = setup();
  await store.connect();
  fake.state.collection('message_embeddings').seed([{ id: '1', document: 'p', metadata: {}, embedding: [] }]);
  await store.upsertMessages([m('2', 'child', { reference: '1' })]);
  assert.equal(fake.state.collection('message_reply_embeddings').upserts.length, 0);
});

test('no parent lookup without references and no replies call when nothing qualifies', async () => {
  const { fake, store } = setup();
  await store.connect();
  const messages = fake.state.collection('message_embeddings');
  let gets = 0;
  const original = messages.get.bind(messages);
  messages.get = (args) => {
    gets += 1;
    return original(args);
  };
  await store.upsertMessages([m('1', 'x')]);
  assert.equal(gets, 0);
  await store.upsertMessages([m('2', 'y', { reference: 'ghost' })]);
  assert.equal(fake.state.collection('message_reply_embeddings').upserts.length, 0);
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

test('getEmbeddings returns messages-collection embeddings keyed by id, omitting unknown ids', async () => {
  const { fake, store } = setup();
  await store.connect();
  fake.state.collection('message_embeddings').seed([{ id: '1', document: 'hello there' }]);
  const found = await store.getEmbeddings(['1', 'nope']);
  assert.deepEqual([...found.keys()], ['1']);
  assert.deepEqual(found.get('1'), fakeEmbed('hello there'));
});

test('getEmbeddings makes no Chroma call for no ids', async () => {
  const { fake, store } = setup();
  await store.connect();
  const messages = fake.state.collection('message_embeddings');
  messages.get = () => { throw new Error('must not be called'); };
  assert.equal((await store.getEmbeddings([])).size, 0);
});

test('getEmbeddings asks for the embeddings of all ids in one get', async () => {
  const { fake, store } = setup();
  await store.connect();
  const messages = fake.state.collection('message_embeddings');
  const calls = [];
  const original = messages.get.bind(messages);
  messages.get = (args) => { calls.push(args); return original(args); };
  await store.getEmbeddings(['1', '2']);
  assert.deepEqual(calls, [{ ids: ['1', '2'], include: ['embeddings'] }]);
});

const seedRecord = (fake, name, id, extra = {}) => fake.state.collection(name).seed([{
  id, document: `doc ${id}`, metadata: { author: 'a', timestamp: 1, has_gif: false }, ...extra,
}]);

test('getRecords returns document, metadata and embedding by id and omits unknown ids', async () => {
  const { fake, store } = setup();
  await store.connect();
  seedRecord(fake, 'message_embeddings', '1');
  const records = await store.getRecords('messages', ['1', 'nope']);
  assert.deepEqual([...records.keys()], ['1']);
  assert.equal(records.get('1').document, 'doc 1');
  assert.deepEqual(records.get('1').metadata, { author: 'a', timestamp: 1, has_gif: false });
  assert.deepEqual(records.get('1').embedding, fakeEmbed('doc 1'));
});

test('getRecords reads the replies collection by name and makes no call for no ids', async () => {
  const { fake, store } = setup();
  await store.connect();
  seedRecord(fake, 'message_reply_embeddings', 'r1');
  assert.deepEqual([...(await store.getRecords('replies', ['r1'])).keys()], ['r1']);
  const collection = fake.state.collection('message_embeddings');
  collection.setFailing(new Error('must not be called'));
  assert.equal((await store.getRecords('messages', [])).size, 0);
});

test('getRecords rejects an unknown collection name', async () => {
  const { store } = setup();
  await assert.rejects(store.getRecords('nope', ['1']), /Unknown collection/);
});

test('fillMetadata upserts exactly the given document, embedding and metadata without embedding anything', async () => {
  const { fake, store } = setup();
  await store.connect();
  const embedding = [0.5, 0.25];
  seedRecord(fake, 'message_embeddings', '1', { embedding, metadata: { author: 'a', timestamp: 1 } });
  await store.fillMetadata('messages', [{
    id: '1', document: 'doc 1', embedding, metadata: { author: 'a', timestamp: 1, has_gif: true },
  }]);
  const row = fake.state.collection('message_embeddings').rows.get('1');
  assert.deepEqual(row.embedding, embedding);
  assert.equal(row.document, 'doc 1');
  assert.deepEqual(row.metadata, { author: 'a', timestamp: 1, has_gif: true });
  assert.equal(fake.state.embeddingCalls, 0);
});

test('fillMetadata does nothing for no records', async () => {
  const { fake, store } = setup();
  await store.connect();
  await store.fillMetadata('replies', []);
  assert.equal(fake.state.collection('message_reply_embeddings').upserts.length, 0);
});

test('addReplyRows upserts one row per message with the given embedding and the standard metadata', async () => {
  const { fake, store } = setup();
  await store.connect();
  const embedding = [1, 0];
  await store.addReplyRows([{ message: m('2', 'reply text', { reference: '1', hasGif: true }), embedding }]);
  const replies = fake.state.collection('message_reply_embeddings');
  assert.equal(replies.upserts.length, 1);
  const row = replies.rows.get('2');
  assert.deepEqual(row.embedding, embedding);
  assert.equal(row.document, 'reply text');
  assert.deepEqual(row.metadata, { author: 'a', timestamp: 10, has_gif: true });
});

test('addReplyRows does nothing for no rows', async () => {
  const { fake, store } = setup();
  await store.connect();
  await store.addReplyRows([]);
  assert.equal(fake.state.collection('message_reply_embeddings').upserts.length, 0);
});
