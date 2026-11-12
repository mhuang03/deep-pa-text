import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChroma, fakeEmbed } from '../../support/fakes/chroma.js';
import { openDatabase } from '../../../src/storage/database.js';
import { createMessageStore } from '../../../src/storage/messageStore.js';
import { createVectorStore } from '../../../src/storage/vectorStore.js';
import { createVectorSync } from '../../../src/ingest/vectorSync.js';
import { inertClock, CHROMA_LIMITS } from '../../support/clocks.js';

const config = {
  storage: { inferredReferenceWindowMs: 3600000 },
  chroma: {
    messagesCollection: 'message_embeddings', repliesCollection: 'message_reply_embeddings', ...CHROMA_LIMITS,
  },
  embedding: { dimensions: 64 },
  backfill: { batchSize: 2 },
};

const setup = async () => {
  const fake = createFakeChroma();
  const embeddingFunction = new fake.OpenAIEmbeddingFunction({});
  const vectorStore = createVectorStore({ client: new fake.ChromaClient({}), embeddingFunction, config, clock: inertClock() });
  await vectorStore.connect();
  const db = openDatabase(':memory:');
  const messageStore = createMessageStore({ db, config });
  const sync = createVectorSync({ messageStore, vectorStore, logger: { info: () => {} }, config });
  const add = (id, timestamp, extra = {}) => {
    const record = { id, author: 'alice', content: `message ${id}`, timestamp, reference: null, ...extra };
    messageStore.insertRaw(record);
    return messageStore.insertFiltered(record, { inferReference: false });
  };
  return {
    fake, db, sync, add, messages: fake.state.collection('message_embeddings'),
    replies: fake.state.collection('message_reply_embeddings'),
  };
};
const ZERO = { checked: 0, addedMessages: 0, filledMetadata: 0, addedReplies: 0, skipped: 0 };
const seedRow = (collection, id, metadata, extra = {}) => collection.seed([{ id, document: `message ${id}`, metadata, ...extra }]);

test('an empty corpus reports zeros', async () => {
  const { sync } = await setup();
  assert.deepEqual(await sync.run({}), ZERO);
});

test('a corpus row missing from Chroma is added across pages', async () => {
  const { sync, add, messages } = await setup();
  ['1', '2', '3', '4', '5'].forEach((id, i) => add(id, i + 1));
  const result = await sync.run({});
  assert.deepEqual(result, { ...ZERO, checked: 5, addedMessages: 5 });
  assert.equal(messages.rows.size, 5);
  assert.deepEqual(messages.rows.get('1').metadata, { author: 'alice', timestamp: 1, has_gif: false });
});

test('a second run reports zeros apart from the checked count and writes nothing', async () => {
  const { sync, add, messages } = await setup();
  add('1', 1);
  add('2', 2, { reference: '1' });
  await sync.run({});
  const upserts = messages.upserts.length;
  assert.deepEqual(await sync.run({}), { ...ZERO, checked: 2 });
  assert.equal(messages.upserts.length, upserts);
});

test('a row without has_gif gets it with document and embedding unchanged and no new embedding call', async () => {
  const { fake, sync, add, messages } = await setup();
  add('1', 1);
  const embedding = [0.1, 0.2, 0.3];
  seedRow(messages, '1', { author: 'alice', timestamp: 1 }, { embedding });
  const calls = fake.state.embeddingCalls;
  const result = await sync.run({});
  assert.equal(result.filledMetadata, 1);
  assert.equal(result.addedMessages, 0);
  const row = messages.rows.get('1');
  assert.deepEqual(row.metadata, { author: 'alice', timestamp: 1, has_gif: false });
  assert.deepEqual(row.embedding, embedding);
  assert.equal(row.document, 'message 1');
  assert.equal(fake.state.embeddingCalls, calls);
});

test('has_gif is filled from the corpus row', async () => {
  const { sync, add, messages } = await setup();
  add('1', 1, { content: 'look <gif! cat>' });
  seedRow(messages, '1', { author: 'alice', timestamp: 1 });
  await sync.run({});
  assert.equal(messages.rows.get('1').metadata.has_gif, true);
});

test('a row with a missing embedding or document is skipped and not touched', async () => {
  const { sync, add, messages } = await setup();
  add('1', 1);
  add('2', 2);
  messages.rows.set('1', { id: '1', document: 'message 1', metadata: { author: 'alice' }, embedding: [] });
  messages.rows.set('2', { id: '2', document: '', metadata: { author: 'alice' }, embedding: [1] });
  const before = messages.upserts.length;
  const result = await sync.run({});
  assert.equal(result.skipped, 2);
  assert.equal(result.filledMetadata, 0);
  assert.equal(messages.upserts.length, before);
  assert.equal(messages.rows.get('1').metadata.has_gif, undefined);
});

test('a reply row is added for an inferred reference using the parent embedding', async () => {
  const { sync, add, messages, replies } = await setup();
  add('1', 1);
  add('2', 2, { reference: '1' });
  seedRow(messages, '1', { author: 'alice', timestamp: 1, has_gif: false });
  seedRow(messages, '2', { author: 'alice', timestamp: 2, has_gif: false });
  const result = await sync.run({});
  assert.equal(result.addedReplies, 1);
  const row = replies.rows.get('2');
  assert.deepEqual(row.embedding, messages.rows.get('1').embedding);
  assert.equal(row.document, 'message 2');
});

test('a reply whose parent has no embedding is skipped', async () => {
  const { sync, add, messages, replies } = await setup();
  messages.rows.set('1', { id: '1', document: 'message 1', metadata: { has_gif: false }, embedding: [] });
  add('1', 1);
  add('2', 2, { reference: '1' });
  seedRow(messages, '2', { author: 'alice', timestamp: 2, has_gif: false });
  const result = await sync.run({});
  assert.equal(result.addedReplies, 0);
  assert.equal(result.skipped, 1);
  assert.equal(replies.rows.size, 0);
});

test('adding a missing message also writes its reply row, counted once', async () => {
  const { sync, add, replies } = await setup();
  add('1', 1);
  add('2', 2, { reference: '1' });
  const result = await sync.run({});
  assert.equal(result.addedMessages, 2);
  assert.equal(result.addedReplies, 0);
  assert.ok(replies.rows.has('2'));
});

test('an existing reply row lacking has_gif is filled unchanged', async () => {
  const { sync, add, messages, replies } = await setup();
  add('1', 1);
  add('2', 2, { reference: '1' });
  seedRow(messages, '1', { has_gif: false });
  seedRow(messages, '2', { has_gif: false });
  const embedding = [0.9, 0.1];
  seedRow(replies, '2', { author: 'alice', timestamp: 2 }, { embedding });
  const result = await sync.run({});
  assert.equal(result.filledMetadata, 1);
  assert.equal(result.addedReplies, 0);
  assert.deepEqual(replies.rows.get('2').embedding, embedding);
  assert.equal(replies.rows.get('2').metadata.has_gif, false);
});

test('a soft-deleted row is not synced', async () => {
  const { sync, add, messages, db } = await setup();
  add('1', 1);
  db.prepare('UPDATE filtered_messages SET deleted_at = 5 WHERE id = ?').run('1');
  assert.deepEqual(await sync.run({}), ZERO);
  assert.equal(messages.rows.size, 0);
});

test('a dry run writes nothing and reports what would be done', async () => {
  const { sync, add, messages, replies } = await setup();
  add('1', 1);
  add('2', 2);
  add('3', 3, { reference: '2' });
  seedRow(messages, '1', { author: 'alice', timestamp: 1 });
  const result = await sync.run({ dryRun: true });
  assert.deepEqual(result, { ...ZERO, checked: 3, addedMessages: 2, filledMetadata: 1 });
  assert.equal(messages.rows.size, 1);
  assert.equal(messages.rows.get('1').metadata.has_gif, undefined);
  assert.equal(replies.rows.size, 0);
  assert.equal(messages.upserts.length, 0);
});

test('a vector failure rejects with the error marked', async () => {
  const { sync, add, messages } = await setup();
  add('1', 1);
  messages.setFailing(new Error('chroma down'));
  await assert.rejects(sync.run({}), (error) => error.isVectorError === true && /chroma down/.test(error.message));
});

test('embeddings of added rows come from the embedding function', async () => {
  const { sync, add, messages } = await setup();
  add('1', 1);
  await sync.run({});
  assert.deepEqual(messages.rows.get('1').embedding, fakeEmbed('message 1'));
});

test('sinceMs checks only rows at or after that time', async () => {
  const { sync, add, messages } = await setup();
  ['1', '2', '3', '4'].forEach((id, i) => add(id, (i + 1) * 10));
  const result = await sync.run({ sinceMs: 30 });
  assert.equal(result.checked, 2);
  assert.deepEqual([...messages.rows.keys()].sort(), ['3', '4']);
});

test('sinceMs with no rows in range reports zeros and calls Chroma not at all', async () => {
  const { sync, add, messages } = await setup();
  add('1', 10);
  assert.deepEqual(await sync.run({ sinceMs: 99 }), ZERO);
  assert.equal(messages.upserts.length, 0);
});

test('quiet suppresses the per-page progress line', async () => {
  const fake = createFakeChroma();
  const vectorStore = createVectorStore({
    client: new fake.ChromaClient({}), embeddingFunction: new fake.OpenAIEmbeddingFunction({}), config, clock: inertClock(),
  });
  const db = openDatabase(':memory:');
  const messageStore = createMessageStore({ db, config });
  const lines = [];
  const sync = createVectorSync({ messageStore, vectorStore, logger: { info: (m) => lines.push(m) }, config });
  const record = { id: '1', author: 'alice', content: 'message 1', timestamp: 1, reference: null };
  messageStore.insertRaw(record);
  messageStore.insertFiltered(record, { inferReference: false });
  await sync.run({ quiet: true });
  assert.deepEqual(lines, []);
  await sync.run({});
  assert.equal(lines.length, 1);
});

test('a SQLite failure is not tagged as a vector error', async () => {
  const { sync, db } = await setup();
  db.close();
  await assert.rejects(sync.run({}), (error) => error.isVectorError === undefined);
});
